// PgStudio Settings Hub webview controller.
// Message protocol: webview → host `{ command: '<section>/<action>', ... }`,
// host → webview `{ type: '<section>/<event>', ... }`.

const vscode = acquireVsCodeApi();
const initialState = {{INITIAL_STATE}};

window.onerror = function (msg) {
  console.error('[PgStudio Settings Hub] Error:', msg);
};

const $ = (id) => document.getElementById(id);

// ─────────────────────────────────────────────────────────────────────────────
// Theme-safe custom selects (native <option> styling breaks in VS Code webviews)
// ─────────────────────────────────────────────────────────────────────────────

const pgSelectRegistry = new WeakMap();
let pgSelectOutsideListenerBound = false;
const PG_SELECT_PANEL_MAX_HEIGHT_PX = 260;
const PG_SELECT_PANEL_GAP_PX = 4;
const PG_SELECT_PANEL_MIN_WIDTH_PX = 128;

function resetPgSelectPanelPosition(panel) {
  if (!panel) { return; }
  panel.classList.remove('pg-select-panel--floating');
  panel.style.position = '';
  panel.style.left = '';
  panel.style.top = '';
  panel.style.bottom = '';
  panel.style.width = '';
  panel.style.right = '';
  panel.style.maxHeight = '';
}

function positionPgSelectPanel(trigger, panel) {
  const rect = trigger.getBoundingClientRect();
  const gap = PG_SELECT_PANEL_GAP_PX;
  const maxH = PG_SELECT_PANEL_MAX_HEIGHT_PX;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const openUp = spaceBelow < 120 && spaceAbove > spaceBelow;

  panel.classList.add('pg-select-panel--floating');
  panel.style.position = 'fixed';
  panel.style.left = rect.left + 'px';
  panel.style.width = Math.max(rect.width, PG_SELECT_PANEL_MIN_WIDTH_PX) + 'px';
  panel.style.right = 'auto';

  if (openUp) {
    panel.style.top = 'auto';
    panel.style.bottom = (window.innerHeight - rect.top + gap) + 'px';
    panel.style.maxHeight = Math.min(maxH, spaceAbove) + 'px';
  } else {
    panel.style.top = (rect.bottom + gap) + 'px';
    panel.style.bottom = 'auto';
    panel.style.maxHeight = Math.min(maxH, spaceBelow) + 'px';
  }
}

function closePgSelect(wrap) {
  if (!wrap) { return; }
  wrap.classList.remove('is-open');
  const panel = wrap.querySelector('.pg-select-panel');
  const trigger = wrap.querySelector('.pg-select-trigger');
  if (panel) {
    panel.hidden = true;
    resetPgSelectPanelPosition(panel);
  }
  if (trigger) { trigger.setAttribute('aria-expanded', 'false'); }
}

function closeAllPgSelects(exceptWrap) {
  document.querySelectorAll('.pg-select.is-open').forEach((wrap) => {
    if (wrap !== exceptWrap) { closePgSelect(wrap); }
  });
}

function bindPgSelectOutsideClick() {
  if (pgSelectOutsideListenerBound) { return; }
  pgSelectOutsideListenerBound = true;
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.pg-select')) {
      closeAllPgSelects();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeAllPgSelects(); }
  });
  const hubContent = document.querySelector('.hub-content');
  if (hubContent) {
    hubContent.addEventListener('scroll', () => closeAllPgSelects(), { passive: true });
  }
  window.addEventListener('resize', () => closeAllPgSelects());
}

function syncPgSelectWrapClasses(selectEl, wrap) {
  wrap.className = 'pg-select';
  if (selectEl.dataset.pgSelectVariant === 'env') {
    wrap.classList.add('pg-select--env', 'pg-select--compact');
  }
  selectEl.classList.forEach((cls) => {
    if (cls.startsWith('env-') && cls !== 'env-select') {
      wrap.classList.add(cls);
    }
  });
}

function enhanceSelect(selectEl) {
  if (!selectEl || selectEl.dataset.pgSelect === 'true') { return; }
  selectEl.dataset.pgSelect = 'true';
  bindPgSelectOutsideClick();

  const wrap = document.createElement('div');
  syncPgSelectWrapClasses(selectEl, wrap);

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'pg-select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (selectEl.id) {
    trigger.id = selectEl.id + '-trigger';
    const label = document.querySelector('label[for="' + selectEl.id + '"]');
    if (label) {
      if (!label.id) { label.id = selectEl.id + '-label'; }
      label.setAttribute('for', trigger.id);
      trigger.setAttribute('aria-labelledby', label.id);
    }
  }

  const valueSpan = document.createElement('span');
  valueSpan.className = 'pg-select-value';

  const chevron = document.createElement('span');
  chevron.className = 'pg-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  trigger.appendChild(valueSpan);
  trigger.appendChild(chevron);

  const panel = document.createElement('div');
  panel.className = 'pg-select-panel';
  panel.setAttribute('role', 'listbox');
  panel.hidden = true;

  selectEl.classList.add('pg-select-native');
  selectEl.parentNode.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);
  wrap.appendChild(trigger);
  wrap.appendChild(panel);

  function rebuildOptions() {
    panel.textContent = '';
    Array.from(selectEl.options).forEach((opt) => {
      const optionBtn = document.createElement('button');
      optionBtn.type = 'button';
      optionBtn.className = 'pg-select-option';
      optionBtn.setAttribute('role', 'option');
      optionBtn.dataset.value = opt.value;
      optionBtn.textContent = opt.textContent;
      optionBtn.disabled = !!opt.disabled;
      if (opt.value === selectEl.value) {
        optionBtn.classList.add('is-selected');
        optionBtn.setAttribute('aria-selected', 'true');
      }
      optionBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        selectEl.value = opt.value;
        syncDisplay();
        closePgSelect(wrap);
        selectEl.dispatchEvent(new Event('change', { bubbles: true }));
      });
      panel.appendChild(optionBtn);
    });
    syncDisplay();
  }

  function syncDisplay() {
    syncPgSelectWrapClasses(selectEl, wrap);
    const selected = selectEl.options[selectEl.selectedIndex];
    valueSpan.textContent = selected ? selected.textContent : 'Select…';
    trigger.disabled = !!selectEl.disabled;
    panel.querySelectorAll('.pg-select-option').forEach((btn) => {
      const isSelected = btn.dataset.value === selectEl.value;
      btn.classList.toggle('is-selected', isSelected);
      btn.setAttribute('aria-selected', String(isSelected));
    });
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    if (selectEl.disabled) { return; }
    if (wrap.classList.contains('is-open')) {
      closePgSelect(wrap);
      return;
    }
    closeAllPgSelects(wrap);
    wrap.classList.add('is-open');
    panel.hidden = false;
    positionPgSelectPanel(trigger, panel);
    trigger.setAttribute('aria-expanded', 'true');
    const selectedBtn = panel.querySelector('.pg-select-option.is-selected');
    if (selectedBtn) { selectedBtn.focus(); }
  });

  const observer = new MutationObserver(() => rebuildOptions());
  observer.observe(selectEl, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled'] });

  selectEl.addEventListener('change', syncDisplay);

  pgSelectRegistry.set(selectEl, { rebuildOptions, syncDisplay, wrap, observer });
  rebuildOptions();
}

