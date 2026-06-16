// PgStudio Settings Hub webview controller.
// Message protocol: webview → host `{ command: '<section>/<action>', ... }`,
// host → webview `{ type: '<section>/<event>', ... }`.

const vscode = acquireVsCodeApi();
const initialState = {{INITIAL_STATE}};

/** @type {Record<string, { id: string, label: string, hint: string, hostPlaceholder: string, iconUri: string, defaults: { port: number, sslmode: string, applicationName?: string } }>} */
const platformPresetById = Object.fromEntries(
  (initialState.platformPresets || []).map((p) => [p.id, p]),
);

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
  if (selectEl.dataset.pgSelectVariant === 'platform') {
    wrap.classList.add('pg-select--platform');
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

  function appendPgSelectOptionLabel(parent, opt) {
    const iconUri = opt.dataset.iconUri || '';
    if (iconUri) {
      const img = document.createElement('img');
      img.className = 'pg-select-platform-icon';
      img.src = iconUri;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      parent.appendChild(img);
    }
    const label = document.createElement('span');
    label.textContent = opt.textContent;
    parent.appendChild(label);
  }

  function rebuildOptions() {
    panel.textContent = '';
    Array.from(selectEl.options).forEach((opt) => {
      const optionBtn = document.createElement('button');
      optionBtn.type = 'button';
      optionBtn.className = 'pg-select-option';
      optionBtn.setAttribute('role', 'option');
      optionBtn.dataset.value = opt.value;
      appendPgSelectOptionLabel(optionBtn, opt);
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
    valueSpan.textContent = '';
    if (selected) {
      appendPgSelectOptionLabel(valueSpan, selected);
    } else {
      valueSpan.textContent = 'Select…';
    }
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

const SECTIONS = ['connections', 'ai', 'prefs', 'sentinel', 'sync', 'license'];
let activeSection = null;

function loadSection(section) {
  switch (section) {
    case 'connections': vscode.postMessage({ command: 'connections/load' }); break;
    case 'ai': vscode.postMessage({ command: 'ai/load' }); break;
    case 'prefs': vscode.postMessage({ command: 'prefs/load' }); break;
    case 'sentinel': vscode.postMessage({ command: 'sentinel/load' }); break;
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
  selectedIds: new Set(),
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
  ['platformPreset', 'environment', 'cloudAuthKind', 'sslmode'].forEach((id) => {
    const el = $(id);
    const state = pgSelectRegistry.get(el);
    if (state) { state.syncDisplay(); }
  });
}

function initPlatformPresetSelect() {
  const select = $('platformPreset');
  if (!select || !initialState.platformPresets || !initialState.platformPresets.length) {
    return;
  }
  select.textContent = '';
  initialState.platformPresets.forEach((preset) => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    option.dataset.iconUri = preset.iconUri;
    option.dataset.hint = preset.hint;
    option.dataset.hostPlaceholder = preset.hostPlaceholder;
    option.dataset.port = String(preset.defaults.port);
    option.dataset.sslmode = preset.defaults.sslmode;
    if (preset.defaults.applicationName) {
      option.dataset.applicationName = preset.defaults.applicationName;
    }
    select.appendChild(option);
  });
  select.value = 'vanilla';
  enhanceSelect(select);
  select.addEventListener('change', () => {
    applyPlatformPreset(select.value, false);
    vscode.postMessage({
      command: 'connections/trackTelemetry',
      event: 'platform_preset_selected',
      properties: { preset: select.value || 'vanilla' },
    });
  });
}

function updatePlatformPresetHint(hintText) {
  const hint = $('platformPresetHint');
  if (!hint) { return; }
  if (hintText) {
    hint.textContent = hintText;
    hint.hidden = false;
  } else {
    hint.hidden = true;
    hint.textContent = '';
  }
}

function applyPlatformPreset(presetId, resetHostPlaceholder) {
  const preset = platformPresetById[presetId];
  if (!preset) { return; }
  $('port').value = String(preset.defaults.port);
  setSelectValue($('sslmode'), preset.defaults.sslmode);
  if (preset.defaults.applicationName) {
    $('applicationName').value = preset.defaults.applicationName;
  }
  $('host').placeholder = preset.hostPlaceholder;
  if (resetHostPlaceholder) {
    $('host').value = '';
  }
  updatePlatformPresetHint(preset.hint);
  updateSSLCertFields();
  if (preset.defaults.sslmode === 'require') {
    $('advancedDetails').open = true;
  }
  syncConnFormSelects();
}

function platformIconUri(presetId) {
  return (platformPresetById[presetId] || platformPresetById.vanilla || {}).iconUri || '';
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
  setSelectValue($('platformPreset'), 'vanilla');
  applyPlatformPreset('vanilla', true);
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

    const presetId = connection.platformPreset || 'vanilla';
    setSelectValue($('platformPreset'), presetId);
    applyPlatformPreset(presetId, false);
    const preset = platformPresetById[presetId];
    if (preset) {
      updatePlatformPresetHint(preset.hint);
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
    platformPreset: $('platformPreset').value || 'vanilla',
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

$('connUrlPasteApplyBtn').addEventListener('click', () => {
  const url = $('connUrlPasteInput').value.trim();
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

function syncConnBulkBar() {
  const bar = $('connBulkBar');
  if (!bar) { return; }
  bar.hidden = connState.selectedIds.size === 0;
}

$('connSelectAll')?.addEventListener('change', (e) => {
  const checked = e.target.checked;
  connState.selectedIds.clear();
  if (checked) {
    connState.rows.forEach((row) => connState.selectedIds.add(row.id));
  }
  document.querySelectorAll('.conn-row-check').forEach((box) => {
    box.checked = checked;
  });
  syncConnBulkBar();
});

$('connBulkApplyBtn')?.addEventListener('click', () => {
  const env = $('connBulkEnv')?.value || 'production';
  vscode.postMessage({
    command: 'connections/bulkSetEnvironment',
    ids: [...connState.selectedIds],
    environment: env,
  });
});

function renderConnectionRows(rows) {
  connState.rows = rows;
  connListState.hidden = true;
  connTableBody.textContent = '';
  updateConnSectionSub(rows.length);
  connState.selectedIds.clear();
  syncConnBulkBar();
  const selectAll = $('connSelectAll');
  if (selectAll) { selectAll.checked = false; }

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

    const checkTd = document.createElement('td');
    checkTd.className = 'td-check';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'conn-row-check';
    check.setAttribute('aria-label', 'Select ' + (row.name || row.host));
    check.addEventListener('change', () => {
      if (check.checked) { connState.selectedIds.add(row.id); }
      else { connState.selectedIds.delete(row.id); }
      syncConnBulkBar();
    });
    checkTd.appendChild(check);
    tr.appendChild(checkTd);

    const nameTd = document.createElement('td');
    nameTd.className = 'cell-name';
    const nameText = document.createTextNode(escapeText(row.name));
    nameTd.appendChild(nameText);
    if (row.platformPreset && row.platformPreset !== 'vanilla') {
      const badge = document.createElement('span');
      badge.className = 'conn-platform-badge';
      badge.title = escapeText(row.platformLabel || row.platformPreset);
      const iconUri = platformIconUri(row.platformPreset);
      if (iconUri) {
        const img = document.createElement('img');
        img.src = iconUri;
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        badge.appendChild(img);
      }
      const badgeLabel = document.createElement('span');
      badgeLabel.textContent = escapeText(row.platformLabel || row.platformPreset);
      badge.appendChild(badgeLabel);
      nameTd.appendChild(badge);
    }
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
      if (!($('syncWizardBackdrop').hidden) && syncWizardState.step === 0 && syncWizardState.providerId === 'postgres') {
        renderSyncWizardStep();
      }
      break;

    case 'connections/connection':
      openConnEditor(message.connection);
      break;

    case 'connections/testResult':
      connTestBtn.disabled = false;
      connTestBtn.textContent = 'Test Connection';
      if (message.ok) {
        const versionMatch = message.version && String(message.version).match(/PostgreSQL\s+[\d.]+/i);
        let successText = 'Connected — ' + (versionMatch ? versionMatch[0] : 'OK');
        if (message.pgVersionWarning) {
          successText += '\n\n' + message.pgVersionWarning;
        }
        if (message.poolerWarning) {
          successText += '\n\n' + message.poolerWarning;
        }
        const envNudge = message.suggestEnvironmentTag
          ? '\n\nTag an environment so Sentinel can highlight this server.'
          : '';
        const envActions = message.suggestEnvironmentTag ? [
          { label: 'Production', onClick: () => { $('environment').value = 'production'; updateProductionWarning(); syncConnFormSelects(); } },
          { label: 'Staging', onClick: () => { $('environment').value = 'staging'; updateProductionWarning(); syncConnFormSelects(); } },
          { label: 'Development', onClick: () => { $('environment').value = 'development'; updateProductionWarning(); syncConnFormSelects(); } },
          { label: 'Configure Sentinel', onClick: () => showSection('sentinel') },
        ] : undefined;
        connShowFormMessage(
          successText + envNudge,
          message.suggestEnvironmentTag || message.pgVersionWarning || message.poolerWarning ? 'info' : 'success',
          envActions,
        );
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

    case 'connections/bulkTagged':
      connState.selectedIds.clear();
      syncConnBulkBar();
      if ($('connSelectAll')) { $('connSelectAll').checked = false; }
      document.querySelectorAll('.conn-row-check').forEach((box) => { box.checked = false; });
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
      $('connUrlPasteInput').value = '';
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
  } else if (provider === 'opencode') {
    vscode.postMessage({ command: 'ai/listModels', settings: { provider: 'opencode', apiKey: '', endpoint: '' } });
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
  } else if (provider === 'opencode') {
    model = modelValueFor('opencode');
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

  const opencodeCliPath = $('opencodeCliPath')?.value || '';
  const opencodeServeUrl = $('opencodeServeUrl')?.value || '';
  const opencodeAutoServe = $('opencodeAutoServe')?.checked !== false;
  const opencodeShowLog = $('opencodeShowLog')?.checked !== false;
  const opencodeSkipPermissions = $('opencodeSkipPermissions')?.checked !== false;
  const opencodeAutoApprovePermissions = $('opencodeAutoApprovePermissions')?.checked !== false;
  const opencodeServePort = parseInt($('opencodeServePort')?.value || '0', 10) || 0;

  return {
    configScope,
    provider,
    apiKey,
    apiKeys,
    model,
    endpoint,
    opencodeCliPath,
    opencodeServeUrl,
    opencodeAutoServe,
    opencodeShowLog,
    opencodeSkipPermissions,
    opencodeAutoApprovePermissions,
    opencodeServePort,
  };
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
  } else if (p === 'opencode') {
    setVal('opencodeCliPath', settings.opencodeCliPath || '');
    setVal('opencodeServeUrl', settings.opencodeServeUrl || '');
    const autoServeEl = $('opencodeAutoServe');
    if (autoServeEl) { autoServeEl.checked = settings.opencodeAutoServe !== false; }
    const showLogEl = $('opencodeShowLog');
    if (showLogEl) { showLogEl.checked = settings.opencodeShowLog !== false; }
    const skipPermEl = $('opencodeSkipPermissions');
    if (skipPermEl) { skipPermEl.checked = settings.opencodeSkipPermissions !== false; }
    const autoApproveEl = $('opencodeAutoApprovePermissions');
    if (autoApproveEl) { autoApproveEl.checked = settings.opencodeAutoApprovePermissions !== false; }
    setVal('opencodeServePort', String(settings.opencodeServePort || 0));
    setVal('model-opencode', settings.model || '');
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
    vscode.postMessage({ command: 'ai/listModels', settings: { provider, apiKey, endpoint: provider === 'github' || provider === 'cursor' || provider === 'opencode' ? '' : endpoint } });
  });
});

['vscode-lm', 'github', 'cursor', 'opencode', 'openai', 'anthropic', 'gemini', 'ollama', 'lmstudio'].forEach((provider) => {
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
// Sentinel section
// ─────────────────────────────────────────────────────────────────────────────

const sentinelThemeSelects = {
  production: $('sentinelThemeProd'),
  staging: $('sentinelThemeStaging'),
  development: $('sentinelThemeDev'),
};

function populateSentinelThemeSelects(themes, selected) {
  const map = selected || {};
  Object.entries(sentinelThemeSelects).forEach(([env, selectEl]) => {
    if (!selectEl) { return; }
    selectEl.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '(use current theme)';
    selectEl.appendChild(empty);
    (themes || []).forEach((label) => {
      const opt = document.createElement('option');
      opt.value = label;
      opt.textContent = label;
      selectEl.appendChild(opt);
    });
    setSelectValue(selectEl, map[env] || '');
    enhanceSelect(selectEl);
  });
}

function postSentinelUpdate(key, value) {
  vscode.postMessage({ command: 'sentinel/update', key, value });
}

function bindSentinelCheckbox(id, key) {
  const el = $(id);
  if (!el) { return; }
  el.addEventListener('change', () => postSentinelUpdate(key, el.checked));
}

bindSentinelCheckbox('sentinelEnabled', 'enabled');
bindSentinelCheckbox('sentinelStatusBar', 'statusBarAccent');
bindSentinelCheckbox('sentinelNotebookStrip', 'notebookContextStrip');
bindSentinelCheckbox('sentinelChrome', 'chromeAccent');
bindSentinelCheckbox('sentinelTabBadges', 'tabBadges');
bindSentinelCheckbox('sentinelChatChip', 'chatEnvChip');
bindSentinelCheckbox('sentinelNotify', 'notifyOnTransition');
bindSentinelCheckbox('sentinelThemeSwap', 'themeSwapEnabled');

$('sentinelNexqlInstallBtn')?.addEventListener('click', () => {
  vscode.postMessage({ command: 'sentinel/openNexqlThemes' });
});
$('sentinelNexqlPrefillBtn')?.addEventListener('click', () => {
  vscode.postMessage({ command: 'sentinel/prefillNexqlThemes' });
});

$('sentinelThemeMode')?.addEventListener('change', (e) => {
  postSentinelUpdate('themeSwapMode', e.target.value);
});

Object.entries(sentinelThemeSelects).forEach(([env, selectEl]) => {
  selectEl?.addEventListener('change', () => {
    const themes = {};
    Object.entries(sentinelThemeSelects).forEach(([k, sel]) => {
      if (sel?.value) { themes[k] = sel.value; }
    });
    postSentinelUpdate('themeSwapThemes', themes);
  });
});

const connSentinelLink = $('connSentinelLink');
if (connSentinelLink) {
  connSentinelLink.addEventListener('click', (e) => {
    e.preventDefault();
    showSection('sentinel');
  });
}

function handleSentinelMessage(message) {
  switch (message.type) {
    case 'sentinel/state': {
      $('sentinelState').hidden = true;
      $('sentinelList').hidden = false;
      const s = message.sentinel || {};
      $('sentinelEnabled').checked = s.enabled !== false;
      $('sentinelStatusBar').checked = s.statusBarAccent !== false;
      $('sentinelNotebookStrip').checked = s.notebookContextStrip !== false;
      $('sentinelChrome').checked = s.chromeAccent !== false;
      $('sentinelTabBadges').checked = s.tabBadges !== false;
      $('sentinelChatChip').checked = s.chatEnvChip !== false;
      $('sentinelNotify').checked = !!s.notifyOnTransition;
      $('sentinelThemeSwap').checked = !!s.themeSwapEnabled;
      const nexqlHint = $('sentinelNexqlHint');
      const prefillBtn = $('sentinelNexqlPrefillBtn');
      if (nexqlHint) { nexqlHint.hidden = false; }
      if (prefillBtn) {
        prefillBtn.hidden = !message.nexqlThemesInstalled || !Object.keys(message.detectedNexqlThemes || {}).length;
      }
      setSelectValue($('sentinelThemeMode'), s.themeSwapMode || 'suggest');
      populateSentinelThemeSelects(message.themes, s.themeSwapThemes);
      const masterOff = s.enabled === false;
      ['sentinelStatusBar', 'sentinelNotebookStrip', 'sentinelChrome', 'sentinelTabBadges', 'sentinelChatChip', 'sentinelNotify'].forEach((id) => {
        const el = $(id);
        if (el) { el.disabled = masterOff; }
      });
      break;
    }
    case 'sentinel/error':
      $('sentinelState').hidden = false;
      $('sentinelState').classList.add('error');
      $('sentinelState').textContent = message.error || 'Failed to update Sentinel settings';
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
let latestSyncState = null;

$('syncSetupBtn').addEventListener('click', () => {
  const mode = (latestSyncState && latestSyncState.cloudDefault) ? 'cloud' : 'advanced';
  vscode.postMessage({ command: 'sync/setup', mode });
});
$('syncPullBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/pull' }));
$('syncPushBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/push' }));
$('syncPreviewRefreshBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/preview' }));
$('syncApplyPreviewBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/applyPreview' }));
$('syncReplaceLocalBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/replaceLocal' }));
$('syncReplaceRemoteBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/replaceRemote' }));
$('syncRebuildIndexBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/rebuildIndex' }));
$('syncDiagnosticsBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/diagnostics' }));
$('syncAdvancedSetupBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/setup', mode: 'advanced' }));
$('syncWizardCloseBtn')?.addEventListener('click', () => { $('syncWizardBackdrop').hidden = true; });
document.querySelectorAll('.subnav-tab').forEach((btn) => {
  btn.addEventListener('click', () => showSyncTab(btn.getAttribute('data-sync-tab')));
});
$('syncConflictsLink')?.addEventListener('click', () => showSyncTab('conflicts'));
$('syncQuickPending')?.addEventListener('click', () => showSyncTab('items'));
$('syncQuickConflicts')?.addEventListener('click', () => showSyncTab('conflicts'));

