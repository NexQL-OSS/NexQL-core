// NexQL Settings Hub webview controller.
// Message protocol: webview → host `{ command: '<section>/<action>', ... }`,
// host → webview `{ type: '<section>/<event>', ... }`.

const vscode = acquireVsCodeApi();
const initialState = {{INITIAL_STATE}};

/** @type {Record<string, { id: string, label: string, hint: string, hostPlaceholder: string, iconUri: string, defaults: { port: number, sslmode: string, applicationName?: string } }>} */
const platformPresetById = Object.fromEntries(
  (initialState.platformPresets || []).map((p) => [p.id, p]),
);

window.onerror = function (msg) {
  console.error('[NexQL Settings Hub] Error:', msg);
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
  const panel = wrap.pgSelectPanel || wrap.querySelector('.pg-select-panel');
  const trigger = wrap.querySelector('.pg-select-trigger');
  if (panel) {
    panel.hidden = true;
    resetPgSelectPanelPosition(panel);
    if (panel.parentNode === document.body) {
      wrap.appendChild(panel);
    }
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
    if (!event.target.closest('.pg-select') && !event.target.closest('.pg-select-panel')) {
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
  if (selectEl.classList.contains('hidden') || selectEl.hasAttribute('hidden')) {
    wrap.classList.add('hidden');
  }

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

  wrap.pgSelectPanel = panel;

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
    
    const hasGroups = Array.from(selectEl.children).some(child => child.tagName === 'OPTGROUP');
    
    if (hasGroups) {
      Array.from(selectEl.children).forEach(child => {
        if (child.tagName === 'OPTGROUP') {
          const groupHeader = document.createElement('div');
          groupHeader.className = 'pg-select-group-header';
          groupHeader.textContent = child.label;
          panel.appendChild(groupHeader);
          
          Array.from(child.children).forEach(opt => {
            addOptionButton(opt);
          });
        } else if (child.tagName === 'OPTION') {
          addOptionButton(child);
        }
      });
    } else {
      Array.from(selectEl.options).forEach((opt) => {
        addOptionButton(opt);
      });
    }
    
    function addOptionButton(opt) {
      const optionBtn = document.createElement('button');
      optionBtn.type = 'button';
      optionBtn.className = 'pg-select-option';
      optionBtn.setAttribute('role', 'option');
      optionBtn.dataset.value = opt.value;
      appendPgSelectOptionLabel(optionBtn, opt);
      optionBtn.disabled = !!opt.disabled;
      
      if (opt.parentNode && opt.parentNode.tagName === 'OPTGROUP' && opt.parentNode.dataset.unconfigured === 'true') {
        optionBtn.classList.add('pg-select-option--unconfigured');
      }
      
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
    }
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
    document.body.appendChild(panel);
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

const SECTIONS = ['connections', 'ai', 'prefs', 'dbindex', 'sentinel', 'sync', 'license'];
let activeSection = null;

function loadSection(section) {
  switch (section) {
    case 'connections': vscode.postMessage({ command: 'connections/load' }); break;
    case 'ai': vscode.postMessage({ command: 'ai/load' }); break;
    case 'prefs': vscode.postMessage({ command: 'prefs/load' }); break;
    case 'sentinel': vscode.postMessage({ command: 'sentinel/load' }); break;
    case 'sync': vscode.postMessage({ command: 'sync/load' }); break;
    case 'license': vscode.postMessage({ command: 'license/load' }); break;
    case 'dbindex': vscode.postMessage({ command: 'dbindex/load' }); break;
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

// Single primary action: Test Connection until tested, then Save.
function updateActionButtons() {
  const tested = !!connState.isTested;
  connTestBtn.hidden = tested;
  // Test is the sole action until the connection passes — style it as primary.
  connTestBtn.className = 'btn-primary';
  connSaveBtn.hidden = !tested;
  connSaveBtn.disabled = !tested;
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
  updateActionButtons();
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
      updateActionButtons();
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
          ? '\n\nOptional: tag this server’s environment before saving.'
          : '';
        const envActions = message.suggestEnvironmentTag ? [
          { label: 'Production', onClick: () => { $('environment').value = 'production'; updateProductionWarning(); syncConnFormSelects(); } },
          { label: 'Staging', onClick: () => { $('environment').value = 'staging'; updateProductionWarning(); syncConnFormSelects(); } },
          { label: 'Development', onClick: () => { $('environment').value = 'development'; updateProductionWarning(); syncConnFormSelects(); } },
        ] : undefined;
        connShowFormMessage(
          successText + envNudge,
          message.suggestEnvironmentTag || message.pgVersionWarning || message.poolerWarning ? 'info' : 'success',
          envActions,
        );
        connState.isTested = true;
        updateActionButtons();
      } else {
        connState.isTested = false;
        updateActionButtons();
        if (isSslDowngradeError(message.error)) {
          connShowFormMessage(message.error || 'Connection failed', 'error', [{
            label: 'Set SSL Mode to Disable',
            onClick: () => {
              $('sslmode').value = 'disable';
              $('advancedDetails').open = true;
              updateSSLCertFields();
              connState.isTested = false;
              updateActionButtons();
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
      setSaveLabel();
      updateActionButtons();
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

const aiSaveBtn = $('aiSaveBtn');
const aiSaveStatus = $('aiSaveStatus');
const githubBanner = $('githubAuthBanner');
const githubStatusText = $('githubAuthStatusText');
const githubConnectBtn = $('githubConnectBtn');
const githubDisconnectBtn = $('githubDisconnectBtn');
let githubAuthState = { connected: false, accountLabel: '' };
let activeTestProvider = null;
let activeTestScope = null;

const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const DEFAULT_LMSTUDIO_ENDPOINT = 'http://localhost:1234/v1/chat/completions';

const ALL_PROVIDERS = [
  { id: 'vscode-lm', name: 'VS Code Language Model' },
  { id: 'github', name: 'GitHub Models' },
  { id: 'cursor', name: 'Cursor SDK' },
  { id: 'opencode', name: 'OpenCode' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic (Claude)' },
  { id: 'gemini', name: 'Google Gemini' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'moonshot', name: 'Moonshot / Kimi' },
  { id: 'mistral', name: 'Mistral AI' },
  { id: 'ollama', name: 'Ollama' },
  { id: 'lmstudio', name: 'LM Studio' },
  { id: 'custom', name: 'Custom Endpoint' }
];

function populateDefaultProviders() {
  const notebookSelect = $('defaultNotebookProvider');
  const chatSelect = $('defaultChatProvider');
  if (!notebookSelect || !chatSelect) return;
  
  const currentNotebookVal = notebookSelect.value;
  const currentChatVal = chatSelect.value;
  
  notebookSelect.textContent = '';
  chatSelect.textContent = '';
  
  const keys = {
    openai: $('apiKey-openai')?.value.trim() || '',
    anthropic: $('apiKey-anthropic')?.value.trim() || '',
    gemini: $('apiKey-gemini')?.value.trim() || '',
    deepseek: $('apiKey-deepseek')?.value.trim() || '',
    moonshot: $('apiKey-moonshot')?.value.trim() || '',
    mistral: $('apiKey-mistral')?.value.trim() || '',
    custom: $('apiKey-custom')?.value.trim() || '',
  };
  const cursorKey = $('apiKey-cursor')?.value.trim() || '';
  
  const isConfigured = (provId) => {
    if (['vscode-lm', 'opencode', 'ollama', 'lmstudio', 'cursor'].includes(provId)) {
      return true;
    }
    if (provId === 'github') {
      return !!githubAuthState.connected;
    }
    return !!keys[provId];
  };
  
  const configuredNotebookGroup = document.createElement('optgroup');
  configuredNotebookGroup.label = 'Ready to Use';
  
  const unconfiguredNotebookGroup = document.createElement('optgroup');
  unconfiguredNotebookGroup.label = 'Requires Configuration';
  unconfiguredNotebookGroup.dataset.unconfigured = 'true';
  
  const configuredChatGroup = document.createElement('optgroup');
  configuredChatGroup.label = 'Ready to Use';
  
  const unconfiguredChatGroup = document.createElement('optgroup');
  unconfiguredChatGroup.label = 'Requires Configuration';
  unconfiguredChatGroup.dataset.unconfigured = 'true';
  
  ALL_PROVIDERS.forEach(p => {
    const ready = isConfigured(p.id);
    
    const opt1 = document.createElement('option');
    opt1.value = p.id;
    opt1.textContent = p.name;
    if (ready) {
      configuredNotebookGroup.appendChild(opt1);
    } else {
      unconfiguredNotebookGroup.appendChild(opt1);
    }
    
    const opt2 = document.createElement('option');
    opt2.value = p.id;
    opt2.textContent = p.name;
    if (ready) {
      configuredChatGroup.appendChild(opt2);
    } else {
      unconfiguredChatGroup.appendChild(opt2);
    }
  });
  
  if (configuredNotebookGroup.children.length > 0) {
    notebookSelect.appendChild(configuredNotebookGroup);
  }
  if (unconfiguredNotebookGroup.children.length > 0) {
    notebookSelect.appendChild(unconfiguredNotebookGroup);
  }
  
  if (configuredChatGroup.children.length > 0) {
    chatSelect.appendChild(configuredChatGroup);
  }
  if (unconfiguredChatGroup.children.length > 0) {
    chatSelect.appendChild(unconfiguredChatGroup);
  }
  
  if (currentNotebookVal) {
    notebookSelect.value = currentNotebookVal;
  }
  if (currentChatVal) {
    chatSelect.value = currentChatVal;
  }
  
  const stateNotebook = pgSelectRegistry.get(notebookSelect);
  if (stateNotebook) {
    stateNotebook.rebuildOptions();
  }
  const stateChat = pgSelectRegistry.get(chatSelect);
  if (stateChat) {
    stateChat.rebuildOptions();
  }
}

// Call it immediately
populateDefaultProviders();

// Collapse provider cards in AI section only
document.querySelectorAll('#section-ai .hub-setting-card').forEach((card) => {
  card.classList.add('collapsed');
});

document.querySelectorAll('#section-ai .hub-setting-card-header--collapsible').forEach((header) => {
  header.addEventListener('click', function (e) {
    if (e.target.closest('a') || e.target.closest('button') || e.target.closest('input') || e.target.closest('select')) {
      return;
    }
    const card = this.closest('.hub-setting-card');
    if (card) {
      card.classList.toggle('collapsed');
    }
  });
});

// Global switch tab helper
window.switchAiTab = function(tabName, cardId) {
  const btn = document.querySelector(`.hub-tab-strip .hub-tab-btn[data-hub-tab="${tabName}"]`);
  if (btn) {
    btn.click();
  }
  const card = $(cardId);
  if (card) {
    card.classList.remove('collapsed'); // Expand card when navigated to!
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.classList.add('highlight-pulse');
    setTimeout(() => {
      card.classList.remove('highlight-pulse');
    }, 2000);
  }
};

// AI tab switching (scoped to AI section only)
document.querySelectorAll('#section-ai .hub-tab-strip .hub-tab-btn[data-hub-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tabName = btn.getAttribute('data-hub-tab');

    document.querySelectorAll('#section-ai .hub-tab-strip .hub-tab-btn[data-hub-tab]').forEach((b) => {
      b.classList.remove('active');
      b.setAttribute('aria-selected', 'false');
    });
    document.querySelectorAll('#section-ai .hub-tab-panel').forEach((p) => {
      p.classList.remove('active');
    });

    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const panel = $('hub-tab-' + tabName);
    if (panel) {
      panel.classList.add('active');
    }
  });
});

function aiShowMessage(text, isError) {
  const target = aiSaveStatus;
  if (!target) return;
  target.className = isError ? 'hub-save-status error' : 'hub-save-status success';
  target.textContent = text;
}

function aiHideMessage() {
  const target = aiSaveStatus;
  if (!target) return;
  target.textContent = '';
  target.className = 'hub-save-status';
}

function updateKeyStatusIcon(provider, hasKey) {
  const icon = $('status-icon-' + provider);
  const card = $('card-' + provider);
  if (icon) {
    if (hasKey) {
      icon.className = 'hub-card-status-dot ok';
      icon.textContent = '✓';
      icon.title = (provider === 'github') ? 'Connected' : 'API key saved';
    } else {
      icon.className = 'hub-card-status-dot empty';
      icon.textContent = '○';
      icon.title = (provider === 'github') ? 'Not connected' : 'No API key saved';
    }
  }
  if (card) {
    if (hasKey) {
      card.classList.add('has-key');
    } else {
      card.classList.remove('has-key');
    }
  }
}

function updateDefaultTabStatus() {
  populateDefaultProviders();
  
  const notebookProvider = $('defaultNotebookProvider')?.value;
  const chatProvider = $('defaultChatProvider')?.value;
  
  updateScopeStatus('Notebook', notebookProvider);
  updateScopeStatus('Chat', chatProvider);
}

function updateScopeStatus(scope, provider) {
  const keys = {
    openai: $('apiKey-openai')?.value.trim() || '',
    anthropic: $('apiKey-anthropic')?.value.trim() || '',
    gemini: $('apiKey-gemini')?.value.trim() || '',
    deepseek: $('apiKey-deepseek')?.value.trim() || '',
    moonshot: $('apiKey-moonshot')?.value.trim() || '',
    mistral: $('apiKey-mistral')?.value.trim() || '',
    custom: $('apiKey-custom')?.value.trim() || '',
  };
  const cursorKey = $('apiKey-cursor')?.value.trim() || '';
  const statusDiv = $('default' + scope + 'KeyStatus');
  if (!statusDiv) return;
  
  statusDiv.textContent = '';
  statusDiv.className = 'scope-key-status';
  
  const needsKey = ['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(provider);
  if (needsKey) {
    let hasKey = false;
    let tabName = 'cloud';
    if (provider === 'custom') {
      hasKey = !!keys.custom;
      tabName = 'local';
    } else {
      hasKey = !!keys[provider];
      tabName = 'cloud';
    }
    
    if (hasKey) {
      statusDiv.className = 'scope-key-status success';
      statusDiv.innerHTML = '✓ API key is saved.';
    } else {
      statusDiv.className = 'scope-key-status warning';
      statusDiv.innerHTML = `⚠️ API key is required. <a href="#" onclick="switchAiTab('${tabName}', 'card-${provider}')">Configure key →</a>`;
    }
  } else if (provider === 'github') {
    if (githubAuthState.connected) {
      statusDiv.className = 'scope-key-status success';
      statusDiv.innerHTML = `✓ Connected as ${githubAuthState.accountLabel || 'GitHub user'}.`;
    } else {
      statusDiv.className = 'scope-key-status warning';
      statusDiv.innerHTML = `⚠️ GitHub account is not connected. <a href="#" onclick="switchAiTab('platform', 'card-github')">Connect account →</a>`;
    }
  } else {
    statusDiv.className = 'scope-key-status success';
    statusDiv.innerHTML = '✓ No API key required.';
  }
}

function autoLoadModels(provider, apiKey, endpoint, options = {}) {
  const allowPrompt = options.allowPrompt !== false;
  const scope = options.scope || '';
  
  const settings = { provider, apiKey: apiKey || '', endpoint: endpoint || '', scope };
  
  if (provider === 'vscode-lm') {
    vscode.postMessage({ command: 'ai/listModels', settings });
  } else if (provider === 'github') {
    if (allowPrompt || options.force) {
      vscode.postMessage({ command: 'ai/listModels', settings });
    }
  } else if (provider === 'cursor') {
    vscode.postMessage({ command: 'ai/listModels', settings });
  } else if (provider === 'opencode') {
    vscode.postMessage({ command: 'ai/listModels', settings });
  } else if (provider === 'anthropic') {
    if (apiKey) {
      vscode.postMessage({ command: 'ai/listModels', settings });
    }
  } else if (['openai', 'gemini', 'deepseek', 'moonshot', 'mistral'].includes(provider) && apiKey) {
    vscode.postMessage({ command: 'ai/listModels', settings });
  } else if (provider === 'custom' && endpoint) {
    vscode.postMessage({ command: 'ai/listModels', settings });
  } else if (provider === 'ollama') {
    vscode.postMessage({ command: 'ai/listModels', settings: { ...settings, endpoint: endpoint || DEFAULT_OLLAMA_ENDPOINT } });
  } else if (provider === 'lmstudio') {
    vscode.postMessage({ command: 'ai/listModels', settings: { ...settings, endpoint: endpoint || DEFAULT_LMSTUDIO_ENDPOINT } });
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
  const apiKeys = {
    openai: $('apiKey-openai')?.value.trim() || '',
    anthropic: $('apiKey-anthropic')?.value.trim() || '',
    gemini: $('apiKey-gemini')?.value.trim() || '',
    deepseek: $('apiKey-deepseek')?.value.trim() || '',
    moonshot: $('apiKey-moonshot')?.value.trim() || '',
    mistral: $('apiKey-mistral')?.value.trim() || '',
    custom: $('apiKey-custom')?.value.trim() || '',
  };
  const cursorApiKey = $('apiKey-cursor')?.value.trim() || '';
  
  const defaultNotebookProvider = $('defaultNotebookProvider')?.value || 'vscode-lm';
  const defaultChatProvider = $('defaultChatProvider')?.value || 'vscode-lm';
  
  let endpoint = '';
  if (defaultNotebookProvider === 'ollama') {
    endpoint = $('endpoint-ollama')?.value.trim() || '';
  } else if (defaultNotebookProvider === 'lmstudio') {
    endpoint = $('endpoint-lmstudio')?.value.trim() || '';
  } else if (defaultNotebookProvider === 'custom') {
    endpoint = $('endpoint-custom')?.value.trim() || '';
  } else if (defaultChatProvider === 'ollama') {
    endpoint = $('endpoint-ollama')?.value.trim() || '';
  } else if (defaultChatProvider === 'lmstudio') {
    endpoint = $('endpoint-lmstudio')?.value.trim() || '';
  } else if (defaultChatProvider === 'custom') {
    endpoint = $('endpoint-custom')?.value.trim() || '';
  }

  return {
    apiKeys,
    cursorApiKey,
    defaultNotebookProvider,
    defaultNotebookModel: modelValueForScope('Notebook'),
    defaultChatProvider,
    defaultChatModel: modelValueForScope('Chat'),
    endpoint,
    opencodeCliPath: $('opencodeCliPath')?.value.trim() || '',
    opencodeServeUrl: $('opencodeServeUrl')?.value.trim() || '',
    opencodeAutoServe: $('opencodeAutoServe')?.checked !== false,
    opencodeShowLog: $('opencodeShowLog')?.checked !== false,
    opencodeSkipPermissions: $('opencodeSkipPermissions')?.checked !== false,
    opencodeAutoApprovePermissions: $('opencodeAutoApprovePermissions')?.checked !== false,
    opencodeServePort: parseInt($('opencodeServePort')?.value || '0', 10) || 0,
  };
}

function setAiFormData(settings) {
  const keys = settings.apiKeys || {};
  const setVal = (id, value) => { const el = $(id); if (el) { el.value = value; } };
  
  setVal('apiKey-openai', keys.openai || '');
  setVal('apiKey-anthropic', keys.anthropic || '');
  setVal('apiKey-gemini', keys.gemini || '');
  setVal('apiKey-deepseek', keys.deepseek || '');
  setVal('apiKey-moonshot', keys.moonshot || '');
  setVal('apiKey-mistral', keys.mistral || '');
  setVal('apiKey-cursor', settings.cursorApiKey || '');
  setVal('apiKey-custom', keys.custom || '');
  
  updateKeyStatusIcon('openai', !!keys.openai);
  updateKeyStatusIcon('anthropic', !!keys.anthropic);
  updateKeyStatusIcon('gemini', !!keys.gemini);
  updateKeyStatusIcon('deepseek', !!keys.deepseek);
  updateKeyStatusIcon('moonshot', !!keys.moonshot);
  updateKeyStatusIcon('mistral', !!keys.mistral);
  updateKeyStatusIcon('cursor', !!settings.cursorApiKey);
  updateKeyStatusIcon('custom', !!keys.custom);
  
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
  
  if (settings.endpoint) {
    if (settings.notebookProvider === 'ollama' || settings.chatProvider === 'ollama') {
      setVal('endpoint-ollama', settings.endpoint);
    } else if (settings.notebookProvider === 'lmstudio' || settings.chatProvider === 'lmstudio') {
      setVal('endpoint-lmstudio', settings.endpoint);
    } else {
      setVal('endpoint-custom', settings.endpoint);
    }
  }
  
  const lastModels = settings.lastModels || {};
  const providerModels = {
    'openai': settings.notebookProvider === 'openai' ? settings.notebookModel : (settings.chatProvider === 'openai' ? settings.chatModel : (lastModels.openai || '')),
    'anthropic': settings.notebookProvider === 'anthropic' ? settings.notebookModel : (settings.chatProvider === 'anthropic' ? settings.chatModel : (lastModels.anthropic || '')),
    'gemini': settings.notebookProvider === 'gemini' ? settings.notebookModel : (settings.chatProvider === 'gemini' ? settings.chatModel : (lastModels.gemini || '')),
    'deepseek': settings.notebookProvider === 'deepseek' ? settings.notebookModel : (settings.chatProvider === 'deepseek' ? settings.chatModel : (lastModels.deepseek || '')),
    'moonshot': settings.notebookProvider === 'moonshot' ? settings.notebookModel : (settings.chatProvider === 'moonshot' ? settings.chatModel : (lastModels.moonshot || '')),
    'mistral': settings.notebookProvider === 'mistral' ? settings.notebookModel : (settings.chatProvider === 'mistral' ? settings.chatModel : (lastModels.mistral || '')),
    'vscode-lm': settings.notebookProvider === 'vscode-lm' ? settings.notebookModel : (settings.chatProvider === 'vscode-lm' ? settings.chatModel : (lastModels['vscode-lm'] || '')),
    'github': settings.notebookProvider === 'github' ? settings.notebookModel : (settings.chatProvider === 'github' ? settings.chatModel : (lastModels.github || '')),
    'cursor': settings.notebookProvider === 'cursor' ? settings.notebookModel : (settings.chatProvider === 'cursor' ? settings.chatModel : (lastModels.cursor || '')),
    'opencode': settings.notebookProvider === 'opencode' ? settings.notebookModel : (settings.chatProvider === 'opencode' ? settings.chatModel : (lastModels.opencode || '')),
    'ollama': settings.notebookProvider === 'ollama' ? settings.notebookModel : (settings.chatProvider === 'ollama' ? settings.chatModel : (lastModels.ollama || '')),
    'lmstudio': settings.notebookProvider === 'lmstudio' ? settings.notebookModel : (settings.chatProvider === 'lmstudio' ? settings.chatModel : (lastModels.lmstudio || '')),
    'custom': settings.notebookProvider === 'custom' ? settings.notebookModel : (settings.chatProvider === 'custom' ? settings.chatModel : (lastModels.custom || ''))
  };
  
  Object.keys(providerModels).forEach(prov => {
    setVal('model-' + prov, providerModels[prov]);
  });
  
  if (settings.notebookProvider) {
    setSelectValue($('defaultNotebookProvider'), settings.notebookProvider);
  }
  if (settings.chatProvider) {
    setSelectValue($('defaultChatProvider'), settings.chatProvider);
  }

  // Set default model inputs/selects
  setVal('defaultNotebookModel', settings.notebookModel || '');
  setVal('defaultChatModel', settings.chatModel || '');

  // Synchronize status alerts for default tab
  updateDefaultTabStatus();
}

if (aiSaveBtn) {
  aiSaveBtn.addEventListener('click', () => {
    aiHideMessage();
    aiSaveBtn.disabled = true;
    aiSaveBtn.textContent = 'Saving…';
    vscode.postMessage({ command: 'ai/save', settings: getAiFormData() });
  });
}

document.querySelectorAll('.ai-test-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const provider = this.getAttribute('data-provider');
    const statusSpan = $('card-status-' + provider);
    if (statusSpan) {
      statusSpan.textContent = 'Testing…';
      statusSpan.className = 'hub-card-status loading';
    }
    this.disabled = true;
    
    let apiKey = '';
    let endpoint = '';
    const model = modelValueFor(provider);
    
    if (provider === 'cursor') {
      apiKey = $('apiKey-cursor')?.value.trim() || '';
    } else if (['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(provider)) {
      apiKey = $('apiKey-' + provider)?.value.trim() || '';
    }
    
    if (provider === 'custom') {
      endpoint = $('endpoint-custom')?.value.trim() || '';
    } else if (provider === 'ollama') {
      endpoint = $('endpoint-ollama')?.value.trim() || DEFAULT_OLLAMA_ENDPOINT;
    } else if (provider === 'lmstudio') {
      endpoint = $('endpoint-lmstudio')?.value.trim() || DEFAULT_LMSTUDIO_ENDPOINT;
    }
    
    const settings = {
      provider,
      apiKey,
      endpoint,
      model,
      opencodeCliPath: $('opencodeCliPath')?.value.trim() || '',
      opencodeServeUrl: $('opencodeServeUrl')?.value.trim() || '',
      opencodeAutoServe: $('opencodeAutoServe')?.checked !== false,
      opencodeShowLog: $('opencodeShowLog')?.checked !== false,
      opencodeSkipPermissions: $('opencodeSkipPermissions')?.checked !== false,
      opencodeAutoApprovePermissions: $('opencodeAutoApprovePermissions')?.checked !== false,
      opencodeServePort: parseInt($('opencodeServePort')?.value || '0', 10) || 0,
    };
    
    activeTestProvider = provider;
    vscode.postMessage({ command: 'ai/test', settings });
  });
});

document.querySelectorAll('.list-models-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const provider = this.getAttribute('data-provider');
    const statusSpan = $('card-status-' + provider);
    
    let apiKey = '';
    let endpoint = '';
    
    if (provider === 'cursor') {
      apiKey = $('apiKey-cursor')?.value.trim() || '';
    } else if (['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(provider)) {
      apiKey = $('apiKey-' + provider)?.value.trim() || '';
      if (!apiKey && provider !== 'custom') {
        if (statusSpan) {
          statusSpan.textContent = 'Please enter API key';
          statusSpan.className = 'hub-card-status error';
        }
        return;
      }
    }
    
    if (provider === 'custom') {
      endpoint = $('endpoint-custom')?.value.trim() || '';
      if (!endpoint) {
        if (statusSpan) {
          statusSpan.textContent = 'Please enter endpoint';
          statusSpan.className = 'hub-card-status error';
        }
        return;
      }
    } else if (provider === 'ollama') {
      endpoint = $('endpoint-ollama')?.value.trim() || DEFAULT_OLLAMA_ENDPOINT;
    } else if (provider === 'lmstudio') {
      endpoint = $('endpoint-lmstudio')?.value.trim() || DEFAULT_LMSTUDIO_ENDPOINT;
    }
    this.disabled = true;
    this.textContent = 'Loading...';
    if (statusSpan) {
      statusSpan.textContent = 'Loading models…';
      statusSpan.className = 'hub-card-status loading';
    }
    
    autoLoadModels(provider, apiKey, endpoint, { force: true });
  });
});

// Default Models list-models buttons
document.querySelectorAll('.list-default-models-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const scope = this.getAttribute('data-scope');
    const providerSelect = $('default' + scope + 'Provider');
    if (!providerSelect) return;
    const provider = providerSelect.value;
    const statusSpan = $('default' + scope + 'Status');
    
    let apiKey = '';
    let endpoint = '';
    
    if (provider === 'cursor') {
      apiKey = $('apiKey-cursor')?.value.trim() || '';
    } else if (['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(provider)) {
      apiKey = $('apiKey-' + provider)?.value.trim() || '';
      if (!apiKey && provider !== 'custom') {
        if (statusSpan) {
          statusSpan.textContent = 'Please enter API key in config tab';
          statusSpan.className = 'hub-card-status error';
        }
        return;
      }
    }
    
    if (provider === 'custom') {
      endpoint = $('endpoint-custom')?.value.trim() || '';
      if (!endpoint) {
        if (statusSpan) {
          statusSpan.textContent = 'Please enter endpoint in config tab';
          statusSpan.className = 'hub-card-status error';
        }
        return;
      }
    } else if (provider === 'ollama') {
      endpoint = $('endpoint-ollama')?.value.trim() || DEFAULT_OLLAMA_ENDPOINT;
    } else if (provider === 'lmstudio') {
      endpoint = $('endpoint-lmstudio')?.value.trim() || DEFAULT_LMSTUDIO_ENDPOINT;
    }
    
    this.disabled = true;
    this.textContent = 'Loading...';
    if (statusSpan) {
      statusSpan.textContent = 'Loading models…';
      statusSpan.className = 'hub-card-status loading';
    }
    
    autoLoadModels(provider, apiKey, endpoint, { scope, force: true });
  });
});

// Default Models test buttons
document.querySelectorAll('.test-default-btn').forEach(btn => {
  btn.addEventListener('click', function() {
    const scope = this.getAttribute('data-scope');
    const providerSelect = $('default' + scope + 'Provider');
    if (!providerSelect) return;
    const provider = providerSelect.value;
    const statusSpan = $('default' + scope + 'Status');
    if (statusSpan) {
      statusSpan.textContent = 'Testing…';
      statusSpan.className = 'hub-card-status loading';
    }
    this.disabled = true;
    
    let apiKey = '';
    let endpoint = '';
    const model = modelValueForScope(scope);
    
    if (provider === 'cursor') {
      apiKey = $('apiKey-cursor')?.value.trim() || '';
    } else if (['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(provider)) {
      apiKey = $('apiKey-' + provider)?.value.trim() || '';
    }
    
    if (provider === 'custom') {
      endpoint = $('endpoint-custom')?.value.trim() || '';
    } else if (provider === 'ollama') {
      endpoint = $('endpoint-ollama')?.value.trim() || DEFAULT_OLLAMA_ENDPOINT;
    } else if (provider === 'lmstudio') {
      endpoint = $('endpoint-lmstudio')?.value.trim() || DEFAULT_LMSTUDIO_ENDPOINT;
    }
    
    const settings = {
      provider,
      apiKey,
      endpoint,
      model,
      opencodeCliPath: $('opencodeCliPath')?.value.trim() || '',
      opencodeServeUrl: $('opencodeServeUrl')?.value.trim() || '',
      opencodeAutoServe: $('opencodeAutoServe')?.checked !== false,
      opencodeShowLog: $('opencodeShowLog')?.checked !== false,
      opencodeSkipPermissions: $('opencodeSkipPermissions')?.checked !== false,
      opencodeAutoApprovePermissions: $('opencodeAutoApprovePermissions')?.checked !== false,
      opencodeServePort: parseInt($('opencodeServePort')?.value || '0', 10) || 0,
    };
    
    activeTestScope = scope;
    vscode.postMessage({ command: 'ai/test', settings });
  });
});

['vscode-lm', 'github', 'cursor', 'opencode', 'openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'ollama', 'lmstudio'].forEach((provider) => {
  const selectEl = $('model-' + provider + '-select');
  const inputEl = $('model-' + provider);
  if (selectEl && inputEl) {
    selectEl.addEventListener('change', function () {
      if (this.value) { inputEl.value = this.value; }
    });
  }
});

['Notebook', 'Chat'].forEach((scope) => {
  const selectEl = $('default' + scope + 'Model-select');
  const inputEl = $('default' + scope + 'Model');
  if (selectEl && inputEl) {
    selectEl.addEventListener('change', function () {
      if (this.value) { inputEl.value = this.value; }
    });
  }
});

['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'cursor'].forEach((provider) => {
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

function modelValueForScope(scope) {
  const selectEl = $('default' + scope + 'Model-select');
  const inputEl = $('default' + scope + 'Model');
  if (!inputEl) { return ''; }
  
  const isSelectHidden = selectEl && (
    selectEl.classList.contains('hidden') ||
    (pgSelectRegistry.get(selectEl)?.wrap.classList.contains('hidden'))
  );
  
  return (selectEl && !isSelectHidden && selectEl.value)
    ? selectEl.value
    : inputEl.value;
}

function modelValueFor(provider) {
  const selectEl = $('model-' + provider + '-select');
  const inputEl = $('model-' + provider);
  if (!inputEl) { return ''; }
  
  const isSelectHidden = selectEl && (
    selectEl.classList.contains('hidden') ||
    (pgSelectRegistry.get(selectEl)?.wrap.classList.contains('hidden'))
  );
  
  return (selectEl && !isSelectHidden && selectEl.value)
    ? selectEl.value
    : inputEl.value;
}

function populateModelDropdown(selectEl, inputEl, models) {
  if (!selectEl) return;
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
  if (inputEl) {
    inputEl.classList.add('hidden');
    if (inputEl.value) {
      setSelectValue(selectEl, inputEl.value);
    }
  }
  const pgState = pgSelectRegistry.get(selectEl);
  if (pgState) {
    pgState.wrap.classList.remove('hidden');
    pgState.rebuildOptions();
  }
}

function handleModelsListed(provider, scope, models) {
  if (scope) {
    const selectEl = $('default' + scope + 'Model-select');
    const inputEl = $('default' + scope + 'Model');
    populateModelDropdown(selectEl, inputEl, models);
    
    const statusSpan = $('default' + scope + 'Status');
    if (statusSpan) {
      statusSpan.textContent = '✓ Models loaded';
      statusSpan.className = 'hub-card-status success';
    }
  } else if (provider) {
    const selectEl = $('model-' + provider + '-select');
    const inputEl = $('model-' + provider);
    populateModelDropdown(selectEl, inputEl, models);
    
    const statusSpan = $('card-status-' + provider);
    if (statusSpan) {
      statusSpan.textContent = '✓ Models loaded';
      statusSpan.className = 'hub-card-status success';
    }
  }
  
  if (provider) {
    const notebookSelect = $('defaultNotebookProvider');
    const chatSelect = $('defaultChatProvider');
    if (notebookSelect && notebookSelect.value === provider) {
      populateModelDropdown($('defaultNotebookModel-select'), $('defaultNotebookModel'), models);
      const statusSpan = $('defaultNotebookStatus');
      if (statusSpan) {
        statusSpan.textContent = '✓ Models loaded';
        statusSpan.className = 'hub-card-status success';
      }
    }
    if (chatSelect && chatSelect.value === provider) {
      populateModelDropdown($('defaultChatModel-select'), $('defaultChatModel'), models);
      const statusSpan = $('defaultChatStatus');
      if (statusSpan) {
        statusSpan.textContent = '✓ Models loaded';
        statusSpan.className = 'hub-card-status success';
      }
    }
    populateModelDropdown($('model-' + provider + '-select'), $('model-' + provider), models);
  }
}

function handleModelsListError(provider, scope, error) {
  if (scope) {
    const statusSpan = $('default' + scope + 'Status');
    if (statusSpan) {
      statusSpan.textContent = 'Failed to load models';
      statusSpan.className = 'hub-card-status error';
    }
  } else if (provider) {
    const statusSpan = $('card-status-' + provider);
    if (statusSpan) {
      statusSpan.textContent = 'Failed to load models';
      statusSpan.className = 'hub-card-status error';
    }
  }
  aiShowMessage('✗ Failed to list models: ' + error, true);
}

function updateGitHubAuthStatus(auth) {
  if (!githubBanner || !githubStatusText) { return; }
  githubAuthState = auth || { connected: false, accountLabel: '' };

  updateKeyStatusIcon('github', githubAuthState.connected);

  if (githubAuthState.connected) {
    githubStatusText.textContent = 'Connected as ' + (githubAuthState.accountLabel || 'GitHub user');
    githubBanner.classList.remove('warning');
    githubBanner.classList.add('info');
    githubBanner.classList.remove('hidden');
  } else {
    githubStatusText.textContent = 'Not connected';
    githubBanner.classList.remove('info');
    githubBanner.classList.add('warning');
    githubBanner.classList.add('hidden');
  }
}

if (githubConnectBtn) {
  githubConnectBtn.addEventListener('click', () => {
    aiHideMessage();
    githubConnectBtn.disabled = true;
    githubConnectBtn.textContent = 'Connecting...';
    vscode.postMessage({ command: 'ai/connectGitHub' });
  });
}

if (githubDisconnectBtn) {
  githubDisconnectBtn.addEventListener('click', () => {
    aiHideMessage();
    githubDisconnectBtn.disabled = true;
    githubDisconnectBtn.textContent = 'Disconnecting...';
    vscode.postMessage({ command: 'ai/disconnectGitHub' });
  });
}

function resetAiButtons() {
  if (aiSaveBtn) {
    aiSaveBtn.disabled = false;
    aiSaveBtn.textContent = 'Save All Settings';
  }
  if (githubConnectBtn) {
    githubConnectBtn.disabled = false;
    githubConnectBtn.textContent = 'Connect GitHub';
  }
  if (githubDisconnectBtn) {
    githubDisconnectBtn.disabled = false;
    githubDisconnectBtn.textContent = 'Disconnect';
  }
  document.querySelectorAll('.list-models-btn').forEach((btn) => {
    btn.disabled = false;
    btn.textContent = 'List models';
  });
  document.querySelectorAll('.list-default-models-btn').forEach((btn) => {
    btn.disabled = false;
    btn.textContent = 'List models';
  });
  document.querySelectorAll('.ai-test-btn').forEach((btn) => {
    btn.disabled = false;
  });
  document.querySelectorAll('.test-default-btn').forEach((btn) => {
    btn.disabled = false;
  });
}

// Listen to default provider dropdown changes
$('defaultNotebookProvider')?.addEventListener('change', function() {
  const selectEl = $('defaultNotebookModel-select');
  const inputEl = $('defaultNotebookModel');
  
  const prov = this.value;
  const keys = {
    openai: $('apiKey-openai')?.value.trim() || '',
    anthropic: $('apiKey-anthropic')?.value.trim() || '',
    gemini: $('apiKey-gemini')?.value.trim() || '',
    deepseek: $('apiKey-deepseek')?.value.trim() || '',
    moonshot: $('apiKey-moonshot')?.value.trim() || '',
    mistral: $('apiKey-mistral')?.value.trim() || '',
    custom: $('apiKey-custom')?.value.trim() || '',
  };
  const cursorKey = $('apiKey-cursor')?.value.trim() || '';
  const key = (prov === 'cursor') ? cursorKey : (prov === 'custom' ? keys.custom : keys[prov]);
  const endpoint = (prov === 'custom') ? ($('endpoint-custom')?.value.trim() || '') : '';
  
  const canAutoload = key || !['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(prov);
  
  if (canAutoload) {
    if (selectEl) {
      selectEl.textContent = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Loading models...';
      selectEl.appendChild(opt);
      selectEl.classList.remove('hidden');
      const pgState = pgSelectRegistry.get(selectEl);
      if (pgState) {
        pgState.wrap.classList.remove('hidden');
        pgState.rebuildOptions();
      }
    }
    if (inputEl) {
      inputEl.classList.add('hidden');
    }
    
    const statusSpan = $('defaultNotebookStatus');
    if (statusSpan) {
      statusSpan.textContent = 'Loading models…';
      statusSpan.className = 'hub-card-status loading';
    }
    
    autoLoadModels(prov, key || '', endpoint, { scope: 'Notebook' });
  } else {
    if (selectEl) {
      selectEl.classList.add('hidden');
      const pgState = pgSelectRegistry.get(selectEl);
      if (pgState) {
        pgState.wrap.classList.add('hidden');
      }
    }
    if (inputEl) {
      inputEl.classList.remove('hidden');
    }
    const statusSpan = $('defaultNotebookStatus');
    if (statusSpan) {
      statusSpan.textContent = '';
      statusSpan.className = 'hub-card-status';
    }
  }
  
  updateDefaultTabStatus();
});

$('defaultChatProvider')?.addEventListener('change', function() {
  const selectEl = $('defaultChatModel-select');
  const inputEl = $('defaultChatModel');
  
  const prov = this.value;
  const keys = {
    openai: $('apiKey-openai')?.value.trim() || '',
    anthropic: $('apiKey-anthropic')?.value.trim() || '',
    gemini: $('apiKey-gemini')?.value.trim() || '',
    deepseek: $('apiKey-deepseek')?.value.trim() || '',
    moonshot: $('apiKey-moonshot')?.value.trim() || '',
    mistral: $('apiKey-mistral')?.value.trim() || '',
    custom: $('apiKey-custom')?.value.trim() || '',
  };
  const cursorKey = $('apiKey-cursor')?.value.trim() || '';
  const key = (prov === 'cursor') ? cursorKey : (prov === 'custom' ? keys.custom : keys[prov]);
  const endpoint = (prov === 'custom') ? ($('endpoint-custom')?.value.trim() || '') : '';
  
  const canAutoload = key || !['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(prov);
  
  if (canAutoload) {
    if (selectEl) {
      selectEl.textContent = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Loading models...';
      selectEl.appendChild(opt);
      selectEl.classList.remove('hidden');
      const pgState = pgSelectRegistry.get(selectEl);
      if (pgState) {
        pgState.wrap.classList.remove('hidden');
        pgState.rebuildOptions();
      }
    }
    if (inputEl) {
      inputEl.classList.add('hidden');
    }
    
    const statusSpan = $('defaultChatStatus');
    if (statusSpan) {
      statusSpan.textContent = 'Loading models…';
      statusSpan.className = 'hub-card-status loading';
    }
    
    autoLoadModels(prov, key || '', endpoint, { scope: 'Chat' });
  } else {
    if (selectEl) {
      selectEl.classList.add('hidden');
      const pgState = pgSelectRegistry.get(selectEl);
      if (pgState) {
        pgState.wrap.classList.add('hidden');
      }
    }
    if (inputEl) {
      inputEl.classList.remove('hidden');
    }
    const statusSpan = $('defaultChatStatus');
    if (statusSpan) {
      statusSpan.textContent = '';
      statusSpan.className = 'hub-card-status';
    }
  }
  
  updateDefaultTabStatus();
});

function handleAiMessage(message) {
  resetAiButtons();

  switch (message.type) {
    case 'ai/settings': {
      setAiFormData(message.settings);
      updateGitHubAuthStatus(message.settings.githubAuth);
      
      const settings = message.settings;
      if (settings) {
        const keys = settings.apiKeys || {};
        if (settings.notebookProvider) {
          const prov = settings.notebookProvider;
          const key = prov === 'cursor' ? settings.cursorApiKey : keys[prov];
          const endpoint = settings.endpoint || '';
          const canAutoload = key || !['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(prov);
          
          if (canAutoload) {
            const statusSpan = $('defaultNotebookStatus');
            if (statusSpan) {
              statusSpan.textContent = 'Loading models…';
              statusSpan.className = 'hub-card-status loading';
            }
            const selectEl = $('defaultNotebookModel-select');
            if (selectEl) {
              selectEl.textContent = '';
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = 'Loading models...';
              selectEl.appendChild(opt);
              selectEl.classList.remove('hidden');
              const pgState = pgSelectRegistry.get(selectEl);
              if (pgState) {
                pgState.wrap.classList.remove('hidden');
                pgState.rebuildOptions();
              }
            }
            const inputEl = $('defaultNotebookModel');
            if (inputEl) {
              inputEl.classList.add('hidden');
            }
            
            autoLoadModels(prov, key || '', endpoint, {
              scope: 'Notebook',
              allowPrompt: !!(settings.githubAuth && settings.githubAuth.connected),
            });
          }
        }
        if (settings.chatProvider) {
          const prov = settings.chatProvider;
          const key = prov === 'cursor' ? settings.cursorApiKey : keys[prov];
          const endpoint = settings.endpoint || '';
          const canAutoload = key || !['openai', 'anthropic', 'gemini', 'deepseek', 'moonshot', 'mistral', 'custom'].includes(prov);
          
          if (canAutoload) {
            const statusSpan = $('defaultChatStatus');
            if (statusSpan) {
              statusSpan.textContent = 'Loading models…';
              statusSpan.className = 'hub-card-status loading';
            }
            const selectEl = $('defaultChatModel-select');
            if (selectEl) {
              selectEl.textContent = '';
              const opt = document.createElement('option');
              opt.value = '';
              opt.textContent = 'Loading models...';
              selectEl.appendChild(opt);
              selectEl.classList.remove('hidden');
              const pgState = pgSelectRegistry.get(selectEl);
              if (pgState) {
                pgState.wrap.classList.remove('hidden');
                pgState.rebuildOptions();
              }
            }
            const inputEl = $('defaultChatModel');
            if (inputEl) {
              inputEl.classList.add('hidden');
            }
            
            if (settings.chatProvider !== settings.notebookProvider) {
              autoLoadModels(prov, key || '', endpoint, {
                scope: 'Chat',
                allowPrompt: !!(settings.githubAuth && settings.githubAuth.connected),
              });
            }
          }
        }
      }
      break;
    }
    case 'ai/testSuccess': {
      if (activeTestScope) {
        const scope = activeTestScope;
        const statusSpan = $('default' + scope + 'Status');
        if (statusSpan) {
          statusSpan.textContent = '✓ Connection successful!';
          statusSpan.className = 'hub-card-status success';
        }
        activeTestScope = null;
      } else if (activeTestProvider) {
        const provider = activeTestProvider;
        const statusSpan = $('card-status-' + provider);
        if (statusSpan) {
          statusSpan.textContent = '✓ Connection successful!';
          statusSpan.className = 'hub-card-status success';
        }
        activeTestProvider = null;
      }
      aiShowMessage('✓ ' + message.result);
      break;
    }
    case 'ai/testError': {
      if (activeTestScope) {
        const scope = activeTestScope;
        const statusSpan = $('default' + scope + 'Status');
        if (statusSpan) {
          statusSpan.textContent = '✗ Connection failed';
          statusSpan.className = 'hub-card-status error';
        }
        activeTestScope = null;
      } else if (activeTestProvider) {
        const provider = activeTestProvider;
        const statusSpan = $('card-status-' + provider);
        if (statusSpan) {
          statusSpan.textContent = '✗ Connection failed';
          statusSpan.className = 'hub-card-status error';
        }
        activeTestProvider = null;
      }
      aiShowMessage('✗ ' + message.error, true);
      break;
    }
    case 'ai/saveSuccess':
      aiShowMessage('✓ Settings saved successfully!');
      break;
    case 'ai/saveError':
      aiShowMessage('✗ Failed to save: ' + message.error, true);
      break;
    case 'ai/modelsListed':
      handleModelsListed(message.provider, message.scope, message.models || []);
      break;
    case 'ai/modelsListError':
      handleModelsListError(message.provider, message.scope, message.error);
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
      aiShowMessage('✓ GitHub disconnected from NexQL');
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
$('syncFreePromoUpgradeBtn')?.addEventListener('click', () => {
  vscode.postMessage({ command: 'license/openUpgrade' });
});
$('syncFreeLocalSyncBtn')?.addEventListener('click', () => {
  vscode.postMessage({ command: 'sync/setup', mode: 'advanced' });
});
$('syncPullBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/pull' }));
$('syncPushBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/push' }));
$('syncPreviewRefreshBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/preview' }));
$('syncApplyPreviewBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/applyPreview' }));
$('syncLocalRefreshBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/local' }));
$('syncCloudRefreshBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/local' }));
$('syncReplaceLocalBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/replaceLocal' }));
$('syncReplaceRemoteBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/replaceRemote' }));
$('syncRebuildIndexBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/rebuildIndex' }));
$('syncRepairBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/repair' }));
$('syncDiagnosticsBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/diagnostics' }));
$('syncDeviceNameSaveBtn')?.addEventListener('click', () => saveSyncDeviceName());
$('syncDeviceNameInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveSyncDeviceName();
  }
});
$('syncAdvancedSetupBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'sync/setup', mode: 'advanced' }));
$('syncWizardCloseBtn')?.addEventListener('click', () => { $('syncWizardBackdrop').hidden = true; });
document.querySelectorAll('#section-sync .hub-tab-btn[data-sync-tab]').forEach((btn) => {
  btn.addEventListener('click', () => showSyncTab(btn.getAttribute('data-sync-tab')));
});
$('syncConflictsLink')?.addEventListener('click', () => showSyncTab('conflicts'));
$('syncQuickPending')?.addEventListener('click', () => showSyncTab('local'));
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

const SYNC_WIZARD_STEP_TITLES = ['Connect', 'Sync', 'Done'];

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
    btn.textContent = 'Finish';
    btn.disabled = false;
  } else if (s === 2) {
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
        '<p>Enable sync to NexQL Cloud. Connections (without passwords), saved queries and notebooks sync across your devices, protected by TLS in transit and your account.</p>',
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
          '  <p class="label-hint" style="margin-top: 8px;">Connection that stores your synced data (nexql_sync schema).</p>',
          '</div>'
        ].join('\n');
      }

      const sqlCode = [
        'CREATE SCHEMA IF NOT EXISTS nexql_sync;',
        'CREATE SEQUENCE IF NOT EXISTS nexql_sync.cursor_seq;',
        '',
        'CREATE TABLE IF NOT EXISTS nexql_sync.items_v2 (',
        '    space_id     TEXT NOT NULL,',
        '    item_id      TEXT NOT NULL,',
        '    kind         TEXT NOT NULL,',
        '    blob         BYTEA NOT NULL,',
        '    content_hash TEXT NOT NULL,',
        '    version      BIGINT NOT NULL,',
        '    device_id    TEXT NOT NULL,',
        '    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),',
        '    PRIMARY KEY (space_id, item_id)',
        ');',
        '',
        'CREATE TABLE IF NOT EXISTS nexql_sync.deletes_v2 (',
        '    space_id   TEXT NOT NULL,',
        '    item_id    TEXT NOT NULL,',
        '    version    BIGINT NOT NULL,',
        '    deleted_by TEXT NOT NULL,',
        '    deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),',
        '    PRIMARY KEY (space_id, item_id)',
        ');'
      ].join('\n');

      const highlightedSqlHtml = [
        '<span class="sql-keyword">CREATE SCHEMA IF NOT EXISTS</span> nexql_sync;',
        '<span class="sql-keyword">CREATE SEQUENCE IF NOT EXISTS</span> nexql_sync.cursor_seq;',
        '',
        '<span class="sql-keyword">CREATE TABLE IF NOT EXISTS</span> nexql_sync.items_v2 (',
        '    space_id     <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    item_id      <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    kind         <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    blob         <span class="sql-type">BYTEA</span> <span class="sql-keyword">NOT NULL</span>,',
        '    content_hash <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    version      <span class="sql-type">BIGINT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    device_id    <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    updated_at   <span class="sql-type">TIMESTAMPTZ</span> <span class="sql-keyword">NOT NULL DEFAULT</span> <span class="sql-func">now</span>(),',
        '    <span class="sql-keyword">PRIMARY KEY</span> (space_id, item_id)',
        ');',
        '',
        '<span class="sql-keyword">CREATE TABLE IF NOT EXISTS</span> nexql_sync.deletes_v2 (',
        '    space_id   <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    item_id    <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    version    <span class="sql-type">BIGINT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    deleted_by <span class="sql-type">TEXT</span> <span class="sql-keyword">NOT NULL</span>,',
        '    deleted_at <span class="sql-type">TIMESTAMPTZ</span> <span class="sql-keyword">NOT NULL DEFAULT</span> <span class="sql-func">now</span>(),',
        '    <span class="sql-keyword">PRIMARY KEY</span> (space_id, item_id)',
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
      '<p>Choose what to sync, then click Finish.</p>',
      '<label><input type="checkbox" id="wizConn" checked> Connections</label>',
      '<label><input type="checkbox" id="wizQueries" checked> Saved queries</label>',
      '<label><input type="checkbox" id="wizNotebooks" checked> Notebooks</label>',
      '<p class="label-hint">Connection passwords and SSH/SSL key paths stay on this device and are never uploaded. Synced data is protected by TLS in transit and your account credentials.</p>',
      '<p id="syncWizardCompleteStatus" class="status-line"></p>',
    ].join('');
  } else if (s === 2) {
    body.innerHTML = '<p class="success">Cloud sync is ready.</p><button type="button" id="syncWizardDoneBtn" class="btn-primary">Open Sync Settings</button>';
    $('syncWizardDoneBtn')?.addEventListener('click', () => { $('syncWizardBackdrop').hidden = true; showSyncTab('overview'); });
  }

  $('syncWizardBackBtn').hidden = s === 0;
  updateSyncWizardNextBtn();
}

