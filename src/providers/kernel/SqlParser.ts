
/**
 * Service for parsing and analyzing SQL statements
 */
export class SqlParser {
  private static readonly DOLLAR_TAG_REGEX = /^(\$[a-zA-Z0-9_]*\$)/;

  private static isIdentifierStart(ch: string): boolean {
    return /^[a-zA-Z_]$/.test(ch);
  }

  private static isIdentifierPart(ch: string): boolean {
    return /^[a-zA-Z0-9_]$/.test(ch);
  }

  /**
   * Iterates SQL and invokes `onCode` only for characters outside quoted strings and comments.
   * If `emitOriginal` is true, original text is copied through unless overridden by `onCode`.
   */
  private static scanOutsideSpecial(
    sql: string,
    onCode: (sql: string, index: number) => { length: number; replacement?: string } | undefined,
    emitOriginal: boolean
  ): string {
    let out = '';
    let i = 0;
    let inSingleQuote = false;
    let inDollarQuote = false;
    let dollarQuoteTag = '';
    let inBlockComment = false;

    while (i < sql.length) {
      const char = sql[i];
      const nextChar = i + 1 < sql.length ? sql[i + 1] : '';
      const peek = sql.substring(i, i + 32);

      if (!inSingleQuote && !inDollarQuote && char === '/' && nextChar === '*') {
        inBlockComment = true;
        if (emitOriginal) {
          out += '/*';
        }
        i += 2;
        continue;
      }

      if (inBlockComment && char === '*' && nextChar === '/') {
        inBlockComment = false;
        if (emitOriginal) {
          out += '*/';
        }
        i += 2;
        continue;
      }

      if (inBlockComment) {
        if (emitOriginal) {
          out += char;
        }
        i++;
        continue;
      }

      if (!inSingleQuote && !inDollarQuote && char === '-' && nextChar === '-') {
        const lineEnd = sql.indexOf('\n', i);
        if (lineEnd === -1) {
          if (emitOriginal) {
            out += sql.substring(i);
          }
          break;
        }
        if (emitOriginal) {
          out += sql.substring(i, lineEnd + 1);
        }
        i = lineEnd + 1;
        continue;
      }

      if (!inSingleQuote) {
        const dollarMatch = peek.match(SqlParser.DOLLAR_TAG_REGEX);
        if (dollarMatch) {
          const tag = dollarMatch[1];
          if (!inDollarQuote) {
            inDollarQuote = true;
            dollarQuoteTag = tag;
            if (emitOriginal) {
              out += tag;
            }
            i += tag.length;
            continue;
          }
          if (tag === dollarQuoteTag) {
            inDollarQuote = false;
            dollarQuoteTag = '';
            if (emitOriginal) {
              out += tag;
            }
            i += tag.length;
            continue;
          }
        }
      }

      if (!inDollarQuote && char === "'") {
        if (inSingleQuote && nextChar === "'") {
          if (emitOriginal) {
            out += "''";
          }
          i += 2;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        if (emitOriginal) {
          out += char;
        }
        i++;
        continue;
      }

      if (!inSingleQuote && !inDollarQuote) {
        const decision = onCode(sql, i);
        if (decision && decision.length > 0) {
          if (emitOriginal) {
            out += decision.replacement ?? sql.slice(i, i + decision.length);
          }
          i += decision.length;
          continue;
        }
      }

      if (emitOriginal) {
        out += char;
      }
      i++;
    }

    return out;
  }

  private static tryReadIdentifier(sql: string, start: number): string | undefined {
    const first = sql[start] ?? '';
    if (!SqlParser.isIdentifierStart(first)) {
      return undefined;
    }

    let i = start + 1;
    while (i < sql.length && SqlParser.isIdentifierPart(sql[i])) {
      i++;
    }
    return sql.slice(start, i);
  }

  private static tryReadQuotedVariableToken(
    sql: string,
    index: number
  ): { name: string; kind: 'literal' | 'identifier'; length: number } | undefined {
    if (sql[index] !== ':' || (sql[index + 1] !== "'" && sql[index + 1] !== '"')) {
      return undefined;
    }

    const quote = sql[index + 1];
    const name = SqlParser.tryReadIdentifier(sql, index + 2);
    if (!name) {
      return undefined;
    }

    const end = index + 2 + name.length;
    if (sql[end] !== quote) {
      return undefined;
    }

    return {
      name,
      kind: quote === "'" ? 'literal' : 'identifier',
      length: 3 + name.length
    };
  }

  private static escapePgLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private static escapePgIdentifier(value: string): string {
    return `"${value.replace(/"/g, '""')}"`;
  }

  /**
   * Strip SQL comments and string literals while preserving code-only text.
   * Double-quoted identifiers are preserved.
   */
  public static stripCommentsAndStrings(sql: string): string {
    let out = '';
    let i = 0;
    let inSingleQuote = false;
    let inDollarQuote = false;
    let dollarQuoteTag = '';
    let inBlockComment = false;

    while (i < sql.length) {
      const char = sql[i];
      const nextChar = i + 1 < sql.length ? sql[i + 1] : '';
      const peek = sql.substring(i, i + 32);

      if (!inSingleQuote && !inDollarQuote && char === '/' && nextChar === '*') {
        inBlockComment = true;
        out += '  ';
        i += 2;
        continue;
      }

      if (inBlockComment && char === '*' && nextChar === '/') {
        inBlockComment = false;
        out += '  ';
        i += 2;
        continue;
      }

      if (inBlockComment) {
        out += ' ';
        i++;
        continue;
      }

      if (!inSingleQuote && !inDollarQuote && char === '-' && nextChar === '-') {
        const lineEnd = sql.indexOf('\n', i);
        if (lineEnd === -1) {
          out += ' '.repeat(sql.length - i);
          break;
        }
        out += ' '.repeat(lineEnd - i + 1);
        i = lineEnd + 1;
        continue;
      }

      if (!inSingleQuote) {
        const dollarMatch = peek.match(SqlParser.DOLLAR_TAG_REGEX);
        if (dollarMatch) {
          const tag = dollarMatch[1];
          if (!inDollarQuote) {
            inDollarQuote = true;
            dollarQuoteTag = tag;
            out += ' '.repeat(tag.length);
            i += tag.length;
            continue;
          }
          if (tag === dollarQuoteTag) {
            inDollarQuote = false;
            dollarQuoteTag = '';
            out += ' '.repeat(tag.length);
            i += tag.length;
            continue;
          }
        }
      }

      if (!inDollarQuote && char === "'") {
        if (inSingleQuote && nextChar === "'") {
          out += '  ';
          i += 2;
          continue;
        }
        inSingleQuote = !inSingleQuote;
        out += ' ';
        i++;
        continue;
      }

      if (inSingleQuote || inDollarQuote) {
        out += ' ';
        i++;
        continue;
      }

      out += char;
      i++;
    }

    return out;
  }

  /**
   * Normalize identifier casing: quoted identifiers preserve case; unquoted identifiers are lowercased.
   */
  public static normalizeIdentifier(identifier: string): string {
    const trimmed = identifier.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return trimmed.toLowerCase();
  }
  /**
   * Split SQL text into individual statements, respecting semicolons but ignoring them inside:
   * - String literals (single quotes)
   * - Dollar-quoted strings ($$...$$, $tag$...$tag$)
   * - Comments (-- and /* ... *\/)
   */
  public static splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let currentStatement = '';
    let i = 0;
    let inSingleQuote = false;
    let inDollarQuote = false;
    let dollarQuoteTag = '';
    let inBlockComment = false;

    while (i < sql.length) {
      const char = sql[i];
      const nextChar = i + 1 < sql.length ? sql[i + 1] : '';
      const peek = sql.substring(i, i + 10);

      // Handle block comments /* ... */
      if (!inSingleQuote && !inDollarQuote && char === '/' && nextChar === '*') {
        inBlockComment = true;
        currentStatement += char + nextChar;
        i += 2;
        continue;
      }

      if (inBlockComment && char === '*' && nextChar === '/') {
        inBlockComment = false;
        currentStatement += char + nextChar;
        i += 2;
        continue;
      }

      // Handle line comments -- ...
      if (!inSingleQuote && !inDollarQuote && !inBlockComment && char === '-' && nextChar === '-') {
        // Add rest of line to current statement
        const lineEnd = sql.indexOf('\n', i);
        if (lineEnd === -1) {
          currentStatement += sql.substring(i);
          break;
        }
        currentStatement += sql.substring(i, lineEnd + 1);
        i = lineEnd + 1;
        continue;
      }

      // Handle dollar-quoted strings
      if (!inSingleQuote && !inBlockComment) {
        const dollarMatch = peek.match(/^(\$[a-zA-Z0-9_]*\$)/);
        if (dollarMatch) {
          const tag = dollarMatch[1];
          if (!inDollarQuote) {
            inDollarQuote = true;
            dollarQuoteTag = tag;
            currentStatement += tag;
            i += tag.length;
            continue;
          } else if (tag === dollarQuoteTag) {
            inDollarQuote = false;
            dollarQuoteTag = '';
            currentStatement += tag;
            i += tag.length;
            continue;
          }
        }
      }

      // Handle single-quoted strings
      if (!inDollarQuote && !inBlockComment && char === "'") {
        if (inSingleQuote && nextChar === "'") {
          // Escaped quote ''
          currentStatement += "''";
          i += 2;
          continue;
        }
        inSingleQuote = !inSingleQuote;
      }

      // Handle semicolon as statement separator
      if (!inSingleQuote && !inDollarQuote && !inBlockComment && char === ';') {
        currentStatement += char;
        const trimmed = currentStatement.trim();
        if (trimmed) {
          statements.push(trimmed);
        }
        currentStatement = '';
        i++;
        continue;
      }

      currentStatement += char;
      i++;
    }

    // Add remaining statement if any
    const trimmed = currentStatement.trim();
    if (trimmed) {
      statements.push(trimmed);
    }

    return statements.filter(s => s.length > 0);
  }

