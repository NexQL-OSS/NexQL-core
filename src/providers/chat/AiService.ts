/**
 * AI Provider service for chat functionality
 */
import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { ChatMessage } from './types';
import { SecretStorageService } from '../../services/SecretStorageService';

// GitHub Models permission applies to fine-grained tokens/GitHub Apps.
// For VS Code OAuth sessions, request no explicit scope.
const GITHUB_MODELS_SCOPES: string[] = [];
const GITHUB_MODELS_API_BASE = 'https://models.github.ai';
const GITHUB_MODELS_API_VERSION = '2026-03-10';
const DEFAULT_GITHUB_MODEL = 'openai/gpt-4.1';

/** Heuristic for VS Code LM when the host does not report token usage (UI hint only). */
const ROUGH_CHARS_PER_TOKEN = 4;

export class AiService {
  private _messages: ChatMessage[] = [];
  private _cancellationTokenSource: vscode.CancellationTokenSource | null = null;
  private _abortController: AbortController | null = null;

  setMessages(messages: ChatMessage[]): void {
    this._messages = messages;
  }

  /**
   * Cancel any ongoing AI request
   */
  cancel(): void {
    if (this._cancellationTokenSource) {
      this._cancellationTokenSource.cancel();
      this._cancellationTokenSource.dispose();
      this._cancellationTokenSource = null;
    }
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
  }

  /**
   * Optional connection context injected into the system prompt.
   * Set by ChatViewProvider when the active connection is identified.
   */
  private _connectionContext: {
    environment?: 'production' | 'staging' | 'development';
    readOnlyMode?: boolean;
    connectionName?: string;
  } | undefined;

  setConnectionContext(ctx: AiService['_connectionContext']): void {
    this._connectionContext = ctx;
  }