$('syncWizardNextBtn')?.addEventListener('click', () => {
  const s = syncWizardState.step;
  if (s === 1) {
    $('syncWizardCompleteStatus').textContent = 'Running first sync…';
    const btn = $('syncWizardNextBtn');
    if (btn) { btn.disabled = true; }
    vscode.postMessage({
      command: 'sync/wizardComplete',
      providerId: syncWizardState.providerId,
      postgresConnectionId: syncWizardState.postgresConnectionId,
      flags: {
        syncConnections: $('wizConn')?.checked !== false,
        syncQueries: $('wizQueries')?.checked !== false,
        syncNotebooks: $('wizNotebooks')?.checked !== false,
      },
    });
    return;
  }
  if (s >= 2) {
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
    local: 'syncTabItems',
    preview: 'syncTabPreview',
    conflicts: 'syncTabConflicts',
    history: 'syncTabHistory',
    shares: 'syncTabShares',
    devices: 'syncTabDevices',
    advanced: 'syncTabAdvanced',
  };
  document.querySelectorAll('#section-sync .hub-tab-btn[data-sync-tab]').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-sync-tab') === tab);
    b.setAttribute('aria-selected', b.getAttribute('data-sync-tab') === tab ? 'true' : 'false');
  });
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
  if (tab === 'items' || tab === 'local') {
    vscode.postMessage({ command: 'sync/local' });
    vscode.postMessage({ command: 'sync/pending' });
  }
}