const syncWizardState = {
  step: 0,
  mode: 'cloud',
  providerId: 'cloud',
  signedIn: false,
  vaultReady: false,
  secretKey: '',
  generation: '',
  vaultMode: 'create',
  customPassphrase: false,
  legacyVault: false,
};

const SYNC_WIZARD_STEP_TITLES = ['Connect', 'Protect', 'Done'];

function isVaultStepSubmittable() {
  const mode = document.querySelector('input[name="vaultMode"]:checked')?.value || syncWizardState.vaultMode || 'create';
  if (mode === 'unlock') {
    return !!($('syncWizardSecret')?.value || '').trim();
  }
  if ($('syncWizardCustomPass')?.checked) {
    return !!($('syncWizardPassphrase')?.value || '').trim();
  }
  return true;
}

function attachVaultStepListeners() {
  const refresh = () => updateSyncWizardNextBtn();
  document.querySelectorAll('input[name="vaultMode"]').forEach((el) => {
    el.addEventListener('change', () => {
      const unlock = document.querySelector('input[name="vaultMode"]:checked')?.value === 'unlock';
      syncWizardState.vaultMode = unlock ? 'unlock' : 'create';
      $('syncWizardCreateBlock').hidden = unlock;
      $('syncWizardUnlockBlock').hidden = !unlock;
      $('syncWizardLegacyEmailWrap').hidden = !unlock;
      refresh();
    });
  });
  $('syncWizardCustomPass')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    syncWizardState.customPassphrase = on;
    $('syncWizardPassphraseWrap').hidden = !on;
    refresh();
  });
  ['syncWizardPassphrase', 'syncWizardSecret', 'syncWizardLegacyEmail'].forEach((id) => {
    $(id)?.addEventListener('input', refresh);
  });
  refresh();
}

