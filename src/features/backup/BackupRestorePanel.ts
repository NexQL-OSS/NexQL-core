import * as vscode from 'vscode';
import * as fs from 'fs';
import { getChatViewProvider } from '../../extension';
import type { ConnectionConfig } from '../../common/types';
import { ConnectionManager } from '../../services/ConnectionManager';
import { createMetadata, getConnectionWithPassword } from '../../commands/connection';
import { queryServerVersionNum } from '../../lib/postgresServerVersion';
import { buildPgDumpArgv } from './buildPgDumpArgs';
import { buildPgDumpallArgv } from './buildPgDumpallArgs';
import { buildPgRestoreArgv, buildPgRestoreListArgv } from './buildPgRestoreArgs';
import { runPgTool } from './PgToolRunner';
import {
  prependConnectionArgs,
  resolveConnectionForTools
} from './resolveConnectionForTools';
import {
  getPgDumpVersion,
  getPgRestoreVersion,
  isMajorMismatch,
  serverMajorFromVersionNum
} from './toolVersion';
import { parseExtraCliArgs } from './parseExtraCliArgs';
import { parseRestoreListOutput } from './restoreListParser';
import { openNotebookWithBackupLog, tryAppendBackupLogToActiveNotebook } from './backupNotebookLog';
import type { PgDumpFormatFlag } from './types';
import { getBackupRestoreHtml } from './BackupRestoreHtml';

export interface BackupPanelLaunchOptions {
  initialTab: 'dump' | 'restore' | 'dumpall';
  connectionId: string;
  databaseName: string;
  databaseLabel: string;
}

interface TableChoiceRow {
  qualified: string;
  schema: string;
}

interface InitPayload {
  initialTab: string;
  connectionId: string;
  databaseName: string;
  databaseLabel: string;
  databases: string[];
  /** Schema names for filter dropdown */
  schemas: string[];
  /** Tables/views for multi-select (-t) */
  tableChoices: TableChoiceRow[];
  serverVersionNum: number;
  serverMajor: number;
  pgDumpMajor: number;
  pgRestoreMajor: number;
  versionMismatchDump: boolean;
  versionMismatchRestore: boolean;
  sshEnabled: boolean;
}

export class BackupRestorePanel {
  public static current: BackupRestorePanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _options: BackupPanelLaunchOptions;
  private _connectionRow: ConnectionConfig | undefined;
  private _password: string | undefined;
  private _disposables: vscode.Disposable[] = [];
  private _cancelSource: vscode.CancellationTokenSource | undefined;
  private _output: vscode.OutputChannel;
  /** Last init payload (versions, SSH) for assistant context */
  private _lastInit: InitPayload | undefined;

