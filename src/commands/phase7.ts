import * as vscode from 'vscode';
import { ChatViewProvider } from '../providers/ChatViewProvider';
import { ProfileManager, ConnectionProfile } from '../features/connections/ProfileManager';
import { SavedQueriesService, SavedQuery } from '../features/savedQueries/SavedQueriesService';
import { QueryAnalyzer } from '../services/QueryAnalyzer';
import { ErrorService } from '../services/ErrorService';
import { extensionContext, statusBar } from '../extension';
import { SaveQueryPanel } from '../features/savedQueries/SaveQueryPanel';
import { SavedQueryDetailsPanel } from '../features/savedQueries/SavedQueryDetailsPanel';
import { ConnectionUtils } from '../utils/connectionUtils';
import { SecretStorageService } from '../services/SecretStorageService';

/**
 * Phase 7 Advanced Power User & AI commands
 * - Connection profiles (presets for roles)
 * - Saved queries (reusable query library)
 * - Performance-driven AI analysis
 */

/**
 * Helper to refresh tree views and status bar after profile changes
 */
function refreshPhase7TreeViews(): void {
  vscode.commands.executeCommand('postgresExplorer.savedQueries.refresh');
  // Update status bar to immediately reflect profile change
  if (statusBar) {
    statusBar.update();
  }
}

/**
 * Load default profile from connection config
 * If the connection has a profileId set, apply that profile to the notebook
 */
export async function loadDefaultProfileFromConnection(): Promise<void> {
  const activeEditor = vscode.window.activeNotebookEditor;
  if (!activeEditor) {
    return;
  }

  const notebook = activeEditor.notebook;
  const metadata = notebook.metadata as any;

  if (!metadata?.connectionId) {
    return;
  }

  // Check if a default profile is already set in globalState for this notebook
  const notebookKey = `activeProfile-${notebook.uri.toString()}`;
  const existingProfile = extensionContext?.globalState.get<any>(notebookKey);
  if (existingProfile) {
    return; // Profile already set, don't override
  }

  // Get the connection and check for a default profileId
  const connections = vscode.workspace.getConfiguration().get<any[]>('postgresExplorer.connections') || [];
  const connection = connections.find(c => c.id === metadata.connectionId);
  
  if (!connection?.profileId) {
    return; // No default profile set in connection config
  }

  // Find the profile
  const profileManager = ProfileManager.getInstance();
  const profile = profileManager.getProfiles().find(p => p.id === connection.profileId);
  
  if (!profile) {
    return; // Profile not found
  }

  // Apply the default profile
  const profileContext = {
    profileId: profile.id,
    readOnlyMode: profile.rolePresets?.forceReadOnly ?? false,
    autoLimitSelectResults: profile.rolePresets?.autoLimitSelectResults ?? 0,
    autoApplySafetyCheck: profile.rolePresets?.autoApplySafetyCheck ?? true,
  };

  await extensionContext.globalState.update(notebookKey, profileContext);
  refreshPhase7TreeViews();
}

/**
 * Switch to a connection profile
 */
