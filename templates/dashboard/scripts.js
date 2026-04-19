const vscode = acquireVsCodeApi();

const style = getComputedStyle(document.body);
const colors = {
  text: style.getPropertyValue('--fg-color').trim(),
  muted: style.getPropertyValue('--muted-color').trim(),
  accent: style.getPropertyValue('--accent-color').trim(),
  success: '#4ade80',
  warning: '#facc15',
  danger: '#f87171',
  grid: 'rgba(128, 128, 128, 0.1)'
};

Chart.defaults.color = colors.muted;
Chart.defaults.borderColor = colors.grid;
Chart.defaults.font.family = 'var(--font-family)';

const commonOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false }, tooltip: { enabled: true, mode: 'index', intersect: false } },
  scales: {
    x: { display: false },
    y: { display: true, min: 0, grid: { color: colors.grid, borderDash: [2, 2] }, ticks: { maxTicksLimit: 4 } }
  },
  elements: { point: { radius: 0, hitRadius: 10 }, line: { tension: 0.3, borderWidth: 2 } }
};

const sparklineOptions = {
  ...commonOptions,
  plugins: { legend: { display: false }, tooltip: { enabled: false } },
  scales: { x: { display: false }, y: { display: false } },
  elements: { point: { radius: 0 }, line: { borderWidth: 1.5 } }
};

const HARD_HISTORY_LIMIT = 720;
let refreshIntervalMs = 15000;
let historyMinutes = 15;
let refreshIntervalId;
let expandedQueryPid = null;
let selectedPidFilter = null;

const timeLabels = [];
const tpsHistory = [];
const connActiveHistory = [];
const connIdleHistory = [];
const waitMarkerHistory = [];
const rollbackHistory = [];
const cacheHitHistory = [];
const longRunningHistory = [];
const checkpointReqHistory = [];
const checkpointTimedHistory = [];
const tempFilesHistory = [];
const tuplesFetchedHistory = [];
const tuplesReturnedHistory = [];
const activeSessionHistory = [];
const connCapacityHistory = [];

const kpiHistory = {
  locks: [],
  activeLoad: [],
  issues: []
};

const lockEventsHistory = [];
const schemaHealthHistory = {
  unusedIndexes: [],
  highSeqScanTables: [],
  deadTuplePressureTables: [],
  vacuumAttentionTables: []
};

let activeQueriesCache = [];
let blockingPids = new Set();
let waitingPids = new Set();

const statsElement = document.getElementById('dashboard-stats');
let initialStats = null;
if (statsElement && statsElement.textContent) {
  try {
    initialStats = JSON.parse(statsElement.textContent);
  } catch (error) {
    console.error('Dashboard: Failed to parse initial stats', error);
  }
}

let lastMetrics = {
  timestamp: Date.now(),
  xact_commit: initialStats?.metrics?.xact_commit ?? 0,
  xact_rollback: initialStats?.metrics?.xact_rollback ?? 0,
  blks_read: initialStats?.metrics?.blks_read ?? 0,
  blks_hit: initialStats?.metrics?.blks_hit ?? 0,
  checkpoints_timed: initialStats?.metrics?.checkpoints_timed ?? 0,
  checkpoints_req: initialStats?.metrics?.checkpoints_req ?? 0,
  temp_bytes: initialStats?.metrics?.temp_bytes ?? 0,
  tuples_fetched: initialStats?.metrics?.tuples_fetched ?? 0,
  tuples_returned: initialStats?.metrics?.tuples_returned ?? 0,
  tps: 0
};

function pushWithLimit(list, value) {
  list.push(value);
  if (list.length > HARD_HISTORY_LIMIT) list.shift();
}

function visiblePoints() {
  const points = Math.ceil((historyMinutes * 60 * 1000) / Math.max(refreshIntervalMs || 15000, 5000));
  return Math.max(12, Math.min(HARD_HISTORY_LIMIT, points));
}

function getVisible(series) {
  return series.slice(-visiblePoints());
}

function formatTimeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function bytesTick(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const base = 1024;
  const index = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(numeric) / Math.log(base))));
  const scaled = numeric / Math.pow(base, index);
  const rounded = scaled < 10 ? scaled.toFixed(1) : Math.round(scaled).toString();
  return `${rounded} ${units[index] || 'B'}`;
}

function formatSeconds(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function waitEventInterpretation(waitType) {
  const map = {
    Client: 'Client waits usually indicate sessions waiting on application response or connection pool pressure.',
    Lock: 'Lock waits indicate contention between concurrent transactions.',
    IO: 'I/O waits can indicate storage latency or heavy disk-bound operations.',
    BufferPin: 'Buffer pin waits usually indicate concurrent scans/DDL conflicts on shared buffers.',
    Activity: 'Activity waits are often background process housekeeping.'
  };
  return map[waitType] || 'Inspect session activity and waits to identify root cause.';
}

function updateKpiDelta(historyKey, currentValue, targetId) {
  if (!kpiHistory[historyKey]) return;
  pushWithLimit(kpiHistory[historyKey], Number(currentValue) || 0);
  const el = document.getElementById(targetId);
  if (!el) return;

  const history = kpiHistory[historyKey];
  if (history.length < 2) {
    el.textContent = '';
    return;
  }

  const prev = history[Math.max(0, history.length - 2)];
  const delta = (Number(currentValue) || 0) - prev;
  el.classList.remove('up', 'down');
  if (delta === 0) {
    el.textContent = '→ 0';
    el.style.color = 'var(--muted-color)';
  } else {
    const lowerIsBetter = new Set(['locks', 'issues', 'activeLoad']);
    const improving = lowerIsBetter.has(historyKey) ? delta < 0 : delta > 0;
    el.textContent = `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)}`;
    el.style.color = improving ? 'var(--success-color)' : 'var(--warning-color)';
    el.classList.add(delta > 0 ? 'up' : 'down');
  }
}

function activateTab(tabName) {
  const tab = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (tab) tab.click();
}

const tpsChart = new Chart(document.getElementById('tpsSparkline'), {
  type: 'line',
  data: { labels: [], datasets: [{ data: [], borderColor: colors.text, fill: false, tension: 0.1, pointRadius: 0 }] },
  options: sparklineOptions
});

const connChart = new Chart(document.getElementById('connectionsHistoryChart'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'Active', data: [], borderColor: colors.success, backgroundColor: 'rgba(74, 222, 128, 0.1)', fill: true },
      { label: 'Idle', data: [], borderColor: colors.muted, backgroundColor: 'rgba(128, 128, 128, 0.06)', fill: true },
      { label: 'Waiting Event', data: [], borderColor: colors.warning, backgroundColor: colors.warning, pointRadius: 3, pointHoverRadius: 5, showLine: false },
      { label: 'Max Connections', data: [], yAxisID: 'y2', borderColor: 'rgba(148, 163, 184, 0.55)', borderDash: [5, 5], fill: false, pointRadius: 0, tension: 0 }
    ]
  },
  options: {
    ...commonOptions,
    scales: {
      x: { display: false },
      y: { stacked: true, min: 0, max: 10, grid: { color: colors.grid } },
      y2: {
        position: 'right',
        min: 0,
        max: 100,
        grid: { drawOnChartArea: false },
        ticks: { maxTicksLimit: 3 }
      }
    },
    plugins: {
      legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 8, usePointStyle: true } },
      tooltip: {
        enabled: true,
        mode: 'index',
        intersect: false,
        callbacks: {
          title: items => items?.[0]?.label || ''
        }
      }
    }
  }
});

const rollbackChart = new Chart(document.getElementById('rollbackChart'), {
  type: 'line',
  data: { labels: [], datasets: [{ label: 'Rollbacks/s', data: [], borderColor: colors.danger, backgroundColor: 'rgba(248, 113, 113, 0.1)', fill: true, tension: 0.2 }] },
  options: { ...commonOptions, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, min: 0 } } }
});

const cacheHitChart = new Chart(document.getElementById('cacheHitChart'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'Hit Ratio', data: [], borderColor: colors.accent, fill: false, tension: 0.2 },
      { label: '100% reference', data: [], borderColor: 'rgba(128, 128, 128, 0.6)', borderDash: [5, 5], fill: false, pointRadius: 0 }
    ]
  },
  options: {
    ...commonOptions,
    plugins: {
      ...commonOptions.plugins,
      tooltip: {
        ...commonOptions.plugins.tooltip,
        callbacks: {
          label: item => `${item.dataset.label}: ${Number(item.parsed.y || 0).toFixed(1)}%`
        }
      }
    },
    scales: {
      x: { display: false },
      y: {
        display: true,
        min: 0,
        max: 100,
        ticks: { stepSize: 20, callback: value => `${value}%` },
        grid: { color: colors.grid }
      }
    }
  }
});

const cacheBandPlugin = {
  id: 'cacheBandPlugin',
  beforeDraw(chart) {
    if (!chart?.chartArea || chart.canvas.id !== 'cacheHitChart') return;
    const { ctx, chartArea, scales } = chart;
    const y = scales.y;
    if (!y) return;

    const y95 = y.getPixelForValue(95);
    const y90 = y.getPixelForValue(90);
    const y0 = y.getPixelForValue(0);

    ctx.save();
    ctx.fillStyle = 'rgba(74, 222, 128, 0.08)';
    ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, y95 - chartArea.top);
    ctx.fillStyle = 'rgba(250, 204, 21, 0.09)';
    ctx.fillRect(chartArea.left, y95, chartArea.right - chartArea.left, y90 - y95);
    ctx.fillStyle = 'rgba(248, 113, 113, 0.08)';
    ctx.fillRect(chartArea.left, y90, chartArea.right - chartArea.left, y0 - y90);
    ctx.restore();
  }
};

Chart.register(cacheBandPlugin);

const longRunningChart = new Chart(document.getElementById('longRunningChart'), {
  type: 'line',
  data: { labels: [], datasets: [{ label: 'Queries > 5s', data: [], borderColor: colors.warning, backgroundColor: 'rgba(250, 204, 21, 0.1)', fill: true, stepped: true }] },
  options: { ...commonOptions, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, min: 0 } } }
});

const checkpointsChart = new Chart(document.getElementById('checkpointsChart'), {
  type: 'line',
  data: { labels: [], datasets: [{ label: 'Timed', data: [], borderColor: colors.success, fill: false }, { label: 'Requested', data: [], borderColor: colors.danger, fill: false }] },
  options: commonOptions
});

const tempFilesChart = new Chart(document.getElementById('tempFilesChart'), {
  type: 'line',
  data: { labels: [], datasets: [{ label: 'Temp Bytes', data: [], borderColor: colors.warning, fill: true, backgroundColor: 'rgba(250, 204, 21, 0.1)' }] },
  options: {
    ...commonOptions,
    scales: {
      ...commonOptions.scales,
      y: { display: true, min: 0, grid: { color: colors.grid }, ticks: { callback: value => bytesTick(value) } }
    }
  }
});

const tuplesChart = new Chart(document.getElementById('tuplesChart'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      { label: 'Fetched', data: [], borderColor: colors.text, borderDash: [2, 2], fill: false },
      { label: 'Returned', data: [], borderColor: colors.accent, fill: false }
    ]
  },
  options: {
    ...commonOptions,
    plugins: {
      ...commonOptions.plugins,
      tooltip: {
        ...commonOptions.plugins.tooltip,
        callbacks: {
          label: item => `${item.dataset.label}: ${Number(item.parsed.y || 0).toLocaleString()}`,
          footer: items => {
            const i = items?.[0]?.dataIndex;
            if (i === undefined) return '';
            const sessions = getVisible(activeSessionHistory)[i] || 0;
            return `${sessions} active session(s) at this time`;
          }
        }
      }
    }
  }
});