  buildSystemPrompt(): string {
    const ctx = this._connectionContext;
    const isProduction = ctx?.environment === 'production';
    const isReadOnly = ctx?.readOnlyMode === true;

    // ── Production safety header (injected first so model sees it immediately) ──
    let productionBlock = '';
    if (isProduction) {
      productionBlock = `
⚠️ **PRODUCTION CONNECTION ACTIVE** ⚠️
The user is connected to a **PRODUCTION** database${ctx?.connectionName ? ` (${ctx.connectionName})` : ''}.
Apply the following guardrails to every response WITHOUT EXCEPTION:

1. **NEVER generate bare DELETE, UPDATE, or TRUNCATE statements** without a WHERE clause.
2. **Always wrap destructive SQL in a transaction** with ROLLBACK as a comment option.
3. **Prefix every write query** with a comment: \`-- ⚠️ PRODUCTION — review carefully before running\`
4. **Recommend SELECT first** to preview affected rows before any write operation.
5. **Flag careless patterns** such as UPDATE without WHERE or DELETE without WHERE with a bold warning.
6. If asked to generate a migration, include \`BEGIN;\` and end with \`-- COMMIT; -- Uncomment after review\`.
7. **Never auto-apply** suggested SQL — always remind the user to review and run explicitly.

`;
    } else if (isReadOnly) {
      productionBlock = `
ℹ️ **READ-ONLY CONNECTION** — This connection is configured as read-only.
Only generate SELECT / EXPLAIN / read queries. If the user requests a write operation,
explain that the connection is read-only and suggest switching to a write-capable connection.

`;
    }

    return `${productionBlock}You are an expert PostgreSQL database assistant. You help users with:
- Writing and optimizing SQL queries
- Understanding database concepts and best practices
- Debugging query issues
- Explaining query execution plans
- Schema design recommendations
- PostgreSQL-specific features and extensions

**IMPORTANT - DATABASE SCHEMA CONTEXT:**
When the user references database objects (tables, views, functions, etc.), I will provide you with the actual schema information in a section marked "=== DATABASE SCHEMA CONTEXT ===". 
- ALWAYS use this provided schema information when answering questions
- The schema context includes real column names, data types, constraints, indexes, and relationships
- Reference the exact column names and types from the provided schema
- Do NOT say you don't have access to the schema when it's provided in the context

**SQL QUALITY CHECKLIST (MANDATORY - Follow before every SQL response):**
Before providing any SQL query, you MUST verify:
1. ✓ All table names exist in the provided schema context or user input
2. ✓ All column names are EXACTLY as shown in the schema (case-sensitive)
3. ✓ All data types are compatible with the operations performed
4. ✓ JOIN conditions use correct column names from both tables
5. ✓ WHERE conditions reference existing columns
6. ✓ GROUP BY includes all non-aggregated columns in SELECT
7. ✓ No syntax errors (matching parentheses, proper comma placement, semicolon at end)
8. ✓ Aliases are used consistently throughout the query
9. ✓ Foreign key relationships are correctly referenced
10. ✓ The query is complete and can be executed as-is

**SQL FORMATTING RULES (MANDATORY):**
When providing SQL code, ALWAYS format it for maximum readability:
1. Use proper indentation (4 spaces) for nested clauses
2. Put each major clause (SELECT, FROM, WHERE, JOIN, GROUP BY, ORDER BY, etc.) on a new line
3. Put each column in SELECT on its own line for queries with more than 3 columns
4. Put each condition in WHERE/AND/OR on its own line
5. Align JOIN conditions properly
6. Use UPPERCASE for SQL keywords
7. Use lowercase for table/column names (unless schema shows otherwise)
8. Add blank lines between CTEs and main query
9. Break long lines at logical points (operators, commas)
10. Always end queries with a semicolon

Example of properly formatted SQL:
\`\`\`sql
SELECT
    u.id,
    u.username,
    u.email,
    COUNT(o.id) AS order_count,
    SUM(o.total_amount) AS total_spent
FROM
    users u
LEFT JOIN
    orders o ON o.user_id = u.id
WHERE
    u.created_at >= '2024-01-01'
    AND u.status = 'active'
GROUP BY
    u.id,
    u.username,
    u.email
HAVING
    COUNT(o.id) > 5
ORDER BY
    total_spent DESC
LIMIT 100;
\`\`\`

**RESPONSE QUALITY:**
- Double-check all SQL for correctness before responding
- If schema context is provided, ONLY use columns that exist in that schema
- If you're unsure about a column name, ask the user to clarify
- Provide complete, executable SQL - never truncate or abbreviate
- If a query is complex, break it down and explain each part
- NEVER include HTML tags, CSS classes, or any markup in SQL code
- SQL strings should use single quotes like 'value', not any special formatting
- Your output is plain markdown only - no HTML

IMPORTANT: At the end of each response, provide 2-4 numbered follow-up questions the user might want to ask next. Format them as:

**Follow-up questions:**
1. [First question]
2. [Second question]
3. [Third question]

Make these questions relevant to the topic discussed and progressively more advanced.

IMPORTANT: If there is a genuinely good factoid or contextual joke, add it immediately before the follow-up questions as a short Markdown blockquote.
- Use your judgment: this is mainly for general-knowledge, conceptual, or exploratory answers.
- For simple fix, error, or query-generation tasks, usually omit it unless there is a truly apt one-liner.
- You may include a factoid, a joke, both, or neither.
- Keep it short, self-contained, and clearly relevant to the current answer.
- Format it as quote style markdown using blockquote lines only; do not add a heading.

IMPORTANT: Follow-up questions are distinct from next-step suggestion bubbles.
- If the user's latest message is only a number, treat it as selecting that numbered question from the immediately previous assistant response's "Follow-up questions:" list.
- Answer the selected follow-up question directly.
- Do not confuse this with next-step bubbles, which are optional model suggestions and not user selections.

**PHASE D: NEXT STEPS SUGGESTION BUBBLES (Optional):**
After your response, you MAY optionally provide suggested follow-up actions the user might want to take. If you do, append them as a raw JSON object at the very end of your response (after the follow-up questions). Do not wrap the JSON in markdown or code fences.

{
  "next_steps": [
    "Short action phrase, 3 to 6 words max",
    "Short action phrase, 3 to 6 words max",
    "Short action phrase, 3 to 6 words max"
  ]
}


IMPORTANT: Only include this JSON block if you have 2-3 truly valuable next-step suggestions. The suggestions should be:
- Actionable and relevant to the current conversation
- Phrased as concise, self-contained action phrases or prompts (ideally 3-6 words, max 40 characters each)
- Progressive in complexity or depth
- Examples: "Review query plan", "Add missing index", "Compare join options"

Do NOT include the JSON block if:
- There are no clear follow-up actions
- The suggestions are obvious or trivial
- You're uncertain about what would be helpful next
- Do not invent filler suggestions just to reach 3 entries
- Do not repeat the follow-up questions in this JSON block
- If only 1 or 2 actions are appropriate, provide only those
- If no actions are appropriate, omit the JSON block entirely

The UI will automatically parse this and show clickable suggestion bubbles.`;
  }