function setSelectValue(selectEl, value) {
  if (!selectEl) { return; }
  selectEl.value = value;
  const state = pgSelectRegistry.get(selectEl);
  if (state) { state.syncDisplay(); }
}

function enhanceAllSelects(root) {
  const scope = root || document;
  scope.querySelectorAll('select:not([data-pg-select="true"])').forEach((selectEl) => {
    enhanceSelect(selectEl);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section navigation
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS = ['connections', 'ai', 'prefs', 'sync', 'license'];
let activeSection = null;

function loadSection(section) {
  switch (section) {
    case 'connections': vscode.postMessage({ command: 'connections/load' }); break;
    case 'ai': vscode.postMessage({ command: 'ai/load' }); break;
    case 'prefs': vscode.postMessage({ command: 'prefs/load' }); break;
    case 'sync': vscode.postMessage({ command: 'sync/load' }); break;
    case 'license': vscode.postMessage({ command: 'license/load' }); break;
  }
}

function showSection(section) {
  if (!SECTIONS.includes(section)) { section = 'connections'; }
  activeSection = section;
  SECTIONS.forEach((s) => {
    const el = $('section-' + s);
    if (el) { el.hidden = s !== section; }
  });
  document.querySelectorAll('.nav-item').forEach((btn) => {
    const isActive = btn.dataset.section === section;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });
  loadSection(section);
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showSection(btn.dataset.section));
});

// ─────────────────────────────────────────────────────────────────────────────
// Connections section
// ─────────────────────────────────────────────────────────────────────────────

const connState = {
  rows: [],
  editingId: null,   // id when editing, null when adding
  isTested: false,
  pendingEditId: null, // deep-link: open editor once the list arrives
  pendingAdd: false,
};

const connForm = $('connectionForm');
const connModalBackdrop = $('connModalBackdrop');
const connEditor = $('connEditor');
const connEditorTitle = $('connEditorTitle');

const CONN_ACTION_ICONS = {
  edit: '<svg viewBox="0 0 16 16" fill="none"><path d="M10.5 2.5l3 3L5.5 13.5H2.5v-3L10.5 2.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  test: '<svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9.5 4.5L13 8l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  duplicate: '<svg viewBox="0 0 16 16" fill="none"><rect x="5.5" y="2.5" width="8" height="8" rx="1.2" stroke="currentColor" stroke-width="1.3"/><path d="M2.5 5.5v8a1 1 0 0 0 1 1h8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  delete: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 4.5h9M6 4.5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M6.5 7v4M9.5 7v4M4.5 4.5l.5 8.5a1 1 0 0 0 1 .9h4a1 1 0 0 0 1-.9l.5-8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  confirm: '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.5l3 3 6-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cancel: '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

function syncConnFormSelects() {
  ['environment', 'cloudAuthKind', 'sslmode'].forEach((id) => {
    const el = $(id);
    const state = pgSelectRegistry.get(el);
    if (state) { state.syncDisplay(); }
  });
}

function mkIconBtn(iconKey, title, onClick, opts) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'conn-action-btn' + (opts && opts.danger ? ' danger' : '');
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.innerHTML = CONN_ACTION_ICONS[iconKey] || '';
  if (opts && opts.testId) { btn.dataset.rowTestId = opts.testId; }
  btn.addEventListener('click', onClick);
  return btn;
}

function setIconBtnLoading(btn, loading) {
  if (!btn) { return; }
  btn.classList.toggle('is-loading', !!loading);
  btn.disabled = !!loading;
}
const connTestBtn = $('connTestBtn');
const connSaveBtn = $('connSaveBtn');
const connFormMessage = $('connFormMessage');
const connListState = $('connListState');
const connTable = $('connTable');
const connTableBody = $('connTableBody');
const connEmptyState = $('connEmptyState');

function escapeText(value) {
  return value === undefined || value === null ? '' : String(value);
}

function connShowFormMessage(text, type, actions) {
  connFormMessage.className = 'message ' + (type || 'info');
  connFormMessage.hidden = false;
  while (connFormMessage.firstChild) { connFormMessage.removeChild(connFormMessage.firstChild); }
  const content = document.createElement('div');
  content.textContent = text;
  connFormMessage.appendChild(content);
  if (actions && actions.length) {
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    actions.forEach((action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn-secondary';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      actionsDiv.appendChild(button);
    });
    connFormMessage.appendChild(actionsDiv);
  }
}

function connHideFormMessage() {
  connFormMessage.hidden = true;
}

function setSaveLabel() {
  connSaveBtn.textContent = connState.editingId ? 'Save Changes' : 'Add Connection';
}

function resetConnForm() {
  connForm.reset();
  $('port').value = '5432';
  $('sshPort').value = '22';
  $('sshDetails').open = false;
  $('advancedDetails').open = false;
  updateSSHState();
  updateSSLCertFields();
  updateProductionWarning();
  connHideFormMessage();
  syncConnFormSelects();
}

function openConnEditor(connection) {
  connState.editingId = connection && connection.id ? connection.id : null;
  connState.isTested = !!connState.editingId; // edit mode allows save without retest
  resetConnForm();

  if (connection) {
    $('name').value = connection.name || '';
    $('host').value = connection.host || '';
    $('port').value = connection.port || 5432;
    $('database').value = connection.database || '';
    $('group').value = connection.group || '';
    $('username').value = connection.username || '';
    $('password').value = connection.password || '';
    $('environment').value = connection.environment || '';
    $('readOnlyMode').checked = !!connection.readOnlyMode;
    if (connection.cloudAuth && connection.cloudAuth.kind) {
      $('cloudAuthKind').value = connection.cloudAuth.kind;
    }
    if (connection.sslmode) { $('sslmode').value = connection.sslmode; }
    if (connection.sslCertPath) { $('sslCertPath').value = connection.sslCertPath; }
    if (connection.sslKeyPath) { $('sslKeyPath').value = connection.sslKeyPath; }
    if (connection.sslRootCertPath) { $('sslRootCertPath').value = connection.sslRootCertPath; }
    if (connection.statementTimeout) { $('statementTimeout').value = connection.statementTimeout; }
    if (connection.connectTimeout) { $('connectTimeout').value = connection.connectTimeout; }
    if (connection.applicationName) { $('applicationName').value = connection.applicationName; }
    if (connection.options) { $('options').value = connection.options; }

    const hasAdvanced = connection.sslmode || connection.statementTimeout ||
      connection.connectTimeout || connection.applicationName || connection.options;
    if (hasAdvanced) {
      $('advancedDetails').open = true;
      updateSSLCertFields();
    }

    if (connection.ssh) {
      $('sshEnabled').checked = !!connection.ssh.enabled;
      $('sshHost').value = connection.ssh.host || '';
      $('sshPort').value = connection.ssh.port || 22;
      $('sshUsername').value = connection.ssh.username || '';
      $('sshKeyPath').value = connection.ssh.privateKeyPath || '';
      $('sshDetails').open = true;
      updateSSHState();
    }
  }

  connEditorTitle.textContent = connState.editingId ? 'Edit Connection' : 'New Connection';
  setSaveLabel();
  connSaveBtn.disabled = !connState.isTested;
  updateProductionWarning();
  syncConnFormSelects();
  connModalBackdrop.hidden = false;
  connEditor.focus();
  $('name').focus();
}

function closeConnEditor() {
  connModalBackdrop.hidden = true;
  connState.editingId = null;
  connState.isTested = false;
}

connModalBackdrop.addEventListener('click', (event) => {
  if (event.target === connModalBackdrop) { closeConnEditor(); }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && connModalBackdrop && !connModalBackdrop.hidden) {
    closeConnEditor();
  }
});