function applyChartWindows() {
  const labels = getVisible(timeLabels);

  tpsChart.data.labels = labels;
  tpsChart.data.datasets[0].data = getVisible(tpsHistory);

  connChart.data.labels = labels;
  connChart.data.datasets[0].data = getVisible(connActiveHistory);
  connChart.data.datasets[1].data = getVisible(connIdleHistory);
  connChart.data.datasets[2].data = getVisible(waitMarkerHistory);
  connChart.data.datasets[3].data = getVisible(connCapacityHistory);

  const maxConnections = Math.max(...getVisible(connCapacityHistory), 1);
  const activeMax = Math.max(...getVisible(connActiveHistory), 0);
  const idleMax = Math.max(...getVisible(connIdleHistory), 0);
  const softMax = Math.max(5, Math.ceil(Math.max(activeMax + idleMax, activeMax) * 1.5), Math.ceil(maxConnections * 0.1));
  connChart.options.scales.y.max = softMax;
  connChart.options.scales.y2.max = maxConnections;

  const usage = activeMax / maxConnections;
  if (usage > 0.9) connChart.data.datasets[0].borderColor = colors.danger;
  else if (usage > 0.7) connChart.data.datasets[0].borderColor = colors.warning;
  else connChart.data.datasets[0].borderColor = colors.success;

  const connNote = document.getElementById('connections-note');
  if (connNote) {
    connNote.textContent = `Auto-scale window: 0-${softMax} sessions • Capacity max: ${maxConnections}`;
  }

  rollbackChart.data.labels = labels;
  rollbackChart.data.datasets[0].data = getVisible(rollbackHistory);

  const visibleCache = getVisible(cacheHitHistory);
  cacheHitChart.data.labels = labels;
  cacheHitChart.data.datasets[0].data = visibleCache;
  cacheHitChart.data.datasets[1].data = new Array(visibleCache.length).fill(100);

  longRunningChart.data.labels = labels;
  longRunningChart.data.datasets[0].data = getVisible(longRunningHistory);

  checkpointsChart.data.labels = labels;
  checkpointsChart.data.datasets[0].data = getVisible(checkpointTimedHistory);
  checkpointsChart.data.datasets[1].data = getVisible(checkpointReqHistory);

  tempFilesChart.data.labels = labels;
  tempFilesChart.data.datasets[0].data = getVisible(tempFilesHistory);

  tuplesChart.data.labels = labels;
  tuplesChart.data.datasets[0].data = getVisible(tuplesFetchedHistory);
  tuplesChart.data.datasets[1].data = getVisible(tuplesReturnedHistory);

  [tpsChart, connChart, rollbackChart, cacheHitChart, longRunningChart, checkpointsChart, tempFilesChart, tuplesChart].forEach(chart => chart.update('none'));
}

function startAutoRefresh(interval) {
  if (refreshIntervalId) clearInterval(refreshIntervalId);
  if (interval > 0) {
    refreshIntervalId = setInterval(() => manualRefresh(), interval);
  }
}

function initializeDashboard(stats) {
  if (!stats) return;
  document.getElementById('db-name').innerText = stats.dbName;
  document.getElementById('db-owner').innerText = stats.owner;
  document.getElementById('db-size').innerText = stats.size;
  updateObjectCounts(stats.objectCounts);
}

function updateObjectCounts(counts) {
  if (!counts) return;
  document.getElementById('count-tables').innerText = `${counts.tables} Tables`;
  document.getElementById('count-views').innerText = `${counts.views} Views`;
  document.getElementById('count-funcs').innerText = `${counts.functions} Funcs`;
}

function setCardSeverity(id, severity) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('sev-ok', 'sev-warn', 'sev-crit');
  el.classList.add(severity === 'crit' ? 'sev-crit' : severity === 'warn' ? 'sev-warn' : 'sev-ok');
}

function parseDurationSeconds(duration) {
  if (!duration) return 0;
  if (duration.includes('day')) {
    const dayMatch = duration.match(/(\d+)\s+day/);
    const dayCount = dayMatch ? Number(dayMatch[1]) : 0;
    const timePart = duration.split(' ').pop();
    const [h, m, s] = (timePart || '00:00:00').split(':').map(Number);
    return dayCount * 86400 + (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
  }
  const [h, m, s] = duration.split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightSql(sql) {
  const escaped = escapeHtml(sql);
  return escaped.replace(/\b(SELECT|FROM|WHERE|GROUP BY|ORDER BY|JOIN|LEFT JOIN|RIGHT JOIN|INNER JOIN|OUTER JOIN|LIMIT|OFFSET|INSERT|UPDATE|DELETE|WITH|AS|AND|OR|ON|IN|EXISTS|DISTINCT|COUNT|SUM|AVG|MAX|MIN)\b/gi, '<span class="sql-kw">$1</span>');
}

function buildStatePill(query, isWaiting) {
  const state = (query.state || 'unknown').toLowerCase();
  const pill = document.createElement('span');
  pill.className = 'state-pill';
  if (isWaiting || query.waitEventType) {
    pill.classList.add('state-waiting');
    pill.textContent = 'waiting';
  } else if (state === 'active') {
    pill.classList.add('state-active');
    pill.textContent = 'active';
  } else if (state === 'idle in transaction') {
    pill.classList.add('state-idle-in-transaction');
    pill.textContent = 'idle in transaction';
  } else if (state === 'idle') {
    pill.classList.add('state-idle');
    pill.textContent = 'idle';
  } else {
    pill.classList.add('state-idle');
    pill.textContent = state;
  }
  return pill;
}

function updateDashboard(stats) {
  const now = Date.now();
  const timeDiff = Math.max((now - lastMetrics.timestamp) / 1000, 1);

  updateObjectCounts(stats.objectCounts);
  document.getElementById('db-size').innerText = stats.size;

  const commits = stats.metrics.xact_commit - lastMetrics.xact_commit;
  const rollbacks = stats.metrics.xact_rollback - lastMetrics.xact_rollback;

  const tps = Math.max(0, Math.round((commits + rollbacks) / timeDiff));
  const rollbackRate = Math.max(0, Math.round(rollbacks / timeDiff));
  const sharedCacheHitRatioRaw = Number(stats.sharedCacheHitRatio);
  const sharedCacheHitRatio = Number.isFinite(sharedCacheHitRatioRaw)
    ? Math.min(100, Math.max(0, sharedCacheHitRatioRaw))
    : null;

  pushWithLimit(timeLabels, formatTimeLabel(now));
  pushWithLimit(tpsHistory, tps);
  pushWithLimit(connActiveHistory, Math.max(0, stats.activeConnections || 0));
  pushWithLimit(connIdleHistory, Math.max(0, stats.idleConnections || 0));
  pushWithLimit(waitMarkerHistory, (stats.waitingConnections || 0) > 0 ? Math.max(0, stats.activeConnections || 0) : null);
  pushWithLimit(connCapacityHistory, Math.max(1, stats.maxConnections || 100));
  const incomingActiveSessions = (stats.activeQueries || []).filter(query => (query.state || '').toLowerCase() === 'active').length;
  pushWithLimit(activeSessionHistory, incomingActiveSessions);
  pushWithLimit(rollbackHistory, rollbackRate);
  pushWithLimit(cacheHitHistory, sharedCacheHitRatio);
  pushWithLimit(longRunningHistory, Math.max(0, stats.longRunningQueries || 0));

  const cpTimed = Math.max(0, (stats.metrics.checkpoints_timed || 0) - (lastMetrics.checkpoints_timed || 0));
  const cpReq = Math.max(0, (stats.metrics.checkpoints_req || 0) - (lastMetrics.checkpoints_req || 0));
  pushWithLimit(checkpointTimedHistory, cpTimed);
  pushWithLimit(checkpointReqHistory, cpReq);

  const tempBytesDelta = Math.max(0, (stats.metrics.temp_bytes || 0) - (lastMetrics.temp_bytes || 0));
  pushWithLimit(tempFilesHistory, tempBytesDelta);

  const tupFetched = Math.max(0, (stats.metrics.tuples_fetched || 0) - (lastMetrics.tuples_fetched || 0));
  const tupReturned = Math.max(0, (stats.metrics.tuples_returned || 0) - (lastMetrics.tuples_returned || 0));
  pushWithLimit(tuplesFetchedHistory, tupFetched);
  pushWithLimit(tuplesReturnedHistory, tupReturned);

  applyChartWindows();

  const tpsEl = document.getElementById('tps-value');
  if (tpsEl) tpsEl.innerText = String(tps);

  const deltaEl = document.getElementById('tps-delta');
  if (deltaEl && lastMetrics.tps > 0) {
    const delta = tps - lastMetrics.tps;
    const pct = Math.round((delta / Math.max(lastMetrics.tps, 1)) * 100);
    if (delta === 0) {
      deltaEl.innerText = '-';
      deltaEl.style.color = 'var(--muted-color)';
    } else {
      deltaEl.innerText = `${delta > 0 ? '↑' : '↓'} ${Math.abs(pct)}%`;
      deltaEl.style.color = 'var(--muted-color)';
    }
  } else if (deltaEl) {
    deltaEl.innerText = '';
  }

  updateLocks(stats.blockingLocks || []);
  updateHealth(stats);
  updateActiveLoad(stats);
  updateIssues(stats);
  updateActiveQueries(stats.activeQueries || []);
  updateIdleInTransactionTable(stats.activeQueries || []);
  updateOverviewSignals(stats);
  updatePerformanceInsights(stats);
  updateWalReplication(stats);
  updateConnectionsByApp(stats.connectionsByApp || []);
  updateSchemaHealth(stats);

  updateKpiDelta('locks', (stats.blockingLocks || []).length, 'locks-delta');

  const tpsCard = document.getElementById('tps-card');
  if (tpsCard) {
    tpsCard.title = tps === 0
      ? (blockingPids.size > 0 ? 'Throughput stalled due to blocking locks' : 'No transaction activity')
      : 'Transactions per second';
  }

  lastMetrics = {
    timestamp: now,
    xact_commit: stats.metrics.xact_commit,
    xact_rollback: stats.metrics.xact_rollback,
    blks_read: stats.metrics.blks_read,
    blks_hit: stats.metrics.blks_hit,
    checkpoints_timed: stats.metrics.checkpoints_timed,
    checkpoints_req: stats.metrics.checkpoints_req,
    temp_bytes: stats.metrics.temp_bytes,
    tuples_fetched: stats.metrics.tuples_fetched,
    tuples_returned: stats.metrics.tuples_returned,
    tps
  };
}

function updateActiveLoad(stats) {
  const el = document.getElementById('active-load-value');
  if (el) {
    el.innerHTML = '';
    const num = document.createTextNode(`${stats.activeConnections || 0} `);
    const span = document.createElement('span');
    span.style.fontSize = '0.8em';
    span.style.color = 'var(--muted-color)';
    span.style.fontWeight = '400';
    span.textContent = `/ ${stats.maxConnections || 0}`;
    el.appendChild(num);
    el.appendChild(span);
  }

  const idleInTxCount = activeQueriesCache.filter(q => (q.state || '').toLowerCase() === 'idle in transaction').length;
  const sub = document.getElementById('active-load-sub');
  if (sub) {
    sub.innerHTML = '';
    if ((stats.waitingConnections || 0) > 0) {
      const waiting = document.createElement('span');
      waiting.className = 'badge-pill badge-crit';
      waiting.textContent = `${stats.waitingConnections} waiting`;
      sub.appendChild(waiting);
    }
    if (idleInTxCount > 0) {
      const idle = document.createElement('span');
      idle.className = 'badge-pill badge-warn';
      idle.textContent = `${idleInTxCount} idle in tx`;
      sub.appendChild(idle);
    }
    if ((stats.waitingConnections || 0) === 0 && idleInTxCount === 0) {
      sub.textContent = 'No waits';
    }
  }

  if ((stats.waitingConnections || 0) > 0) setCardSeverity('tile-active-load', 'crit');
  else if (idleInTxCount > 0) setCardSeverity('tile-active-load', 'warn');
  else setCardSeverity('tile-active-load', 'ok');

  updateKpiDelta('activeLoad', Number(stats.activeConnections || 0), 'active-load-delta');
}

function updateIssues(stats) {
  const container = document.getElementById('issues-card-content');
  const label = document.getElementById('issues-label');
  if (!container || !label) return;

  container.innerHTML = '';
  if (stats.waitEvents && stats.waitEvents.length > 0) {
    label.innerText = 'Top Wait Events';
    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '4px';
    wrapper.style.marginTop = '8px';
    stats.waitEvents.forEach(wait => {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.fontSize = '0.85em';

      const typeEl = document.createElement('span');
      const waitType = wait.type || '';
      typeEl.textContent = waitType;
      typeEl.title = waitEventInterpretation(waitType);
      const countEl = document.createElement('span');
      countEl.style.color = 'var(--muted-color)';
      countEl.textContent = String(wait.count || 0);

      row.appendChild(typeEl);
      row.appendChild(countEl);
      wrapper.appendChild(row);
    });
    container.appendChild(wrapper);

    const topType = stats.waitEvents[0]?.type;
    if (topType) {
      const note = document.createElement('div');
      note.className = 'chart-note';
      note.style.marginTop = '8px';
      note.textContent = waitEventInterpretation(topType);
      container.appendChild(note);
    }

    setCardSeverity('tile-issues', 'warn');
    const totalWaits = stats.waitEvents.reduce((sum, wait) => sum + Number(wait.count || 0), 0);
    updateKpiDelta('issues', totalWaits, 'issues-delta');
    return;
  }

  label.innerText = 'Issues';
  const issues = (stats.metrics.deadlocks || 0) + (stats.metrics.conflicts || 0);
  const valueEl = document.createElement('div');
  valueEl.className = 'value';
  valueEl.textContent = String(issues);

  const detail = document.createElement('div');
  detail.style.fontSize = '0.8rem';
  detail.style.color = 'var(--muted-color)';
  detail.textContent = `${stats.metrics.deadlocks || 0} deadlocks`;

  container.appendChild(valueEl);
  container.appendChild(detail);
  setCardSeverity('tile-issues', issues > 0 ? 'warn' : 'ok');
  updateKpiDelta('issues', issues, 'issues-delta');
}

function updateHealth(stats) {
  const healthDot = document.getElementById('health-dot');
  const healthText = document.getElementById('health-text');
  const healthReason = document.getElementById('health-reason');
  const healthCard = document.getElementById('tile-health');
  const idleBadge = document.getElementById('idle-in-tx-badge');

  const connUsage = (stats.activeConnections || 0) / Math.max(stats.maxConnections || 100, 1);
  const hasBlocks = (stats.blockingLocks || []).length > 0;
  const hasWaiting = (stats.waitingConnections || 0) > 0;
  const hasLong = (stats.longRunningQueries || 0) > 0;
  const idleInTx = activeQueriesCache.filter(q => (q.state || '').toLowerCase() === 'idle in transaction').length;

  let severity = 'ok';
  if (hasBlocks || connUsage > 0.9) severity = 'crit';
  else if (hasWaiting || hasLong || idleInTx > 0 || connUsage > 0.7) severity = 'warn';

  if (healthDot) {
    healthDot.className = `status-dot ${severity === 'crit' ? 'status-crit' : severity === 'warn' ? 'status-warn' : 'status-ok'}`;
  }
  if (healthText) {
    healthText.textContent = severity === 'crit' ? 'Critical' : severity === 'warn' ? 'Degraded' : 'Healthy';
  }

  const waitingQuery = activeQueriesCache.find(q => waitingPids.has(q.pid) || q.waitEventType);
  if (healthReason) {
    if (hasWaiting && waitingQuery) {
      healthReason.innerHTML = `Degraded - ${stats.waitingConnections} query waiting on lock (<a href="#" data-action="filterPid" data-pid="${waitingQuery.pid}">PID ${waitingQuery.pid}</a>)`;
    } else if (hasBlocks && stats.blockingLocks?.[0]?.blocking_pid) {
      const pid = stats.blockingLocks[0].blocking_pid;
      healthReason.innerHTML = `Blocking lock chain detected (<a href="#" data-action="filterPid" data-pid="${pid}">PID ${pid}</a>)`;
    } else if (idleInTx > 0) {
      healthReason.textContent = `Degraded - ${idleInTx} session(s) idle in transaction`;
    } else {
      healthReason.textContent = 'No incidents detected';
    }
  }

  if (idleBadge) {
    if (idleInTx > 0) {
      idleBadge.style.display = 'inline-block';
      idleBadge.className = 'badge-pill badge-warn';
      idleBadge.textContent = `Idle in transaction: ${idleInTx}`;
    } else {
      idleBadge.style.display = 'none';
    }
  }

  if (healthCard) {
    const tips = [];
    if (connUsage > 0.7) tips.push(`High connection usage (${Math.round(connUsage * 100)}%)`);
    if (hasBlocks) tips.push(`${stats.blockingLocks.length} blocking locks`);
    if (hasWaiting) tips.push(`${stats.waitingConnections} waiting`);
    if (hasLong) tips.push(`${stats.longRunningQueries} long-running`);
    if (idleInTx > 0) tips.push(`${idleInTx} idle in transaction`);
    healthCard.title = tips.length > 0 ? tips.join(' · ') : 'No issues detected';
  }

  setCardSeverity('tile-health', severity);
  updateRecommendedAction(stats, hasBlocks);
}

function updateWalReplication(stats) {
  const w = stats.walReplication;
  const roleEl = document.getElementById('wal-role-chip');
  const lsnEl = document.getElementById('wal-lsn-summary');
  const chipBox = document.getElementById('wal-settings-chips');
  const replBody = document.querySelector('#wal-repl-table tbody');
  const recvBody = document.querySelector('#wal-receiver-table tbody');
  const slotsBody = document.querySelector('#wal-slots-table tbody');
  const pgNote = document.getElementById('wal-pgstat-note');
  const pgPre = document.getElementById('wal-pgstat-pre');

  if (!w) {
    if (roleEl) roleEl.textContent = 'WAL: —';
    return;
  }

  if (roleEl) {
    roleEl.textContent = w.inRecovery ? 'Role: standby' : 'Role: primary';
    roleEl.classList.toggle('warn', w.inRecovery);
  }

  if (lsnEl) {
    if (!w.inRecovery && w.currentWalLsn) {
      lsnEl.textContent = `Current WAL: ${w.currentWalLsn}`;
    } else if (w.inRecovery) {
      const lag =
        w.replayLagBytes != null && Number.isFinite(w.replayLagBytes)
          ? ` · replay delta ${bytesTick(w.replayLagBytes)}`
          : '';
      lsnEl.textContent = `Receive ${w.receiveLsn || '—'} · Replay ${w.replayLsn || '—'}${lag}`;
    } else {
      lsnEl.textContent = 'WAL LSN: —';
    }
  }

  if (chipBox) {
    chipBox.innerHTML = '';
    ['wal_level', 'max_wal_size', 'min_wal_size', 'archive_mode', 'synchronous_standby_names'].forEach((k) => {
      const val = w.settings && w.settings[k];
      if (val === undefined || val === '') return;
      const span = document.createElement('span');
      span.className = 'signal-chip';
      const display = String(val).length > 80 ? `${String(val).slice(0, 77)}…` : String(val);
      span.textContent = `${k}: ${display}`;
      span.title = `${k}: ${val}`;
      chipBox.appendChild(span);
    });
  }

  if (replBody) {
    replBody.innerHTML = '';
    const rows = Array.isArray(w.replicas) ? w.replicas : [];
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.style.padding = '16px';
      td.style.color = 'var(--muted-color)';
      td.textContent = w.inRecovery
        ? 'Not available on standby (pg_stat_replication is empty here).'
        : 'No active replication connections.';
      tr.appendChild(td);
      replBody.appendChild(tr);
    } else {
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        [r.application_name || '—', r.client_addr || '—', r.state || '—', r.replay_lag || '—', r.sync_state || '—', r.replay_lsn || '—'].forEach((cell) => {
          const td = document.createElement('td');
          td.textContent = cell;
          tr.appendChild(td);
        });
        replBody.appendChild(tr);
      });
    }
  }

  if (recvBody) {
    recvBody.innerHTML = '';
    const wr = w.walReceiver;
    if (!wr || (!wr.status && !wr.received_lsn)) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.style.padding = '16px';
      td.style.color = 'var(--muted-color)';
      td.textContent = w.inRecovery ? 'No walreceiver row (check replication link).' : 'WAL receiver is only populated on standbys.';
      tr.appendChild(td);
      recvBody.appendChild(tr);
    } else {
      const tr = document.createElement('tr');
      [wr.status || '—', wr.received_lsn || '—', `${wr.sender_host || '—'}:${wr.sender_port ?? '—'}`, wr.last_msg_receipt_time || '—'].forEach((cell) => {
        const td = document.createElement('td');
        td.textContent = cell;
        tr.appendChild(td);
      });
      recvBody.appendChild(tr);
    }
  }

  if (slotsBody) {
    slotsBody.innerHTML = '';
    const slots = Array.isArray(w.replicationSlots) ? w.replicationSlots : [];
    if (slots.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.style.padding = '16px';
      td.style.color = 'var(--muted-color)';
      td.textContent = 'No replication slots.';
      tr.appendChild(td);
      slotsBody.appendChild(tr);
    } else {
      slots.forEach((s) => {
        const tr = document.createElement('tr');
        [s.slot_name, s.slot_type || '—', s.active ? 'yes' : 'no', s.wal_status || '—', s.restart_lsn || '—'].forEach((cell) => {
          const td = document.createElement('td');
          td.textContent = cell;
          tr.appendChild(td);
        });
        slotsBody.appendChild(tr);
      });
    }
  }

  if (pgPre && pgNote) {
    if (w.pgStatWal && typeof w.pgStatWal === 'object') {
      pgNote.textContent = 'Cluster-wide WAL generator stats (since stats_reset).';
      const o = w.pgStatWal;
      const lines = Object.keys(o)
        .sort()
        .map((k) => `${k}: ${o[k]}`);
      pgPre.textContent = lines.join('\n');
    } else {
      pgNote.textContent = 'pg_stat_wal not available (requires PostgreSQL 15+, or insufficient privileges).';
      pgPre.textContent = '';
    }
  }
}

