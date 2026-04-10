/**
 * Type definitions for the Chat View
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: FileAttachment[];
  mentions?: DbMention[];
  usage?: string;
}

export interface FileAttachment {
  name: string;
  content: string;
  type: string;
  path?: string;
  // For image attachments: base64 data URL
  dataUrl?: string;
  mimeType?: string;
}

export interface DbMention {
  name: string;
  type: DbObjectType;
  schema: string;
  database: string;
  connectionId: string;
  breadcrumb: string;
  schemaInfo?: string;
}

export type DbObjectType = 'table' | 'view' | 'function' | 'materialized-view' | 'type' | 'schema' | 'database' | 'connection';

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

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  // Phase C: Optional metadata for enhanced history UI
  preview?: string;          // First 100 chars of first AI response
  connectionName?: string;   // Name of the connection this session used
  database?: string;         // Name of the database this session used
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  isActive: boolean;
  // Phase C: Optional metadata for history display
  preview?: string;
  connectionName?: string;
  database?: string;
}