  public static async show(
    context: vscode.ExtensionContext,
    options: BackupPanelLaunchOptions
  ): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (BackupRestorePanel.current) {
      await BackupRestorePanel.current._refreshAndReveal(options);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'pgstudioBackupRestore',
      'PostgreSQL · Backup & Restore',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')]
      }
    );

    BackupRestorePanel.current = new BackupRestorePanel(panel, context, options);
    context.subscriptions.push(panel);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    options: BackupPanelLaunchOptions
  ) {
    this._panel = panel;
    this._context = context;
    this._options = options;
    this._output = vscode.window.createOutputChannel('PostgreSQL Backup');

    this._disposables.push(panel.onDidDispose(() => this.dispose()));
    this._disposables.push(
      panel.webview.onDidReceiveMessage(msg => this._onMessage(msg))
    );

    void this._loadAndSendInit();
  }

  private dispose(): void {
    BackupRestorePanel.current = undefined;
    this._cancelSource?.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
    this._output.dispose();
  }

  private async _refreshAndReveal(options: BackupPanelLaunchOptions): Promise<void> {
    this._options = options;
    this._panel.title = `Backup & Restore · ${options.databaseLabel}`;
    await this._loadAndSendInit();
    this._panel.reveal(vscode.window.activeTextEditor?.viewColumn);
  }

  private async _loadAndSendInit(): Promise<void> {
    try {
      const conn = await getConnectionWithPassword(this._options.connectionId, this._options.databaseName);
      this._password = conn.password;
      const connections =
        vscode.workspace.getConfiguration().get<ConnectionConfig[]>('postgresExplorer.connections') || [];
      this._connectionRow = connections.find(c => c.id === conn.id);

      const client = await ConnectionManager.getInstance().getPooledClient({
        id: conn.id,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        database: this._options.databaseName,
        name: conn.name
      });

      let serverVersionNum = 0;
      let databases: string[] = [];
      let schemas: string[] = [];
      let tableChoices: TableChoiceRow[] = [];
      try {
        serverVersionNum = await queryServerVersionNum(client);
        const dbs = await client.query<{ datname: string }>(`
          SELECT datname FROM pg_database
          WHERE datallowconn = true AND datistemplate = false
          ORDER BY datname
        `);
        databases = dbs.rows.map(r => r.datname);

        const schResult = await client.query<{ schema_name: string }>(`
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema')
          ORDER BY schema_name
        `);
        schemas = schResult.rows.map(r => r.schema_name);

        const tabResult = await client.query<{ qualified: string; schema: string }>(`
          SELECT
            t.table_schema AS schema,
            quote_ident(t.table_schema) || '.' || quote_ident(t.table_name) AS qualified
          FROM information_schema.tables t
          WHERE t.table_type IN ('BASE TABLE', 'PARTITIONED TABLE', 'VIEW', 'FOREIGN TABLE')
            AND t.table_schema NOT IN ('pg_catalog', 'information_schema')
          ORDER BY t.table_schema, t.table_name
        `);
        tableChoices = tabResult.rows.map(r => ({ qualified: r.qualified, schema: r.schema }));
      } finally {
        client.release();
      }

      const serverMajor = serverMajorFromVersionNum(serverVersionNum);
      let pgDumpMajor = 0;
      let pgRestoreMajor = 0;
      try {
        pgDumpMajor = (await getPgDumpVersion()).major;
      } catch {
        /* ignore */
      }
      try {
        pgRestoreMajor = (await getPgRestoreVersion()).major;
      } catch {
        /* ignore */
      }

      const cfg = this._connectionRow;
      const payload: InitPayload = {
        initialTab: this._options.initialTab,
        connectionId: this._options.connectionId,
        databaseName: this._options.databaseName,
        databaseLabel: this._options.databaseLabel,
        databases,
        schemas,
        tableChoices,
        serverVersionNum,
        serverMajor,
        pgDumpMajor,
        pgRestoreMajor,
        versionMismatchDump: isMajorMismatch(pgDumpMajor, serverMajor),
        versionMismatchRestore: isMajorMismatch(pgRestoreMajor, serverMajor),
        sshEnabled: !!cfg?.ssh?.enabled
      };

      this._lastInit = payload;
      this._panel.webview.html = await getBackupRestoreHtml(this._panel.webview, this._context.extensionUri);
      this._panel.title = `Backup & Restore · ${this._options.databaseLabel}`;
      void this._panel.webview.postMessage({ type: 'init', payload });
    } catch (e) {
      vscode.window.showErrorMessage(`Backup panel: ${e}`);
    }
  }

  private async _onMessage(msg: { type?: string; payload?: unknown }): Promise<void> {
    switch (msg.type) {
      case 'pickSaveFile':
        await this._pickSaveFile(msg.payload as { defaultName?: string });
        break;
      case 'pickOpenFile':
        await this._pickOpenFile();
        break;
      case 'pickDirectory':
        await this._pickDirectory();
        break;
      case 'runDump':
        await this._runDump(msg.payload as Record<string, unknown>);
        break;
      case 'runRestore':
        await this._runRestore(msg.payload as Record<string, unknown>);
        break;
      case 'runDumpall':
        await this._runDumpall(msg.payload as Record<string, unknown>);
        break;
      case 'listArchive':
        await this._listArchive(msg.payload as Record<string, unknown>);
        break;
      case 'backupToolsAssist':
        await this._backupToolsAssist(msg.payload as Record<string, unknown>);
        break;
      case 'cancel':
        this._cancelSource?.cancel();
        break;
      case 'appendNotebook':
        await this._appendNotebook(msg.payload as { title: string; log: string });
        break;
      case 'generateTask':
        await this._generateTaskSnippet(msg.payload as Record<string, unknown>);
        break;
      default:
        break;
    }
  }

  private async _pickSaveFile(payload?: { defaultName?: string }): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(payload?.defaultName ?? 'backup.dump'),
      filters: {
        'PostgreSQL archive': ['dump', 'backup', 'sql', 'tar'],
        'All files': ['*']
      },
      title: 'Backup output file'
    });
    if (uri) {
      void this._panel.webview.postMessage({ type: 'pickedPath', kind: 'save', path: uri.fsPath });
    }
  }

  private async _pickOpenFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        'Dump / archive': ['dump', 'backup', 'sql', 'tar'],
        'All files': ['*']
      },
      title: 'Select backup file'
    });
    if (uris?.[0]) {
      void this._panel.webview.postMessage({ type: 'pickedPath', kind: 'open', path: uris[0].fsPath });
    }
  }

  private async _pickDirectory(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: 'Select output directory'
    });
    if (uris?.[0]) {
      void this._panel.webview.postMessage({ type: 'pickedPath', kind: 'dir', path: uris[0].fsPath });
    }
  }

  /**
   * Optional webview `extraCliArgs` string → argv tokens. Returns null on parse error (notification shown).
   */
  private _extraArgvFromPayload(payload: Record<string, unknown>): string[] | null {
    const raw = payload.extraCliArgs;
    if (raw === undefined || raw === null) {
      return [];
    }
    const s = String(raw).trim();
    if (!s) {
      return [];
    }
    try {
      return parseExtraCliArgs(s);
    } catch (e) {
      void vscode.window.showErrorMessage(`Invalid extra CLI args: ${e}`);
      return null;
    }
  }

  private async _runDump(payload: Record<string, unknown>): Promise<void> {
    const cfg = this._connectionRow;
    if (!cfg) {
      return;
    }

    const extraArgv = this._extraArgvFromPayload(payload);
    if (extraArgv === null) {
      return;
    }

    this._cancelSource?.dispose();
    this._cancelSource = new vscode.CancellationTokenSource();
    const token = this._cancelSource.token;

    let log = '';
    const append = (s: string) => {
      log += s;
      void this._panel.webview.postMessage({ type: 'logChunk', chunk: s });
    };

    let resolvedDispose: (() => void) | undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'pg_dump',
        cancellable: true
      },
      async (progress, pToken) => {
        pToken.onCancellationRequested(() => this._cancelSource?.cancel());

        try {
          const resolved = await resolveConnectionForTools(cfg, this._password);
          resolvedDispose = resolved.dispose;

          const formatMap: Record<string, PgDumpFormatFlag> = {
            custom: 'c',
            plain: 'p',
            directory: 'd',
            tar: 't'
          };
          const fmt = formatMap[String(payload.format)] ?? 'c';

          const tableList = Array.isArray(payload.tableQualifiedList)
            ? (payload.tableQualifiedList as unknown[]).map(x => String(x)).filter(Boolean)
            : [];
          const schemaList = Array.isArray(payload.schemaNameList)
            ? (payload.schemaNameList as unknown[]).map(x => String(x)).filter(Boolean)
            : [];

          const argv = buildPgDumpArgv({
            format: fmt,
            verbose: !!payload.verbose,
            schemaOnly: !!payload.schemaOnly,
            dataOnly: !!payload.dataOnly,
            blobs: !!payload.blobs,
            parallelJobs: Number(payload.parallelJobs) || 1,
            compression:
              payload.compression === null || payload.compression === undefined
                ? null
                : Number(payload.compression),
            outputPath: String(payload.outputPath ?? ''),
            database: String(payload.database ?? this._options.databaseName),
            tableQualifiedList: tableList.length > 0 ? tableList : undefined,
            schemaNameList: schemaList.length > 0 ? schemaList : undefined,
            extraArgv: extraArgv.length > 0 ? extraArgv : undefined
          });

          const fullArgv = prependConnectionArgs(argv, resolved);
          append(`$ ${this._safeArgvDisplay(fullArgv)}\n\n`);

          const result = await runPgTool({
            argv: fullArgv,
            env: resolved.env,
            token,
            onStdout: chunk => append(chunk),
            onStderr: chunk => append(chunk)
          });

          append(`\n[exit ${result.exitCode}]\n`);
          progress.report({ increment: 100 });

          if (!token.isCancellationRequested && result.exitCode !== 0) {
            vscode.window.showErrorMessage(`pg_dump exited with code ${result.exitCode}`);
          }
        } catch (e) {
          const err = `${e}`;
          append(`\n${err}\n`);
          vscode.window.showErrorMessage(err);
        } finally {
          resolvedDispose?.();
        }
      }
    );

    void this._panel.webview.postMessage({ type: 'runDone', log });
  }

  private async _runRestore(payload: Record<string, unknown>): Promise<void> {
    const cfg = this._connectionRow;
    if (!cfg) {
      return;
    }

    const extraArgv = this._extraArgvFromPayload(payload);
    if (extraArgv === null) {
      return;
    }

    const inputPath = String(payload.inputPath ?? '');
    if (/\.sql$/i.test(inputPath)) {
      vscode.window.showWarningMessage(
        'Plain SQL dumps are restored with psql, not pg_restore. Run: psql -f ... against the target database.'
      );
      return;
    }

    this._cancelSource?.dispose();
    this._cancelSource = new vscode.CancellationTokenSource();
    const token = this._cancelSource.token;

    let log = '';
    const append = (s: string) => {
      log += s;
      void this._panel.webview.postMessage({ type: 'logChunk', chunk: s });
    };

    let resolvedDispose: (() => void) | undefined;
    const selectedLines = Array.isArray(payload.selectedLines)
      ? (payload.selectedLines as string[])
      : undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'pg_restore',
        cancellable: true
      },
      async (progress, pToken) => {
        pToken.onCancellationRequested(() => this._cancelSource?.cancel());

        let tempFiles: string[] = [];

        try {
          const resolved = await resolveConnectionForTools(cfg, this._password);
          resolvedDispose = resolved.dispose;

          const listResult = buildPgRestoreArgv({
            verbose: !!payload.verbose,
            jobs: Number(payload.jobs) || 1,
            targetDatabase: String(payload.targetDatabase ?? ''),
            inputPath,
            selectedListLines: selectedLines && selectedLines.length > 0 ? selectedLines : undefined,
            extraArgv: extraArgv.length > 0 ? extraArgv : undefined
          });
          tempFiles = listResult.tempFiles;

          const fullArgv = prependConnectionArgs(listResult.argv, resolved);
          append(`$ ${this._safeArgvDisplay(fullArgv)}\n\n`);

          const result = await runPgTool({
            argv: fullArgv,
            env: resolved.env,
            token,
            onStdout: chunk => append(chunk),
            onStderr: chunk => append(chunk)
          });

          append(`\n[exit ${result.exitCode}]\n`);
          progress.report({ increment: 100 });

          if (!token.isCancellationRequested && result.exitCode !== 0) {
            vscode.window.showErrorMessage(`pg_restore exited with code ${result.exitCode}`);
          }
        } catch (e) {
          const err = `${e}`;
          append(`\n${err}\n`);
          vscode.window.showErrorMessage(err);
        } finally {
          for (const f of tempFiles) {
            try {
              fs.unlinkSync(f);
            } catch {
              /* ignore */
            }
          }
          resolvedDispose?.();
        }
      }
    );

    void this._panel.webview.postMessage({ type: 'runDone', log });
  }

  private async _runDumpall(payload: Record<string, unknown>): Promise<void> {
    const cfg = this._connectionRow;
    if (!cfg) {
      return;
    }

    const extraArgv = this._extraArgvFromPayload(payload);
    if (extraArgv === null) {
      return;
    }

    this._cancelSource?.dispose();
    this._cancelSource = new vscode.CancellationTokenSource();
    const token = this._cancelSource.token;

    let log = '';
    const append = (s: string) => {
      log += s;
      void this._panel.webview.postMessage({ type: 'logChunk', chunk: s });
    };

    let resolvedDispose: (() => void) | undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'pg_dumpall',
        cancellable: true
      },
      async (progress, pToken) => {
        pToken.onCancellationRequested(() => this._cancelSource?.cancel());

        try {
          const resolved = await resolveConnectionForTools(cfg, this._password);
          resolvedDispose = resolved.dispose;

          const argv = buildPgDumpallArgv({
            verbose: !!payload.verbose,
            globalsOnly: !!payload.globalsOnly,
            rolesOnly: !!payload.rolesOnly,
            outputPath: String(payload.outputPath ?? ''),
            extraArgv: extraArgv.length > 0 ? extraArgv : undefined
          });

          const fullArgv = prependConnectionArgs(argv, resolved);
          append(`$ ${this._safeArgvDisplay(fullArgv)}\n\n`);

          const result = await runPgTool({
            argv: fullArgv,
            env: resolved.env,
            token,
            onStdout: chunk => append(chunk),
            onStderr: chunk => append(chunk)
          });

          append(`\n[exit ${result.exitCode}]\n`);
          progress.report({ increment: 100 });

          if (!token.isCancellationRequested && result.exitCode !== 0) {
            vscode.window.showErrorMessage(`pg_dumpall exited with code ${result.exitCode}`);
          }
        } catch (e) {
          append(`\n${e}\n`);
          vscode.window.showErrorMessage(`${e}`);
        } finally {
          resolvedDispose?.();
        }
      }
    );

    void this._panel.webview.postMessage({ type: 'runDone', log });
  }

  private async _listArchive(payload: Record<string, unknown>): Promise<void> {
    const p = String(payload?.path ?? '');
    if (!p) {
      return;
    }

    const extraArgv = this._extraArgvFromPayload(payload);
    if (extraArgv === null) {
      void this._panel.webview.postMessage({
        type: 'listResult',
        error: 'Invalid extra CLI args',
        raw: ''
      });
      return;
    }

    let log = '';
    try {
      const argv = buildPgRestoreListArgv(p, extraArgv.length > 0 ? extraArgv : undefined);
      const result = await runPgTool({
        argv,
        env: { ...process.env },
        onStdout: chunk => {
          log += chunk;
        },
        onStderr: chunk => {
          log += chunk;
        }
      });

      if (result.exitCode !== 0) {
        void this._panel.webview.postMessage({
          type: 'listResult',
          error: `pg_restore --list exited ${result.exitCode}`,
          raw: log
        });
        return;
      }

      const rows = parseRestoreListOutput(log);
      void this._panel.webview.postMessage({
        type: 'listResult',
        rows,
        raw: log
      });
    } catch (e) {
      void this._panel.webview.postMessage({
        type: 'listResult',
        error: `${e}`,
        raw: ''
      });
    }
  }

  private async _backupToolsAssist(payload: Record<string, unknown>): Promise<void> {
    const chat = getChatViewProvider();
    if (!chat) {
      void vscode.window.showWarningMessage('SQL Assistant is not available yet. Open the SQL Assistant view once, then retry.');
      return;
    }

    const scenarioRaw = String(payload.scenario ?? 'tool_log');
    const init = this._lastInit;
    let scenario: 'version_banner' | 'tool_log' = 'tool_log';
    let toolLog: string | undefined =
      typeof payload.logText === 'string' && payload.logText.trim() ? String(payload.logText) : undefined;

    if (scenarioRaw === 'version_banner') {
      scenario = 'version_banner';
      toolLog = undefined;
    } else if (scenarioRaw === 'ssh_banner') {
      scenario = 'tool_log';
      toolLog =
        '[Context: user opened assistant from the Backup & Restore **SSH** info banner.]\n' +
        'NexQL shows that SSH is enabled and that CLI tools (pg_dump / pg_restore) use the same tunnel as the SQL driver (local port forward).\n\n' +
        'Please explain what that means for running backups/restores, common pitfalls (host/port, identity file, timeouts), and how to verify the tunnel matches the connection.\n';
    }

    try {
      await chat.openBackupToolsAssistant({
        scenario,
        connectionId: this._options.connectionId,
        databaseLabel: this._options.databaseLabel,
        databaseName: this._options.databaseName,
        connection: this._connectionRow,
        toolLog: scenario === 'tool_log' ? toolLog : undefined,
        serverMajor: init?.serverMajor ?? 0,
        pgDumpMajor: init?.pgDumpMajor ?? 0,
        pgRestoreMajor: init?.pgRestoreMajor ?? 0
      });
    } catch (e) {
      void vscode.window.showErrorMessage(`Backup assistant: ${e}`);
    }
  }

  private async _appendNotebook(payload: { title: string; log: string }): Promise<void> {
    const conn = await getConnectionWithPassword(this._options.connectionId, this._options.databaseName);
    const meta = createMetadata(conn, this._options.databaseName);

    const appended = await tryAppendBackupLogToActiveNotebook(
      payload.title,
      payload.log,
      this._options.connectionId,
      this._options.databaseName
    );
    if (!appended) {
      await openNotebookWithBackupLog(payload.title, payload.log, meta);
    }
  }

  private async _generateTaskSnippet(payload: Record<string, unknown>): Promise<void> {
    const task = {
      label: String(payload.label ?? 'PostgreSQL backup'),
      type: 'pgstudio-pgdump',
      connectionId: this._options.connectionId,
      databaseName: String(payload.database ?? this._options.databaseName),
      dumpFormat: String(payload.format ?? 'custom'),
      outputPath: String(payload.outputPath ?? '${workspaceFolder}/backup.dump')
    };

    const json = JSON.stringify(task, null, 2);
    const doc = `{
  "version": "2.0.0",
  "tasks": [
    ${json.split('\n').join('\n    ')}
  ]
}`;
    await vscode.env.clipboard.writeText(doc);
    vscode.window.showInformationMessage(
      'Sample tasks.json snippet copied to clipboard. Paste into .vscode/tasks.json and adjust paths.'
    );
  }

  /** Hide password if ever present in argv */
  private _safeArgvDisplay(argv: string[]): string {
    return argv.join(' ');
  }

}