function updateSyncWizardNextBtn() {
  const s = syncWizardState.step;
  const btn = $('syncWizardNextBtn');
  if (!btn) { return; }
  if (s === 0) {
    btn.textContent = 'Next';
    if (syncWizardState.providerId === 'cloud') {
      btn.disabled = !syncWizardState.signedIn;
    } else if (syncWizardState.providerId === 'postgres') {
      btn.disabled = !syncWizardState.postgresConnectionId;
    } else {
      btn.disabled = false;
    }
  } else if (s === 1) {
    if (syncWizardState.vaultReady) {
      btn.textContent = 'Next';
      btn.disabled = false;
    } else {
      const unlock = (document.querySelector('input[name="vaultMode"]:checked')?.value || 'create') === 'unlock';
      btn.textContent = unlock ? 'Unlock vault' : 'Create vault';
      btn.disabled = !isVaultStepSubmittable();
    }
  } else if (s === 2) {
    btn.textContent = 'Finish';
    btn.disabled = false;
  } else if (s === 3) {
    btn.textContent = 'Done';
    btn.disabled = false;
  }
}

function openSyncWizard(mode) {
  syncWizardState.step = 0;
  syncWizardState.mode = mode || 'cloud';
  syncWizardState.providerId = mode === 'advanced' ? 'postgres' : 'cloud';
  syncWizardState.signedIn = mode === 'advanced';
  syncWizardState.vaultReady = false;
  syncWizardState.secretKey = '';
  syncWizardState.generation = '';
  syncWizardState.vaultMode = 'create';
  syncWizardState.customPassphrase = false;
  syncWizardState.legacyVault = false;
  syncWizardState.postgresConnectionId = latestSyncState ? (latestSyncState.postgresConnectionId || '') : '';
  $('syncWizardBackdrop').hidden = false;
  vscode.postMessage({ command: 'connections/load' });
  vscode.postMessage({ command: 'sync/wizardWelcome' });
  renderSyncWizardStep();
}