function getConnFormData() {
  const data = {
    name: $('name').value,
    host: $('host').value,
    port: parseInt($('port').value, 10),
    database: $('database').value || 'postgres',
    group: $('group').value || undefined,
    username: $('username').value.trim() || undefined,
    password: $('password').value || undefined,
    environment: $('environment').value || undefined,
    readOnlyMode: $('readOnlyMode').checked || undefined,
    sslmode: $('sslmode').value || undefined,
    sslCertPath: $('sslCertPath').value || undefined,
    sslKeyPath: $('sslKeyPath').value || undefined,
    sslRootCertPath: $('sslRootCertPath').value || undefined,
    statementTimeout: $('statementTimeout').value ? parseInt($('statementTimeout').value, 10) : undefined,
    connectTimeout: $('connectTimeout').value ? parseInt($('connectTimeout').value, 10) : undefined,
    applicationName: $('applicationName').value || undefined,
    options: $('options').value || undefined,
  };

  const authKind = $('cloudAuthKind').value;
  if (authKind && authKind !== 'none') {
    data.cloudAuth = { kind: authKind };
  }

  if ($('sshEnabled').checked) {
    data.ssh = {
      enabled: true,
      host: $('sshHost').value,
      port: parseInt($('sshPort').value, 10),
      username: $('sshUsername').value,
      privateKeyPath: $('sshKeyPath').value,
    };
  }

  return data;
}

// SSH enable/disable
function updateSSHState() {
  const enabled = $('sshEnabled').checked;
  const fields = $('ssh-fields');
  fields.classList.toggle('ssh-fields-disabled', !enabled);
  fields.querySelectorAll('input').forEach((i) => { i.required = enabled; });
}
$('sshEnabled').addEventListener('change', updateSSHState);

// SSL cert fields
function updateSSLCertFields() {
  const sslmode = $('sslmode').value;
  const certFields = $('ssl-cert-fields');
  const needsCerts = sslmode === 'verify-ca' || sslmode === 'verify-full';
  certFields.hidden = !needsCerts;
  $('sslRootCertPath').required = needsCerts;
}
$('sslmode').addEventListener('change', updateSSLCertFields);

$('cloudAuthKind').addEventListener('change', (event) => {
  vscode.postMessage({
    command: 'connections/trackTelemetry',
    event: 'cloud_auth_selected',
    properties: { authKind: event.target.value || 'none' },
  });
});

// Production warning banner
function updateProductionWarning() {
  const isProd = $('environment').value === 'production';
  const isReadOnly = $('readOnlyMode').checked;
  $('productionWarning').hidden = !(isProd && !isReadOnly);
}
$('environment').addEventListener('change', updateProductionWarning);
$('readOnlyMode').addEventListener('change', updateProductionWarning);
$('enableReadOnlyLink').addEventListener('click', (e) => {
  e.preventDefault();
  $('readOnlyMode').checked = true;
  updateProductionWarning();
});

// Any edit invalidates the previous test (in add mode)
connForm.querySelectorAll('input, select').forEach((input) => {
  input.addEventListener('input', () => {
    if (connState.isTested && !connState.editingId) {
      connState.isTested = false;
      connSaveBtn.disabled = true;
      connHideFormMessage();
    }
  });
});

function isSslDowngradeError(errorText) {
  return /blocked automatic SSL downgrade/i.test(errorText || '') ||
    /explicitly set SSL Mode to "Disable — No SSL"/i.test(errorText || '');
}

connTestBtn.addEventListener('click', () => {
  if (!connForm.checkValidity()) {
    connForm.reportValidity();
    return;
  }
  connHideFormMessage();
  connTestBtn.disabled = true;
  connTestBtn.textContent = 'Testing…';
  vscode.postMessage({ command: 'connections/test', connection: getConnFormData() });
});

connForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!connState.isTested) { return; }
  connHideFormMessage();
  connSaveBtn.disabled = true;
  connSaveBtn.textContent = 'Saving…';
  vscode.postMessage({
    command: 'connections/save',
    connection: getConnFormData(),
    editingId: connState.editingId || undefined,
  });
});

$('connAddBtn').addEventListener('click', () => openConnEditor(null));
$('connEmptyAddBtn').addEventListener('click', () => openConnEditor(null));
$('connEditorCloseBtn').addEventListener('click', closeConnEditor);

// .env import
const envPicker = $('connEnvPicker');
const envList = $('connEnvList');

$('connImportEnvBtn').addEventListener('click', () => {
  envPicker.hidden = false;
  envList.textContent = '';
  const li = document.createElement('li');
  li.className = 'label-hint';
  li.textContent = 'Scanning workspace .env files…';
  envList.appendChild(li);
  vscode.postMessage({ command: 'connections/scanEnv' });
});

$('connEnvCancelBtn').addEventListener('click', () => { envPicker.hidden = true; });

$('connEnvPasteBtn').addEventListener('click', () => {
  const url = $('connEnvPasteInput').value.trim();
  if (!url) { return; }
  vscode.postMessage({ command: 'connections/parseEnvUrl', url });
});

function renderEnvCandidates(candidates) {
  envList.textContent = '';
  if (!candidates.length) {
    const li = document.createElement('li');
    li.className = 'label-hint';
    li.textContent = 'No DATABASE_URL-style keys found in workspace .env files. Paste a URL below instead.';
    envList.appendChild(li);
    return;
  }
  candidates.forEach((candidate) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    const label = document.createElement('span');
    label.textContent = candidate.relativePath + ' — ' + candidate.key;
    const preview = document.createElement('span');
    preview.className = 'candidate-preview';
    preview.textContent = candidate.preview || '';
    button.appendChild(label);
    button.appendChild(preview);
    button.addEventListener('click', () => {
      vscode.postMessage({ command: 'connections/parseEnvUrl', url: candidate.value });
    });
    li.appendChild(button);
    envList.appendChild(li);
  });
}

// Table rendering
const ENV_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'development', label: 'Development' },
  { value: 'staging', label: 'Staging' },
  { value: 'production', label: 'Production' },
];

const connSectionSub = $('connSectionSub');

function updateConnSectionSub(count) {
  if (!connSectionSub) { return; }
  if (!count) {
    connSectionSub.textContent = 'PostgreSQL servers available in the explorer';
    return;
  }
  const noun = count === 1 ? 'connection' : 'connections';
  connSectionSub.textContent = count + ' ' + noun + ' configured';
}

