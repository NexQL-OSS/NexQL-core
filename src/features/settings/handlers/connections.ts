import * as vscode from 'vscode';
import {
  ConnectionInfo,
  getStoredConnections,
  writeConnectionsToWorkspace,
} from '../../connections/connectionStore';
import { ConnectionUtils } from '../../../utils/connectionUtils';
import { runConnectionTest } from '../../connections/connectionTest';
import { SecretStorageService } from '../../../services/SecretStorageService';
import { ConnectionManager } from '../../../services/ConnectionManager';
import { TelemetryService } from '../../../services/TelemetryService';
import { parseCloudAuth } from '../../../core/connection/cloudAuth';
import { connectionInfoFromDatabaseUrl, previewDatabaseUrl } from '../../../utils/databaseUrl';
import {
  DATABASE_URL_ENV_KEYS,
} from '../../../utils/envFileDatabaseUrls';
import { scanWorkspaceEnvFiles } from '../../../commands/importConnectionFromDatabaseUrl';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';

/** Row shape sent to the webview — never includes passwords. */
interface ConnectionRow {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  group: string;
  environment: string;
  sslmode: string;
  readOnlyMode: boolean;
  sshEnabled: boolean;
  hasPassword: boolean;
}

function refreshTree(): void {
  void vscode.commands.executeCommand('postgres-explorer.refreshConnections');
}

/** Move notebook files when a connection display name changes. */
async function migrateConnectionNotebookFolder(
  context: vscode.ExtensionContext,
  oldName: string,
  newName: string,
): Promise<void> {
  if (!oldName || !newName || oldName === newName) {
    return;
  }
  const oldSeg = ConnectionUtils.toSafeSegment(oldName);
  const newSeg = ConnectionUtils.toSafeSegment(newName);
  if (oldSeg === newSeg) {
    return;
  }

  const oldUri = vscode.Uri.joinPath(context.globalStorageUri, oldSeg);
  const newUri = vscode.Uri.joinPath(context.globalStorageUri, newSeg);
  try {
    await vscode.workspace.fs.stat(oldUri);
  } catch {
    return;
  }
  try {
    await vscode.workspace.fs.stat(newUri);
    return;
  } catch {
    await vscode.workspace.fs.rename(oldUri, newUri, { overwrite: false });
    void vscode.commands.executeCommand('postgres-explorer.notebooks.refresh');
  }
}