function renderSyncWizardStep() {
  const body = $('syncWizardBody');
  const title = $('syncWizardTitle');
  body.textContent = '';
  const s = syncWizardState.step;
  title.textContent = 'Set Up Cloud Sync — ' + (SYNC_WIZARD_STEP_TITLES[s] || 'Done');

  if (s === 0) {
    if (syncWizardState.providerId === 'cloud') {
      body.innerHTML = [
        '<p>Enable encrypted sync to NexQL Cloud. Your data is encrypted on this device before upload.</p>',
        '<p id="syncWizardTier" class="label-hint"></p>',
        '<button type="button" id="syncWizardEnableBtn" class="btn-primary">Enable Cloud Sync</button>',
        '<p id="syncWizardSignInStatus" class="status-line"></p>',
        '<button type="button" id="syncWizardBrowserBtn" class="btn-secondary btn-sm">Authorize in browser instead</button>',
      ].join('');
      $('syncWizardEnableBtn')?.addEventListener('click', () => {
        $('syncWizardEnableBtn').disabled = true;
        $('syncWizardSignInStatus').textContent = 'Connecting…';
        vscode.postMessage({ command: 'sync/wizardSignIn', mode: 'license' });
      });
      $('syncWizardBrowserBtn')?.addEventListener('click', () => {
        $('syncWizardBrowserBtn').disabled = true;
        $('syncWizardSignInStatus').textContent = 'Opening browser…';
        vscode.postMessage({ command: 'sync/wizardSignIn', mode: 'browser' });
      });
    } else if (syncWizardState.providerId === 'postgres') {
      const connections = connState.rows || [];
      const pgConnections = connections.filter(c => c.host);
      
      let selectHtml = '';
      if (pgConnections.length === 0) {
        selectHtml = '<p class="status-line error">No database connections found. Please add a connection in the Connections tab first.</p>';
      } else {
        selectHtml = [
          '<div class="form-group">',
          '  <label for="syncWizardPostgresConn">Select sync database connection</label>',
          '  <select id="syncWizardPostgresConn" style="width: 100%; margin-top: 8px;">',
          pgConnections.map(c => {
            const details = `${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
            const label = c.name ? `${c.name} (${details})` : details;
            return `<option value="${c.id}">${escapeText(label)}</option>`;
          }).join('\n'),
          '  </select>',
          '  <p class="label-hint" style="margin-top: 8px;">Connection to store the encrypted sync vault blobs.</p>',
          '</div>'
        ].join('\n');
      }

      const sqlCode = [
        'CREATE SCHEMA IF NOT EXISTS pgstudio_sync;',
        '',
        'CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_items (',
        '    account_id   TEXT NOT NULL,',
        '    item_id      TEXT NOT NULL,',
        '    kind         TEXT NOT NULL,',
        '    blob         BYTEA NOT NULL,',
        '    content_hash TEXT NOT NULL,',
        '    revision     INTEGER NOT NULL,',
        '    device_id    TEXT NOT NULL,',
        '    deleted      BOOLEAN NOT NULL,',
        '    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),',
        '    PRIMARY KEY (account_id, item_id)',
        ');',
        '',
        'CREATE TABLE IF NOT EXISTS pgstudio_sync.sync_meta (',
        '    account_id      TEXT PRIMARY KEY,',
        '    bound_device_id TEXT,',
        '    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()',
        ');'
      ].join('\n');

      const highlightedSqlHtml = [
        '<span class="sql-keyword">CREATE SCHEMA IF NOT EXISTS</span> pgstudio_sync;',
        '',
        '<span class="sql-keyword">CREATE TABLE IF NOT EXISTS</span> pgstudio_sync.sync_items (',
        '    account_id   <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    item_id      <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    kind         <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    blob         <span class="sql-type">BYTEA</span> <span class="sql-keyword">NOT NULL</span>,',
        '    content_hash <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    revision     <span class="sql-type">INTEGER</span> <span class="sql-keyword">NOT NULL</span>,',
        '    device_id    <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    deleted      <span class="sql-type">BOOLEAN</span> <span class="sql-keyword">NOT NULL</span>,',
        '    updated_at   <span class="sql-type">TIMESTAMPTZ</span> <span class="sql-keyword">NOT NULL DEFAULT</span> <span class="sql-func">now</span>(),',
        '    <span class="sql-keyword">PRIMARY KEY</span> (account_id, item_id)',
        ');',
        '',
        '<span class="sql-keyword">CREATE TABLE IF NOT EXISTS</span> pgstudio_sync.sync_meta (',
        '    account_id      <span class="sql-type">TEXT</span> <span class="sql-keyword">PRIMARY KEY</span>,',
        '    bound_device_id <span class="sql-type">TEXT</span>,',
        '    updated_at      <span class="sql-type">TIMESTAMPTZ</span> <span class="sql-keyword">NOT NULL DEFAULT</span> <span class="sql-func">now</span>()',
        ');'
      ].join('\n');

      const setupScriptHtml = [
        '<div class="sync-postgres-setup-box" style="margin-top: 16px; padding: 12px; border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; background: rgba(255, 255, 255, 0.03);">',
        '  <p style="color: var(--vscode-inputValidation-warningForeground); font-weight: bold; margin-bottom: 8px; font-size: 12px;">',
        '    ⚠️ WARNING: Do not run this script on critical or production databases.',
        '  </p>',
        '  <p class="label-hint" style="margin-bottom: 8px; font-size: 12px;">',
        '    Note: This sync backend requires to be run on postgres DB. Other databases are not supported.',
        '  </p>',
        '  <p class="label-hint" style="margin-bottom: 8px; font-size: 12px;">',
        '    Run this SQL script on the selected database using your query tool to set up the sync schema:',
        '  </p>',
        '  <pre class="mono" style="margin: 8px 0; padding: 8px; background: rgba(0, 0, 0, 0.25); border-radius: 4px; overflow-x: auto; font-size: 11px; max-height: 120px; text-align: left;"><code id="syncWizardPostgresSqlCode">' + highlightedSqlHtml + '</code></pre>',
        '  <button type="button" id="syncWizardCopyPostgresSqlBtn" class="btn-secondary btn-sm" style="margin-top: 4px;">Copy SQL Script</button>',
        '  <button type="button" id="syncWizardOpenNotebookPostgresBtn" class="btn-secondary btn-sm" style="margin-top: 4px; margin-left: 6px;">Open in Notebook</button>',
        '</div>'
      ].join('\n');

      body.innerHTML = [
        '<p>Connect to your chosen backend for manual backup and sync.</p>',
        selectHtml,
        setupScriptHtml
      ].join('\n');
      
      const selectEl = $('syncWizardPostgresConn');
      if (selectEl) {
        enhanceSelect(selectEl);
        if (syncWizardState.postgresConnectionId) {
          setSelectValue(selectEl, syncWizardState.postgresConnectionId);
        } else {
          syncWizardState.postgresConnectionId = selectEl.value;
        }
        selectEl.addEventListener('change', () => {
          syncWizardState.postgresConnectionId = selectEl.value;
          updateSyncWizardNextBtn();
        });
      }

      $('syncWizardCopyPostgresSqlBtn')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(sqlCode);
        const btn = $('syncWizardCopyPostgresSqlBtn');
        if (btn) {
          const prev = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = prev; }, 1500);
        }
      });

      $('syncWizardOpenNotebookPostgresBtn')?.addEventListener('click', () => {
        const connId = syncWizardState.postgresConnectionId;
        if (connId) {
          vscode.postMessage({
            command: 'sync/openNotebook',
            postgresConnectionId: connId
          });
        }
      });
      
      syncWizardState.signedIn = pgConnections.length > 0;
    } else {
      body.innerHTML = '<p>Connect to your chosen backend.</p><p class="label-hint">Advanced backends use the same auth flows as before.</p>';
      syncWizardState.signedIn = true;
    }
  } else if (s === 1) {
    body.innerHTML = [
      '<div class="sync-wizard-protect">',
      '  <p class="sync-wizard-lead">Your sync vault encrypts connections and queries. Save the secret key — it is shown only once.</p>',
      '  <div class="sync-wizard-choices" role="radiogroup" aria-label="Vault mode">',
      '    <label class="sync-wizard-choice">',
      '      <input type="radio" name="vaultMode" value="create" checked>',
      '      <span class="sync-wizard-choice-card">',
      '        <span class="sync-wizard-choice-title">Create new vault</span>',
      '        <span class="sync-wizard-choice-hint">Auto-generate a secret key</span>',
      '      </span>',
      '    </label>',
      '    <label class="sync-wizard-choice">',
      '      <input type="radio" name="vaultMode" value="unlock">',
      '      <span class="sync-wizard-choice-card">',
      '        <span class="sync-wizard-choice-title">Unlock existing vault</span>',
      '        <span class="sync-wizard-choice-hint">Use your recovery kit secret</span>',
      '      </span>',
      '    </label>',
      '  </div>',
      '  <div id="syncWizardCreateBlock" class="sync-wizard-panel">',
      '    <label class="sync-wizard-check">',
      '      <input type="checkbox" id="syncWizardCustomPass">',
      '      <span>Use custom passphrase</span>',
      '    </label>',
      '    <div id="syncWizardPassphraseWrap" class="form-group" hidden>',
      '      <label for="syncWizardPassphrase">Passphrase</label>',
      '      <input type="password" id="syncWizardPassphrase" class="hub-input mono" placeholder="Enter a memorable passphrase" autocomplete="new-password">',
      '    </div>',
      '  </div>',
      '  <div id="syncWizardUnlockBlock" class="sync-wizard-panel" hidden>',
      '    <div class="form-group">',
      '      <label for="syncWizardSecret">Secret key</label>',
      '      <input type="password" id="syncWizardSecret" class="hub-input mono" placeholder="Paste secret from recovery kit" autocomplete="off">',
      '    </div>',
      '    <div id="syncWizardLegacyEmailWrap" class="form-group" hidden>',
      '      <label for="syncWizardLegacyEmail">Account email <span class="label-hint">(legacy vaults only)</span></label>',
      '      <input type="email" id="syncWizardLegacyEmail" class="hub-input mono" placeholder="you@example.com" autocomplete="email">',
      '    </div>',
      '  </div>',
      '  <p id="syncWizardVaultStatus" class="status-line" role="status"></p>',
      '  <div id="syncWizardSecretReveal" class="sync-secret-reveal" hidden>',
      '    <p class="sync-secret-reveal-label">Your secret key</p>',
      '    <div class="sync-secret-reveal-row">',
      '      <code id="syncWizardSecretValue" class="mono hub-input hub-input-code"></code>',
      '      <button type="button" id="syncWizardCopySecret" class="btn-secondary btn-sm">Copy</button>',
      '    </div>',
      '    <p class="label-hint">Save this — you will need it on other devices.</p>',
      '  </div>',
      '</div>',
    ].join('');
    attachVaultStepListeners();
    if (syncWizardState.vaultReady && syncWizardState.secretKey) {
      $('syncWizardSecretReveal').hidden = false;
      $('syncWizardSecretValue').textContent = syncWizardState.secretKey;
      $('syncWizardCopySecret')?.addEventListener('click', () => {
        navigator.clipboard?.writeText(syncWizardState.secretKey);
        const copyBtn = $('syncWizardCopySecret');
        if (copyBtn) {
          const prev = copyBtn.textContent;
          copyBtn.textContent = 'Copied';
          setTimeout(() => { copyBtn.textContent = prev; }, 1500);
        }
      });
      document.querySelectorAll('input[name="vaultMode"], #syncWizardCustomPass, #syncWizardPassphrase, #syncWizardSecret').forEach((el) => {
        el.disabled = true;
      });
    }
  } else if (s === 2) {
    body.innerHTML = [
      '<p>Choose what to sync, then click Finish.</p>',
      '<label><input type="checkbox" id="wizConn" checked> Connections</label>',
      '<label><input type="checkbox" id="wizQueries" checked> Saved queries</label>',
      '<label><input type="checkbox" id="wizNotebooks" checked> Notebooks</label>',
      '<label><input type="checkbox" id="wizPasswords"> Passwords</label>',
      '<p id="syncWizardCompleteStatus" class="status-line"></p>',
    ].join('');
  } else if (s === 3) {
    body.innerHTML = '<p class="success">Cloud sync is ready.</p><button type="button" id="syncWizardDoneBtn" class="btn-primary">Open Sync Settings</button>';
    $('syncWizardDoneBtn')?.addEventListener('click', () => { $('syncWizardBackdrop').hidden = true; showSyncTab('overview'); });
  }

  $('syncWizardBackBtn').hidden = s === 0;
  updateSyncWizardNextBtn();
}

$('syncWizardNextBtn')?.addEventListener('click', () => {
  const s = syncWizardState.step;
  if (s === 1 && !syncWizardState.vaultReady) {
    syncWizardState.vaultMode = document.querySelector('input[name="vaultMode"]:checked')?.value || 'create';
    const unlock = syncWizardState.vaultMode === 'unlock';
    const statusEl = $('syncWizardVaultStatus');
    if (statusEl) {
      statusEl.textContent = unlock ? 'Unlocking vault…' : 'Creating vault…';
      statusEl.className = 'status-line';
    }
    const btn = $('syncWizardNextBtn');
    if (btn) { btn.disabled = true; }
    vscode.postMessage({
      command: 'sync/wizardVault',
      mode: syncWizardState.vaultMode,
      secretKey: unlock ? ($('syncWizardSecret')?.value || '') : undefined,
      passphrase: !unlock && $('syncWizardCustomPass')?.checked ? ($('syncWizardPassphrase')?.value || '') : undefined,
      legacyEmail: unlock ? ($('syncWizardLegacyEmail')?.value || '') : undefined,
    });
    return;
  }
  if (s === 2) {
    $('syncWizardCompleteStatus').textContent = 'Running first sync…';
    updateSyncWizardNextBtn();
    const btn = $('syncWizardNextBtn');
    if (btn) { btn.disabled = true; }
    vscode.postMessage({
      command: 'sync/wizardComplete',
      providerId: syncWizardState.providerId,
      vaultMode: syncWizardState.vaultMode,
      postgresConnectionId: syncWizardState.postgresConnectionId,
      flags: {
        syncConnections: $('wizConn')?.checked !== false,
        syncQueries: $('wizQueries')?.checked !== false,
        syncNotebooks: $('wizNotebooks')?.checked !== false,
        syncPasswords: !!$('wizPasswords')?.checked,
      },
    });
    return;
  }
  if (s >= 3) {
    $('syncWizardBackdrop').hidden = true;
    return;
  }
  syncWizardState.step += 1;
  renderSyncWizardStep();
});

function showSyncTab(tab) {
  const tabIdMap = {
    overview: 'syncTabOverview',
    settings: 'syncTabSettings',
    items: 'syncTabItems',
    preview: 'syncTabPreview',
    conflicts: 'syncTabConflicts',
    history: 'syncTabHistory',
    shares: 'syncTabShares',
    devices: 'syncTabDevices',
    advanced: 'syncTabAdvanced',
  };
  document.querySelectorAll('.subnav-tab').forEach((b) => b.classList.toggle('active', b.getAttribute('data-sync-tab') === tab));
  Object.entries(tabIdMap).forEach(([key, id]) => {
    const el = $(id);
    if (el) { el.hidden = key !== tab; }
  });
  if (tab === 'history') { vscode.postMessage({ command: 'sync/history' }); }
  if (tab === 'conflicts') { vscode.postMessage({ command: 'sync/conflicts' }); }
  if (tab === 'shares') { vscode.postMessage({ command: 'sync/shares' }); }
  if (tab === 'devices') { vscode.postMessage({ command: 'sync/devices' }); }
  if (tab === 'preview') { vscode.postMessage({ command: 'sync/preview' }); }
  if (tab === 'settings') { vscode.postMessage({ command: 'connections/load' }); }
  if (tab === 'items') {
    vscode.postMessage({ command: 'sync/items' });
    vscode.postMessage({ command: 'sync/pending' });
  }
}

$('syncWizardBackBtn')?.addEventListener('click', () => {
  if (syncWizardState.step > 0) {
    syncWizardState.step -= 1;
    if (syncWizardState.step === 1) {
      syncWizardState.vaultReady = false;
    }
    renderSyncWizardStep();
  }
});

function renderPreviewList(el, items) {
  el.textContent = '';
  if (!items?.length) { el.textContent = 'None'; return; }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'sync-preview-row';
    row.textContent = `[${item.changeType}] ${item.name || item.id} (${item.kind})`;
    el.appendChild(row);
  });
}

function renderConflicts(conflicts) {
  const el = $('syncConflictsList');
  el.textContent = '';
  updateSyncConflictBadges(conflicts?.length || 0);
  if (!conflicts?.length) { el.textContent = 'No conflicts.'; return; }
  conflicts.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'sync-conflict-row';
    row.innerHTML = `<strong>${c.name || c.id}</strong> <span class="label-hint">${c.source}</span>`;
    ['keepMine', 'keepTheirs', 'keepBoth', 'delete', 'diff'].forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-sm';
      btn.textContent = action;
      btn.addEventListener('click', () => vscode.postMessage({ command: 'sync/resolveConflict', conflictId: c.id, resolveAction: action }));
      row.appendChild(btn);
    });
    el.appendChild(row);
  });
}

function formatBytes(n) {
  if (n >= 1073741824) { return (n / 1073741824).toFixed(1) + ' GB'; }
  if (n >= 1048576) { return (n / 1048576).toFixed(1) + ' MB'; }
  return Math.round(n / 1024) + ' KB';
}
$('syncNowBtn').addEventListener('click', () => {
  const btn = $('syncNowBtn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
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

const SYNC_STATUS_PILL_CLASS = {
  synced: 'sync-status-synced',
  idle: 'sync-status-synced',
  syncing: 'sync-status-syncing',
  offline: 'sync-status-paused',
  conflict: 'sync-status-conflict',
  error: 'sync-status-error',
  paused: 'sync-status-paused',
  locked: 'sync-status-paused',
};

function updateSyncStatusPill(status, label) {
  const pill = $('syncStatusPill');
  if (!pill) { return; }
  pill.textContent = label;
  pill.className = 'sync-status-pill';
  const cls = SYNC_STATUS_PILL_CLASS[status];
  if (cls) { pill.classList.add(cls); }
}

function updateSyncConflictBadges(count) {
  const n = Number(count) || 0;
  const conflictsValue = $('syncConflictsValue');
  if (conflictsValue) { conflictsValue.textContent = String(n); }

  const tabBadge = $('syncConflictsTabBadge');
  if (tabBadge) {
    tabBadge.hidden = n <= 0;
    tabBadge.textContent = String(n);
  }

  const quickBtn = $('syncQuickConflicts');
  const quickCount = $('syncQuickConflictsCount');
  if (quickBtn && quickCount) {
    quickBtn.hidden = n <= 0;
    quickCount.textContent = String(n);
  }
}

function updateSyncPendingBadges(count) {
  const tabBadge = $('syncItemsTabBadge');
  if (tabBadge) {
    tabBadge.hidden = count <= 0;
    tabBadge.textContent = String(count);
  }

  const quickBtn = $('syncQuickPending');
  const quickCount = $('syncQuickPendingCount');
  if (quickBtn && quickCount) {
    quickBtn.hidden = count <= 0;
    quickCount.textContent = String(count);
  }
}

let syncItemsCache = [];
let syncPendingItemIds = new Set();

function renderSyncPending(activities) {
  const body = $('syncPendingBody');
  const badge = $('syncPendingBadge');
  syncPendingItemIds = new Set((activities || []).map((a) => a.itemId));
  while (body.firstChild) { body.removeChild(body.firstChild); }

  if (!activities.length) {
    badge.hidden = true;
    updateSyncPendingBadges(0);
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'empty-state';
    td.textContent = 'No pending changes.';
    tr.appendChild(td);
    body.appendChild(tr);
    if (syncItemsCache.length) {
      renderSyncItems(syncItemsCache);
    }
    return;
  }

  badge.hidden = false;
  badge.textContent = String(activities.length);
  updateSyncPendingBadges(activities.length);

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
  if (syncItemsCache.length) {
    renderSyncItems(syncItemsCache);
  }
}

const SYNC_ITEM_STATUS_LABELS = {
  excluded: 'Excluded',
  pending: 'Pending',
  synced: 'Synced',
  local: 'Local only',
};

function formatSyncItemStatus(item) {
  if (item.excluded || item.itemStatus === 'excluded') {
    return 'Excluded';
  }
  if (syncPendingItemIds.has(item.id) || item.itemStatus === 'pending') {
    return 'Pending';
  }
  return SYNC_ITEM_STATUS_LABELS[item.itemStatus] || 'Synced';
}

function getSyncItemsKindFilter() {
  return $('syncItemsKindFilter')?.value || 'all';
}

function renderSyncItems(items) {
  syncItemsCache = items || [];
  const filter = getSyncItemsKindFilter();
  const filtered = filter === 'all'
    ? syncItemsCache
    : syncItemsCache.filter((item) => item.kind === filter);

  const body = $('syncItemsBody');
  while (body.firstChild) { body.removeChild(body.firstChild); }

  if (!filtered.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'empty-state';
    td.textContent = syncItemsCache.length
      ? 'No items match this filter.'
      : 'No items are being synced yet.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const item of filtered) {
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
    const statusLabel = formatSyncItemStatus(item);
    statusTd.textContent = statusLabel;
    if (statusLabel === 'Excluded' || statusLabel === 'Local only') {
      statusTd.classList.add('label-hint');
    }
    if (statusLabel === 'Pending') {
      statusTd.classList.add('sync-item-status-pending');
    }
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
$('syncItemsKindFilter')?.addEventListener('change', () => renderSyncItems(syncItemsCache));
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
$('syncPostgresConnectionSelect')?.addEventListener('change', () => {
  vscode.postMessage({
    command: 'sync/savePostgresConnection',
    postgresConnectionId: $('syncPostgresConnectionSelect').value,
  });
});
$('syncCopyPostgresErrorSqlBtn')?.addEventListener('click', () => {
  const code = $('syncPostgresErrorSqlCode')?.textContent || '';
  navigator.clipboard?.writeText(code);
  const btn = $('syncCopyPostgresErrorSqlBtn');
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }
});
$('syncOpenNotebookPostgresErrorBtn')?.addEventListener('click', () => {
  const connId = latestSyncState?.postgresConnectionId;
  if (connId) {
    vscode.postMessage({
      command: 'sync/openNotebook',
      postgresConnectionId: connId
    });
  }
});
$('syncSettingsCopyPostgresSqlBtn')?.addEventListener('click', () => {
  const code = $('syncSettingsPostgresSqlCode')?.textContent || '';
  navigator.clipboard?.writeText(code);
  const btn = $('syncSettingsCopyPostgresSqlBtn');
  if (btn) {
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
  }
});
$('syncSettingsOpenNotebookPostgresBtn')?.addEventListener('click', () => {
  const connId = $('syncPostgresConnectionSelect')?.value || latestSyncState?.postgresConnectionId;
  if (connId) {
    vscode.postMessage({
      command: 'sync/openNotebook',
      postgresConnectionId: connId
    });
  }
});

function handleSyncMessage(message) {
  switch (message.type) {
    case 'sync/state': {
      const sync = message.sync;
      latestSyncState = sync;
      $('syncState').hidden = true;
      $('syncLocked').hidden = sync.featureEnabled;
      $('syncNotConfigured').hidden = !(sync.featureEnabled && !sync.configured);
      $('syncConfigured').hidden = !(sync.featureEnabled && sync.configured);
      $('syncSectionActions').hidden = !(sync.featureEnabled && sync.configured);

      if (sync.featureEnabled && sync.configured) {
        vscode.postMessage({ command: 'sync/items' });
        vscode.postMessage({ command: 'sync/pending' });
        $('syncHealthHeader').hidden = false;
        const statusLabel = SYNC_STATUS_LABELS[sync.status] || sync.status;
        $('syncHealthLast').textContent = sync.lastSyncAt
          ? 'Last sync: ' + new Date(sync.lastSyncAt).toLocaleString()
          : 'Last sync: never';
        if (sync.lastError) {
          $('syncHealthError').hidden = false;
          $('syncHealthError').textContent = sync.lastError;
        } else {
          $('syncHealthError').hidden = true;
        }
        $('syncStatusValue').textContent = statusLabel;
        updateSyncStatusPill(sync.status, statusLabel);
        $('syncProviderValue').textContent = sync.providerLabel || '—';
        $('syncAccountValue').textContent = sync.accountEmail || '—';
        updateSyncConflictBadges(sync.conflicts);
        $('syncPauseBtn').textContent = sync.paused ? 'Resume' : 'Pause';
        const syncNowBtn = $('syncNowBtn');
        syncNowBtn.disabled = sync.paused || sync.status === 'syncing';
        if (sync.status !== 'syncing' && syncNowBtn.textContent === 'Syncing…') {
          syncNowBtn.textContent = 'Sync Now';
        }
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

        if (sync.providerId === 'postgres') {
          $('syncPostgresSettingsBlock').hidden = false;
          const connSelect = $('syncPostgresConnectionSelect');
          if (connSelect) {
            connSelect.innerHTML = (connState.rows || [])
              .filter(c => c.host)
              .map(c => {
                const details = `${c.host}:${c.port}${c.database ? '/' + c.database : ''}`;
                const label = c.name ? `${c.name} (${details})` : details;
                return `<option value="${c.id}">${escapeText(label)}</option>`;
              })
              .join('\n');
            connSelect.value = sync.postgresConnectionId || '';
            setSelectValue(connSelect, connSelect.value);
          }
          if (sync.lastError) {
            $('syncPostgresErrorSetupBox').hidden = false;
          } else {
            $('syncPostgresErrorSetupBox').hidden = true;
          }
        } else {
          $('syncPostgresSettingsBlock').hidden = true;
          $('syncPostgresErrorSetupBox').hidden = true;
        }

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
      $('syncNowBtn').disabled = true;
      $('syncNowBtn').textContent = 'Syncing…';
      if ($('syncRunMessage')) {
        $('syncRunMessage').className = 'status-line';
        $('syncRunMessage').textContent = 'Syncing…';
      }
      break;
    case 'sync/runComplete': {
      const el = $('syncRunMessage');
      const btn = $('syncNowBtn');
      btn.textContent = 'Sync Now';
      if (message.result) {
        el.className = 'status-line success';
        el.textContent = formatSyncRunMessage(message.result);
      } else {
        el.className = 'status-line error';
        el.textContent = formatSyncRunMessage(null);
      }
      break;
    }
    case 'sync/preview':
      renderPreviewList($('syncPreviewOutgoing'), message.preview?.outgoing);
      renderPreviewList($('syncPreviewIncoming'), message.preview?.incoming);
      renderPreviewList($('syncPreviewConflicts'), message.preview?.conflictItems);
      break;
    case 'sync/history': {
      const body = $('syncHistoryBody');
      body.textContent = '';
      const hist = message.history || [];
      if (!hist.length) {
        body.innerHTML = '<tr><td colspan="3" class="empty-state">No inbound history yet.</td></tr>';
        break;
      }
      hist.forEach((h) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${h.name || h.itemId}</td><td>${h.deviceName || h.deviceId}</td><td>${formatSyncTimestamp(h.appliedAt)}</td>`;
        body.appendChild(tr);
      });
      break;
    }
    case 'sync/conflicts':
      renderConflicts(message.conflicts || []);
      break;
    case 'sync/shares': {
      const outEl = $('syncOutgoingShares');
      const inEl = $('syncIncomingShares');
      outEl.textContent = '';
      inEl.textContent = '';
      (message.outgoing || []).forEach((s) => {
        const row = document.createElement('div');
        row.textContent = `${s.name || s.shareId} → ${s.granteeEmail}${s.revoked ? ' (revoked)' : ''} `;
        if (!s.revoked) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-secondary btn-sm';
          btn.textContent = 'Revoke';
          btn.addEventListener('click', () => vscode.postMessage({ command: 'sync/revokeShare', shareId: s.shareId }));
          row.appendChild(btn);
        }
        outEl.appendChild(row);
      });
      (message.incoming || []).forEach((s) => {
        const row = document.createElement('div');
        row.textContent = `${s.name || s.shareId} from ${s.ownerEmail}`;
        inEl.appendChild(row);
      });
      break;
    }
    case 'sync/devices': {
      const el = $('syncDevicesList');
      el.textContent = '';
      (message.devices || []).forEach((d) => {
        const row = document.createElement('div');
        row.textContent = `${d.deviceName || d.deviceId}${d.isThisDevice ? ' (this device)' : ''} — ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : ''} `;
        if (!d.isThisDevice) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-secondary btn-sm';
          btn.textContent = 'Revoke';
          btn.addEventListener('click', () => vscode.postMessage({ command: 'sync/revokeDevice', deviceId: d.deviceId }));
          row.appendChild(btn);
        }
        el.appendChild(row);
      });
      break;
    }
    case 'sync/quota': {
      const q = message.quota;
      const el = $('syncHealthQuota');
      if (q && el) {
        el.hidden = false;
        el.textContent = `${formatBytes(q.bytesUsed)} / ${formatBytes(q.bytesLimit)} (${q.itemCount} items)`;
      } else if (el) {
        el.hidden = true;
      }
      break;
    }
    case 'sync/openWizard':
      openSyncWizard(message.mode || 'cloud');
      break;
    case 'sync/wizardWelcome':
      if ($('syncWizardTier')) {
        $('syncWizardTier').textContent = 'Plan: ' + (message.tierLabel || message.tier);
      }
      break;
    case 'sync/wizardSignInStatus':
      if ($('syncWizardSignInStatus')) {
        $('syncWizardSignInStatus').textContent = message.status || '';
      }
      break;
    case 'sync/wizardSignInResult': {
      const statusEl = $('syncWizardSignInStatus');
      if (statusEl) {
        statusEl.textContent = message.ok
          ? ('Connected' + (message.email ? ' — ' + message.email : ''))
          : (message.error || 'Sign-in failed');
        statusEl.className = 'status-line' + (message.ok ? ' success' : ' error');
      }
      if (message.ok) {
        syncWizardState.signedIn = true;
        $('syncWizardEnableBtn') && ($('syncWizardEnableBtn').disabled = true);
        updateSyncWizardNextBtn();
      } else {
        $('syncWizardEnableBtn') && ($('syncWizardEnableBtn').disabled = false);
        $('syncWizardBrowserBtn') && ($('syncWizardBrowserBtn').disabled = false);
      }
      break;
    }
    case 'sync/wizardVaultResult': {
      const vaultStatus = $('syncWizardVaultStatus');
      if (vaultStatus) {
        vaultStatus.textContent = message.ok ? 'Vault ready' : (message.error || 'Vault failed');
        vaultStatus.className = 'status-line' + (message.ok ? ' success' : ' error');
      }
      if (message.secretKey) { syncWizardState.secretKey = message.secretKey; }
      if (message.generation) { syncWizardState.generation = message.generation; }
      if (message.ok) {
        syncWizardState.vaultReady = true;
        if (syncWizardState.vaultMode === 'create' && message.secretKey) {
          vscode.postMessage({
            command: 'sync/wizardRecoveryKit',
            generation: syncWizardState.generation,
            secretKey: message.secretKey,
            customPassphrase: syncWizardState.customPassphrase,
          });
        }
        renderSyncWizardStep();
        updateSyncWizardNextBtn();
      } else {
        updateSyncWizardNextBtn();
      }
      break;
    }
    case 'sync/wizardCompleteResult': {
      const completeStatus = $('syncWizardCompleteStatus');
      if (message.ok) {
        if (completeStatus) {
          completeStatus.textContent = 'Sync complete.';
          completeStatus.className = 'status-line success';
        }
        syncWizardState.step = 3;
        renderSyncWizardStep();
      } else {
        if (completeStatus) {
          completeStatus.textContent = message.error || 'Setup failed';
          completeStatus.className = 'status-line error';
        }
        const btn = $('syncWizardNextBtn');
        if (btn) { btn.disabled = false; }
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

$('licenseEmailVerifyBtn').addEventListener('click', () => {
  const email = $('licenseOwnerEmailInput').value.trim();
  const msg = $('licenseEmailMessage');
  if (!email) {
    msg.className = 'status-line error';
    msg.textContent = 'Enter your subscription email.';
    return;
  }
  msg.className = 'status-line';
  msg.textContent = 'Verifying…';
  vscode.postMessage({ command: 'license/setEmail', email });
});

$('licenseOwnerEmailInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    $('licenseEmailVerifyBtn').click();
  }
});

function renderLicenseDevices(devices) {
  const body = $('licenseDevicesBody');
  body.replaceChildren();
  devices.forEach((d) => {
    const tr = document.createElement('tr');
    const machineTd = document.createElement('td');
    const label = d.isCurrent ? 'this machine' : (d.instanceId || '').slice(0, 8) + '…';
    machineTd.textContent = label;
    if (d.isCurrent) machineTd.className = 'device-current';

    const seenTd = document.createElement('td');
    seenTd.textContent = d.lastSeen
      ? new Date(d.lastSeen).toLocaleDateString()
      : '—';

    const actionTd = document.createElement('td');
    if (!d.isCurrent && d.instanceId) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-link';
      btn.textContent = 'Remove';
      btn.addEventListener('click', () => {
        $('licenseDeviceMessage').className = 'status-line';
        $('licenseDeviceMessage').textContent = 'Removing…';
        vscode.postMessage({ command: 'license/removeDevice', instanceId: d.instanceId });
      });
      actionTd.appendChild(btn);
    }

    tr.appendChild(machineTd);
    tr.appendChild(seenTd);
    tr.appendChild(actionTd);
    body.appendChild(tr);
  });
}

function renderLicenseHistory(events) {
  const list = $('licenseHistoryList');
  list.replaceChildren();
  if (!events || !events.length) {
    const li = document.createElement('li');
    li.textContent = 'No history yet.';
    list.appendChild(li);
    return;
  }
  events.forEach((ev) => {
    const li = document.createElement('li');
    const date = document.createElement('span');
    date.className = 'history-date';
    date.textContent = ev.createdAt
      ? new Date(ev.createdAt).toLocaleDateString()
      : '—';
    const summary = document.createElement('span');
    summary.className = 'history-summary';
    summary.textContent = ev.summary || '';
    li.appendChild(date);
    li.appendChild(summary);
    list.appendChild(li);
  });
}

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

      const statusLabel = lic.cachedStatus
        ? String(lic.cachedStatus).toUpperCase()
        : '—';
      $('licenseStatusRow').hidden = !isPaid || !lic.cachedStatus;
      $('licenseStatusValue').textContent = statusLabel;

      $('licensePeriodRow').hidden = !lic.period;
      $('licensePeriodValue').textContent = lic.period
        ? lic.period.charAt(0).toUpperCase() + lic.period.slice(1)
        : '—';

      $('licenseExpiryRow').hidden = !lic.expiresAt;
      $('licenseExpiryValue').textContent = lic.expiresAt
        ? new Date(lic.expiresAt).toLocaleDateString()
        : '—';

      $('licenseEmailRow').hidden = !lic.maskedEmail;
      $('licenseEmailValue').textContent = lic.maskedEmail || '—';

      $('licenseMemberRow').hidden = !lic.memberSince;
      $('licenseMemberValue').textContent = lic.memberSince
        ? new Date(lic.memberSince).toLocaleDateString()
        : '—';

      $('licenseRenewalsRow').hidden = lic.renewalCount == null;
      $('licenseRenewalsValue').textContent = lic.renewalCount != null
        ? String(lic.renewalCount)
        : '—';

      $('licenseGraceRow').hidden = !lic.gracePeriodStartedAt;
      $('licenseGraceValue').textContent = lic.gracePeriodStartedAt
        ? 'started ' + new Date(lic.gracePeriodStartedAt).toLocaleDateString()
        : '—';

      $('licenseDeactivateBtn').hidden = !isPaid;
      $('licenseActivateBox').hidden = isPaid;
      $('licenseEmailBox').hidden = !lic.needsEmail;
      if (lic.ownerEmail) {
        $('licenseOwnerEmailInput').value = lic.ownerEmail;
      }

      const hasDevices = lic.devices && lic.devices.length > 0;
      $('licenseDevicesBox').hidden = !hasDevices;
      if (hasDevices) {
        const used = lic.devices.length;
        const limit = lic.deviceLimit || used;
        $('licenseDevicesTitle').textContent = 'Devices (' + used + '/' + limit + ')';
        renderLicenseDevices(lic.devices);
      }

      const hasHistory = lic.history && lic.history.length > 0;
      $('licenseHistoryBox').hidden = !hasHistory;
      if (hasHistory) {
        renderLicenseHistory(lic.history);
      }

      $('licenseQuotaBox').hidden = !(lic.quotas && lic.quotas.length);
      if (lic.quotas && lic.quotas.length) {
        $('licenseQuotaTitle').textContent = isPaid
          ? 'Usage — unlimited on your plan'
          : 'Free usage remaining';
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
    case 'license/emailResult': {
      const msg = $('licenseEmailMessage');
      msg.className = 'status-line ' + (message.ok ? 'success' : 'error');
      msg.textContent = (message.ok ? '✓ ' : '✗ ') + message.message;
      break;
    }
    case 'license/deviceResult': {
      const msg = $('licenseDeviceMessage');
      msg.className = 'status-line ' + (message.ok ? 'success' : 'error');
      msg.textContent = (message.ok ? '✓ ' : '✗ ') + message.message;
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
    if (message.wizard && message.section === 'sync') {
      openSyncWizard(message.wizard);
    }
    if (message.tab && message.section === 'sync') {
      showSyncTab(message.tab);
    }
    return;
  }

  const prefix = type.split('/')[0];
  switch (prefix) {
    case 'connections': handleConnectionsMessage(message); break;
    case 'ai': handleAiMessage(message); break;
    case 'prefs': handlePrefsMessage(message); break;
    case 'sentinel': handleSentinelMessage(message); break;
    case 'sync': handleSyncMessage(message); break;
    case 'license': handleLicenseMessage(message); break;
  }
});

// Enhance all static selects before first paint of dropdown UI.
enhanceAllSelects(document);

// Boot with the deep-linked initial state injected by the host.
initPlatformPresetSelect();

if (initialState.prefillConnectionUrl) {
  vscode.postMessage({
    command: 'connections/parseEnvUrl',
    url: initialState.prefillConnectionUrl,
  });
}

if (initialState.editConnectionId) { connState.pendingEditId = initialState.editConnectionId; }
if (initialState.addConnection) { connState.pendingAdd = true; }
showSection(initialState.section || 'connections');
if (initialState.wizard && initialState.section === 'sync') { openSyncWizard(initialState.wizard); }
if (initialState.tab && initialState.section === 'sync') { showSyncTab(initialState.tab); }
