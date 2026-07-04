import { ToolCall } from '../types';
import { ToolSpec } from './ToolSpec';

/**
 * Compatibility shim for weak/cheap models that were offered structured tool-calling but
 * instead narrate the call as prose or a fenced code block, e.g.:
 *   ```tool_code
 *   search_schema('', type_filter='table')
 *   ```
 * `_makeHttpRequest`'s structured-shape parser (OpenAI tool_calls / Anthropic tool_use /
 * Gemini functionCall) correctly finds nothing here — this recovers the intent by pattern
 * matching a `known_tool_name(args...)` call against the real ToolSpec list, so the tool
 * still executes instead of dumping an inert code block on the user.
 */

const FENCE_RE = /```[a-zA-Z_-]*\n([\s\S]*?)```/g;
/** A contiguous block of non-empty lines — a "paragraph" for bare (unfenced) call detection. */
const PARAGRAPH_RE = /[^\n]+(?:\n[^\n]+)*/g;
/** A bare single call expression, optionally multi-line, with no trailing statements. */
const CALL_RE = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\(([\s\S]*)\)\s*$/;

function splitTopLevelArgs(argsStr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';

  for (let i = 0; i < argsStr.length; i++) {
    const ch = argsStr[i];

    if (quote) {
      current += ch;
      if (ch === quote && argsStr[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      current += ch;
      continue;
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      current += ch;
      continue;
    }

    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function decodeLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === 'true' || trimmed === 'True') {
    return true;
  }
  if (trimmed === 'false' || trimmed === 'False') {
    return false;
  }
  if (trimmed === 'None' || trimmed === 'null' || trimmed === 'undefined') {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
  ) {
    try {
      return JSON.parse(trimmed.replace(/'/g, '"'));
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

/**
 * Parses `name(arg1, key2=value2, ...)` into `{ key: value }`, mapping bare positional
 * args onto the tool's declared property order and dropping kwargs the schema doesn't
 * define (e.g. a hallucinated `type_filter` on `search_schema`, which only has `query`).
 */
function parseCallArguments(argsStr: string, spec: ToolSpec): Record<string, unknown> {
  const propertyNames = Object.keys(spec.parameters.properties);
  const result: Record<string, unknown> = {};
  const positionalPieces = splitTopLevelArgs(argsStr);

  let positionalIndex = 0;
  for (const piece of positionalPieces) {
    const eqIdx = piece.indexOf('=');
    const isKwarg =
      eqIdx > 0 &&
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(piece.slice(0, eqIdx).trim()) &&
      piece[eqIdx + 1] !== '=';

    if (isKwarg) {
      const key = piece.slice(0, eqIdx).trim();
      if (propertyNames.includes(key)) {
        result[key] = decodeLiteral(piece.slice(eqIdx + 1));
      }
      continue;
    }

    const posKey = propertyNames[positionalIndex];
    if (posKey !== undefined && !(posKey in result)) {
      result[posKey] = decodeLiteral(piece);
    }
    positionalIndex++;
  }

  return result;
}

function tryMatchCall(
  candidate: string,
  tools: ToolSpec[]
): { name: string; arguments: Record<string, unknown> } | undefined {
  const match = CALL_RE.exec(candidate.trim());
  if (!match) {
    return undefined;
  }
  const [, name, argsStr] = match;
  const spec = tools.find((t) => t.name === name);
  if (!spec) {
    return undefined;
  }
  return { name, arguments: parseCallArguments(argsStr, spec) };
}

export function extractPseudoToolCalls(
  text: string,
  tools: ToolSpec[]
): { calls: ToolCall[]; cleanedText: string } {
  const calls: ToolCall[] = [];
  const spans: Array<{ start: number; end: number }> = [];

  FENCE_RE.lastIndex = 0;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = FENCE_RE.exec(text)) !== null) {
    const matched = tryMatchCall(fenceMatch[1], tools);
    if (matched) {
      calls.push({ id: `pseudo_call_${calls.length}`, name: matched.name, arguments: matched.arguments });
      spans.push({ start: fenceMatch.index, end: fenceMatch.index + fenceMatch[0].length });
    }
  }

  // No fenced match found anywhere — fall back to scanning each contiguous non-blank-line
  // block (a "paragraph") for a bare call (covers models that skip the code fence and mix
  // the call into surrounding prose, e.g. "I'll search...\n\nsearch_schema('users')").
  if (calls.length === 0) {
    PARAGRAPH_RE.lastIndex = 0;
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = PARAGRAPH_RE.exec(text)) !== null) {
      const matched = tryMatchCall(paraMatch[0], tools);
      if (matched) {
        calls.push({ id: `pseudo_call_${calls.length}`, name: matched.name, arguments: matched.arguments });
        spans.push({ start: paraMatch.index, end: paraMatch.index + paraMatch[0].length });
      }
    }
  }

  if (calls.length === 0) {
    return { calls: [], cleanedText: text };
  }

  let cleanedText = '';
  let cursor = 0;
  for (const span of spans) {
    cleanedText += text.slice(cursor, span.start);
    cursor = span.end;
  }
  cleanedText += text.slice(cursor);

  return { calls, cleanedText: cleanedText.replace(/\n{3,}/g, '\n\n').trim() };
}
