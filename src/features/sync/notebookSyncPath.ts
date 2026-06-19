import * as path from 'path';
import { ConnectionUtils } from '../../utils/connectionUtils';
import type { NotebookSyncPayload } from './types';

/** Derive folder segments relative to globalStorage from an on-disk notebook path. */
export function deriveFolderPath(globalStorageRoot: string, filePath: string): string[] | undefined {
  const root = path.resolve(globalStorageRoot);
  const dir = path.resolve(path.dirname(filePath));
  const rel = path.relative(root, dir);
  if (!rel || rel === '.' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(path.sep).filter(Boolean);
}

export interface ConnectionNameLookup {
  id: string;
  name?: string;
}

/**
 * Resolve the directory where a synced notebook should be written.
 * Prefers synced folderPath, then conn/db derivation, then legacy flat folder.
 */
export function resolveNotebookTargetDir(
  payload: NotebookSyncPayload,
  globalStorageRoot: string,
  legacyNotebookFolder: string,
  connections?: ConnectionNameLookup[],
): string {
  if (payload.folderPath && payload.folderPath.length > 0) {
    const segments = payload.folderPath.map((segment) => ConnectionUtils.toSafeSegment(segment));
    return path.join(globalStorageRoot, ...segments);
  }

  if (payload.connectionId && payload.databaseName) {
    const conn = connections?.find((c) => String(c.id) === payload.connectionId);
    const connSegment = ConnectionUtils.toSafeSegment(
      payload.connectionName ?? conn?.name ?? payload.connectionId,
    );
    const dbSegment = ConnectionUtils.toSafeSegment(payload.databaseName);
    return path.join(globalStorageRoot, connSegment, dbSegment);
  }

  return legacyNotebookFolder;
}