function updateOverviewSignals(stats) {
  const indexChip = document.getElementById('signal-index-hit');
  const txChip = document.getElementById('signal-oldest-tx');
  const vacuumChip = document.getElementById('signal-vacuum');

  if (indexChip) {
    const parsedRatio = Number(stats.indexHitRatio);
    const ratio = Number.isFinite(parsedRatio) ? parsedRatio : 100;
    indexChip.textContent = `Index Hit: ${ratio.toFixed(1)}%`;
    indexChip.classList.remove('warn', 'crit');
    if (ratio < 90) indexChip.classList.add('crit');
    else if (ratio < 95) indexChip.classList.add('warn');
  }

  if (txChip) {
    const age = Number(stats.oldestTransactionAgeSeconds || 0);
    txChip.textContent = `Oldest Tx: ${formatSeconds(age)}`;
    txChip.classList.remove('warn', 'crit');
    if (age > 300) txChip.classList.add('crit');
    else if (age > 120) txChip.classList.add('warn');
  }

  if (vacuumChip) {
    const tables = Number(stats.vacuumTablesNeedingAttention || 0);
    vacuumChip.textContent = `Vacuum Attention: ${tables}`;
    vacuumChip.classList.remove('warn', 'crit');
    if (tables > 5) vacuumChip.classList.add('crit');
    else if (tables > 0) vacuumChip.classList.add('warn');
  }
}

function updatePerformanceInsights(stats) {
  const indexValue = document.getElementById('perf-index-hit-value');
  const indexNote = document.getElementById('perf-index-hit-note');
  const topSqlList = document.getElementById('perf-top-sql-list');

  const parsedRatio = Number(stats.indexHitRatio);
  const ratio = Number.isFinite(parsedRatio) ? parsedRatio : 100;
  if (indexValue) {
    indexValue.textContent = `${ratio.toFixed(1)}%`;
    indexValue.style.color = ratio < 90 ? 'var(--danger-color)' : ratio < 95 ? 'var(--warning-color)' : 'var(--success-color)';
  }
  if (indexNote) {
    if (ratio < 90) indexNote.textContent = 'Low index block cache reuse. Validate indexes, execution plans, and memory settings.';
    else if (ratio < 95) indexNote.textContent = 'Moderate index block cache reuse. Check hottest read paths and index coverage.';
    else indexNote.textContent = 'Healthy index block cache reuse for indexed access patterns.';
  }

  if (!topSqlList) return;
  topSqlList.innerHTML = '';
  const statements = Array.isArray(stats.pgStatStatements) ? stats.pgStatStatements : [];
  const preview = statements
    .slice()
    .sort((a, b) => Number(b.total_time || 0) - Number(a.total_time || 0))
    .slice(0, 5);

  if (preview.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chart-note';
    empty.textContent = 'No statement timing data. Enable pg_stat_statements to view top SQL by total time.';
    topSqlList.appendChild(empty);
    return;
  }

  preview.forEach(statement => {
    const item = document.createElement('div');
    item.className = 'top-sql-item';

    const sqlLine = document.createElement('div');
    sqlLine.className = 'sql-line';
    const normalized = String(statement.query || '').replace(/\s+/g, ' ').trim();
    sqlLine.textContent = normalized || '(empty query text)';

    const sqlMeta = document.createElement('div');
    sqlMeta.className = 'sql-meta';
    const totalMs = Number(statement.total_time || 0);
    const calls = Number(statement.calls || 0);
    const meanMs = Number(statement.mean_time || 0);
    sqlMeta.textContent = `${totalMs.toFixed(1)} ms total • ${calls} calls • ${meanMs.toFixed(2)} ms avg`;

    item.appendChild(sqlLine);
    item.appendChild(sqlMeta);
    topSqlList.appendChild(item);
  });
}

function setActiveQueryFilter(pid) {
  selectedPidFilter = pid ? Number(pid) : null;
  expandedQueryPid = selectedPidFilter;
  activateTab('activity');
  updateActiveQueries(activeQueriesCache);
  jumpToQueries();
}

function clearActiveQueryFilter() {
  selectedPidFilter = null;
  updateActiveQueries(activeQueriesCache);
}

function renderActivityFocusState() {
  const pill = document.getElementById('activity-focus-pill');
  const clearBtn = document.getElementById('activity-focus-clear');
  if (!pill || !clearBtn) return;

  if (!selectedPidFilter) {
    pill.style.display = 'none';
    clearBtn.style.display = 'none';
    pill.textContent = '';
    return;
  }

  const exists = activeQueriesCache.some(query => Number(query.pid) === Number(selectedPidFilter));
  pill.style.display = 'inline-block';
  clearBtn.style.display = 'inline-block';
  pill.classList.remove('warn');
  pill.classList.remove('crit');
  if (!exists) {
    pill.classList.add('warn');
    pill.textContent = `Focused PID ${selectedPidFilter} (not currently active)`;
  } else {
    pill.textContent = `Focused PID ${selectedPidFilter}`;
  }
}

