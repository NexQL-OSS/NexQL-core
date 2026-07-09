import * as vscode from 'vscode';
import { ErrorHandlers } from '../commands/helper';
import { createAndShowNotebook } from '../commands/connection';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { resolveTreeItemConnection } from './connectionHelper';
import { AiService } from '../providers/chat/AiService';
import { TelemetryService } from '../services/TelemetryService';
import {
  PolicyDefinition,
  PolicyCommand,
  buildPolicyScript,
} from '../commands/sql/policies';
import { parseAiPolicy } from './policyAi';

interface ColumnInfo {
  name: string;
  type: string;
}

/** Everything the studio needs: the table context plus the policy being designed. */
interface PolicyStudioState {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  availableRoles: string[];
  existingPolicies: string[];
  rlsEnabled: boolean;
  // Policy under design
  name: string;
  permissive: boolean;
  command: PolicyCommand;
  roles: string[];
  using: string;
  withCheck: string;
}

/**
 * RLS Policy Studio — a visual, click-to-configure designer for PostgreSQL
 * row-level security policies with AI assistance. Mirrors the table/role
 * designers: live SQL preview on the right, "Open in Notebook" to execute.
 */
export class RlsPolicyStudioPanel {
  public static readonly viewType = 'pgStudio.rlsPolicyStudio';
  private static _panels = new Map<string, RlsPolicyStudioPanel>();

  private readonly _panel: vscode.WebviewPanel;
  private readonly _disposables: vscode.Disposable[] = [];
  private readonly _aiService = new AiService();
  private _state: PolicyStudioState;
  private _metadata: any;

  private constructor(panel: vscode.WebviewPanel, state: PolicyStudioState, metadata: any) {
    this._panel = panel;
    this._state = state;
    this._metadata = metadata;
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    TelemetryService.getInstance().trackDesignerOpened('rls');
  }

