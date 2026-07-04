/**
 * Registers NexQL's in-process MCP server with VS Code's MCP registry
 * (`vscode.lm.registerMcpServerDefinitionProvider`). `provideMcpServerDefinitions` must
 * not require user interaction (per the API contract) so it returns a placeholder
 * definition; the actual server only starts — and the real port/token are only
 * generated — in `resolveMcpServerDefinition`, which VS Code calls lazily when a
 * client actually wants to connect.
 */
import * as vscode from 'vscode';
import { NexqlMcpServer } from './NexqlMcpServer';

const PLACEHOLDER_URI = vscode.Uri.parse('http://127.0.0.1:0/mcp');

export class McpDefinitionProvider implements vscode.McpServerDefinitionProvider<vscode.McpHttpServerDefinition> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeMcpServerDefinitions = this._onDidChange.event;

  constructor(
    private readonly server: NexqlMcpServer,
    private readonly isEnabled: () => boolean
  ) {}

  provideMcpServerDefinitions(): vscode.McpHttpServerDefinition[] {
    if (!this.isEnabled()) {
      return [];
    }
    return [new vscode.McpHttpServerDefinition('NexQL', PLACEHOLDER_URI)];
  }

  async resolveMcpServerDefinition(
    definition: vscode.McpHttpServerDefinition
  ): Promise<vscode.McpHttpServerDefinition> {
    const info = await this.server.start();
    definition.uri = vscode.Uri.parse(`http://127.0.0.1:${info.port}/mcp`);
    definition.headers = { Authorization: `Bearer ${info.token}` };
    return definition;
  }

  /** Call after the enable/disable setting changes so VS Code re-queries availability. */
  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