  async callVsCodeLm(userMessage: string, config: vscode.WorkspaceConfiguration, customSystemPrompt?: string): Promise<{ text: string, usage?: string }> {
    const configuredModel = config.get<string>('aiModel');
    let models: vscode.LanguageModelChat[];

    if (configuredModel) {
      // Extract base name if format is "name (family)"
      const baseName = configuredModel.replace(/\s*\(.*\)$/, '').trim();

      // Try to find the specific model by name/id/family
      const allModels = await vscode.lm.selectChatModels({});
      const matchingModels = allModels.filter(m =>
        m.id === baseName ||
        m.name === baseName ||
        m.family === baseName ||
        m.id === configuredModel ||
        m.name === configuredModel ||
        m.family === configuredModel
      );
      models = matchingModels.length > 0 ? matchingModels : allModels;
    } else {
      // Default: try gpt-4o family first
      models = await vscode.lm.selectChatModels({ family: 'gpt-4o' });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({});
      }
    }

    const model = models[0];
    if (!model) {
      throw new Error('No AI models available via VS Code API. Please ensure GitHub Copilot Chat is installed or switch provider.');
    }

    console.log('[AiService] Selected model details:', JSON.stringify({
      id: model.id,
      name: model.name,
      family: (model as any).family,
      vendor: (model as any).vendor,
      version: (model as any).version,
      maxInputTokens: (model as any).maxInputTokens,
      maxOutputTokens: (model as any).maxOutputTokens
    }));

    const systemPrompt = customSystemPrompt !== undefined ? customSystemPrompt : this.buildSystemPrompt();

    const messages: any[] = [];
    if (systemPrompt) {
      const lmMessageCtor = vscode.LanguageModelChatMessage as any;
      // Prefer system role when available; older API versions only expose User/Assistant.
      if (typeof lmMessageCtor.System === 'function') {
        messages.push(lmMessageCtor.System(systemPrompt));
      } else {
        messages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
      }
    }

    const history = this._messages.slice(-10);

