/**
 * Chat surface types shared beyond the chat module (assistant gateway,
 * dashboards, notebooks). Owned by core so features can reference them
 * without importing the chat implementation.
 */

export interface FileAttachment {
  name: string;
  content: string;
  type: string;
  path?: string;
  // For image attachments: base64 data URL
  dataUrl?: string;
  mimeType?: string;
}

export type DbObjectType = 'table' | 'view' | 'function' | 'procedure' | 'materialized-view' | 'type' | 'schema' | 'database' | 'connection' | 'column' | 'index' | 'constraint' | 'partition' | 'sequence' | 'domain' | 'trigger' | 'aggregate' | 'foreign-table' | 'foreign-data-wrapper' | 'foreign-server' | 'notebook' | 'saved-query';

export interface DbObject {
  name: string;
  type: DbObjectType;
  schema: string;
  database: string;
  connectionId: string;
  connectionName: string;
  breadcrumb: string;
  details?: string;
  isContainer?: boolean;
}