$('syncWizardBackBtn')?.addEventListener('click', () => {
  if (syncWizardState.step > 0) {
    syncWizardState.step -= 1;
    renderSyncWizardStep();
  }
});

function renderPreviewList(el, items) {
  el.textContent = '';
  if (!items?.length) {
    const empty = document.createElement('div');
    empty.className = 'hub-empty';
    empty.textContent = 'None';
    el.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'hub-list-row';
    const main = document.createElement('div');
    main.className = 'hub-list-row-main';
    main.textContent = `${item.name || item.id} (${item.kind})`;
    const meta = document.createElement('span');
    meta.className = 'hub-list-row-meta';
    meta.textContent = item.changeType || '';
    row.appendChild(main);
    row.appendChild(meta);
    el.appendChild(row);
  });
}

function renderConflicts(conflicts) {
  const el = $('syncConflictsList');
  el.textContent = '';
  updateSyncConflictBadges(conflicts?.length || 0);
  if (!conflicts?.length) {
    const empty = document.createElement('div');
    empty.className = 'hub-empty';
    empty.textContent = 'No conflicts.';
    el.appendChild(empty);
    return;
  }
  conflicts.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'hub-list-row';
    const main = document.createElement('div');
    main.className = 'hub-list-row-main';
    main.innerHTML = `<strong>${c.name || c.id}</strong> <span class="hub-list-row-meta">${c.source || ''}</span>`;
    const actions = document.createElement('div');
    actions.className = 'hub-list-row-actions';
    ['keepMine', 'keepTheirs', 'keepBoth', 'delete', 'diff'].forEach((action) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-sm';
      btn.textContent = action;
      btn.addEventListener('click', () => vscode.postMessage({ command: 'sync/resolveConflict', conflictId: c.id, resolveAction: action }));
      actions.appendChild(btn);
    });
    row.appendChild(main);
    row.appendChild(actions);
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

