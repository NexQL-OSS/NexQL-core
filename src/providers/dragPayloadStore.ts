/**
 * Shared stash for the most recent tree drag payload.
 *
 * VS Code only fills the tree's own mime type on the webview side, and on some
 * platforms even that arrives empty on drop. `DatabaseDragAndDropController.handleDrag`
 * stores the serialized items here so `ChatViewProvider` can recover them when the
 * webview's `getData()` came back empty.
 */
const TTL_MS = 60_000;

let payload: any[] | null = null;
let stashedAt = 0;

export function setLastTreeDragPayload(items: any[]): void {
  payload = items;
  stashedAt = Date.now();
}

export function getLastTreeDragPayload(): any[] | null {
  if (!payload || Date.now() - stashedAt > TTL_MS) {
    return null;
  }
  return payload;
}
