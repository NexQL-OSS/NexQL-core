import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { SYNC_ACTIVITY_LOG_KEY } from './constants';
import type { SyncActivity, SyncActivityAction, SyncActivityInput, SyncActivityView, SyncKind } from './types';

const MAX_PENDING = 200;

function activityKey(kind: SyncKind, itemId: string): string {
  return `${kind}:${itemId}`;
}

/**
 * Local outbound sync queue — records creates/updates/renames/deletes until
 * a successful sync acknowledges them.
 */
export class SyncActivityLog {
  private static instance: SyncActivityLog | undefined;

  static getInstance(context: vscode.ExtensionContext): SyncActivityLog {
    if (!SyncActivityLog.instance) {
      SyncActivityLog.instance = new SyncActivityLog(context);
    }
    return SyncActivityLog.instance;
  }

  static resetInstanceForTests(): void {
    SyncActivityLog.instance = undefined;
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  record(input: SyncActivityInput): void {
    const pending = this.load();
    const key = activityKey(input.kind, input.itemId);
    const idx = pending.findIndex((p) => activityKey(p.kind, p.itemId) === key);
    const now = Date.now();

    if (input.action === 'delete') {
      if (idx >= 0 && pending[idx].action === 'create') {
        pending.splice(idx, 1);
      } else if (idx >= 0) {
        pending[idx] = {
          ...pending[idx],
          action: 'delete',
          name: input.name ?? pending[idx].name,
          previousName: undefined,
          queuedAt: now,
        };
      } else {
        pending.push(this.newEntry(input, now));
      }
    } else if (input.action === 'rename') {
      if (idx >= 0) {
        const prev = pending[idx];
        pending[idx] = {
          ...prev,
          action: prev.action === 'create' ? 'create' : 'rename',
          name: input.name ?? prev.name,
          previousName: input.previousName ?? prev.previousName,
          queuedAt: now,
        };
      } else {
        pending.push(this.newEntry(input, now));
      }
    } else if (input.action === 'create') {
      if (idx >= 0) {
        pending[idx] = {
          ...pending[idx],
          action: 'create',
          name: input.name ?? pending[idx].name,
          previousName: undefined,
          queuedAt: now,
        };
      } else {
        pending.push(this.newEntry(input, now));
      }
    } else {
      if (idx >= 0) {
        const prev = pending[idx];
        pending[idx] = {
          ...prev,
          action: prev.action === 'create' ? 'create' : 'update',
          name: input.name ?? prev.name,
          queuedAt: now,
        };
      } else {
        pending.push(this.newEntry(input, now));
      }
    }

    this.save(pending.slice(-MAX_PENDING));
  }

  /** Remove pending entries successfully synced this run. */
  acknowledge(keys: Iterable<string>): void {
    const synced = new Set(keys);
    const pending = this.load().filter((p) => !synced.has(activityKey(p.kind, p.itemId)));
    this.save(pending);
  }

  listPending(): SyncActivityView[] {
    return this.load()
      .slice()
      .sort((a, b) => b.queuedAt - a.queuedAt)
      .map((p) => ({
        id: p.id,
        itemId: p.itemId,
        kind: p.kind,
        action: p.action,
        name: p.name,
        previousName: p.previousName,
        queuedAt: p.queuedAt,
      }));
  }

  clearAll(): void {
    this.save([]);
  }

  private newEntry(input: SyncActivityInput, queuedAt: number): SyncActivity {
    return {
      id: crypto.randomUUID(),
      itemId: input.itemId,
      kind: input.kind,
      action: input.action,
      name: input.name,
      previousName: input.previousName,
      queuedAt,
    };
  }

  private load(): SyncActivity[] {
    return this.context.globalState.get<SyncActivity[]>(SYNC_ACTIVITY_LOG_KEY, []);
  }

  private async save(entries: SyncActivity[]): Promise<void> {
    await this.context.globalState.update(SYNC_ACTIVITY_LOG_KEY, entries);
  }
}

let boundContext: vscode.ExtensionContext | undefined;

export function bindSyncActivityLog(context: vscode.ExtensionContext): void {
  boundContext = context;
}

/** Record a pending outbound sync activity (no-op if sync is not initialized). */
export function recordSyncActivity(input: SyncActivityInput): void {
  if (!boundContext) {
    return;
  }
  SyncActivityLog.getInstance(boundContext).record(input);
}