function fillSyncThisDeviceCard(thisDevice) {
  const input = $('syncDeviceNameInput');
  const hint = $('syncDeviceIdHint');
  if (!input || !hint || !thisDevice) {
    return;
  }
  input.value = thisDevice.deviceName || thisDevice.suggestedName || '';
  hint.textContent = `Device ID: ${thisDevice.deviceId}`;
}

function saveSyncDeviceName() {
  const input = $('syncDeviceNameInput');
  const msg = $('syncDeviceRenameMessage');
  if (!input) {
    return;
  }
  const name = input.value.trim();
  if (!name) {
    if (msg) {
      msg.className = 'status-line error';
      msg.textContent = 'Enter a device name.';
    }
    return;
  }
  if (msg) {
    msg.className = 'status-line';
    msg.textContent = 'Saving…';
  }
  vscode.postMessage({ command: 'sync/renameDevice', deviceName: name });
}

function renderSyncDeviceRow(d) {
  const row = document.createElement('div');
  row.className = 'hub-list-row';
  const main = document.createElement('div');
  main.className = 'hub-list-row-main';

  const title = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = d.deviceName || 'Unnamed device';
  title.appendChild(strong);
  if (d.isThisDevice) {
    const badge = document.createElement('span');
    badge.className = 'hub-badge';
    badge.textContent = ' this device';
    title.appendChild(badge);
  }
  main.appendChild(title);

  const idLine = document.createElement('div');
  idLine.className = 'label-hint';
  idLine.textContent = d.deviceId;
  main.appendChild(idLine);

  const meta = document.createElement('span');
  meta.className = 'hub-list-row-meta';
  meta.textContent = d.lastSeen ? new Date(d.lastSeen).toLocaleString() : '—';
  row.appendChild(main);
  row.appendChild(meta);

  if (!d.isThisDevice) {
    const actions = document.createElement('div');
    actions.className = 'hub-list-row-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary btn-sm';
    btn.textContent = 'Revoke';
    btn.addEventListener('click', () => vscode.postMessage({ command: 'sync/revokeDevice', deviceId: d.deviceId }));
    actions.appendChild(btn);
    row.appendChild(actions);
  }
  return row;
}

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

