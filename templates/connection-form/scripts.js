console.log('[PgStudio] Connection form script starting...');
window.onerror = function (msg, source, line, col, error) {
  console.error('[PgStudio] Global Error:', msg, error);
  if (typeof vscode !== 'undefined') {
    vscode.postMessage({ type: 'error', error: msg });
  }
};

const vscode = acquireVsCodeApi();
const messageDiv = document.getElementById('message');
const testBtn = document.getElementById('testConnection');
const addBtn = document.getElementById('addConnection');
const addBtnLabel = addBtn.querySelector('span:last-child').textContent;
const form = document.getElementById('connectionForm');
const inputs = form.querySelectorAll('input');

// Injected connection data (replaced at runtime by the extension)
const connectionData = {{ CONNECTION_DATA }};

// In edit mode we allow saving without re-testing
const isEditMode = !!connectionData;
let isTested = isEditMode;

// ── Populate form when editing ────────────────────────────────────────────────
if (connectionData) {
  document.getElementById('name').value = connectionData.name || '';
  document.getElementById('host').value = connectionData.host || '';
  document.getElementById('port').value = connectionData.port || 5432;
  document.getElementById('database').value = connectionData.database || '';
  document.getElementById('group').value = connectionData.group || '';
  document.getElementById('username').value = connectionData.username || '';
  document.getElementById('password').value = connectionData.password || '';

  if (connectionData.sslmode)         { document.getElementById('sslmode').value = connectionData.sslmode; }
  if (connectionData.sslCertPath)     { document.getElementById('sslCertPath').value = connectionData.sslCertPath; }
  if (connectionData.sslKeyPath)      { document.getElementById('sslKeyPath').value = connectionData.sslKeyPath; }
  if (connectionData.sslRootCertPath) { document.getElementById('sslRootCertPath').value = connectionData.sslRootCertPath; }
  if (connectionData.statementTimeout){ document.getElementById('statementTimeout').value = connectionData.statementTimeout; }
  if (connectionData.connectTimeout)  { document.getElementById('connectTimeout').value = connectionData.connectTimeout; }
  if (connectionData.applicationName) { document.getElementById('applicationName').value = connectionData.applicationName; }
  if (connectionData.options)         { document.getElementById('options').value = connectionData.options; }
  if (connectionData.environment)     { document.getElementById('environment').value = connectionData.environment; }
  if (connectionData.readOnlyMode)    { document.getElementById('readOnlyMode').checked = connectionData.readOnlyMode; }

  const hasAdvancedOptions = connectionData.sslmode || connectionData.statementTimeout ||
    connectionData.connectTimeout || connectionData.applicationName || connectionData.options;
  if (hasAdvancedOptions) {
    setTimeout(() => {
      document.getElementById('advanced-section').style.display = 'block';
      document.getElementById('advanced-arrow').style.transform = 'rotate(180deg)';
      updateSSLCertFields();
    }, 100);
  }

  // Allow saving immediately in edit mode
  addBtn.disabled = false;

  if (connectionData.ssh) {
    document.getElementById('sshEnabled').checked = connectionData.ssh.enabled;
    document.getElementById('sshHost').value = connectionData.ssh.host || '';
    document.getElementById('sshPort').value = connectionData.ssh.port || 22;
    document.getElementById('sshUsername').value = connectionData.ssh.username || '';
    document.getElementById('sshKeyPath').value = connectionData.ssh.privateKeyPath || '';
    setTimeout(() => {
      document.getElementById('ssh-section').style.display = 'block';
      document.getElementById('ssh-arrow').style.transform = 'rotate(180deg)';
      updateSSHState();
    }, 100);
  }
}

