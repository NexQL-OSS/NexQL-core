/**
 * Capability + context types for the layered AI system-prompt builder.
 *
 * Each AI touchpoint (chat, quick-actions, notebook assist, backup tools) maps to
 * one capability. The builder gates expensive boilerplate (SQL formatting rules,
 * UI-affordance blocks) on capability so conceptual questions don't pay the full
 * SQL-authoring token tax.
 */
export type AiCapability =
  | 'chat'
  | 'fixQuery'
  | 'optimizeQuery'
  | 'explainError'
  | 'analyzeData'
  | 'generateQuery'
  | 'notebookAssist'
  | 'backupTools';

/** Connection context that drives the production / read-only safety header. */
export interface PromptConnectionContext {
  environment?: 'production' | 'staging' | 'development';
  readOnlyMode?: boolean;
  connectionName?: string;
}
