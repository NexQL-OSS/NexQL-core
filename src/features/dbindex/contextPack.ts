import * as vscode from 'vscode';
import { IndexManifest, ObjectEntry } from './types';
import { IndexStore } from './IndexStore';
import { TableSchema, ColumnInfo, ForeignKeyInfo, IndexInfo, renderTableSchema } from '../../common/schemaRender';

/**
 * Maps an indexed ObjectEntry into the TableSchema structure required by schemaRender.ts.
 */
export function mapObjectEntryToTableSchema(schema: string, name: string, entry: ObjectEntry): TableSchema {
  const columns: ColumnInfo[] = entry.columns.map(c => ({
    name: c.name,
    dataType: c.type,
    isNullable: c.notNull ? 'NO' : 'YES',
    default: c.default
  }));

  const pk = entry.primaryKey || [];

  const fks: ForeignKeyInfo[] = (entry.foreignKeys || []).map(fk => {
    const parts = fk.refTable.split('.');
    return {
      constraintName: fk.name,
      column: fk.columns[0] || '',
      refSchema: parts[0] || 'public',
      refTable: parts[1] || '',
      refColumn: fk.refColumns[0] || ''
    };
  });

  const indexes: IndexInfo[] = (entry.indexes || []).map(idx => ({
    name: idx.name,
    columns: idx.columns,
    isUnique: idx.unique,
    isPrimary: pk.includes(idx.columns[0] || '')
  }));

  return {
    schema,
    table: name,
    columns,
    pk,
    fks,
    indexes,
    rowEstimate: entry.rowEstimate || null
  };
}

/**
 * Build the Markdown string injected into the system prompt from the ranked hits.
 */
export async function buildContextPack(
  hits: Array<{ ref: string; detail: 'full' | 'columns' | 'skeleton' }>,
  store: IndexStore,
  baseDir: vscode.Uri,
  manifest: IndexManifest,
  joinHints: string[],
  drift: boolean,
  userMessage?: string
): Promise<string> {
  const sections: string[] = [];

  // 1. Header
  const dateStr = new Date(manifest.indexedAt).toLocaleDateString();
  let header = `--- DATABASE INDEX SCHEMA CONTEXT (${manifest.buildMode} index from ${dateStr})`;
  if (drift) {
    header += `\n-- ⚠️ WARNING: Live database fingerprint has drifted. Cached index might be slightly stale.`;
  }
  sections.push(header);

  // 2. Objects Detail
  for (const hit of hits) {
    const parts = hit.ref.split('.');
    const schema = parts[0] || 'public';
    const name = parts[1] || '';

    const entry = await store.getObjectEntry(baseDir, manifest, schema, name);
    if (!entry) {
      continue;
    }

    if (entry.kind === 'table' || entry.kind === 'view' || entry.kind === 'matview') {
      const tableSchema = mapObjectEntryToTableSchema(schema, name, entry);
      if (hit.detail === 'full') {
        sections.push(renderTableSchema(tableSchema, { userMessage }));
      } else if (hit.detail === 'columns') {
        sections.push(renderTableSchema(tableSchema, { userMessage, maxColumns: 6 }));
      } else {
        // Skeleton detail
        const colList = entry.columns.map(c => c.name).join(', ');
        let skeletonStr = `## Table: ${hit.ref} (skeleton)\nColumns: ${colList}`;
        if (entry.primaryKey && entry.primaryKey.length > 0) {
          skeletonStr += `\nPrimary Key: ${entry.primaryKey.join(', ')}`;
        }
        sections.push(skeletonStr);
      }
    } else if (entry.kind === 'function') {
      let funcStr = `## Function: ${hit.ref}\n- Signature: ${entry.signature || ''}\n- Language: ${entry.language || ''}\n- Volatility: ${entry.volatility || ''}`;
      if (entry.comment) {
        funcStr += `\n- Description: ${entry.comment}`;
      }
      sections.push(funcStr);
    } else if (entry.kind === 'enum') {
      const vals = entry.values ? entry.values.join(', ') : '';
      sections.push(`## Enum: ${hit.ref}\nValues: [${vals}]`);
    } else if (entry.kind === 'domain') {
      let domStr = `## Domain: ${hit.ref}\n- Base Type: ${entry.baseType || ''}`;
      if (entry.constraint) {
        domStr += `\n- Constraint: ${entry.constraint}`;
      }
      sections.push(domStr);
    }
  }

  // 3. Join hints
  if (joinHints.length > 0) {
    sections.push(`### Suggested Join Conditions:\n` + joinHints.map(h => `- ${h}`).join('\n'));
  }

  sections.push(`--- END DATABASE CONTEXT ---`);
  return sections.join('\n\n');
}
