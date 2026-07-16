import * as vscode from 'vscode';
import { loadPanelTemplate } from '../../../lib/template-loader';
import { IndexStore } from '../IndexStore';
import { IndexBuilder } from '../IndexBuilder';
import { ObjectEntry, JoinEdge, JoinGraph } from '../types';
import { getDbIndexesState, handleRebuildIndex, handleClearIndex, handleExportIndex } from './indexActions';
import { SettingsHubPanel } from '../../settings/SettingsHubPanel';

export class DbIndexPanel {
  public static currentPanel: DbIndexPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext;
  private readonly _store: IndexStore;
  private readonly _disposables: vscode.Disposable[] = [];

  public static async show(extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (DbIndexPanel.currentPanel) {
      DbIndexPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbIndexGrounding',
      '🔍 Database Index Grounding',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    DbIndexPanel.currentPanel = new DbIndexPanel(panel, extensionUri, context);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._context = context;
    this._store = new IndexStore(context.globalStorageUri);

    void this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'requestState':
            await this._postState();
            return;
          case 'updateConfig':
            await vscode.workspace.getConfiguration().update(
              'postgresExplorer.dbIndex.enableEmbeddings',
              message.enableEmbeddings,
              vscode.ConfigurationTarget.Global
            );
            return;
          case 'buildNew':
            // Open Settings Hub on the dbindex section and immediately open the new wizard modal
            SettingsHubPanel.show(
              this._extensionUri,
              this._context,
              { section: 'dbindex', wizard: 'build' }
            );
            return;
          case 'rebuild':
            await this._handleRebuild(message.connectionId, message.database);
            return;
          case 'export':
            await this._handleExport(message.connectionId, message.database);
            return;
          case 'clear':
            await this._handleClear(message.connectionId, message.database);
            return;
          case 'requestDetails':
            await this._handleRequestDetails(message.connectionId, message.database);
            return;
          case 'saveOverrides':
            await this._handleSaveOverrides(message.connectionId, message.database, message.overrides);
            return;
        }
      },
      null,
      this._disposables
    );
  }

  public dispose() {
    DbIndexPanel.currentPanel = undefined;
    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
    this._panel.dispose();
  }

  private async _update() {
    this._panel.webview.html = await loadPanelTemplate(
      this._panel.webview,
      this._extensionUri,
      'dbindex',
      { PAGE_TITLE: 'Database Index Grounding' }
    );
  }

  private async _postState() {
    const state = await getDbIndexesState(this._store);
    await this._panel.webview.postMessage({
      command: 'state',
      state,
    });
  }

  private async _handleRebuild(connectionId: string, database: string) {
    await handleRebuildIndex(this._store, connectionId, database, () => this._postState());
  }

  private async _handleClear(connectionId: string, database: string) {
    await handleClearIndex(this._store, connectionId, database, () => this._postState());
  }

  private async _handleExport(connectionId: string, database: string) {
    await handleExportIndex(this._store, connectionId, database);
  }

  private async _handleRequestDetails(connectionId: string, database: string) {
    const baseDir = this._store.getBaseDir(connectionId, database);
    const manifest = await this._store.readManifest(baseDir);
    if (!manifest) {
      await this._panel.webview.postMessage({
        command: 'detailsError',
        error: 'Manifest not found.',
      });
      return;
    }

    try {
      const objects: any[] = [];
      const overrides = await this._store.readOverrides(baseDir) || {};

      for (const shard of manifest.shards) {
        const shardUri = vscode.Uri.joinPath(baseDir, shard.file);
        try {
          const data = await vscode.workspace.fs.readFile(shardUri);
          const entries = JSON.parse(Buffer.from(data).toString('utf-8')) as Record<string, ObjectEntry>;
          for (const [ref, entry] of Object.entries(entries)) {
            const objOverride = overrides.objects?.[ref];
            const columns = entry.columns.map(col => {
              const colOverride = objOverride?.columns?.[col.name];
              return {
                name: col.name,
                type: col.type,
                comment: colOverride?.comment !== undefined ? colOverride.comment : col.comment,
                pii: colOverride?.pii !== undefined ? colOverride.pii : false,
              };
            });

            objects.push({
              ref,
              kind: entry.kind,
              comment: objOverride?.comment !== undefined ? objOverride.comment : entry.comment,
              excluded: objOverride?.excluded !== undefined ? objOverride.excluded : false,
              columns,
              indexes: entry.indexes || [],
            });
          }
        } catch {
          // ignore shard read failures
        }
      }

      // Read synonyms and joins
      const tokensIndex = await this._store.readTokens(baseDir, manifest);
      const minedSynonyms = tokensIndex?.synonyms || {};

      let baseJoins: JoinEdge[] = [];
      const jgUri = vscode.Uri.joinPath(baseDir, manifest.derived.joinGraph);
      try {
        const data = await vscode.workspace.fs.readFile(jgUri);
        const graph = JSON.parse(Buffer.from(data).toString('utf-8')) as JoinGraph;
        baseJoins = graph.edges;
      } catch {}

      await this._panel.webview.postMessage({
        command: 'details',
        connectionId,
        database,
        objects,
        minedSynonyms,
        baseJoins,
        overrides,
      });
    } catch (err: any) {
      await this._panel.webview.postMessage({
        command: 'detailsError',
        error: err.message || String(err),
      });
    }
  }

  private async _handleSaveOverrides(connectionId: string, database: string, overrides: any) {
    try {
      const baseDir = this._store.getBaseDir(connectionId, database);
      await this._store.writeOverrides(baseDir, overrides);
      vscode.window.showInformationMessage(`Overrides saved successfully for "${database}".`);
      
      // Post updated state and updated details
      await this._postState();
      await this._handleRequestDetails(connectionId, database);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Failed to save overrides: ${err.message || err}`);
    }
  }

  public refreshState(): void {
    void this._postState();
  }
}
