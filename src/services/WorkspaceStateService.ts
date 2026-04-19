import * as vscode from 'vscode';

/** Workspace-scoped defaults for PgStudio (per VS Code workspace folder). */
export interface PgStudioWorkspaceDefaults {
  lastConnectionId?: string;
  lastDatabaseName?: string;
}

const WORKSPACE_DEFAULTS_KEY = 'pgstudio.workspaceDefaults.v1';

/**
 * Centralizes reads/writes to {@link vscode.ExtensionContext.workspaceState} for PgStudio.
 * Used for last-used connection/database when switching from the status bar and for workspace-level UI.
 */
export class WorkspaceStateService implements vscode.Disposable {
  private static instance: WorkspaceStateService;
  private context: vscode.ExtensionContext | null = null;

  private constructor() {}

  static getInstance(): WorkspaceStateService {
    if (!WorkspaceStateService.instance) {
      WorkspaceStateService.instance = new WorkspaceStateService();
    }
    return WorkspaceStateService.instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  getDefaults(): PgStudioWorkspaceDefaults {
    if (!this.context) {
      return {};
    }
    return this.context.workspaceState.get<PgStudioWorkspaceDefaults>(WORKSPACE_DEFAULTS_KEY, {}) ?? {};
  }

  async setDefaults(partial: Partial<PgStudioWorkspaceDefaults>): Promise<void> {
    if (!this.context) {
      return;
    }
    const next: PgStudioWorkspaceDefaults = { ...this.getDefaults(), ...partial };
    await this.context.workspaceState.update(WORKSPACE_DEFAULTS_KEY, next);
  }

  /** Record after user switches connection (and optional database) from a notebook. */
  async recordConnectionSwitch(connectionId: string, databaseName?: string): Promise<void> {
    await this.setDefaults({
      lastConnectionId: connectionId,
      ...(databaseName !== undefined ? { lastDatabaseName: databaseName } : {}),
    });
  }

  /** Record after user switches database for the current connection. */
  async recordDatabaseSwitch(connectionId: string, databaseName: string): Promise<void> {
    await this.setDefaults({
      lastConnectionId: connectionId,
      lastDatabaseName: databaseName,
    });
  }

  dispose(): void {
    this.context = null;
  }
}