function updateActiveQueries(queries) {
  activeQueriesCache = Array.isArray(queries) ? queries : [];
  const tbody = document.querySelector('#active-queries-table tbody');
  if (!tbody) return;
  renderActivityFocusState();

  tbody.innerHTML = '';
  if (activeQueriesCache.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.setAttribute('colspan', '7');
    td.style.textAlign = 'center';
    td.style.padding = '24px';
    td.style.color = 'var(--muted-color)';
    td.textContent = 'No session activity found';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  activeQueriesCache.forEach(query => {
    const seconds = parseDurationSeconds(query.duration || '');
    let rowClass = '';
    if (seconds > 30) rowClass = 'row-crit';
    else if (seconds >= 5) rowClass = 'row-warn';

    const isBlocker = blockingPids.has(query.pid);
    const isWaiting = waitingPids.has(query.pid) || Boolean(query.waitEventType);
    const durationClass = seconds > 30 ? 'duration-crit' : seconds >= 5 ? 'duration-warn' : 'duration-ok';

    const tr = document.createElement('tr');
    if (rowClass) tr.className = rowClass;
    if (selectedPidFilter && Number(query.pid) === Number(selectedPidFilter)) {
      tr.classList.add('row-focus');
    }

    const pidTd = document.createElement('td');
    pidTd.className = 'mono';
    if (isBlocker) {
      pidTd.style.color = 'var(--danger-color)';
      pidTd.style.fontWeight = '700';
      pidTd.title = 'This process is blocking other queries';
      pidTd.textContent = `🔒 ${query.pid}`;
    } else if (isWaiting) {
      pidTd.style.color = 'var(--warning-color)';
      pidTd.style.fontWeight = '600';
      pidTd.title = 'This process is waiting';
      pidTd.textContent = `⏳ ${query.pid}`;
    } else {
      pidTd.textContent = String(query.pid);
    }
    tr.appendChild(pidTd);

    const userTd = document.createElement('td');
    userTd.textContent = query.usename || '';
    tr.appendChild(userTd);

    const stateTd = document.createElement('td');
    stateTd.appendChild(buildStatePill(query, isWaiting));
    tr.appendChild(stateTd);

    const durationTd = document.createElement('td');
    durationTd.className = `mono ${durationClass}`;
    durationTd.style.fontWeight = '600';
    durationTd.textContent = query.duration || '';
    tr.appendChild(durationTd);

    const startTd = document.createElement('td');
    startTd.style.fontSize = '0.85em';
    startTd.style.color = 'var(--muted-color)';
    startTd.textContent = query.startTime || '-';
    tr.appendChild(startTd);

    const queryTd = document.createElement('td');
    queryTd.className = 'mono query-cell';
    queryTd.setAttribute('data-action', 'toggleQuery');
    queryTd.setAttribute('data-pid', String(query.pid));
    queryTd.title = 'Click to expand full SQL';
    const queryPreview = document.createElement('div');
    queryPreview.className = 'query-preview';
    const shortQuery = (query.query || '').trim().replace(/\s+/g, ' ');
    queryPreview.textContent = shortQuery.length > 140 ? `${shortQuery.slice(0, 140)}...` : shortQuery;
    queryTd.appendChild(queryPreview);
    tr.appendChild(queryTd);

    const actionsTd = document.createElement('td');
    const actionsDiv = document.createElement('div');
    actionsDiv.style.display = 'flex';
    actionsDiv.style.gap = '4px';
    actionsDiv.style.justifyContent = 'flex-end';

    const b64Query = btoa(unescape(encodeURIComponent(query.query || '')));

    const explainBtn = document.createElement('button');
    explainBtn.className = 'btn-action';
    explainBtn.setAttribute('data-action', 'explain');
    explainBtn.setAttribute('data-query', b64Query);
    explainBtn.textContent = 'Explain';
    actionsDiv.appendChild(explainBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-action btn-warn';
    cancelBtn.setAttribute('data-action', 'cancel');
    cancelBtn.setAttribute('data-pid', String(query.pid));
    cancelBtn.textContent = 'Cancel';
    actionsDiv.appendChild(cancelBtn);

    const killBtn = document.createElement('button');
    killBtn.className = 'btn-action btn-danger';
    killBtn.setAttribute('data-action', 'terminate');
    killBtn.setAttribute('data-pid', String(query.pid));
    killBtn.textContent = 'Kill';
    actionsDiv.appendChild(killBtn);

    actionsTd.appendChild(actionsDiv);
    tr.appendChild(actionsTd);
    tbody.appendChild(tr);

    if (expandedQueryPid === query.pid) {
      const expandedTr = document.createElement('tr');
      expandedTr.className = 'expanded-query-row';
      const expandedTd = document.createElement('td');
      expandedTd.colSpan = 7;
      const pre = document.createElement('pre');
      pre.className = 'mono expanded-query';
      pre.innerHTML = highlightSql(query.query || '');
      expandedTd.appendChild(pre);
      expandedTr.appendChild(expandedTd);
      tbody.appendChild(expandedTr);
    }
  });
}

function updateIdleInTransactionTable(queries) {
  const tbody = document.querySelector('#idle-in-tx-table tbody');
  if (!tbody) return;

  const idleInTx = (queries || []).filter(query => (query.state || '').toLowerCase() === 'idle in transaction');
  tbody.innerHTML = '';

  if (idleInTx.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7;
    td.style.textAlign = 'center';
    td.style.padding = '16px';
    td.style.color = 'var(--muted-color)';
    td.textContent = 'No idle-in-transaction sessions.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  idleInTx.forEach(query => {
    const tr = document.createElement('tr');
    tr.className = 'row-warn';

    const pidTd = document.createElement('td');
    pidTd.className = 'mono';
    pidTd.textContent = String(query.pid);
    tr.appendChild(pidTd);

    const userTd = document.createElement('td');
    userTd.textContent = query.usename || '';
    tr.appendChild(userTd);

    const stateTd = document.createElement('td');
    stateTd.appendChild(buildStatePill(query, false));
    tr.appendChild(stateTd);

    const txStartTd = document.createElement('td');
    txStartTd.style.fontSize = '0.85em';
    txStartTd.style.color = 'var(--muted-color)';
    txStartTd.textContent = query.xactStart || '-';
    tr.appendChild(txStartTd);

    const durationTd = document.createElement('td');
    durationTd.className = 'mono duration-warn';
    durationTd.textContent = query.duration || '';
    tr.appendChild(durationTd);

    const queryTd = document.createElement('td');
    queryTd.className = 'mono';
    const shortQuery = (query.query || '').trim().replace(/\s+/g, ' ');
    queryTd.textContent = shortQuery.length > 140 ? `${shortQuery.slice(0, 140)}...` : shortQuery;
    tr.appendChild(queryTd);

    const actionsTd = document.createElement('td');
    actionsTd.style.textAlign = 'right';
    const killBtn = document.createElement('button');
    killBtn.className = 'btn-action btn-danger';
    killBtn.setAttribute('data-action', 'terminate');
    killBtn.setAttribute('data-pid', String(query.pid));
    killBtn.textContent = 'Kill';
    actionsTd.appendChild(killBtn);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });
}

function updateLocks(locks) {
  blockingPids.clear();
  waitingPids.clear();
  if (locks && locks.length > 0) {
    locks.forEach(lock => {
      blockingPids.add(lock.blocking_pid);
      waitingPids.add(lock.blocked_pid);
    });
  }

  const tileVal = document.getElementById('locks-tile-value');
  if (tileVal) {
    tileVal.textContent = String((locks || []).length);
  }
  setCardSeverity('tile-locks', (locks || []).length > 0 ? 'crit' : 'ok');
  if ((locks || []).length > 0) {
    pushWithLimit(lockEventsHistory, {
      ts: Date.now(),
      at: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      count: locks.length
    });
  }
  renderLockTree(locks || []);
}

function renderLockTree(locks) {
  const container = document.getElementById('locks-tree-container');
  const emptyState = document.getElementById('locks-empty-state');
  const recentEvents = document.getElementById('locks-recent-events');
  const chainSummary = document.getElementById('locks-chain-summary');

  if (!locks || locks.length === 0) {
    if (container) container.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    if (chainSummary) chainSummary.style.display = 'none';
    if (recentEvents) {
      if (lockEventsHistory.length > 0) {
        const latest = lockEventsHistory[lockEventsHistory.length - 1];
        const cleanFor = latest && latest.ts ? formatSeconds(Math.max(0, Math.floor((Date.now() - latest.ts) / 1000))) : 'recently';
        const recent = lockEventsHistory.slice(-3).reverse().map(event => `${event.at}: ${event.count} blocking lock(s)`).join(' · ');
        recentEvents.style.display = 'block';
        recentEvents.textContent = `No active blocking locks. Clean for ${cleanFor}. Last events: ${recent}`;
      } else {
        recentEvents.style.display = 'block';
        recentEvents.textContent = 'Last lock event: never detected this session.';
      }
    }
    return;
  }

  if (emptyState) emptyState.style.display = 'none';
  if (!container) return;
  if (recentEvents) recentEvents.style.display = 'none';

  container.innerHTML = '';

  const nodes = new Set();
  const relations = [];

  locks.forEach(l => {
    nodes.add(l.blocking_pid);
    nodes.add(l.blocked_pid);
    relations.push({
      parent: l.blocking_pid,
      child: l.blocked_pid,
      info: l
    });
  });

  const children = new Set(relations.map(r => r.child));
  const roots = Array.from(nodes).filter(n => !children.has(n));

  if (chainSummary) {
    const chainLines = relations.map(relation => {
      const blockerQ = (relation.info.blocking_query || '').trim().replace(/\s+/g, ' ').slice(0, 72);
      const blockedQ = (relation.info.blocked_query || '').trim().replace(/\s+/g, ' ').slice(0, 72);
      return `PID ${relation.child} (${blockedQ || '...'}) <-blocked by- PID ${relation.parent} (${blockerQ || '...'})`;
    });
    chainSummary.style.display = 'block';
    chainSummary.textContent = chainLines.join('\n');
  }

  // If no roots and we have nodes -> Cycle. Pick one.
  if (roots.length === 0 && nodes.size > 0) {
    roots.push(Array.from(nodes)[0]);
  }

  const createNode = (pid, visited) => {
    const div = document.createElement('div');
    div.className = 'lock-node';

    if (visited.has(pid)) {
      const cyc = document.createElement('div');
      cyc.textContent = '🔄 Cycle detected: PID ' + pid;
      div.appendChild(cyc);
      return div;
    }
    visited.add(pid);

    const myRelations = relations.filter(r => r.parent === pid);

    let user = 'Unknown';
    let query = 'Unknown';

    const asBlocker = relations.find(r => r.parent === pid);
    const asBlocked = relations.find(r => r.child === pid);

    if (asBlocker) {
      user = asBlocker.info.blocking_user;
      query = asBlocker.info.blocking_query;
    } else if (asBlocked) {
      user = asBlocked.info.blocked_user;
      query = asBlocked.info.blocked_query;
    }

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    const left = document.createElement('div');
    const pidSpan = document.createElement('span');
    pidSpan.className = 'mono';
    pidSpan.style.fontWeight = 'bold';
    if (asBlocker) pidSpan.style.color = 'var(--danger-color)';
    pidSpan.textContent = 'PID ' + pid;

    const userSpan = document.createElement('span');
    userSpan.style.marginLeft = '8px';
    userSpan.style.color = 'var(--muted-color)';
    userSpan.textContent = user || '';

    left.appendChild(pidSpan);
    left.appendChild(userSpan);

    const right = document.createElement('div');
    if (asBlocked) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = asBlocked.info.lock_mode || '';
      right.appendChild(badge);
    } else {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.style.background = 'var(--success-color)';
      badge.style.color = 'black';
      badge.textContent = 'Root';
      right.appendChild(badge);
    }

    header.appendChild(left);
    header.appendChild(right);
    div.appendChild(header);

    const queryDiv = document.createElement('div');
    queryDiv.className = 'mono';
    queryDiv.style.fontSize = '0.85em';
    queryDiv.style.marginTop = '4px';
    queryDiv.style.opacity = '0.8';
    queryDiv.style.whiteSpace = 'nowrap';
    queryDiv.style.overflow = 'hidden';
    queryDiv.style.textOverflow = 'ellipsis';
    queryDiv.textContent = query || '(No query info)';
    div.appendChild(queryDiv);

    if (asBlocked) {
      const waitingDiv = document.createElement('div');
      waitingDiv.style.fontSize = '0.8em';
      waitingDiv.style.marginTop = '4px';
      waitingDiv.style.color = 'var(--muted-color)';
      waitingDiv.textContent = 'Waiting for: ' + (asBlocked.info.locked_object || '');
      div.appendChild(waitingDiv);
    }

    const actions = document.createElement('div');
    actions.style.marginTop = '8px';
    actions.style.display = 'flex';
    actions.style.gap = '8px';

    const killBtn = document.createElement('button');
    killBtn.className = 'btn-action btn-danger';
    killBtn.setAttribute('data-action', 'terminate');
    killBtn.setAttribute('data-pid', String(pid));
    killBtn.textContent = 'Kill Session';
    actions.appendChild(killBtn);

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-action';
    cancelBtn.setAttribute('data-action', 'cancel');
    cancelBtn.setAttribute('data-pid', String(pid));
    cancelBtn.textContent = 'Cancel Query';
    actions.appendChild(cancelBtn);

    div.appendChild(actions);

    if (myRelations.length > 0) {
      const childContainer = document.createElement('div');
      childContainer.className = 'lock-children';
      myRelations.forEach(r => {
        childContainer.appendChild(createNode(r.child, new Set(visited)));
      });
      div.appendChild(childContainer);
    }

    return div;
  };

  roots.forEach(rootPid => {
    container.appendChild(createNode(rootPid, new Set()));
  });
}

