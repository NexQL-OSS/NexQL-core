// ---------------------------------------------------------------------------
// Pure, dependency-free parsers for the Data Import wizard.
// No VS Code / Node imports so these can be unit-tested in isolation.
// ---------------------------------------------------------------------------

export type ParsedTable = { headers: string[]; rows: (string | null)[][] };

export type DataFormat = 'csv' | 'tsv' | 'custom' | 'json' | 'ndjson';

// ---------------------------------------------------------------------------
// CSV Parser  (RFC 4180 compliant, supports custom delimiter/quote/escape)
// ---------------------------------------------------------------------------

export function parseCsv(
  content: string,
  delimiter: string,
  quoteChar: string,
  escapeChar: string,
  hasHeader: boolean,
  nullValue: string
): ParsedTable {
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const result: (string | null)[][] = [];
  let i = 0;
  const len = lines.length;

  const parseRow = (): (string | null)[] => {
    const fields: (string | null)[] = [];
    while (i < len && lines[i] !== '\n') {
      // Skip delimiter between fields
      if (fields.length > 0) {
        if (lines[i] === delimiter[0]) { i++; }
        else { break; }
      }

      if (lines[i] === quoteChar) {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < len) {
          const ch = lines[i];
          if (ch === escapeChar && i + 1 < len && lines[i + 1] === quoteChar) {
            field += quoteChar;
            i += 2;
          } else if (ch === quoteChar) {
            i++; // skip closing quote
            break;
          } else {
            field += ch;
            i++;
          }
        }
        fields.push(field === nullValue ? null : field);
      } else {
        // Unquoted field
        let field = '';
        while (i < len && lines[i] !== delimiter[0] && lines[i] !== '\n') {
          field += lines[i++];
        }
        fields.push(field === nullValue || field === '' && nullValue === '' ? null : field === nullValue ? null : field || null);
      }
    }
    if (i < len && lines[i] === '\n') { i++; }
    return fields;
  };

  while (i < len) {
    if (lines[i] === '\n') { i++; continue; } // blank line
    const row = parseRow();
    if (row.length > 0) { result.push(row); }
  }

  let headers: string[];
  let rows: (string | null)[][];
  if (hasHeader && result.length > 0) {
    headers = result[0].map((h, idx) => (h != null ? String(h) : `col_${idx + 1}`));
    rows = result.slice(1);
  } else {
    const maxCols = result.reduce((m, r) => Math.max(m, r.length), 0);
    headers = Array.from({ length: maxCols }, (_, i) => `col_${i + 1}`);
    rows = result;
  }

  return { headers, rows };
}

// ---------------------------------------------------------------------------
// JSON / NDJSON parsers
// ---------------------------------------------------------------------------

/** Flatten an array of records into columnar headers/rows (union of keys, first-seen order). */
export function rowsFromRecords(records: unknown[]): ParsedTable {
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const rec of records) {
    if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
      for (const k of Object.keys(rec as Record<string, unknown>)) {
        if (!seen.has(k)) { seen.add(k); headers.push(k); }
      }
    }
  }
  const cell = (v: unknown): string | null => {
    if (v === undefined || v === null) { return null; }
    if (typeof v === 'object') { return JSON.stringify(v); } // nested objects/arrays → JSON text
    return String(v);
  };
  const rows = records.map((rec) =>
    headers.map((h) => cell(rec && typeof rec === 'object' ? (rec as Record<string, unknown>)[h] : undefined)),
  );
  return { headers, rows };
}

/** Parse a JSON document: an array of objects, or a single object. */
export function parseJson(content: string): ParsedTable {
  const data = JSON.parse(content);
  const records = Array.isArray(data)
    ? data
    : data && typeof data === 'object'
      ? [data]
      : [];
  if (records.length === 0) {
    throw new Error('JSON must be an array of objects or a single object.');
  }
  return rowsFromRecords(records);
}

/** Parse newline-delimited JSON (one object per line). */
export function parseNdjson(content: string, allowPartialLast = false): ParsedTable {
  const lines = content.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const records: unknown[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    try {
      records.push(JSON.parse(lines[idx]));
    } catch (e) {
      // When previewing a truncated sample, the final line may be incomplete.
      if (allowPartialLast && idx === lines.length - 1) { break; }
      throw new Error(`Invalid JSON on line ${idx + 1}: ${(e as Error).message}`);
    }
  }
  return rowsFromRecords(records);
}

/** Detect a default format from a file extension. */
export function formatFromExtension(ext: string): DataFormat {
  switch (ext.toLowerCase()) {
    case 'json': return 'json';
    case 'ndjson':
    case 'jsonl': return 'ndjson';
    case 'tsv': return 'tsv';
    default: return 'csv';
  }
}

/** Format-aware parse dispatcher used by both preview and import. */
export function parseData(
  content: string,
  opts: { format: DataFormat; delimiter: string; quoteChar: string; escapeChar: string; hasHeader: boolean; nullValue: string; allowPartialLast?: boolean },
): ParsedTable {
  switch (opts.format) {
    case 'json':
      return parseJson(content);
    case 'ndjson':
      return parseNdjson(content, opts.allowPartialLast);
    case 'tsv':
      return parseCsv(content, '\t', opts.quoteChar, opts.escapeChar, opts.hasHeader, opts.nullValue);
    case 'csv':
    case 'custom':
    default:
      return parseCsv(content, opts.delimiter, opts.quoteChar, opts.escapeChar, opts.hasHeader, opts.nullValue);
  }
}
