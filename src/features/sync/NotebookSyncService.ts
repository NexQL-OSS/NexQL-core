import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { contentHash } from './envelope';
import { readNotebookSyncId } from './notebookSyncId';
import type { NotebookSyncPayload, SyncItemMeta } from './types';
import { DEFAULT_NOTEBOOK_FOLDER } from './constants';
import type { SyncIndex } from './SyncIndex';

interface RawCell {
  value: string;
  kind?: string;
  language?: string;
}

/** Normalize cells so hashes match regardless of source (file walk vs open document). */
function normalizeCells(cells: RawCell[]): Array<{ value: string; kind: string; language: string }> {
  return cells.map((c) => {
    const kind = c.kind === 'markdown' ? 'markdown' : 'sql';
    return { value: c.value ?? '', kind, language: kind };
  });
}

function buildPayload(
  syncId: string,
  name: string,
  metadata: Record<string, unknown>,
  cells: RawCell[],
): NotebookSyncPayload {
  return {
    syncId,
    name,
    connectionId: String(metadata.connectionId ?? ''),
    databaseName: metadata.databaseName as string | undefined,
    host: metadata.host as string | undefined,
    port: metadata.port as number | undefined,
    cells: normalizeCells(cells),
  };
}

export class NotebookSyncService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly index: SyncIndex,
  ) {}

  getNotebookFolder(): string {
    const configured = vscode.workspace
      .getConfiguration()
      .get<string>('postgresExplorer.sync.notebookFolder');
    let folder = configured?.trim() || path.join(os.homedir(), DEFAULT_NOTEBOOK_FOLDER);
    if (folder.startsWith('~/')) {
      folder = path.join(os.homedir(), folder.slice(2));
    } else if (folder === '~') {
      folder = os.homedir();
    }
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
    return folder;
  }

  /** Roots to scan: extension global storage (primary) plus legacy sync folder. */
  private notebookRoots(): string[] {
    const primary = this.context.globalStorageUri.fsPath;
    const legacy = this.getNotebookFolder();
    return legacy === primary ? [primary] : [primary, legacy];
  }

  private notebookTargetDir(payload: NotebookSyncPayload): string {
    if (payload.connectionId && payload.databaseName) {
      const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
      const conn = connections.find((c) => String(c.id) === payload.connectionId);
      const connSegment = ConnectionUtils.toSafeSegment(conn?.name ?? payload.connectionId);
      const dbSegment = ConnectionUtils.toSafeSegment(payload.databaseName);
      const dir = path.join(this.context.globalStorageUri.fsPath, connSegment, dbSegment);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      return dir;
    }
    return this.getNotebookFolder();
  }

  /** Persist a syncId into a notebook file on disk, preserving other content. */
  private writeSyncIdToFile(filePath: string, parsed: Record<string, any>, syncId: string): void {
    parsed.metadata = { ...(parsed.metadata ?? {}), syncId };
    if (parsed.metadata.custom?.metadata) {
      parsed.metadata.custom.metadata.syncId = syncId;
    }
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  }

  /** Persist a syncId into an open notebook document's metadata. */
  private async writeSyncIdToDocument(doc: vscode.NotebookDocument, syncId: string): Promise<boolean> {
    const metadata = { ...doc.metadata, syncId } as Record<string, unknown>;
    const custom = metadata.custom as { metadata?: Record<string, unknown> } | undefined;
    if (custom?.metadata) {
      metadata.custom = { ...custom, metadata: { ...custom.metadata, syncId } };
    }
    const edit = new vscode.WorkspaceEdit();
    edit.set(doc.uri, [vscode.NotebookEdit.updateNotebookMetadata(metadata)]);
    return vscode.workspace.applyEdit(edit);
  }

  async collectLocalNotebooks(deviceId: string): Promise<Array<{ meta: SyncItemMeta; plaintext: Buffer }>> {
    const items: Array<{ meta: SyncItemMeta; plaintext: Buffer }> = [];
    const seenIds = new Set<string>();
    const seenPaths = new Set<string>();

    const collect = (
      syncId: string,
      name: string,
      filePath: string,
      metadata: Record<string, unknown>,
      cells: RawCell[],
      mtimeMs: number | undefined,
    ): void => {
      const payload = buildPayload(syncId, name, metadata, cells);
      const plaintext = Buffer.from(JSON.stringify(payload));
      const hash = contentHash(plaintext);
      const { revision, updatedAt } = this.index.observe(syncId, 'notebook', hash, {
        name,
        filePath,
        fallbackRevision: typeof metadata.revision === 'number' ? metadata.revision : undefined,
        modifiedAt: mtimeMs,
      });
      items.push({
        meta: {
          id: syncId,
          kind: 'notebook',
          contentHash: hash,
          revision,
          updatedAt,
          deviceId,
          deleted: false,
        },
        plaintext,
      });
      seenIds.add(syncId);
      seenPaths.add(path.resolve(filePath));
    };

    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) {
        return;
      }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.pgsql')) {
          const resolvedFull = path.resolve(full);
          if (seenPaths.has(resolvedFull)) {
            continue;
          }
          try {
            const raw = fs.readFileSync(full);
            const parsed = JSON.parse(raw.toString());
            let syncId = readNotebookSyncId(parsed);
            if (syncId && seenIds.has(syncId)) {
              // Another file already claimed this identity this scan. Never delete
              // here — silent deletion caused data loss. Skip the extra copy; if it
              // is a genuine duplicate, applyNotebook reconciles it on the next pull.
              continue;
            }
            if (!syncId) {
              syncId = crypto.randomUUID();
              this.writeSyncIdToFile(full, parsed, syncId);
            }
            const mtimeMs = fs.statSync(full).mtimeMs;
            collect(
              syncId,
              path.basename(full, '.pgsql'),
              full,
              parsed.metadata ?? {},
              parsed.cells ?? [],
              mtimeMs,
            );
          } catch {
            /* skip corrupt files */
          }
        }
      }
    };

    for (const doc of vscode.workspace.notebookDocuments) {
      if (doc.notebookType !== 'postgres-notebook' && doc.notebookType !== 'postgres-query') {
        continue;
      }
      const resolvedFsPath = path.resolve(doc.uri.fsPath);
      if (doc.isUntitled || doc.uri.scheme !== 'file' || seenPaths.has(resolvedFsPath)) {
        continue;
      }
      // Skip docs whose backing file was deleted on disk. VS Code keeps the
      // editor open after a delete, so without this the open document would
      // re-observe the item every sync — resurrecting the index entry and
      // blocking the delete tombstone (the item never looks "gone locally").
      if (!fs.existsSync(doc.uri.fsPath)) {
        continue;
      }
      const metadata = doc.metadata as Record<string, unknown>;
      let syncId = typeof metadata.syncId === 'string' ? metadata.syncId : undefined;
      
      // If missing in memory, check if file on disk has it to prevent generating duplicate ID
      if (!syncId && fs.existsSync(doc.uri.fsPath)) {
        try {
          const raw = fs.readFileSync(doc.uri.fsPath);
          const parsed = JSON.parse(raw.toString());
          syncId = readNotebookSyncId(parsed);
        } catch {
          /* ignore */
        }
      }

      if (!syncId || seenIds.has(syncId)) {
        syncId = crypto.randomUUID();
        const persisted = await this.writeSyncIdToDocument(doc, syncId);
        if (!persisted) {
          // Identity would not survive this session; syncing now would create
          // a duplicate remote item on every run.
          continue;
        }
      }
      const cells: RawCell[] = doc.getCells().map((cell) => ({
        value: cell.document.getText(),
        kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'sql',
      }));
      collect(
        syncId,
        path.basename(doc.uri.fsPath, '.pgsql'),
        doc.uri.fsPath,
        metadata,
        cells,
        undefined,
      );
    }

    for (const root of this.notebookRoots()) {
      walk(root);
    }

    return items;
  }

  /** Find the on-disk file for a syncId: index first, then folder scan. */
  private resolvePathBySyncId(syncId: string): string | undefined {
    const indexed = this.index.get(syncId)?.filePath;
    if (indexed && fs.existsSync(indexed)) {
      return indexed;
    }
    for (const root of this.notebookRoots()) {
      const scan = (dir: string): string | undefined => {
        if (!fs.existsSync(dir)) {
          return undefined;
        }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = scan(full);
            if (found) {
              return found;
            }
          } else if (entry.name.endsWith('.pgsql')) {
            try {
              const parsed = JSON.parse(fs.readFileSync(full).toString());
              if (readNotebookSyncId(parsed) === syncId) {
                return full;
              }
            } catch {
              /* ignore */
            }
          }
        }
        return undefined;
      };
      const found = scan(root);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  /** Pick a free file path for `name`, suffixing when another identity owns it. */
  private availablePath(folder: string, name: string, syncId: string): string {
    let candidate = path.join(folder, `${name}.pgsql`);
    let counter = 2;
    while (fs.existsSync(candidate)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate).toString());
        if (readNotebookSyncId(parsed) === syncId) {
          return candidate;
        }
      } catch {
        /* occupied by unreadable file — treat as foreign */
      }
      candidate = path.join(folder, `${name} (${counter}).pgsql`);
      counter += 1;
    }
    return candidate;
  }

  async applyNotebook(payload: NotebookSyncPayload, meta: SyncItemMeta): Promise<string> {
    const folder = this.notebookTargetDir(payload);
    const syncId = meta.id;
    // Conflict copies arrive under a derived id; label them so users can tell
    // the copies apart and so the original file is not overwritten.
    const isConflictCopy = payload.syncId !== syncId;
    const name = isConflictCopy
      ? `${payload.name} (conflict from ${meta.deviceId})`
      : payload.name;

    const targetPath = path.join(folder, `${name}.pgsql`);
    const existing = isConflictCopy ? undefined : this.resolvePathBySyncId(syncId);
    let filePath: string;
    if (existing) {
      filePath = targetPath;
      if (path.resolve(existing) !== path.resolve(filePath)) {
        if (fs.existsSync(filePath)) {
          const occupant = JSON.parse(fs.readFileSync(filePath).toString());
          if (readNotebookSyncId(occupant) !== syncId) {
            filePath = this.availablePath(folder, name, syncId);
          }
        }
        if (path.resolve(existing) !== path.resolve(filePath)) {
          fs.renameSync(existing, filePath);
        }
      }
    } else {
      filePath = fs.existsSync(targetPath)
        ? this.availablePath(folder, name, syncId)
        : targetPath;
    }

    const metadata = {
      connectionId: payload.connectionId,
      databaseName: payload.databaseName,
      host: payload.host,
      port: payload.port,
      syncId,
      revision: meta.revision,
      updatedAt: meta.updatedAt,
    };
    const fileContent = {
      cells: normalizeCells(payload.cells),
      metadata: {
        ...metadata,
        custom: {
          cells: [],
          metadata: { ...metadata, enableScripts: true },
        },
      },
    };
    fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2));

    this.index.update(syncId, {
      kind: 'notebook',
      name,
      filePath,
      lastObservedHash: meta.contentHash,
    });
    return filePath;
  }

  /** Remove the local file for a remote tombstone. */
  async deleteNotebook(meta: SyncItemMeta): Promise<void> {
    const filePath = this.resolvePathBySyncId(meta.id);
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.index.remove(meta.id);
  }

  /** True when a notebook with this sync id exists on disk. */
  isPresentOnDisk(syncId: string): boolean {
    return !!this.resolvePathBySyncId(syncId);
  }
}
