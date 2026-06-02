const vscode = acquireVsCodeApi();
const form = document.getElementById('settingsForm');
const configScopeSelect = document.getElementById('configScope');
const providerSelect = document.getElementById('provider');
const testBtn = document.getElementById('testBtn');
const saveBtn = document.getElementById('saveBtn');
const messageDiv = document.getElementById('message');
const githubBanner = document.getElementById('githubAuthBanner');
const githubStatusText = document.getElementById('githubAuthStatusText');
const githubConnectBtn = document.getElementById('githubConnectBtn');
const githubDisconnectBtn = document.getElementById('githubDisconnectBtn');
let githubAuthState = { connected: false, accountLabel: '' };

// Request to load current settings
vscode.postMessage({ command: 'loadSettings' });

// Provider change handler
providerSelect.addEventListener('change', () => {
  const provider = providerSelect.value;
  document.querySelectorAll('.provider-details').forEach(el => {
    el.classList.remove('active');
  });
  const detailsEl = document.getElementById('provider-' + provider);
  if (detailsEl) {
    detailsEl.classList.add('active');
  }
  hideMessage();

  // Auto-load models for the new provider
  const formData = getFormData();
  autoLoadModels(provider, formData.apiKey, formData.endpoint, { allowPrompt: githubAuthState.connected });
});

function showMessage(text, isError = false) {
  const type = isError ? 'error' : 'success';
  messageDiv.className = 'status-line ' + type;
  messageDiv.style.display = 'block';
  messageDiv.textContent = text;
}

function hideMessage() {
  messageDiv.style.display = 'none';
  messageDiv.className = 'status-line';
}

function autoLoadModels(provider, apiKey, endpoint, options = {}) {
  const allowPrompt = options.allowPrompt !== false;
  // Auto-load models for providers where it's possible
  if (provider === 'vscode-lm') {
    // Always load VS Code LM models
    vscode.postMessage({
      command: 'listModels',
      settings: { provider: 'vscode-lm', apiKey: '', endpoint: '' }
    });
  } else if (provider === 'github') {
    if (allowPrompt) {
      vscode.postMessage({
        command: 'listModels',
        settings: { provider: 'github', apiKey: '', endpoint: '' }
      });
    }
  } else if (provider === 'cursor') {
    vscode.postMessage({
      command: 'listModels',
      settings: { provider: 'cursor', apiKey: apiKey || '', endpoint: endpoint || '' }
    });
  } else if (provider === 'anthropic') {
    // Prefer to fetch Anthropic models from the API when API key is provided
    if (apiKey && apiKey.length > 0) {
      vscode.postMessage({
        command: 'listModels',
        settings: { provider: 'anthropic', apiKey: apiKey, endpoint: endpoint }
      });
    }
  } else if ((provider === 'openai' || provider === 'gemini') && apiKey) {
    // Load models if API key is available
    vscode.postMessage({
      command: 'listModels',
      settings: { provider: provider, apiKey: apiKey, endpoint: endpoint }
    });
  } else if (provider === 'custom' && endpoint) {
    // Load models if endpoint is available
    vscode.postMessage({
      command: 'listModels',
      settings: { provider: 'custom', apiKey: apiKey, endpoint: endpoint }
    });
  } else if (provider === 'ollama') {
    // Ollama doesn't need an API key — always try to list
    const ep = endpoint || 'http://localhost:11434/v1/chat/completions';
    vscode.postMessage({
      command: 'listModels',
      settings: { provider: 'ollama', apiKey: '', endpoint: ep }
    });
  } else if (provider === 'lmstudio') {
    // LM Studio doesn't need an API key — always try to list
    const ep = endpoint || 'http://localhost:1234/v1/chat/completions';
    vscode.postMessage({
      command: 'listModels',
      settings: { provider: 'lmstudio', apiKey: '', endpoint: ep }
    });
  }
}