  /**
   * Whether the SQL uses at least one `:paramName` placeholder (outside literals/comments; `::` casts excluded).
   */
  public static hasNamedParameters(sql: string): boolean {
    return SqlParser.substituteNamedParametersWithPgPlaceholders(sql).paramNames.length > 0;
  }

  /**
   * Detects PostgreSQL positional parameters (`$N`) outside literals/comments.
   */
  public static detectPositionalParameters(sql: string): number[] {
    const found = new Set<number>();

    SqlParser.scanOutsideSpecial(
      sql,
      (input, index) => {
        if (input[index] !== '$') {
          return undefined;
        }
        const rest = input.slice(index + 1);
        const match = rest.match(/^([1-9][0-9]*)/);
        if (!match) {
          return undefined;
        }

        const raw = match[1];
        found.add(Number(raw));
        return { length: 1 + raw.length };
      },
      false
    );

    return [...found].sort((a, b) => a - b);
  }

  /**
   * Substitute psql-style quoted variables `:'name'` and `:"name"`.
   */
  public static substituteQuotedPsqlVariables(
    sql: string,
    values: Record<string, string>
  ): { text: string; paramNames: string[] } {
    const ordered: string[] = [];
    const seen = new Set<string>();

    const text = SqlParser.scanOutsideSpecial(
      sql,
      (input, index) => {
        const token = SqlParser.tryReadQuotedVariableToken(input, index);
        if (!token) {
          return undefined;
        }

        if (!seen.has(token.name)) {
          seen.add(token.name);
          ordered.push(token.name);
        }

        const rawValue = values[token.name] ?? '';
        const replacement =
          token.kind === 'literal'
            ? SqlParser.escapePgLiteral(rawValue)
            : SqlParser.escapePgIdentifier(rawValue);

        return { length: token.length, replacement };
      },
      true
    );

    return { text, paramNames: ordered };
  }

