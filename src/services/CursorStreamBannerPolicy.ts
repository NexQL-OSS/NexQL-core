import type * as vscode from 'vscode';

const MUTED_FOREVER_KEY = 'nexql.cursorStream.bannerMutedForever.v1';
const DISMISSED_AT_KEY = 'nexql.cursorStream.bannerDismissedAt.v1';
const COUNT_AT_DISMISS_KEY = 'nexql.cursorStream.bannerCountAtDismiss.v1';
const SLIDING_EXEC_COUNT_KEY = 'nexql.cursorStream.slidingExecCount.v1';

/** Snooze banner for 7 days after dismiss. */
const SNOOZE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Or after this many sliding-window query results since dismiss. */
const SNOOZE_EXEC_THRESHOLD = 100;

export class CursorStreamBannerPolicy {
  /**
   * Increment global sliding-result counter for this workspace (call once per sliding response).
   * Returns the new count after increment.
   */
  public static incrementSlidingExecCount(workspaceState: vscode.Memento): number {
    const next = (workspaceState.get<number>(SLIDING_EXEC_COUNT_KEY) ?? 0) + 1;
    void workspaceState.update(SLIDING_EXEC_COUNT_KEY, next);
    return next;
  }

  /**
   * Whether to show the streaming cursor hint banner for this result (after increment).
   */
  public static shouldShowBanner(
    globalState: vscode.Memento,
    workspaceState: vscode.Memento,
    currentSlidingExecCount: number,
  ): boolean {
    if (globalState.get<boolean>(MUTED_FOREVER_KEY, false)) {
      return false;
    }
    const dismissedAt = workspaceState.get<number>(DISMISSED_AT_KEY);
    if (!dismissedAt) {
      return true;
    }
    const countAtDismiss = workspaceState.get<number>(COUNT_AT_DISMISS_KEY) ?? 0;
    if (Date.now() - dismissedAt >= SNOOZE_WEEK_MS) {
      return true;
    }
    if (currentSlidingExecCount - countAtDismiss >= SNOOZE_EXEC_THRESHOLD) {
      return true;
    }
    return false;
  }

  /** User closed the banner with X — snooze until week or 100 sliding queries. */
  public static async recordDismiss(workspaceState: vscode.Memento): Promise<void> {
    const count = workspaceState.get<number>(SLIDING_EXEC_COUNT_KEY) ?? 0;
    await workspaceState.update(DISMISSED_AT_KEY, Date.now());
    await workspaceState.update(COUNT_AT_DISMISS_KEY, count);
  }

  /** User chose mute forever. */
  public static async recordMuteForever(globalState: vscode.Memento): Promise<void> {
    await globalState.update(MUTED_FOREVER_KEY, true);
  }
}