function renderConnectionRows(rows) {
  connState.rows = rows;
  connListState.hidden = true;
  connTableBody.textContent = '';
  updateConnSectionSub(rows.length);

  if (!rows.length) {
    connTable.hidden = true;
    connEmptyState.hidden = false;
    return;
  }
  connTable.hidden = false;
  connEmptyState.hidden = true;

  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;

    const nameTd = document.createElement('td');
    nameTd.className = 'cell-name';
    nameTd.textContent = escapeText(row.name);
    if (row.group) {
      const groupSpan = document.createElement('span');
      groupSpan.className = 'conn-group';
      groupSpan.textContent = escapeText(row.group);
      nameTd.appendChild(groupSpan);
    }
    tr.appendChild(nameTd);

    const hostTd = document.createElement('td');
    hostTd.className = 'mono-cell';
    hostTd.textContent = escapeText(row.host) + ':' + escapeText(row.port) + (row.sshEnabled ? ' (ssh)' : '');
    tr.appendChild(hostTd);

    const dbTd = document.createElement('td');
    dbTd.className = 'mono-cell';
    dbTd.textContent = escapeText(row.database);
    tr.appendChild(dbTd);

    const userTd = document.createElement('td');
    userTd.className = 'mono-cell';
    const userWrap = document.createElement('span');
    userWrap.className = 'user-cell';
    userWrap.appendChild(document.createTextNode(escapeText(row.username) || '—'));
    if (row.hasPassword) {
      const cred = document.createElement('span');
      cred.className = 'cred-badge';
      cred.textContent = '🔒';
      cred.title = 'Password stored in secret storage';
      userWrap.appendChild(cred);
    }
    userTd.appendChild(userWrap);
    tr.appendChild(userTd);

    const envTd = document.createElement('td');
    const envSelect = document.createElement('select');
    envSelect.className = 'env-select' + (row.environment ? ' env-' + row.environment : '');
    envSelect.dataset.pgSelectVariant = 'env';
    envSelect.setAttribute('aria-label', 'Environment for ' + escapeText(row.name));
    ENV_OPTIONS.forEach((opt) => {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      if (opt.value === (row.environment || '')) { option.selected = true; }
      envSelect.appendChild(option);
    });
    envSelect.addEventListener('change', () => {
      envSelect.className = 'env-select pg-select-native' + (envSelect.value ? ' env-' + envSelect.value : '');
      const pgState = pgSelectRegistry.get(envSelect);
      if (pgState) { pgState.syncDisplay(); }
      vscode.postMessage({ command: 'connections/setEnvironment', id: row.id, environment: envSelect.value });
    });
    envTd.appendChild(envSelect);
    enhanceSelect(envSelect);
    tr.appendChild(envTd);

    const sslTd = document.createElement('td');
    const sslMode = escapeText(row.sslmode) || 'prefer';
    const sslChip = document.createElement('span');
    sslChip.className = 'ssl-chip ssl-' + sslMode.replace(/[^a-z0-9-]/gi, '-');
    sslChip.textContent = sslMode;
    sslTd.appendChild(sslChip);
    tr.appendChild(sslTd);

    const actionsTd = document.createElement('td');
    actionsTd.className = 'cell-actions';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const rowLabel = escapeText(row.name);

    actions.appendChild(mkIconBtn('edit', 'Edit ' + rowLabel, () => {
      vscode.postMessage({ command: 'connections/get', id: row.id });
    }));

    const testBtn = mkIconBtn('test', 'Test ' + rowLabel, () => {
      setIconBtnLoading(testBtn, true);
      vscode.postMessage({ command: 'connections/testSaved', id: row.id });
    }, { testId: row.id });
    actions.appendChild(testBtn);

    actions.appendChild(mkIconBtn('duplicate', 'Duplicate ' + rowLabel, () => {
      vscode.postMessage({ command: 'connections/duplicate', id: row.id });
    }));

    const deleteBtn = mkIconBtn('delete', 'Delete ' + rowLabel, () => {
      if (tr.dataset.confirmingDelete === 'true') { return; }
      tr.dataset.confirmingDelete = 'true';
      deleteBtn.hidden = true;
      const confirmBtn = mkIconBtn('confirm', 'Confirm delete ' + rowLabel, () => {
        vscode.postMessage({ command: 'connections/delete', id: row.id });
      }, { danger: true });
      const cancelBtn = mkIconBtn('cancel', 'Cancel delete', () => {
        confirmBtn.remove();
        cancelBtn.remove();
        deleteBtn.hidden = false;
        delete tr.dataset.confirmingDelete;
      });
      actions.appendChild(confirmBtn);
      actions.appendChild(cancelBtn);
    }, { danger: true });
    actions.appendChild(deleteBtn);

    const resultSpan = document.createElement('span');
    resultSpan.className = 'conn-action-status';
    resultSpan.dataset.rowResultId = row.id;
    resultSpan.setAttribute('aria-hidden', 'true');
    actions.appendChild(resultSpan);
    actionsTd.appendChild(actions);
    tr.appendChild(actionsTd);

    connTableBody.appendChild(tr);
  });

  // Deep-link follow-ups once rows exist
  if (connState.pendingEditId) {
    vscode.postMessage({ command: 'connections/get', id: connState.pendingEditId });
    connState.pendingEditId = null;
  }
  if (connState.pendingAdd) {
    openConnEditor(null);
    connState.pendingAdd = false;
  }
}

