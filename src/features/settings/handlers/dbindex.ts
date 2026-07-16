import * as vscode from 'vscode';
import type { SettingsHubHostContext, SettingsHubMessage, SettingsSectionHandler } from '../types';
import { IndexStore } from '../../dbindex/IndexStore';
import { getDbIndexesState, handleRebuildIndex, handleClearIndex, handleExportIndex } from '../../dbindex/panel/indexActions';
import { getStoredConnections } from '../../connections/connectionStore';
import { ConnectionManager } from '../../../services/ConnectionManager';
import { listNonSystemSchemas } from '../../dbindex/catalogQueries';
import { IndexBuilder } from '../../dbindex/IndexBuilder';
import { IndexScope } from '../../dbindex/types';

export class DbIndexSectionHandler implements SettingsSectionHandler {
  readonly section = 'dbindex';
  private readonly store: IndexStore;
  private activeBuildCts: vscode.CancellationTokenSource | undefined;

  constructor(private readonly host: SettingsHubHostContext) {
    this.store = new IndexStore(this.host.extensionContext.globalStorageUri);
  }

  async handle(action: string, message: SettingsHubMessage): Promise<void> {
    try {
      switch (action) {
        case 'load':
          await this.sendState();
          break;
        case 'build':
          await vscode.commands.executeCommand('postgres-explorer.dbindex.build');
          await this.sendState();
          break;
        case 'rebuild': {
          const connectionId = String(message.connectionId || '');
          const database = String(message.database || '');
          await handleRebuildIndex(this.store, connectionId, database, () => this.sendState());
          break;
        }
        case 'clear': {
          const connectionId = String(message.connectionId || '');
          const database = String(message.database || '');
          await handleClearIndex(this.store, connectionId, database, () => this.sendState());
          break;
        }
        case 'export': {
          const connectionId = String(message.connectionId || '');
          const database = String(message.database || '');
          await handleExportIndex(this.store, connectionId, database);
          break;
        }
        case 'curate':
          await vscode.commands.executeCommand('postgres-explorer.dbindex.openPanel');
          break;
        case 'setEmbeddings':
          await vscode.workspace.getConfiguration().update(
            'postgresExplorer.dbIndex.enableEmbeddings',
            !!message.enableEmbeddings,
            vscode.ConfigurationTarget.Global
          );
          await this.sendState();
          break;
        case 'listConnections': {
          const connections = getStoredConnections().map(c => ({
            id: c.id,
            name: c.name || 'Unnamed',
            environment: c.environment || '',
          }));
          this.host.post({
            type: 'dbindex/connections',
            connections,
          });
          break;
        }
        case 'listDatabases': {
          const connectionId = String(message.connectionId || '');
          const connection = getStoredConnections().find(c => c.id === connectionId);
          if (!connection) {
            throw new Error('Connection not found');
          }
          let client: any;
          let databases: string[] = [];
          try {
            client = await ConnectionManager.getInstance().getPooledClient(connection as any);
            const res = await client.query(`
              SELECT datname 
              FROM pg_database 
              WHERE datistemplate = false AND datallowconn = true
              ORDER BY datname
            `);
            databases = res.rows.map((r: any) => r.datname);
          } finally {
            if (client) {
              try { client.release(); } catch {}
            }
          }
          this.host.post({
            type: 'dbindex/databases',
            databases,
          });
          break;
        }
        case 'listSchemas': {
          const connectionId = String(message.connectionId || '');
          const database = String(message.database || '');
          const connection = getStoredConnections().find(c => c.id === connectionId);
          if (!connection) {
            throw new Error('Connection not found');
          }
          let client: any;
          let schemas: string[] = [];
          try {
            client = await ConnectionManager.getInstance().getPooledClient({
              ...connection,
              database,
            } as any);
            schemas = await listNonSystemSchemas(client);
          } finally {
            if (client) {
              try { client.release(); } catch {}
            }
          }
          this.host.post({
            type: 'dbindex/schemas',
            schemas,
          });
          break;
        }
        case 'startBuild': {
          const connectionId = String(message.connectionId || '');
          const database = String(message.database || '');
          const schemas = (message.schemas as string[]) || [];
          const depth = String(message.depth || 'structure') as any;
          const piiExcludedColumns = (message.piiExcludedColumns as string[]) || [];

          const connection = getStoredConnections().find(c => c.id === connectionId);
          if (!connection) {
            throw new Error('Connection not found');
          }

          if (this.activeBuildCts) {
            this.activeBuildCts.cancel();
            this.activeBuildCts.dispose();
          }

          this.activeBuildCts = new vscode.CancellationTokenSource();
          const token = this.activeBuildCts.token;

          const builder = new IndexBuilder(this.store);
          const scope: IndexScope = {
            includedSchemas: schemas,
            excludedObjects: [],
            piiExcludedColumns,
          };

          // Run async and post progress
          builder.build(
            connectionId,
            database,
            scope,
            depth,
            'guided',
            connection.environment || 'development',
            token,
            {
              report: (value) => {
                this.host.post({
                  type: 'dbindex/buildProgress',
                  percent: undefined,
                  text: value.message || '',
                });
              }
            }
          ).then((manifest) => {
            if (token.isCancellationRequested) {
              return;
            }
            this.host.post({
              type: 'dbindex/buildComplete',
              text: `Index successfully built for "${database}"! (Count: ${manifest.counts.tables} tables, ${manifest.counts.views} views)`,
            });
          }).catch((err) => {
            if (token.isCancellationRequested) {
              this.host.post({
                type: 'dbindex/buildError',
                error: 'Database indexing was cancelled.',
              });
              return;
            }
            this.host.post({
              type: 'dbindex/buildError',
              error: err.message || String(err),
            });
          }).finally(() => {
            if (this.activeBuildCts) {
              this.activeBuildCts.dispose();
              this.activeBuildCts = undefined;
            }
          });
          break;
        }
        case 'cancelBuild': {
          if (this.activeBuildCts) {
            this.activeBuildCts.cancel();
            this.activeBuildCts.dispose();
            this.activeBuildCts = undefined;
          }
          break;
        }
        default:
          this.host.post({ type: 'dbindex/error', error: `Unknown action: ${action}` });
      }
    } catch (err: any) {
      this.host.post({
        type: 'dbindex/error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async sendState(): Promise<void> {
    const state = await getDbIndexesState(this.store);
    this.host.post({
      type: 'dbindex/state',
      state,
    });
  }
}