function updateRecommendedAction(stats, hasBlocks) {
  const actionContainer = document.getElementById('recommended-action');

  if (!hasBlocks || !stats.blockingLocks || stats.blockingLocks.length === 0) {
    if (actionContainer) actionContainer.style.display = 'none';
    return;
  }

  const blockerPid = stats.blockingLocks[0].blocking_pid;
  if (actionContainer) {
    actionContainer.style.display = 'block';
    actionContainer.innerHTML = '';
    const span = document.createElement('span');
    span.style.cursor = 'pointer';
    span.setAttribute('data-action', 'terminate');
    span.setAttribute('data-pid', String(blockerPid));
    span.textContent = '💡 Recommended: Kill blocker PID ' + String(blockerPid);
    actionContainer.appendChild(span);
  }
}

function showDetails(type) {
  vscode.postMessage({ command: 'showDetails', type });
}

function hideDetails() {
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('main-view').style.display = 'block';
}

function renderDetailsView(type, data, columns) {
  const titleMap = {
    tables: 'Tables',
    views: 'Views',
    functions: 'Functions',
    pgStatStatements: 'Top SQL (pg_stat_statements)'
  };
  const title = titleMap[type] || (type.charAt(0).toUpperCase() + type.slice(1));
  document.getElementById('detail-title').innerText = title;

  const container = document.getElementById('detail-content');
  if (!container) return;
  container.innerHTML = '';

  const wrapper = document.createElement('div');
  wrapper.className = 'table-container';

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headTr = document.createElement('tr');
  columns.forEach(c => {
    const th = document.createElement('th');
    th.textContent = c;
    headTr.appendChild(th);
  });
  thead.appendChild(headTr);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  if (!data || data.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.setAttribute('colspan', String(columns.length));
    td.style.textAlign = 'center';
    td.style.color = 'var(--muted-color)';
    td.style.padding = '24px';
    td.textContent = 'No items found';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    data.forEach(row => {
      const tr = document.createElement('tr');
      if (type === 'pgStatStatements') {
        const tdQuery = document.createElement('td');
        tdQuery.className = 'mono';
        tdQuery.style.maxWidth = '640px';
        tdQuery.style.whiteSpace = 'pre-wrap';
        tdQuery.textContent = row && row.query != null ? String(row.query) : '';
        tr.appendChild(tdQuery);

        const appendCell = val => {
          const td = document.createElement('td');
          td.textContent = val != null ? String(val) : '';
          tr.appendChild(td);
        };

        appendCell(row && row.calls);
        appendCell(row && row.total_time);
        appendCell(row && row.mean_time);
        appendCell(row && row.rows);
      } else {
        const tdName = document.createElement('td');
        tdName.className = 'mono';
        tdName.textContent = row && row.name != null ? String(row.name) : '';
        tr.appendChild(tdName);

        if (type === 'tables') {
          const tdSize = document.createElement('td');
          tdSize.textContent = row && row.size != null ? String(row.size) : '';
          tr.appendChild(tdSize);
        }
        if (type === 'views') {
          const tdOwner = document.createElement('td');
          tdOwner.textContent = row && row.owner != null ? String(row.owner) : '';
          tr.appendChild(tdOwner);
        }
        if (type === 'functions') {
          const tdLang = document.createElement('td');
          tdLang.textContent = row && row.language != null ? String(row.language) : '';
          tr.appendChild(tdLang);
        }
      }
      tbody.appendChild(tr);
    });
  }

  table.appendChild(tbody);
  wrapper.appendChild(table);
  container.appendChild(wrapper);

  document.getElementById('main-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  window.scrollTo(0, 0);
}

function manualRefresh() { vscode.postMessage({ command: 'refresh' }); }
function explainQuery(b64Query) { vscode.postMessage({ command: 'explainQuery', query: decodeURIComponent(escape(atob(b64Query))) }); }
function cancelQuery(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid)) return;
  vscode.postMessage({ command: 'cancelQuery', pid: numericPid });
}
function terminateQuery(pid) {
  const numericPid = Number(pid);
  if (!Number.isFinite(numericPid)) return;
  vscode.postMessage({ command: 'terminateQuery', pid: numericPid });
}
function jumpToQueries() {
  const el = document.getElementById('active-queries-table');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}
function jumpToLocks() {
  const el = document.getElementById('locks-tree-container');
  if (el) el.scrollIntoView({ behavior: 'smooth' });
}

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action], [id^="count-"], #tps-card, .interactive, .back-link, .btn-action');
  if (!target) return;

  const action = target.getAttribute('data-action');
  if (action) {
    event.preventDefault();
    if (action === 'explain') explainQuery(target.getAttribute('data-query'));
    else if (action === 'cancel') cancelQuery(target.getAttribute('data-pid'));
    else if (action === 'terminate') terminateQuery(target.getAttribute('data-pid'));
    else if (action === 'toggleQuery') {
      const pid = Number(target.getAttribute('data-pid'));
      expandedQueryPid = expandedQueryPid === pid ? null : pid;
      updateActiveQueries(activeQueriesCache);
    }
    else if (action === 'filterPid') setActiveQueryFilter(target.getAttribute('data-pid'));
    else if (action === 'clearPidFilter') clearActiveQueryFilter();
    else if (action === 'refresh') manualRefresh();
    else if (action === 'showDetails') showDetails(target.getAttribute('data-type'));
    else if (action === 'hideDetails') hideDetails();
    else if (action === 'jumpToQueries') jumpToQueries();
    else if (action === 'jumpToLocks') jumpToLocks();
    return;
  }

  // Handle Static IDs/Classes (Legacy support if we missed data-actions)
  if (target.id === 'count-tables') { event.preventDefault(); showDetails('tables'); }
  else if (target.id === 'count-views') { event.preventDefault(); showDetails('views'); }
  else if (target.id === 'count-funcs') { event.preventDefault(); showDetails('functions'); }
  else if (target.classList.contains('back-link')) { event.preventDefault(); hideDetails(); }
});

window.addEventListener('message', event => {
  const message = event.data;
  switch (message.command) {
    case 'updateStats':
      updateDashboard(message.stats);
      break;
    case 'showDetails':
      renderDetailsView(message.type, message.data, message.columns);
      break;
    case 'aiLoading':
      renderAiLoading(message.loading);
      break;
    case 'aiResponse':
      renderAiResponse(message.text);
      break;
    case 'queryForAIResult':
      _handleQueryResult(message);
      break;
  }
});

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));

    t.classList.add('active');
    const tabId = t.getAttribute('data-tab');
    document.getElementById('tab-' + tabId).classList.add('active');

    if (tabId === 'overview' || tabId === 'activity' || tabId === 'performance') {
      [tpsChart, connChart, rollbackChart, cacheHitChart, longRunningChart, checkpointsChart, tempFilesChart, tuplesChart].forEach(chart => chart.resize());
    }
  };
});

const refreshSelect = document.getElementById('refresh-interval');
if (refreshSelect) {
  refreshSelect.value = String(refreshIntervalMs);
  refreshSelect.addEventListener('change', event => {
    refreshIntervalMs = Number(event.target.value);
    startAutoRefresh(refreshIntervalMs);
    applyChartWindows();
  });
}

const rangeSelect = document.getElementById('history-range');
if (rangeSelect) {
  rangeSelect.value = String(historyMinutes);
  rangeSelect.addEventListener('change', event => {
    historyMinutes = Number(event.target.value) || 15;
    applyChartWindows();
  });
}

startAutoRefresh(refreshIntervalMs);

initializeDashboard(initialStats);
if (initialStats) {
  updateDashboard(initialStats);
}

// ── Shared helpers ───────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Connection Analytics ─────────────────────────────────────────────

function updateConnectionsByApp(connectionsByApp) {
  const tbody = document.querySelector('#connections-by-app-table tbody');
  if (!tbody) return;

  if (!connectionsByApp.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--muted-color);padding:20px;">No connection data.</td></tr>';
    return;
  }

  const byApp = {};
  for (const row of connectionsByApp) {
    if (!byApp[row.application_name]) {
      byApp[row.application_name] = { active: 0, idle: 0, waiting: 0, other: 0 };
    }
    if (row.waiting) {
      byApp[row.application_name].waiting += row.count;
      continue;
    }
    const st = (row.state || '').toLowerCase();
    if (st === 'active') byApp[row.application_name].active += row.count;
    else if (st === 'idle') byApp[row.application_name].idle += row.count;
    else if (st === 'idle in transaction (aborted)') byApp[row.application_name].waiting += row.count;
    else byApp[row.application_name].other += row.count;
  }

  const entries = Object.entries(byApp).sort((a, b) => {
    const totalA = a[1].active + a[1].idle + a[1].waiting + a[1].other;
    const totalB = b[1].active + b[1].idle + b[1].waiting + b[1].other;
    return totalB - totalA;
  });

  tbody.innerHTML = entries.map(([app, counts]) => {
    const total = counts.active + counts.idle + counts.waiting + counts.other;
    const activeW = total > 0 ? Math.round((counts.active / total) * 100) : 0;
    const idleW = total > 0 ? Math.round((counts.idle / total) * 100) : 0;
    const waitW = 100 - activeW - idleW;
    return `<tr>
      <td style="font-weight:500;">${escHtml(app)}</td>
      <td style="text-align:right;color:var(--success-color);">${counts.active || 0}</td>
      <td style="text-align:right;color:var(--muted-color);">${counts.idle || 0}</td>
      <td style="text-align:right;color:var(--warning-color);">${counts.waiting || 0}</td>
      <td style="text-align:right;font-weight:600;">${total}</td>
      <td>
        <div class="conn-app-bar">
          ${activeW > 0 ? `<div class="conn-bar-active" style="flex:${activeW}" title="Active: ${counts.active}"></div>` : ''}
          ${idleW > 0 ? `<div class="conn-bar-idle" style="flex:${idleW}" title="Idle: ${counts.idle}"></div>` : ''}
          ${waitW > 0 ? `<div class="conn-bar-waiting" style="flex:${Math.max(waitW,0)}" title="Waiting: ${counts.waiting}"></div>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

// ── Schema Health Tab ────────────────────────────────────────────────

function updateSchemaHealth(stats) {
  pushWithLimit(schemaHealthHistory.unusedIndexes, (stats.unusedIndexes || []).length);
  pushWithLimit(schemaHealthHistory.highSeqScanTables, (stats.highSeqScanTables || []).length);
  pushWithLimit(schemaHealthHistory.deadTuplePressureTables, (stats.tableBloat || []).length);
  pushWithLimit(schemaHealthHistory.vacuumAttentionTables, (stats.tablesNeedingVacuum || []).length);
  updateSchemaHealthTrendNote();

  renderUnusedIndexes(stats.unusedIndexes || []);
  renderHighSeqScan(stats.highSeqScanTables || []);
  renderTableBloat(stats.tableBloat || []);
  renderAutovacuumProgress(stats.autovacuumProgress || []);
  renderTablesNeedingVacuum(stats.tablesNeedingVacuum || []);
}

function updateSchemaHealthTrendNote() {
  const note = document.getElementById('schema-health-note');
  if (!note) return;

  const delta = (arr) => {
    if (!arr || arr.length < 2) return 0;
    return Number(arr[arr.length - 1] || 0) - Number(arr[arr.length - 2] || 0);
  };

  const unusedDelta = delta(schemaHealthHistory.unusedIndexes);
  const seqDelta = delta(schemaHealthHistory.highSeqScanTables);
  const deadDelta = delta(schemaHealthHistory.deadTuplePressureTables);
  const vacuumDelta = delta(schemaHealthHistory.vacuumAttentionTables);

  note.textContent = `Trend: unused indexes ${unusedDelta >= 0 ? '+' : ''}${unusedDelta}, high seq-scan tables ${seqDelta >= 0 ? '+' : ''}${seqDelta}, dead-tuple pressure tables ${deadDelta >= 0 ? '+' : ''}${deadDelta}, vacuum-attention tables ${vacuumDelta >= 0 ? '+' : ''}${vacuumDelta}`;
}

function renderUnusedIndexes(indexes) {
  const tbody = document.querySelector('#unused-indexes-table tbody');
  if (!tbody) return;
  if (!indexes.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--success-color);padding:20px;">No non-constraint unused indexes detected.</td></tr>';
    return;
  }
  tbody.innerHTML = indexes.map(idx => {
    const rawMb = idx.raw_size / (1024 * 1024);
    const sev = rawMb > 50 ? 'crit' : rawMb > 10 ? 'warn' : 'ok';
    const badge = `<span class="schema-badge ${sev}">${sev === 'crit' ? 'Large' : sev === 'warn' ? 'Medium' : 'Small'}</span>`;
    return `<tr class="${sev !== 'ok' ? 'row-' + sev : ''}">
      <td class="mono" style="font-size:11px;">${escHtml(idx.index_name)}</td>
      <td>${escHtml(idx.table_name)}</td>
      <td style="text-align:right;">${escHtml(idx.index_size)}</td>
      <td style="text-align:center;">${badge}</td>
    </tr>`;
  }).join('');
}

function renderHighSeqScan(tables) {
  const tbody = document.querySelector('#high-seq-scan-table tbody');
  if (!tbody) return;
  if (!tables.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--success-color);padding:20px;">No high sequential scan tables detected.</td></tr>';
    return;
  }
  tbody.innerHTML = tables.map(t => {
    const pct = Number(t.seq_scan_pct || 0);
    const cls = pct > 80 ? 'row-crit' : pct > 50 ? 'row-warn' : '';
    const color = pct > 80 ? 'var(--danger-color)' : pct > 50 ? 'var(--warning-color)' : 'var(--fg-color)';
    return `<tr class="${cls}">
      <td>${escHtml(t.table_name)}</td>
      <td style="text-align:right;">${(t.seq_scan||0).toLocaleString()}</td>
      <td style="text-align:right;">${(t.idx_scan||0).toLocaleString()}</td>
      <td style="text-align:right;font-weight:600;color:${color};">${pct.toFixed(1)}%</td>
      <td style="text-align:right;">${(t.row_count||0).toLocaleString()}</td>
    </tr>`;
  }).join('');
}