function handleConnectionsMessage(message) {
  switch (message.type) {
    case 'connections/list':
      renderConnectionRows(message.connections || []);
      break;

    case 'connections/connection':
      openConnEditor(message.connection);
      break;

    case 'connections/testResult':
      connTestBtn.disabled = false;
      connTestBtn.textContent = 'Test Connection';
      if (message.ok) {
        const versionMatch = message.version && String(message.version).match(/PostgreSQL\s+[\d.]+/i);
        connShowFormMessage('Connected — ' + (versionMatch ? versionMatch[0] : 'OK'), 'success');
        connState.isTested = true;
        connSaveBtn.disabled = false;
      } else {
        connState.isTested = false;
        if (!connState.editingId) { connSaveBtn.disabled = true; }
        if (isSslDowngradeError(message.error)) {
          connShowFormMessage(message.error || 'Connection failed', 'error', [{
            label: 'Set SSL Mode to Disable',
            onClick: () => {
              $('sslmode').value = 'disable';
              $('advancedDetails').open = true;
              updateSSLCertFields();
              connState.isTested = false;
              if (!connState.editingId) { connSaveBtn.disabled = true; }
              connShowFormMessage('SSL mode set to Disable — No SSL. Retest the connection before saving.', 'warning');
              $('sslmode').focus();
            },
          }]);
        } else {
          connShowFormMessage(message.error || 'Connection failed', 'error');
        }
      }
      break;

    case 'connections/saved':
      connSaveBtn.textContent = connState.editingId ? 'Save Changes' : 'Add Connection';
      closeConnEditor();
      break;

    case 'connections/saveError':
      connSaveBtn.disabled = false;
      setSaveLabel();
      connShowFormMessage('Failed to save: ' + (message.error || 'Unknown error'), 'error');
      break;

    case 'connections/rowTestResult': {
      const btn = document.querySelector('[data-row-test-id="' + message.id + '"]');
      const result = document.querySelector('[data-row-result-id="' + message.id + '"]');
      setIconBtnLoading(btn, false);
      if (result) {
        result.className = 'conn-action-status ' + (message.ok ? 'ok' : 'fail');
        result.title = message.ok
          ? ('Connected — ' + (message.version || 'OK'))
          : (message.error || 'Connection failed');
        setTimeout(() => {
          result.className = 'conn-action-status';
          result.title = '';
        }, 6000);
      }
      break;
    }

    case 'connections/deleted':
      break; // list refresh follows

    case 'connections/envCandidates':
      renderEnvCandidates(message.candidates || []);
      break;

    case 'connections/envParsed':
      envPicker.hidden = true;
      $('connEnvPasteInput').value = '';
      openConnEditor({ ...message.connection, id: null });
      connShowFormMessage('Prefilled from DATABASE_URL — test and save to add this connection.', 'info');
      break;

    case 'connections/envParseError':
      renderEnvCandidates([]);
      envPicker.hidden = false;
      {
        const li = document.createElement('li');
        li.className = 'label-hint';
        li.style.color = 'var(--danger)';
        li.textContent = message.error || 'Could not parse URL';
        envList.appendChild(li);
      }
      break;

    case 'connections/error':
      connListState.hidden = false;
      connListState.classList.add('error');
      connListState.textContent = message.error || 'Something went wrong';
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AI section (ported from the standalone AI Settings panel)
// ─────────────────────────────────────────────────────────────────────────────

const aiForm = $('settingsForm');
const configScopeSelect = $('configScope');
const providerSelect = $('provider');
const aiTestBtn = $('aiTestBtn');
const aiSaveBtn = $('aiSaveBtn');
const aiMessageDiv = $('aiMessage');
const githubBanner = $('githubAuthBanner');
const githubStatusText = $('githubAuthStatusText');
const githubConnectBtn = $('githubConnectBtn');
const githubDisconnectBtn = $('githubDisconnectBtn');
let githubAuthState = { connected: false, accountLabel: '' };

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const DEFAULT_LMSTUDIO_ENDPOINT = 'http://localhost:1234/v1/chat/completions';

function aiShowMessage(text, isError) {
  aiMessageDiv.className = 'status-line ' + (isError ? 'error' : 'success');
  aiMessageDiv.textContent = text;
}

function aiHideMessage() {
  aiMessageDiv.textContent = '';
  aiMessageDiv.className = 'status-line';
}

providerSelect.addEventListener('change', () => {
  const provider = providerSelect.value;
  document.querySelectorAll('.provider-details').forEach((el) => el.classList.remove('active'));
  const detailsEl = $('provider-' + provider);
  if (detailsEl) { detailsEl.classList.add('active'); }
  aiHideMessage();
  const formData = getAiFormData();
  autoLoadModels(provider, formData.apiKey, formData.endpoint, { allowPrompt: githubAuthState.connected });
});

function autoLoadModels(provider, apiKey, endpoint, options = {}) {
  const allowPrompt = options.allowPrompt !== false;
  if (provider === 'vscode-lm') {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'vscode-lm', apiKey: '', endpoint: '' } });
  } else if (provider === 'github') {
    if (allowPrompt) {
      vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'github', apiKey: '', endpoint: '' } });
    }
  } else if (provider === 'cursor') {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'cursor', apiKey: apiKey || '', endpoint: endpoint || '' } });
  } else if (provider === 'anthropic') {
    if (apiKey && apiKey.length > 0) {
      vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'anthropic', apiKey, endpoint } });
    }
  } else if ((provider === 'openai' || provider === 'gemini') && apiKey) {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider, apiKey, endpoint } });
  } else if (provider === 'custom' && endpoint) {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'custom', apiKey, endpoint } });
  } else if (provider === 'ollama') {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'ollama', apiKey: '', endpoint: endpoint || DEFAULT_OLLAMA_ENDPOINT } });
  } else if (provider === 'lmstudio') {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'lmstudio', apiKey: '', endpoint: endpoint || DEFAULT_LMSTUDIO_ENDPOINT } });
  }
}

function modelValueFor(provider) {
  const selectEl = $('model-' + provider + '-select');
  const inputEl = $('model-' + provider);
  if (!inputEl) { return ''; }
  return (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
    ? selectEl.value
    : inputEl.value;
}

function getAiFormData() {
  const configScope = configScopeSelect ? configScopeSelect.value : 'notebook';
  const provider = providerSelect.value;
  let apiKey = '';
  const apiKeys = {
    openai: $('apiKey-openai')?.value || '',
    anthropic: $('apiKey-anthropic')?.value || '',
    gemini: $('apiKey-gemini')?.value || '',
    custom: $('apiKey-custom')?.value || '',
  };
  let model = '';
  let endpoint = '';

  if (provider === 'vscode-lm' || provider === 'github') {
    model = modelValueFor(provider);
  } else if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini') {
    apiKey = $('apiKey-' + provider).value;
    model = modelValueFor(provider);
  } else if (provider === 'cursor') {
    apiKey = $('apiKey-cursor').value;
    model = modelValueFor('cursor');
  } else if (provider === 'custom') {
    apiKey = $('apiKey-custom').value;
    model = $('model-custom').value;
    endpoint = $('endpoint-custom').value;
  } else if (provider === 'ollama') {
    model = modelValueFor('ollama');
    endpoint = $('endpoint-ollama').value || DEFAULT_OLLAMA_ENDPOINT;
  } else if (provider === 'lmstudio') {
    model = modelValueFor('lmstudio');
    endpoint = $('endpoint-lmstudio').value || DEFAULT_LMSTUDIO_ENDPOINT;
  }

  return { configScope, provider, apiKey, apiKeys, model, endpoint };
}

function setAiFormData(settings) {
  if (configScopeSelect && settings.configScope) {
    setSelectValue(configScopeSelect, settings.configScope);
  }

  const keys = settings.apiKeys || {};
  const setVal = (id, value) => { const el = $(id); if (el) { el.value = value; } };
  setVal('apiKey-openai', keys.openai || (settings.provider === 'openai' ? settings.apiKey : '') || '');
  setVal('apiKey-anthropic', keys.anthropic || (settings.provider === 'anthropic' ? settings.apiKey : '') || '');
  setVal('apiKey-gemini', keys.gemini || (settings.provider === 'gemini' ? settings.apiKey : '') || '');
  setVal('apiKey-custom', keys.custom || (settings.provider === 'custom' ? settings.apiKey : '') || '');

  setSelectValue(providerSelect, settings.provider || 'vscode-lm');
  document.querySelectorAll('.provider-details').forEach((el) => el.classList.remove('active'));
  const detailsEl = $('provider-' + providerSelect.value);
  if (detailsEl) { detailsEl.classList.add('active'); }

  const p = settings.provider;
  if (p === 'cursor') {
    setVal('apiKey-cursor', settings.cursorApiKey || '');
    setVal('model-cursor', settings.model || '');
  } else if (p === 'custom') {
    setVal('model-custom', settings.model || '');
    setVal('endpoint-custom', settings.endpoint || '');
  } else if (p === 'ollama') {
    setVal('model-ollama', settings.model || '');
    setVal('endpoint-ollama', settings.endpoint || DEFAULT_OLLAMA_ENDPOINT);
  } else if (p === 'lmstudio') {
    setVal('model-lmstudio', settings.model || '');
    setVal('endpoint-lmstudio', settings.endpoint || DEFAULT_LMSTUDIO_ENDPOINT);
  } else if (p) {
    setVal('model-' + p, settings.model || '');
  }
}

if (configScopeSelect) {
  configScopeSelect.addEventListener('change', () => {
    aiHideMessage();
    vscode.postMessage({ command: 'ai/load', configScope: configScopeSelect.value });
  });
}

aiTestBtn.addEventListener('click', () => {
  aiHideMessage();
  aiTestBtn.disabled = true;
  aiTestBtn.textContent = 'Testing…';
  vscode.postMessage({ command: 'ai/test', settings: getAiFormData() });
});

aiForm.addEventListener('submit', (e) => {
  e.preventDefault();
  aiHideMessage();
  aiSaveBtn.disabled = true;
  aiSaveBtn.textContent = 'Saving…';
  vscode.postMessage({ command: 'ai/save', settings: getAiFormData() });
});

