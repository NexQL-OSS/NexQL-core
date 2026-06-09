// Pure helper for the RLS Policy Studio — no VS Code deps, so it is unit-testable.

export interface AiPolicyResult {
  using: string;
  withCheck: string;
  name?: string;
  explanation?: string;
}

/** Extract the policy JSON from a model response (tolerates code fences / prose). */
export function parseAiPolicy(text: string): AiPolicyResult | null {
  if (!text) { return null; }
  let body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) { return null; }
  body = body.slice(start, end + 1);
  try {
    const obj = JSON.parse(body);
    return {
      using: typeof obj.using === 'string' ? obj.using : '',
      withCheck: typeof obj.withCheck === 'string' ? obj.withCheck : '',
      name: typeof obj.name === 'string' ? obj.name : undefined,
      explanation: typeof obj.explanation === 'string' ? obj.explanation : undefined,
    };
  } catch {
    return null;
  }
}
