/**
 * Parses `pg_restore --list` output into selectable TOC rows.
 * Lines look like: "123; 1259 16384 TABLE DATA public foo postgres"
 */

export interface RestoreListRow {
  /** Full original line */
  rawLine: string;
  /** Leading numeric id before semicolon, if present */
  id: string | null;
  /** Rough classification for UI */
  kind: string;
}

const TOC_LINE = /^(\d+);\s*(.*)$/;

export function parseRestoreListOutput(text: string): RestoreListRow[] {
  const rows: RestoreListRow[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith(';')) {
      continue;
    }
    const m = TOC_LINE.exec(trimmed);
    if (m) {
      const rest = m[2] ?? '';
      const parts = rest.trim().split(/\s+/);
      const kind = parts.length >= 3 ? parts[2]! : 'UNKNOWN';
      rows.push({ rawLine: trimmed, id: m[1]!, kind });
    }
  }
  return rows;
}

/** Build list file body for pg_restore -L from selected raw lines (preserves order) */
export function buildListFileFromSelection(selectedRawLines: string[]): string {
  return selectedRawLines.join('\n') + '\n';
}