  public static async openForTable(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
    let dbConn: Awaited<ReturnType<typeof resolveTreeItemConnection>> | undefined;
    try {
      const schema = item.schema;
      const table = item.tableName || (item.type === 'table' ? item.label : undefined);
      if (!schema || !table) {
        await vscode.window.showErrorMessage('Select a table (or its Policies node) to design an RLS policy.');
        return;
      }

      dbConn = await resolveTreeItemConnection(item);
      if (!dbConn) {
        return;
      }
      const { client, metadata } = dbConn;
      const panelKey = `${item.connectionId}:${item.databaseName}:${schema}.${table}`;
      if (RlsPolicyStudioPanel._panels.has(panelKey)) {
        RlsPolicyStudioPanel._panels.get(panelKey)!._panel.reveal(vscode.ViewColumn.One);
        return;
      }

      const columnsResult = await client.query(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
         ORDER BY a.attnum`,
        [schema, table],
      );
      const rlsResult = await client.query(
        `SELECT c.relrowsecurity AS enabled
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
      );
      const policiesResult = await client.query(
        `SELECT p.polname AS name
         FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relname = $2
         ORDER BY p.polname`,
        [schema, table],
      );
      const rolesResult = await client.query(
        `SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg_%' ORDER BY rolname`,
      );

      const state: PolicyStudioState = {
        schema,
        table,
        columns: columnsResult.rows.map((r: any) => ({ name: r.name, type: r.type })),
        availableRoles: rolesResult.rows.map((r: any) => r.rolname),
        existingPolicies: policiesResult.rows.map((r: any) => r.name),
        rlsEnabled: !!rlsResult.rows[0]?.enabled,
        name: '',
        permissive: true,
        command: 'ALL',
        roles: [],
        using: '',
        withCheck: '',
      };

      const panel = vscode.window.createWebviewPanel(
        RlsPolicyStudioPanel.viewType,
        `RLS Policy Studio · ${schema}.${table}`,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources')],
        },
      );

      const studio = new RlsPolicyStudioPanel(panel, state, metadata);
      RlsPolicyStudioPanel._panels.set(panelKey, studio);
      panel.onDidDispose(() => RlsPolicyStudioPanel._panels.delete(panelKey));

      panel.webview.html = studio._getHtml();
      panel.webview.onDidReceiveMessage((msg) => studio._onMessage(msg), null, studio._disposables);
    } catch (err: any) {
      await ErrorHandlers.handleCommandError(err, 'open RLS policy studio');
    } finally {
      dbConn?.release?.();
    }
  }

  private async _onMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'stateChanged':
        this._state = { ...this._state, ...msg.policy };
        this._panel.webview.postMessage({ type: 'previewUpdated', sql: this._buildScript() });
        break;
      case 'generateAi':
        await this._handleAi(String(msg.nl || ''));
        break;
      case 'copySql':
        await vscode.env.clipboard.writeText(this._buildScript());
        void vscode.window.showInformationMessage('RLS policy SQL copied to clipboard.');
        break;
      case 'openNotebook':
        await this._openNotebook();
        break;
    }
  }

  private _definition(): PolicyDefinition {
    const s = this._state;
    return {
      schema: s.schema,
      table: s.table,
      name: s.name || 'new_policy',
      permissive: s.permissive,
      command: s.command,
      roles: s.roles,
      using: s.using.trim() || undefined,
      withCheck: s.withCheck.trim() || undefined,
    };
  }

  private _buildScript(): string {
    return buildPolicyScript(this._definition(), !this._state.rlsEnabled);
  }

  private async _openNotebook(): Promise<void> {
    const s = this._state;
    if (!s.name.trim()) {
      void vscode.window.showWarningMessage('Give the policy a name before opening the notebook.');
      return;
    }
    const md =
      `# Create RLS policy: ${s.name}\n\n` +
      `Policy on \`${s.schema}.${s.table}\` — **${s.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'}**, ` +
      `\`FOR ${s.command}\`, applies to ${s.roles.length ? s.roles.join(', ') : 'PUBLIC'}.\n\n` +
      `Review each cell, then run.`;
    const cells = [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, md, 'markdown'),
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, this._buildScript(), 'sql'),
    ];
    await createAndShowNotebook(cells, this._metadata);
  }

  private async _handleAi(nl: string): Promise<void> {
    if (!nl.trim()) {
      this._panel.webview.postMessage({ type: 'aiError', message: 'Describe the access rule first.' });
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration('postgresExplorer');
      const { readAiScopeSettings } = await import('../features/aiAssistant/aiConfig');
      const provider = readAiScopeSettings(config, 'notebook').provider;
      try {
        await this._aiService.getModelInfo(provider, config, 'notebook');
      } catch {
        this._panel.webview.postMessage({
          type: 'aiError',
          message: 'AI is not configured. Set up an AI provider in settings, or write the expressions manually.',
        });
        return;
      }

      const s = this._state;
      const cols = s.columns.map((c) => `${c.name} ${c.type}`).join(', ');
      const system =
        'You are a PostgreSQL row-level security (RLS) expert. Given a table schema, the target command, ' +
        'and a natural-language access rule, produce the policy predicate expressions. ' +
        'Respond with ONLY minified JSON of the form ' +
        '{"using":"<sql boolean expression or empty>","withCheck":"<sql boolean expression or empty>","name":"<short snake_case policy name>","explanation":"<one sentence>"}. ' +
        'Use only columns that exist in the schema. When the rule references the current user/tenant/app context, ' +
        "use current_setting('app.<key>', true) or session_user as appropriate. " +
        'USING applies to SELECT/UPDATE/DELETE; WITH CHECK applies to INSERT/UPDATE. ' +
        'Do NOT emit CREATE POLICY — only the expressions. Do not wrap in code fences.';
      const prompt =
        `Table: ${s.schema}.${s.table}\nColumns: ${cols}\nCommand: FOR ${s.command}\n` +
        `Access rule: ${nl.trim()}`;

      const result = await this._aiService.callProvider(provider, prompt, config, system, 'notebook');
      const parsed = parseAiPolicy(result.text);
      if (!parsed) {
        this._panel.webview.postMessage({
          type: 'aiError',
          message: 'Could not parse the AI response. Try rephrasing the rule.',
        });
        return;
      }
      this._panel.webview.postMessage({ type: 'aiResult', ...parsed });
    } catch (err: any) {
      this._panel.webview.postMessage({ type: 'aiError', message: `AI request failed: ${err?.message || String(err)}` });
    }
  }

  private _getHtml(): string {
    const nonce = Math.random().toString(36).slice(2);
    const initial = JSON.stringify(this._state).replace(/</g, '\\u003c');
    const initialSql = JSON.stringify(this._buildScript()).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RLS Policy Studio</title>
<style>
  :root {
    --bg: var(--vscode-editor-background); --bg2: var(--vscode-sideBar-background);
    --bg3: var(--vscode-input-background); --border: var(--vscode-editorWidget-border, var(--vscode-panel-border));
    --text: var(--vscode-editor-foreground); --muted: var(--vscode-descriptionForeground);
    --accent: var(--vscode-focusBorder); --ok: #4ec9b0; --warn: #dcdcaa; --danger: #f44747; --kw: #569cd6; --str: #ce9178;
  }
  * { box-sizing: border-box; }
  body { margin:0; font-family: var(--vscode-font-family, sans-serif); font-size:13px; color:var(--text); background:var(--bg); }
  .shell { display:grid; grid-template-columns: minmax(0,1fr) 380px; height:100vh; }
  .left { display:flex; flex-direction:column; min-width:0; border-right:1px solid var(--border); overflow:auto; }
  .titlebar { display:flex; align-items:center; gap:10px; padding:10px 14px; background:var(--bg2); border-bottom:1px solid var(--border); position:sticky; top:0; z-index:2; }
  .title { font-weight:600; }
  .badge { border-radius:999px; padding:2px 9px; font-size:11px; font-weight:600; background: rgba(78,201,176,0.14); color:var(--ok); }
  .badge-tbl { background: rgba(86,156,214,0.16); color: var(--kw); }
  .body { padding:14px; }
  .section { margin-bottom:18px; }
  .section h3 { margin:0 0 6px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .hint { font-size:11px; color:var(--muted); margin:2px 0 8px; }
  .field { margin-bottom:12px; }
  .field > label { display:block; font-weight:600; margin-bottom:4px; }
  .input, .select, textarea { width:100%; padding:7px 9px; border-radius:5px; border:1px solid var(--border); color:var(--text); background:var(--bg3); font:inherit; }
  textarea { resize:vertical; min-height:54px; font-family: var(--vscode-editor-font-family, monospace); }
  .opts { display:flex; flex-wrap:wrap; gap:8px; }
  .opt { border:1px solid var(--border); border-radius:6px; padding:8px 11px; cursor:pointer; background:var(--bg3); min-width:92px; }
  .opt:hover { border-color: var(--accent); }
  .opt.sel { border-color: var(--accent); background: rgba(0,122,204,0.16); }
  .opt .ot { font-weight:600; }
  .opt .od { font-size:11px; color:var(--muted); margin-top:2px; }
  .roles { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { display:inline-flex; align-items:center; gap:5px; border:1px solid var(--border); border-radius:999px; padding:3px 9px; cursor:pointer; }
  .chip.on { border-color: var(--accent); background: rgba(0,122,204,0.16); }
  .ai { border:1px solid rgba(86,156,214,0.4); border-radius:8px; padding:12px; background: rgba(86,156,214,0.06); }
  .ai h3 { color: var(--kw); }
  .row { display:flex; gap:8px; align-items:center; }
  .btn { padding:7px 12px; border-radius:5px; border:1px solid var(--border); background:transparent; color:var(--text); cursor:pointer; font:inherit; }
  .btn:hover { border-color: var(--accent); }
  .btn-primary { background: rgba(0,122,204,0.18); border-color: rgba(0,122,204,0.45); }
  .btn-ai { background: rgba(86,156,214,0.2); border-color: rgba(86,156,214,0.5); color: var(--kw); font-weight:600; }
  .btn:disabled { opacity:.5; cursor:default; }
  .ai-msg { font-size:11px; margin-top:8px; min-height:14px; }
  .ai-msg.err { color: var(--danger); }
  .ai-msg.ok { color: var(--ok); }
  .right { display:flex; flex-direction:column; min-width:0; background:var(--bg2); }
  .preview-header { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid var(--border); }
  .preview-title { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  pre.preview { flex:1; margin:0; padding:14px; overflow:auto; font-family: var(--vscode-editor-font-family, monospace); font-size:12.5px; line-height:1.6; white-space:pre-wrap; }
  .kw { color: var(--kw); } .str { color: var(--str); } .cmt { color: var(--muted); font-style: italic; }
  .footer { border-top:1px solid var(--border); padding:12px 14px; display:flex; flex-direction:column; gap:8px; }
  .footer .btn { width:100%; }
  .warnbox { font-size:11px; color: var(--warn); margin-top:6px; }
  .spinner { display:none; width:13px; height:13px; border:2px solid var(--muted); border-top-color: var(--kw); border-radius:50%; animation: spin .7s linear infinite; }
  .spinner.on { display:inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head>
<body>
  <div class="shell">
    <div class="left">
      <div class="titlebar">
        <span class="title">RLS Policy Studio</span>
        <span class="badge">AI</span>
        <span class="badge badge-tbl" id="tbl"></span>
      </div>
      <div class="body">
        <div class="section ai">
          <h3>✨ Describe the rule</h3>
          <div class="hint">Plain English — e.g. "users can only see rows for their own tenant" or "only the row owner may update".</div>
          <textarea id="ai-input" placeholder="Describe who can access which rows..."></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn btn-ai" id="ai-go">Generate with AI</button>
            <span class="spinner" id="ai-spin"></span>
          </div>
          <div class="ai-msg" id="ai-msg"></div>
        </div>

        <div class="section">
          <h3>Policy name</h3>
          <input class="input" id="f-name" placeholder="e.g. tenant_isolation" />
          <div class="hint" id="name-warn"></div>
        </div>

        <div class="section">
          <h3>Command</h3>
          <div class="hint">Which SQL operations this policy governs.</div>
          <div class="opts" id="cmd-opts"></div>
        </div>

        <div class="section">
          <h3>Policy type</h3>
          <div class="opts" id="perm-opts"></div>
        </div>

        <div class="section">
          <h3>Applies to roles</h3>
          <div class="hint">No selection → <code>PUBLIC</code> (all roles).</div>
          <div class="roles" id="roles"></div>
        </div>

        <div class="section" id="using-field">
          <h3>USING expression <span class="hint" style="text-transform:none">— row visibility</span></h3>
          <div class="hint">Boolean predicate evaluated per existing row (SELECT/UPDATE/DELETE).</div>
          <textarea id="f-using" placeholder="e.g. tenant_id = current_setting('app.tenant_id', true)::uuid"></textarea>
        </div>

        <div class="section" id="check-field">
          <h3>WITH CHECK expression <span class="hint" style="text-transform:none">— new/updated rows</span></h3>
          <div class="hint">Predicate that new or updated rows must satisfy (INSERT/UPDATE).</div>
          <textarea id="f-check" placeholder="e.g. tenant_id = current_setting('app.tenant_id', true)::uuid"></textarea>
        </div>
      </div>
    </div>
    <div class="right">
      <div class="preview-header">
        <span class="preview-title">SQL Preview</span>
        <span class="preview-title" id="rls-state"></span>
      </div>
      <pre class="preview" id="preview"></pre>
      <div class="footer">
        <button class="btn btn-primary" id="open-notebook">Open in Notebook</button>
        <button class="btn" id="copy-sql">Copy SQL</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = ${initial};
    const COMMANDS = [
      ['ALL', 'SELECT, INSERT, UPDATE, DELETE'],
      ['SELECT', 'Read visibility (USING)'],
      ['INSERT', 'New rows (WITH CHECK)'],
      ['UPDATE', 'USING + WITH CHECK'],
      ['DELETE', 'Row visibility (USING)'],
    ];
    const PERMS = [
      [true, 'PERMISSIVE', 'Combine with OR (default)'],
      [false, 'RESTRICTIVE', 'Combine with AND (narrows)'],
    ];

    document.getElementById('tbl').textContent = state.schema + '.' + state.table;

    function send() { vscode.postMessage({ type: 'stateChanged', policy: state }); }

    function applicability() {
      const c = state.command;
      document.getElementById('using-field').style.display = (c !== 'INSERT') ? '' : 'none';
      document.getElementById('check-field').style.display = (c === 'INSERT' || c === 'UPDATE' || c === 'ALL') ? '' : 'none';
    }

    function renderCommands() {
      const wrap = document.getElementById('cmd-opts'); wrap.innerHTML = '';
      for (const [val, desc] of COMMANDS) {
        const d = document.createElement('div');
        d.className = 'opt' + (state.command === val ? ' sel' : '');
        d.innerHTML = '<div class="ot">' + val + '</div><div class="od">' + desc + '</div>';
        d.onclick = () => { state.command = val; renderCommands(); applicability(); send(); };
        wrap.appendChild(d);
      }
    }
    function renderPerms() {
      const wrap = document.getElementById('perm-opts'); wrap.innerHTML = '';
      for (const [val, name, desc] of PERMS) {
        const d = document.createElement('div');
        d.className = 'opt' + (state.permissive === val ? ' sel' : '');
        d.innerHTML = '<div class="ot">' + name + '</div><div class="od">' + desc + '</div>';
        d.onclick = () => { state.permissive = val; renderPerms(); send(); };
        wrap.appendChild(d);
      }
    }
    function renderRoles() {
      const wrap = document.getElementById('roles'); wrap.innerHTML = '';
      const set = new Set(state.roles);
      for (const role of state.availableRoles) {
        const c = document.createElement('span');
        c.className = 'chip' + (set.has(role) ? ' on' : '');
        c.textContent = role;
        c.onclick = () => {
          const i = state.roles.indexOf(role);
          if (i >= 0) state.roles.splice(i, 1); else state.roles.push(role);
          renderRoles(); send();
        };
        wrap.appendChild(c);
      }
    }
    function refreshName() {
      const warn = document.getElementById('name-warn');
      if (state.existingPolicies.includes(state.name.trim())) {
        warn.textContent = '⚠ A policy with this name already exists on the table.';
        warn.style.color = 'var(--warn)';
      } else { warn.textContent = ''; }
    }

    function highlight(sql) {
      const esc = sql.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return esc
        .replace(/(--[^\\n]*)/g, '<span class="cmt">$1</span>')
        .replace(/('(?:[^']|'')*')/g, '<span class="str">$1</span>')
        .replace(/\\b(CREATE|POLICY|ON|AS|PERMISSIVE|RESTRICTIVE|FOR|TO|USING|WITH|CHECK|ALTER|TABLE|ENABLE|ROW|LEVEL|SECURITY|ALL|SELECT|INSERT|UPDATE|DELETE|PUBLIC)\\b/g, '<span class="kw">$1</span>');
    }
    function setPreview(sql) {
      document.getElementById('preview').innerHTML = highlight(sql);
      document.getElementById('rls-state').textContent = state.rlsEnabled ? 'RLS already enabled' : 'will ENABLE RLS';
    }

    // Inputs
    document.getElementById('f-name').addEventListener('input', e => { state.name = e.target.value; refreshName(); send(); });
    document.getElementById('f-using').addEventListener('input', e => { state.using = e.target.value; send(); });
    document.getElementById('f-check').addEventListener('input', e => { state.withCheck = e.target.value; send(); });

    document.getElementById('copy-sql').onclick = () => vscode.postMessage({ type: 'copySql' });
    document.getElementById('open-notebook').onclick = () => vscode.postMessage({ type: 'openNotebook' });

    const aiBtn = document.getElementById('ai-go');
    const aiSpin = document.getElementById('ai-spin');
    const aiMsg = document.getElementById('ai-msg');
    aiBtn.onclick = () => {
      const nl = document.getElementById('ai-input').value;
      aiMsg.textContent = ''; aiMsg.className = 'ai-msg';
      aiBtn.disabled = true; aiSpin.classList.add('on');
      vscode.postMessage({ type: 'generateAi', nl });
    };

    window.addEventListener('message', ev => {
      const m = ev.data;
      if (m.type === 'previewUpdated') { setPreview(m.sql); }
      else if (m.type === 'aiResult') {
        aiBtn.disabled = false; aiSpin.classList.remove('on');
        if (typeof m.using === 'string') { state.using = m.using; document.getElementById('f-using').value = m.using; }
        if (typeof m.withCheck === 'string') { state.withCheck = m.withCheck; document.getElementById('f-check').value = m.withCheck; }
        if (m.name && !state.name.trim()) { state.name = m.name; document.getElementById('f-name').value = m.name; refreshName(); }
        aiMsg.textContent = m.explanation ? ('✓ ' + m.explanation) : '✓ Generated.';
        aiMsg.className = 'ai-msg ok';
        send();
      } else if (m.type === 'aiError') {
        aiBtn.disabled = false; aiSpin.classList.remove('on');
        aiMsg.textContent = m.message; aiMsg.className = 'ai-msg err';
      }
    });

    renderCommands(); renderPerms(); renderRoles(); applicability(); refreshName();
    setPreview(${initialSql});
    send();
  </script>
</body></html>`;
  }

  private dispose(): void {
    RlsPolicyStudioPanel._panels.forEach((p, key) => {
      if (p === this) { RlsPolicyStudioPanel._panels.delete(key); }
    });
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}
