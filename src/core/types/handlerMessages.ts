/**
 * Discriminated union for webview ↔ extension notebook messages (extend as handlers grow).
 * Prefer narrowing on `type` at call sites.
 */
export type HandlerMessageType =
  | 'breadcrumbNavigate'
  | 'saveColumnWidths'
  | 'getColumnWidths'
  | 'exportRequest'
  | 'retryCell'
  | 'explainError'
  | 'fixQuery';

export interface HandlerMessageBase {
  type: string;
}