document.querySelectorAll('.list-models-btn').forEach((btn) => {
  btn.addEventListener('click', function () {
    const provider = this.getAttribute('data-provider');
    const settings = getAiFormData();

    if ((provider === 'openai' || provider === 'gemini' || provider === 'anthropic') && !settings.apiKey) {
      aiShowMessage('Please enter an API key first', true);
      return;
    }
    if (provider === 'custom' && !settings.endpoint) {
      aiShowMessage('Please enter an endpoint first', true);
      return;
    }

    let endpoint = settings.endpoint;
    if (provider === 'ollama' && !endpoint) { endpoint = DEFAULT_OLLAMA_ENDPOINT; }
    if (provider === 'lmstudio' && !endpoint) { endpoint = DEFAULT_LMSTUDIO_ENDPOINT; }

    this.disabled = true;
    this.textContent = 'Loading models...';

    const apiKey = (provider === 'github') ? '' : settings.apiKey;
    vscode.postMessage({ command: 'ai/listModels', settings: { provider, apiKey, endpoint: provider === 'github' || provider === 'cursor' ? '' : endpoint } });
  });
});

['vscode-lm', 'github', 'cursor', 'openai', 'anthropic', 'gemini', 'ollama', 'lmstudio'].forEach((provider) => {
  const selectEl = $('model-' + provider + '-select');
  const inputEl = $('model-' + provider);
  if (selectEl && inputEl) {
    selectEl.addEventListener('change', function () {
      if (this.value) { inputEl.value = this.value; }
    });
  }
});

['openai', 'gemini', 'cursor'].forEach((provider) => {
  const apiKeyInput = $('apiKey-' + provider);
  if (apiKeyInput) {
    apiKeyInput.addEventListener('blur', function () {
      if (this.value && this.value.length > 10) {
        autoLoadModels(provider, this.value, '');
      }
    });
  }
});

const customEndpoint = $('endpoint-custom');
if (customEndpoint) {
  customEndpoint.addEventListener('blur', function () {
    if (this.value) {
      autoLoadModels('custom', $('apiKey-custom').value, this.value);
    }
  });
}

function handleModelsListed(models) {
  const provider = providerSelect.value;
  const selectEl = $('model-' + provider + '-select');
  const inputEl = $('model-' + provider);

  if (selectEl && models.length > 0) {
    selectEl.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select a model...';
    selectEl.appendChild(placeholder);
    models.forEach((model) => {
      const option = document.createElement('option');
      if (model && typeof model === 'object') {
        option.value = model.id || model.displayName || '';
        option.textContent = model.displayName || model.id || '';
      } else {
        option.value = model;
        option.textContent = model;
      }
      selectEl.appendChild(option);
    });
    selectEl.classList.remove('hidden');
    inputEl.classList.add('hidden');
    if (inputEl.value) { setSelectValue(selectEl, inputEl.value); }
    const pgState = pgSelectRegistry.get(selectEl);
    if (pgState) { pgState.rebuildOptions(); }
  }
}

function updateGitHubAuthStatus(auth) {
  if (!githubBanner || !githubStatusText) { return; }
  githubAuthState = auth || { connected: false, accountLabel: '' };

  if (providerSelect.value !== 'github' && !githubAuthState.connected) {
    githubBanner.classList.add('hidden');
    return;
  }
  githubBanner.classList.remove('hidden');
  if (auth && auth.connected) {
    githubStatusText.textContent = 'Connected as ' + (auth.accountLabel || 'GitHub user');
    githubBanner.classList.remove('warning');
    githubBanner.classList.add('info');
  } else {
    githubStatusText.textContent = 'Not connected';
    githubBanner.classList.remove('info');
    githubBanner.classList.add('warning');
  }
}

githubConnectBtn.addEventListener('click', () => {
  aiHideMessage();
  githubConnectBtn.disabled = true;
  githubConnectBtn.textContent = 'Connecting...';
  vscode.postMessage({ command: 'ai/connectGitHub' });
});

githubDisconnectBtn.addEventListener('click', () => {
  aiHideMessage();
  githubDisconnectBtn.disabled = true;
  githubDisconnectBtn.textContent = 'Disconnecting...';
  vscode.postMessage({ command: 'ai/disconnectGitHub' });
});

function resetAiButtons() {
  aiTestBtn.disabled = false;
  aiTestBtn.textContent = 'Test';
  aiSaveBtn.disabled = false;
  aiSaveBtn.textContent = 'Save';
  githubConnectBtn.disabled = false;
  githubConnectBtn.textContent = 'Connect GitHub';
  githubDisconnectBtn.disabled = false;
  githubDisconnectBtn.textContent = 'Disconnect';
  document.querySelectorAll('.list-models-btn').forEach((btn) => {
    btn.disabled = false;
    btn.textContent = 'List available models';
  });
}

function handleAiMessage(message) {
  resetAiButtons();

  switch (message.type) {
    case 'ai/settings': {
      setAiFormData(message.settings);
      updateGitHubAuthStatus(message.settings.githubAuth);
      const settings = message.settings;
      if (settings && settings.provider) {
        autoLoadModels(settings.provider, settings.cursorApiKey || settings.apiKey || '', settings.endpoint || '', {
          allowPrompt: !!(settings.githubAuth && settings.githubAuth.connected),
        });
      }
      break;
    }
    case 'ai/testSuccess':
      aiShowMessage('✓ ' + message.result);
      break;
    case 'ai/testError':
      aiShowMessage('✗ ' + message.error, true);
      break;
    case 'ai/saveSuccess':
      aiShowMessage('✓ Settings saved successfully!');
      break;
    case 'ai/saveError':
      aiShowMessage('✗ Failed to save: ' + message.error, true);
      break;
    case 'ai/modelsListed':
      handleModelsListed(message.models || []);
      aiShowMessage('✓ Connected — ' + (message.models || []).length + ' model(s) available');
      break;
    case 'ai/modelsListError':
      aiShowMessage('✗ Failed to list models: ' + message.error, true);
      break;
    case 'ai/githubConnected':
      updateGitHubAuthStatus({ connected: true, accountLabel: message.accountLabel });
      aiShowMessage('✓ Connected GitHub account: ' + message.accountLabel);
      break;
    case 'ai/githubConnectError':
      aiShowMessage('✗ GitHub connect failed: ' + message.error, true);
      break;
    case 'ai/githubDisconnected':
      updateGitHubAuthStatus({ connected: false });
      aiShowMessage('✓ GitHub disconnected from PgStudio');
      break;
    case 'ai/githubDisconnectError':
      aiShowMessage('✗ GitHub disconnect failed: ' + message.error, true);
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences section
// ─────────────────────────────────────────────────────────────────────────────

$('prefDdlEnabled').addEventListener('change', (e) => {
  vscode.postMessage({ command: 'prefs/update', key: 'ddlEnabled', value: e.target.checked });
});
$('prefDdlOpenOnSelection').addEventListener('change', (e) => {
  vscode.postMessage({ command: 'prefs/update', key: 'ddlOpenOnSelection', value: e.target.checked });
});

function handlePrefsMessage(message) {
  switch (message.type) {
    case 'prefs/state':
      $('prefsState').hidden = true;
      $('prefsList').hidden = false;
      $('prefDdlEnabled').checked = !!message.prefs.ddlEnabled;
      $('prefDdlOpenOnSelection').checked = !!message.prefs.ddlOpenOnSelection;
      break;
    case 'prefs/error':
      $('prefsState').hidden = false;
      $('prefsState').classList.add('error');
      $('prefsState').textContent = message.error || 'Failed to update preference';
      break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cloud Sync section
// ─────────────────────────────────────────────────────────────────────────────

const SYNC_STATUS_LABELS = {
  idle: 'Ready',
  synced: 'Synced',
  syncing: 'Syncing…',
  offline: 'Offline',
  conflict: 'Conflicts detected',
  error: 'Error',
  paused: 'Paused',
  locked: 'Vault locked',
  not_configured: 'Not configured',
};

let syncFlagsDirtyGuard = false;

$('syncSetupBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'sync/setup' });
});
$('syncNowBtn').addEventListener('click', () => {
  $('syncNowBtn').disabled = true;
  $('syncRunMessage').textContent = 'Syncing…';
  $('syncRunMessage').className = 'status-line';
  vscode.postMessage({ command: 'sync/now' });
});
$('syncPauseBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'sync/pauseResume' });
});
$('syncSignOutBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'sync/signOut' });
});
$('syncShareBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'sync/share' });
});
$('syncImportSharesBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'sync/importShares' });
});