export async function switchConnectionProfile(): Promise<void> {
  const profileManager = ProfileManager.getInstance();
  const profiles = profileManager.getProfiles();

  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No connection profiles available. Create one first.');
    return;
  }

  const items = profiles.map((p) => ({
    label: p.profileName || p.name || `${p.host}:${p.port}`,
    description: p.description || `${p.host}:${p.port}`,
    profile: p,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a connection profile to switch to',
    matchOnDescription: true,
  });

  if (selected) {
    // Get active notebook editor
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor) {
      vscode.window.showWarningMessage('No active notebook. Open a .pgsql notebook first.');
      return;
    }

    const notebook = activeEditor.notebook;
    const metadata = notebook.metadata as any;

    if (!metadata?.connectionId) {
      vscode.window.showWarningMessage('Notebook has no connection configured.');
      return;
    }

    // Store active profile context in extension globalState
    // Use notebook URI as key to allow different notebooks to have different active profiles
    const notebookKey = `activeProfile-${notebook.uri.toString()}`;
    const profile = selected.profile;
    
    const profileContext = {
      profileId: profile.id,
      readOnlyMode: profile.rolePresets?.forceReadOnly ?? false,
      autoLimitSelectResults: profile.rolePresets?.autoLimitSelectResults ?? 0,
      autoApplySafetyCheck: profile.rolePresets?.autoApplySafetyCheck ?? true,
    };

    await extensionContext.globalState.update(notebookKey, profileContext);

    // Build a detailed message about the active profile settings
    const settings: string[] = [];
    if (profileContext.readOnlyMode) settings.push('🔒 Read-Only (writes blocked)');
    if (profileContext.autoLimitSelectResults > 0) settings.push(`📊 Auto-Limit: ${profileContext.autoLimitSelectResults} rows`);
    if (profileContext.autoApplySafetyCheck) settings.push('⚠️ Safety checks enabled');

    const settingsText = settings.length > 0 ? `\n\nActive settings:\n${settings.join('\n')}` : '\nNo special constraints';

    vscode.window.showInformationMessage(
      `✓ Switched to profile: ${selected.label}${settingsText}`
    );
    refreshPhase7TreeViews();
  }
}

/**
 * Create a new connection profile
 */
export async function createConnectionProfile(): Promise<void> {
  const profileName = await vscode.window.showInputBox({
    prompt: 'Enter profile name (e.g., "Read-Only Analyst")',
    placeHolder: 'Profile Name',
  });

  if (!profileName) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: 'Enter profile description (optional)',
    placeHolder: 'e.g., Safe read-only access for data analysts',
  });

  const hostStr = await vscode.window.showInputBox({
    prompt: 'Enter database host',
    placeHolder: 'localhost',
  });

  const host = hostStr || 'localhost';

  const portStr = await vscode.window.showInputBox({
    prompt: 'Enter database port',
    placeHolder: '5432',
  });

  const port = parseInt(portStr || '5432', 10);

  const forceReadOnly = await vscode.window.showQuickPick(
    ['Yes', 'No'],
    { placeHolder: 'Force read-only mode for this profile?' }
  );

  const profile: ConnectionProfile = {
    id: `profile_${Date.now()}`,
    host,
    port,
    profileName,
    description,
    readOnlyMode: forceReadOnly === 'Yes',
    rolePresets: {
      forceReadOnly: forceReadOnly === 'Yes',
      autoApplySafetyCheck: true,
      autoLimitSelectResults: forceReadOnly === 'Yes' ? 1000 : 0,
    },
  };

  const profileManager = ProfileManager.getInstance();
  await profileManager.createProfile(profile);
  refreshPhase7TreeViews();
  vscode.window.showInformationMessage(`Profile created: ${profileName}`);
}

/**
 * Delete a connection profile
 */
export async function deleteConnectionProfile(): Promise<void> {
  const profileManager = ProfileManager.getInstance();
  const profiles = profileManager.getProfiles();

  if (profiles.length === 0) {
    vscode.window.showWarningMessage('No profiles to delete.');
    return;
  }

  const items = profiles.map((p) => ({
    label: p.profileName || p.name || `${p.host}:${p.port}`,
    description: p.description || '',
    profile: p,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a profile to delete',
  });

  if (selected) {
    const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
      placeHolder: `Delete profile "${selected.label}"?`,
    });

    if (confirm === 'Yes') {
      await profileManager.deleteProfile(selected.profile.id);
      refreshPhase7TreeViews();
      vscode.window.showInformationMessage(`Profile deleted: ${selected.label}`);
    }
  }
}

/**
 * Save current query to library
 */