function getFormData() {
  const configScope = configScopeSelect ? configScopeSelect.value : 'notebook';
  const provider = providerSelect.value;
  let apiKey = '';
  const apiKeys = {
    openai: document.getElementById('apiKey-openai')?.value || '',
    anthropic: document.getElementById('apiKey-anthropic')?.value || '',
    gemini: document.getElementById('apiKey-gemini')?.value || '',
    custom: document.getElementById('apiKey-custom')?.value || ''
  };
  let model = '';
  let endpoint = '';

  if (provider === 'vscode-lm') {
    const selectEl = document.getElementById('model-vscode-lm-select');
    const inputEl = document.getElementById('model-vscode-lm');
    model = (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
      ? selectEl.value
      : inputEl.value;
  } else if (provider === 'openai') {
    apiKey = document.getElementById('apiKey-openai').value;
    const selectEl = document.getElementById('model-openai-select');
    const inputEl = document.getElementById('model-openai');
    model = (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
      ? selectEl.value
      : inputEl.value;
  } else if (provider === 'anthropic') {
    apiKey = document.getElementById('apiKey-anthropic').value;
    const selectEl = document.getElementById('model-anthropic-select');
    const inputEl = document.getElementById('model-anthropic');
    model = (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
      ? selectEl.value
      : inputEl.value;
  } else if (provider === 'gemini') {
    apiKey = document.getElementById('apiKey-gemini').value;
    const selectEl = document.getElementById('model-gemini-select');
    const inputEl = document.getElementById('model-gemini');
    model = (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
      ? selectEl.value
      : inputEl.value;
  } else if (provider === 'github') {
    const selectEl = document.getElementById('model-github-select');
    const inputEl = document.getElementById('model-github');
    model = (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
      ? selectEl.value
      : inputEl.value;
  } else if (provider === 'cursor') {
    apiKey = document.getElementById('apiKey-cursor').value;
    const selectEl = document.getElementById('model-cursor-select');
    const inputEl = document.getElementById('model-cursor');
    model = (selectEl && !selectEl.classList.contains('hidden') && selectEl.value)
      ? selectEl.value
      : inputEl.value;
  } else if (provider === 'custom') {
    apiKey = document.getElementById('apiKey-custom').value;
    model = document.getElementById('model-custom').value;
    endpoint = document.getElementById('endpoint-custom').value;
  } else if (provider === 'ollama') {
    model = document.getElementById('model-ollama').value;
    endpoint = document.getElementById('endpoint-ollama').value || 'http://localhost:11434/v1/chat/completions';
  } else if (provider === 'lmstudio') {
    model = document.getElementById('model-lmstudio').value;
    endpoint = document.getElementById('endpoint-lmstudio').value || 'http://localhost:1234/v1/chat/completions';
  }

  return { configScope, provider, apiKey, apiKeys, model, endpoint };
}

function setFormData(settings) {
  if (configScopeSelect && settings.configScope) {
    configScopeSelect.value = settings.configScope;
  }

  const keys = settings.apiKeys || {};
  const openaiKey = keys.openai || (settings.provider === 'openai' ? settings.apiKey : '') || '';
  const anthropicKey = keys.anthropic || (settings.provider === 'anthropic' ? settings.apiKey : '') || '';
  const geminiKey = keys.gemini || (settings.provider === 'gemini' ? settings.apiKey : '') || '';
  const customKey = keys.custom || (settings.provider === 'custom' ? settings.apiKey : '') || '';

  const openaiEl = document.getElementById('apiKey-openai');
  const anthropicEl = document.getElementById('apiKey-anthropic');
  const geminiEl = document.getElementById('apiKey-gemini');
  const customEl = document.getElementById('apiKey-custom');
  if (openaiEl) openaiEl.value = openaiKey;
  if (anthropicEl) anthropicEl.value = anthropicKey;
  if (geminiEl) geminiEl.value = geminiKey;
  if (customEl) customEl.value = customKey;

  providerSelect.value = settings.provider || 'vscode-lm';
  providerSelect.dispatchEvent(new Event('change'));

  if (settings.provider === 'vscode-lm') {
    document.getElementById('model-vscode-lm').value = settings.model || '';
  } else if (settings.provider === 'openai') {
    document.getElementById('model-openai').value = settings.model || '';
  } else if (settings.provider === 'anthropic') {
    document.getElementById('model-anthropic').value = settings.model || '';
  } else if (settings.provider === 'gemini') {
    document.getElementById('model-gemini').value = settings.model || '';
  } else if (settings.provider === 'github') {
    document.getElementById('model-github').value = settings.model || '';
  } else if (settings.provider === 'cursor') {
    document.getElementById('apiKey-cursor').value = settings.cursorApiKey || '';
    document.getElementById('model-cursor').value = settings.model || '';
  } else if (settings.provider === 'custom') {
    document.getElementById('model-custom').value = settings.model || '';
    document.getElementById('endpoint-custom').value = settings.endpoint || '';
  } else if (settings.provider === 'ollama') {
    document.getElementById('model-ollama').value = settings.model || '';
    document.getElementById('endpoint-ollama').value = settings.endpoint || 'http://localhost:11434/v1/chat/completions';
  } else if (settings.provider === 'lmstudio') {
    document.getElementById('model-lmstudio').value = settings.model || '';
    document.getElementById('endpoint-lmstudio').value = settings.endpoint || 'http://localhost:1234/v1/chat/completions';
  }
}

if (configScopeSelect) {
  configScopeSelect.addEventListener('change', () => {
    hideMessage();
    vscode.postMessage({ command: 'loadSettings', configScope: configScopeSelect.value });
  });
}

// Test button handler
testBtn.addEventListener('click', () => {
  hideMessage();
  testBtn.disabled = true;
  testBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Testing...</span>';

  vscode.postMessage({
    command: 'testConnection',
    settings: getFormData()
  });
});

// Form submit handler
form.addEventListener('submit', (e) => {
  e.preventDefault();
  hideMessage();
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Saving...</span>';

  vscode.postMessage({
    command: 'saveSettings',
    settings: getFormData()
  });
});

// List models button handlers
document.querySelectorAll('.list-models-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    const provider = this.getAttribute('data-provider');
    const settings = getFormData();

    if ((provider === 'openai' || provider === 'gemini' || provider === 'anthropic') && !settings.apiKey) {
      showMessage('Please enter an API key first', true);
      return;
    }

    if (provider === 'github') {
      this.disabled = true;
      this.textContent = 'Loading models...';
      vscode.postMessage({
        command: 'listModels',
        settings: { provider: 'github', apiKey: '', endpoint: '' }
      });
      return;
    }

    if (provider === 'cursor') {
      this.disabled = true;
      this.textContent = 'Loading models...';
      vscode.postMessage({
        command: 'listModels',
        settings: { provider: 'cursor', apiKey: settings.apiKey, endpoint: '' }
      });
      return;
    }

    // VS Code LM does not require an API key
    if (provider === 'custom' && !settings.endpoint) {
      showMessage('Please enter an endpoint first', true);
      return;
    }

    // For ollama/lmstudio use their default endpoints if not overridden
    let endpoint = settings.endpoint;
    if (provider === 'ollama' && !endpoint) { endpoint = 'http://localhost:11434/v1/chat/completions'; }
    if (provider === 'lmstudio' && !endpoint) { endpoint = 'http://localhost:1234/v1/chat/completions'; }

    this.disabled = true;
    this.textContent = 'Loading models...';

    vscode.postMessage({
      command: 'listModels',
      settings: { provider: provider, apiKey: settings.apiKey, endpoint: endpoint }
    });
  });
});

// Model select change handlers
['vscode-lm', 'github', 'cursor', 'openai', 'anthropic', 'gemini', 'ollama', 'lmstudio'].forEach(provider => {
  const selectEl = document.getElementById('model-' + provider + '-select');
  const inputEl = document.getElementById('model-' + provider);
  if (selectEl && inputEl) {
    selectEl.addEventListener('change', function () {
      if (this.value) {
        inputEl.value = this.value;
      }
    });
  }
});

// Auto-load models when API key is entered for OpenAI, Gemini, and Cursor
['openai', 'gemini', 'cursor'].forEach(provider => {
  const apiKeyInput = document.getElementById('apiKey-' + provider);
  if (apiKeyInput) {
    apiKeyInput.addEventListener('blur', function () {
      if (this.value && this.value.length > 10) {
        autoLoadModels(provider, this.value, '');
      }
    });
  }
});

// Auto-load models when custom endpoint is entered
const customEndpoint = document.getElementById('endpoint-custom');
if (customEndpoint) {
  customEndpoint.addEventListener('blur', function () {
    if (this.value) {
      const apiKey = document.getElementById('apiKey-custom').value;
      autoLoadModels('custom', apiKey, this.value);
    }
  });
}

// Message handler
window.addEventListener('message', event => {
  const message = event.data;
  testBtn.disabled = false;
  testBtn.innerHTML = '<span class="btn-icon">⚡</span><span>Test Connection</span>';
  saveBtn.disabled = false;
  saveBtn.innerHTML = '<span class="btn-icon">✓</span><span>Save Settings</span>';
  if (githubConnectBtn) {
    githubConnectBtn.disabled = false;
    githubConnectBtn.innerHTML = '<span class="btn-icon">↗</span><span>Connect GitHub</span>';
  }
  if (githubDisconnectBtn) {
    githubDisconnectBtn.disabled = false;
    githubDisconnectBtn.innerHTML = '<span class="btn-icon">⎋</span><span>Disconnect</span>';
  }

  // Reset list models buttons
  document.querySelectorAll('.list-models-btn').forEach(btn => {
    btn.disabled = false;
    btn.textContent = 'List available models';
  });

  switch (message.type) {
    case 'testSuccess':
      showMessage('✓ ' + message.result);
      break;
    case 'testError':
      showMessage('✗ ' + message.error, true);
      break;
    case 'saveSuccess':
      showMessage('✓ Settings saved successfully!');
      break;
    case 'saveError':
      showMessage('✗ Failed to save: ' + message.error, true);
      break;
    case 'settingsLoaded':
      setFormData(message.settings);
      updateGitHubAuthStatus(message.settings.githubAuth);
      // Auto-load models for the current provider
      const settings = message.settings;
      if (settings && settings.provider) {
        autoLoadModels(settings.provider, settings.cursorApiKey || settings.apiKey || '', settings.endpoint || '', {
          allowPrompt: !!settings.githubAuth?.connected
        });
      }
      break;
    case 'modelsListed':
      handleModelsListed(message.models);
      showMessage('✓ Connected — ' + message.models.length + ' model(s) available');
      break;
    case 'modelsListError':
      showMessage('✗ Failed to list models: ' + message.error, true);
      break;
    case 'githubConnected':
      updateGitHubAuthStatus({ connected: true, accountLabel: message.accountLabel });
      showMessage('✓ Connected GitHub account: ' + message.accountLabel);
      break;
    case 'githubConnectError':
      showMessage('✗ GitHub connect failed: ' + message.error, true);
      break;
    case 'githubDisconnected':
      updateGitHubAuthStatus({ connected: false });
      showMessage('✓ GitHub disconnected from PgStudio');
      break;
    case 'githubDisconnectError':
      showMessage('✗ GitHub disconnect failed: ' + message.error, true);
      break;
  }
});

function updateGitHubAuthStatus(auth) {
  if (!githubBanner || !githubStatusText) {
    return;
  }

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

if (githubConnectBtn) {
  githubConnectBtn.addEventListener('click', () => {
    hideMessage();
    githubConnectBtn.disabled = true;
    githubConnectBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Connecting...</span>';
    vscode.postMessage({ command: 'connectGitHub' });
  });
}

if (githubDisconnectBtn) {
  githubDisconnectBtn.addEventListener('click', () => {
    hideMessage();
    githubDisconnectBtn.disabled = true;
    githubDisconnectBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Disconnecting...</span>';
    vscode.postMessage({ command: 'disconnectGitHub' });
  });
}

function handleModelsListed(models) {
  const provider = providerSelect.value;
  const selectEl = document.getElementById('model-' + provider + '-select');
  const inputEl = document.getElementById('model-' + provider);

  if (selectEl && models.length > 0) {
    // Populate dropdown
    selectEl.innerHTML = '<option value="">Select a model...</option>';
    models.forEach(model => {
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

    // Show dropdown, hide input
    selectEl.classList.remove('hidden');
    inputEl.classList.add('hidden');

    // If there's a current value, select it
    if (inputEl.value) {
      selectEl.value = inputEl.value;
    }
  }
}
