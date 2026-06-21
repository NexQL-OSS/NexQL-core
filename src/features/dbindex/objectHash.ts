import * as crypto from 'crypto';
import { ObjectEntry } from './types';

/**
 * Computes a SHA-1 hash of the structural characteristics of a database object entry.
 * This determines if the index shard needs to be rewritten, and if embeddings need refresh.
 */
export function computeObjectHash(entry: Partial<ObjectEntry>): string {
  const parts: string[] = [
    entry.kind || '',
    String(entry.rowEstimate || 0),
    entry.comment || '',
  ];

  if (entry.columns) {
    // Columns are ordered by ordinal position
    const colStrings = entry.columns.map(c =>
      `${c.name}:${c.type}:${c.notNull ? 'notnull' : 'nullable'}:${c.default || ''}:${c.comment || ''}:${c.ordinal}`
    );
    parts.push(`cols:${colStrings.join('|')}`);
  }

  if (entry.primaryKey) {
    parts.push(`pk:${entry.primaryKey.join(',')}`);
  }

  if (entry.foreignKeys) {
    const fkStrings = entry.foreignKeys.map(fk =>
      `${fk.name}:${fk.columns.join(',')}:${fk.refTable}:${fk.refColumns.join(',')}`
    ).sort();
    parts.push(`fks:${fkStrings.join('|')}`);
  }

  if (entry.indexes) {
    const idxStrings = entry.indexes.map(idx =>
      `${idx.name}:${idx.columns.join(',')}:${idx.unique}:${idx.method}:${idx.partial || ''}`
    ).sort();
    parts.push(`idx:${idxStrings.join('|')}`);
  }

  if (entry.checks) {
    const checkStrings = entry.checks.map(ck =>
      `${ck.name}:${ck.expr}`
    ).sort();
    parts.push(`checks:${checkStrings.join('|')}`);
  }

  if (entry.definition) {
    parts.push(`def:${entry.definition}`);
  }

  if (entry.signature) {
    parts.push(`sig:${entry.signature}:${entry.language || ''}:${entry.volatility || ''}`);
  }

  if (entry.values) {
    parts.push(`vals:${entry.values.join(',')}`);
  }

  if (entry.baseType) {
    parts.push(`base:${entry.baseType}:${entry.constraint || ''}`);
  }

  const combined = parts.join(';;');
  return crypto.createHash('sha1').update(combined).digest('hex');
}
