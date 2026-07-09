import * as vscode from 'vscode';
import { ErrorHandlers } from '../commands/helper';
import { createAndShowNotebook } from '../commands/connection';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { resolveTreeItemConnection } from './connectionHelper';
import { TelemetryService } from '../services/TelemetryService';
import {
  buildRoleMigrationMarkdown,
  buildRoleMigrationSql,
  buildRolePreviewHtml,
  buildRoleChangePreviewHtml,
  buildRoleChangeMigrationSql,
  buildRoleChangeMigrationMarkdown,
  RoleDesignerDatabasePrivilege,
  RoleDesignerDefaultTablePrivilege,
  RoleDesignerMembership,
  RoleDesignerSchemaPrivilege,
  RoleDesignerState,
  RoleDesignerTablePrivilege,
} from './RoleSQL';

type RoleDesignerQueryResult = {
  roleName: string;
  password: string;
  connectionLimit: string;
  validUntil: string;
  flags: RoleDesignerState['flags'];
  searchPath: string;
  statementTimeout: string;
  workMem: string;
  databasePrivileges: RoleDesignerDatabasePrivilege[];
  schemaPrivileges: RoleDesignerSchemaPrivilege[];
  defaultTablePrivileges: RoleDesignerDefaultTablePrivilege[];
  tablePrivileges: RoleDesignerTablePrivilege[];
  memberOf: RoleDesignerMembership[];
  members: RoleDesignerMembership[];
  availableRoles: string[];
};

export class RoleDesignerPanel {
  public static readonly viewType = 'pgStudio.roleDesigner';