    messages.push(
      ...history.map(msg => {
        const text = this._sanitizeContent(this._getMessageContent(msg));
        const images = msg.attachments?.filter(a => a.type === 'image' && a.dataUrl) || [];
        if (images.length > 0) {
          const parts: any[] = [];
          for (const img of images) {
            const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              const bytes = Buffer.from(match[2], 'base64');
              const lmImagePart = (vscode as any).LanguageModelImagePart;
              if (typeof lmImagePart === 'function') {
                parts.push(new lmImagePart(match[1], bytes));
              }
            }
          }
          if (text.trim()) {
            parts.push(new (vscode as any).LanguageModelTextPart(text));
          }
          return msg.role === 'user'
            ? vscode.LanguageModelChatMessage.User(parts.length > 0 ? parts : text)
            : vscode.LanguageModelChatMessage.Assistant(text);
        }
        return msg.role === 'user'
          ? vscode.LanguageModelChatMessage.User(text)
          : vscode.LanguageModelChatMessage.Assistant(text);
      })
    );
    // Always include the latest user prompt as the final turn.
    // Some models are sensitive to explicit final-turn structure.
    messages.push(vscode.LanguageModelChatMessage.User(userMessage));

    const compactHistory = history.map((msg, idx) => ({
      idx,
      role: msg.role,
      contentLength: this._getMessageContent(msg).length,
      attachmentCount: msg.attachments?.length || 0,
      mentionCount: msg.mentions?.length || 0
    }));

    console.log('[AiService] Prepared request payload summary:', JSON.stringify({
      totalMessages: messages.length,
      historyMessages: history.length,
      userMessageLength: userMessage.length,
      systemPromptLength: systemPrompt.length,
      history: compactHistory
    }));

    // Debug: Log all messages being sent to model
    console.log('[AiService] ========== MESSAGES SENT TO MODEL ==========');
    console.log('[AiService] System prompt length:', systemPrompt.length);
    console.log('[AiService] Conversation history messages:', this._messages.length);

    // Create and store cancellation token source for this request
    this._cancellationTokenSource = new vscode.CancellationTokenSource();

    try {
      console.log('[AiService] sendRequest initial attempt started');
      const chatRequest = await model.sendRequest(messages, {}, this._cancellationTokenSource.token);
      const rawChatRequest = chatRequest as any;
      console.log('[AiService] sendRequest initial attempt resolved:', JSON.stringify({
        hasStream: !!rawChatRequest?.stream,
        hasText: !!rawChatRequest?.text,
        hasResult: !!rawChatRequest?.result,
        resultKeys: rawChatRequest?.result ? Object.keys(rawChatRequest.result) : []
      }));

      let effectiveRequest: any = chatRequest;
      let responseText = await this._extractVsCodeLmResponseText(chatRequest as any);
      console.log('[AiService] Initial extraction result length:', responseText.length);

      // Some models may return an empty text stream on the first attempt for verbose histories.
      // Retry once with a minimal context to avoid persisting blank assistant replies.
      let effectiveMessagesForFallback = messages;
      if (!responseText.trim()) {
        console.warn('[AiService] Empty response from VS Code LM; retrying with minimal prompt context.');
        const retryMessages: any[] = [];
        if (systemPrompt) {
          const lmMessageCtor = vscode.LanguageModelChatMessage as any;
          if (typeof lmMessageCtor.System === 'function') {
            retryMessages.push(lmMessageCtor.System(systemPrompt));
          } else {
            retryMessages.push(vscode.LanguageModelChatMessage.User(systemPrompt));
          }
        }
        retryMessages.push(vscode.LanguageModelChatMessage.User(userMessage));

        console.log('[AiService] Retry payload summary:', JSON.stringify({
          totalMessages: retryMessages.length,
          userMessageLength: userMessage.length,
          systemPromptLength: systemPrompt.length
        }));

        console.log('[AiService] sendRequest retry attempt started');
        const retryRequest = await model.sendRequest(retryMessages, {}, this._cancellationTokenSource.token);
        effectiveRequest = retryRequest;
        const rawRetryRequest = retryRequest as any;
        console.log('[AiService] sendRequest retry attempt resolved:', JSON.stringify({
          hasStream: !!rawRetryRequest?.stream,
          hasText: !!rawRetryRequest?.text,
          hasResult: !!rawRetryRequest?.result,
          resultKeys: rawRetryRequest?.result ? Object.keys(rawRetryRequest.result) : []
        }));

        responseText = await this._extractVsCodeLmResponseText(retryRequest as any);
        console.log('[AiService] Retry extraction result length:', responseText.length);
        effectiveMessagesForFallback = retryMessages;
      }

      // If the configured model yields no chunks at all, try another available model once.
      if (!responseText.trim()) {
        const fallbackModel = await this._findAlternateModel(model.id);
        if (fallbackModel) {
          console.warn('[AiService] Selected model produced empty output. Trying alternate model:', fallbackModel.name || fallbackModel.id);
          const fallbackRequest = await fallbackModel.sendRequest(effectiveMessagesForFallback, {}, this._cancellationTokenSource.token);
          effectiveRequest = fallbackRequest;
          responseText = await this._extractVsCodeLmResponseText(fallbackRequest as any);
          console.log('[AiService] Alternate model extraction result length:', responseText.length);
        }
      }

      if (!responseText.trim()) {
        throw new Error('AI model returned an empty response. Please retry or select a different model.');
      }

      const promptChars = AiService._approxCharsFromLmMessages(effectiveMessagesForFallback);
      let usageStr = await AiService._extractVsCodeLmUsageAfterStream(effectiveRequest);
      if (!usageStr) {
        usageStr = AiService._roughTokenEstimateLabel(promptChars, responseText.length);
      }

      return { text: responseText, usage: usageStr };
    } finally {
      // Clean up cancellation token source
      if (this._cancellationTokenSource) {
        this._cancellationTokenSource.dispose();
        this._cancellationTokenSource = null;
      }
    }
  }

  /** Best-effort token / usage string from a consumed VS Code LM response (shape varies by host). */
  private static async _extractVsCodeLmUsageAfterStream(chatRequest: any): Promise<string | undefined> {
    const direct = AiService._usageFromLmResponseObject(chatRequest);
    if (direct) {
      return direct;
    }
    const r = chatRequest?.result;
    if (r && typeof r.then === 'function') {
      try {
        const resolved = await r;
        return AiService._usageFromLmResponseObject(resolved);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private static _usageFromLmResponseObject(obj: any): string | undefined {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }
    const u = obj.usage;
    if (!u || typeof u !== 'object') {
      return undefined;
    }
    if (typeof u.totalTokens === 'number') {
      return `${u.totalTokens} tokens`;
    }
    if (typeof u.inputTokens === 'number' && typeof u.outputTokens === 'number') {
      return `${u.inputTokens} in + ${u.outputTokens} out`;
    }
    if (typeof u.promptTokens === 'number' && typeof u.completionTokens === 'number') {
      return `${u.promptTokens} in + ${u.completionTokens} out`;
    }
    return undefined;
  }

  private static _approxCharsFromLmMessages(lmMessages: any[]): number {
    let n = 0;
    for (const msg of lmMessages) {
      const c = (msg as any)?.content;
      if (typeof c === 'string') {
        n += c.length;
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (typeof part === 'string') {
            n += part.length;
          } else if (part && typeof (part as any).text === 'string') {
            n += (part as any).text.length;
          } else if (part && typeof (part as any).value === 'string') {
            n += (part as any).value.length;
          }
        }
      }
    }
    return n;
  }

  /** Rough token hint when the LM host does not report usage (not billing-grade). */
  private static _roughTokenEstimateLabel(promptChars: number, completionChars: number): string {
    const inTok = Math.max(1, Math.round(promptChars / ROUGH_CHARS_PER_TOKEN));
    const outTok = Math.max(1, Math.round(completionChars / ROUGH_CHARS_PER_TOKEN));
    const total = inTok + outTok;
    return `~${total} tokens (est. · ${inTok} in + ${outTok} out)`;
  }

  private async _findAlternateModel(currentModelId: string): Promise<vscode.LanguageModelChat | undefined> {
    const allModels = await this._selectChatModelsWithTimeout({});
    if (allModels.length === 0) {
      return undefined;
    }

    const candidates = allModels.filter(m => m.id !== currentModelId);
    if (candidates.length === 0) {
      return undefined;
    }

    // Prefer known stable families first if available.
    const preferredFamilyOrder = ['gpt-4o', 'gpt-4.1', 'o3', 'claude'];
    for (const family of preferredFamilyOrder) {
      const match = candidates.find(m => (m.family || '').toLowerCase().includes(family));
      if (match) {
        return match;
      }
    }

    return candidates[0];
  }

  private async _extractVsCodeLmResponseText(chatRequest: any): Promise<string> {
    let responseText = '';
    const streamPartDebug: string[] = [];
    let streamChunkCount = 0;
    let textChunkCount = 0;

    // Stream is the canonical response channel in current VS Code APIs.
    if (chatRequest?.stream && Symbol.asyncIterator in Object(chatRequest.stream)) {
      for await (const part of chatRequest.stream) {
        streamChunkCount += 1;
        responseText += this._extractTextFromStreamPart(part, streamPartDebug);
      }
    }

    console.log('[AiService] Stream extraction stats:', JSON.stringify({
      streamChunkCount,
      streamChunkTypes: streamPartDebug,
      extractedLength: responseText.length
    }));

    if (responseText.trim()) {
      return responseText;
    }

    // Fallback for environments where text is the only available channel.
    if (chatRequest?.text && Symbol.asyncIterator in Object(chatRequest.text)) {
      for await (const fragment of chatRequest.text) {
        textChunkCount += 1;
        responseText += this._normalizeLmTextFragment(fragment);
      }
    }

    console.log('[AiService] Text extraction stats:', JSON.stringify({
      textChunkCount,
      extractedLength: responseText.length
    }));

    if (responseText.trim()) {
      return responseText;
    }

    // Last-resort compatibility fallback.
    const resultContent = chatRequest?.result?.content;
    if (typeof resultContent === 'string') {
      console.log('[AiService] Using result.content string fallback with length:', resultContent.length);
      return resultContent;
    }
    if (Array.isArray(resultContent)) {
      console.log('[AiService] Using result.content array fallback with parts:', resultContent.length);
      return resultContent
        .map((item: any) => {
          if (typeof item === 'string') return item;
          if (typeof item?.text === 'string') return item.text;
          if (typeof item?.value === 'string') return item.value;
          return '';
        })
        .join('');
    }

    if (!responseText.trim() && streamPartDebug.length > 0) {
      console.warn('[AiService] LM stream yielded non-text parts only:', streamPartDebug.join(' | '));
    }

    return responseText;
  }

  private _normalizeLmTextFragment(fragment: any): string {
    if (fragment === null || fragment === undefined) {
      return '';
    }
    if (typeof fragment === 'string') {
      return fragment;
    }
    if (typeof fragment?.value === 'string') {
      return fragment.value;
    }
    if (typeof fragment?.text === 'string') {
      return fragment.text;
    }
    return '';
  }

  private _extractTextFromStreamPart(part: any, debugParts?: string[]): string {
    if (!part) {
      return '';
    }

    const addDebugPart = (value: string): void => {
      if (!debugParts) {
        return;
      }
      if (debugParts.length < 8) {
        debugParts.push(value);
      }
    };

    const ctorName = part?.constructor?.name || typeof part;
    addDebugPart(ctorName);

    if (part instanceof (vscode as any).LanguageModelTextPart) {
      return typeof part.value === 'string' ? part.value : '';
    }

    if (part instanceof (vscode as any).LanguageModelToolCallPart) {
      addDebugPart(`tool:${part.name || 'unknown'}`);
      return '';
    }

    if (typeof part === 'string') {
      return part;
    }
    if (typeof part.text === 'string') {
      return part.text;
    }
    if (typeof part.value === 'string') {
      return part.value;
    }

    const nestedText = part?.part?.text;
    if (typeof nestedText === 'string') {
      return nestedText;
    }

    const nestedValue = part?.part?.value;
    if (typeof nestedValue === 'string') {
      return nestedValue;
    }

    const candidates = [part?.content, part?.chunk, part?.delta];
    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        return candidate;
      }
      if (typeof candidate?.text === 'string') {
        return candidate.text;
      }
      if (typeof candidate?.value === 'string') {
        return candidate.value;
      }
    }

    return '';
  }

  // Sanitize content to remove any HTML/CSS artifacts before sending to AI
  private _sanitizeContent(content: string): string {
    let cleaned = content;
    // Remove CSS class-like patterns that may have leaked into history
    cleaned = cleaned.replace(/\b(sql-keyword|sql-string|sql-function|sql-number|sql-type|sql-comment|sql-operator|sql-special|function)"\s*>/gi, '');
    return cleaned;
  }

  private _getMessageContent(msg: ChatMessage): string {
    let content = msg.content;
    if (msg.attachments && msg.attachments.length > 0) {
      const attachmentTexts = msg.attachments
        .filter(att => att.type !== 'image')
        .map(att => `\n\nFile: ${att.name} (${att.type})\n\`\`\`${att.type}\n${att.content}\n\`\`\``)
        .join('');
      content += attachmentTexts;
    }
    return content;
  }

  /**
   * Build a multipart content array for providers that support vision (images).
   * Returns null if there are no image attachments (caller should use plain string).
   */
  private _buildMultipartContent(msg: ChatMessage, textOverride?: string): any[] | null {
    const images = msg.attachments?.filter(att => att.type === 'image' && att.dataUrl) || [];
    if (images.length === 0) return null;

    const text = textOverride ?? this._getMessageContent(msg);
    const parts: any[] = [];

    if (text.trim()) {
      parts.push({ type: 'text', text });
    }

    for (const img of images) {
      // dataUrl format: "data:<mimeType>;base64,<data>"
      const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          type: 'image_url',
          image_url: { url: img.dataUrl! }
        });
      }
    }

    return parts.length > 0 ? parts : null;
  }

  /**
   * Build Anthropic-style multipart content with image blocks.
   */
  private _buildAnthropicContent(msg: ChatMessage, textOverride?: string): any[] | string {
    const images = msg.attachments?.filter(att => att.type === 'image' && att.dataUrl) || [];
    const text = textOverride ?? this._getMessageContent(msg);

    if (images.length === 0) return text;

    const parts: any[] = [];
    for (const img of images) {
      const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({
          type: 'image',
          source: { type: 'base64', media_type: match[1], data: match[2] }
        });
      }
    }
    if (text.trim()) {
      parts.push({ type: 'text', text });
    }
    return parts;
  }

  /**
   * Build Gemini-style parts array with inline image data.
   */
  private _buildGeminiParts(msg: ChatMessage, textOverride?: string): any[] {
    const images = msg.attachments?.filter(att => att.type === 'image' && att.dataUrl) || [];
    const text = textOverride ?? this._getMessageContent(msg);
    const parts: any[] = [];

    if (text.trim()) {
      parts.push({ text });
    }
    for (const img of images) {
      const match = img.dataUrl!.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        parts.push({ inline_data: { mime_type: match[1], data: match[2] } });
      }
    }
    return parts;
  }

  async callDirectApi(provider: string, userMessage: string, config: vscode.WorkspaceConfiguration, customSystemPrompt?: string): Promise<{ text: string, usage?: string }> {
    const apiKey = await this._getDirectApiKey(config);
    const githubSession = provider === 'github' ? await this._getGitHubSession() : undefined;
    
    // API key is required for most providers, but optional for custom endpoints
    if (!apiKey && provider !== 'custom' && provider !== 'ollama' && provider !== 'lmstudio' && provider !== 'github') {
      throw new Error(`API Key is required for ${provider} provider. Please configure postgresExplorer.aiApiKey.`);
    }

    let endpoint = '';
    let model = config.get<string>('aiModel');
    let headers: any = {
      'Content-Type': 'application/json'
    };
    
    // Only add Authorization header if API key is provided
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    
    let body: any = {};

    const systemPrompt = customSystemPrompt !== undefined ? customSystemPrompt : this.buildSystemPrompt();

    // Sanitize conversation history to remove any HTML artifacts
    const conversationHistory = this._messages.slice(-10).map(msg => ({
      role: msg.role,
      content: this._sanitizeContent(this._getMessageContent(msg))
    }));

    if (provider === 'openai') {
      endpoint = 'https://api.openai.com/v1/chat/completions';
      model = model || 'gpt-4o';

      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      // History with vision support
      for (const msg of this._messages.slice(-10)) {
        const multipart = this._buildMultipartContent(msg);
        messages.push({
          role: msg.role,
          content: multipart ?? this._sanitizeContent(this._getMessageContent(msg))
        });
      }
      // Current user message — check if it carries images
      const currentMsg: ChatMessage = { role: 'user', content: userMessage, attachments: this._messages[this._messages.length - 1]?.attachments };
      const currentMultipart = this._buildMultipartContent(currentMsg, userMessage);
      messages.push({ role: 'user', content: currentMultipart ?? userMessage });

      body = {
        model: model,
        messages: messages,
        temperature: 0.7
      };
    } else if (provider === 'anthropic') {
      endpoint = 'https://api.anthropic.com/v1/messages';
      model = model || 'claude-3-5-sonnet-20241022';
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      delete headers['Authorization'];

      const anthropicMessages: any[] = [];
      for (const msg of this._messages.slice(-10)) {
        anthropicMessages.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: this._buildAnthropicContent(msg)
        });
      }
      const lastMsg = this._messages[this._messages.length - 1];
      const currentAnthropicContent = lastMsg?.attachments?.some(a => a.type === 'image')
        ? this._buildAnthropicContent(lastMsg, userMessage)
        : userMessage;
      anthropicMessages.push({ role: 'user', content: currentAnthropicContent });

      body = {
        model: model,
        system: systemPrompt,
        messages: anthropicMessages,
        max_tokens: 4096
      };
    } else if (provider === 'gemini') {
      model = model || 'gemini-1.5-flash';
      endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      headers['X-goog-api-key'] = apiKey;
      delete headers['Authorization'];

      const geminiContents: any[] = [];
      for (const msg of this._messages.slice(-10)) {
        geminiContents.push({
          role: msg.role === 'assistant' ? 'model' : 'user',
          parts: this._buildGeminiParts(msg)
        });
      }
      const lastMsg = this._messages[this._messages.length - 1];
      const currentGeminiParts = lastMsg?.attachments?.some(a => a.type === 'image')
        ? this._buildGeminiParts(lastMsg, userMessage)
        : [{ text: userMessage }];
      geminiContents.push({ role: 'user', parts: currentGeminiParts });

      body = {
        systemInstruction: systemPrompt ? { parts: [{ text: systemPrompt }] } : undefined,
        contents: geminiContents
      };
    } else if (provider === 'custom') {
      endpoint = config.get<string>('aiEndpoint') || '';
      if (!endpoint) {
        throw new Error('Endpoint is required for custom provider');
      }
      model = model || 'gpt-3.5-turbo';

      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push(...conversationHistory);
      messages.push({ role: 'user', content: userMessage });

      body = {
        model: model,
        messages: messages
      };
    } else if (provider === 'ollama') {
      endpoint = config.get<string>('aiEndpoint') || 'http://localhost:11434/v1/chat/completions';
      model = model || '';

      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push(...conversationHistory);
      messages.push({ role: 'user', content: userMessage });

      body = { model, messages };
    } else if (provider === 'lmstudio') {
      endpoint = config.get<string>('aiEndpoint') || 'http://localhost:1234/v1/chat/completions';
      model = model || '';

      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push(...conversationHistory);
      messages.push({ role: 'user', content: userMessage });

      body = { model, messages };
    } else if (provider === 'github') {
      if (!githubSession) {
        throw new Error('Sign in to GitHub in AI Settings to use GitHub Models.');
      }

      endpoint = `${GITHUB_MODELS_API_BASE}/inference/chat/completions`;
      model = model || DEFAULT_GITHUB_MODEL;

      const messages: any[] = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push(...conversationHistory);
      messages.push({ role: 'user', content: userMessage });

      headers = {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${githubSession.accessToken}`,
        'X-GitHub-Api-Version': GITHUB_MODELS_API_VERSION,
        'Content-Type': 'application/json'
      };

      body = {
        model,
        messages,
        temperature: 0.7
      };
    } else {
      throw new Error(`Unsupported provider: ${provider}`);
    }

    return this._makeHttpRequest(endpoint, headers, body, provider);
  }

  private async _getDirectApiKey(config: vscode.WorkspaceConfiguration): Promise<string> {
    try {
      const secretApiKey = await SecretStorageService.getInstance().getAiApiKey();
      return secretApiKey || config.get<string>('aiApiKey') || '';
    } catch {
      return config.get<string>('aiApiKey') || '';
    }
  }

  private async _getGitHubSession(): Promise<vscode.AuthenticationSession | undefined> {
    try {
      return await vscode.authentication.getSession('github', GITHUB_MODELS_SCOPES, {
        silent: true,
        clearSessionPreference: false
      });
    } catch {
      return undefined;
    }
  }

  private _makeHttpRequest(endpoint: string, headers: any, body: any, provider: string): Promise<{ text: string, usage?: string }> {
    return new Promise((resolve, reject) => {
      const url = new URL(endpoint);
      const requestData = JSON.stringify(body);

      const options: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(requestData)
        }
      };

      const protocol = url.protocol === 'https:' ? https : http;
      const req = protocol.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const response = JSON.parse(data);

            if (res.statusCode !== 200) {
              reject(new Error(response.error?.message || `API request failed with status ${res.statusCode}`));
              return;
            }

            let content = '';
            let usage = '';

            if (provider === 'anthropic') {
              content = response.content?.[0]?.text || '';
              if (response.usage) {
                 usage = `${response.usage.input_tokens} input, ${response.usage.output_tokens} output`;
              }
            } else if (provider === 'gemini') {
              content = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (response.usageMetadata) {
                 usage = `${response.usageMetadata.totalTokenCount} tokens`;
              }
            } else {
              // OpenAI or compatible
              content = response.choices?.[0]?.message?.content || '';
              if (response.usage) {
                 usage = `${response.usage.total_tokens} tokens (P:${response.usage.prompt_tokens}, C:${response.usage.completion_tokens})`;
              }
            }

            if (!content && provider === 'custom') {
              content = JSON.stringify(response); // Fallback
            }

            if (usage && body?.model) {
              usage = `${body.model} · ${usage}`;
            }

            resolve({ text: content, usage });
          } catch (e) {
            // If response is not JSON, we might want to log it
            reject(new Error(`Failed to parse API response: ${e instanceof Error ? e.message : String(e)}`));
          }
        });
      });

      req.on('error', reject);
      req.write(requestData);
      req.end();
    });
  }

  async generateTitle(firstMessage: string, provider: string): Promise<string> {
    try {
      if (provider === 'vscode-lm') {
        const models = await vscode.lm.selectChatModels({});
        if (models.length > 0) {
          const prompt = `Generate a very short title (max 5 words) for a chat about: "${firstMessage.substring(0, 100)}". Return only the title, nothing else.`;
          const messages = [vscode.LanguageModelChatMessage.User(prompt)];
          const response = await models[0].sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
          let title = '';
          for await (const fragment of response.text) {
            title += fragment;
          }
          return title.trim().substring(0, 50);
        }
      }

      // Fallback to simple extraction
      const title = firstMessage.substring(0, 40).replace(/\n/g, ' ').trim();
      return title.length === 40 ? title + '...' : title;
    } catch {
      const simple = firstMessage.substring(0, 40).replace(/\n/g, ' ').trim();
      return simple.length === 40 ? simple + '...' : simple;
    }
  }

  async getModelInfo(provider: string, config: vscode.WorkspaceConfiguration): Promise<string> {
    try {
      const configuredModel = config.get<string>('aiModel');

      if (provider === 'vscode-lm') {
        if (configuredModel) {
          const baseName = configuredModel.replace(/\s*\(.*\)$/, '').trim();
          const allModels = await this._selectChatModelsWithTimeout({});
          const matchingModels = allModels.filter((m: vscode.LanguageModelChat) =>
            m.id === baseName || m.name === baseName || m.family === baseName ||
            m.id === configuredModel || m.name === configuredModel || m.family === configuredModel
          );
          if (matchingModels.length > 0) {
            return matchingModels[0].name || matchingModels[0].id;
          }
        }
        const models = await this._selectChatModelsWithTimeout({ family: 'gpt-4o' });
        if (models.length > 0) {
          return models[0].name || models[0].id;
        }
        const anyModels = await this._selectChatModelsWithTimeout({});
        return anyModels.length > 0 ? (anyModels[0].name || anyModels[0].id) : 'VS Code LM (No Models)';
      } else {
        return configuredModel || this._getDefaultModel(provider);
      }
    } catch {
      return 'Unknown';
    }
  }

  private _getDefaultModel(provider: string): string {
    switch (provider) {
      case 'github': return DEFAULT_GITHUB_MODEL;
      case 'openai': return 'gpt-4o';
      case 'anthropic': return 'claude-3-5-sonnet-20241022';
      case 'gemini': return 'gemini-1.5-flash';
      case 'custom': return 'custom-model';
      case 'ollama': return 'ollama';
      case 'lmstudio': return 'lm-studio';
      default: return 'Unknown';
    }
  }

  private async _selectChatModelsWithTimeout(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat[]> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[AiService] vscode.lm.selectChatModels timed out after 2000ms');
        resolve([]);
      }, 2000);

      vscode.lm.selectChatModels(selector).then((models) => {
        clearTimeout(timeout);
        resolve(models);
      }, (error) => {
        clearTimeout(timeout);
        console.error('[AiService] vscode.lm.selectChatModels failed:', error);
        resolve([]);
      });
    });
  }
}