const SYNC_KIND_LABELS = {
  connection: 'Connection',
  query: 'Saved query',
  notebook: 'Notebook',
  secrets: 'Passwords',
};

const SYNC_ACTION_LABELS = {
  create: 'Create',
  update: 'Update',
  rename: 'Rename',
  delete: 'Delete',
};

function formatSyncTimestamp(ms) {
  if (!ms) { return '—'; }
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

const SYNC_KIND_PLURAL = {
  connections: 'connections',
  queries: 'saved queries',
  notebooks: 'notebooks',
};

function formatKindBreakdown(counts, kindLabel) {
  const parts = [];
  if (counts.created) {
    parts.push(counts.created + ' new ' + kindLabel);
  }
  if (counts.updated) {
    parts.push(counts.updated + ' modified ' + kindLabel);
  }
  if (counts.deleted) {
    parts.push(counts.deleted + ' deleted ' + kindLabel);
  }
  return parts;
}

function formatDirectionSummary(direction, label) {
  if (!direction) { return ''; }
  const parts = [];
  for (const [kind, counts] of Object.entries(direction)) {
    parts.push(...formatKindBreakdown(counts, SYNC_KIND_PLURAL[kind] || kind));
  }
  if (!parts.length) { return ''; }
  return label + ': ' + parts.join(', ');
}

function formatSyncRunMessage(result) {
  if (!result) {
    return 'Sync did not complete — check the sync status above.';
  }
  const segments = [];
  const pushed = formatDirectionSummary(result.summary?.pushed, 'Up to cloud');
  const pulled = formatDirectionSummary(result.summary?.pulled, 'From cloud');
  if (pushed) { segments.push(pushed); }
  if (pulled) { segments.push(pulled); }
  if (result.conflicts) {
    segments.push(result.conflicts + ' conflict' + (result.conflicts === 1 ? '' : 's'));
  }
  if (result.skipped) {
    segments.push(result.skipped + ' skipped');
  }
  if (!segments.length) {
    return '✓ Already in sync — no changes.';
  }
  return '✓ ' + segments.join('. ') + '.';
}

function formatPendingLabel(activity) {
  if (activity.action === 'rename' && activity.previousName && activity.name) {
    return activity.previousName + ' → ' + activity.name;
  }
  return activity.name || activity.itemId;
}

function renderSyncPending(activities) {
  const body = $('syncPendingBody');
  const badge = $('syncPendingBadge');
  while (body.firstChild) { body.removeChild(body.firstChild); }

  if (!activities.length) {
    badge.hidden = true;
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty-state';
    td.textContent = 'No pending changes.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  badge.hidden = false;
  badge.textContent = String(activities.length);

  for (const activity of activities) {
    const tr = document.createElement('tr');

    const actionTd = document.createElement('td');
    actionTd.textContent = SYNC_ACTION_LABELS[activity.action] || activity.action;
    actionTd.classList.add('sync-pending-action');
    if (activity.action === 'delete') { actionTd.classList.add('sync-action-delete'); }
    tr.appendChild(actionTd);

    const nameTd = document.createElement('td');
    nameTd.textContent = formatPendingLabel(activity);
    if (!activity.name) { nameTd.classList.add('mono'); }
    tr.appendChild(nameTd);

    const kindTd = document.createElement('td');
    kindTd.textContent = SYNC_KIND_LABELS[activity.kind] || activity.kind;
    tr.appendChild(kindTd);

    const queuedTd = document.createElement('td');
    queuedTd.textContent = formatSyncTimestamp(activity.queuedAt);
    tr.appendChild(queuedTd);

    body.appendChild(tr);
  }
}

function renderSyncItems(items) {
  const body = $('syncItemsBody');
  while (body.firstChild) { body.removeChild(body.firstChild); }

  if (!items.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty-state';
    td.textContent = 'No items are being synced yet.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const item of items) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.textContent = item.name || item.id;
    if (!item.name) { nameTd.classList.add('mono'); }
    tr.appendChild(nameTd);

    const kindTd = document.createElement('td');
    kindTd.textContent = SYNC_KIND_LABELS[item.kind] || item.kind;
    tr.appendChild(kindTd);

    const updatedTd = document.createElement('td');
    updatedTd.textContent = formatSyncTimestamp(item.updatedAt);
    tr.appendChild(updatedTd);

    const statusTd = document.createElement('td');
    statusTd.textContent = item.excluded ? 'Not syncing' : 'Syncing';
    if (item.excluded) { statusTd.classList.add('label-hint'); }
    tr.appendChild(statusTd);

    const actionTd = document.createElement('td');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary btn-sm';
    if (item.excluded) {
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'sync/resumeItem', itemId: item.id });
      });
    } else {
      btn.textContent = 'Stop syncing';
      btn.classList.add('btn-danger-text');
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'sync/stopSyncingItem', itemId: item.id, itemName: item.name || item.id });
      });
    }
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);

    body.appendChild(tr);
  }
}
$('syncUpgradeBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'license/openUpgrade' });
});
$('syncActivateLink').addEventListener('click', () => {
  showSection('license');
});

['syncFlagConnections', 'syncFlagQueries', 'syncFlagNotebooks', 'syncFlagPasswords'].forEach((id) => {
  $(id).addEventListener('change', () => {
    if (syncFlagsDirtyGuard) { return; }
    vscode.postMessage({
      command: 'sync/saveFlags',
      flags: {
        syncConnections: $('syncFlagConnections').checked,
        syncQueries: $('syncFlagQueries').checked,
        syncNotebooks: $('syncFlagNotebooks').checked,
        syncPasswords: $('syncFlagPasswords').checked,
      },
    });
  });
});

function pushAutoSync() {
  if (syncFlagsDirtyGuard) { return; }
  vscode.postMessage({
    command: 'sync/updateAuto',
    auto: $('syncAutoEnabled').checked,
    pullIntervalMinutes: parseInt($('syncPullInterval').value, 10),
  });
}
$('syncAutoEnabled').addEventListener('change', pushAutoSync);
$('syncPullInterval').addEventListener('change', pushAutoSync);