function renderTableBloat(tables) {
  const tbody = document.querySelector('#table-bloat-table tbody');
  if (!tbody) return;
  if (!tables.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--success-color);padding:20px;">No significant dead-tuple pressure detected.</td></tr>';
    return;
  }
  tbody.innerHTML = tables.map(t => {
    const pct = Number(t.bloat_pct || 0);
    const cls = pct > 20 ? 'crit' : pct > 10 ? 'warn' : '';
    const rowCls = cls ? 'row-' + cls : '';
    const barW = Math.min(80, Math.round(pct));
    const barCls = cls ? ' ' + cls : '';
    return `<tr class="${rowCls}">
      <td>${escHtml(t.table_name)}</td>
      <td style="text-align:right;">${(t.n_live_tup||0).toLocaleString()}</td>
      <td style="text-align:right;">${(t.n_dead_tup||0).toLocaleString()}</td>
      <td style="text-align:right;">
        <span style="font-weight:600;">${pct.toFixed(1)}%</span>
        <div class="bloat-bar${barCls}" style="width:${barW}px;"></div>
      </td>
      <td style="text-align:right;">${escHtml(t.table_size || '-')}</td>
      <td style="text-align:center;">
        ${cls ? `<span class="schema-badge ${cls}">VACUUM</span>` : '<span class="schema-badge ok">OK</span>'}
      </td>
    </tr>`;
  }).join('');
}

function renderAutovacuumProgress(workers) {
  const tbody = document.querySelector('#autovacuum-progress-table tbody');
  if (!tbody) return;
  if (!workers.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--muted-color);padding:20px;">No autovacuum workers currently running.</td></tr>';
    return;
  }
  tbody.innerHTML = workers.map(w => {
    const total = w.heap_blks_total || 1;
    const scanned = w.heap_blks_scanned || 0;
    const pct = Math.min(100, Math.round((scanned / total) * 100));
    return `<tr>
      <td>${w.pid}</td>
      <td class="mono" style="font-size:11px;">${escHtml(w.table_name || '-')}</td>
      <td>${escHtml(w.phase || '-')}</td>
      <td>
        <div class="vacuum-progress-bar">
          <div class="vacuum-progress-fill" style="width:${pct}%"></div>
        </div>
        <span style="font-size:10px;color:var(--muted-color);">${pct}% (${scanned.toLocaleString()}/${total.toLocaleString()} blocks)</span>
      </td>
    </tr>`;
  }).join('');
}

function renderTablesNeedingVacuum(tables) {
  const tbody = document.querySelector('#tables-needing-vacuum-table tbody');
  if (!tbody) return;
  if (!tables.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--success-color);padding:20px;">No tables exceed autovacuum vacuum thresholds.</td></tr>';
    return;
  }
  tbody.innerHTML = tables.map(t => {
    const dead = t.n_dead_tup || 0;
    const threshold = t.dead_tuple_threshold || 0;
    const cls = dead > 10000 ? 'row-crit' : dead > 2000 ? 'row-warn' : '';
    const lastVac = t.last_autovacuum ? new Date(t.last_autovacuum).toLocaleString() : 'Never';
    const lastAna = t.last_autoanalyze ? new Date(t.last_autoanalyze).toLocaleString() : 'Never';
    return `<tr class="${cls}">
      <td>${escHtml(t.table_name)}</td>
      <td style="text-align:right;font-weight:600;">${dead.toLocaleString()}</td>
      <td style="text-align:right;color:var(--muted-color);">${threshold.toLocaleString()}</td>
      <td style="font-size:11px;color:var(--muted-color);">${lastVac}</td>
      <td style="font-size:11px;color:var(--muted-color);">${lastAna}</td>
    </tr>`;
  }).join('');
}

// ── AI Panel ──────────────────────────────────────────────────────────

let currentStats = null;

const aiPanel = document.getElementById('ai-panel');
const aiToggleBtn = document.getElementById('ai-toggle-btn');
const aiCloseBtn = document.getElementById('ai-panel-close');
const aiClearBtn = document.getElementById('ai-clear-btn');
const aiSendBtn = document.getElementById('ai-send-btn');
const aiQuestionInput = document.getElementById('ai-question');
const aiResponseArea = document.getElementById('ai-response-area');
const aiAutoNotify = document.getElementById('ai-auto-notify');

function openAiPanel() {
  if (!aiPanel) return;
  aiPanel.classList.add('open');
  document.body.classList.add('ai-panel-open');
}

function closeAiPanel() {
  if (!aiPanel) return;
  aiPanel.classList.remove('open');
  document.body.classList.remove('ai-panel-open');
}

function buildContextSummary() {
  if (!currentStats) return '';
  const s = currentStats;
  const parsedIndexHitRatio = Number(s.indexHitRatio);
  const indexHitRatio = Number.isFinite(parsedIndexHitRatio) ? parsedIndexHitRatio : 100;
  const sharedCacheHitRatioRaw = Number(s.sharedCacheHitRatio);
  const sharedCacheHitRatio = Number.isFinite(sharedCacheHitRatioRaw)
    ? `${sharedCacheHitRatioRaw.toFixed(1)}%`
    : 'n/a';
  const connPct = s.maxConnections > 0
    ? ((s.totalConnections / s.maxConnections) * 100).toFixed(0)
    : '0';
  const health = (s.blockingLocks || []).length > 0 ? 'Degraded (blocking locks)' :
    (s.waitingConnections || 0) > 0 ? 'Degraded (waiting sessions)' : 'OK';

  const lines = [
    `Database: ${s.dbName || '-'} | Size: ${s.size || '-'}`,
    `Health: ${health}`,
    `Connections: ${s.activeConnections || 0} active, ${s.idleConnections || 0} idle, ${s.waitingConnections || 0} waiting / ${s.maxConnections || 0} max (${connPct}% capacity)`,
    `Blocking locks: ${(s.blockingLocks || []).length}`,
    `Long-running queries (>5s): ${s.longRunningQueries || 0}`,
    `Wait events: ${(s.waitEvents || []).map(w => `${w.type}=${w.count}`).join(', ') || 'none'}`,
    `Shared cache hit ratio: ${sharedCacheHitRatio}`,
    `Index hit ratio: ${indexHitRatio.toFixed(1)}%`,
    `Oldest transaction age: ${s.oldestTransactionAgeSeconds || 0}s`,
    `Tables needing vacuum: ${(s.tablesNeedingVacuum || []).length}`,
    `Unused indexes: ${(s.unusedIndexes || []).length}`,
    `Dead-tuple pressure tables: ${(s.tableBloat || []).length}`,
    `High seq-scan tables: ${(s.highSeqScanTables || []).length}`,
  ];

  if ((s.blockingLocks || []).length > 0) {
    const lockDetails = s.blockingLocks.slice(0, 3).map(l =>
      `PID ${l.blocking_pid} (${l.blocking_user}) blocks PID ${l.blocked_pid} (${l.blocked_user}) on "${l.locked_object}" [${l.lock_mode}]`
    );
    lines.push(`\nBlocking lock details:\n${lockDetails.map(d => `  - ${d}`).join('\n')}`);
  }

  if ((s.pgStatStatements || []).length > 0) {
    const topStatements = s.pgStatStatements.slice(0, 3).map((st, i) =>
      `#${i + 1}: ${Number(st.total_time).toFixed(0)}ms total, ${st.calls} calls, avg ${Number(st.mean_time).toFixed(1)}ms — ${String(st.query || '').substring(0, 80)}…`
    );
    lines.push(`\nTop SQL (pg_stat_statements):\n${topStatements.map(d => `  ${d}`).join('\n')}`);
  }

  if ((s.highSeqScanTables || []).length > 0) {
    const topSeq = s.highSeqScanTables.slice(0, 3).map(t =>
      `${t.table_name} (${Number(t.seq_scan_pct).toFixed(0)}% seq, ${Number(t.row_count).toLocaleString()} rows)`
    );
    lines.push(`Top high seq-scan tables: ${topSeq.join(', ')}`);
  }

  if ((s.tableBloat || []).length > 0) {
    const topBloat = s.tableBloat.slice(0, 3).map(t =>
      `${t.table_name} (${Number(t.bloat_pct).toFixed(0)}% dead, ${Number(t.n_dead_tup).toLocaleString()} dead tuples)`
    );
    lines.push(`Top bloated tables: ${topBloat.join(', ')}`);
  }

  return lines.join('\n');
}

const quickPromptMap = {
  'analyze-health': 'Analyze the current database health status and explain what is causing any issues. Walk me through each problem area step by step.',
  'explain-locks': 'Explain the blocking lock situation in detail: which PIDs are involved, what are they doing, and what are my options to resolve it safely?',
  'slow-queries': 'What are the long-running queries indicating and how should I address them? Show me queries I can run to investigate further.',
  'top-sql': 'Review the top SQL statements by total time and suggest specific optimizations. Which query should I tackle first and why?',
  'schema-health': 'Analyze the schema health — unused indexes, table bloat, and sequential scan patterns. Prioritize what I should fix first and explain the impact of each.',
  'vacuum-advice': 'Review the vacuum status and dead tuple counts. What vacuum actions should I take, in what order, and what thresholds should I monitor?',
  'connection-triage': 'Analyze the connection patterns: which applications are consuming connections, are there idle-in-transaction sessions, and am I at risk of connection exhaustion?',
  'index-recommendations': 'Based on the high sequential scan tables and query patterns, what indexes should I consider creating? Show me the CREATE INDEX statements.',
};

const metricPromptMap = {
  'db-health': 'Explain the current DB health status and what is causing any degradation.',
  'active-load': 'Analyze the active connection load. Is it healthy? What should I watch for?',
  'blocking-locks': 'Explain the blocking locks in detail. What transactions are involved and how do I resolve them?',
  'wait-events': 'Explain the current wait events. What are they indicating about the workload?',
  'unused-indexes': 'Analyze the unused indexes. Which ones should I consider dropping and why?',
  'high-seq-scan': 'Analyze the tables with high sequential scan rates. Which might benefit from new indexes?',
  'table-bloat': 'Analyze the table bloat. What is the impact and what VACUUM strategy should I use?',
  'autovacuum': 'Analyze the autovacuum status. Is autovacuum keeping up? Should I tune any settings?',
};

const quirkyMessages = [
  "🔍 Inspecting wait events and active sessions...",
  "🔒 Tracing blocking chains and lock contenders...",
  "📈 Correlating spikes across throughput and latency...",
  "🧭 Mapping the connection-state distribution...",
  "🧠 Interpreting cache hit behavior by workload pattern...",
  "🧱 Checking temp spill signals for sort/hash pressure...",
  "🧹 Reviewing dead tuples and vacuum pressure indicators...",
  "🛠️ Verifying autovacuum progress and backlog risk...",
  "📊 Ranking top SQL by total execution time...",
  "🧪 Testing alternate hypotheses for this symptom...",
  "🛰️ Sampling WAL and replication health signals...",
  "📚 Comparing current telemetry with baseline patterns...",
  "🪪 Identifying sessions most likely driving the issue...",
  "🎯 Narrowing to one high-impact next investigation step...",
  "🧯 Looking for immediate mitigation opportunities...",
  "🧵 Stitching metrics into a coherent incident story...",
  "🧰 Validating if index strategy matches access patterns...",
  "📉 Checking for sequential scan hotspots and plan drift...",
  "✅ Summarizing findings with confidence level and risk...",
  "➡️ Preparing the next diagnostic query if needed..."
];

