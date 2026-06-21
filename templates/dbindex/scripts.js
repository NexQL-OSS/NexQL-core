(function() {
  const vscode = acquireVsCodeApi();

  const container = document.getElementById('index-cards');
  const buildNewBtn = document.getElementById('btn-build-new');
  const chkEmbeddings = document.getElementById('chk-enable-embeddings');

  // Handle setting updates
  chkEmbeddings.addEventListener('change', () => {
    vscode.postMessage({
      command: 'updateConfig',
      enableEmbeddings: chkEmbeddings.checked
    });
  });

  buildNewBtn.addEventListener('click', () => {
    vscode.postMessage({ command: 'buildNew' });
  });

  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
      case 'state':
        renderState(message.state);
        break;
    }
  });

  function renderState(state) {
    chkEmbeddings.checked = !!state.enableEmbeddings;

    if (!state.indexes || state.indexes.length === 0) {
      container.innerHTML = `
        <div class="pg-empty-state">
          <p>No active database indexes found.</p>
          <button id="btn-empty-build" class="empty-cta">⚡ Index a Database</button>
        </div>
      `;
      document.getElementById('btn-empty-build')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'buildNew' });
      });
      return;
    }

    container.innerHTML = '';
    state.indexes.forEach(idx => {
      const card = document.createElement('div');
      card.className = 'pg-card db-index-card';

      const dateStr = idx.indexedAt ? new Date(idx.indexedAt).toLocaleString() : 'N/A';
      const statusClass = idx.drift ? 'drift' : (idx.indexedAt ? 'fresh' : 'none');
      const statusLabel = idx.drift ? 'Drifted' : (idx.indexedAt ? 'Fresh' : 'Not Indexed');

      card.innerHTML = `
        <div class="card-header">
          <div class="card-title">
            <span>💾</span>
            <strong>${idx.database}</strong>
            <span class="pg-text-meta">(${idx.connectionName})</span>
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
          <strong>Scope:</strong> Schemas: <code>${idx.schemas ? idx.schemas.join(', ') : 'none'}</code> 
          ${idx.piiCount > 0 ? ` · <span style="color:var(--vscode-errorForeground)">${idx.piiCount} PII columns excluded</span>` : ''}
        </div>

        <div class="card-actions">
          <button class="pg-btn pg-btn--primary btn-rebuild" data-conn="${idx.connectionId}" data-db="${idx.database}">
            Rebuild
          </button>
          <button class="pg-btn pg-btn--ghost btn-export" data-conn="${idx.connectionId}" data-db="${idx.database}">
            Export Schema
          </button>
          <button class="pg-btn pg-btn--ghost btn-clear" data-conn="${idx.connectionId}" data-db="${idx.database}" style="color:var(--vscode-errorForeground)">
            Delete Index
          </button>
        </div>
      `;

      card.querySelector('.btn-rebuild').addEventListener('click', () => {
        vscode.postMessage({
          command: 'rebuild',
          connectionId: idx.connectionId,
          database: idx.database
        });
      });

      card.querySelector('.btn-export').addEventListener('click', () => {
        vscode.postMessage({
          command: 'export',
          connectionId: idx.connectionId,
          database: idx.database
        });
      });

      card.querySelector('.btn-clear').addEventListener('click', () => {
        vscode.postMessage({
          command: 'clear',
          connectionId: idx.connectionId,
          database: idx.database
        });
      });

      container.appendChild(card);
    });
  }

  // Request initial state on load
  vscode.postMessage({ command: 'requestState' });
}());