function handleSyncMessage(message) {
  switch (message.type) {
    case 'sync/state': {
      const sync = message.sync;
      $('syncState').hidden = true;
      $('syncLocked').hidden = sync.featureEnabled;
      $('syncNotConfigured').hidden = !(sync.featureEnabled && !sync.configured);
      $('syncConfigured').hidden = !(sync.featureEnabled && sync.configured);

      if (sync.featureEnabled && sync.configured) {
        vscode.postMessage({ command: 'sync/items' });
        vscode.postMessage({ command: 'sync/pending' });
        $('syncStatusValue').textContent = SYNC_STATUS_LABELS[sync.status] || sync.status;
        $('syncProviderValue').textContent = sync.providerLabel || '—';
        $('syncAccountValue').textContent = sync.accountEmail || '—';
        $('syncConflictsValue').textContent = String(sync.conflicts);
        $('syncPauseBtn').textContent = sync.paused ? 'Resume' : 'Pause';
        $('syncNowBtn').disabled = sync.paused;
        $('syncSharingRow').hidden = !sync.sharingAvailable;

        syncFlagsDirtyGuard = true;
        $('syncFlagConnections').checked = !!sync.flags.syncConnections;
        $('syncFlagQueries').checked = !!sync.flags.syncQueries;
        $('syncFlagNotebooks').checked = !!sync.flags.syncNotebooks;
        $('syncFlagPasswords').checked = !!sync.flags.syncPasswords;
        $('syncAutoEnabled').checked = !!sync.auto && !!sync.autoAllowed;
        $('syncAutoEnabled').disabled = !sync.autoAllowed;
        $('syncPullInterval').disabled = !sync.autoAllowed;
        $('syncAutoHint').textContent = sync.autoAllowed
          ? 'Push on changes; pull on the interval below'
          : 'Automatic sync requires NexQL Sponsor or Teams — free plan syncs manually with “Sync Now”';
        $('syncPullInterval').value = sync.pullIntervalMinutes;
        syncFlagsDirtyGuard = false;
      }
      break;
    }
    case 'sync/items':
      renderSyncItems(message.items || []);
      break;
    case 'sync/pending':
      renderSyncPending(message.pending || []);
      break;
    case 'sync/running':
      break;
    case 'sync/runComplete': {
      const el = $('syncRunMessage');
      $('syncNowBtn').disabled = false;
      if (message.result) {
        el.className = 'status-line success';
        el.textContent = formatSyncRunMessage(message.result);
      } else {
        el.className = 'status-line error';
        el.textContent = formatSyncRunMessage(null);
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// License section
// ─────────────────────────────────────────────────────────────────────────────

$('licenseActivateBtn').addEventListener('click', () => {
  const key = $('licenseKeyInput').value.trim();
  const msg = $('licenseActivateMessage');
  if (!key) {
    msg.className = 'status-line error';
    msg.textContent = 'Enter a license key first.';
    return;
  }
  $('licenseActivateBtn').disabled = true;
  $('licenseActivateBtn').textContent = 'Activating…';
  msg.className = 'status-line';
  msg.textContent = '';
  vscode.postMessage({ command: 'license/activate', key });
});

$('licenseKeyInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('licenseActivateBtn').click();
  }
});

$('licenseDeactivateBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'license/deactivate' });
});

$('licenseUpgradeBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'license/openUpgrade' });
});

function renderQuotas(quotas) {
  const body = $('licenseQuotaBody');
  body.textContent = '';
  quotas.forEach((q) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    nameTd.textContent = q.label;
    tr.appendChild(nameTd);

    const remainTd = document.createElement('td');
    if (q.limit === null) {
      remainTd.textContent = 'Unlimited';
    } else {
      const bar = document.createElement('span');
      bar.className = 'quota-bar';
      const fill = document.createElement('i');
      const ratio = q.limit > 0 ? q.remaining / q.limit : 0;
      fill.style.width = Math.round(ratio * 100) + '%';
      if (q.remaining === 0) { fill.className = 'empty'; }
      else if (ratio <= 0.34) { fill.className = 'low'; }
      bar.appendChild(fill);
      remainTd.appendChild(bar);
      const label = document.createElement('span');
      label.textContent = q.remaining + '/' + q.limit + (q.period === 'week' ? ' this week' : ' today');
      remainTd.appendChild(label);
    }
    tr.appendChild(remainTd);

    const resetTd = document.createElement('td');
    resetTd.className = 'label-hint';
    resetTd.textContent = q.resetHint || '';
    tr.appendChild(resetTd);

    body.appendChild(tr);
  });
}

function handleLicenseMessage(message) {
  switch (message.type) {
    case 'license/state': {
      const lic = message.license;
      $('licenseState').hidden = true;
      $('licenseBody').hidden = false;

      const badge = $('licenseTierBadge');
      badge.textContent = lic.tierLabel;
      badge.className = 'tier-badge tier-' + lic.tier;
      $('licenseOfflineNote').hidden = !lic.offline;

      const isPaid = lic.tier !== 'free';
      $('licenseKeyRow').hidden = !lic.maskedKey;
      $('licenseKeyValue').textContent = lic.maskedKey || '—';
      $('licenseExpiryRow').hidden = !lic.expiresAt;
      $('licenseExpiryValue').textContent = lic.expiresAt
        ? new Date(lic.expiresAt).toLocaleDateString()
        : '—';
      $('licenseGraceRow').hidden = !lic.gracePeriodStartedAt;
      $('licenseGraceValue').textContent = lic.gracePeriodStartedAt
        ? 'started ' + new Date(lic.gracePeriodStartedAt).toLocaleDateString()
        : '—';

      $('licenseDeactivateBtn').hidden = !isPaid;
      $('licenseActivateBox').hidden = isPaid;
      $('licenseQuotaBox').hidden = !(lic.quotas && lic.quotas.length);
      if (lic.quotas && lic.quotas.length) {
        renderQuotas(lic.quotas);
      }
      break;
    }
    case 'license/activateResult': {
      const msg = $('licenseActivateMessage');
      $('licenseActivateBtn').disabled = false;
      $('licenseActivateBtn').textContent = 'Activate';
      msg.className = 'status-line ' + (message.ok ? 'success' : 'error');
      msg.textContent = (message.ok ? '✓ ' : '✗ ') + message.message;
      if (message.ok) { $('licenseKeyInput').value = ''; }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message routing + boot
// ─────────────────────────────────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  const message = event.data || {};
  const type = String(message.type || '');

  if (type === 'hub/navigate') {
    if (message.editConnectionId) { connState.pendingEditId = message.editConnectionId; }
    if (message.addConnection) { connState.pendingAdd = true; }
    showSection(message.section || 'connections');
    return;
  }

  const prefix = type.split('/')[0];
  switch (prefix) {
    case 'connections': handleConnectionsMessage(message); break;
    case 'ai': handleAiMessage(message); break;
    case 'prefs': handlePrefsMessage(message); break;
    case 'sync': handleSyncMessage(message); break;
    case 'license': handleLicenseMessage(message); break;
  }
});

// Enhance all static selects before first paint of dropdown UI.
enhanceAllSelects(document);

// Boot with the deep-linked initial state injected by the host.
if (initialState.editConnectionId) { connState.pendingEditId = initialState.editConnectionId; }
if (initialState.addConnection) { connState.pendingAdd = true; }
showSection(initialState.section || 'connections');