export async function saveQueryToLibrary(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('No active editor. Open a SQL file first.');
    return;
  }

  const query = editor.document.getText();
  if (!query.trim()) {
    vscode.window.showWarningMessage('Editor is empty.');
    return;
  }

  const title = await vscode.window.showInputBox({
    prompt: 'Give this query a title',
    placeHolder: 'e.g., "Active Users Report"',
  });

  if (!title) {
    return;
  }

  const description = await vscode.window.showInputBox({
    prompt: 'Optional description',
    placeHolder: 'What does this query do?',
  });

  const tagsStr = await vscode.window.showInputBox({
    prompt: 'Tags (comma-separated, optional)',
    placeHolder: 'e.g., analytics, reporting, maintenance',
  });

  const tags = tagsStr
    ? tagsStr.split(',').map((t) => t.trim()).filter((t) => t)
    : undefined;

  const savedQuery: SavedQuery = {
    id: `query_${Date.now()}`,
    title,
    query,
    description,
    tags,
    createdAt: Date.now(),
    usageCount: 0,
  };

  const service = SavedQueriesService.getInstance();
  await service.saveQuery(savedQuery);
  refreshPhase7TreeViews();
  vscode.window.showInformationMessage(`Query saved: "${title}"`);
}

/**
 * Load a saved query
 */
