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
  const reads = stats.metrics.blks_read - lastMetrics.blks_read;
  const hits = stats.metrics.blks_hit - lastMetrics.blks_hit;

  const tps = Math.max(0, Math.round((commits + rollbacks) / timeDiff));
  const rollbackRate = Math.max(0, Math.round(rollbacks / timeDiff));
  const totalIo = reads + hits;
  const hitRatio = Math.min(100, Math.max(0, totalIo > 0 ? (hits / totalIo) * 100 : 100));

  pushWithLimit(timeLabels, formatTimeLabel(now));
  pushWithLimit(tpsHistory, tps);
  pushWithLimit(connActiveHistory, Math.max(0, stats.activeConnections || 0));
  pushWithLimit(connIdleHistory, Math.max(0, stats.idleConnections || 0));
  pushWithLimit(waitMarkerHistory, (stats.waitingConnections || 0) > 0 ? Math.max(0, stats.activeConnections || 0) : null);
  pushWithLimit(connCapacityHistory, Math.max(1, stats.maxConnections || 100));
  const incomingActiveSessions = (stats.activeQueries || []).filter(query => (query.state || '').toLowerCase() === 'active').length;
  pushWithLimit(activeSessionHistory, incomingActiveSessions);
  pushWithLimit(rollbackHistory, rollbackRate);
  pushWithLimit(cacheHitHistory, hitRatio);
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
    const ratio = Number(stats.indexHitRatio || 0);
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

  const ratio = Number(stats.indexHitRatio || 0);
  if (indexValue) {
    indexValue.textContent = `${ratio.toFixed(1)}%`;
    indexValue.style.color = ratio < 90 ? 'var(--danger-color)' : ratio < 95 ? 'var(--warning-color)' : 'var(--success-color)';
  }
  if (indexNote) {
    if (ratio < 90) indexNote.textContent = 'Low cache reuse. Validate indexes, execution plans, and memory settings.';
    else if (ratio < 95) indexNote.textContent = 'Moderate cache reuse. Check hottest read paths and index coverage.';
    else indexNote.textContent = 'Healthy cache reuse for indexed access patterns.';
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
