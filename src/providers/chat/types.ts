/**
 * Type definitions for the Chat View
 */

export interface ToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  attachments?: FileAttachment[];
  mentions?: DbMention[];
  usage?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  ragContext?: {
    objects: Array<{ ref: string; score: number; detail: 'full' | 'columns' | 'skeleton' }>;
    joinHints: string[];
    tokensUsed: number;
  };
  agenticSteps?: Array<{
    toolCall: ToolCall;
    result: string;
  }>;
  /** Live + persisted trace of pre-response work (RAG, agentic turns). Rendered above assistant reply. */
  thinkingTrace?: ThinkingStep[];
  /** UI-only: index into the raw (unfiltered) message array — lets "resend" target the right turn once tool-call messages are filtered out of the displayed list. */
  _rawIdx?: number;
}

export interface ThinkingStep {
  id: string;
  label: string;
  status: 'active' | 'done' | 'error';
  ragContext?: ChatMessage['ragContext'];
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