function formatSyncItemPresence(item) {
  return item.presence === 'cloud-only' ? 'Cloud only' : 'This device';
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
    td.colSpan = 7;
    td.className = 'empty-state';
    td.textContent = syncItemsCache.length
      ? 'No items match this filter.'
      : 'No sync items on this device or in cloud.';
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

    const detailTd = document.createElement('td');
    detailTd.textContent = item.detail || '—';
    if (!item.detail) { detailTd.classList.add('label-hint'); }
    tr.appendChild(detailTd);

    const updatedTd = document.createElement('td');
    updatedTd.textContent = formatSyncTimestamp(item.updatedAt);
    tr.appendChild(updatedTd);

    const presenceTd = document.createElement('td');
    presenceTd.textContent = formatSyncItemPresence(item);
    if (item.presence === 'cloud-only') {
      presenceTd.classList.add('label-hint');
    }
    tr.appendChild(presenceTd);

    const statusTd = document.createElement('td');
    const statusLabel = item.presence === 'cloud-only'
      ? 'Not on device'
      : formatSyncItemStatus(item);
    statusTd.textContent = statusLabel;
    if (statusLabel === 'Excluded' || statusLabel === 'Local only' || statusLabel === 'Not on device') {
      statusTd.classList.add('label-hint');
    }
    if (statusLabel === 'Pending') {
      statusTd.classList.add('sync-item-status-pending');
    }
    tr.appendChild(statusTd);

    const actionTd = document.createElement('td');
    if (item.presence === 'cloud-only') {
      const importBtn = document.createElement('button');
      importBtn.type = 'button';
      importBtn.className = 'btn-secondary btn-sm';
      importBtn.textContent = 'Import';
      importBtn.addEventListener('click', () => {
        vscode.postMessage({ command: 'sync/importCloudItem', itemId: item.id });
      });
      actionTd.appendChild(importBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn-secondary btn-sm btn-danger-text';
      deleteBtn.textContent = 'Delete from cloud';
      deleteBtn.addEventListener('click', () => {
        vscode.postMessage({
          command: 'sync/deleteCloudItem',
          itemId: item.id,
          itemName: item.name || item.id,
        });
      });
      actionTd.appendChild(deleteBtn);
    } else if (item.excluded && item.presence !== 'cloud-only') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-sm';
      btn.textContent = 'Resume';
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'sync/resumeItem', itemId: item.id });
      });
      actionTd.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary btn-sm';
      btn.textContent = 'Stop syncing';
      btn.classList.add('btn-danger-text');
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: 'sync/stopSyncingItem', itemId: item.id, itemName: item.name || item.id });
      });
      actionTd.appendChild(btn);
    }
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

