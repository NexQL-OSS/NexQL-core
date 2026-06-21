import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { QueryHistoryService } from '../services/QueryHistoryService';
import { ChatViewProvider } from '../providers/ChatViewProvider';

import { cmdAiAssist } from '../commands/aiAssist';
import { showColumnProperties, copyColumnName, copyColumnNameQuoted, generateSelectStatement, generateWhereClause, generateAlterColumnScript, generateDropColumnScript, generateRenameColumnScript, addColumnComment, generateIndexOnColumn, viewColumnStatistics, cmdAddColumn } from '../commands/columns';
import { showConstraintProperties, copyConstraintName, generateDropConstraintScript, generateAlterConstraintScript, validateConstraint, generateAddConstraintScript, viewConstraintDependencies, cmdConstraintOperations, cmdAddConstraint } from '../commands/constraints';
import { cmdConnectDatabase, cmdDisconnectConnection, cmdDisconnectDatabase, cmdReconnectConnection, cmdDuplicateConnection, showConnectionSafety, revealInExplorer } from '../commands/connection';
import { cmdImportConnectionFromDatabaseUrl } from '../commands/importConnectionFromDatabaseUrl';
import { cmdSmartPasteConnection } from '../commands/smartPasteConnection';
import { showIndexProperties, copyIndexName, generateDropIndexScript, generateReindexScript, generateScriptCreate, analyzeIndexUsage, generateAlterIndexScript, addIndexComment, cmdIndexOperations, cmdAddIndex } from '../commands/indexes';
import { cmdAddObjectInDatabase, cmdBackupDatabase, cmdCreateDatabase, cmdDatabaseDashboard, cmdDatabaseDashboardFromPalette, cmdDatabaseOperations, cmdDeleteDatabase, cmdDisconnectDatabase as cmdDisconnectDatabaseLegacy, cmdGenerateCreateScript, cmdMaintenanceDatabase, cmdOpenBackupWorkspaceFromPalette, cmdPsqlTool, cmdQueryTool, cmdRestoreDatabase, cmdScriptAlterDatabase, cmdShowConfiguration } from '../commands/database';
import { cmdDropExtension, cmdEnableExtension, cmdExtensionOperations, cmdRefreshExtension } from '../commands/extensions';
import { cmdCreateForeignTable, cmdDropForeignTable, cmdEditForeignTable, cmdForeignTableOperations, cmdRefreshForeignTable, cmdShowForeignTableProperties, cmdViewForeignTableData } from '../commands/foreignTables';
import { cmdForeignDataWrapperOperations, cmdShowForeignDataWrapperProperties, cmdCreateForeignServer, cmdForeignServerOperations, cmdShowForeignServerProperties, cmdDropForeignServer, cmdCreateUserMapping, cmdUserMappingOperations, cmdShowUserMappingProperties, cmdDropUserMapping, cmdRefreshForeignDataWrapper, cmdRefreshForeignServer, cmdRefreshUserMapping } from '../commands/foreignDataWrappers';
import { cmdCallFunction, cmdCreateFunction, cmdDropFunction, cmdEditFunction, cmdFunctionOperations, cmdRefreshFunction, cmdShowFunctionProperties } from '../commands/functions';
import { cmdCallProcedure, cmdCreateProcedure, cmdDropProcedure, cmdEditProcedure, cmdProcedureOperations, cmdRefreshProcedure, cmdShowProcedureProperties } from '../commands/procedures';
import { cmdCreateMaterializedView, cmdDropMatView, cmdEditMatView, cmdMatViewOperations, cmdRefreshMatView, cmdViewMatViewData, cmdViewMatViewProperties } from '../commands/materializedViews';
import { cmdNewNotebook, cmdExplainQuery, cmdJumpToSection } from '../commands/notebook';
import { toggleFullDatasetForCell, toggleFullDatasetFromCell } from '../commands/fullDataset';
import { cmdExportNotebook } from '../commands/notebookExport';
import { cmdCreateObjectInSchema, cmdCreateSchema, cmdSchemaOperations, cmdShowSchemaProperties, cmdPasteTable } from '../commands/schema';
import {
  cmdCreateTable, cmdDropTable, cmdEditTable, cmdInsertTable, cmdMaintenanceAnalyze, cmdMaintenanceReindex, cmdMaintenanceVacuum, cmdScriptCreate, cmdScriptDelete, cmdScriptInsert, cmdScriptSelect, cmdScriptUpdate, cmdShowTableProperties, cmdTableOperations, cmdTruncateTable, cmdUpdateTable, cmdViewTableData, cmdTableProfile, cmdTableActivity, cmdQuickCloneTable, cmdExportTable, cmdIndexUsage, cmdTableDefinition
} from '../commands/tables';
import { cmdAllOperationsTypes, cmdCreateType, cmdDropType, cmdEditTypes, cmdRefreshType, cmdShowTypeProperties } from '../commands/types';
import { cmdAddRole, cmdAddUser, cmdDropRole, cmdEditRole, cmdGrantRevokeRole, cmdRefreshRole, cmdRoleOperations, cmdShowRoleProperties } from '../commands/usersRoles';
import { cmdCreateView, cmdDropView, cmdEditView, cmdRefreshView, cmdScriptCreate as cmdViewScriptCreate, cmdScriptSelect as cmdViewScriptSelect, cmdShowViewProperties, cmdViewData, cmdViewOperations } from '../commands/views';

import { SettingsHubPanel, SettingsHubShowOptions } from '../features/settings/SettingsHubPanel';
import {
  cmdCreateNotebookFolder,
  cmdMoveNotebook,
  cmdRenameNotebookFolder,
} from '../features/notebook/notebookFolderCommands';
import { ConnectionUtils } from '../utils/connectionUtils';
import { sentinelThemeSwapService } from '../extension';