export async function loadSavedQuery(): Promise<void> {
  const service = SavedQueriesService.getInstance();
  const queries = service.getQueries();

  if (queries.length === 0) {
    vscode.window.showInformationMessage('No saved queries yet.');
    return;
  }

  const items = queries.map((q) => ({
    label: q.title,
    description: q.description || `Created: ${new Date(q.createdAt).toLocaleDateString()}`,
    detail: `Used ${q.usageCount} times${q.tags?.length ? ` • Tags: ${q.tags.join(', ')}` : ''}`,
    query: q,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a query to load',
    matchOnDescription: true,
  });

  if (selected) {
    // Record usage
    await service.recordUsage(selected.query.id);

    // Open in new editor using openTextDocument
    const doc = await vscode.workspace.openTextDocument({
      language: 'pgsql',
      content: selected.query.query,
    });
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Copy a saved query to clipboard - context menu action
 */
export async function copySavedQuery(treeItem: any): Promise<void> {
  // Handle both tree item (from context menu) and direct query object
  const query = treeItem?.query || treeItem;
  
  if (!query) {
    vscode.window.showWarningMessage('No query selected.');
    return;
  }

  await vscode.env.clipboard.writeText(query.query);
  vscode.window.showInformationMessage(`✓ Query copied to clipboard: "${query.title}"`);
}

/**
 * Open a saved query in a new notebook with its original connection context
 */
export async function openSavedQueryInNotebook(treeItem: any): Promise<void> {
  // Handle both tree item (from context menu) and direct query object
  const query = treeItem?.query || treeItem;
  
  if (!query) {
    vscode.window.showWarningMessage('No query selected.');
    return;
  }

  try {
    if (!query.connectionId) {
      vscode.window.showWarningMessage('This query does not have a connection context. Please save it again from a notebook.');
      return;
    }

    // Record usage
    const service = SavedQueriesService.getInstance();
    await service.recordUsage(query.id);

    // Fetch the full connection details from config
    const connection = ConnectionUtils.findConnection(query.connectionId);
    if (!connection) {
      vscode.window.showErrorMessage(`Connection "${query.connectionId}" not found. It may have been deleted.`);
      return;
    }

    // Get the stored password from secret storage
    const password = await SecretStorageService.getInstance().getPassword(query.connectionId);

    // Build complete metadata for the notebook
    const metadata = {
      connectionId: query.connectionId,
      databaseName: query.databaseName,
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: password || connection.password,
      custom: {
        cells: [],
        metadata: {
          connectionId: query.connectionId,
          databaseName: query.databaseName,
          schema: query.schemaName,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          enableScripts: true
        }
      }
    };

    // Create notebook with SQL cell containing the query
    const notebookData = new vscode.NotebookData([
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, query.query, 'sql')
    ]);
    notebookData.metadata = metadata;

    // Open notebook in the notebook editor
    const notebook = await vscode.workspace.openNotebookDocument('postgres-notebook', notebookData);
    await vscode.window.showNotebookDocument(notebook);

    vscode.window.showInformationMessage(
      `✓ Opened query: "${query.title}"${
        query.databaseName ? ` (${query.databaseName})` : ''
      }`
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Failed to open query: ${errorMessage}`);
  }
}

/**
 * Delete a saved query - context menu action
 */
export async function deleteSavedQuery(treeItem: any): Promise<void> {
  // Handle both tree item (from context menu) and direct query object
  const query = treeItem?.query || treeItem;
  
  if (!query) {
    vscode.window.showWarningMessage('No query selected.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    `Delete saved query "${query.title}"?`,
    { modal: true },
    'Delete'
  );

  if (confirm === 'Delete') {
    const service = SavedQueriesService.getInstance();
    await service.deleteQuery(query.id);
    vscode.window.showInformationMessage(`✓ Query deleted: "${query.title}"`);
    vscode.commands.executeCommand('postgresExplorer.savedQueries.refresh');
  }
}

/**
 * Edit a saved query - opens the save panel in edit mode
 */
export async function editSavedQuery(treeItem: any): Promise<void> {
  // Handle both tree item (from context menu) and direct query object
  const query = treeItem?.query || treeItem;
  
  if (!query) {
    vscode.window.showWarningMessage('No query selected.');
    return;
  }

  if (!extensionContext) {
    vscode.window.showErrorMessage('Extension context not available.');
    return;
  }

  // Open the save panel in edit mode with the query data
  const connectionMetadata = {
    connectionId: query.connectionId,
    databaseName: query.databaseName,
    schemaName: query.schemaName
  };

  SaveQueryPanel.showForEdit(extensionContext.extensionUri, query, connectionMetadata);
}
async function deleteSavedQueryLegacy(): Promise<void> {
  const service = SavedQueriesService.getInstance();
  const queries = service.getQueries();

  if (queries.length === 0) {
    vscode.window.showInformationMessage('No saved queries to delete.');
    return;
  }

  const items = queries.map((q) => ({
    label: q.title,
    description: q.description || '',
    query: q,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a query to delete',
  });

  if (selected) {
    const confirm = await vscode.window.showQuickPick(['Yes', 'No'], {
      placeHolder: `Delete "${selected.label}"?`,
    });

    if (confirm === 'Yes') {
      await service.deleteQuery(selected.query.id);
      refreshPhase7TreeViews();
      vscode.window.showInformationMessage(`Query deleted: "${selected.label}"`);
    }
  }
}

/**
 * Export saved queries as JSON file
 */
export async function exportSavedQueries(): Promise<void> {
  const service = SavedQueriesService.getInstance();
  const json = service.exportQueries();

  const fileUri = await vscode.window.showSaveDialog({
    filters: { 'JSON Files': ['json'] },
    defaultUri: vscode.Uri.file(
      `saved-queries-${new Date().toISOString().split('T')[0]}.json`
    ),
  });

  if (fileUri) {
    const fs = require('fs').promises;
    await fs.writeFile(fileUri.fsPath, json, 'utf8');
    refreshPhase7TreeViews();
    vscode.window.showInformationMessage(`Queries exported to: ${fileUri.fsPath}`);
  }
}

/**
 * Import saved queries from JSON file
 */
export async function importSavedQueries(): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    filters: { 'JSON Files': ['json'] },
    canSelectMany: false,
  });

  if (!files || files.length === 0) {
    return;
  }

  try {
    const fs = require('fs').promises;
    const content = await fs.readFile(files[0].fsPath, 'utf8');
    const service = SavedQueriesService.getInstance();
    await service.importQueries(content);
    refreshPhase7TreeViews();
    vscode.window.showInformationMessage('Queries imported successfully.');
  } catch (error) {
    ErrorService.getInstance().showError(
      `Failed to import queries: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Search saved queries by text
 */
export async function searchSavedQueries(): Promise<void> {
  const searchText = await vscode.window.showInputBox({
    prompt: 'Search queries by title or description',
    placeHolder: 'e.g., "user report"',
  });

  if (!searchText) {
    return;
  }

  const service = SavedQueriesService.getInstance();
  const results = service.searchQueries(searchText);

  if (results.length === 0) {
    vscode.window.showInformationMessage('No matching queries found.');
    return;
  }

  const items = results.map((q) => ({
    label: q.title,
    description: q.description || '',
    query: q,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a query',
  });

  if (selected) {
    await service.recordUsage(selected.query.id);
    const doc = await vscode.workspace.openTextDocument({
      language: 'pgsql',
      content: selected.query.query,
    });
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Show query recommendations (most used/recent)
 */
export async function showQueryRecommendations(): Promise<void> {
  const service = SavedQueriesService.getInstance();
  const recent = service.getRecentQueries(5);
  const mostUsed = service.getMostUsedQueries(5);

  if (recent.length === 0 && mostUsed.length === 0) {
    vscode.window.showInformationMessage('No saved queries yet.');
    return;
  }

  const items: vscode.QuickPickItem[] = [];

  if (recent.length > 0) {
    items.push(
      { label: '$(history) Recent Queries', kind: vscode.QuickPickItemKind.Separator },
      ...recent.map((q) => ({
        label: q.title,
        description: `${q.usageCount} uses`,
        query: q,
      }))
    );
  }

  if (mostUsed.length > 0) {
    items.push(
      { label: '$(star) Most Used Queries', kind: vscode.QuickPickItemKind.Separator },
      ...mostUsed.map((q) => ({
        label: q.title,
        description: `${q.usageCount} uses`,
        query: q,
      }))
    );
  }

  const selected = await vscode.window.showQuickPick(items as any[], {
    placeHolder: 'Select a recommended query',
  });

  if (selected && 'query' in selected) {
    await service.recordUsage(selected.query.id);
    const doc = await vscode.workspace.openTextDocument({
      language: 'pgsql',
      content: selected.query.query,
    });
    await vscode.window.showTextDocument(doc);
  }
}

/**
 * Save current query to library
 * Opens a webview form for better UX
 */
export async function saveQueryToLibraryUI(): Promise<void> {
  const activeEditor = vscode.window.activeNotebookEditor;
  
  if (!activeEditor) {
    vscode.window.showWarningMessage('No active notebook. Open a .pgsql notebook first.');
    return;
  }

  // Get the currently selected/active cell
  const notebook = activeEditor.notebook;
  const selection = activeEditor.selections[0];
  
  if (!selection) {
    vscode.window.showWarningMessage('No cell selected. Please select a SQL cell first.');
    return;
  }

  // Get the cell at the selection
  const cell = notebook.cellAt(selection.start);
  
  // Only allow SQL cells (not markdown)
  if (cell.kind !== vscode.NotebookCellKind.Code) {
    vscode.window.showWarningMessage('Please select a code cell (SQL query), not a markdown cell.');
    return;
  }

  const queryText = cell.document.getText();

  if (!queryText.trim()) {
    vscode.window.showWarningMessage('The selected cell is empty. Please write a query first.');
    return;
  }

  // Capture connection metadata from the notebook
  const metadata = notebook.metadata as any;
  const connectionMetadata = {
    connectionId: metadata?.connectionId,
    databaseName: metadata?.databaseName,
    schemaName: metadata?.schema
  };

  // Show the save query panel with connection metadata
  if (!extensionContext) {
    vscode.window.showErrorMessage('Extension context not available.');
    return;
  }
  SaveQueryPanel.show(extensionContext.extensionUri, queryText, connectionMetadata);
}

/**
 * View a saved query in detail panel
 * Shows the query, allows copying and deletion
 */
export async function viewSavedQuery(treeItem?: any): Promise<void> {
  // Handle both tree item (from context menu) and direct query object
  let query = treeItem?.query || treeItem;
  
  if (!query) {
    // If no query passed, show a picker
    const service = SavedQueriesService.getInstance();
    const queries = service.getQueries();

    if (queries.length === 0) {
      vscode.window.showInformationMessage('No saved queries yet.');
      return;
    }

    const items = queries.map((q) => ({
      label: q.title,
      description: q.description || `Used ${q.usageCount} times`,
      query: q
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a query to view'
    });

    if (selected) {
      query = selected.query;
    } else {
      return;
    }
  }

  if (query) {
    SavedQueryDetailsPanel.show(vscode.Uri.file(__dirname).with({ scheme: 'file' }).with({ path: vscode.Uri.file(__dirname).fsPath.replace(/src.*/, '') }), query);
  }
}

/**
 * D3: Export connection profiles as a portable JSON bundle.
 * Credentials are stripped — only role preset settings and metadata are exported.
 */
export async function exportConnectionProfiles(): Promise<void> {
  const profileManager = ProfileManager.getInstance();
  const profiles = profileManager.getProfiles();

  if (profiles.length === 0) {
    vscode.window.showInformationMessage('No profiles to export.');
    return;
  }

  // Strip any credential fields before export
  const safeProfiles = profiles.map(({ password: _pw, ...rest }) => rest);
  const json = JSON.stringify(safeProfiles, null, 2);

  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(`pgstudio-profiles-${new Date().toISOString().split('T')[0]}.json`),
    filters: { 'JSON Files': ['json'] },
  });

  if (uri) {
    await vscode.workspace.fs.writeFile(uri, Buffer.from(json, 'utf8'));
    vscode.window.showInformationMessage(`${safeProfiles.length} profile(s) exported to ${uri.fsPath}`);
  }
}

/**
 * D3: Import connection profiles from a JSON bundle.
 * Uses last-write-wins — existing profiles with the same ID are overwritten.
 */
export async function importConnectionProfiles(): Promise<void> {
  const files = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { 'JSON Files': ['json'] },
    title: 'Import PgStudio Connection Profiles',
  });

  if (!files || files.length === 0) { return; }

  try {
    const bytes = await vscode.workspace.fs.readFile(files[0]);
    const imported = JSON.parse(Buffer.from(bytes).toString('utf8'));

    if (!Array.isArray(imported)) {
      vscode.window.showErrorMessage('Invalid profile file — expected a JSON array.');
      return;
    }

    const profileManager = ProfileManager.getInstance();
    let count = 0;
    for (const p of imported) {
      if (p.id && p.profileName) {
        await profileManager.createProfile(p);
        count++;
      }
    }

    refreshPhase7TreeViews();
    vscode.window.showInformationMessage(`${count} profile(s) imported successfully.`);
  } catch (err: any) {
    vscode.window.showErrorMessage(`Failed to import profiles: ${err.message}`);
  }
}

/**
 * Load a saved query into the active notebook
 */
export async function loadSavedQueryUI(): Promise<void> {
  const activeEditor = vscode.window.activeNotebookEditor;

  if (!activeEditor) {
    vscode.window.showWarningMessage('No active notebook. Open a .pgsql notebook first.');
    return;
  }

  const service = SavedQueriesService.getInstance();
  const queries = service.getQueries();

  if (queries.length === 0) {
    vscode.window.showInformationMessage('No saved queries yet.');
    return;
  }

  const items = queries.map((q) => ({
    label: q.title,
    description: q.description || `Used ${q.usageCount} times`,
    query: q
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a query to load'
  });

  if (selected) {
    // Record usage
    await service.recordUsage(selected.query.id);

    // Open the query in a new document
    const doc = await vscode.workspace.openTextDocument({
      language: 'sql',
      content: selected.query.query,
    });
    await vscode.window.showTextDocument(doc);
    vscode.window.showInformationMessage(`✓ Loaded query: "${selected.query.title}"`);
  }
}