['syncFlagConnections', 'syncFlagQueries', 'syncFlagNotebooks'].forEach((id) => {
  $(id)?.addEventListener('change', () => {
    if (syncFlagsDirtyGuard) { return; }
    vscode.postMessage({
      command: 'sync/saveFlags',
      flags: {
        syncConnections: $('syncFlagConnections').checked,
        syncQueries: $('syncFlagQueries').checked,
        syncNotebooks: $('syncFlagNotebooks').checked,
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

      if (sync.featureEnabled && !sync.configured) {
        const isFree = sync.tier === 'free';
        $('syncNotConfiguredFree').hidden = !isFree;
        $('syncNotConfiguredSetup').hidden = isFree;
      }

      if (sync.featureEnabled && sync.configured) {
        vscode.postMessage({ command: 'sync/local' });
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
    case 'sync/local':
      renderSyncItems(message.items || []);
      break;
    case 'sync/cloud':
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
      const outgoing = message.outgoing || [];
      const incoming = message.incoming || [];
      if (!outgoing.length) {
        const empty = document.createElement('div');
        empty.className = 'hub-empty';
        empty.textContent = 'No outgoing shares.';
        outEl.appendChild(empty);
      }
      outgoing.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'hub-list-row';
        const main = document.createElement('div');
        main.className = 'hub-list-row-main';
        main.textContent = `${s.name || s.shareId} → ${s.granteeEmail}${s.revoked ? ' (revoked)' : ''}`;
        row.appendChild(main);
        if (!s.revoked) {
          const actions = document.createElement('div');
          actions.className = 'hub-list-row-actions';
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn-secondary btn-sm';
          btn.textContent = 'Revoke';
          btn.addEventListener('click', () => vscode.postMessage({ command: 'sync/revokeShare', shareId: s.shareId }));
          actions.appendChild(btn);
          row.appendChild(actions);
        }
        outEl.appendChild(row);
      });
      if (!incoming.length) {
        const empty = document.createElement('div');
        empty.className = 'hub-empty';
        empty.textContent = 'No incoming shares.';
        inEl.appendChild(empty);
      }
      incoming.forEach((s) => {
        const row = document.createElement('div');
        row.className = 'hub-list-row';
        const main = document.createElement('div');
        main.className = 'hub-list-row-main';
        main.textContent = `${s.name || s.shareId} from ${s.ownerEmail}`;
        row.appendChild(main);
        inEl.appendChild(row);
      });
      break;
    }
    case 'sync/devices': {
      fillSyncThisDeviceCard(message.thisDevice);
      const el = $('syncDevicesList');
      el.textContent = '';
      const devices = message.devices || [];
      if (!devices.length) {
        const empty = document.createElement('div');
        empty.className = 'hub-empty';
        empty.textContent = 'No other devices registered yet.';
        el.appendChild(empty);
        break;
      }
      devices.forEach((d) => {
        el.appendChild(renderSyncDeviceRow(d));
      });
      break;
    }
    case 'sync/deviceRenameResult': {
      const msg = $('syncDeviceRenameMessage');
      if (!msg) {
        break;
      }
      msg.className = 'status-line ' + (message.ok ? 'success' : 'error');
      msg.textContent = message.ok
        ? (message.warning || 'Device name saved.')
        : (message.error || 'Could not save device name.');
      if (message.ok && message.deviceName && $('syncDeviceNameInput')) {
        $('syncDeviceNameInput').value = message.deviceName;
      }
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
    case 'sync/wizardCompleteResult': {
      const completeStatus = $('syncWizardCompleteStatus');
      if (message.ok) {
        if (completeStatus) {
          completeStatus.textContent = 'Sync complete.';
          completeStatus.className = 'status-line success';
        }
        syncWizardState.step = 2;
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

function fillLicenseThisDeviceRename(lic) {
  const box = $('licenseThisDeviceRename');
  const input = $('licenseDeviceNameInput');
  const hint = $('licenseDeviceIdHint');
  if (!box || !input || !hint || !lic) {
    return;
  }
  box.hidden = false;
  input.value = lic.localDeviceName || '';
  const hints = [];
  if (lic.machineId) {
    hints.push(`License ID: ${lic.machineId}`);
  }
  if (lic.syncDeviceId) {
    hints.push(`Sync ID: ${lic.syncDeviceId}`);
  }
  hint.textContent = hints.join(' · ');
}

function saveLicenseDeviceName() {
  const input = $('licenseDeviceNameInput');
  const msg = $('licenseDeviceMessage');
  if (!input) {
    return;
  }
  const name = input.value.trim();
  if (!name) {
    if (msg) {
      msg.className = 'status-line error';
      msg.textContent = 'Enter a device name.';
    }
    return;
  }
  if (msg) {
    msg.className = 'status-line';
    msg.textContent = 'Saving…';
  }
  vscode.postMessage({ command: 'license/renameDevice', deviceName: name });
}

$('licenseDeviceNameSaveBtn')?.addEventListener('click', () => saveLicenseDeviceName());
$('licenseDeviceNameInput')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    saveLicenseDeviceName();
  }
});

function renderLicenseDevices(devices) {
  const body = $('licenseDevicesBody');
  body.replaceChildren();
  devices.forEach((d) => {
    const tr = document.createElement('tr');
    const machineTd = document.createElement('td');
    const displayName = d.deviceName || 'Unnamed device';
    const title = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = displayName;
    title.appendChild(strong);
    if (d.isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'hub-badge';
      badge.textContent = ' this device';
      title.appendChild(badge);
    }
    machineTd.appendChild(title);
    const idLine = document.createElement('div');
    idLine.className = 'label-hint';
    idLine.textContent = d.instanceId || '—';
    machineTd.appendChild(idLine);
    if (d.isCurrent) {
      machineTd.className = 'device-current';
    }

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
        fillLicenseThisDeviceRename(lic);
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
    case 'license/deviceRenameResult': {
      const msg = $('licenseDeviceMessage');
      msg.className = 'status-line ' + (message.ok ? 'success' : 'error');
      msg.textContent = (message.ok ? '✓ ' : '✗ ') + (message.message || 'Device name saved.');
      if (message.ok && message.deviceName && $('licenseDeviceNameInput')) {
        $('licenseDeviceNameInput').value = message.deviceName;
      }
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Database Indexing section
// ─────────────────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function handleDbIndexMessage(message) {
  switch (message.type) {
    case 'dbindex/state':
      $('dbindexState').hidden = true;
      $('dbindexListContainer').hidden = false;
      $('dbindexEnableEmbeddings').checked = !!message.state.enableEmbeddings;
      renderDbIndexes(message.state.indexes);
      break;
    case 'dbindex/error':
      $('dbindexState').hidden = false;
      $('dbindexState').classList.add('error');
      $('dbindexState').textContent = message.error || 'Failed to update index';
      break;
  }
}

function renderDbIndexes(indexes) {
  const cardsContainer = $('dbindexCards');
  if (!cardsContainer) return;

  if (!indexes || indexes.length === 0) {
    cardsContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none"><rect x="8" y="14" width="32" height="22" rx="4" stroke="currentColor" stroke-width="2"/><path d="M16 24h16M24 20v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <h2>No active database indexes</h2>
        <p>Build a local index to enable conceptual search and offline grounding for AI tools.</p>
        <button type="button" class="btn-primary" id="dbindexEmptyBuildBtn">⚡ Index Your First Database</button>
      </div>
    `;
    $('dbindexEmptyBuildBtn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'dbindex/build' });
    });
    return;
  }

  cardsContainer.textContent = '';
  indexes.forEach(idx => {
    const card = document.createElement('div');
    card.className = 'hub-setting-card db-index-card';

    const dateStr = idx.indexedAt ? new Date(idx.indexedAt).toLocaleString() : 'N/A';
    const statusClass = idx.drift ? 'drift' : (idx.indexedAt ? 'fresh' : 'none');
    const statusLabel = idx.drift ? 'Drifted' : (idx.indexedAt ? 'Fresh' : 'Not Indexed');

    card.innerHTML = `
      <div class="card-header">
        <div class="card-title">
          <span>💾</span>
          <strong>${escapeHtml(idx.database)}</strong>
          <span class="pg-text-meta">(${escapeHtml(idx.connectionName)})</span>
        </div>
        <span class="status-badge ${statusClass}">${statusLabel}</span>
      </div>

      <div class="stats-row">
        <div class="stat-item">
          <span class="pg-text-meta">Indexed Objects</span>
          <span class="val">${idx.tables || 0} tables · ${idx.views || 0} views · ${idx.functions || 0} fns</span>
        </div>
        <div class="stat-item">
          <span class="pg-text-meta">Last Updated</span>
          <span class="val">${dateStr}</span>
        </div>
        <div class="stat-item">
          <span class="pg-text-meta">Depth</span>
          <span class="val">${idx.depth || 'N/A'}</span>
        </div>
      </div>

      <div class="scope-details">
        <strong>Scope:</strong> Schemas: <code>${escapeHtml(idx.schemas ? idx.schemas.join(', ') : 'none')}</code>
        ${idx.piiCount > 0 ? ` · <span style="color:var(--danger, #f44336)">${idx.piiCount} PII columns excluded</span>` : ''}
      </div>

      <div class="card-actions">
        <button type="button" class="btn-primary btn-curate" data-conn="${idx.connectionId}" data-db="${idx.database}">🔧 Curate</button>
        <button type="button" class="btn-secondary btn-rebuild" data-conn="${idx.connectionId}" data-db="${idx.database}">Rebuild</button>
        <button type="button" class="btn-secondary btn-export" data-conn="${idx.connectionId}" data-db="${idx.database}">Export Schema</button>
        <button type="button" class="btn-secondary btn-danger-text btn-clear" data-conn="${idx.connectionId}" data-db="${idx.database}">Delete Index</button>
      </div>
    `;

    card.querySelector('.btn-curate').addEventListener('click', () => {
      vscode.postMessage({ command: 'dbindex/curate', connectionId: idx.connectionId, database: idx.database });
    });

    card.querySelector('.btn-rebuild').addEventListener('click', () => {
      vscode.postMessage({ command: 'dbindex/rebuild', connectionId: idx.connectionId, database: idx.database });
    });

    card.querySelector('.btn-export').addEventListener('click', () => {
      vscode.postMessage({ command: 'dbindex/export', connectionId: idx.connectionId, database: idx.database });
    });

    card.querySelector('.btn-clear').addEventListener('click', () => {
      vscode.postMessage({ command: 'dbindex/clear', connectionId: idx.connectionId, database: idx.database });
    });

    cardsContainer.appendChild(card);
  });
}

$('dbindexBuildBtn').addEventListener('click', () => {
  vscode.postMessage({ command: 'dbindex/build' });
});

$('dbindexEnableEmbeddings').addEventListener('change', (e) => {
  vscode.postMessage({ command: 'dbindex/setEmbeddings', enableEmbeddings: e.target.checked });
});

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
    case 'dbindex': handleDbIndexMessage(message); break;
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