export class ConnectionsSectionHandler implements SettingsSectionHandler {
  readonly section = 'connections';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        await this.sendList();
        break;
      case 'get':
        await this.sendConnection(String(message.id));
        break;
      case 'test':
        await this.testForm(message.connection as Record<string, unknown>);
        break;
      case 'testSaved':
        await this.testSaved(String(message.id));
        break;
      case 'save':
        await this.save(
          message.connection as Record<string, unknown>,
          typeof message.editingId === 'string' ? message.editingId : undefined,
        );
        break;
      case 'delete':
        await this.delete(String(message.id));
        break;
      case 'duplicate':
        await this.duplicate(String(message.id));
        break;
      case 'setEnvironment':
        await this.setEnvironment(String(message.id), String(message.environment ?? ''));
        break;
      case 'scanEnv':
        await this.scanEnv();
        break;
      case 'parseEnvUrl':
        await this.parseEnvUrl(String(message.url ?? ''));
        break;
      case 'trackTelemetry':
        if (message.event === 'cloud_auth_selected') {
          const props = message.properties as { authKind?: string } | undefined;
          TelemetryService.getInstance().trackEvent('cloud_auth_selected', {
            authKind: props?.authKind || 'none',
          });
        }
        break;
    }
  }

  private async sendList(): Promise<void> {
    const connections = getStoredConnections();
    const secrets = SecretStorageService.getInstance();
    const rows: ConnectionRow[] = await Promise.all(
      connections.map(async (conn) => ({
        id: conn.id,
        name: conn.name || '',
        host: conn.host || '',
        port: conn.port || 5432,
        database: conn.database || 'postgres',
        username: conn.username || '',
        group: conn.group || '',
        environment: conn.environment || '',
        sslmode: conn.sslmode || 'prefer',
        readOnlyMode: !!conn.readOnlyMode,
        sshEnabled: !!conn.ssh?.enabled,
        hasPassword: !!(await secrets.getPassword(conn.id)),
      })),
    );
    this.host.post({ type: 'connections/list', connections: rows });
  }

  private async sendConnection(id: string): Promise<void> {
    const connection = getStoredConnections().find((c) => c.id === id);
    if (!connection) {
      this.host.post({ type: 'connections/error', error: `Connection not found: ${id}` });
      return;
    }
    const password = await this.host.extensionContext.secrets.get(
      `postgres-password-${id}`,
    );
    this.host.post({
      type: 'connections/connection',
      connection: { ...connection, password: password || '' },
    });
  }

  private async testForm(connection: Record<string, unknown>): Promise<void> {
    try {
      const version = await runConnectionTest(connection as never, false);
      this.host.post({ type: 'connections/testResult', ok: true, version });
    } catch (err: unknown) {
      TelemetryService.getInstance().trackEvent('connection_error', {
        errorCategory: 'settings_hub_test',
      });
      this.host.post({
        type: 'connections/testResult',
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async testSaved(id: string): Promise<void> {
    try {
      const connection = getStoredConnections().find((c) => c.id === id);
      if (!connection) {
        throw new Error('Connection not found');
      }
      const password = await SecretStorageService.getInstance().getPassword(id);
      const version = await runConnectionTest(
        { ...connection, password: password || undefined },
        false,
      );
      this.host.post({ type: 'connections/rowTestResult', id, ok: true, version });
    } catch (err: unknown) {
      this.host.post({
        type: 'connections/rowTestResult',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async save(
    payload: Record<string, unknown>,
    editingId: string | undefined,
  ): Promise<void> {
    try {
      await runConnectionTest(payload as never, true);

      const connections = getStoredConnections();
      const cloudAuthParsed = parseCloudAuth(payload.cloudAuth);
      const newConnection: ConnectionInfo = {
        id: editingId || Date.now().toString(),
        name: String(payload.name ?? ''),
        host: String(payload.host ?? ''),
        port: Number(payload.port) || 5432,
        username: (payload.username as string) || undefined,
        password: (payload.password as string) || undefined,
        database: (payload.database as string) || undefined,
        group: (payload.group as string) || undefined,
        environment: (payload.environment as ConnectionInfo['environment']) || undefined,
        readOnlyMode: (payload.readOnlyMode as boolean) || undefined,
        sslmode: (payload.sslmode as ConnectionInfo['sslmode']) || undefined,
        sslCertPath: (payload.sslCertPath as string) || undefined,
        sslKeyPath: (payload.sslKeyPath as string) || undefined,
        sslRootCertPath: (payload.sslRootCertPath as string) || undefined,
        statementTimeout: (payload.statementTimeout as number) || undefined,
        connectTimeout: (payload.connectTimeout as number) || undefined,
        applicationName: (payload.applicationName as string) || undefined,
        options: (payload.options as string) || undefined,
        ssh: payload.ssh as ConnectionInfo['ssh'],
        ...(cloudAuthParsed.kind !== 'none' ? { cloudAuth: cloudAuthParsed } : {}),
      };

      const index = editingId
        ? connections.findIndex((c) => c.id === editingId)
        : -1;
      const previousName = index !== -1 ? connections[index]?.name : undefined;
      if (index !== -1) {
        connections[index] = newConnection;
      } else {
        connections.push(newConnection);
      }

      await writeConnectionsToWorkspace(this.host.extensionContext, connections);

      if (previousName && previousName !== newConnection.name) {
        await migrateConnectionNotebookFolder(
          this.host.extensionContext,
          previousName,
          newConnection.name,
        );
      }

      // Refresh the pool so the new settings take effect immediately.
      try {
        await ConnectionManager.getInstance().closeAllConnectionsById(newConnection.id);
      } catch (e) {
        console.error('Failed to close stale connections:', e);
      }

      refreshTree();
      this.host.post({ type: 'connections/saved', id: newConnection.id, edited: !!editingId });
      await this.sendList();
      vscode.window.showInformationMessage(
        `Connection ${editingId ? 'updated' : 'saved'} successfully!`,
      );
    } catch (err: unknown) {
      TelemetryService.getInstance().trackEvent('connection_error', {
        errorCategory: 'settings_hub_save',
      });
      this.host.post({
        type: 'connections/saveError',
        error: err instanceof Error ? err.message : 'Unknown error occurred',
      });
    }
  }

  private async delete(id: string): Promise<void> {
    try {
      const remaining = getStoredConnections().filter((c) => c.id !== id);
      await vscode.workspace
        .getConfiguration()
        .update('postgresExplorer.connections', remaining, vscode.ConfigurationTarget.Global);
      try {
        await SecretStorageService.getInstance().deletePassword(id);
      } catch {
        // No stored password for this connection.
      }
      refreshTree();
      this.host.post({ type: 'connections/deleted', id });
      await this.sendList();
    } catch (err: unknown) {
      this.host.post({
        type: 'connections/error',
        error: `Failed to delete connection: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async duplicate(id: string): Promise<void> {
    const source = getStoredConnections().find((c) => c.id === id);
    if (!source) {
      this.host.post({ type: 'connections/error', error: `Connection not found: ${id}` });
      return;
    }
    const password = await SecretStorageService.getInstance().getPassword(id);
    const copy: ConnectionInfo = {
      ...source,
      id: Date.now().toString(),
      name: `${source.name} (copy)`,
      password: password || undefined,
    };
    const connections = [...getStoredConnections(), copy];
    await writeConnectionsToWorkspace(this.host.extensionContext, connections);
    refreshTree();
    await this.sendList();
  }

  private async setEnvironment(id: string, environment: string): Promise<void> {
    const connections = getStoredConnections();
    const target = connections.find((c) => c.id === id);
    if (!target) {
      this.host.post({ type: 'connections/error', error: `Connection not found: ${id}` });
      return;
    }
    if (environment === 'development' || environment === 'staging' || environment === 'production') {
      target.environment = environment;
    } else {
      delete target.environment;
    }
    await vscode.workspace
      .getConfiguration()
      .update('postgresExplorer.connections', connections, vscode.ConfigurationTarget.Global);
    refreshTree();
    await this.sendList();
  }

  private async scanEnv(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      this.host.post({ type: 'connections/envCandidates', candidates: [] });
      return;
    }
    const keySet = new Set<string>(DATABASE_URL_ENV_KEYS);
    const candidates = await scanWorkspaceEnvFiles(folders, (k) => keySet.has(k));
    this.host.post({
      type: 'connections/envCandidates',
      candidates: candidates.map((c) => ({
        relativePath: c.relativePath,
        key: c.key,
        value: c.value,
        preview: previewDatabaseUrl(c.value),
      })),
    });
  }

  private async parseEnvUrl(url: string): Promise<void> {
    try {
      const info = connectionInfoFromDatabaseUrl(url.trim(), `env-${Date.now()}`);
      this.host.post({ type: 'connections/envParsed', connection: info });
    } catch (e: unknown) {
      this.host.post({
        type: 'connections/envParseError',
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}