// Phase 7: Advanced Power User & AI features
import {
  switchConnectionProfile,
  createConnectionProfile,
  deleteConnectionProfile,
  saveQueryToLibrary,
  saveQueryToLibraryUI,
  loadSavedQuery,
  loadSavedQueryUI,
  viewSavedQuery,
  deleteSavedQuery,
  copySavedQuery,
  editSavedQuery,
  openSavedQueryInNotebook,
  exportSavedQueries,
  importSavedQueries,
  searchSavedQueries,
  showQueryRecommendations,
  exportConnectionProfiles,
  importConnectionProfiles,
} from '../commands/phase7';
import { SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';
import { pickQueryHistory } from '../commands/pickQueryHistory';
import { setTelemetryMode, showTelemetryModePicker } from '../commands/telemetryMode';

// Visual Schema Design
import {
  cmdOpenTableDesigner,
  cmdCreateTableVisual,
  cmdOpenRoleDesigner,
  cmdOpenSchemaDiff,
  cmdOpenSchemaDiffFromPalette,
  cmdOpenErd,
  cmdOpenErdMultiFromDatabase,
  cmdImportDbml,
  cmdImportData,
} from '../commands/schemaDesigner';
import { NotebookTreeItem, NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';

// Phase 2: New object types
import { cmdListTriggers, cmdCreateTrigger, cmdDropTrigger, cmdEnableTrigger, cmdDisableTrigger, cmdShowTriggerProperties, cmdTriggerOperations } from '../commands/triggers';
import { cmdListSequences, cmdCreateSequence, cmdDropSequence, cmdSequenceNextValue, cmdShowSequenceProperties, cmdSequenceOperations } from '../commands/sequences';
import { cmdListPartitions, cmdDetachPartition, cmdShowPartitionProperties, cmdCreatePartition } from '../commands/partitions';
import { cmdListDomains, cmdCreateDomain, cmdDropDomain, cmdShowDomainProperties } from '../commands/domains';
import { cmdListAggregates, cmdDropAggregate, cmdShowAggregateProperties, cmdCreateAggregate } from '../commands/aggregates';
import { cmdListEventTriggers, cmdCreateEventTrigger, cmdDropEventTrigger, cmdEnableEventTrigger, cmdDisableEventTrigger, cmdShowEventTriggerProperties, cmdEventTriggerOperations } from '../commands/eventTriggers';
import {
  cmdListCronJobs,
  cmdInstallPgCron,
  cmdScheduleCronJob,
  cmdShowCronJobProperties,
  cmdUnscheduleCronJob,
} from '../commands/pgCron';
import { cmdListRules, cmdDropRule, cmdShowRuleProperties, cmdRuleOperations } from '../commands/rules';
import { cmdListTablespaces, cmdShowTablespaceProperties, cmdTablespaceOperations } from '../commands/tablespaces';
import { cmdListPublications, cmdCreatePublication, cmdDropPublication, cmdShowPublicationProperties, cmdListSubscriptions, cmdDropSubscription, cmdShowSubscriptionProperties, cmdPublicationOperations } from '../commands/publications';
import { cmdDropPolicy, cmdCreatePolicy } from '../commands/rlsPolicies';
import { cmdMigrationHub } from '../features/migrations/migrationHub';
import { cmdOpenListenNotify, cmdOpenListenNotifyFromPalette } from '../commands/listenNotify';
import { cmdSearchSchema } from '../commands/schemaSearch';
import { WorkspaceStateService } from '../services/WorkspaceStateService';
import { switchWorkspaceDefaultConnection } from '../commands/workspaceConnection';
import { WhatsNewManager } from './WhatsNewManager';
import { cmdLicenseActivate, cmdLicenseManage, cmdLicenseOpenUpgrade, cmdLicenseShowUsage } from '../commands/license';
import {
  cmdSyncNow,
  cmdSyncPause,
  cmdSyncSetup,
  cmdSyncInviteMember,
  cmdSyncShareWithTeam,
  cmdSyncShare,
  cmdSyncImportShares,
  cmdSyncShowSecretKey,
  cmdSyncSignOut,
  cmdSyncStatus,
  cmdSyncStatusMenu,
  cmdSyncPull,
  cmdSyncPush,
  cmdSyncPreview,
  cmdSyncConflicts,
  cmdSyncReplaceLocal,
  cmdSyncReplaceRemote,
  cmdSyncRebuildIndex,
  cmdSyncRepair,
  cmdSyncDiagnostics,
  cmdSyncExcludeItem,
} from '../features/sync/syncCommands';

export function getCommandSpecs(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
  chatViewProviderInstance: ChatViewProvider | undefined,
  outputChannel: vscode.OutputChannel,
  whatsNewManager: WhatsNewManager,
  savedQueriesTreeProvider?: SavedQueriesTreeProvider,
  notebooksTreeProvider?: NotebooksTreeProvider
): Array<{ command: string; callback: (...args: any[]) => any }> {
  const commands = [
    {
      command: 'postgres-explorer.sync.setup',
      callback: () => cmdSyncSetup(context),
    },
    {
      command: 'postgres-explorer.sync.now',
      callback: () => cmdSyncNow(),
    },
    {
      command: 'postgres-explorer.sync.status',
      callback: () => cmdSyncStatus(),
    },
    {
      command: 'postgres-explorer.sync.statusMenu',
      callback: () => cmdSyncStatusMenu(context),
    },
    {
      command: 'postgres-explorer.sync.showSecretKey',
      callback: () => cmdSyncShowSecretKey(context),
    },
    {
      command: 'postgres-explorer.sync.pause',
      callback: () => cmdSyncPause(),
    },
    {
      command: 'postgres-explorer.sync.signOut',
      callback: () => cmdSyncSignOut(),
    },
    {
      command: 'postgres-explorer.sync.inviteMember',
      callback: () => cmdSyncInviteMember(context),
    },
    {
      command: 'postgres-explorer.sync.shareWithTeam',
      callback: (treeItem?: { id?: string; query?: { id?: string }; uri?: vscode.Uri }) =>
        cmdSyncShareWithTeam(context, treeItem),
    },
    {
      command: 'postgres-explorer.sync.share',
      callback: () => cmdSyncInviteMember(context),
    },
    {
      command: 'postgres-explorer.sync.importShares',
      callback: () => cmdSyncImportShares(context),
    },
    {
      command: 'postgres-explorer.sync.pull',
      callback: () => cmdSyncPull(),
    },
    {
      command: 'postgres-explorer.sync.push',
      callback: () => cmdSyncPush(),
    },
    {
      command: 'postgres-explorer.sync.preview',
      callback: () => cmdSyncPreview(),
    },
    {
      command: 'postgres-explorer.sync.conflicts',
      callback: () => cmdSyncConflicts(),
    },
    {
      command: 'postgres-explorer.sync.replaceLocal',
      callback: () => cmdSyncReplaceLocal(),
    },
    {
      command: 'postgres-explorer.sync.replaceRemote',
      callback: () => cmdSyncReplaceRemote(),
    },
    {
      command: 'postgres-explorer.sync.rebuildIndex',
      callback: () => cmdSyncRebuildIndex(),
    },
    {
      command: 'postgres-explorer.sync.repair',
      callback: () => cmdSyncRepair(),
    },
    {
      command: 'postgres-explorer.sync.diagnostics',
      callback: () => cmdSyncDiagnostics(),
    },
    {
      command: 'postgres-explorer.sync.excludeItem',
      callback: async (treeItem?: { id?: string; query?: { id?: string }; uri?: vscode.Uri }) => {
        const { resolveSyncItemIdFromTreeItem } = await import('../features/sync/syncCommands');
        await cmdSyncExcludeItem(await resolveSyncItemIdFromTreeItem(treeItem));
      },
    },
    {
      command: 'postgres-explorer.license.activate',
      callback: (prefillKey?: string) => cmdLicenseActivate(prefillKey)
    },
    {
      command: 'postgres-explorer.migrationHub',
      callback: () => cmdMigrationHub()
    },
    {
      command: 'postgres-explorer.license.manage',
      callback: () => cmdLicenseManage()
    },
    {
      command: 'postgres-explorer.license.openUpgrade',
      callback: () => cmdLicenseOpenUpgrade()
    },
    {
      command: 'postgres-explorer.license.showUsage',
      callback: () => cmdLicenseShowUsage()
    },
    {
      command: 'postgres-explorer.audit.openLog',
      callback: async () => {
        const { AuditLogService } = await import('../features/audit/AuditLogService');
        await AuditLogService.getInstance().openLog();
      }
    },
    {
      command: 'postgres-explorer.addConnection',
      callback: () => {
        SettingsHubPanel.show(context.extensionUri, context, {
          section: 'connections',
          addConnection: true,
        });
      }
    },
    {
      command: 'postgres-explorer.importConnectionFromDatabaseUrl',
      callback: () => cmdImportConnectionFromDatabaseUrl(context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.smartPasteConnection',
      callback: () => cmdSmartPasteConnection(context, databaseTreeProvider),
    },
    {
      command: 'postgres-explorer.editConnection',
      callback: (item: DatabaseTreeItem) => {
        if (!item || !item.connectionId) return;
        const connection = ConnectionUtils.findConnection(item.connectionId);
        if (connection) {
          SettingsHubPanel.show(context.extensionUri, context, {
            section: 'connections',
            editConnectionId: item.connectionId,
          });
        }
      }
    },
    {
      command: 'postgres-explorer.duplicateConnection',
      callback: async (item: DatabaseTreeItem) => {
        await cmdDuplicateConnection(item, context, databaseTreeProvider);
      }
    },
    {
      command: 'postgres-explorer.refreshConnections',
      callback: () => {
        databaseTreeProvider.refresh();
      }
    },
    {
      command: 'postgres-explorer.clearHistory',
      callback: async () => {
        await QueryHistoryService.getInstance().clear();
        vscode.window.showInformationMessage('Query history cleared');
      }
    },
    {
      command: 'postgres-explorer.pickQueryHistory',
      callback: () => pickQueryHistory()
    },
    {
      command: 'postgres-explorer.telemetry.openModePicker',
      callback: () => showTelemetryModePicker()
    },
    {
      command: 'postgres-explorer.telemetry.setModeOff',
      callback: () => setTelemetryMode('off')
    },
    {
      command: 'postgres-explorer.telemetry.setModeBasic',
      callback: () => setTelemetryMode('basic')
    },
    {
      command: 'postgres-explorer.telemetry.setModeDetailed',
      callback: () => setTelemetryMode('detailed')
    },
    {
      command: 'postgres-explorer.showWhatsNew',
      callback: () => {
        void whatsNewManager.checkAndShow(true);
      }
    },
    {
      command: 'postgres-explorer.copyQuery',
      callback: async (item: any) => {
        // Handle both direct string (from context menu if configured that way) or TreeItem
        const query = typeof item === 'string' ? item : item?.query;
        if (query) {
          await vscode.env.clipboard.writeText(query);
          vscode.window.showInformationMessage('Query copied to clipboard');
        }
      }
    },
    {
      command: 'postgres-explorer.deleteHistoryItem',
      callback: async (item: any) => {
        if (item && item.id) {
          await QueryHistoryService.getInstance().delete(item.id);
        }
      }
    },
    {
      command: 'postgres-explorer.openQuery',
      callback: async (item: any) => {
        const query = typeof item === 'string' ? item : item?.query;
        if (query) {
          const doc = await vscode.workspace.openTextDocument({
            content: query,
            language: 'sql'
          });
          await vscode.window.showTextDocument(doc);
        }
      }
    },
    {
      command: 'postgres-explorer.explainQuery',
      callback: async (cellUri: vscode.Uri, analyze: boolean) => {
        await cmdExplainQuery(cellUri, analyze);
      }
    },
    {
      command: 'postgres-explorer.explainQueryFromCell',
      callback: async (cell?: vscode.NotebookCell) => {
        let target = cell;
        if (!target) {
          const editor = vscode.window.activeNotebookEditor;
          if (editor?.selection && editor.selection.start < editor.notebook.cellCount) {
            target = editor.notebook.cellAt(editor.selection.start);
          }
        }
        if (!target) {
          vscode.window.showErrorMessage('No cell selected');
          return;
        }
        await cmdExplainQuery(target.document.uri, true);
      },
    },
    {
      command: 'postgres-explorer.toggleFullDatasetForCell',
      callback: async (cellUri?: vscode.Uri) => {
        await toggleFullDatasetForCell(cellUri);
      },
    },
    {
      command: 'postgres-explorer.toggleFullDatasetFromCell',
      callback: async (cell?: vscode.NotebookCell) => {
        await toggleFullDatasetFromCell(cell);
      },
    },
    {
      command: 'postgres-explorer.tableProfile',
      callback: async (item: DatabaseTreeItem) => await cmdTableProfile(item, context)
    },
    {
      command: 'postgres-explorer.tableActivity',
      callback: async (item: DatabaseTreeItem) => await cmdTableActivity(item, context)
    },
    {
      command: 'postgres-explorer.indexUsage',
      callback: async (item: DatabaseTreeItem) => await cmdIndexUsage(item, context)
    },
    {
      command: 'postgres-explorer.tableDefinition',
      callback: async (item: DatabaseTreeItem) => await cmdTableDefinition(item, context)
    },
    {
      command: 'postgres-explorer.generateQuery',
      callback: async () => {
        if (!chatViewProviderInstance) {
          vscode.window.showErrorMessage('AI Chat is not initialized');
          return;
        }

        // Step 1: Get all connections
        const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];

        if (connections.length === 0) {
          vscode.window.showErrorMessage('No database connections found. Please add a connection first.');
          return;
        }

        // Step 2: Let user select connection
        const connectionItems = connections.map(conn => ({
          label: conn.name,
          description: `${conn.host}:${conn.port}/${conn.database}`,
          connection: conn
        }));

        const selectedConnection = await vscode.window.showQuickPick(connectionItems, {
          placeHolder: 'Select a database connection',
          title: 'Generate Query - Select Database'
        });

        if (!selectedConnection) {
          return;
        }

        // Step 3: Fetch database objects (tables, views, functions)
        try {
          const dbObjects = await databaseTreeProvider.getDbObjectsForConnection(selectedConnection.connection);

          if (!dbObjects || dbObjects.length === 0) {
            vscode.window.showWarningMessage('No tables, views, or functions found in this database.');
            // Continue anyway, let user describe query without schema
            const input = await vscode.window.showInputBox({
              prompt: 'Describe the SQL query you want to generate',
              placeHolder: 'e.g., Show me top 10 users by order count'
            });

            if (input) {
              vscode.commands.executeCommand('postgres-explorer.chatView.focus');
              await chatViewProviderInstance.handleGenerateQuery(input);
            }
            return;
          }

          // Step 4: Let user select relevant objects
          const objectItems = dbObjects.map(obj => ({
            label: `${obj.type === 'table' ? '📋' : obj.type === 'view' ? '👁️' : '⚙️'} ${obj.schema}.${obj.name}`,
            description: obj.type,
            picked: false,
            object: obj
          }));

          const selectedObjects = await vscode.window.showQuickPick(objectItems, {
            placeHolder: 'Select tables, views, or functions (multi-select)',
            title: 'Generate Query - Select Database Objects',
            canPickMany: true
          });

          if (!selectedObjects || selectedObjects.length === 0) {
            const proceed = await vscode.window.showWarningMessage(
              'No objects selected. Generate query without schema context?',
              'Yes', 'No'
            );

            if (proceed !== 'Yes') {
              return;
            }
          }

          // Step 5: Get query description
          const input = await vscode.window.showInputBox({
            prompt: 'Describe the SQL query you want to generate',
            placeHolder: 'e.g., Show me top 10 users by order count in the last month'
          });

          if (input) {
            // Focus the chat view
            vscode.commands.executeCommand('postgres-explorer.chatView.focus');

            // Send to AI with schema context
            const schemaContext = selectedObjects ? selectedObjects.map(item => item.object) : undefined;
            await chatViewProviderInstance.handleGenerateQuery(input, schemaContext);
          }
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to fetch database objects: ${error.message}`);
        }
      }
    },
    {
      command: 'postgres-explorer.optimizeQuery',
      callback: async () => {
        if (!chatViewProviderInstance) {
          vscode.window.showErrorMessage('AI Chat is not initialized');
          return;
        }

        let query = '';
        const activeNotebookEditor = vscode.window.activeNotebookEditor;
        if (activeNotebookEditor && activeNotebookEditor.selections.length > 0) {
          const cellIndex = activeNotebookEditor.selections[0].start;
          const cell = activeNotebookEditor.notebook.cellAt(cellIndex);
          query = cell.document.getText().trim();
        }

        if (!query) {
          query = (await vscode.window.showInputBox({
            prompt: 'Paste or type the SQL query you want to optimize',
            placeHolder: 'SELECT ...'
          }))?.trim() || '';
        }

        if (!query) {
          vscode.window.showWarningMessage('No query provided for optimization.');
          return;
        }

        await vscode.commands.executeCommand('postgresExplorer.chatView.focus');
        await chatViewProviderInstance.handleOptimizeQuery(query);
      }
    },
    {
      command: 'postgres-explorer.openSqlAssistantTab',
      callback: async () => {
        if (!chatViewProviderInstance) {
          vscode.window.showWarningMessage('SQL Assistant is not available');
          return;
        }

        await chatViewProviderInstance.openInEditor(vscode.ViewColumn.Beside);
      }
    },
    {
      command: 'postgres-explorer.addToFavorites',
      callback: async (item: DatabaseTreeItem) => {
        if (item) {
          await databaseTreeProvider.addToFavorites(item);
        }
      }
    },
    {
      command: 'postgres-explorer.removeFromFavorites',
      callback: async (item: DatabaseTreeItem) => {
        if (item) {
          await databaseTreeProvider.removeFromFavorites(item);
        }
      }
    },
    {
      command: 'postgres-explorer.manageConnections',
      callback: () => {
        SettingsHubPanel.show(context.extensionUri, context, { section: 'connections' });
      }
    },
    {
      command: 'postgres-explorer.aiSettings',
      callback: () => {
        SettingsHubPanel.show(context.extensionUri, context, { section: 'ai' });
      }
    },
    {
      command: 'postgres-explorer.settingsHub',
      callback: (options?: SettingsHubShowOptions) => {
        SettingsHubPanel.show(context.extensionUri, context, options ?? {}, sentinelThemeSwapService);
      }
    },
    {
      command: 'postgres-explorer.connect',
      callback: async (item: any) => await cmdConnectDatabase(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.disconnect',
      callback: async () => {
        databaseTreeProvider.refresh();
        vscode.window.showInformationMessage('Disconnected from PostgreSQL database');
      }
    },
    {
      command: 'postgres-explorer.queryTable',
      callback: async (item: any) => {
        if (!item || !item.schema) {
          return;
        }

        const query = `SELECT * FROM ${item.schema}.${item.label} LIMIT 100;`;
        const notebook = await vscode.workspace.openNotebookDocument('postgres-notebook', new vscode.NotebookData([
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, query, 'sql')
        ]));
        await vscode.window.showNotebookDocument(notebook);
      }
    },
    {
      command: 'postgres-explorer.newNotebook',
      callback: async (item: any) => await cmdNewNotebook(item, context)
    },
    {
      command: 'postgres-explorer.jumpToSection',
      callback: async () => await cmdJumpToSection()
    },
    {
      command: 'postgres-explorer.exportNotebook',
      callback: () => cmdExportNotebook()
    },
    {
      command: 'postgres-explorer.notebooks.refresh',
      callback: () => notebooksTreeProvider?.refresh()
    },
    {
      command: 'postgres-explorer.notebooks.open',
      callback: async (item: NotebookTreeItem) => {
        if (item?.uri) {
          const doc = await vscode.workspace.openNotebookDocument(item.uri);
          await vscode.window.showNotebookDocument(doc, { preserveFocus: false });
        }
      }
    },
    {
      command: 'postgres-explorer.notebooks.rename',
      callback: async (item: NotebookTreeItem) => {
        if (!item?.uri) { return; }
        const oldName = (item.label as string);
        const newName = await vscode.window.showInputBox({
          prompt: 'New notebook name',
          value: oldName,
          validateInput: v => v && /^[a-zA-Z0-9_-]+$/.test(v) ? null : 'Use only letters, numbers, hyphens, underscores'
        });
        if (!newName || newName === oldName) { return; }
        const newUri = vscode.Uri.joinPath(item.uri, '..', `${newName}.pgsql`);
        await vscode.workspace.fs.rename(item.uri, newUri, { overwrite: false });
        try {
          const raw = await vscode.workspace.fs.readFile(newUri);
          const parsed = JSON.parse(Buffer.from(raw).toString()) as Record<string, unknown>;
          const { readNotebookSyncId } = await import('../features/sync/notebookSyncId');
          const { SyncIndex } = await import('../features/sync/SyncIndex');
          const { recordSyncActivity } = await import('../features/sync/SyncActivityLog');
          const syncId = readNotebookSyncId(parsed);
          if (syncId) {
            const index = new SyncIndex(context);
            index.update(syncId, { kind: 'notebook', name: newName, filePath: newUri.fsPath });
            await index.flush();
            recordSyncActivity({
              kind: 'notebook',
              action: 'rename',
              itemId: syncId,
              name: newName,
              previousName: oldName,
            });
          }
        } catch {
          /* index update is best-effort */
        }
        const { triggerInstantSync } = await import('../features/sync/syncTriggers');
        triggerInstantSync();
        notebooksTreeProvider?.refresh();
      }
    },
    {
      command: 'postgres-explorer.notebooks.delete',
      callback: async (item: NotebookTreeItem) => {
        if (!item?.uri) { return; }
        const notebookName = item.label as string;
        let syncId: string | undefined;
        try {
          const raw = await vscode.workspace.fs.readFile(item.uri);
          const parsed = JSON.parse(Buffer.from(raw).toString()) as Record<string, unknown>;
          const { readNotebookSyncId } = await import('../features/sync/notebookSyncId');
          syncId = readNotebookSyncId(parsed);
        } catch {
          /* best-effort */
        }
        const { isItemSyncedToCloud, resolveDeleteCloudChoice, applyLocalDeleteCloudChoice } =
          await import('../features/sync/localDeletePrompt');
        const synced = !!(syncId && isItemSyncedToCloud(context, syncId));
        const cloudChoice = syncId
          ? await resolveDeleteCloudChoice(context, syncId, notebookName)
          : 'keep-cloud';
        if (!cloudChoice) { return; }
        if (!synced) {
          const confirm = await vscode.window.showWarningMessage(
            `Delete "${notebookName}.pgsql"? This cannot be undone.`,
            { modal: true }, 'Delete'
          );
          if (confirm !== 'Delete') { return; }
        }
        await vscode.workspace.fs.delete(item.uri, { recursive: false });
        if (syncId) {
          await applyLocalDeleteCloudChoice(syncId, cloudChoice);
        }
        notebooksTreeProvider?.refresh();
      }
    },
    {
      command: 'postgres-explorer.notebooks.deleteFolder',
      callback: async (item: NotebookTreeItem) => {
        if (!item?.uri) { return; }
        const folderName = item.label as string;
        const confirm = await vscode.window.showWarningMessage(
          `Delete folder "${folderName}" and all notebooks inside it? This cannot be undone.`,
          { modal: true },
          'Delete Folder'
        );
        if (confirm !== 'Delete Folder') { return; }
        await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: false });
        const { triggerInstantSync } = await import('../features/sync/syncTriggers');
        triggerInstantSync();
        notebooksTreeProvider?.refresh();
      }
    },
    {
      command: 'postgres-explorer.notebooks.createFolder',
      callback: async (item?: NotebookTreeItem) => {
        await cmdCreateNotebookFolder(context, item, notebooksTreeProvider, context.globalStorageUri);
      },
    },
    {
      command: 'postgres-explorer.notebooks.renameFolder',
      callback: async (item: NotebookTreeItem) => {
        await cmdRenameNotebookFolder(context, item, notebooksTreeProvider);
      },
    },
    {
      command: 'postgres-explorer.notebooks.moveNotebook',
      callback: async (item: NotebookTreeItem) => {
        await cmdMoveNotebook(context, item, notebooksTreeProvider, context.globalStorageUri);
      },
    },
    {
      command: 'postgres-explorer.refresh',
      callback: () => databaseTreeProvider.refresh()
    },
    // Add database commands
    {
      command: 'postgres-explorer.createInDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdAddObjectInDatabase(item, context)
    },
    {
      command: 'postgres-explorer.createDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdCreateDatabase(item, context)
    },
    {
      command: 'postgres-explorer.dropDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdDeleteDatabase(item, context)
    },
    {
      command: 'postgres-explorer.scriptAlterDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdScriptAlterDatabase(item, context)
    },
    {
      command: 'postgres-explorer.databaseOperations',
      callback: async (item: DatabaseTreeItem) => await cmdDatabaseOperations(item, context)
    },
    {
      command: 'postgres-explorer.showDashboard',
      callback: async (item: DatabaseTreeItem) => await cmdDatabaseDashboard(item, context)
    },
    {
      command: 'postgres-explorer.showDashboardFromPalette',
      callback: () => cmdDatabaseDashboardFromPalette(context)
    },
    {
      command: 'postgres-explorer.openListenNotify',
      callback: async (item: DatabaseTreeItem) => await cmdOpenListenNotify(item, context)
    },
    {
      command: 'postgres-explorer.openListenNotifyFromPalette',
      callback: () => cmdOpenListenNotifyFromPalette(context)
    },
    {
      command: 'postgres-explorer.backupDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdBackupDatabase(item, context)
    },
    {
      command: 'postgres-explorer.restoreDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdRestoreDatabase(item, context)
    },
    {
      command: 'postgres-explorer.openBackupWorkspace',
      callback: () => cmdOpenBackupWorkspaceFromPalette(context)
    },
    {
      command: 'postgres-explorer.generateCreateScript',
      callback: async (item: DatabaseTreeItem) => await cmdGenerateCreateScript(item, context)
    },
    {
      command: 'postgres-explorer.disconnectDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdDisconnectDatabaseLegacy(item, context)
    },
    {
      command: 'postgres-explorer.maintenanceDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdMaintenanceDatabase(item, context)
    },
    {
      command: 'postgres-explorer.queryTool',
      callback: async (item: DatabaseTreeItem) => await cmdQueryTool(item, context)
    },
    {
      command: 'postgres-explorer.psqlTool',
      callback: async (item: DatabaseTreeItem) => await cmdPsqlTool(item, context)
    },
    {
      command: 'postgres-explorer.showConfiguration',
      callback: async (item: DatabaseTreeItem) => await cmdShowConfiguration(item, context)
    },
    // Add schema commands
    {
      command: 'postgres-explorer.createSchema',
      callback: async (item: DatabaseTreeItem) => await cmdCreateSchema(item, context)
    },
    {
      command: 'postgres-explorer.createInSchema',
      callback: async (item: DatabaseTreeItem) => await cmdCreateObjectInSchema(item, context)
    },
    {
      command: 'postgres-explorer.schemaOperations',
      callback: async (item: DatabaseTreeItem) => await cmdSchemaOperations(item, context)
    },
    {
      command: 'postgres-explorer.showSchemaProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowSchemaProperties(item, context)
    },
    // Add table commands
    {
      command: 'postgres-explorer.editTable',
      callback: async (item: DatabaseTreeItem) => await cmdEditTable(item, context)
    },
    {
      command: 'postgres-explorer.viewTableData',
      callback: async (item: DatabaseTreeItem) => {
        await databaseTreeProvider.addToRecent(item);
        await cmdViewTableData(item, context);
      }
    },
    {
      command: 'postgres-explorer.dropTable',
      callback: async (item: DatabaseTreeItem) => await cmdDropTable(item, context)
    },
    {
      command: 'postgres-explorer.tableOperations',
      callback: async (item: DatabaseTreeItem) => await cmdTableOperations(item, context)
    },
    {
      command: 'postgres-explorer.truncateTable',
      callback: async (item: DatabaseTreeItem) => await cmdTruncateTable(item, context)
    },
    {
      command: 'postgres-explorer.quickClone',
      callback: async (item: DatabaseTreeItem) => await cmdQuickCloneTable(item, context)
    },
    {
      command: 'postgres-explorer.insertData',
      callback: async (item: DatabaseTreeItem) => await cmdInsertTable(item, context)
    },
    {
      command: 'postgres-explorer.exportTable',
      callback: async (item: DatabaseTreeItem) => await cmdExportTable(item, context)
    },
    {
      command: 'postgres-explorer.updateData',
      callback: async (item: DatabaseTreeItem) => await cmdUpdateTable(item, context)
    },
    {
      command: 'postgres-explorer.showTableProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowTableProperties(item, context)
    },
    // Add script commands
    {
      command: 'postgres-explorer.scriptSelect',
      callback: async (item: DatabaseTreeItem) => await cmdScriptSelect(item, context)
    },
    {
      command: 'postgres-explorer.scriptInsert',
      callback: async (item: DatabaseTreeItem) => await cmdScriptInsert(item, context)
    },
    {
      command: 'postgres-explorer.scriptUpdate',
      callback: async (item: DatabaseTreeItem) => await cmdScriptUpdate(item, context)
    },
    {
      command: 'postgres-explorer.scriptDelete',
      callback: async (item: DatabaseTreeItem) => await cmdScriptDelete(item, context)
    },
    {
      command: 'postgres-explorer.scriptCreate',
      callback: async (item: DatabaseTreeItem) => await cmdScriptCreate(item, context)
    },
    // Add maintenance commands
    {
      command: 'postgres-explorer.maintenanceVacuum',
      callback: async (item: DatabaseTreeItem) => await cmdMaintenanceVacuum(item, context)
    },
    {
      command: 'postgres-explorer.maintenanceAnalyze',
      callback: async (item: DatabaseTreeItem) => await cmdMaintenanceAnalyze(item, context)
    },
    {
      command: 'postgres-explorer.maintenanceReindex',
      callback: async (item: DatabaseTreeItem) => await cmdMaintenanceReindex(item, context)
    },

    // Add view commands
    {
      command: 'postgres-explorer.refreshView',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshView(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.editViewDefinition',
      callback: async (item: DatabaseTreeItem) => await cmdEditView(item, context)
    },
    {
      command: 'postgres-explorer.viewViewData',
      callback: async (item: DatabaseTreeItem) => {
        await databaseTreeProvider.addToRecent(item);
        await cmdViewData(item, context);
      }
    },
    {
      command: 'postgres-explorer.dropView',
      callback: async (item: DatabaseTreeItem) => await cmdDropView(item, context)
    },
    {
      command: 'postgres-explorer.viewOperations',
      callback: async (item: DatabaseTreeItem) => await cmdViewOperations(item, context)
    },
    {
      command: 'postgres-explorer.showViewProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowViewProperties(item, context)
    },
    {
      command: 'postgres-explorer.viewScriptSelect',
      callback: async (item: DatabaseTreeItem) => await cmdViewScriptSelect(item, context)
    },
    {
      command: 'postgres-explorer.viewScriptCreate',
      callback: async (item: DatabaseTreeItem) => await cmdViewScriptCreate(item, context)
    },
    // Add function commands
    {
      command: 'postgres-explorer.refreshFunction',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshFunction(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.showFunctionProperties',
      callback: async (item: DatabaseTreeItem) => {
        await databaseTreeProvider.addToRecent(item);
        await cmdShowFunctionProperties(item, context);
      }
    },
    {
      command: 'postgres-explorer.functionOperations',
      callback: async (item: DatabaseTreeItem) => await cmdFunctionOperations(item, context)
    },
    {
      command: 'postgres-explorer.createReplaceFunction',
      callback: async (item: DatabaseTreeItem) => await cmdEditFunction(item, context)
    },
    {
      command: 'postgres-explorer.callFunction',
      callback: async (item: DatabaseTreeItem) => await cmdCallFunction(item, context)
    },
    {
      command: 'postgres-explorer.dropFunction',
      callback: async (item: DatabaseTreeItem) => await cmdDropFunction(item, context)
    },
    // Add procedure commands
    {
      command: 'postgres-explorer.refreshProcedure',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshProcedure(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.showProcedureProperties',
      callback: async (item: DatabaseTreeItem) => {
        await databaseTreeProvider.addToRecent(item);
        await cmdShowProcedureProperties(item, context);
      }
    },
    {
      command: 'postgres-explorer.procedureOperations',
      callback: async (item: DatabaseTreeItem) => await cmdProcedureOperations(item, context)
    },
    {
      command: 'postgres-explorer.createReplaceProcedure',
      callback: async (item: DatabaseTreeItem) => await cmdEditProcedure(item, context)
    },
    {
      command: 'postgres-explorer.callProcedure',
      callback: async (item: DatabaseTreeItem) => await cmdCallProcedure(item, context)
    },
    {
      command: 'postgres-explorer.dropProcedure',
      callback: async (item: DatabaseTreeItem) => await cmdDropProcedure(item, context)
    },
    {
      command: 'postgres-explorer.createProcedure',
      callback: async (item: DatabaseTreeItem) => await cmdCreateProcedure(item, context)
    },
    // Add materialized view commands
    {
      command: 'postgres-explorer.refreshMaterializedView',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshMatView(item, context)
    },
    {
      command: 'postgres-explorer.editMatView',
      callback: async (item: DatabaseTreeItem) => await cmdEditMatView(item, context)
    },
    {
      command: 'postgres-explorer.editMaterializedView',
      callback: async (item: DatabaseTreeItem) => await cmdEditMatView(item, context)
    },
    {
      command: 'postgres-explorer.viewMaterializedViewData',
      callback: async (item: DatabaseTreeItem) => await cmdViewMatViewData(item, context)
    },
    {
      command: 'postgres-explorer.showMaterializedViewProperties',
      callback: async (item: DatabaseTreeItem) => await cmdViewMatViewProperties(item, context)
    },
    {
      command: 'postgres-explorer.dropMatView',
      callback: async (item: DatabaseTreeItem) => await cmdDropMatView(item, context)
    },
    {
      command: 'postgres-explorer.materializedViewOperations',
      callback: async (item: DatabaseTreeItem) => await cmdMatViewOperations(item, context)
    },
    // Add type commands
    {
      command: 'postgres-explorer.refreshType',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshType(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.typeOperations',
      callback: async (item: DatabaseTreeItem) => await cmdAllOperationsTypes(item, context)
    },
    {
      command: 'postgres-explorer.editType',
      callback: async (item: DatabaseTreeItem) => await cmdEditTypes(item, context)
    },
    {
      command: 'postgres-explorer.showTypeProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowTypeProperties(item, context)
    },
    {
      command: 'postgres-explorer.dropType',
      callback: async (item: DatabaseTreeItem) => await cmdDropType(item, context)
    },
    // Add foreign table commands
    {
      command: 'postgres-explorer.refreshForeignTable',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshForeignTable(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.foreignTableOperations',
      callback: async (item: DatabaseTreeItem) => await cmdForeignTableOperations(item, context)
    },
    {
      command: 'postgres-explorer.editForeignTable',
      callback: async (item: DatabaseTreeItem) => await cmdEditForeignTable(item, context)
    },
    {
      command: 'postgres-explorer.showForeignTableProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowForeignTableProperties(item, context)
    },
    {
      command: 'postgres-explorer.viewForeignTableData',
      callback: async (item: DatabaseTreeItem) => await cmdViewForeignTableData(item, context)
    },
    {
      command: 'postgres-explorer.dropForeignTable',
      callback: async (item: DatabaseTreeItem) => await cmdDropForeignTable(item, context)
    },
    // Add role/user commands
    {
      command: 'postgres-explorer.refreshRole',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshRole(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.createUser',
      callback: async (item: DatabaseTreeItem) => await cmdAddUser(item, context)
    },
    {
      command: 'postgres-explorer.createRole',
      callback: async (item: DatabaseTreeItem) => await cmdAddRole(item, context)
    },
    {
      command: 'postgres-explorer.editRole',
      callback: async (item: DatabaseTreeItem) => await cmdEditRole(item, context)
    },
    {
      command: 'postgres-explorer.grantRevoke',
      callback: async (item: DatabaseTreeItem) => await cmdGrantRevokeRole(item, context)
    },
    {
      command: 'postgres-explorer.dropRole',
      callback: async (item: DatabaseTreeItem) => await cmdDropRole(item, context)
    },
    {
      command: 'postgres-explorer.roleOperations',
      callback: async (item: DatabaseTreeItem) => await cmdRoleOperations(item, context)
    },
    {
      command: 'postgres-explorer.showRoleProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowRoleProperties(item, context)
    },
    // Add extension commands
    {
      command: 'postgres-explorer.refreshExtension',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshExtension(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.enableExtension',
      callback: async (item: DatabaseTreeItem) => await cmdEnableExtension(item, context)
    },
    {
      command: 'postgres-explorer.extensionOperations',
      callback: async (item: DatabaseTreeItem) => await cmdExtensionOperations(item, context)
    },
    {
      command: 'postgres-explorer.dropExtension',
      callback: async (item: DatabaseTreeItem) => await cmdDropExtension(item, context)
    },
    // Add connection commands
    {
      command: 'postgres-explorer.disconnectConnection',
      callback: async (item: DatabaseTreeItem) => await cmdDisconnectConnection(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.reconnectConnection',
      callback: async (item: DatabaseTreeItem) => await cmdReconnectConnection(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.deleteConnection',
      callback: async (item: DatabaseTreeItem) => await cmdDisconnectDatabase(item, context, databaseTreeProvider)
    },

    {
      command: 'postgres-explorer.createTable',
      callback: async (item: DatabaseTreeItem) => await cmdCreateTable(item, context)
    },
    {
      command: 'postgres-explorer.createView',
      callback: async (item: DatabaseTreeItem) => await cmdCreateView(item, context)
    },
    {
      command: 'postgres-explorer.createFunction',
      callback: async (item: DatabaseTreeItem) => await cmdCreateFunction(item, context)
    },
    {
      command: 'postgres-explorer.createMaterializedView',
      callback: async (item: DatabaseTreeItem) => await cmdCreateMaterializedView(item, context)
    },
    {
      command: 'postgres-explorer.createType',
      callback: async (item: DatabaseTreeItem) => await cmdCreateType(item, context)
    },
    {
      command: 'postgres-explorer.createForeignTable',
      callback: async (item: DatabaseTreeItem) => await cmdCreateForeignTable(item, context)
    },
    // Foreign Data Wrapper commands
    {
      command: 'postgres-explorer.foreignDataWrapperOperations',
      callback: async (item: DatabaseTreeItem) => await cmdForeignDataWrapperOperations(item, context)
    },
    {
      command: 'postgres-explorer.showForeignDataWrapperProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowForeignDataWrapperProperties(item, context)
    },
    {
      command: 'postgres-explorer.refreshForeignDataWrapper',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshForeignDataWrapper(item, context, databaseTreeProvider)
    },
    // Foreign Server commands
    {
      command: 'postgres-explorer.createForeignServer',
      callback: async (item: DatabaseTreeItem) => await cmdCreateForeignServer(item, context)
    },
    {
      command: 'postgres-explorer.foreignServerOperations',
      callback: async (item: DatabaseTreeItem) => await cmdForeignServerOperations(item, context)
    },
    {
      command: 'postgres-explorer.showForeignServerProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowForeignServerProperties(item, context)
    },
    {
      command: 'postgres-explorer.dropForeignServer',
      callback: async (item: DatabaseTreeItem) => await cmdDropForeignServer(item, context)
    },
    {
      command: 'postgres-explorer.refreshForeignServer',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshForeignServer(item, context, databaseTreeProvider)
    },
    // User Mapping commands
    {
      command: 'postgres-explorer.createUserMapping',
      callback: async (item: DatabaseTreeItem) => await cmdCreateUserMapping(item, context)
    },
    {
      command: 'postgres-explorer.userMappingOperations',
      callback: async (item: DatabaseTreeItem) => await cmdUserMappingOperations(item, context)
    },
    {
      command: 'postgres-explorer.showUserMappingProperties',
      callback: async (item: DatabaseTreeItem) => await cmdShowUserMappingProperties(item, context)
    },
    {
      command: 'postgres-explorer.dropUserMapping',
      callback: async (item: DatabaseTreeItem) => await cmdDropUserMapping(item, context)
    },
    {
      command: 'postgres-explorer.refreshUserMapping',
      callback: async (item: DatabaseTreeItem) => await cmdRefreshUserMapping(item, context, databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.createRole',
      callback: async (item: DatabaseTreeItem) => await cmdAddRole(item, context)
    },
    {
      command: 'postgres-explorer.enableExtension',
      callback: async (item: DatabaseTreeItem) => await cmdEnableExtension(item, context)
    },

    {
      command: 'postgres-explorer.aiAssist',
      callback: async (cell: vscode.NotebookCell) => await cmdAiAssist(cell, context, outputChannel)
    },

    {
      command: 'postgres-explorer.chatWithQuery',
      callback: async (cell: vscode.NotebookCell) => {
        // Get the query from the active cell
        let query = '';
        let results = '';

        if (cell) {
          query = cell.document.getText();
          // Check if there are outputs from previous execution
          if (cell.outputs && cell.outputs.length > 0) {
            const output = cell.outputs[0];
            for (const item of output.items) {
              if (item.mime === 'application/x-postgres-result' || item.mime === 'application/json') {
                try {
                  const data = JSON.parse(new TextDecoder().decode(item.data));
                  if (data.rows && data.rows.length > 0) {
                    results = `\nResults (${data.rows.length} rows): ${JSON.stringify(data.rows.slice(0, 5), null, 2)}${data.rows.length > 5 ? '\n... and more' : ''}`;
                  }
                } catch (e) {
                  // Ignore parse errors
                }
              }
            }
          }
        } else {
          // Fallback to active notebook editor
          const activeEditor = vscode.window.activeNotebookEditor;
          if (activeEditor) {
            const selections = activeEditor.selections;
            if (selections && selections.length > 0) {
              const cellIndex = selections[0].start;
              const activeCell = activeEditor.notebook.cellAt(cellIndex);
              query = activeCell.document.getText();
            }
          }
        }

        if (!query) {
          vscode.window.showWarningMessage('No query found in the active cell.');
          return;
        }

        // Focus the chat view and send the query
        await vscode.commands.executeCommand('postgresExplorer.chatView.focus');

        // Send message to chat view with query context
        const message = `Help me with this SQL query:\n\`\`\`sql\n${query}\n\`\`\`${results}`;

        // Use the chat view provider to send the message
        if (chatViewProviderInstance) {
          chatViewProviderInstance.sendToChat({ query, results, message });
        }
      }
    },

    {
      command: 'postgres-explorer.sendToChat',
      callback: async (data: { query: string; results?: string; message: string }) => {
        if (chatViewProviderInstance) {
          await chatViewProviderInstance.sendToChat(data);
        }
      }
    },

    {
      command: 'postgres-explorer.attachToChat',
      callback: async (item: DatabaseTreeItem) => {
        if (!chatViewProviderInstance) {
          vscode.window.showWarningMessage('SQL Assistant is not available');
          return;
        }
        if (!item || !item.connectionId || !item.databaseName) {
          vscode.window.showErrorMessage('Invalid database object');
          return;
        }

        // Resolve connection name from config
        const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
        const conn = connections.find(c => c.id === item.connectionId);
        const connectionName = conn?.name || conn?.host || 'Unknown';

        // Convert DatabaseTreeItem to DbObject
        const dbObject: any = {
          name: item.label,
          type: item.type,
          schema: item.schema || '',
          database: item.databaseName,
          connectionId: item.connectionId,
          connectionName: connectionName,
          breadcrumb: [connectionName, item.databaseName, item.schema, item.label].filter(Boolean).join(' > ')
        };

        await chatViewProviderInstance.attachDbObject(dbObject);
      }
    },

    // Column commands
    {
      command: 'postgres-explorer.showColumnProperties',
      callback: async (item: DatabaseTreeItem) => await showColumnProperties(item)
    },
    {
      command: 'postgres-explorer.copyColumnName',
      callback: async (item: DatabaseTreeItem) => await copyColumnName(item)
    },
    {
      command: 'postgres-explorer.copyColumnNameQuoted',
      callback: async (item: DatabaseTreeItem) => await copyColumnNameQuoted(item)
    },
    {
      command: 'postgres-explorer.generateSelectStatement',
      callback: async (item: DatabaseTreeItem) => await generateSelectStatement(item)
    },
    {
      command: 'postgresExplorer.openColumnNotebook',
      callback: async (item: DatabaseTreeItem) => await showColumnProperties(item)
    },
    {
      command: 'postgres-explorer.generateWhereClause',
      callback: async (item: DatabaseTreeItem) => await generateWhereClause(item)
    },
    {
      command: 'postgres-explorer.generateAlterColumnScript',
      callback: async (item: DatabaseTreeItem) => await generateAlterColumnScript(item)
    },
    {
      command: 'postgres-explorer.generateDropColumnScript',
      callback: async (item: DatabaseTreeItem) => await generateDropColumnScript(item)
    },
    {
      command: 'postgres-explorer.generateRenameColumnScript',
      callback: async (item: DatabaseTreeItem) => await generateRenameColumnScript(item)
    },
    {
      command: 'postgres-explorer.addColumnComment',
      callback: async (item: DatabaseTreeItem) => await addColumnComment(item)
    },
    {
      command: 'postgres-explorer.generateIndexOnColumn',
      callback: async (item: DatabaseTreeItem) => await generateIndexOnColumn(item)
    },
    {
      command: 'postgres-explorer.viewColumnStatistics',
      callback: async (item: DatabaseTreeItem) => await viewColumnStatistics(item)
    },

    // Constraint commands
    {
      command: 'postgres-explorer.showConstraintProperties',
      callback: async (item: DatabaseTreeItem) => await showConstraintProperties(item)
    },
    {
      command: 'postgres-explorer.copyConstraintName',
      callback: async (item: DatabaseTreeItem) => await copyConstraintName(item)
    },
    {
      command: 'postgres-explorer.generateDropConstraintScript',
      callback: async (item: DatabaseTreeItem) => await generateDropConstraintScript(item)
    },
    {
      command: 'postgres-explorer.generateAlterConstraintScript',
      callback: async (item: DatabaseTreeItem) => await generateAlterConstraintScript(item)
    },
    {
      command: 'postgres-explorer.validateConstraint',
      callback: async (item: DatabaseTreeItem) => await validateConstraint(item)
    },
    {
      command: 'postgres-explorer.generateAddConstraintScript',
      callback: async (item: DatabaseTreeItem) => await generateAddConstraintScript(item)
    },
    {
      command: 'postgres-explorer.viewConstraintDependencies',
      callback: async (item: DatabaseTreeItem) => await viewConstraintDependencies(item)
    },
    {
      command: 'postgres-explorer.constraintOperations',
      callback: async (item: DatabaseTreeItem) => await cmdConstraintOperations(item, context)
    },

    // Index commands
    {
      command: 'postgres-explorer.showIndexProperties',
      callback: async (item: DatabaseTreeItem) => await showIndexProperties(item)
    },
    {
      command: 'postgres-explorer.copyIndexName',
      callback: async (item: DatabaseTreeItem) => await copyIndexName(item)
    },
    {
      command: 'postgres-explorer.generateDropIndexScript',
      callback: async (item: DatabaseTreeItem) => await generateDropIndexScript(item)
    },
    {
      command: 'postgres-explorer.generateReindexScript',
      callback: async (item: DatabaseTreeItem) => await generateReindexScript(item)
    },
    {
      command: 'postgres-explorer.generateScriptCreate',
      callback: async (item: DatabaseTreeItem) => await generateScriptCreate(item)
    },
    {
      command: 'postgres-explorer.analyzeIndexUsage',
      callback: async (item: DatabaseTreeItem) => await analyzeIndexUsage(item)
    },
    {
      command: 'postgres-explorer.generateAlterIndexScript',
      callback: async (item: DatabaseTreeItem) => await generateAlterIndexScript(item)
    },
    {
      command: 'postgres-explorer.addIndexComment',
      callback: async (item: DatabaseTreeItem) => await addIndexComment(item)
    },
    {
      command: 'postgres-explorer.indexOperations',
      callback: async (item: DatabaseTreeItem) => await cmdIndexOperations(item, context)
    },
    {
      command: 'postgres-explorer.addColumn',
      callback: async (item: DatabaseTreeItem) => await cmdAddColumn(item)
    },
    {
      command: 'postgres-explorer.addConstraint',
      callback: async (item: DatabaseTreeItem) => await cmdAddConstraint(item)
    },
    {
      command: 'postgres-explorer.addIndex',
      callback: async (item: DatabaseTreeItem) => await cmdAddIndex(item)
    },

    // Breadcrumb navigation commands
    {
      command: 'postgres-explorer.switchConnection',
      callback: async () => {
        const editor = ConnectionUtils.getActivePostgresNotebook();
        if (!editor) {
          vscode.window.showWarningMessage('No active PostgreSQL notebook.');
          return;
        }

        const metadata = editor.notebook.metadata as any;
        const selected = await ConnectionUtils.showConnectionPicker(metadata?.connectionId);

        if (selected) {
          await ConnectionUtils.updateNotebookMetadata(editor.notebook, {
            connectionId: selected.id,
            databaseName: selected.database,
            host: selected.host,
            port: selected.port,
            username: selected.username
          });
          await WorkspaceStateService.getInstance().recordConnectionSwitch(selected.id, selected.database);
          vscode.window.showInformationMessage(`Switched to: ${selected.name || selected.host}`);
        }
      }
    },
    {
      command: 'postgres-explorer.showConnectionSafety',
      callback: showConnectionSafety
    },
    {
      command: 'postgres-explorer.revealInExplorer',
      callback: () => revealInExplorer(databaseTreeProvider)
    },
    {
      command: 'postgres-explorer.navigateBreadcrumb',
      callback: async (args: { type: string; connectionId?: string; database?: string; schema?: string; object?: string }) => {
        // Reveal the item in the database tree based on breadcrumb segment
        if (args?.type === 'connection' && args.connectionId) {
          // Focus database explorer and reveal connection
          await vscode.commands.executeCommand('postgresExplorer.focus');
        }
        // Future: could expand tree to specific schema/table
      }
    },
    {
      command: 'postgres-explorer.copyBreadcrumbPath',
      callback: async (args: { connectionName?: string; database?: string; schema?: string; object?: string }) => {
        const parts = [
          args?.connectionName,
          args?.database,
          args?.schema,
          args?.object
        ].filter(Boolean);

        if (parts.length > 0) {
          const path = parts.join(' ▸ ');
          await vscode.env.clipboard.writeText(path);
          vscode.window.showInformationMessage('Breadcrumb path copied to clipboard');
        }
      }
    },
    {
      command: 'postgres-explorer.switchDatabase',
      callback: async () => {
        const editor = ConnectionUtils.getActivePostgresNotebook();
        if (!editor) {
          vscode.window.showWarningMessage('No active PostgreSQL notebook.');
          return;
        }

        const metadata = editor.notebook.metadata as any;
        if (!metadata?.connectionId) {
          vscode.window.showWarningMessage('No connection configured for this notebook.');
          return;
        }

        const connection = ConnectionUtils.findConnection(metadata.connectionId);
        if (!connection) {
          vscode.window.showErrorMessage('Connection not found.');
          return;
        }

        const selectedDb = await ConnectionUtils.showDatabasePicker(connection, metadata.databaseName);

        if (selectedDb && selectedDb !== metadata.databaseName) {
          await ConnectionUtils.updateNotebookMetadata(editor.notebook, { databaseName: selectedDb });
          await WorkspaceStateService.getInstance().recordDatabaseSwitch(metadata.connectionId, selectedDb);
          vscode.window.showInformationMessage(`Switched to database: ${selectedDb}`);
        }
      }
    },
    {
      command: 'postgres-explorer.switchWorkspaceDefaultConnection',
      callback: () => switchWorkspaceDefaultConnection()
    },
    // Phase 7: Connection Profiles
    {
      command: 'postgres-explorer.switchConnectionProfile',
      callback: () => switchConnectionProfile()
    },
    {
      command: 'postgres-explorer.createConnectionProfile',
      callback: () => createConnectionProfile()
    },
    {
      command: 'postgres-explorer.deleteConnectionProfile',
      callback: () => deleteConnectionProfile()
    },
    // Phase 7: Saved Queries
    {
      command: 'postgres-explorer.saveQueryToLibrary',
      callback: () => saveQueryToLibrary()
    },
    {
      command: 'postgres-explorer.loadSavedQuery',
      callback: () => loadSavedQuery()
    },
    {
      command: 'postgres-explorer.exportSavedQueries',
      callback: () => exportSavedQueries()
    },
    {
      command: 'postgres-explorer.importSavedQueries',
      callback: () => importSavedQueries()
    },
    {
      command: 'postgres-explorer.searchSavedQueries',
      callback: () => searchSavedQueries()
    },
    {
      command: 'postgres-explorer.showQueryRecommendations',
      callback: () => showQueryRecommendations()
    },
    {
      command: 'postgres-explorer.saveQueryToLibraryUI',
      callback: () => saveQueryToLibraryUI()
    },
    {
      command: 'postgres-explorer.viewSavedQuery',
      callback: (query: any) => viewSavedQuery(query)
    },
    {
      command: 'postgres-explorer.copySavedQuery',
      callback: (query: any) => copySavedQuery(query)
    },
    {
      command: 'postgres-explorer.editSavedQuery',
      callback: (query: any) => editSavedQuery(query)
    },
    {
      command: 'postgres-explorer.openSavedQueryInNotebook',
      callback: (query: any) => openSavedQueryInNotebook(query)
    },
    {
      command: 'postgres-explorer.deleteSavedQuery',
      callback: (query: any) => deleteSavedQuery(query)
    },
    {
      command: 'postgres-explorer.loadSavedQueryUI',
      callback: () => loadSavedQueryUI()
    },

    // Visual Schema Design (Phase 7 Roadmap)
    {
      command: 'postgres-explorer.openTableDesigner',
      callback: (item: DatabaseTreeItem) => cmdOpenTableDesigner(item, context)
    },
    {
      command: 'postgres-explorer.openRoleDesigner',
      callback: (item: DatabaseTreeItem) => cmdOpenRoleDesigner(item, context)
    },
    {
      command: 'postgres-explorer.createTableVisual',
      callback: (item: DatabaseTreeItem) => cmdCreateTableVisual(item, context)
    },
    {
      command: 'postgres-explorer.openSchemaDiff',
      callback: (item: DatabaseTreeItem) => cmdOpenSchemaDiff(item, context)
    },
    {
      command: 'postgres-explorer.openSchemaDiffFromPalette',
      callback: () => cmdOpenSchemaDiffFromPalette(context)
    },
    // D2: ERD
    {
      command: 'postgres-explorer.openErd',
      callback: (item: DatabaseTreeItem) => cmdOpenErd(item, context)
    },
    {
      command: 'postgres-explorer.openErdMulti',
      callback: (item: DatabaseTreeItem) => cmdOpenErdMultiFromDatabase(item, context)
    },
    {
      command: 'postgres-explorer.importDbml',
      callback: (item?: DatabaseTreeItem) => cmdImportDbml(item, context)
    },
    // Import Data
    {
      command: 'postgres-explorer.importData',
      callback: (item: DatabaseTreeItem) => cmdImportData(item, context)
    },
    // D3: Profile export/import
    {
      command: 'postgres-explorer.exportConnectionProfiles',
      callback: () => exportConnectionProfiles()
    },
    {
      command: 'postgres-explorer.importConnectionProfiles',
      callback: () => importConnectionProfiles()
    },
    {
      command: 'postgres-explorer.viewMaintenanceVacuum',
      callback: async () => {
        vscode.window.showInformationMessage('VACUUM is not applicable to regular views. Use this on tables or materialized views.');
      }
    },
    {
      command: 'postgres-explorer.viewMaintenanceAnalyze',
      callback: async () => {
        vscode.window.showInformationMessage('ANALYZE is not applicable to regular views. Use this on tables or materialized views.');
      }
    },

    // Phase 2: Triggers
    { command: 'postgres-explorer.listTriggers', callback: async (item: DatabaseTreeItem) => await cmdListTriggers(item, context) },
    { command: 'postgres-explorer.createTrigger', callback: async (item: DatabaseTreeItem) => await cmdCreateTrigger(item, context) },
    { command: 'postgres-explorer.dropTrigger', callback: async (item: DatabaseTreeItem) => await cmdDropTrigger(item, context) },
    { command: 'postgres-explorer.enableTrigger', callback: async (item: DatabaseTreeItem) => await cmdEnableTrigger(item, context) },
    { command: 'postgres-explorer.disableTrigger', callback: async (item: DatabaseTreeItem) => await cmdDisableTrigger(item, context) },
    { command: 'postgres-explorer.showTriggerProperties', callback: async (item: DatabaseTreeItem) => await cmdShowTriggerProperties(item, context) },
    { command: 'postgres-explorer.triggerOperations', callback: async (item: DatabaseTreeItem) => await cmdTriggerOperations(item, context) },

    // Phase 2: Sequences
    { command: 'postgres-explorer.listSequences', callback: async (item: DatabaseTreeItem) => await cmdListSequences(item, context) },
    { command: 'postgres-explorer.createSequence', callback: async (item: DatabaseTreeItem) => await cmdCreateSequence(item, context) },
    { command: 'postgres-explorer.dropSequence', callback: async (item: DatabaseTreeItem) => await cmdDropSequence(item, context) },
    { command: 'postgres-explorer.sequenceNextValue', callback: async (item: DatabaseTreeItem) => await cmdSequenceNextValue(item, context) },
    { command: 'postgres-explorer.showSequenceProperties', callback: async (item: DatabaseTreeItem) => await cmdShowSequenceProperties(item, context) },
    { command: 'postgres-explorer.sequenceOperations', callback: async (item: DatabaseTreeItem) => await cmdSequenceOperations(item, context) },

    // Phase 2: Partitions
    { command: 'postgres-explorer.listPartitions', callback: async (item: DatabaseTreeItem) => await cmdListPartitions(item, context) },
    { command: 'postgres-explorer.detachPartition', callback: async (item: DatabaseTreeItem) => await cmdDetachPartition(item, context) },
    { command: 'postgres-explorer.showPartitionProperties', callback: async (item: DatabaseTreeItem) => await cmdShowPartitionProperties(item, context) },
    { command: 'postgres-explorer.createPartition', callback: async (item: DatabaseTreeItem) => await cmdCreatePartition(item, context) },

    // Phase 2: Domains
    { command: 'postgres-explorer.listDomains', callback: async (item: DatabaseTreeItem) => await cmdListDomains(item, context) },
    { command: 'postgres-explorer.createDomain', callback: async (item: DatabaseTreeItem) => await cmdCreateDomain(item, context) },
    { command: 'postgres-explorer.dropDomain', callback: async (item: DatabaseTreeItem) => await cmdDropDomain(item, context) },
    { command: 'postgres-explorer.showDomainProperties', callback: async (item: DatabaseTreeItem) => await cmdShowDomainProperties(item, context) },

    // Phase 2: Aggregates
    { command: 'postgres-explorer.listAggregates', callback: async (item: DatabaseTreeItem) => await cmdListAggregates(item, context) },
    { command: 'postgres-explorer.createAggregate', callback: async (item: DatabaseTreeItem) => await cmdCreateAggregate(item, context) },
    { command: 'postgres-explorer.dropAggregate', callback: async (item: DatabaseTreeItem) => await cmdDropAggregate(item, context) },
    { command: 'postgres-explorer.showAggregateProperties', callback: async (item: DatabaseTreeItem) => await cmdShowAggregateProperties(item, context) },

    // Phase 2: Event Triggers
    { command: 'postgres-explorer.listEventTriggers', callback: async (item: DatabaseTreeItem) => await cmdListEventTriggers(item, context) },
    { command: 'postgres-explorer.createEventTrigger', callback: async (item: DatabaseTreeItem) => await cmdCreateEventTrigger(item, context) },
    { command: 'postgres-explorer.dropEventTrigger', callback: async (item: DatabaseTreeItem) => await cmdDropEventTrigger(item, context) },
    { command: 'postgres-explorer.enableEventTrigger', callback: async (item: DatabaseTreeItem) => await cmdEnableEventTrigger(item, context) },
    { command: 'postgres-explorer.disableEventTrigger', callback: async (item: DatabaseTreeItem) => await cmdDisableEventTrigger(item, context) },
    { command: 'postgres-explorer.showEventTriggerProperties', callback: async (item: DatabaseTreeItem) => await cmdShowEventTriggerProperties(item, context) },
    { command: 'postgres-explorer.eventTriggerOperations', callback: async (item: DatabaseTreeItem) => await cmdEventTriggerOperations(item, context) },
    { command: 'postgres-explorer.listCronJobs', callback: async (item: DatabaseTreeItem) => await cmdListCronJobs(item, context) },
    { command: 'postgres-explorer.installPgCron', callback: async (item: DatabaseTreeItem) => await cmdInstallPgCron(item, context) },
    { command: 'postgres-explorer.scheduleCronJob', callback: async (item: DatabaseTreeItem) => await cmdScheduleCronJob(item, context) },
    { command: 'postgres-explorer.showCronJobProperties', callback: async (item: DatabaseTreeItem) => await cmdShowCronJobProperties(item, context) },
    { command: 'postgres-explorer.unscheduleCronJob', callback: async (item: DatabaseTreeItem) => await cmdUnscheduleCronJob(item, context) },

    // Phase 2: Rules
    { command: 'postgres-explorer.listRules', callback: async (item: DatabaseTreeItem) => await cmdListRules(item, context) },
    { command: 'postgres-explorer.dropRule', callback: async (item: DatabaseTreeItem) => await cmdDropRule(item, context) },
    { command: 'postgres-explorer.showRuleProperties', callback: async (item: DatabaseTreeItem) => await cmdShowRuleProperties(item, context) },
    { command: 'postgres-explorer.ruleOperations', callback: async (item: DatabaseTreeItem) => await cmdRuleOperations(item, context) },

    // Phase 2: Tablespaces
    { command: 'postgres-explorer.listTablespaces', callback: async (item: DatabaseTreeItem) => await cmdListTablespaces(item, context) },
    { command: 'postgres-explorer.showTablespaceProperties', callback: async (item: DatabaseTreeItem) => await cmdShowTablespaceProperties(item, context) },
    { command: 'postgres-explorer.tablespaceOperations', callback: async (item: DatabaseTreeItem) => await cmdTablespaceOperations(item, context) },

    // Phase 2: Publications & Subscriptions
    { command: 'postgres-explorer.listPublications', callback: async (item: DatabaseTreeItem) => await cmdListPublications(item, context) },
    { command: 'postgres-explorer.createPublication', callback: async (item: DatabaseTreeItem) => await cmdCreatePublication(item, context) },
    { command: 'postgres-explorer.dropPublication', callback: async (item: DatabaseTreeItem) => await cmdDropPublication(item, context) },
    { command: 'postgres-explorer.showPublicationProperties', callback: async (item: DatabaseTreeItem) => await cmdShowPublicationProperties(item, context) },
    { command: 'postgres-explorer.publicationOperations', callback: async (item: DatabaseTreeItem) => await cmdPublicationOperations(item, context) },
    { command: 'postgres-explorer.listSubscriptions', callback: async (item: DatabaseTreeItem) => await cmdListSubscriptions(item, context) },
    { command: 'postgres-explorer.dropSubscription', callback: async (item: DatabaseTreeItem) => await cmdDropSubscription(item, context) },
    { command: 'postgres-explorer.dropPolicy', callback: async (item: DatabaseTreeItem) => await cmdDropPolicy(item, context) },
    { command: 'postgres-explorer.createPolicy', callback: async (item: DatabaseTreeItem) => await cmdCreatePolicy(item, context) },
    { command: 'postgres-explorer.showSubscriptionProperties', callback: async (item: DatabaseTreeItem) => await cmdShowSubscriptionProperties(item, context) },

    // Phase 2: Schema Search
    { command: 'postgres-explorer.searchSchema', callback: async () => await cmdSearchSchema() },

    // Database Index Grounding Commands
    {
      command: 'postgres-explorer.dbindex.openPanel',
      callback: async () => {
        const { DbIndexPanel } = await import('../features/dbindex/panel/DbIndexPanel');
        await DbIndexPanel.show(context.extensionUri, context);
      }
    },
    {
      command: 'postgres-explorer.dbindex.build',
      callback: async (item?: DatabaseTreeItem) => {
        const { IndexBuilder } = await import('../features/dbindex/IndexBuilder');
        const { IndexStore } = await import('../features/dbindex/IndexStore');
        const { runGuidedBuildWizard } = await import('../features/dbindex/buildWizard');
        const store = new IndexStore(context.globalStorageUri);
        const builder = new IndexBuilder(store);
        const preselected = item && item.connectionId && item.databaseName ? {
          connectionId: item.connectionId,
          databaseName: item.databaseName
        } : undefined;
        await runGuidedBuildWizard(context, builder, outputChannel, preselected);
      }
    },
    {
      command: 'postgres-explorer.dbindex.clear',
      callback: async () => {
        const { IndexStore } = await import('../features/dbindex/IndexStore');
        const store = new IndexStore(context.globalStorageUri);
        const connection = await ConnectionUtils.showConnectionPicker(undefined, {
          title: 'Clear Database Index',
          placeHolder: 'Select a connection',
        });
        if (!connection) return;
        const database = await ConnectionUtils.showDatabasePicker(connection, undefined, {
          title: 'Clear Database Index',
          placeHolder: 'Select a database',
        });
        if (!database) return;
        
        const confirm = await vscode.window.showWarningMessage(
          `Are you sure you want to delete the local index for "${database}"?`,
          'Delete'
        );
        if (confirm === 'Delete') {
          await store.clearIndex(connection.id, database);
          vscode.window.showInformationMessage(`Index cleared for "${database}".`);
        }
      }
    },
    {
      command: 'postgres-explorer.dbindex.updateBackground',
      callback: async (connectionId: string, database: string) => {
        const { IndexBuilder } = await import('../features/dbindex/IndexBuilder');
        const { IndexStore } = await import('../features/dbindex/IndexStore');
        const store = new IndexStore(context.globalStorageUri);
        const baseDir = store.getBaseDir(connectionId, database);
        const manifest = await store.readManifest(baseDir);
        if (!manifest) return; // No index configured

        const builder = new IndexBuilder(store);
        try {
          await builder.build(
            connectionId,
            database,
            manifest.scope,
            manifest.buildDepth,
            'auto',
            manifest.environment,
          );
          outputChannel.appendLine(`[AutoRefresh] Background index rebuild complete for ${database}.`);
        } catch (err: any) {
          outputChannel.appendLine(`[AutoRefresh] Background index rebuild failed: ${err.message || err}`);
        }
      }
    }
  ];

  return commands;
}