  private static _panels = new Map<string, RoleDesignerPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private _currentState: RoleDesignerState | undefined;
  private _originalState: RoleDesignerState | undefined;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly _extensionUri: vscode.Uri,
  ) {
    this._panel = panel;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    TelemetryService.getInstance().trackDesignerOpened('role');
  }

  public static async openForRole(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
    let dbConn: Awaited<ReturnType<typeof resolveTreeItemConnection>> | undefined;
    try {
      dbConn = await resolveTreeItemConnection(item);
      if (!dbConn) {
        return;
      }

      const { client } = dbConn;
      const roleName = item.label;
      const panelKey = `${item.connectionId}:${item.databaseName}:${roleName}`;

      if (RoleDesignerPanel._panels.has(panelKey)) {
        RoleDesignerPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
        return;
      }

      const notebookMetadata = dbConn.metadata;

      const roleRow = await client.query(
        `SELECT
           r.rolname,
           r.rolsuper,
           r.rolcreatedb,
           r.rolcreaterole,
           r.rolcanlogin,
           r.rolinherit,
           r.rolreplication,
           r.rolbypassrls,
           r.rolconnlimit,
           r.rolvaliduntil,
           COALESCE(pg_catalog.shobj_description(r.oid, 'pg_authid'), '') as description
         FROM pg_roles r
         WHERE r.rolname = $1`,
        [roleName]
      );

      if (roleRow.rows.length === 0) {
        throw new Error('Role not found');
      }

      let password = '';
      try {
        const pwdResult = await client.query(
          `SELECT rolpassword FROM pg_authid WHERE rolname = $1`,
          [roleName]
        );
        password = pwdResult.rows[0]?.rolpassword || '';
      } catch {
        // Some roles cannot inspect pg_authid; show a placeholder instead of failing.
        password = '(hidden)';
      }

      const databasesResult = await client.query(
        `SELECT
           datname,
           has_database_privilege($1, datname, 'CONNECT') as can_connect,
           has_database_privilege($1, datname, 'CREATE') as can_create,
           has_database_privilege($1, datname, 'TEMP') as can_temp
         FROM pg_database
         WHERE datallowconn
         ORDER BY datname`,
        [roleName]
      );

      const schemasResult = await client.query(
        `SELECT
           n.nspname as schema_name,
           has_schema_privilege($1, n.nspname, 'USAGE') as can_usage,
           has_schema_privilege($1, n.nspname, 'CREATE') as can_create,
           EXISTS (
             SELECT 1
             FROM pg_class c
             WHERE c.relnamespace = n.oid
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND NOT has_table_privilege($1, format('%I.%I', n.nspname, c.relname), 'SELECT')
           ) = false as can_select_all_tables
         FROM pg_namespace n
         WHERE n.nspname NOT LIKE 'pg_%'
           AND n.nspname <> 'information_schema'
         ORDER BY CASE WHEN n.nspname = 'public' THEN 0 ELSE 1 END, n.nspname`,
        [roleName]
      );

      const defaultTablePrivileges = schemasResult.rows.map((row: any) => ({
        schemaName: row.schema_name,
        select: false,
        insert: false,
        update: false,
        delete: false,
      }));

      const tablePrivilegesResult = await client.query(
        `SELECT
           tp.table_schema as schema_name,
           tp.table_name,
           bool_or(tp.privilege_type = 'SELECT') as can_select,
           bool_or(tp.privilege_type = 'INSERT') as can_insert,
           bool_or(tp.privilege_type = 'UPDATE') as can_update,
           bool_or(tp.privilege_type = 'DELETE') as can_delete
         FROM information_schema.table_privileges tp
         WHERE tp.grantee = $1
           AND tp.table_schema NOT LIKE 'pg_%'
           AND tp.table_schema <> 'information_schema'
         GROUP BY tp.table_schema, tp.table_name
         ORDER BY tp.table_schema, tp.table_name`,
        [roleName]
      );

      const memberOfResult = await client.query(
        `SELECT
           g.rolname as role_name
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.member
         JOIN pg_roles g ON g.oid = am.roleid
         WHERE r.rolname = $1
         ORDER BY g.rolname`,
        [roleName]
      );

      const membersResult = await client.query(
        `SELECT
           m.rolname as role_name
         FROM pg_auth_members am
         JOIN pg_roles r ON r.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
         WHERE r.rolname = $1
         ORDER BY m.rolname`,
        [roleName]
      );

      const availableRolesResult = await client.query(
        `SELECT rolname FROM pg_roles WHERE rolname != $1 ORDER BY rolname`,
        [roleName]
      );

      const data = RoleDesignerPanel._toState({
        roleName,
        password,
        connectionLimit: String(roleRow.rows[0].rolconnlimit ?? '-1'),
        validUntil: roleRow.rows[0].rolvaliduntil ? String(roleRow.rows[0].rolvaliduntil) : '',
        flags: {
          login: !!roleRow.rows[0].rolcanlogin,
          superuser: !!roleRow.rows[0].rolsuper,
          createdb: !!roleRow.rows[0].rolcreatedb,
          createrole: !!roleRow.rows[0].rolcreaterole,
          inherit: !!roleRow.rows[0].rolinherit,
          replication: !!roleRow.rows[0].rolreplication,
          bypassrls: !!roleRow.rows[0].rolbypassrls,
        },
        searchPath: 'analytics, public',
        statementTimeout: '30s',
        workMem: '64MB',
        databasePrivileges: databasesResult.rows.map((row: any) => ({
          databaseName: row.datname,
          connect: !!row.can_connect,
          create: !!row.can_create,
          temp: !!row.can_temp,
        })),
        schemaPrivileges: schemasResult.rows.map((row: any) => ({
          schemaName: row.schema_name,
          usage: !!row.can_usage,
          create: !!row.can_create,
          selectAllTables: !!row.can_select_all_tables,
        })),
        defaultTablePrivileges,
        tablePrivileges: tablePrivilegesResult.rows.map((row: any) => ({
          schemaName: row.schema_name,
          tableName: row.table_name,
          select: !!row.can_select,
          insert: !!row.can_insert,
          update: !!row.can_update,
          delete: !!row.can_delete,
        })),
        memberOf: memberOfResult.rows.map((row: any) => ({
          roleName: row.role_name,
          enabled: true,
          lastLogin: null,
        })),
        members: membersResult.rows.map((row: any) => ({
          roleName: row.role_name,
          enabled: true,
          lastLogin: null,
        })),
        availableRoles: availableRolesResult.rows.map((row: any) => row.rolname),
      });

      const panel = vscode.window.createWebviewPanel(
        RoleDesignerPanel.viewType,
        `Role Designer · ${roleName}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')],
        }
      );

      const designer = new RoleDesignerPanel(panel, context.extensionUri);
      designer._originalState = data;
      designer._currentState = data;
      RoleDesignerPanel._panels.set(panelKey, designer);

      panel.onDidDispose(() => {
        RoleDesignerPanel._panels.delete(panelKey);
      });

      panel.webview.html = RoleDesignerPanel._getHtml(panel.webview, data);
      panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.type) {
          case 'stateChanged': {
            designer._currentState = message.state as RoleDesignerState;
            panel.webview.postMessage({
              type: 'previewUpdated',
              html: buildRoleChangePreviewHtml(designer._originalState!, designer._currentState),
            });
            break;
          }
          case 'copySql': {
            const sql = buildRoleChangeMigrationSql(designer._originalState!, message.state as RoleDesignerState);
            await vscode.env.clipboard.writeText(sql);
            vscode.window.showInformationMessage('Changes copied to clipboard (delta mode)');
            break;
          }
          case 'openNotebook': {
            await RoleDesignerPanel._openNotebook(
              message.state as RoleDesignerState,
              notebookMetadata,
              designer._originalState
            );
            break;
          }
        }
      }, null, designer._disposables);

    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open role designer');
    } finally {
      if (dbConn && dbConn.release) {
        dbConn.release();
      }
    }
  }

  private static _toState(data: RoleDesignerQueryResult): RoleDesignerState {
    return {
      roleName: data.roleName,
      password: data.password,
      connectionLimit: data.connectionLimit,
      validUntil: data.validUntil,
      flags: data.flags,
      searchPath: data.searchPath,
      statementTimeout: data.statementTimeout,
      workMem: data.workMem,
      databasePrivileges: data.databasePrivileges,
      schemaPrivileges: data.schemaPrivileges,
      defaultTablePrivileges: data.defaultTablePrivileges,
      tablePrivileges: data.tablePrivileges,
      memberOf: data.memberOf,
      members: data.members,
      availableRoles: data.availableRoles,
    };
  }

  private static async _openNotebook(
    state: RoleDesignerState,
    metadata: any,
    originalState?: RoleDesignerState
  ): Promise<void> {
    const markdown = originalState
      ? buildRoleChangeMigrationMarkdown(originalState, state)
      : buildRoleMigrationMarkdown(state);
    const sql = originalState
      ? buildRoleChangeMigrationSql(originalState, state)
      : buildRoleMigrationSql(state);

    const cells = [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, markdown, 'markdown'),
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, 'sql'),
    ];

    await createAndShowNotebook(cells, metadata);
  }

  private static _getHtml(webview: vscode.Webview, state: RoleDesignerState): string {
    const nonce = Math.random().toString(36).slice(2);
    const initialState = JSON.stringify(state).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Role Designer</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --bg2: var(--vscode-sideBar-background);
      --bg3: var(--vscode-input-background);
      --border: var(--vscode-editorWidget-border, var(--vscode-panel-border));
      --text: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --accent: var(--vscode-focusBorder);
      --danger: #f44747;
      --warn: #dcdcaa;
      --ok: #4ec9b0;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--vscode-editor-font-family, sans-serif); font-size: 13px; color: var(--text); background: var(--bg); }
    .shell { display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: 100vh; }
    .left { display: flex; flex-direction: column; min-width: 0; border-right: 1px solid var(--border); }
    .titlebar { display:flex; align-items:center; gap:10px; padding: 8px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); }
    .title { font-weight: 600; }
    .badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600; }
    .badge-edit { background: rgba(0, 122, 204, 0.18); color: var(--ok); }
    .badge-role { background: rgba(244, 71, 71, 0.14); color: var(--danger); }
    .tabs { display:flex; border-bottom: 1px solid var(--border); background: var(--bg2); overflow-x: auto; }
    .tab { padding: 10px 14px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; white-space: nowrap; }
    .tab.active { color: var(--text); border-bottom-color: var(--accent); background: var(--bg); }
    .content { flex: 1; overflow: hidden; }
    .pane { display: none; height: 100%; overflow: auto; padding: 12px; }
    .pane.active { display: block; }
    .section { margin-bottom: 18px; }
    .section h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
    .grid { display: grid; grid-template-columns: 190px 1fr; gap: 8px 10px; align-items: center; }
    .label { color: var(--muted); }
    .input, .select { width: 100%; padding: 6px 8px; border-radius: 4px; border: 1px solid var(--border); color: var(--text); background: var(--bg3); font: inherit; }
    .input[readonly] { opacity: 0.8; }
    .flag-grid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; }
    .flag { display:flex; align-items:center; gap:8px; }
    .warn { color: var(--warn); font-size: 11px; margin-left: 6px; }
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { border-bottom: 1px solid rgba(127,127,127,0.18); padding: 7px 8px; text-align: left; font-size: 12px; }
    .table th { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; }
    .check { width: 16px; height: 16px; }
    .btn { padding: 6px 10px; border-radius: 4px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
    .btn:hover { border-color: var(--accent); }
    .btn-primary { background: rgba(0,122,204,0.15); border-color: rgba(0,122,204,0.4); }
    .btn-danger { color: var(--danger); }
    .muted { color: var(--muted); font-size: 11px; }
    .right { display:flex; flex-direction:column; min-width:0; background: var(--bg2); }
    .preview-header { display:flex; align-items:center; justify-content:space-between; gap:8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
    .preview-title { display:flex; align-items:center; gap:8px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .preview { padding: 12px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; line-height: 1.7; overflow: auto; white-space: normal; flex: 1; }
    .footer { border-top: 1px solid var(--border); padding: 12px; display:flex; flex-direction:column; gap: 8px; }
    .footer .btn { width: 100%; }
    .pill { display:inline-flex; align-items:center; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
    .pill-ok { color: var(--ok); background: rgba(78,201,176,0.12); }
    .pill-warn { color: var(--warn); background: rgba(220,220,170,0.12); }
    .subtle { color: var(--muted); }
    .empty { padding: 18px 0; color: var(--muted); text-align: center; }
    .inline-note { font-size: 11px; color: var(--muted); }
  </style>
</head>
<body>
  <div class="shell">
    <div class="left">
      <div class="titlebar">
        <span class="title">Role Designer</span>
        <span class="badge badge-edit">EDIT MODE</span>
        <span class="badge badge-role">${state.roleName}</span>
      </div>
      <div class="tabs">
        <div class="tab active" data-tab="properties">Properties</div>
        <div class="tab" data-tab="db">DB Privileges</div>
        <div class="tab" data-tab="membership">Membership</div>
        <div class="tab" data-tab="schema">Schema / Table Privs</div>
      </div>
      <div class="content">
        <div class="pane active" id="tab-properties"></div>
        <div class="pane" id="tab-db"></div>
        <div class="pane" id="tab-membership"></div>
        <div class="pane" id="tab-schema"></div>
      </div>
    </div>
    <div class="right">
      <div class="preview-header">
        <div class="preview-title"><span class="dot"></span>SQL Preview</div>
        <span class="pill pill-ok">Unsaved changes</span>
      </div>
      <div class="preview" id="preview"></div>
      <div class="footer">
        <button class="btn btn-primary" id="open-notebook">Open in Notebook</button>
        <button class="btn" id="copy-sql">Copy SQL</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initialState = ${initialState};
    const state = JSON.parse(JSON.stringify(initialState));

    function sendState() {
      vscode.postMessage({ type: 'stateChanged', state });
    }

    function setPreview(html) {
      document.getElementById('preview').innerHTML = html;
    }

    function checkboxCell(checked, onChange) {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'check';
      input.checked = checked;
      input.addEventListener('change', onChange);
      return input;
    }

    function textInput(value, placeholder, onChange, readOnly = false) {
      const input = document.createElement('input');
      input.className = 'input';
      input.value = value || '';
      input.placeholder = placeholder || '';
      input.readOnly = readOnly;
      input.addEventListener('input', onChange);
      return input;
    }

    function label(text) {
      const div = document.createElement('div');
      div.className = 'label';
      div.textContent = text;
      return div;
    }

    function cell(value, muted = false) {
      const td = document.createElement('td');
      td.textContent = value;
      if (muted) td.className = 'subtle';
      return td;
    }

    function checkCell(checked, onChange) {
      const td = document.createElement('td');
      const input = checkboxCell(checked, e => onChange(e.target.checked));
      td.appendChild(input);
      return td;
    }

    function renderProperties() {
      const pane = document.getElementById('tab-properties');
      pane.innerHTML = '';

      const section = document.createElement('div');
      section.className = 'section';
      section.innerHTML = '<h3>Identity</h3>';

      const grid = document.createElement('div');
      grid.className = 'grid';
      grid.appendChild(label('Role Name'));
      grid.appendChild(textInput(state.roleName, 'role name', e => { state.roleName = e.target.value; sendState(); }, true));
      grid.appendChild(label('Password'));
      const passwordInput = textInput(state.password, 'hashed password', e => { state.password = e.target.value; sendState(); }, true);
      grid.appendChild(passwordInput);
      grid.appendChild(label('Connection Limit'));
      grid.appendChild(textInput(state.connectionLimit, '-1', e => { state.connectionLimit = e.target.value; sendState(); }));
      grid.appendChild(label('Valid Until'));
      grid.appendChild(textInput(state.validUntil, 'YYYY-MM-DD HH:MM:SS', e => { state.validUntil = e.target.value; sendState(); }));

      section.appendChild(grid);
      pane.appendChild(section);

      const privSection = document.createElement('div');
      privSection.className = 'section';
      privSection.innerHTML = '<h3>Privileges</h3>';
      const flagGrid = document.createElement('div');
      flagGrid.className = 'flag-grid';
      const flags = [
        ['login', 'LOGIN', 'Can log in to the server', false],
        ['superuser', 'SUPERUSER', 'High risk', true],
        ['createdb', 'CREATEDB', 'Create databases', false],
        ['createrole', 'CREATEROLE', 'Create and manage roles', false],
        ['inherit', 'INHERIT', 'Inherit granted privileges', false],
        ['replication', 'REPLICATION', 'High risk', true],
        ['bypassrls', 'BYPASSRLS', 'High risk', true],
      ];
      for (const [key, labelText, note, isRisk] of flags) {
        const wrapper = document.createElement('div');
        wrapper.className = 'flag';
        const input = checkboxCell(!!state.flags[key], () => { state.flags[key] = input.checked; sendState(); });
        wrapper.appendChild(input);
        const text = document.createElement('div');
        text.innerHTML = '<div>' + labelText + '</div><div class="inline-note">' + note + '</div>';
        wrapper.appendChild(text);
        if (isRisk) {
          const pill = document.createElement('span');
          pill.className = 'pill pill-warn';
          pill.textContent = 'High risk';
          wrapper.appendChild(pill);
        }
        flagGrid.appendChild(wrapper);
      }
      privSection.appendChild(flagGrid);
      pane.appendChild(privSection);

      const settingsSection = document.createElement('div');
      settingsSection.className = 'section';
      settingsSection.innerHTML = '<h3>Session Settings</h3>';
      const settingsGrid = document.createElement('div');
      settingsGrid.className = 'grid';
      settingsGrid.appendChild(label('Search Path'));
      settingsGrid.appendChild(textInput(state.searchPath, 'analytics, public', e => { state.searchPath = e.target.value; sendState(); }));
      settingsGrid.appendChild(label('statement_timeout'));
      settingsGrid.appendChild(textInput(state.statementTimeout, '30s', e => { state.statementTimeout = e.target.value; sendState(); }));
      settingsGrid.appendChild(label('work_mem'));
      settingsGrid.appendChild(textInput(state.workMem, '64MB', e => { state.workMem = e.target.value; sendState(); }));
      settingsSection.appendChild(settingsGrid);
      pane.appendChild(settingsSection);
    }

    function renderDatabasePrivileges() {
      const pane = document.getElementById('tab-db');
      pane.innerHTML = '';

      const section = document.createElement('div');
      section.className = 'section';
      section.innerHTML = '<h3>Database Privileges</h3>';
      const table = document.createElement('table');
      table.className = 'table';
      table.innerHTML = '<thead><tr><th>Database</th><th>CONNECT</th><th>CREATE</th><th>TEMP</th></tr></thead>';
      const body = document.createElement('tbody');
      state.databasePrivileges.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(row.databaseName));
        tr.appendChild(checkCell(row.connect, checked => { state.databasePrivileges[index].connect = checked; sendState(); }));
        tr.appendChild(checkCell(row.create, checked => { state.databasePrivileges[index].create = checked; sendState(); }));
        tr.appendChild(checkCell(row.temp, checked => { state.databasePrivileges[index].temp = checked; sendState(); }));
        body.appendChild(tr);
      });
      table.appendChild(body);
      section.appendChild(table);
      pane.appendChild(section);

      const defaults = document.createElement('div');
      defaults.className = 'section';
      defaults.innerHTML = '<h3>Default Privileges on New Tables</h3><div class="muted">ALTER DEFAULT PRIVILEGES IN SCHEMA ... GRANT/REVOKE ON TABLES</div>';
      const defaultsTable = document.createElement('table');
      defaultsTable.className = 'table';
      defaultsTable.innerHTML = '<thead><tr><th>Schema</th><th>SELECT</th><th>INSERT</th><th>UPDATE</th><th>DELETE</th></tr></thead>';
      const defaultsBody = document.createElement('tbody');
      state.defaultTablePrivileges.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(row.schemaName));
        tr.appendChild(checkCell(row.select, checked => { state.defaultTablePrivileges[index].select = checked; sendState(); }));
        tr.appendChild(checkCell(row.insert, checked => { state.defaultTablePrivileges[index].insert = checked; sendState(); }));
        tr.appendChild(checkCell(row.update, checked => { state.defaultTablePrivileges[index].update = checked; sendState(); }));
        tr.appendChild(checkCell(row.delete, checked => { state.defaultTablePrivileges[index].delete = checked; sendState(); }));
        defaultsBody.appendChild(tr);
      });
      defaultsTable.appendChild(defaultsBody);
      defaults.appendChild(defaultsTable);
      pane.appendChild(defaults);
    }

    function sectionTable(title, rows) {
      const section = document.createElement('div');
      section.className = 'section';
      const h3 = document.createElement('h3');
      h3.textContent = title;
      section.appendChild(h3);
      if (!rows.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No roles found';
        section.appendChild(empty);
        return section;
      }

      const table = document.createElement('table');
      table.className = 'table';
      table.innerHTML = '<thead><tr><th>Role</th><th>Last login</th><th>Action</th></tr></thead>';
      const body = document.createElement('tbody');
      rows.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(row.roleName));
        tr.appendChild(cell(row.lastLogin || 'n/a'));
        const actionCell = document.createElement('td');
        const revoke = document.createElement('button');
        revoke.className = 'btn btn-danger';
        revoke.textContent = row.enabled ? 'Revoke' : 'Grant';
        revoke.addEventListener('click', () => {
          rows[index].enabled = !rows[index].enabled;
          renderMembership();
          sendState();
        });
        actionCell.appendChild(revoke);
        tr.appendChild(actionCell);
        body.appendChild(tr);
      });
      table.appendChild(body);
      section.appendChild(table);
      return section;
    }

    function renderMembership() {
      const pane = document.getElementById('tab-membership');
      pane.innerHTML = '';

      const semanticsNote = document.createElement('div');
      semanticsNote.className = 'muted';
      semanticsNote.style.marginBottom = '10px';
      semanticsNote.textContent = 'Membership Mode: Inherit = regular membership; Admin Option = membership with admin rights. Inherited privileges are controlled by the role-level INHERIT flag in Properties.';
      pane.appendChild(semanticsNote);

      // Helper to render membership table with privilege controls
      function renderMembershipTable(title, memberships, direction) {
        const section = document.createElement('div');
        section.className = 'section';
        const h3 = document.createElement('h3');
        h3.textContent = title;
        section.appendChild(h3);

        if (memberships.length > 0) {
          const table = document.createElement('table');
          table.className = 'table';
          table.innerHTML = '<thead><tr><th>Role</th><th>Membership Mode</th><th>Status</th><th>Action</th></tr></thead>';
          const body = document.createElement('tbody');
          
          memberships.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.appendChild(cell(row.roleName));
            
            const privTypeCell = document.createElement('td');
            const privSelect = document.createElement('select');
            privSelect.className = 'select';
            privSelect.style.maxWidth = '140px';
            for (const [value, label] of [['inherit', 'Inherit'], ['admin', 'Admin Option']]) {
              const option = document.createElement('option');
              option.value = value;
              option.textContent = label;
              option.selected = (row.privilegeType || 'inherit') === value;
              privSelect.appendChild(option);
            }
            privSelect.addEventListener('change', () => {
              memberships[index].privilegeType = privSelect.value;
              renderMembership();
              sendState();
            });
            privTypeCell.appendChild(privSelect);
            tr.appendChild(privTypeCell);
            
            // Status
            tr.appendChild(cell(row.enabled ? 'Granted' : 'Revoked', !row.enabled));
            
            // Action buttons
            const actionCell = document.createElement('td');
            actionCell.style.display = 'flex';
            actionCell.style.gap = '4px';
            
            const toggleBtn = document.createElement('button');
            toggleBtn.className = row.enabled ? 'btn btn-danger' : 'btn';
            toggleBtn.style.padding = '4px 8px';
            toggleBtn.style.fontSize = '11px';
            toggleBtn.textContent = row.enabled ? 'Revoke' : 'Grant';
            toggleBtn.addEventListener('click', () => {
              memberships[index].enabled = !memberships[index].enabled;
              renderMembership();
              sendState();
            });
            actionCell.appendChild(toggleBtn);
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'btn';
            removeBtn.style.padding = '4px 8px';
            removeBtn.style.fontSize = '11px';
            removeBtn.style.color = 'var(--danger)';
            removeBtn.textContent = '✕';
            removeBtn.addEventListener('click', () => {
              memberships.splice(index, 1);
              renderMembership();
              sendState();
            });
            actionCell.appendChild(removeBtn);
            
            tr.appendChild(actionCell);
            body.appendChild(tr);
          });
          table.appendChild(body);
          section.appendChild(table);
        } else {
          const empty = document.createElement('div');
          empty.className = 'empty';
          empty.textContent = 'No roles added';
          section.appendChild(empty);
        }

        // Add new role selector
        const addDiv = document.createElement('div');
        addDiv.style.marginTop = '12px';
        addDiv.style.display = 'flex';
        addDiv.style.gap = '8px';
        addDiv.style.alignItems = 'center';

        const select = document.createElement('select');
        select.className = 'select';
        select.style.flex = '1';
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'Select a role...';
        select.appendChild(opt);

        // Filter out already added roles
        const addedRoles = new Set(memberships.map(m => m.roleName));
        state.availableRoles.forEach(roleName => {
          if (!addedRoles.has(roleName)) {
            const option = document.createElement('option');
            option.value = roleName;
            option.textContent = roleName;
            select.appendChild(option);
          }
        });

        addDiv.appendChild(select);

        const privilegeSelect = document.createElement('select');
        privilegeSelect.className = 'select';
        privilegeSelect.style.maxWidth = '140px';
        const inheritOption = document.createElement('option');
        inheritOption.value = 'inherit';
        inheritOption.textContent = 'Inherit';
        privilegeSelect.appendChild(inheritOption);
        const adminOption = document.createElement('option');
        adminOption.value = 'admin';
        adminOption.textContent = 'Admin Option';
        privilegeSelect.appendChild(adminOption);
        addDiv.appendChild(privilegeSelect);

        const addBtn = document.createElement('button');
        addBtn.className = 'btn btn-primary';
        addBtn.style.whiteSpace = 'nowrap';
        addBtn.textContent = '+ Add';
        addBtn.addEventListener('click', () => {
          const roleName = select.value.trim();
          if (!roleName) return;
          memberships.push({
            roleName,
            enabled: true,
            privilegeType: privilegeSelect.value,
            lastLogin: null,
          });
          renderMembership();
          sendState();
        });
        addDiv.appendChild(addBtn);

        section.appendChild(addDiv);
        return section;
      }

      pane.appendChild(renderMembershipTable('Member of (inherits privileges from)', state.memberOf, 'memberOf'));
      pane.appendChild(renderMembershipTable('Members (roles that inherit from this role)', state.members, 'members'));
    }

    function renderSchemaPrivileges() {
      const pane = document.getElementById('tab-schema');
      pane.innerHTML = '';

      const section = document.createElement('div');
      section.className = 'section';
      section.innerHTML = '<h3>Schema Privileges</h3>';
      const table = document.createElement('table');
      table.className = 'table';
      table.innerHTML = '<thead><tr><th>Schema</th><th>USAGE</th><th>CREATE</th><th>ALL TABLES SELECT</th></tr></thead>';
      const body = document.createElement('tbody');
      state.schemaPrivileges.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(row.schemaName));
        tr.appendChild(checkCell(row.usage, checked => { state.schemaPrivileges[index].usage = checked; sendState(); }));
        tr.appendChild(checkCell(row.create, checked => { state.schemaPrivileges[index].create = checked; sendState(); }));
        tr.appendChild(checkCell(row.selectAllTables, checked => { state.schemaPrivileges[index].selectAllTables = checked; sendState(); }));
        body.appendChild(tr);
      });
      table.appendChild(body);
      section.appendChild(table);
      pane.appendChild(section);

      const overrides = document.createElement('div');
      overrides.className = 'section';
      overrides.innerHTML = '<h3>Table Overrides</h3><div class="muted">Fine-grained privileges on a specific table.</div>';
      const tableOverrideTable = document.createElement('table');
      tableOverrideTable.className = 'table';
      tableOverrideTable.innerHTML = '<thead><tr><th>Schema</th><th>Table</th><th>SELECT</th><th>INSERT</th><th>UPDATE</th><th>DELETE</th></tr></thead>';
      const tbody = document.createElement('tbody');
      state.tablePrivileges.forEach((row, index) => {
        const tr = document.createElement('tr');
        tr.appendChild(cell(row.schemaName));
        tr.appendChild(cell(row.tableName));
        tr.appendChild(checkCell(row.select, checked => { state.tablePrivileges[index].select = checked; sendState(); }));
        tr.appendChild(checkCell(row.insert, checked => { state.tablePrivileges[index].insert = checked; sendState(); }));
        tr.appendChild(checkCell(row.update, checked => { state.tablePrivileges[index].update = checked; sendState(); }));
        tr.appendChild(checkCell(row.delete, checked => { state.tablePrivileges[index].delete = checked; sendState(); }));
        tbody.appendChild(tr);
      });
      const addRow = document.createElement('tr');
      addRow.innerHTML = '<td><input class="input" id="new-schema" placeholder="schema"></td><td><input class="input" id="new-table" placeholder="table_name"></td>';
      addRow.appendChild(checkCell(false, () => {}));
      addRow.appendChild(checkCell(false, () => {}));
      addRow.appendChild(checkCell(false, () => {}));
      addRow.appendChild(checkCell(false, () => {}));
      tbody.appendChild(addRow);
      tableOverrideTable.appendChild(tbody);
      overrides.appendChild(tableOverrideTable);
      const addBtn = document.createElement('button');
      addBtn.className = 'btn';
      addBtn.textContent = '+ Add table override';
      addBtn.addEventListener('click', () => {
        const schema = document.getElementById('new-schema').value.trim();
        const tableName = document.getElementById('new-table').value.trim();
        if (!schema || !tableName) {
          return;
        }
        state.tablePrivileges.push({ schemaName: schema, tableName, select: false, insert: false, update: false, delete: false });
        renderSchemaPrivileges();
        sendState();
      });
      overrides.appendChild(addBtn);
      pane.appendChild(overrides);
    }

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el === tab));
        document.querySelectorAll('.pane').forEach(el => el.classList.remove('active'));
        document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      });
    });

    document.getElementById('copy-sql').addEventListener('click', () => {
      vscode.postMessage({ type: 'copySql', state });
    });
    document.getElementById('open-notebook').addEventListener('click', () => {
      vscode.postMessage({ type: 'openNotebook', state });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'previewUpdated') {
        setPreview(message.html);
      }
    });

    renderProperties();
    renderDatabasePrivileges();
    renderMembership();
    renderSchemaPrivileges();
    setPreview(${JSON.stringify(buildRolePreviewHtml(state)).replace(/</g, '\\u003c')});
    sendState();
  </script>
</body>
</html>`;
  }

  private dispose(): void {
    RoleDesignerPanel._panels.forEach((panel, key) => {
      if (panel === this) {
        RoleDesignerPanel._panels.delete(key);
      }
    });

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      disposable?.dispose();
    }
  }
}