let aiLoadingMessageInterval = null;
let aiLoadingMessageIndex = 0;

let _lastAiQuestion = '';
const _aiAutoFixState = {
  attempts: 0,
  maxAttempts: 5,
  history: []
};
const _investigationState = {
  executedSql: [],
  askedQuestions: [],
};

function _normalizeSqlForComparison(sql) {
  return String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _normalizeQuestionForComparison(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function _rememberQuestion(question) {
  const norm = _normalizeQuestionForComparison(question);
  if (!norm) return;
  if (_investigationState.askedQuestions.includes(norm)) return;
  _investigationState.askedQuestions.push(norm);
  if (_investigationState.askedQuestions.length > 30) {
    _investigationState.askedQuestions.shift();
  }
}

function _rememberExecutedSql(sql) {
  const norm = _normalizeSqlForComparison(sql);
  if (!norm) return;
  if (_investigationState.executedSql.includes(norm)) return;
  _investigationState.executedSql.push(norm);
  if (_investigationState.executedSql.length > 20) {
    _investigationState.executedSql.shift();
  }
}

function _resetAiAutoFixState() {
  _aiAutoFixState.attempts = 0;
  _aiAutoFixState.history = [];
}

function _resetInvestigationState() {
  _investigationState.executedSql = [];
  _investigationState.askedQuestions = [];
}

function _buildAutoFixHistorySummary() {
  if (_aiAutoFixState.history.length === 0) return 'No attempts were recorded.';
  return _aiAutoFixState.history.map((entry, index) => {
    const sql = String(entry.sql || '').replace(/\s+/g, ' ').trim();
    const compactSql = sql.length > 180 ? `${sql.slice(0, 180)}...` : sql;
    return `${index + 1}. Error: ${entry.error}\n   SQL: ${compactSql}`;
  }).join('\n');
}

function _requestAiAutoFixForQueryError(data) {
  const sql = String(data.sql || '').trim();
  const error = String(data.error || 'Unknown query execution error').trim();

  _aiAutoFixState.attempts += 1;
  _aiAutoFixState.history.push({
    sql,
    error,
    at: new Date().toISOString()
  });

  if (_aiAutoFixState.attempts > _aiAutoFixState.maxAttempts) {
    const summary = _buildAutoFixHistorySummary();
    _appendAiMessage(
      'assistant',
      _parseAiMarkdown(
        `I attempted to auto-fix this query ${_aiAutoFixState.maxAttempts} times and it is still failing.\n\n` +
        `Please share how you want to proceed (for example: adjust intent, simplify query scope, or provide schema details).\n\n` +
        `What I tried:\n\n${summary}`
      )
    );
    renderAiLoading(false);
    return;
  }

  const summary = _buildAutoFixHistorySummary();
  const autoFixQuestion = [
    'The last SQL query execution failed in PostgreSQL.',
    'Analyze the failure and produce a corrected query.',
    'Respond with:',
    '1) A brief explanation of why it failed',
    '2) What you changed',
    '3) A corrected SQL query in a ```sql fenced block',
    '4) A short note asking the user to run the fixed query again',
    '',
    `Attempt: ${_aiAutoFixState.attempts}/${_aiAutoFixState.maxAttempts}`,
    `Failed SQL:\n${sql}`,
    `Error:\n${error}`,
    '',
    'Previous attempts (oldest to newest):',
    summary
  ].join('\n');

  _lastAiQuestion = autoFixQuestion;
  renderAiLoading(true);
  vscode.postMessage({
    command: 'askAI',
    question: autoFixQuestion,
    context: buildContextSummary(),
  });
}

function _appendAiMessage(role, htmlContent, meta = {}) {
  if (!aiResponseArea) return;
  const welcome = aiResponseArea.querySelector('.ai-welcome');
  if (welcome) welcome.remove();

  const msgDiv = document.createElement('div');
  msgDiv.className = 'ai-message ' + role;

  const roleLabel = document.createElement('div');
  roleLabel.className = 'ai-message-role';
  roleLabel.textContent = role === 'user' ? 'You' : 'AI';

  const bubble = document.createElement('div');
  bubble.className = 'ai-message-bubble';

  const content = document.createElement('div');
  content.className = 'ai-message-content';
  content.innerHTML = htmlContent;

  bubble.appendChild(content);

  if (role === 'user' && meta.contextSummary) {
    const rawContext = String(meta.contextSummary || '').trim();
    const maxChars = 650;
    const lines = rawContext.split('\n');
    const maxLines = 14;
    const clippedByChars = rawContext.length > maxChars;
    const clippedByLines = lines.length > maxLines;
    const clippedText = clippedByLines
      ? lines.slice(0, maxLines).join('\n')
      : rawContext;
    const finalText = clippedByChars
      ? `${clippedText.slice(0, maxChars)}\n... (context truncated)`
      : (clippedByLines ? `${clippedText}\n... (context truncated)` : clippedText);

    const details = document.createElement('details');
    details.className = 'ai-context-attachment';
    details.style.margin = '10px 0 0 0';
    details.style.border = '1px solid rgba(128, 128, 128, 0.35)';
    details.style.borderRadius = '6px';
    details.style.background = 'rgba(128, 128, 128, 0.08)';
    details.style.overflow = 'hidden';

    const summary = document.createElement('summary');
    summary.style.cursor = 'pointer';
    summary.style.listStyle = 'none';
    summary.style.padding = '6px 10px';
    summary.style.fontSize = '0.78rem';
    summary.style.color = 'var(--muted-color)';
    summary.style.userSelect = 'none';
    summary.textContent = 'Attachment: Dashboard context snapshot';

    const body = document.createElement('pre');
    body.className = 'ai-context-quote';
    body.style.margin = '0';
    body.style.padding = '8px 10px 10px 10px';
    body.style.borderTop = '1px solid rgba(128, 128, 128, 0.25)';
    body.style.fontSize = '0.78rem';
    body.style.color = 'var(--muted-color)';
    body.style.whiteSpace = 'pre-wrap';
    body.style.maxHeight = '180px';
    body.style.overflow = 'auto';
    body.textContent = finalText;

    details.appendChild(summary);
    details.appendChild(body);
    bubble.appendChild(details);
  }

  msgDiv.appendChild(roleLabel);
  msgDiv.appendChild(bubble);
  aiResponseArea.appendChild(msgDiv);

  if (role === 'assistant') {
    _addSqlRunButtons(msgDiv, meta.runQuestion);
  }

  aiResponseArea.scrollTop = aiResponseArea.scrollHeight;
}

function _addSqlRunButtons(msgDiv, runQuestionOverride) {
  msgDiv.querySelectorAll('.ai-code-block').forEach(block => {
    const langEl = block.querySelector('.ai-code-lang');
    const lang = langEl ? langEl.textContent.trim().toUpperCase() : '';
    if (!['SQL', 'PGSQL', 'POSTGRESQL', 'PLPGSQL'].includes(lang)) return;

    const codeEl = block.querySelector('.ai-code-content');
    if (!codeEl) return;

    const confirmRow = document.createElement('div');
    confirmRow.className = 'ai-run-confirm';
    confirmRow.innerHTML = `
      <span class="ai-run-prompt">Run this query on <strong>${escHtml(currentStats ? currentStats.dbName : 'the database')}</strong>?</span>
      <div class="ai-run-actions">
        <button class="ai-run-ok-btn">&#9654; Run</button>
        <button class="ai-run-skip-btn">Skip</button>
      </div>`;
    block.appendChild(confirmRow);

    confirmRow.querySelector('.ai-run-ok-btn').addEventListener('click', () => {
      const sql = codeEl.textContent.trim();
      confirmRow.innerHTML = '<span class="ai-run-executing"><span class="ai-run-spinner"></span> Executing query…</span>';
      const runQuestion = runQuestionOverride || _lastAiQuestion || 'Investigate this SQL query result and explain findings.';
      vscode.postMessage({ command: 'executeQueryForAI', sql, question: runQuestion });
    });

    confirmRow.querySelector('.ai-run-skip-btn').addEventListener('click', () => {
      confirmRow.remove();
    });
  });
}

function _handleQueryResult(data) {
  if (!aiResponseArea) return;

  const lastConfirm = aiResponseArea.querySelector('.ai-run-executing');
  if (lastConfirm) lastConfirm.closest('.ai-run-confirm').remove();

  const wrapper = document.createElement('div');
  wrapper.className = 'ai-query-result';

  if (data.error) {
    wrapper.innerHTML = `<div class="ai-result-error"><strong>Query error:</strong> ${escHtml(data.error)}</div>`;
    aiResponseArea.appendChild(wrapper);
    aiResponseArea.scrollTop = aiResponseArea.scrollHeight;
    _requestAiAutoFixForQueryError(data);
    return;
  }

  const hadAutoFixAttempt = _aiAutoFixState.history.length > 0;
  _rememberExecutedSql(data.sql || '');
  // Reset retry loop after any successful execution.
  _resetAiAutoFixState();

  const rowCount = data.rowCount ?? (data.rows ? data.rows.length : 0);
  let html = `<div class="ai-result-meta">Query returned ${rowCount} row${rowCount !== 1 ? 's' : ''}`;
  if (data.columns && data.rows && data.rows.length > 0) {
    html += ` &mdash; <button class="ai-csv-btn">&#8659; Download CSV</button>`;
  }
  html += `</div>`;
  wrapper.innerHTML = html;

  const csvBtn = wrapper.querySelector('.ai-csv-btn');
  if (csvBtn) csvBtn.addEventListener('click', () => _downloadQueryCsv(data));

  aiResponseArea.appendChild(wrapper);
  aiResponseArea.scrollTop = aiResponseArea.scrollHeight;

  _sendResultsToAI(data, { summarizeAfterFix: hadAutoFixAttempt });
}

function _sendResultsToAI(data, options = {}) {
  const summarizeAfterFix = Boolean(options.summarizeAfterFix);
  const rowCount = data.rowCount ?? (data.rows ? data.rows.length : 0);
  let resultContext = `Query results (${rowCount} row${rowCount !== 1 ? 's' : ''}):\n`;

  if (data.columns && data.rows && data.rows.length > 0) {
    resultContext += data.columns.join(' | ') + '\n';
    resultContext += data.rows.slice(0, 50).map(row =>
      data.columns.map(col => {
        const normalized = normalizeResultValue(row[col]);
        return normalized === null || normalized === undefined ? 'NULL' : String(normalized);
      }).join(' | ')
    ).join('\n');
    if (data.rows.length > 50) resultContext += `\n… (${data.rows.length - 50} more rows truncated)`;
  } else {
    resultContext += '(no rows returned)';
  }

  const zeroRowGuidance = rowCount === 0
    ? [
      'Important: the SQL execution succeeded and returned 0 rows.',
      'Treat this as an empty result set, not as a query failure.',
      'Explain what this implies and whether this is expected for current filters/conditions.'
    ].join('\n')
    : '';

  const previousSql = _investigationState.executedSql.length > 0
    ? _investigationState.executedSql.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : 'None';
  const previousQuestions = _investigationState.askedQuestions.length > 0
    ? _investigationState.askedQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : 'None';

  const question = summarizeAfterFix
    ? [
      'The corrected query executed successfully.',
      'Summarize what the returned data means for the user’s original problem in concise terms.',
      'Explain what failed previously and what was fixed to make this run succeed.',
      'Do NOT generate another SQL query unless the data is clearly insufficient to answer the question.',
      'If more data is required, provide exactly one targeted SQL query and explain why it is needed.',
      '',
      'Original repair request and context:',
      data.question || 'N/A',
      '',
      zeroRowGuidance,
      zeroRowGuidance ? '' : '',
      'Previously executed SQL (do not repeat):',
      previousSql,
      '',
      'Previously asked follow-up questions (do not repeat):',
      previousQuestions,
      '',
      resultContext
    ].join('\n')
    : [
      (data.question || 'Answer the original question using the query results below.'),
      '',
      'Important investigation rules:',
      '- Do not repeat a previously executed SQL query.',
      '- Do not repeat previously asked follow-up questions.',
      '- If current evidence is enough, stop querying and provide a final investigation summary.',
      '- In final summary, explicitly state: (a) major finding yes/no, (b) suspicious activity yes/no on current thread.',
      '- If nothing suspicious is found, clearly say so and switch to the next likely issue area.',
      '- Only propose one new SQL query if genuinely required and from a different diagnostic angle.',
      '',
      zeroRowGuidance,
      zeroRowGuidance ? '' : '',
      'Previously executed SQL (do not repeat):',
      previousSql,
      '',
      'Previously asked follow-up questions (do not repeat):',
      previousQuestions,
      '',
      resultContext
    ].join('\n');

  renderAiLoading(true);
  vscode.postMessage({ command: 'askAI', question, context: buildContextSummary() });
}

function _downloadQueryCsv(data) {
  const { columns, rows } = data;
  const esc = val => {
    const normalized = normalizeResultValue(val);
    const s = normalized === null || normalized === undefined ? '' : String(normalized);
    return (s.includes(',') || s.includes('"') || s.includes('\n'))
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(','), ...rows.map(row => columns.map(col => esc(row[col])).join(','))];
  vscode.postMessage({ command: 'downloadCsv', csv: lines.join('\n'), filename: 'query_results.csv' });
}

function normalizeResultValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    return value.map(item => normalizeResultValue(item));
  }

  if (typeof value === 'object') {
    if (typeof value.toPostgres === 'function') {
      try {
        return value.toPostgres();
      } catch {
        // Fallback to JSON serialization.
      }
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function sendAiQuestion(question) {
  if (!question || !question.trim()) return;
  openAiPanel();
  const q = question.trim();
  const contextSummary = buildContextSummary();
  _resetAiAutoFixState();
  _rememberQuestion(q);
  _lastAiQuestion = q;
  _appendAiMessage('user', escHtml(q).replace(/\n/g, '<br>'), { contextSummary });
  vscode.postMessage({
    command: 'askAI',
    question: q,
    context: contextSummary,
  });
  if (aiQuestionInput) aiQuestionInput.value = '';
}

function clearConversation() {
  if (!aiResponseArea) return;
  aiResponseArea.innerHTML = `<div class="ai-welcome">
    <p>Ask about any metric, or click a quick-action above.</p>
    <p style="font-size: 0.8rem; color: var(--muted-color);">Context from the current dashboard snapshot is sent with each question.</p>
  </div>`;
  _resetAiAutoFixState();
  _resetInvestigationState();
  _lastAiQuestion = '';
  vscode.postMessage({ command: 'clearConversation' });
}

function renderAiLoading(loading) {
  if (!aiResponseArea) return;
  const existing = aiResponseArea.querySelector('.ai-loading-quirky');
  if (loading && !existing) {
    aiLoadingMessageIndex = Math.floor(Math.random() * quirkyMessages.length);
    const loadingEl = document.createElement('div');
    loadingEl.className = 'ai-loading-quirky';
    loadingEl.textContent = quirkyMessages[aiLoadingMessageIndex];
    aiResponseArea.appendChild(loadingEl);

    if (aiLoadingMessageInterval) {
      clearInterval(aiLoadingMessageInterval);
    }
    aiLoadingMessageInterval = setInterval(() => {
      const activeEl = aiResponseArea.querySelector('.ai-loading-quirky');
      if (!activeEl) return;
      aiLoadingMessageIndex = (aiLoadingMessageIndex + 1) % quirkyMessages.length;
      activeEl.textContent = quirkyMessages[aiLoadingMessageIndex];
    }, 2500);

    aiResponseArea.scrollTop = aiResponseArea.scrollHeight;
  } else if (!loading && existing) {
    if (aiLoadingMessageInterval) {
      clearInterval(aiLoadingMessageInterval);
      aiLoadingMessageInterval = null;
    }
    existing.remove();
  }
}

function _extractNextSteps(text) {
  // Extract {"next_steps": [...]} JSON block at end of response
  const match = text.match(/\{[\s\S]*?"next_steps"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (!match) return { cleanText: text, nextSteps: [] };
  try {
    const parsed = JSON.parse(match[0]);
    const nextSteps = Array.isArray(parsed.next_steps) ? parsed.next_steps : [];
    const cleanText = text.slice(0, match.index).trimEnd();
    return { cleanText, nextSteps };
  } catch (_) {
    return { cleanText: text, nextSteps: [] };
  }
}

function _extractFollowUpQuestions(text) {
  // Extract numbered follow-up questions from "**Follow-up questions:**\n1. ...\n2. ..."
  const questions = [];
  const sectionMatch = text.match(/\*\*Follow-up questions:\*\*\s*\n((?:\d+\.\s*.+\n?)+)/i);
  if (sectionMatch) {
    const block = sectionMatch[1];
    const itemRegex = /\d+\.\s*(.+)/g;
    let m;
    while ((m = itemRegex.exec(block)) !== null) {
      questions.push(m[1].trim());
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const q of questions) {
    const norm = _normalizeQuestionForComparison(q);
    if (!norm || seen.has(norm) || _investigationState.askedQuestions.includes(norm)) continue;
    seen.add(norm);
    deduped.push(q);
  }
  return deduped;
}

function _renderSuggestionChips(container, items, isFollowUp) {
  if (!items || items.length === 0) return;
  const chipRow = document.createElement('div');
  chipRow.className = isFollowUp ? 'ai-followup-chips' : 'ai-nextstep-chips';
  items.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = 'ai-suggestion-chip';
    btn.textContent = isFollowUp ? `${idx + 1}. ${item}` : item;
    btn.title = item;
    btn.addEventListener('click', () => {
      const q = isFollowUp ? String(idx + 1) : item;
      sendAiQuestion(q);
    });
    chipRow.appendChild(btn);
  });
  container.appendChild(chipRow);
}

function renderAiResponse(text) {
  const { cleanText, nextSteps } = _extractNextSteps(text);
  const followUps = _extractFollowUpQuestions(cleanText);

  for (const followUp of followUps) {
    _rememberQuestion(followUp);
  }

  _lastAiQuestion = cleanText;
  _appendAiMessage('assistant', _parseAiMarkdown(cleanText), { runQuestion: cleanText });

  // Find the last assistant message bubble to attach chips to
  const messages = aiResponseArea ? aiResponseArea.querySelectorAll('.ai-message.assistant') : [];
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    const bubble = lastMsg.querySelector('.ai-message-bubble');
    if (bubble) {
      if (followUps.length > 0) _renderSuggestionChips(bubble, followUps, true);
      if (nextSteps.length > 0) _renderSuggestionChips(bubble, nextSteps, false);
    }
  }

  if (aiResponseArea) aiResponseArea.scrollTop = aiResponseArea.scrollHeight;
}

// ── AI Markdown + SQL Highlighting ──────────────────────────────────

let _aiCodeBlockCounter = 0;
let _aiMarkedRenderer = null;

function _highlightSqlTokens(code) {
  const keywords = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TABLE', 'INDEX', 'VIEW', 'FUNCTION', 'TRIGGER', 'PROCEDURE', 'CONSTRAINT', 'PRIMARY', 'KEY', 'FOREIGN', 'REFERENCES', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'FULL', 'CROSS', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION', 'ALL', 'DISTINCT', 'AS', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'ILIKE', 'IS', 'NULL', 'TRUE', 'FALSE', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DEFAULT', 'VALUES', 'SET', 'RETURNING', 'BEGIN', 'COMMIT', 'ROLLBACK', 'TRANSACTION', 'GRANT', 'REVOKE', 'WITH', 'ANALYZE', 'EXPLAIN', 'VACUUM', 'REINDEX', 'CLUSTER', 'COALESCE', 'NULLIF', 'CAST'];
  const types = ['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'VARCHAR', 'TEXT', 'BOOLEAN', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'NUMERIC', 'DECIMAL', 'FLOAT', 'REAL', 'JSON', 'JSONB', 'UUID', 'SERIAL', 'BIGSERIAL', 'BYTEA', 'OID', 'REGCLASS'];

  let html = '';
  let rest = code;
  while (rest.length > 0) {
    let m;
    if ((m = rest.match(/^(--[^\n]*)/))) { html += '<span class="sql-comment">' + m[0] + '</span>'; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^(\/\*[\s\S]*?\*\/)/))) { html += '<span class="sql-comment">' + m[0] + '</span>'; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^('(?:[^'\\]|\\.)*')/))) { html += '<span class="sql-string">' + m[0] + '</span>'; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^(\d+\.?\d*)/))) { html += '<span class="sql-number">' + m[0] + '</span>'; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/))) {
      const w = m[0], u = w.toUpperCase();
      if (keywords.includes(u)) html += '<span class="sql-keyword">' + w + '</span>';
      else if (types.includes(u)) html += '<span class="sql-type">' + w + '</span>';
      else if (/^\s*\(/.test(rest.slice(w.length))) html += '<span class="sql-function">' + w + '</span>';
      else html += '<span class="sql-identifier">' + w + '</span>';
      rest = rest.slice(w.length); continue;
    }
    if ((m = rest.match(/^(&[a-zA-Z]+;)/))) { html += m[0]; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^([+\-/*=<>!|%]+)/))) { html += '<span class="sql-operator">' + m[0] + '</span>'; rest = rest.slice(m[0].length); continue; }
    if ((m = rest.match(/^([,;().[\]]+)/))) { html += '<span class="sql-punctuation">' + m[0] + '</span>'; rest = rest.slice(m[0].length); continue; }
    html += rest[0]; rest = rest.slice(1);
  }
  return html;
}

function _getAiMarkedRenderer() {
  if (_aiMarkedRenderer) return _aiMarkedRenderer;
  if (typeof marked === 'undefined') return null;

  const renderer = new marked.Renderer();

  renderer.code = function ({ text, lang }) {
    const id = 'ai-code-' + (++_aiCodeBlockCounter);
    const language = lang || 'text';
    const displayLang = language === 'text' ? 'CODE' : language.toUpperCase();
    const isSql = ['sql', 'pgsql', 'postgresql', 'plpgsql'].includes(language.toLowerCase());

    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const highlighted = isSql ? _highlightSqlTokens(escaped) : escaped;

    return `<div class="ai-code-block">
      <div class="ai-code-header">
        <span class="ai-code-lang">${displayLang}</span>
        <button class="ai-copy-btn" data-code-id="${id}" title="Copy">
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg>
          Copy
        </button>
      </div>
      <pre><code id="${id}" class="ai-code-content">${highlighted}</code></pre>
    </div>`;
  };

  renderer.codespan = function ({ text }) {
    return `<code class="ai-inline-code">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code>`;
  };

  _aiMarkedRenderer = renderer;
  return _aiMarkedRenderer;
}

function _parseAiMarkdown(text) {
  if (typeof marked !== 'undefined') {
    try {
      const renderer = _getAiMarkedRenderer();
      if (renderer) {
        return marked.parse(text, { renderer, breaks: true });
      }
    } catch (e) { /* fall through */ }
  }
  // Fallback: minimal escaping
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

if (aiToggleBtn) {
  aiToggleBtn.addEventListener('click', () => {
    if (aiPanel && aiPanel.classList.contains('open')) {
      closeAiPanel();
    } else {
      openAiPanel();
    }
  });
}

if (aiCloseBtn) {
  aiCloseBtn.addEventListener('click', closeAiPanel);
}

if (aiClearBtn) {
  aiClearBtn.addEventListener('click', clearConversation);
}

if (aiSendBtn) {
  aiSendBtn.addEventListener('click', () => {
    sendAiQuestion(aiQuestionInput ? aiQuestionInput.value : '');
  });
}

if (aiQuestionInput) {
  aiQuestionInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAiQuestion(aiQuestionInput.value);
    }
  });
}

if (aiAutoNotify) {
  aiAutoNotify.addEventListener('change', () => {
    vscode.postMessage({ command: 'toggleAutoNotify', enabled: aiAutoNotify.checked });
  });
}

document.querySelectorAll('.ai-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    const prompt = quickPromptMap[btn.dataset.prompt];
    if (prompt) sendAiQuestion(prompt);
  });
});

