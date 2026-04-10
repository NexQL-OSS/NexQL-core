import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { DatabaseTreeProvider } from '../providers/DatabaseTreeProvider';
import { QueryHistoryService } from '../services/QueryHistoryService';
import { ChatViewProvider } from '../providers/ChatViewProvider';

import { cmdAiAssist } from '../commands/aiAssist';
import { showColumnProperties, copyColumnName, copyColumnNameQuoted, generateSelectStatement, generateWhereClause, generateAlterColumnScript, generateDropColumnScript, generateRenameColumnScript, addColumnComment, generateIndexOnColumn, viewColumnStatistics, cmdAddColumn } from '../commands/columns';
import { showConstraintProperties, copyConstraintName, generateDropConstraintScript, generateAlterConstraintScript, validateConstraint, generateAddConstraintScript, viewConstraintDependencies, cmdConstraintOperations, cmdAddConstraint } from '../commands/constraints';
import { cmdConnectDatabase, cmdDisconnectConnection, cmdDisconnectDatabase, cmdReconnectConnection, showConnectionSafety, revealInExplorer } from '../commands/connection';
import { showIndexProperties, copyIndexName, generateDropIndexScript, generateReindexScript, generateScriptCreate, analyzeIndexUsage, generateAlterIndexScript, addIndexComment, cmdIndexOperations, cmdAddIndex } from '../commands/indexes';
import { cmdAddObjectInDatabase, cmdBackupDatabase, cmdCreateDatabase, cmdDatabaseDashboard, cmdDatabaseOperations, cmdDeleteDatabase, cmdDisconnectDatabase as cmdDisconnectDatabaseLegacy, cmdGenerateCreateScript, cmdMaintenanceDatabase, cmdPsqlTool, cmdQueryTool, cmdRestoreDatabase, cmdScriptAlterDatabase, cmdShowConfiguration } from '../commands/database';
import { cmdDropExtension, cmdEnableExtension, cmdExtensionOperations, cmdRefreshExtension } from '../commands/extensions';
import { cmdCreateForeignTable, cmdDropForeignTable, cmdEditForeignTable, cmdForeignTableOperations, cmdRefreshForeignTable, cmdShowForeignTableProperties, cmdViewForeignTableData } from '../commands/foreignTables';
import { cmdForeignDataWrapperOperations, cmdShowForeignDataWrapperProperties, cmdCreateForeignServer, cmdForeignServerOperations, cmdShowForeignServerProperties, cmdDropForeignServer, cmdCreateUserMapping, cmdUserMappingOperations, cmdShowUserMappingProperties, cmdDropUserMapping, cmdRefreshForeignDataWrapper, cmdRefreshForeignServer, cmdRefreshUserMapping } from '../commands/foreignDataWrappers';
import { cmdCallFunction, cmdCreateFunction, cmdDropFunction, cmdEditFunction, cmdFunctionOperations, cmdRefreshFunction, cmdShowFunctionProperties } from '../commands/functions';
import { cmdCreateMaterializedView, cmdDropMatView, cmdEditMatView, cmdMatViewOperations, cmdRefreshMatView, cmdViewMatViewData, cmdViewMatViewProperties } from '../commands/materializedViews';
import { cmdNewNotebook, cmdExplainQuery, cmdJumpToSection } from '../commands/notebook';
import { cmdCreateObjectInSchema, cmdCreateSchema, cmdSchemaOperations, cmdShowSchemaProperties, cmdPasteTable } from '../commands/schema';
import {
  cmdCreateTable, cmdDropTable, cmdEditTable, cmdInsertTable, cmdMaintenanceAnalyze, cmdMaintenanceReindex, cmdMaintenanceVacuum, cmdScriptCreate, cmdScriptDelete, cmdScriptInsert, cmdScriptSelect, cmdScriptUpdate, cmdShowTableProperties, cmdTableOperations, cmdTruncateTable, cmdUpdateTable, cmdViewTableData, cmdTableProfile, cmdTableActivity, cmdQuickCloneTable, cmdExportTable, cmdIndexUsage, cmdTableDefinition
} from '../commands/tables';
import { cmdAllOperationsTypes, cmdCreateType, cmdDropType, cmdEditTypes, cmdRefreshType, cmdShowTypeProperties } from '../commands/types';
import { cmdAddRole, cmdAddUser, cmdDropRole, cmdEditRole, cmdGrantRevokeRole, cmdRefreshRole, cmdRoleOperations, cmdShowRoleProperties } from '../commands/usersRoles';
import { cmdCreateView, cmdDropView, cmdEditView, cmdRefreshView, cmdScriptCreate as cmdViewScriptCreate, cmdScriptSelect as cmdViewScriptSelect, cmdShowViewProperties, cmdViewData, cmdViewOperations } from '../commands/views';