// ── SSH toggle ────────────────────────────────────────────────────────────────
function toggleSSH() {
  const section = document.getElementById('ssh-section');
  const arrow = document.getElementById('ssh-arrow');
  if (section.style.display === 'none') {
    section.style.display = 'block';
    arrow.style.transform = 'rotate(180deg)';
  } else {
    section.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

function updateSSHState() {
  const enabled = document.getElementById('sshEnabled').checked;
  const fields = document.getElementById('ssh-fields');
  const sshInputs = fields.querySelectorAll('input');
  if (enabled) {
    fields.style.opacity = '1';
    fields.style.pointerEvents = 'auto';
    sshInputs.forEach(i => i.required = true);
    document.getElementById('sshKeyPath').required = true;
  } else {
    fields.style.opacity = '0.5';
    fields.style.pointerEvents = 'none';
    sshInputs.forEach(i => i.required = false);
  }
}

document.getElementById('sshEnabled').addEventListener('change', updateSSHState);

// ── Advanced options toggle ───────────────────────────────────────────────────
function toggleAdvanced() {
  const section = document.getElementById('advanced-section');
  const arrow = document.getElementById('advanced-arrow');
  if (section.style.display === 'none') {
    section.style.display = 'block';
    arrow.style.transform = 'rotate(180deg)';
  } else {
    section.style.display = 'none';
    arrow.style.transform = 'rotate(0deg)';
  }
}

document.getElementById('ssh-header').addEventListener('click', toggleSSH);
document.getElementById('advanced-header').addEventListener('click', toggleAdvanced);

// ── SSL cert fields ───────────────────────────────────────────────────────────
function updateSSLCertFields() {
  const sslmode = document.getElementById('sslmode').value;
  const certFields = document.getElementById('ssl-cert-fields');
  if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
    certFields.style.display = 'block';
    document.getElementById('sslRootCertPath').required = true;
  } else {
    certFields.style.display = 'none';
    document.getElementById('sslRootCertPath').required = false;
  }
}

document.getElementById('sslmode').addEventListener('change', updateSSLCertFields);

// ── Message helpers ───────────────────────────────────────────────────────────
function showMessage(text, type = 'info') {
  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  messageDiv.className = 'message ' + type;
  messageDiv.style.display = 'flex';
  while (messageDiv.firstChild) { messageDiv.removeChild(messageDiv.firstChild); }
  const iconSpan = document.createElement('span');
  iconSpan.className = 'message-icon';
  iconSpan.textContent = icons[type];
  const textSpan = document.createElement('span');
  textSpan.textContent = text;
  messageDiv.appendChild(iconSpan);
  messageDiv.appendChild(textSpan);
}

function hideMessage() {
  messageDiv.style.display = 'none';
}

// ── Form data ─────────────────────────────────────────────────────────────────
function getFormData() {
  const usernameInput = document.getElementById('username').value.trim();
  const passwordInput = document.getElementById('password').value;
  const sshEnabled = document.getElementById('sshEnabled').checked;

  const data = {
    name: document.getElementById('name').value,
    host: document.getElementById('host').value,
    port: parseInt(document.getElementById('port').value),
    database: document.getElementById('database').value || 'postgres',
    group: document.getElementById('group').value || undefined,
    username: usernameInput || undefined,
    password: passwordInput || undefined,
    environment: document.getElementById('environment').value || undefined,
    readOnlyMode: document.getElementById('readOnlyMode').checked || undefined,
    sslmode: document.getElementById('sslmode').value || undefined,
    sslCertPath: document.getElementById('sslCertPath').value || undefined,
    sslKeyPath: document.getElementById('sslKeyPath').value || undefined,
    sslRootCertPath: document.getElementById('sslRootCertPath').value || undefined,
    statementTimeout: document.getElementById('statementTimeout').value ? parseInt(document.getElementById('statementTimeout').value) : undefined,
    connectTimeout: document.getElementById('connectTimeout').value ? parseInt(document.getElementById('connectTimeout').value) : undefined,
    applicationName: document.getElementById('applicationName').value || undefined,
    options: document.getElementById('options').value || undefined
  };

  if (sshEnabled) {
    data.ssh = {
      enabled: true,
      host: document.getElementById('sshHost').value,
      port: parseInt(document.getElementById('sshPort').value),
      username: document.getElementById('sshUsername').value,
      privateKeyPath: document.getElementById('sshKeyPath').value
    };
  }

  return data;
}

// ── Input change: reset tested state (but keep save enabled in edit mode) ─────
inputs.forEach(input => {
  input.addEventListener('input', () => {
    if (isTested && !isEditMode) {
      isTested = false;
      addBtn.disabled = true;
      hideMessage();
    }
  });
});

// ── Test connection ───────────────────────────────────────────────────────────
testBtn.addEventListener('click', () => {
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  hideMessage();
  testBtn.disabled = true;
  testBtn.innerHTML = '<span>Testing…</span>';
  vscode.postMessage({ command: 'testConnection', connection: getFormData() });
});

// ── Save / submit ─────────────────────────────────────────────────────────────
form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isTested) { return; }
  hideMessage();
  addBtn.disabled = true;
  addBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Saving…</span>';
  vscode.postMessage({ command: 'saveConnection', connection: getFormData() });
});

// ── Messages from extension ───────────────────────────────────────────────────
window.addEventListener('message', event => {
  const message = event.data;
  testBtn.disabled = false;
  testBtn.innerHTML = '<span>Test Connection</span>';
  addBtn.innerHTML = `<span class="btn-icon">✓</span><span>${addBtnLabel}</span>`;

  switch (message.type) {
    case 'testSuccess': {
      const versionMatch = message.version && message.version.match(/PostgreSQL\s+[\d.]+/i);
      const versionLabel = versionMatch ? versionMatch[0] : 'Connected';
      showMessage('Connected — ' + versionLabel, 'success');
      isTested = true;
      addBtn.disabled = false;
      break;
    }
    case 'testError':
      showMessage(message.error || 'Connection failed', 'error');
      isTested = false;
      // In edit mode keep save enabled even after a failed test
      if (!isEditMode) { addBtn.disabled = true; }
      break;
  }
});
