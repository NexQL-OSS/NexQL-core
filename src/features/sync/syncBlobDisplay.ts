import type { SyncKind } from './types';

/** Extract a display name from a sync blob without applying it. */
export function displayNameFromSyncBlob(kind: SyncKind, plaintext: Buffer): string {
  try {
    const data = JSON.parse(plaintext.toString()) as Record<string, unknown>;
    switch (kind) {
      case 'connection':
        return String(data.name ?? `${data.host}:${data.port}`);
      case 'query':
        return String(data.title ?? data.id ?? 'Query');
      case 'notebook':
        return String(data.name ?? data.syncId ?? 'Notebook');
      default:
        return 'Item';
    }
  } catch {
    return 'Item';
  }
}

/** Secondary label for cloud list rows (connection group, notebook db, etc.). */
export function detailFromSyncBlob(kind: SyncKind, plaintext: Buffer): string | undefined {
  try {
    const data = JSON.parse(plaintext.toString()) as Record<string, unknown>;
    switch (kind) {
      case 'connection': {
        const group = typeof data.group === 'string' ? data.group.trim() : '';
        return group || undefined;
      }
      case 'notebook': {
        const parts: string[] = [];
        if (typeof data.connectionName === 'string' && data.connectionName) {
          parts.push(data.connectionName);
        }
        if (typeof data.databaseName === 'string' && data.databaseName) {
          parts.push(data.databaseName);
        }
        if (Array.isArray(data.folderPath) && data.folderPath.length) {
          parts.push(data.folderPath.join('/'));
        }
        return parts.length ? parts.join(' · ') : undefined;
      }
      case 'query':
        return typeof data.databaseName === 'string' ? data.databaseName : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}
