    const vscode = acquireVsCodeApi();
    let state = {};
    let lastLog = '';
    const selectedTables = new Set();
    const selectedSchemas = new Set();
    /** Schemas excluded from the table list; empty = show all. */
    const tableSchemaExclude = new Set();
    let schemaNsPickerOpen = false;
    let tablePickerOpen = false;

    function getSchemaChoices() {
      return state.schemas || [];
    }

    function visibleSchemaRows() {
      var searchEl = document.getElementById('d_sn_search');
      var q = searchEl ? String(searchEl.value || '').toLowerCase().trim() : '';
      return getSchemaChoices().filter(function(s) {
        if (q && String(s).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }

    function updateSchemaNsTriggerSummary() {
      var el = document.getElementById('d_sn_trigger_summary');
      if (!el) return;
      var total = getSchemaChoices().length;
      if (total === 0) {
        el.textContent = 'No schemas in catalog';
        return;
      }
      var n = selectedSchemas.size;
      if (n === 0) {
        el.textContent = 'No schema filter for -n (click to choose)';
        return;
      }
      if (n === total) {
        el.textContent = 'All ' + total + ' schemas for -n';
        return;
      }
      var sorted = Array.from(selectedSchemas).sort();
      if (n <= 3) {
        el.textContent = n + ' for -n: ' + sorted.join(', ');
        return;
      }
      el.textContent = n + ' of ' + total + ' schemas for -n';
    }

    function updateSchemaNsInteraction() {
      var wrap = document.getElementById('d_sn_ms_wrap');
      var btn = document.getElementById('d_sn_btn');
      if (wrap) wrap.classList.toggle('schema-ns-disabled', selectedTables.size > 0);
      if (btn) {
        btn.disabled = selectedTables.size > 0;
        btn.title = selectedTables.size > 0
          ? 'Clear table selections (-t) to edit schema (-n) filter'
          : '';
      }
    }

    function renderSchemaNsChips() {
      var wrap = document.getElementById('d_sn_chips');
      if (!wrap) return;
      wrap.innerHTML = '';
      if (selectedSchemas.size === 0) {
        wrap.hidden = true;
        return;
      }
      wrap.hidden = false;
      Array.from(selectedSchemas).sort().forEach(function(schemaName) {
        var chip = document.createElement('span');
        chip.className = 'picker-chip';
        chip.setAttribute('role', 'listitem');
        chip.appendChild(document.createTextNode(schemaName));
        var rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'picker-chip-remove';
        rm.setAttribute('aria-label', 'Remove schema ' + schemaName);
        rm.appendChild(document.createTextNode('\u00D7'));
        rm.addEventListener('click', function(e) {
          e.preventDefault();
          selectedSchemas.delete(schemaName);
          renderSchemaNsPickerList();
          onDumpSchemasChanged();
        });
        chip.appendChild(rm);
        wrap.appendChild(chip);
      });
    }

    function renderSchemaNsPickerList() {
      var list = document.getElementById('d_sn_list');
      var empty = document.getElementById('d_sn_empty');
      if (!list) return;
      var choices = getSchemaChoices();
      list.innerHTML = '';
      if (!choices.length) {
        if (empty) {
          empty.hidden = false;
          empty.textContent = 'No schemas in catalog.';
        }
        renderSchemaNsChips();
        updateSchemaNsTriggerSummary();
        updateSchemaNsInteraction();
        return;
      }
      if (empty) empty.hidden = true;
      visibleSchemaRows().forEach(function(schemaName) {
        var lab = document.createElement('label');
        lab.className = 'table-picker-row' + (selectedSchemas.has(schemaName) ? ' is-selected' : '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedSchemas.has(schemaName);
        cb.dataset.schema = schemaName;
        cb.addEventListener('change', function() {
          if (cb.checked) selectedSchemas.add(schemaName);
          else selectedSchemas.delete(schemaName);
          lab.classList.toggle('is-selected', cb.checked);
          updateSchemaNsTriggerSummary();
          renderSchemaNsChips();
          onDumpSchemasChanged();
        });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(schemaName));
        list.appendChild(lab);
      });
      if (choices.length && visibleSchemaRows().length === 0) {
        var miss = document.createElement('p');
        miss.className = 'ms-dropdown-empty field-hint';
        miss.textContent = 'No schemas match your search.';
        list.appendChild(miss);
      }
      renderSchemaNsChips();
      updateSchemaNsTriggerSummary();
      updateSchemaNsInteraction();
    }

    function getTableChoices() {
      return state.tableChoices || [];
    }

    /** Tables allowed for -t while schema (-n) subset is selected; otherwise full catalog. */
    function tableChoicesForDump() {
      var all = state.tableChoices || [];
      if (selectedSchemas.size === 0) return all;
      return all.filter(function(row) { return selectedSchemas.has(row.schema); });
    }

    function pruneInvalidTableSelections() {
      if (selectedSchemas.size === 0) return;
      var toRemove = [];
      selectedTables.forEach(function(q) {
        var row = (state.tableChoices || []).find(function(r) { return r.qualified === q; });
        var sch = row ? row.schema : '';
        if (!sch || !selectedSchemas.has(sch)) toRemove.push(q);
      });
      toRemove.forEach(function(q) { selectedTables.delete(q); });
    }

    function schemaNamesForTableFilter() {
      var seen = Object.create(null);
      var out = [];
      tableChoicesForDump().forEach(function(row) {
        var s = row.schema;
        if (s && !seen[s]) {
          seen[s] = true;
          out.push(s);
        }
      });
      out.sort();
      return out;
    }

    function pruneTableSchemaExclude() {
      var allowed = Object.create(null);
      schemaNamesForTableFilter().forEach(function(s) { allowed[s] = true; });
      Array.from(tableSchemaExclude).forEach(function(s) {
        if (!allowed[s]) tableSchemaExclude.delete(s);
      });
    }

    function onDumpSchemasChanged() {
      pruneInvalidTableSelections();
      pruneTableSchemaExclude();
      renderSchemaFilterPanel();
      updateTableTriggerSummary();
      renderTablePickerList();
    }

    function visibleTableRows() {
      var searchEl = document.getElementById('d_table_search');
      var q = searchEl ? String(searchEl.value || '').toLowerCase().trim() : '';
      return tableChoicesForDump().filter(function(row) {
        if (tableSchemaExclude.has(row.schema)) return false;
        if (q && String(row.qualified).toLowerCase().indexOf(q) < 0) return false;
        return true;
      });
    }

    function tableSchemaVisibilitySuffix() {
      var names = schemaNamesForTableFilter();
      var n = names.length;
      if (n === 0) return '';
      var shown = names.filter(function(s) { return !tableSchemaExclude.has(s); });
      if (tableSchemaExclude.size === 0) return '';
      if (shown.length === 0) return ' · list: no schemas visible';
      if (shown.length <= 2) return ' · list: ' + shown.join(', ');
      return ' · list: ' + shown.length + '/' + n + ' schemas';
    }

    function updateTableTriggerSummary() {
      var el = document.getElementById('d_table_trigger_summary');
      if (!el) return;
      var total = tableChoicesForDump().length;
      if (total === 0) {
        el.textContent = 'No tables in catalog (click to open picker)';
        return;
      }
      var n = selectedTables.size;
      var base = n === 0 ? ('0 of ' + total + ' tables') : (n + ' of ' + total + ' tables');
      el.textContent = base + tableSchemaVisibilitySuffix();
    }

    function setSnPickerOpen(open) {
      schemaNsPickerOpen = !!open;
      var panel = document.getElementById('d_sn_panel');
      var btn = document.getElementById('d_sn_btn');
      var wrap = document.getElementById('d_sn_ms_wrap');
      if (panel) panel.hidden = !schemaNsPickerOpen;
      if (btn) btn.setAttribute('aria-expanded', schemaNsPickerOpen ? 'true' : 'false');
      if (wrap) wrap.classList.toggle('is-open', schemaNsPickerOpen);
    }

    function setTablePickerOpen(open) {
      tablePickerOpen = !!open;
      var panel = document.getElementById('d_table_panel');
      var btn = document.getElementById('d_table_btn');
      var wrap = document.getElementById('d_table_ms_wrap');
      if (panel) panel.hidden = !tablePickerOpen;
      if (btn) btn.setAttribute('aria-expanded', tablePickerOpen ? 'true' : 'false');
      if (wrap) wrap.classList.toggle('is-open', tablePickerOpen);
    }

    function renderSchemaFilterPanel() {
      var list = document.getElementById('d_sch_filter_list');
      if (!list) return;
      list.innerHTML = '';
      var names = schemaNamesForTableFilter();
      names.forEach(function(s) {
        var lab = document.createElement('label');
        lab.className = 'ms-dropdown-option';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !tableSchemaExclude.has(s);
        cb.addEventListener('change', function() {
          if (cb.checked) tableSchemaExclude.delete(s);
          else tableSchemaExclude.add(s);
          updateTableTriggerSummary();
          renderTablePickerList();
        });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(s));
        list.appendChild(lab);
      });
      updateTableTriggerSummary();
    }

    function renderTablePickerList() {
      var list = document.getElementById('d_table_list');
      var empty = document.getElementById('d_table_empty');
      if (!list) return;
      var choices = tableChoicesForDump();
      var visible = choices.length ? visibleTableRows() : [];
      if (empty) {
        if (!choices.length) {
          empty.hidden = false;
          empty.textContent = selectedSchemas.size > 0
            ? 'No tables in the selected schemas.'
            : 'No tables found (permissions or empty database).';
        } else if (visible.length === 0) {
          empty.hidden = false;
          empty.textContent = 'No tables match the current search or schema visibility filter. Clear the search, use "Show all", or adjust schema checkboxes above.';
        } else {
          empty.hidden = true;
        }
      }
      list.innerHTML = '';
      if (!choices.length) {
        updateTableTriggerSummary();
        updateSchemaNsInteraction();
        return;
      }
      visible.forEach(function(row) {
        var lab = document.createElement('label');
        lab.className = 'table-picker-row' + (selectedTables.has(row.qualified) ? ' is-selected' : '');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedTables.has(row.qualified);
        cb.dataset.qualified = row.qualified;
        cb.addEventListener('change', function() {
          if (cb.checked) selectedTables.add(row.qualified);
          else selectedTables.delete(row.qualified);
          lab.classList.toggle('is-selected', cb.checked);
          updateTableTriggerSummary();
          updateSchemaNsInteraction();
        });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(row.qualified));
        list.appendChild(lab);
      });
      updateTableTriggerSummary();
      updateSchemaNsInteraction();
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'init') {
        state = message.payload;
        selectedTables.clear();
        selectedSchemas.clear();
        tableSchemaExclude.clear();
        setSnPickerOpen(false);
        setTablePickerOpen(false);
        document.getElementById('d_db').value = state.databaseName || '';
        document.getElementById('r_target').innerHTML = (state.databases || [])
          .map(d => '<option value="' + d.replace(/"/g,'&quot;') + '">' + d + '</option>')
          .join('');
        var sub = document.getElementById('backupSubtitle');
        if (sub) sub.textContent = state.databaseLabel ? ('Target · ' + state.databaseLabel) : '';
        const b = document.getElementById('banner');
        let h = '';
        if (state.versionMismatchDump || state.versionMismatchRestore) {
          h += '<div class="pg-banner warn pg-banner--split" role="alert"><span class="pg-banner-msg">Client/server major version mismatch: pg_dump major ' + state.pgDumpMajor +
            ', pg_restore major ' + state.pgRestoreMajor + ', server major ' + state.serverMajor +
            '. Install PostgreSQL client tools matching the server major version.</span>' +
            '<button type="button" class="btn btn-secondary" data-backup-assist="version_banner">Ask SQL Assistant…</button></div>';
        }
        if (state.sshEnabled) {
          h += '<div class="pg-banner info pg-banner--split" role="status"><span class="pg-banner-msg">SSH: CLI tools use the same tunnel as the SQL driver (local port forward).</span>' +
            '<button type="button" class="btn btn-secondary" data-backup-assist="ssh_banner">Ask SQL Assistant…</button></div>';
        }
        b.innerHTML = h;
        renderSchemaFilterPanel();
        renderSchemaNsPickerList();
        renderTablePickerList();
        updateSchemaNsTriggerSummary();
        updateTableTriggerSummary();
        switchTab(state.initialTab || 'dump');
        refreshLogAssistVisibility();
      }
      if (message.type === 'pickedPath') {
        if (message.kind === 'save') document.getElementById('d_out').value = message.path;
        if (message.kind === 'open') document.getElementById('r_in').value = message.path;
        if (message.kind === 'dir') document.getElementById('d_out').value = message.path;
      }
      if (message.type === 'logChunk') {
        lastLog += message.chunk;
        document.getElementById('log').textContent = lastLog;
        refreshLogAssistVisibility();
      }
      if (message.type === 'runDone') {
        lastLog = message.log || lastLog;
        document.getElementById('log').textContent = lastLog;
        refreshLogAssistVisibility();
      }
      if (message.type === 'listResult') {
        const toc = document.getElementById('toc');
        const wrap = document.getElementById('tocWrap');
        toc.innerHTML = '';
        if (message.error) {
          wrap.style.display = 'block';
          toc.textContent = message.error + '\n' + (message.raw || '');
          return;
        }
        wrap.style.display = 'block';
        (message.rows || []).forEach((row, i) => {
          const id = 'toc_' + i;
          const lab = document.createElement('label');
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.checked = true;
          cb.dataset.line = row.rawLine;
          lab.appendChild(cb);
          lab.appendChild(document.createTextNode(row.kind + ' · ' + row.rawLine.slice(0, 120)));
          toc.appendChild(lab);
        });
      }
    });

    function switchTab(name) {
      document.querySelectorAll('.backup-tab').forEach(function(t) {
        var on = t.getAttribute('data-tab') === name;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('.backup-panel').forEach(function(p) {
        p.classList.toggle('is-visible', p.id === name);
      });
    }

    document.querySelectorAll('.backup-tab').forEach(function(t) {
      t.addEventListener('click', function() { switchTab(t.getAttribute('data-tab')); });
    });

    function backupLogLooksLikeFailure(log) {
      if (!log || !String(log).trim()) return false;
      var s = String(log);
      return /\b(ERROR|FATAL)\s*:/i.test(s) ||
        /:\s*error:/i.test(s) ||
        /\bpg_restore:\s*error/i.test(s) ||
        /\bpg_dump:\s*error/i.test(s) ||
        /\bpg_dumpall:\s*error/i.test(s) ||
        /\[\s*exit\s+[1-9]\d*\s*\]/i.test(s) ||
        /exited\s+with\s+code\s+[1-9]/i.test(s) ||
        /errors\s+ignored\s+on\s+restore/i.test(s);
    }

    function refreshLogAssistVisibility() {
      var btn = document.getElementById('nb_assist');
      if (!btn) return;
      btn.hidden = !backupLogLooksLikeFailure(lastLog);
    }

    var backupRoot = document.querySelector('.backup-root');
    if (backupRoot) {
      backupRoot.addEventListener('click', function(e) {
        var t = e.target;
        if (!t || !t.closest) return;
        var btn = t.closest('[data-backup-assist]');
        if (!btn) return;
        e.preventDefault();
        var scenario = btn.getAttribute('data-backup-assist') || 'tool_log';
        vscode.postMessage({ type: 'backupToolsAssist', payload: { scenario: scenario } });
      });
    }

    document.getElementById('d_browse_file').onclick = () => vscode.postMessage({ type: 'pickSaveFile', payload: { defaultName: (document.getElementById('d_db').value || 'db') + '_backup.dump' } });
    document.getElementById('d_browse_dir').onclick = () => vscode.postMessage({ type: 'pickDirectory' });
    document.getElementById('r_browse_in').onclick = () => vscode.postMessage({ type: 'pickOpenFile' });
    document.getElementById('a_browse').onclick = () => vscode.postMessage({ type: 'pickSaveFile', payload: { defaultName: 'dumpall.sql' } });

    var dSearch = document.getElementById('d_table_search');
    var snSearch = document.getElementById('d_sn_search');
    if (dSearch) dSearch.addEventListener('input', function() { renderTablePickerList(); });
    if (snSearch) snSearch.addEventListener('input', function() { renderSchemaNsPickerList(); });

    var snSelAll = document.getElementById('d_sn_select_all');
    var snSelShown = document.getElementById('d_sn_select_shown');
    var snClr = document.getElementById('d_sn_clear');
    if (snSelAll) snSelAll.addEventListener('click', function() {
      getSchemaChoices().forEach(function(s) { selectedSchemas.add(s); });
      renderSchemaNsPickerList();
      onDumpSchemasChanged();
    });
    if (snSelShown) snSelShown.addEventListener('click', function() {
      visibleSchemaRows().forEach(function(s) { selectedSchemas.add(s); });
      renderSchemaNsPickerList();
      onDumpSchemasChanged();
    });
    if (snClr) snClr.addEventListener('click', function() {
      selectedSchemas.clear();
      renderSchemaNsPickerList();
      onDumpSchemasChanged();
    });

    (function setupScopePickerDropdowns() {
      var snWrap = document.getElementById('d_sn_ms_wrap');
      var snBtn = document.getElementById('d_sn_btn');
      var tableWrap = document.getElementById('d_table_ms_wrap');
      var tableBtn = document.getElementById('d_table_btn');
      var allBtn = document.getElementById('d_sch_filter_all');

      if (snBtn && snWrap) {
        snBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          if (snBtn.disabled) return;
          setTablePickerOpen(false);
          setSnPickerOpen(!schemaNsPickerOpen);
          if (schemaNsPickerOpen) renderSchemaNsPickerList();
        });
      }

      if (tableBtn && tableWrap) {
        tableBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          setSnPickerOpen(false);
          setTablePickerOpen(!tablePickerOpen);
          if (tablePickerOpen) {
            renderSchemaFilterPanel();
            renderTablePickerList();
          }
        });
      }

      if (allBtn) {
        allBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          tableSchemaExclude.clear();
          renderSchemaFilterPanel();
          renderTablePickerList();
        });
      }

      document.addEventListener('mousedown', function(e) {
        if (snWrap && schemaNsPickerOpen && !snWrap.contains(e.target)) setSnPickerOpen(false);
        if (tableWrap && tablePickerOpen && !tableWrap.contains(e.target)) setTablePickerOpen(false);
      });
      document.addEventListener('keydown', function(e) {
        if (e.key !== 'Escape') return;
        if (schemaNsPickerOpen) setSnPickerOpen(false);
        if (tablePickerOpen) setTablePickerOpen(false);
      });
    })();

    document.getElementById('d_table_select_all').addEventListener('click', function() {
      tableChoicesForDump().forEach(function(row) { selectedTables.add(row.qualified); });
      renderTablePickerList();
    });
    var dTableSelShown = document.getElementById('d_table_select_shown');
    if (dTableSelShown) dTableSelShown.addEventListener('click', function() {
      visibleTableRows().forEach(function(row) { selectedTables.add(row.qualified); });
      renderTablePickerList();
    });
    document.getElementById('d_table_clear').addEventListener('click', function() {
      selectedTables.clear();
      renderTablePickerList();
    });

    function readExtraCli(id) {
      var el = document.getElementById(id);
      return el && el.value ? el.value : '';
    }

    document.getElementById('d_run').onclick = () => {
      lastLog = '';
      document.getElementById('log').textContent = '';
      refreshLogAssistVisibility();
      var selList = [];
      selectedTables.forEach(function(q) { selList.push(q); });
      selList.sort();
      var schemaSel = [];
      selectedSchemas.forEach(function(s) { schemaSel.push(s); });
      schemaSel.sort();
      vscode.postMessage({ type: 'runDump', payload: {
        format: document.getElementById('d_format').value,
        verbose: document.getElementById('d_verbose').checked,
        schemaOnly: document.getElementById('d_schema').checked,
        dataOnly: document.getElementById('d_data').checked,
        blobs: document.getElementById('d_blobs').checked,
        parallelJobs: parseInt(document.getElementById('d_jobs').value, 10) || 1,
        compression: parseInt(document.getElementById('d_z').value, 10),
        outputPath: document.getElementById('d_out').value,
        database: document.getElementById('d_db').value,
        tableQualifiedList: selList.length ? selList : undefined,
        schemaNameList: schemaSel.length ? schemaSel : undefined,
        extraCliArgs: readExtraCli('d_extra')
      }});
    };

    document.getElementById('r_run').onclick = () => {
      const lines = [];
      const boxes = document.querySelectorAll('#toc input[type=checkbox]');
      boxes.forEach(cb => {
        if (cb.checked && cb.dataset.line) lines.push(cb.dataset.line);
      });
      if (boxes.length > 0 && lines.length === 0) {
        alert('Select at least one archive object, or run Dry-run again after clearing selections.');
        return;
      }
      lastLog = '';
      document.getElementById('log').textContent = '';
      refreshLogAssistVisibility();
      vscode.postMessage({ type: 'runRestore', payload: {
        inputPath: document.getElementById('r_in').value,
        targetDatabase: document.getElementById('r_target').value,
        verbose: document.getElementById('r_verbose').checked,
        jobs: parseInt(document.getElementById('r_jobs').value, 10) || 1,
        selectedLines: lines.length ? lines : undefined,
        extraCliArgs: readExtraCli('r_extra')
      }});
    };

    document.getElementById('r_list').onclick = () => {
      vscode.postMessage({ type: 'listArchive', payload: {
        path: document.getElementById('r_in').value,
        extraCliArgs: readExtraCli('r_extra')
      }});
    };

    document.getElementById('a_run').onclick = () => {
      lastLog = '';
      document.getElementById('log').textContent = '';
      refreshLogAssistVisibility();
      vscode.postMessage({ type: 'runDumpall', payload: {
        verbose: document.getElementById('a_verbose').checked,
        globalsOnly: document.getElementById('a_globals').checked,
        rolesOnly: document.getElementById('a_roles').checked,
        outputPath: document.getElementById('a_out').value,
        extraCliArgs: readExtraCli('a_extra')
      }});
    };

    document.getElementById('nb_append').onclick = () => {
      vscode.postMessage({ type: 'appendNotebook', payload: { title: 'Backup / restore log', log: lastLog } });
    };

    var nbAssist = document.getElementById('nb_assist');
    if (nbAssist) {
      nbAssist.addEventListener('click', function() {
        vscode.postMessage({ type: 'backupToolsAssist', payload: { scenario: 'tool_log', logText: lastLog } });
      });
    }

    document.getElementById('nb_cancel').onclick = () => vscode.postMessage({ type: 'cancel' });

    document.getElementById('d_task').onclick = () => vscode.postMessage({ type: 'generateTask', payload: {
      format: document.getElementById('d_format').value,
      database: document.getElementById('d_db').value,
      outputPath: document.getElementById('d_out').value || ('\u0024{workspaceFolder}/backup.dump')
    }});

    (function setupBackupLogPanelChrome() {
      var vscodeApi = vscode;
      var wrap = document.getElementById('backup_log_wrap');
      var handle = document.getElementById('backup_log_resize');
      var toggleBtn = document.getElementById('backup_log_toggle');
      var header = document.getElementById('backup_log_header');
      var MIN_LOG_H = 120;
      var DEFAULT_LOG_H = 240;

      function clampHeight(px) {
        var maxH = Math.min(Math.floor(window.innerHeight * 0.72), Math.max(MIN_LOG_H, window.innerHeight - 96));
        return Math.max(MIN_LOG_H, Math.min(maxH, Math.round(px)));
      }

      function applySavedLogLayout() {
        if (!wrap) return;
        var st = vscodeApi.getState() || {};
        var h = typeof st.logPanelHeight === 'number' ? st.logPanelHeight : DEFAULT_LOG_H;
        wrap.style.setProperty('--backup-log-height', clampHeight(h) + 'px');
        if (st.logCollapsed) {
          wrap.classList.add('is-collapsed');
          if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
        }
      }

      applySavedLogLayout();

      function toggleLogCollapsed() {
        if (!wrap) return;
        var collapsed = wrap.classList.toggle('is-collapsed');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { logCollapsed: collapsed }));
      }

      if (toggleBtn) {
        toggleBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          toggleLogCollapsed();
        });
      }
      if (header) {
        header.addEventListener('click', function() {
          toggleLogCollapsed();
        });
      }

      var dragActive = false;
      var startY = 0;
      var startH = 0;

      function endDrag() {
        if (!dragActive) return;
        dragActive = false;
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', endDrag);
        if (wrap && !wrap.classList.contains('is-collapsed')) {
          vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, {
            logPanelHeight: Math.round(wrap.getBoundingClientRect().height)
          }));
        }
      }

      function onDragMove(e) {
        if (!dragActive || !wrap) return;
        var dy = startY - e.clientY;
        var nh = clampHeight(startH + dy);
        wrap.style.setProperty('--backup-log-height', nh + 'px');
      }

      if (handle && wrap) {
        handle.addEventListener('mousedown', function(e) {
          if (wrap.classList.contains('is-collapsed')) return;
          e.preventDefault();
          dragActive = true;
          startY = e.clientY;
          startH = wrap.getBoundingClientRect().height;
          document.body.style.cursor = 'ns-resize';
          document.addEventListener('mousemove', onDragMove);
          document.addEventListener('mouseup', endDrag);
        });
        handle.addEventListener('keydown', function(e) {
          if (wrap.classList.contains('is-collapsed')) return;
          var step = e.shiftKey ? 28 : 14;
          var cur = wrap.getBoundingClientRect().height;
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            var up = clampHeight(cur + step);
            wrap.style.setProperty('--backup-log-height', up + 'px');
            vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { logPanelHeight: up }));
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            var down = clampHeight(cur - step);
            wrap.style.setProperty('--backup-log-height', down + 'px');
            vscodeApi.setState(Object.assign({}, vscodeApi.getState() || {}, { logPanelHeight: down }));
          }
        });
      }

      window.addEventListener('resize', function() {
        if (!wrap || wrap.classList.contains('is-collapsed')) return;
        var cur = wrap.getBoundingClientRect().height;
        var capped = clampHeight(cur);
        if (capped !== cur) {
          wrap.style.setProperty('--backup-log-height', capped + 'px');
        }
      });
    })();
