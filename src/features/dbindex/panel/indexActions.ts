import * as vscode from 'vscode';
import { IndexStore, safeSegment } from '../IndexStore';
import { IndexBuilder } from '../IndexBuilder';
import { ObjectEntry } from '../types';

export interface DbIndexInfo {
  connectionId: string;
  connectionName: string;
  database: string;
  indexedAt: string;
  tables: number;
  views: number;
  functions: number;
  depth: number | string;
  schemas: string[];
  piiCount: number;
  drift: boolean;
}

export interface DbIndexState {
  enableEmbeddings: boolean;
  indexes: DbIndexInfo[];
}

export async function getDbIndexesState(store: IndexStore): Promise<DbIndexState> {
  const config = vscode.workspace.getConfiguration();
  const enableEmbeddings = config.get<boolean>('postgresExplorer.dbIndex.enableEmbeddings', false);

  const connections: any[] = config.get<any[]>('postgresExplorer.connections') || [];
  const indexes: DbIndexInfo[] = [];

  for (const conn of connections) {
    if (!conn.id) continue;
    const connDir = vscode.Uri.joinPath(store.globalStorageUri, 'dbindex', safeSegment(conn.id));
    let dbDirs: [string, vscode.FileType][] = [];
    try {
      dbDirs = await vscode.workspace.fs.readDirectory(connDir);
    } catch {
      continue;
    }
    for (const [dbDirName, dbFileType] of dbDirs) {
      if (dbFileType !== vscode.FileType.Directory) continue;
      const baseDir = vscode.Uri.joinPath(connDir, dbDirName);
      const manifest = await store.readManifest(baseDir);
      if (manifest) {
        let drift = false;
        try {
          const { AutoRefreshService } = require('../../../services/AutoRefreshService');
          const activeFp = AutoRefreshService.getFingerprint?.(conn.id, manifest.database);
          if (activeFp && activeFp !== manifest.schemaFingerprint) {
            drift = true;
          }
        } catch {
          // ignore
        }

        indexes.push({
          connectionId: conn.id,
          connectionName: conn.name || 'Unnamed',
          database: manifest.database || dbDirName,
          indexedAt: manifest.indexedAt,
          tables: manifest.counts.tables,
          views: manifest.counts.views,
          functions: manifest.counts.functions,
          depth: manifest.buildDepth,
          schemas: manifest.scope.includedSchemas,
          piiCount: manifest.scope.piiExcludedColumns.length,
          drift,
        });
      }
    }
  }

  return {
    enableEmbeddings,
    indexes,
  };
}

export async function handleRebuildIndex(
  store: IndexStore,
  connectionId: string,
  database: string,
  onStateChange: () => Promise<void>
): Promise<void> {
  const baseDir = store.getBaseDir(connectionId, database);
  const manifest = await store.readManifest(baseDir);
  if (!manifest) return;

  const builder = new IndexBuilder(store);
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Rebuilding Index: ${database}`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        await builder.build(
          connectionId,
          database,
          manifest.scope,
          manifest.buildDepth,
          manifest.buildMode,
          manifest.environment,
          token,
          progress
        );
        vscode.window.showInformationMessage(`Index rebuilt successfully for "${database}"!`);
        await onStateChange();
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to rebuild index: ${err.message || err}`);
      }
    }
  );
}

export async function handleClearIndex(
  store: IndexStore,
  connectionId: string,
  database: string,
  onStateChange: () => Promise<void>
): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    `Delete local index for database "${database}"?`,
    'Delete'
  );
  if (confirm === 'Delete') {
    await store.clearIndex(connectionId, database);
    vscode.window.showInformationMessage(`Index deleted for "${database}".`);
    await onStateChange();
  }
}

export async function handleExportIndex(
  store: IndexStore,
  connectionId: string,
  database: string
): Promise<void> {
  const baseDir = store.getBaseDir(connectionId, database);
  const manifest = await store.readManifest(baseDir);
  if (!manifest) {
    vscode.window.showErrorMessage('No index configuration found to export.');
    return;
  }

  const saveUri = await vscode.window.showSaveDialog({
    title: 'Export Schema Data Dictionary',
    saveLabel: 'Export',
    filters: { Markdown: ['md'] },
    defaultUri: vscode.Uri.file(`${database}_data_dictionary.md`),
  });

  if (!saveUri) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Compiling Data Dictionary...',
    },
    async () => {
      const mdParts: string[] = [
        `# Data Dictionary: ${database}`,
        `*Generated from NexQL Local Index on ${new Date(manifest.indexedAt).toLocaleDateString()}*\n`,
        `## Overview`,
        `- **PG Version**: ${manifest.pgVersion}`,
        `- **Build Depth**: ${manifest.buildDepth}`,
        `- **Counts**: ${manifest.counts.tables} tables, ${manifest.counts.views} views, ${manifest.counts.functions} functions\n`,
      ];

      // Gather all schemas and objects
      for (const shard of manifest.shards) {
        mdParts.push(`## Schema: ${shard.schema}\n`);

        const shardUri = vscode.Uri.joinPath(baseDir, shard.file);
        try {
          const data = await vscode.workspace.fs.readFile(shardUri);
          const entries = JSON.parse(Buffer.from(data).toString('utf-8')) as Record<string, ObjectEntry>;
          
          for (const [ref, entry] of Object.entries(entries)) {
            mdParts.push(`### ${entry.kind.toUpperCase()}: ${ref}`);
            if (entry.comment) {
              mdParts.push(`*Description: ${entry.comment}*\n`);
            }

            if (entry.columns && entry.columns.length > 0) {
              mdParts.push('| Column | Type | Nullability | Default | Description |');
              mdParts.push('|--------|------|----------|---------|-------------|');
              for (const col of entry.columns) {
                mdParts.push(`| ${col.name} | ${col.type} | ${col.notNull ? 'NO' : 'YES'} | ${col.default || '-'} | ${col.comment || '-'} |`);
              }
              mdParts.push('');
            }

            if (entry.definition) {
              mdParts.push('**Definition:**');
              mdParts.push('```sql');
              mdParts.push(entry.definition);
              mdParts.push('```\n');
            }
          }
        } catch {
          // skip shard fail
        }
      }

      await vscode.workspace.fs.writeFile(saveUri, Buffer.from(mdParts.join('\n'), 'utf-8'));
      vscode.window.showInformationMessage('Data Dictionary exported successfully.');
    }
  );
}