document.addEventListener('click', e => {
  const btn = e.target.closest('.card-ai-btn');
  if (btn) {
    e.stopPropagation();
    const metric = btn.dataset.metric;
    const prompt = metricPromptMap[metric] || `Analyze the ${metric} metric and explain what I should know.`;
    sendAiQuestion(prompt);
  }

  // Copy button inside AI code blocks
  const copyBtn = e.target.closest('.ai-copy-btn');
  if (copyBtn) {
    const codeId = copyBtn.dataset.codeId;
    const codeEl = codeId && document.getElementById(codeId);
    if (codeEl) {
      navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 010 1.5h-1.5a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-1.5a.75.75 0 011.5 0v1.5A1.75 1.75 0 019.25 16h-7.5A1.75 1.75 0 010 14.25v-7.5z"/><path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0114.25 11h-7.5A1.75 1.75 0 015 9.25v-7.5zm1.75-.25a.25.25 0 00-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 00.25-.25v-7.5a.25.25 0 00-.25-.25h-7.5z"/></svg> Copy`;
        }, 1500);
      });
    }
  }
});

// Cache stats for AI context
const _origUpdateDashboard = updateDashboard;
// Intercept to keep currentStats fresh
const _dashboardStatsScript = document.getElementById('dashboard-stats');
if (_dashboardStatsScript) {
  try { currentStats = JSON.parse(_dashboardStatsScript.textContent); } catch (_) {}
}
window.addEventListener('message', e => {
  if (e.data && e.data.command === 'updateStats') {
    currentStats = e.data.stats;
  }
}, true);