import { AiSettingsPanel } from '../aiSettingsPanel';
import { ConnectionFormPanel } from '../connectionForm';
import { ConnectionManagementPanel } from '../connectionManagement';
import { ConnectionUtils } from '../utils/connectionUtils';

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
  showQueryRecommendations
} from '../commands/phase7';
import { SavedQueriesTreeProvider } from '../providers/Phase7TreeProviders';
import { pickQueryHistory } from '../commands/pickQueryHistory';

// Visual Schema Design
import { cmdOpenTableDesigner, cmdCreateTableVisual, cmdOpenSchemaDiff } from '../commands/schemaDesigner';
import { NotebookTreeItem, NotebooksTreeProvider } from '../providers/NotebooksTreeProvider';

export function registerAllCommands(
  context: vscode.ExtensionContext,
  databaseTreeProvider: DatabaseTreeProvider,
  chatViewProviderInstance: ChatViewProvider | undefined,
  outputChannel: vscode.OutputChannel,
  savedQueriesTreeProvider?: SavedQueriesTreeProvider,
  notebooksTreeProvider?: NotebooksTreeProvider
) {
  const commands = [
    {
      command: 'postgres-explorer.addConnection',
      callback: () => {
        // Explicitly pass undefined to force "Add" mode, ignoring any arguments VS Code might pass
        ConnectionFormPanel.show(context.extensionUri, context, undefined);
      }
    },
    {
      command: 'postgres-explorer.editConnection',
      callback: (item: DatabaseTreeItem) => {
        if (!item || !item.connectionId) return;
        const connection = ConnectionUtils.findConnection(item.connectionId);
        if (connection) {
          ConnectionFormPanel.show(context.extensionUri, context, connection);
        }
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
        ConnectionManagementPanel.show(context.extensionUri, context);
      }
    },
    {
      command: 'postgres-explorer.aiSettings',
      callback: () => {
        AiSettingsPanel.show(context.extensionUri, context);
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
      callback: async (item: any) => await cmdNewNotebook(item)
    },
    {
      command: 'postgres-explorer.jumpToSection',
      callback: async () => await cmdJumpToSection()
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
        notebooksTreeProvider?.refresh();
      }
    },
    {
      command: 'postgres-explorer.notebooks.delete',
      callback: async (item: NotebookTreeItem) => {
        if (!item?.uri) { return; }
        const confirm = await vscode.window.showWarningMessage(
          `Delete "${item.label as string}.pgsql"? This cannot be undone.`,
          { modal: true }, 'Delete'
        );
        if (confirm !== 'Delete') { return; }
        await vscode.workspace.fs.delete(item.uri, { recursive: false });
        notebooksTreeProvider?.refresh();
      }
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
      command: 'postgres-explorer.backupDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdBackupDatabase(item, context)
    },
    {
      command: 'postgres-explorer.restoreDatabase',
      callback: async (item: DatabaseTreeItem) => await cmdRestoreDatabase(item, context)
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
          vscode.window.showInformationMessage(`Switched to database: ${selectedDb}`);
        }
      }
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
      command: 'postgres-explorer.createTableVisual',
      callback: (item: DatabaseTreeItem) => cmdCreateTableVisual(item, context)
    },
    {
      command: 'postgres-explorer.openSchemaDiff',
      callback: (item: DatabaseTreeItem) => cmdOpenSchemaDiff(item, context)
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
  ];

  console.log('Starting command registration...');
  outputChannel.appendLine('Starting command registration...');

  commands.forEach(({ command, callback }) => {
    try {
      console.log(`Registering command: ${command}`);
      context.subscriptions.push(
        vscode.commands.registerCommand(command, callback)
      );
    } catch (e) {
      console.error(`Failed to register command ${command}:`, e);
      outputChannel.appendLine(`Failed to register command ${command}: ${e}`);
    }
  });

  // Phase 7: Register refresh commands for tree views
  context.subscriptions.push(
    vscode.commands.registerCommand('postgresExplorer.savedQueries.refresh', () => {
      if (savedQueriesTreeProvider) {
        savedQueriesTreeProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('postgres-explorer.pasteTable', (item) => cmdPasteTable(item, context))
  );

  outputChannel.appendLine('All commands registered successfully.');
}
