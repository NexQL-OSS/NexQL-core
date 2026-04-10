/**
 * Session storage service for chat history
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ChatSession, ChatSessionSummary, ChatMessage } from './types';

export class SessionService {
    private _context: vscode.ExtensionContext;
    private _currentSessionId: string | null = null;

    constructor(context: vscode.ExtensionContext) {
        this._context = context;
    }

    getChatSessions(): ChatSession[] {
        return this._context.globalState.get<ChatSession[]>('chatSessions', []);
    }

    async saveChatSessions(sessions: ChatSession[]): Promise<void> {
        await this._context.globalState.update('chatSessions', sessions);
    }

    generateSessionId(): string {
        // Use 9 random bytes as before: base64url-encoding to avoid special chars (or hex for simplicity)
        const randomPart = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').substr(0, 12);
        return `session_${Date.now()}_${randomPart}`;
    }

    getCurrentSessionId(): string | null {
        return this._currentSessionId;
    }

    setCurrentSessionId(id: string | null): void {
        this._currentSessionId = id;
    }

    async saveSession(messages: ChatMessage[], generateTitle: (msg: string) => Promise<string>, metadata?: { connectionName?: string; database?: string }): Promise<void> {
        if (messages.length === 0) return;

        const sessions = this.getChatSessions();
        const now = Date.now();

        if (this._currentSessionId) {
            const index = sessions.findIndex(s => s.id === this._currentSessionId);
            if (index !== -1) {
                sessions[index].messages = [...messages];
                sessions[index].updatedAt = now;
                
                // Phase C: Update metadata if provided
                if (metadata?.connectionName) {
                    sessions[index].connectionName = metadata.connectionName;
                }
                if (metadata?.database) {
                    sessions[index].database = metadata.database;
                }
                
                // Phase C: Extract preview from first AI response if not already set
                if (!sessions[index].preview) {
                    const firstAiMessage = messages.find(m => m.role === 'assistant');
                    if (firstAiMessage) {
                        // Strip markdown fence markers and take first 100 chars
                        const cleanContent = firstAiMessage.content
                            .replace(/^```[\s\S]*?```/gm, '') // Remove code blocks
                            .replace(/\*\*/g, '')               // Remove bold markers
                            .replace(/\*/g, '')                 // Remove italic markers
                            .trim();
                        sessions[index].preview = cleanContent.substring(0, 100);
                    }
                }
            }
        } else {
            this._currentSessionId = this.generateSessionId();
            const firstUserMessage = messages.find(m => m.role === 'user')?.content || 'New Chat';
            const title = await generateTitle(firstUserMessage);
            
            // Phase C: Extract preview from first AI response
            let preview: string | undefined;
            const firstAiMessage = messages.find(m => m.role === 'assistant');
            if (firstAiMessage) {
                const cleanContent = firstAiMessage.content
                    .replace(/^```[\s\S]*?```/gm, '')
                    .replace(/\*\*/g, '')
                    .replace(/\*/g, '')
                    .trim();
                preview = cleanContent.substring(0, 100);
            }
            
            sessions.unshift({
                id: this._currentSessionId,
                title,
                messages: [...messages],
                createdAt: now,
                updatedAt: now,
                // Phase C: Store metadata
                preview,
                connectionName: metadata?.connectionName,
                database: metadata?.database
            });
        }

        // Keep only last 50 sessions
        const trimmedSessions = sessions.slice(0, 50);
        await this.saveChatSessions(trimmedSessions);
    }

    loadSession(sessionId: string): ChatMessage[] | null {
        const sessions = this.getChatSessions();
        const session = sessions.find(s => s.id === sessionId);
        
        if (session) {
            this._currentSessionId = session.id;
            return [...session.messages];
        }
        return null;
    }

    async deleteSession(sessionId: string): Promise<boolean> {
        const sessions = this.getChatSessions();
        const filtered = sessions.filter(s => s.id !== sessionId);
        await this.saveChatSessions(filtered);
        
        const wasCurrentSession = this._currentSessionId === sessionId;
        if (wasCurrentSession) {
            this._currentSessionId = null;
        }
        
        return wasCurrentSession;
    }

    getSessionSummaries(): ChatSessionSummary[] {
        const sessions = this.getChatSessions();
        return sessions.map(s => ({
            id: s.id,
            title: s.title,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length,
            isActive: s.id === this._currentSessionId,
            // Phase C: Include metadata in summaries
            preview: s.preview,
            connectionName: s.connectionName,
            database: s.database
        }));
    }

    clearCurrentSession(): void {
        this._currentSessionId = null;
    }
}
