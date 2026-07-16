(function() {
  const vscode = acquireVsCodeApi();

  // Active View Elements
  const viewIndexes = document.getElementById('view-indexes');
  const viewCuration = document.getElementById('view-curation');

  // List View Elements
  const container = document.getElementById('index-cards');
  const buildNewBtn = document.getElementById('btn-build-new');
  const chkEmbeddings = document.getElementById('chk-enable-embeddings');

  // Curation View Elements
  const btnBack = document.getElementById('btn-back');
  const btnSaveCuration = document.getElementById('btn-save-curation');
  const curationDb = document.getElementById('curation-db');
  const curationConn = document.getElementById('curation-conn');
  const txtObjectSearch = document.getElementById('txt-object-search');
  const objectsList = document.getElementById('objects-list');
  const joinsList = document.getElementById('joins-list');
  const synonymsList = document.getElementById('synonyms-list');

  // Join Form Elements
  const selJoinSrcTable = document.getElementById('sel-join-src-table');
  const selJoinSrcCol = document.getElementById('sel-join-src-col');
  const selJoinTgtTable = document.getElementById('sel-join-tgt-table');
  const selJoinTgtCol = document.getElementById('sel-join-tgt-col');
  const txtJoinVia = document.getElementById('txt-join-via');
  const btnAddJoin = document.getElementById('btn-add-join');

  // Synonym Form Elements
  const txtSynWord = document.getElementById('txt-syn-word');
  const txtSynList = document.getElementById('txt-syn-list');
  const btnAddSynonym = document.getElementById('btn-add-synonym');

  // Local Curation State
  let curatingConnectionId = '';
  let curatingDatabase = '';
  let curatingObjects = [];
  let curatingBaseJoins = [];
  let curatingMinedSynonyms = {};
  let curatingOverrides = { joins: [], synonyms: {}, objects: {} };

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

  btnBack.addEventListener('click', () => {
    viewCuration.style.display = 'none';
    viewIndexes.style.display = 'block';
    // Clear state
    curatingConnectionId = '';
    curatingDatabase = '';
    curatingObjects = [];
    curatingBaseJoins = [];
    curatingOverrides = { joins: [], synonyms: {}, objects: {} };
  });

  btnSaveCuration.addEventListener('click', () => {
    vscode.postMessage({
      command: 'saveOverrides',
      connectionId: curatingConnectionId,
      database: curatingDatabase,
      overrides: curatingOverrides
    });
  });

  // Tab Switching Logic
  const tabButtons = document.querySelectorAll('.curation-tabs .tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const tabId = btn.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');

      if (tabId === 'tab-visualizer') {
        renderVisualizerTab();
      }
    });
  });

  // Search Filter
  txtObjectSearch.addEventListener('input', () => {
    renderObjectsTab();
  });

  // Message Listener
  window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
      case 'state':
        renderState(message.state);
        break;
      case 'details':
        loadCurationState(message);
        break;
      case 'detailsError':
        alert('Failed to load curation workspace: ' + message.error);
        break;
    }
  });

  function renderState(state) {
    chkEmbeddings.checked = !!state.enableEmbeddings;

    renderDbIndexesShared(state.indexes, container, (action, connId, db) => {
      if (action === 'buildNew') {
        vscode.postMessage({ command: 'buildNew' });
        return;
      }
      const commandMap = {
        curate: 'requestDetails',
        rebuild: 'rebuild',
        export: 'export',
        clear: 'clear'
      };
      vscode.postMessage({ command: commandMap[action], connectionId: connId, database: db });
    });
  }


  function loadCurationState(message) {
    curatingConnectionId = message.connectionId;
    curatingDatabase = message.database;
    curatingObjects = message.objects;
    curatingBaseJoins = message.baseJoins || [];
    curatingMinedSynonyms = message.minedSynonyms || {};

    // Clone overrides safely
    curatingOverrides = JSON.parse(JSON.stringify(message.overrides || {}));
    if (!curatingOverrides.joins) curatingOverrides.joins = [];
    if (!curatingOverrides.synonyms) curatingOverrides.synonyms = {};
    if (!curatingOverrides.objects) curatingOverrides.objects = {};

    curationDb.innerText = curatingDatabase;
    curationConn.innerText = `(${curatingConnectionId})`;

    // Reset view
    viewIndexes.style.display = 'none';
    viewCuration.style.display = 'block';

    // Reset tabs (Objects default active)
    tabButtons.forEach((b, i) => {
      if (i === 0) b.classList.add('active');
      else b.classList.remove('active');
    });
    document.querySelectorAll('.tab-content').forEach((c, i) => {
      if (i === 0) c.classList.add('active');
      else c.classList.remove('active');
    });

    txtObjectSearch.value = '';

    // Render workspace contents
    renderObjectsTab();
    renderJoinsTab();
    renderSynonymsTab();
    setupJoinsForm();
  }

  // Safely retrieve/initialize overrides path
  function getOrCreateObjectOverride(ref) {
    if (!curatingOverrides.objects) {
      curatingOverrides.objects = {};
    }
    if (!curatingOverrides.objects[ref]) {
      curatingOverrides.objects[ref] = { columns: {} };
    }
    if (!curatingOverrides.objects[ref].columns) {
      curatingOverrides.objects[ref].columns = {};
    }
    return curatingOverrides.objects[ref];
  }

  // --- RENDERING: OBJECTS TAB ---
  function renderObjectsTab() {
    objectsList.innerHTML = '';
    const query = txtObjectSearch.value.trim().toLowerCase();

    const filtered = curatingObjects.filter(obj => {
      if (!query) return true;
      if (obj.ref.toLowerCase().includes(query)) return true;
      if (obj.comment && obj.comment.toLowerCase().includes(query)) return true;
      return false;
    });

    if (filtered.length === 0) {
      objectsList.innerHTML = '<p class="pg-empty-state">No objects matched your search filter.</p>';
      return;
    }

    filtered.forEach(obj => {
      const isExcluded = curatingOverrides.objects?.[obj.ref]?.excluded ?? false;
      const commentVal = curatingOverrides.objects?.[obj.ref]?.comment ?? obj.comment ?? '';

      const kindLabels = {
        table: '💾 TABLE',
        view: '👁️ VIEW',
        matview: '👁️ MATVIEW',
        function: '⚡ FUNCTION',
        enum: '🔢 ENUM',
        domain: '🏷️ DOMAIN',
        sequence: '🔢 SEQ'
      };
      const label = kindLabels[obj.kind] || obj.kind.toUpperCase();

      const item = document.createElement('div');
      item.className = `tree-item ${isExcluded ? 'excluded-item' : ''}`;

      item.innerHTML = `
        <div class="tree-header">
          <div class="tree-toggle-icon">▶</div>
          <div class="tree-info">
            <span class="obj-kind">${label}</span>
            <span class="obj-ref"><strong>${obj.ref}</strong></span>
          </div>
          <div class="tree-actions" onclick="event.stopPropagation()">
            <input type="text" class="pg-input obj-comment-input" placeholder="Custom description..." value="${commentVal}">
            <label class="checkbox-container">
              <input type="checkbox" class="chk-exclude" ${isExcluded ? 'checked' : ''}>
              <span class="checkbox-label">Exclude</span>
            </label>
          </div>
        </div>
        <div class="tree-children" style="display: none;">
          <table class="columns-table">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>PII</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              ${obj.columns.map(col => {
                const colOverride = curatingOverrides.objects?.[obj.ref]?.columns?.[col.name];
                const isPii = colOverride?.pii ?? col.pii ?? false;
                const colComment = colOverride?.comment ?? col.comment ?? '';
                return `
                  <tr class="${isPii ? 'pii-row' : ''}">
                    <td><code>${col.name}</code></td>
                    <td class="col-type">${col.type}</td>
                    <td>
                      <label class="checkbox-container">
                        <input type="checkbox" class="chk-pii" data-ref="${obj.ref}" data-col="${col.name}" ${isPii ? 'checked' : ''}>
                        <span class="checkbox-label">PII</span>
                      </label>
                    </td>
                    <td>
                      <input type="text" class="pg-input col-comment-input" data-ref="${obj.ref}" data-col="${col.name}" placeholder="Custom column description..." value="${colComment}">
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;

      // Expand/collapse child columns
      const header = item.querySelector('.tree-header');
      const children = item.querySelector('.tree-children');
      const toggleIcon = item.querySelector('.tree-toggle-icon');

      header.addEventListener('click', () => {
        const isCollapsed = children.style.display === 'none';
        children.style.display = isCollapsed ? 'block' : 'none';
        toggleIcon.innerText = isCollapsed ? '▼' : '▶';
        toggleIcon.classList.toggle('expanded', isCollapsed);
      });

      // Handle Object Exclusion
      const chkExclude = item.querySelector('.chk-exclude');
      chkExclude.addEventListener('change', () => {
        const override = getOrCreateObjectOverride(obj.ref);
        override.excluded = chkExclude.checked;
        if (chkExclude.checked) {
          item.classList.add('excluded-item');
        } else {
          item.classList.remove('excluded-item');
        }
      });

      // Handle Object Comment
      const commentInput = item.querySelector('.obj-comment-input');
      commentInput.addEventListener('change', () => {
        const override = getOrCreateObjectOverride(obj.ref);
        override.comment = commentInput.value.trim() || null;
      });

      // Handle Column PII & Comment
      item.querySelectorAll('.chk-pii').forEach(chk => {
        chk.addEventListener('change', () => {
          const ref = chk.getAttribute('data-ref');
          const colName = chk.getAttribute('data-col');
          const override = getOrCreateObjectOverride(ref);
          if (!override.columns[colName]) {
            override.columns[colName] = {};
          }
          override.columns[colName].pii = chk.checked;
          
          const row = chk.closest('tr');
          if (chk.checked) {
            row.classList.add('pii-row');
          } else {
            row.classList.remove('pii-row');
          }
        });
      });

      item.querySelectorAll('.col-comment-input').forEach(input => {
        input.addEventListener('change', () => {
          const ref = input.getAttribute('data-ref');
          const colName = input.getAttribute('data-col');
          const override = getOrCreateObjectOverride(ref);
          if (!override.columns[colName]) {
            override.columns[colName] = {};
          }
          override.columns[colName].comment = input.value.trim() || null;
        });
      });

      objectsList.appendChild(item);
    });
  }

  // --- RENDERING: RELATIONSHIPS / JOINS TAB ---
  function renderJoinsTab() {
    joinsList.innerHTML = '';

    // Gather all merged join edges
    const overrideMap = new Map();
    curatingOverrides.joins.forEach(edge => {
      const key = `${edge.from}->${edge.to}:${edge.via}`;
      overrideMap.set(key, edge);
    });

    const displayEdges = [];

    // Base joins
    curatingBaseJoins.forEach(baseEdge => {
      const key = `${baseEdge.from}->${baseEdge.to}:${baseEdge.via}`;
      if (overrideMap.has(key)) {
        displayEdges.push({
          ...overrideMap.get(key),
          isOverride: true
        });
        overrideMap.delete(key);
      } else {
        displayEdges.push({
          ...baseEdge,
          isOverride: false
        });
      }
    });

    // Custom remaining joins
    overrideMap.forEach(edge => {
      displayEdges.push({
        ...edge,
        isOverride: true,
        isCustom: true
      });
    });

    if (displayEdges.length === 0) {
      joinsList.innerHTML = '<p class="pg-empty-state">No relationships or join paths defined.</p>';
      return;
    }

    displayEdges.forEach(edge => {
      const joinRow = document.createElement('div');
      joinRow.className = `join-item ${edge.disabled ? 'disabled-join' : ''}`;

      const inferredBadge = edge.inferred ? '<span class="badge inferred">Inferred</span>' : '';
      const customBadge = edge.isCustom ? '<span class="badge custom">Custom</span>' : '';
      const colsStr = edge.cols.map(c => `<code>${c[0]} = ${c[1]}</code>`).join(' & ');

      joinRow.innerHTML = `
        <div class="join-info">
          <div class="join-direction">
            <strong>${edge.from}</strong> → <strong>${edge.to}</strong>
            ${inferredBadge} ${customBadge}
          </div>
          <div class="join-columns">
            via ${colsStr} (relationship: <code>${edge.via}</code>)
          </div>
        </div>
        <div class="join-actions">
          <label class="checkbox-container">
            <input type="checkbox" class="chk-disable-join" ${edge.disabled ? 'checked' : ''}>
            <span class="checkbox-label">Disable</span>
          </label>
          ${edge.isCustom ? '<button class="pg-btn pg-btn--ghost btn-del-join" style="color:var(--vscode-errorForeground)">Delete</button>' : ''}
        </div>
      `;

      // Handle disabling
      const chkDisable = joinRow.querySelector('.chk-disable-join');
      chkDisable.addEventListener('change', () => {
        // Find existing or push new override edge
        let overrideEdge = curatingOverrides.joins.find(e => e.from === edge.from && e.to === edge.to && e.via === edge.via);
        if (!overrideEdge) {
          overrideEdge = {
            from: edge.from,
            to: edge.to,
            via: edge.via,
            cols: edge.cols,
            inferred: edge.inferred,
            disabled: false
          };
          curatingOverrides.joins.push(overrideEdge);
        }
        overrideEdge.disabled = chkDisable.checked;
        if (chkDisable.checked) {
          joinRow.classList.add('disabled-join');
        } else {
          joinRow.classList.remove('disabled-join');
        }
      });

      // Handle deleting custom join
      if (edge.isCustom) {
        const btnDel = joinRow.querySelector('.btn-del-join');
        btnDel.addEventListener('click', () => {
          curatingOverrides.joins = curatingOverrides.joins.filter(e => !(e.from === edge.from && e.to === edge.to && e.via === edge.via));
          renderJoinsTab();
        });
      }

      joinsList.appendChild(joinRow);
    });
  }

  function setupJoinsForm() {
    selJoinSrcTable.innerHTML = '<option value="">Select table...</option>';
    selJoinTgtTable.innerHTML = '<option value="">Select table...</option>';

    const tables = curatingObjects.filter(o => o.kind === 'table' || o.kind === 'view' || o.kind === 'matview');

    tables.forEach(t => {
      const optSrc = document.createElement('option');
      optSrc.value = t.ref;
      optSrc.textContent = t.ref;
      selJoinSrcTable.appendChild(optSrc);

      const optTgt = document.createElement('option');
      optTgt.value = t.ref;
      optTgt.textContent = t.ref;
      selJoinTgtTable.appendChild(optTgt);
    });

    selJoinSrcTable.addEventListener('change', () => {
      populateColsSelect(selJoinSrcTable.value, selJoinSrcCol);
    });

    selJoinTgtTable.addEventListener('change', () => {
      populateColsSelect(selJoinTgtTable.value, selJoinTgtCol);
    });
  }

  function populateColsSelect(tableRef, selectEl) {
    selectEl.innerHTML = '<option value="">Select column...</option>';
    if (!tableRef) return;

    const tableObj = curatingObjects.find(o => o.ref === tableRef);
    if (tableObj && tableObj.columns) {
      tableObj.columns.forEach(col => {
        const opt = document.createElement('option');
        opt.value = col.name;
        opt.textContent = col.name;
        selectEl.appendChild(opt);
      });
    }
  }

  btnAddJoin.addEventListener('click', () => {
    const srcTable = selJoinSrcTable.value;
    const srcCol = selJoinSrcCol.value;
    const tgtTable = selJoinTgtTable.value;
    const tgtCol = selJoinTgtCol.value;
    const via = txtJoinVia.value.trim() || 'custom';

    if (!srcTable || !srcCol || !tgtTable || !tgtCol) {
      alert('Please fill out all source and target tables/columns to create a join path.');
      return;
    }

    // Add to override list
    const newEdge = {
      from: srcTable,
      to: tgtTable,
      via,
      cols: [[srcCol, tgtCol]],
      inferred: false,
      disabled: false
    };

    // Prevent duplicate exact custom edges
    const exists = curatingOverrides.joins.some(e => e.from === srcTable && e.to === tgtTable && e.via === via);
    if (exists) {
      alert('A custom join relationship already exists with this name between these tables.');
      return;
    }

    curatingOverrides.joins.push(newEdge);
    txtJoinVia.value = '';
    renderJoinsTab();
  });

  // --- RENDERING: SYNONYMS TAB ---
  function renderSynonymsTab() {
    synonymsList.innerHTML = '';

    // Load override synonyms
    const overrideSyns = curatingOverrides.synonyms || {};
    const words = Object.keys(overrideSyns);

    if (words.length === 0) {
      synonymsList.innerHTML = '<p class="pg-empty-state">No custom synonyms defined. Add mappings below.</p>';
      return;
    }

    words.forEach(word => {
      const synList = overrideSyns[word] || [];
      if (synList.length === 0) return;

      const synRow = document.createElement('div');
      synRow.className = 'synonym-item';
      synRow.innerHTML = `
        <div class="synonym-info">
          <strong>${word}</strong> ➔ <span>${synList.join(', ')}</span>
        </div>
        <button class="pg-btn pg-btn--ghost btn-del-syn" data-word="${word}" style="color:var(--vscode-errorForeground)">Delete</button>
      `;

      synRow.querySelector('.btn-del-syn').addEventListener('click', () => {
        delete curatingOverrides.synonyms[word];
        renderSynonymsTab();
      });

      synonymsList.appendChild(synRow);
    });
  }

  btnAddSynonym.addEventListener('click', () => {
    const word = txtSynWord.value.trim().toLowerCase();
    const synInput = txtSynList.value.trim();

    if (!word || !synInput) {
      alert('Please specify a valid word and a comma-separated list of synonyms.');
      return;
    }

    const syns = synInput.split(',')
      .map(s => s.trim().toLowerCase())
      .filter(s => s.length > 0);

    if (syns.length === 0) {
      alert('Please specify at least one non-empty synonym.');
      return;
    }

    if (!curatingOverrides.synonyms) {
      curatingOverrides.synonyms = {};
    }

    const currentList = curatingOverrides.synonyms[word] || [];
    curatingOverrides.synonyms[word] = Array.from(new Set([...currentList, ...syns]));

    txtSynWord.value = '';
    txtSynList.value = '';
    renderSynonymsTab();
  });

  // --- RENDERING: VISUALIZER TAB ---
  let visNodes = [];
  let visLinks = [];
  let visZoom = { x: 0, y: 0, k: 1 };
  let visSelectedNodeId = null;
  let visIsPanning = false;
  let visPanStart = { x: 0, y: 0 };
  let visDragNode = null;
  let visDragOffset = { x: 0, y: 0 };

  function renderVisualizerTab() {
    const svg = document.getElementById('visualizer-svg');
    const linksGroup = document.getElementById('vis-links-group');
    const nodesGroup = document.getElementById('vis-nodes-group');
    if (!svg || !linksGroup || !nodesGroup) return;

    // 1. Gather nodes (only unexcluded objects)
    const activeObjects = curatingObjects.filter(obj => !obj.excluded);
    visNodes = activeObjects.map(obj => {
      // Keep existing positions if available to preserve layout
      const existing = visNodes.find(n => n.id === obj.ref);
      return {
        id: obj.ref,
        name: obj.ref.split('.')[1] || obj.ref,
        schema: obj.ref.split('.')[0] || 'public',
        kind: obj.kind,
        columns: obj.columns || [],
        indexes: obj.indexes || [],
        comment: obj.comment,
        x: existing ? existing.x : undefined,
        y: existing ? existing.y : undefined
      };
    });

    // 2. Gather links/edges
    const overrideMap = new Map();
    curatingOverrides.joins.forEach(edge => {
      const key = `${edge.from}->${edge.to}:${edge.via}`;
      overrideMap.set(key, edge);
    });

    visLinks = [];
    
    // Add base joins
    curatingBaseJoins.forEach(baseEdge => {
      const key = `${baseEdge.from}->${baseEdge.to}:${baseEdge.via}`;
      let actualEdge = baseEdge;
      let isOverride = false;
      if (overrideMap.has(key)) {
        actualEdge = overrideMap.get(key);
        overrideMap.delete(key);
        isOverride = true;
      }
      
      // Only include if both source and target nodes exist and are not excluded
      if (visNodes.some(n => n.id === actualEdge.from) && visNodes.some(n => n.id === actualEdge.to)) {
        visLinks.push({
          source: actualEdge.from,
          target: actualEdge.to,
          via: actualEdge.via,
          cols: actualEdge.cols,
          inferred: actualEdge.inferred,
          disabled: actualEdge.disabled,
          isOverride
        });
      }
    });

    // Add custom remaining overrides
    overrideMap.forEach(edge => {
      if (visNodes.some(n => n.id === edge.from) && visNodes.some(n => n.id === edge.to)) {
        visLinks.push({
          source: edge.from,
          target: edge.to,
          via: edge.via,
          cols: edge.cols,
          inferred: edge.inferred,
          disabled: edge.disabled,
          isOverride: true,
          isCustom: true
        });
      }
    });

    // 3. Initialize visualizer detail panel
    updateVisDetails();

    // 4. Run force-directed layout if positions are undefined
    const svgRect = svg.getBoundingClientRect();
    const width = svgRect.width || 600;
    const height = svgRect.height || 550;
    
    runForceLayout(visNodes, visLinks, width, height);

    // 5. Draw elements in SVG
    drawVisGraph();

    // 6. Bind svg events (pan, zoom, reset, fit)
    bindVisEvents(svg, width, height);
  }

  function runForceLayout(nodes, links, width, height, forceRecompute = false) {
    let needsLayout = false;
    nodes.forEach((node, idx) => {
      if (node.x === undefined || node.y === undefined || forceRecompute) {
        needsLayout = true;
        const angle = (idx / nodes.length) * 2 * Math.PI;
        const radius = Math.min(width, height) * 0.3;
        node.x = width / 2 + radius * Math.cos(angle) + (Math.random() - 0.5) * 20;
        node.y = height / 2 + radius * Math.sin(angle) + (Math.random() - 0.5) * 20;
      }
      node.vx = 0;
      node.vy = 0;
    });

    if (!needsLayout) return;

    const iterations = 100;
    const kspring = 0.035;
    const krepel = 3500;
    const damping = 0.82;

    for (let iter = 0; iter < iterations; iter++) {
      // Repulsion between node bodies
      for (let i = 0; i < nodes.length; i++) {
        const n1 = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const n2 = nodes[j];
          const dx = n2.x - n1.x;
          const dy = n2.y - n1.y;
          const distSq = dx * dx + dy * dy + 0.01;
          const dist = Math.sqrt(distSq);
          if (dist < 220) {
            const force = krepel / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            n1.vx -= fx;
            n1.vy -= fy;
            n2.vx += fx;
            n2.vy += fy;
          }
        }
      }

      // Attraction along links
      links.forEach(link => {
        if (link.disabled) return;
        const source = nodes.find(n => n.id === link.source);
        const target = nodes.find(n => n.id === link.target);
        if (source && target) {
          const dx = target.x - source.x;
          const dy = target.y - source.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const desiredDist = 130;
          const force = kspring * (dist - desiredDist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          source.vx += fx;
          source.vy += fy;
          target.vx -= fx;
          target.vy -= fy;
        }
      });

      // Gravity to center
      nodes.forEach(node => {
        const dx = width / 2 - node.x;
        const dy = height / 2 - node.y;
        node.vx += dx * 0.005;
        node.vy += dy * 0.005;
      });

      // Update positions
      nodes.forEach(node => {
        node.x += node.vx * damping;
        node.y += node.vy * damping;
        // Keep within bounds
        node.x = Math.max(30, Math.min(width - 30, node.x));
        node.y = Math.max(30, Math.min(height - 30, node.y));
      });
    }
  }

  function drawVisGraph() {
    const linksGroup = document.getElementById('vis-links-group');
    const nodesGroup = document.getElementById('vis-nodes-group');
    if (!linksGroup || !nodesGroup) return;

    linksGroup.innerHTML = '';
    nodesGroup.innerHTML = '';

    // Draw Links
    visLinks.forEach(link => {
      const sourceNode = visNodes.find(n => n.id === link.source);
      const targetNode = visNodes.find(n => n.id === link.target);
      if (!sourceNode || !targetNode) return;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      
      const x1 = sourceNode.x;
      const y1 = sourceNode.y;
      const x2 = targetNode.x;
      const y2 = targetNode.y;
      
      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      
      path.setAttribute('d', d);
      
      let cls = 'vis-link-line';
      if (link.inferred) cls += ' inferred';
      if (link.disabled) cls += ' disabled';
      if (visSelectedNodeId === link.source || visSelectedNodeId === link.target) cls += ' active';
      
      path.setAttribute('class', cls);
      path.setAttribute('marker-end', visSelectedNodeId === link.source || visSelectedNodeId === link.target ? 'url(#vis-arrow-active)' : 'url(#vis-arrow)');
      
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${link.source} -> ${link.target} (${link.via})`;
      path.appendChild(title);
      
      linksGroup.appendChild(path);
    });

    // Draw Nodes
    visNodes.forEach(node => {
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('transform', `translate(${node.x}, ${node.y})`);
      group.setAttribute('data-id', node.id);

      const isSelected = visSelectedNodeId === node.id;
      const isRelated = visLinks.some(l => !l.disabled && ((l.source === visSelectedNodeId && l.target === node.id) || (l.target === visSelectedNodeId && l.source === node.id)));

      // Render rectangular node card
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      const width = 160;
      const height = 48;
      rect.setAttribute('x', -width / 2);
      rect.setAttribute('y', -height / 2);
      rect.setAttribute('width', width);
      rect.setAttribute('height', height);
      rect.setAttribute('class', `vis-node-rect ${isSelected ? 'selected' : ''} ${isRelated ? 'highlighted' : ''}`);
      
      group.appendChild(rect);

      // Icon + Header (Title)
      const titleText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      titleText.setAttribute('x', -width / 2 + 10);
      titleText.setAttribute('y', -height / 2 + 18);
      titleText.setAttribute('class', 'vis-node-header');
      
      let icon = '▦ ';
      if (node.kind === 'view' || node.kind === 'matview') icon = '👁 ';
      if (node.kind === 'function') icon = '⚙ ';
      
      titleText.textContent = icon + node.name;
      group.appendChild(titleText);

      // Schema Subheader
      const schemaText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      schemaText.setAttribute('x', -width / 2 + 10);
      schemaText.setAttribute('y', -height / 2 + 30);
      schemaText.setAttribute('class', 'vis-node-subheader');
      schemaText.textContent = node.schema;
      group.appendChild(schemaText);

      // Index and column stats indicators on node bottom
      const statsText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      statsText.setAttribute('x', -width / 2 + 10);
      statsText.setAttribute('y', -height / 2 + 41);
      statsText.setAttribute('class', 'vis-node-content');
      
      const indexCount = node.indexes.length;
      statsText.textContent = `${node.columns.length} cols` + (indexCount > 0 ? ` · ${indexCount} idx` : '');
      group.appendChild(statsText);

      // Indicator badge if it has overrides/PII
      const piiColumnsCount = node.columns.filter(c => c.pii).length;
      if (piiColumnsCount > 0) {
        const badge = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        badge.setAttribute('x', width / 2 - 20);
        badge.setAttribute('y', -height / 2 + 16);
        badge.setAttribute('class', 'vis-node-indicator');
        badge.setAttribute('style', 'fill: var(--vscode-errorForeground, #ef4444); font-weight: bold;');
        badge.textContent = '⚠️';
        group.appendChild(badge);
      }

      // Drag / Click Bindings
      rect.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        
        visSelectedNodeId = node.id;
        updateVisDetails();
        drawVisGraph(); // Redraw to highlight selections

        visDragNode = node;
        
        // Compute drag offsets under scale
        const rectSvg = document.getElementById('visualizer-svg').getBoundingClientRect();
        const clientX = (e.clientX - rectSvg.left - visZoom.x) / visZoom.k;
        const clientY = (e.clientY - rectSvg.top - visZoom.y) / visZoom.k;
        
        visDragOffset.x = clientX - node.x;
        visDragOffset.y = clientY - node.y;
      });

      nodesGroup.appendChild(group);
    });
  }

  function bindVisEvents(svg, width, height) {
    // Pan SVG background
    svg.onmousedown = e => {
      if (e.button !== 0 || visDragNode) return;
      visIsPanning = true;
      visPanStart.x = e.clientX - visZoom.x;
      visPanStart.y = e.clientY - visZoom.y;
    };

    window.addEventListener('mousemove', e => {
      if (visIsPanning) {
        visZoom.x = e.clientX - visPanStart.x;
        visZoom.y = e.clientY - visPanStart.y;
        applyZoomTransform();
      } else if (visDragNode) {
        const rectSvg = svg.getBoundingClientRect();
        const clientX = (e.clientX - rectSvg.left - visZoom.x) / visZoom.k;
        const clientY = (e.clientY - rectSvg.top - visZoom.y) / visZoom.k;
        
        visDragNode.x = clientX - visDragOffset.x;
        visDragNode.y = clientY - visDragOffset.y;
        
        // Keep within bounds
        visDragNode.x = Math.max(30, Math.min(width - 30, visDragNode.x));
        visDragNode.y = Math.max(30, Math.min(height - 30, visDragNode.y));

        // Drag actual SVG element
        const nodeEl = svg.querySelector(`g[data-id="${visDragNode.id}"]`);
        if (nodeEl) {
          nodeEl.setAttribute('transform', `translate(${visDragNode.x}, ${visDragNode.y})`);
        }
        
        // Recalculate paths
        drawVisLinksOnly();
      }
    });

    window.addEventListener('mouseup', () => {
      visIsPanning = false;
      visDragNode = null;
    });

    // Zoom on wheel
    svg.onwheel = e => {
      e.preventDefault();
      const rectSvg = svg.getBoundingClientRect();
      const mouseX = e.clientX - rectSvg.left;
      const mouseY = e.clientY - rectSvg.top;
      
      const zoomFactor = 1.08;
      const delta = e.deltaY < 0 ? zoomFactor : 1 / zoomFactor;
      
      const newK = Math.max(0.15, Math.min(3, visZoom.k * delta));
      
      // Zoom centered at mouse
      visZoom.x = mouseX - (mouseX - visZoom.x) * (newK / visZoom.k);
      visZoom.y = mouseY - (mouseY - visZoom.y) * (newK / visZoom.k);
      visZoom.k = newK;
      
      applyZoomTransform();
    };

    // Toolbar buttons
    document.getElementById('btn-vis-fit').onclick = fitVisView;
    document.getElementById('btn-vis-reset').onclick = () => {
      visZoom = { x: 0, y: 0, k: 1 };
      applyZoomTransform();
    };
    document.getElementById('btn-vis-refresh').onclick = () => {
      runForceLayout(visNodes, visLinks, width, height, true);
      drawVisGraph();
    };
  }

  function applyZoomTransform() {
    const zoomGroup = document.getElementById('vis-zoom-group');
    if (zoomGroup) {
      zoomGroup.setAttribute('transform', `translate(${visZoom.x}, ${visZoom.y}) scale(${visZoom.k})`);
    }
  }

  function drawVisLinksOnly() {
    const linksGroup = document.getElementById('vis-links-group');
    if (!linksGroup) return;

    linksGroup.innerHTML = '';
    visLinks.forEach(link => {
      const sourceNode = visNodes.find(n => n.id === link.source);
      const targetNode = visNodes.find(n => n.id === link.target);
      if (!sourceNode || !targetNode) return;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      
      const x1 = sourceNode.x;
      const y1 = sourceNode.y;
      const x2 = targetNode.x;
      const y2 = targetNode.y;
      
      const midX = (x1 + x2) / 2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      
      path.setAttribute('d', d);
      
      let cls = 'vis-link-line';
      if (link.inferred) cls += ' inferred';
      if (link.disabled) cls += ' disabled';
      if (visSelectedNodeId === link.source || visSelectedNodeId === link.target) cls += ' active';
      
      path.setAttribute('class', cls);
      path.setAttribute('marker-end', visSelectedNodeId === link.source || visSelectedNodeId === link.target ? 'url(#vis-arrow-active)' : 'url(#vis-arrow)');
      
      linksGroup.appendChild(path);
    });
  }

  function fitVisView() {
    if (visNodes.length === 0) return;
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    visNodes.forEach(node => {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x);
      maxY = Math.max(maxY, node.y);
    });

    const svg = document.getElementById('visualizer-svg');
    const rectSvg = svg.getBoundingClientRect();
    const W = rectSvg.width || 600;
    const H = rectSvg.height || 550;

    const pad = 60;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;

    const newK = Math.min(W / contentW, H / contentH, 1);
    visZoom.k = newK;
    visZoom.x = (W - contentW * newK) / 2 - minX * newK + pad * newK;
    visZoom.y = (H - contentH * newK) / 2 - minY * newK + pad * newK;

    applyZoomTransform();
  }

  function updateVisDetails() {
    const container = document.getElementById('visualizer-details');
    if (!container) return;

    if (!visSelectedNodeId) {
      container.innerHTML = `
        <div class="detail-placeholder">
          <p>Click a table or object node in the graph to visualize and inspect its indexes, column schema, and active relations.</p>
        </div>
      `;
      return;
    }

    const node = visNodes.find(n => n.id === visSelectedNodeId);
    if (!node) return;

    // Build indexes HTML
    let indexesHtml = '<p class="pg-text-meta">No custom indexes defined</p>';
    if (node.indexes && node.indexes.length > 0) {
      indexesHtml = node.indexes.map(idx => {
        const uniqueTag = idx.unique ? '<span class="vis-tag pk">Unique</span>' : '';
        const methodTag = idx.method ? `<span class="vis-tag">${idx.method}</span>` : '';
        const partialInfo = idx.partial ? `<div style="font-size:10px;color:var(--pg-text-muted);margin-top:2px;">WHERE ${idx.partial}</div>` : '';
        return `
          <div class="vis-detail-index-item">
            <strong>${escapeHtml(idx.name)}</strong> ${uniqueTag} ${methodTag}
            <div style="color:var(--pg-text-muted);margin-top:2px;">(${escapeHtml(idx.columns.join(', '))})</div>
            ${partialInfo}
          </div>
        `;
      }).join('');
    }

    // Build columns HTML
    const columnsHtml = node.columns.map(col => {
      const piiTag = col.pii ? '<span class="vis-tag pii">PII Excluded</span>' : '';
      const commentHtml = col.comment ? `<div style="font-size:10px;color:var(--pg-text-muted);margin-top:2px;">${escapeHtml(col.comment)}</div>` : '';
      return `
        <div class="vis-detail-column-item">
          <strong>${escapeHtml(col.name)}</strong> <span class="col-type">${escapeHtml(col.type)}</span> ${piiTag}
          ${commentHtml}
        </div>
      `;
    }).join('');

    // Build relationships HTML
    const activeLinks = visLinks.filter(l => !l.disabled && (l.source === node.id || l.target === node.id));
    let relationsHtml = '<p class="pg-text-meta">No active relationship paths</p>';
    if (activeLinks.length > 0) {
      relationsHtml = activeLinks.map(link => {
        const inferredTag = link.inferred ? '<span class="vis-tag">Inferred</span>' : '';
        const customTag = link.isCustom ? '<span class="vis-tag">Custom</span>' : '';
        const dir = link.source === node.id ? `→ <strong>${link.target.split('.')[1]}</strong>` : `← <strong>${link.source.split('.')[1]}</strong>`;
        const colsStr = link.cols.map(c => `${c[0]} = ${c[1]}`).join(' & ');
        return `
          <div class="vis-detail-index-item">
            ${dir} ${inferredTag} ${customTag}
            <div style="font-size:10px;color:var(--pg-text-muted);margin-top:2px;">via ${escapeHtml(colsStr)}</div>
            <div style="font-size:9px;color:var(--pg-text-muted);opacity:0.8;">name: ${escapeHtml(link.via)}</div>
          </div>
        `;
      }).join('');
    }

    container.innerHTML = `
      <div class="vis-detail-card">
        <h4><span>💾</span> ${escapeHtml(node.name)}</h4>
        <div style="font-size:11px;color:var(--pg-text-muted);margin-top:-6px;">schema: <code>${escapeHtml(node.schema)}</code> · kind: <code>${escapeHtml(node.kind)}</code></div>
        
        ${node.comment ? `<div class="vis-detail-section"><h5>Description</h5><div style="font-size:11px;line-height:1.45;color:var(--vscode-foreground);">${escapeHtml(node.comment)}</div></div>` : ''}

        <div class="vis-detail-section">
          <h5>Built Indexes (${node.indexes.length})</h5>
          <div class="vis-detail-indexes">${indexesHtml}</div>
        </div>

        <div class="vis-detail-section">
          <h5>Active Joins (${activeLinks.length})</h5>
          <div class="vis-detail-indexes">${relationsHtml}</div>
        </div>

        <div class="vis-detail-section">
          <h5>Columns Schema (${node.columns.length})</h5>
          <div class="vis-detail-columns">${columnsHtml}</div>
        </div>
      </div>
    `;
  }

  // Request initial state on load
  vscode.postMessage({ command: 'requestState' });
}());
