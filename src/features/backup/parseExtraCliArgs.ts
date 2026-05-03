/** Upper bound so webview cannot pass huge argv. */
const MAX_EXTRA_INPUT_CHARS = 8192;
const MAX_EXTRA_TOKENS = 128;
const MAX_TOKEN_CHARS = 4096;

/**
 * Split optional user-supplied flags for pg_* tools (not a shell — spawn argv only).
 * Supports double quotes (with \" for literal quote) and single quotes (no escapes).
 */
export function parseExtraCliArgs(raw: string): string[] {
  const s = raw.trim();
  if (!s) {
    return [];
  }
  if (s.length > MAX_EXTRA_INPUT_CHARS) {
    throw new Error(`Extra CLI args exceed ${MAX_EXTRA_INPUT_CHARS} characters`);
  }
  if (s.includes('\0')) {
    throw new Error('Extra CLI args must not contain NUL');
  }

  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;

  const pushCur = (): void => {
    if (!cur.length) {
      return;
    }
    if (cur.length > MAX_TOKEN_CHARS) {
      throw new Error(`Extra CLI token exceeds ${MAX_TOKEN_CHARS} characters`);
    }
    out.push(cur);
    cur = '';
    if (out.length > MAX_EXTRA_TOKENS) {
      throw new Error(`Extra CLI args: at most ${MAX_EXTRA_TOKENS} tokens`);
    }
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote === '"') {
      if (c === '\\' && i + 1 < s.length && s[i + 1] === '"') {
        cur += '"';
        i++;
        continue;
      }
      if (c === '"') {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (quote === "'") {
      if (c === "'") {
        quote = null;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      pushCur();
      continue;
    }
    cur += c;
  }

  if (quote !== null) {
    throw new Error('Extra CLI args: unclosed quote');
  }
  pushCur();
  return out;
}
