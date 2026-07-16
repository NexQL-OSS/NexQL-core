if (typeof escapeHtml === 'undefined') {
  window.escapeHtml = function(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  };
}

if (typeof expandedConnectionIds === 'undefined') {
  window.expandedConnectionIds = new Set();
}

window.renderDbIndexesShared = function(indexes, container, postAction) {
  if (!container) return;

  if (!indexes || indexes.length === 0) {
    container.innerHTML = `
      <div class="empty-state pg-empty-state">
        <div class="empty-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" fill="none"><rect x="8" y="14" width="32" height="22" rx="4" stroke="currentColor" stroke-width="2"/><path d="M16 24h16M24 20v8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </div>
        <h2>No active database indexes</h2>
        <p>Build a local index to enable conceptual search and offline grounding for AI tools.</p>
        <button type="button" class="btn-primary empty-cta" id="dbindexEmptyBuildBtnShared">⚡ Index Your First Database</button>
      </div>
    `;
    const btn = document.getElementById('dbindexEmptyBuildBtnShared');
    if (btn) {
      btn.addEventListener('click', () => {
        postAction('buildNew');
      });
    }
    return;
  }

  container.textContent = '';

  // Group by connectionId
  const groups = {};
  indexes.forEach(idx => {
    const connId = idx.connectionId || 'unknown';
    if (!groups[connId]) {
      groups[connId] = {
        connectionName: idx.connectionName || 'Unnamed Connection',
        indexes: []
      };
    }
    groups[connId].indexes.push(idx);
  });

  Object.keys(groups).forEach(connId => {
    const group = groups[connId];
    const groupCard = document.createElement('div');
    
    // Collapsed by default (unless connection is in expandedConnectionIds)
    const isExpanded = window.expandedConnectionIds.has(connId);
    groupCard.className = `connection-index-group${isExpanded ? '' : ' collapsed'}`;

    const indexCountText = group.indexes.length === 1 ? '1 index' : `${group.indexes.length} indexes`;

    groupCard.innerHTML = `
      <div class="connection-group-header">
        <div class="connection-group-title">
          <span class="chevron">▼</span>
          <span class="icon">🔌</span>
          <h3 class="title">${escapeHtml(group.connectionName)}</h3>
        </div>
        <span class="index-count-badge">${indexCountText}</span>
      </div>
      <div class="connection-group-body"></div>
    `;

    // Setup header click toggle
    const header = groupCard.querySelector('.connection-group-header');
    header.addEventListener('click', () => {
      const currentlyCollapsed = groupCard.classList.toggle('collapsed');
      if (currentlyCollapsed) {
        window.expandedConnectionIds.delete(connId);
      } else {
        window.expandedConnectionIds.add(connId);
      }
    });

    const bodyContainer = groupCard.querySelector('.connection-group-body');

    group.indexes.forEach(idx => {
      const row = document.createElement('div');
      row.className = 'db-index-row';

      const dateStr = idx.indexedAt ? new Date(idx.indexedAt).toLocaleString() : 'N/A';
      const statusClass = idx.drift ? 'drift' : (idx.indexedAt ? 'fresh' : 'none');
      const statusLabel = idx.drift ? 'Drifted' : (idx.indexedAt ? 'Fresh' : 'Not Indexed');

      row.innerHTML = `
        <div class="db-index-row-main">
          <div class="db-name-section">
            <span class="db-icon">🗄️</span>
            <strong class="db-name">${escapeHtml(idx.database)}</strong>
            <span class="status-badge ${statusClass}">${statusLabel}</span>
          </div>
          <div class="db-stats-section">
            <span class="stat-bubble" title="Indexed Objects">
              <strong>${idx.tables || 0}</strong> tables · <strong>${idx.views || 0}</strong> views · <strong>${idx.functions || 0}</strong> fns
            </span>
            <span class="stat-bubble" title="Indexing Depth">
              Depth: <strong>${idx.depth || 'N/A'}</strong>
            </span>
            <span class="stat-bubble" title="Last Updated">
              Updated: <strong>${dateStr}</strong>
            </span>
          </div>
          <div class="db-actions-section">
            <button class="pg-btn pg-btn--primary pg-btn-sm btn-curate" data-conn="${idx.connectionId}" data-db="${idx.database}">
              🔧 Curate
            </button>
            <button class="pg-btn pg-btn--ghost pg-btn-sm btn-rebuild" data-conn="${idx.connectionId}" data-db="${idx.database}">
              Rebuild
            </button>
            <button class="pg-btn pg-btn--ghost pg-btn-sm btn-export" data-conn="${idx.connectionId}" data-db="${idx.database}">
              Export
            </button>
            <button class="pg-btn pg-btn--ghost pg-btn-sm btn-clear" data-conn="${idx.connectionId}" data-db="${idx.database}" style="color:var(--vscode-errorForeground)">
              Delete
            </button>
          </div>
        </div>
        <div class="db-index-row-sub">
          <span class="lbl">Scope:</span> <code>${escapeHtml(idx.schemas ? idx.schemas.join(', ') : 'none')}</code>
          ${idx.piiCount > 0 ? ` · <span class="pii-warning">${idx.piiCount} PII columns excluded</span>` : ''}
        </div>
      `;

      // Helper to find the closest button (for settings-hub styling compatibility)
      const findBtn = (selector) => {
        return row.querySelector(selector);
      };

      const btnCurate = findBtn('.btn-curate');
      const btnRebuild = findBtn('.btn-rebuild');
      const btnExport = findBtn('.btn-export');
      const btnClear = findBtn('.btn-clear');

      // Add settings-hub secondary style compatibility if it's settings-hub (classes: btn-secondary)
      if (document.getElementById('dbindexBuildBtn')) {
        [btnRebuild, btnExport, btnClear].forEach(b => {
          if (b) {
            b.className = b.className.replace('pg-btn pg-btn--ghost pg-btn-sm', 'btn-secondary btn-sm');
          }
        });
        if (btnCurate) {
          btnCurate.className = btnCurate.className.replace('pg-btn pg-btn--primary pg-btn-sm', 'btn-primary btn-sm');
        }
        if (btnClear) {
          btnClear.className += ' btn-danger-text';
        }
      }

      btnCurate.addEventListener('click', (e) => {
        e.stopPropagation();
        postAction('curate', idx.connectionId, idx.database);
      });

      btnRebuild.addEventListener('click', (e) => {
        e.stopPropagation();
        postAction('rebuild', idx.connectionId, idx.database);
      });

      btnExport.addEventListener('click', (e) => {
        e.stopPropagation();
        postAction('export', idx.connectionId, idx.database);
      });

      btnClear.addEventListener('click', (e) => {
        e.stopPropagation();
        postAction('clear', idx.connectionId, idx.database);
      });

      bodyContainer.appendChild(row);
    });

    container.appendChild(groupCard);
  });
};
