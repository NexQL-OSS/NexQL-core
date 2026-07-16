import * as vscode from 'vscode';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';
import type { IMcpServer } from '../../../pro/api';
import { getChatViewProvider } from '../../../services/chatViewRegistry';

const DDL_ENABLED_KEY = 'nexql.ddlViewer.enabled';
const DDL_OPEN_ON_SELECTION_KEY = 'nexql.ddlViewer.openOnSelection';
const HISTORY_MAX_ITEMS_KEY = 'postgresExplorer.queryHistory.maxItems';

/**
 * Retrieves the MCP server instance from the coreApi if pro is loaded.
 * Returns undefined when running as a free build.
 */
function getMcpServerFromApi(): IMcpServer | undefined {
  // coreApi.getMcpServer is injected by activatePro; access via a global accessor
  // stored on extension module. Cast to any to avoid importing extension.ts.
  try {
    const extModule = require('../../../extension') as any;
    return extModule._coreApi?.getMcpServer?.();
  } catch {
    return undefined;
  }
}

export class PreferencesSectionHandler implements SettingsSectionHandler {
  readonly section = 'prefs';

  constructor(private readonly host: SettingsHubHostContext) {}

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    switch (action) {
      case 'load':
        await this.sendState();
        break;
      case 'update':
        await this.update(String(message.key), message.value as boolean | number);
        break;
    }
  }

  private async sendState(): Promise<void> {
    const config = vscode.workspace.getConfiguration();
    const mcpEnabled = config.get<boolean>('postgresExplorer.mcp.enabled', false);
    const mcpConfiguredPort = config.get<number>('postgresExplorer.mcp.port', 0);

    let port = 0;
    let token = '';
    let mcpStarted = false;

    const server = getMcpServerFromApi();
    if (server) {
      if (mcpEnabled) {
        try {
          const info = await server.start();
          port = info.port;
          token = info.token;
          mcpStarted = true;
        } catch {
          // ignore start error here
        }
      } else {
        const info = server.info;
        if (info) {
          port = info.port;
          token = info.token;
          mcpStarted = true;
        }
      }
    }

    this.host.post({
      type: 'prefs/state',
      prefs: {
        ddlEnabled: config.get<boolean>(DDL_ENABLED_KEY, true),
        ddlOpenOnSelection: config.get<boolean>(DDL_OPEN_ON_SELECTION_KEY, true),
        historyMaxItems: config.get<number>(HISTORY_MAX_ITEMS_KEY, 200),
        mcpEnabled,
        mcpPort: port,
        mcpConfiguredPort,
        mcpToken: token,
        mcpStarted,
      },
    });
  }

  private async update(key: string, value: boolean | number): Promise<void> {
    try {
      if (key === 'ddlEnabled') {
        // Route through the DDL viewer command so open preview tabs are
        // cleaned up and code lenses refresh, same as the in-editor toggle.
        await vscode.commands.executeCommand('postgres-explorer.ddlViewer.toggleEnabled', value);
      } else if (key === 'ddlOpenOnSelection') {
        await vscode.workspace
          .getConfiguration()
          .update(DDL_OPEN_ON_SELECTION_KEY, value, vscode.ConfigurationTarget.Global);
      } else if (key === 'historyMaxItems') {
        const n = Math.max(10, Math.min(1000, Number(value)));
        await vscode.workspace
          .getConfiguration()
          .update(HISTORY_MAX_ITEMS_KEY, n, vscode.ConfigurationTarget.Global);
      } else if (key === 'mcpEnabled') {
        await vscode.workspace
          .getConfiguration()
          .update('postgresExplorer.mcp.enabled', value, vscode.ConfigurationTarget.Global);
      } else if (key === 'mcpPort') {
        const n = Math.max(0, Math.min(65535, Math.trunc(Number(value)) || 0));
        await vscode.workspace
          .getConfiguration()
          .update('postgresExplorer.mcp.port', n, vscode.ConfigurationTarget.Global);
        // Server already binds the old port; restart so the new one takes effect now
        // instead of requiring a full window reload.
        const server = getMcpServerFromApi();
        if (server?.info) {
          try {
            await server.restart();
          } catch (err) {
            this.host.post({
              type: 'prefs/error',
              error: `Failed to bind port ${n}: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      } else {
        this.host.post({ type: 'prefs/error', error: `Unknown preference: ${key}` });
        return;
      }
      await this.sendState();
    } catch (err: unknown) {
      this.host.post({
        type: 'prefs/error',
        error: err instanceof Error ? err.message : String(err),
      });
      await this.sendState();
    }
  }
}
