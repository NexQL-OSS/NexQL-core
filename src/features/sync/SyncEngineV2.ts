/**
 * Pure merge helpers for the git-like sync engine. No VS Code or IO deps so the
 * decision logic is unit-testable in isolation.
 *
 * The engine never does a three-way merge. The server is the source of truth;
 * the client only ever decides, per item, whether a *local* edit or the
 * *remote* version wins — by last-writer-wins on edit time. The loser is always
 * preserved as a local backup by the caller, so nothing is silently dropped.
 */

export type Side = 'local' | 'remote';

/** Last-writer-wins: newer edit time wins; ties go to remote (server authority). */
export function pickWinner(localUpdatedAt: number, remoteUpdatedAt: number): Side {
  return localUpdatedAt > remoteUpdatedAt ? 'local' : 'remote';
}

export interface IncomingDecision {
  /** Apply the remote blob locally. */
  applyRemote: boolean;
  /** Back up the current local copy before applying (it had unsynced edits). */
  backupLocal: boolean;
}

/** Whether a remote tombstone should preserve dirty local content as a backup. */
export function shouldBackupBeforeDelete(hasLocal: boolean, localDirty: boolean): boolean {
  return hasLocal && localDirty;
}

/**
 * Decide what to do with one incoming remote upsert.
 *
 * @param hasLocal      a local item with this id exists
 * @param localDirty    the local item has edits not yet pushed
 * @param sameContent   local and remote content hashes match
 * @param localUpdatedAt local edit time (epoch ms)
 * @param remoteUpdatedAt remote write time (epoch ms)
 */
export function decideIncoming(
  hasLocal: boolean,
  localDirty: boolean,
  sameContent: boolean,
  localUpdatedAt: number,
  remoteUpdatedAt: number,
): IncomingDecision {
  if (!hasLocal) {
    return { applyRemote: true, backupLocal: false };
  }
  if (sameContent) {
    // Already converged — just adopt the server version, no write needed.
    return { applyRemote: false, backupLocal: false };
  }
  if (!localDirty) {
    // Fast-forward: local is unchanged since last sync, take remote.
    return { applyRemote: true, backupLocal: false };
  }
  // Genuine conflict — both sides changed. LWW, preserve the loser locally.
  return pickWinner(localUpdatedAt, remoteUpdatedAt) === 'remote'
    ? { applyRemote: true, backupLocal: true }
    : { applyRemote: false, backupLocal: false };
}
