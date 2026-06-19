import * as vscode from 'vscode';
import { withAuthRetry } from './syncAuth';
import { httpRequest } from './providers/httpUtils';
import { DEFAULT_SYNC_API_ENDPOINT } from './constants';
import type { WorkspaceMemberView, WorkspaceRole, WorkspaceView } from './types';

/**
 * Team workspaces (server-ACL sharing — pass 1, no client crypto).
 *
 * A shared workspace is a sync space with a member roster. Items are shared by
 * syncing them into the workspace's space; the server enforces who may read or
 * write. O(1) to add a member, no per-item re-encryption.
 */
export class WorkspaceSharingService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private baseUrl(): string {
    const configured = vscode.workspace.getConfiguration().get<string>('postgresExplorer.sync.apiEndpoint');
    return configured?.trim() || DEFAULT_SYNC_API_ENDPOINT;
  }

  private request<T>(
    url: string,
    options: { method?: string; body?: string },
    mapResponse: (res: import('./providers/httpUtils').HttpResponse) => T,
    errorLabel: string,
  ): Promise<T> {
    return withAuthRetry(
      this.context,
      async (headers) => {
        const h = options.body
          ? { ...headers, 'Content-Type': 'application/json' }
          : headers;
        return httpRequest(url, { method: options.method, headers: h, body: options.body });
      },
      mapResponse,
      errorLabel,
    );
  }

  async listWorkspaces(): Promise<WorkspaceView[]> {
    try {
      return await this.request(
        `${this.baseUrl()}/sync/v2-spaces`,
        {},
        (res) => {
          const data = JSON.parse(res.body.toString()) as {
            spaces: Array<{ space_id: string; name: string; owner_email: string; role: WorkspaceRole }>;
          };
          return (data.spaces ?? []).map((s) => ({
            spaceId: s.space_id,
            name: s.name,
            ownerEmail: s.owner_email,
            role: s.role,
          }));
        },
        'List workspaces',
      );
    } catch {
      return [];
    }
  }

  async createWorkspace(name: string): Promise<WorkspaceView> {
    const data = await this.request(
      `${this.baseUrl()}/sync/v2-spaces`,
      { method: 'POST', body: JSON.stringify({ action: 'create', name }) },
      (res) => JSON.parse(res.body.toString()) as { space_id: string; name: string },
      'Failed to create workspace',
    );
    const { AccountService } = await import('./AccountService');
    const resolvedEmail = (await AccountService.getInstance(this.context).getAccountEmail()) ?? '';
    return { spaceId: data.space_id, name: data.name, ownerEmail: resolvedEmail, role: 'owner' };
  }

  async listMembers(spaceId: string): Promise<WorkspaceMemberView[]> {
    try {
      return await this.request(
        `${this.baseUrl()}/sync/v2-spaces?space=${encodeURIComponent(spaceId)}`,
        {},
        (res) => {
          const data = JSON.parse(res.body.toString()) as {
            members: Array<{ email: string; role: WorkspaceRole; added_at: string }>;
          };
          return (data.members ?? []).map((m) => ({ email: m.email, role: m.role, addedAt: m.added_at }));
        },
        'List members',
      );
    } catch {
      return [];
    }
  }

  async addMember(spaceId: string, email: string, role: 'editor' | 'viewer'): Promise<void> {
    await this.request(
      `${this.baseUrl()}/sync/v2-spaces`,
      { method: 'POST', body: JSON.stringify({ action: 'addMember', space: spaceId, email, role }) },
      () => undefined,
      'Failed to add member',
    );
  }

  async removeMember(spaceId: string, email: string): Promise<void> {
    await this.request(
      `${this.baseUrl()}/sync/v2-spaces`,
      { method: 'POST', body: JSON.stringify({ action: 'removeMember', space: spaceId, email }) },
      () => undefined,
      'Failed to remove member',
    );
  }
}