  /**
   * Detect positional (`$N`), named (`:name`), and psql-quoted (`:'x'`, `:"x"`) parameters.
   */
  public static detectParameters(sql: string): {
    positional: number[];
    named: string[];
    quoted: { name: string; kind: 'literal' | 'identifier' }[];
  } {
    const positional = SqlParser.detectPositionalParameters(sql);
    const named = SqlParser.substituteNamedParametersWithPgPlaceholders(sql).paramNames;

    const quoted: { name: string; kind: 'literal' | 'identifier' }[] = [];
    const seen = new Set<string>();
    SqlParser.scanOutsideSpecial(
      sql,
      (input, index) => {
        const token = SqlParser.tryReadQuotedVariableToken(input, index);
        if (!token) {
          return undefined;
        }

        const key = `${token.kind}:${token.name}`;
        if (!seen.has(key)) {
          seen.add(key);
          quoted.push({ name: token.name, kind: token.kind });
        }

        return { length: token.length };
      },
      false
    );

    return { positional, named, quoted };
  }

  /**
   * Replaces `:paramName` tokens with PostgreSQL positional placeholders `$1`, `$2`, … in first-seen name order.
   * Does not replace inside strings, dollar-quotes, or comments. Skips PostgreSQL `::type` casts.
   */
  public static substituteNamedParametersWithPgPlaceholders(sql: string): { text: string; paramNames: string[] } {
    const ordered: string[] = [];
    const seen = new Map<string, number>();

    const pushParam = (name: string): number => {
      const existing = seen.get(name);
      if (existing !== undefined) {
        return existing;
      }
      const idx = ordered.length + 1;
      seen.set(name, idx);
      ordered.push(name);
      return idx;
    };

    const out = SqlParser.scanOutsideSpecial(
      sql,
      (input, index) => {
        const char = input[index];
        const nextChar = index + 1 < input.length ? input[index + 1] : '';

        if (char === ':' && nextChar === ':') {
          return { length: 2, replacement: '::' };
        }

        if (char === ':') {
          const name = SqlParser.tryReadIdentifier(input, index + 1);
          if (name) {
            const idx = pushParam(name);
            return { length: 1 + name.length, replacement: `$${idx}` };
          }
        }

        return undefined;
      },
      true
    );

    return { text: out, paramNames: ordered };
  }

  public static parseCommentParameters(sql: string): {
    positional: Map<number, string | null>;
    named: Map<string, string | null>;
  } {
    const positional = new Map<number, string | null>();
    const named = new Map<string, string | null>();
    const lineRe = /^--\s*(\$(\d+)|:([a-zA-Z_][a-zA-Z0-9_]*))=(.*?)\s*$/;

    for (const line of sql.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      if (!trimmed.startsWith('--')) { break; }
      const m = lineRe.exec(trimmed);
      if (!m) { continue; }
      const val = SqlParser.parseCommentParamValue(m[4].trim());
      if (m[2]) {
        positional.set(Number(m[2]), val);
      } else if (m[3]) {
        named.set(m[3], val);
      }
    }

    return { positional, named };
  }

  private static parseCommentParamValue(raw: string): string | null {
    if (/^null$/i.test(raw)) { return null; }
    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
      return raw.slice(1, -1).replace(/''/g, "'");
    }
    return raw;
  }
}
