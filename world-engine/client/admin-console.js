'use strict';

const ADMIN_UI = {
  timer: null,
  busy: false,
  snapshot: null,
};

window.addEventListener('DOMContentLoaded', () => {
  mountAdminConsole();
  bindAdminConsoleControls();
  restoreAdminConsoleOptions();
  refreshAdminConsole().catch(() => {});
  configureAdminAutoRefresh();
});

function mountAdminConsole() {
  if (document.getElementById('adminConsolePanel')) return;
  const anchor = document.getElementById('runtimeLoopPanel')
    || document.getElementById('worldMetrics')?.closest('.panel');
  const panel = document.createElement('section');
  panel.id = 'adminConsolePanel';
  panel.className = 'panel wide admin-console-panel';
  panel.innerHTML = [
    '<div class="section-title">',
    '  <div><h2>GM / 运维控制台</h2><p class="hint">聚合世界状态、连接、API 审计与错误；开启权限模式时需要 GM/admin Session。</p></div>',
    '  <span id="adminConsoleStatus" class="admin-console-status idle">idle</span>',
    '</div>',
    '<div class="grid four admin-filter-grid">',
    '  <label>刷新间隔<select id="adminRefreshSeconds"><option value="3">3 秒</option><option value="5" selected>5 秒</option><option value="10">10 秒</option><option value="30">30 秒</option></select></label>',
    '  <label>HTTP 方法<select id="adminMethodFilter"><option value="">全部</option><option value="GET">GET</option><option value="POST">POST</option><option value="OPTIONS">OPTIONS</option></select></label>',
    '  <label>状态码<input id="adminStatusFilter" inputmode="numeric" placeholder="例如 403" /></label>',
    '  <label>路径包含<input id="adminPathFilter" placeholder="例如 /players" /></label>',
    '</div>',
    '<div class="actions admin-console-actions">',
    '  <label class="inline-control"><input id="adminAutoRefresh" type="checkbox" />自动刷新</label>',
    '  <button id="adminRefreshBtn" class="primary">刷新运维面板</button>',
    '  <button id="adminClearFiltersBtn">清除筛选</button>',
    '</div>',
    '<div id="adminMetrics" class="metric-grid admin-metrics"></div>',
    '<div id="adminSummaryCards" class="admin-summary-grid"></div>',
    '<div class="admin-section-heading"><h3>API 审计</h3><span id="adminAuditCount" class="badge">0</span></div>',
    '<div class="admin-table-wrap">',
    '  <table class="admin-table">',
    '    <thead><tr><th>tick</th><th>方法</th><th>路径</th><th>状态</th><th>耗时</th><th>账号 / 玩家</th><th>错误</th></tr></thead>',
    '    <tbody id="adminAuditBody"><tr><td colspan="7" class="empty">等待审计数据</td></tr></tbody>',
    '  </table>',
    '</div>',
    '<div class="admin-section-heading"><h3>最近错误</h3><span id="adminErrorCount" class="badge">0</span></div>',
    '<div id="adminErrorList" class="admin-error-list"><div class="empty">等待错误数据</div></div>',
    '<details class="admin-raw-details"><summary>原始运维快照</summary><pre id="adminConsoleRaw">等待运维数据</pre></details>',
  ].join('');

  if (anchor?.nextSibling) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.querySelector('main')?.appendChild(panel);
}

function bindAdminConsoleControls() {
  bindAdminButton('adminRefreshBtn', refreshAdminConsole);
  bindAdminButton('adminClearFiltersBtn', clearAdminFilters);
  document.getElementById('adminAutoRefresh')?.addEventListener('change', configureAdminAutoRefresh);
  document.getElementById('adminRefreshSeconds')?.addEventListener('change', configureAdminAutoRefresh);
  for (const id of ['adminMethodFilter', 'adminStatusFilter', 'adminPathFilter']) {
    document.getElementById(id)?.addEventListener('input', () => {
      persistAdminConsoleOptions();
      if (ADMIN_UI.snapshot) renderAdminAudit(ADMIN_UI.snapshot.audit?.log || []);
    });
  }
}

function bindAdminButton(id, handler) {
  document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      renderAdminError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function restoreAdminConsoleOptions() {
  setAdminValue('adminRefreshSeconds', localStorage.getItem('mud_admin_refresh_seconds') || '5');
  setAdminValue('adminMethodFilter', localStorage.getItem('mud_admin_method_filter') || '');
  setAdminValue('adminStatusFilter', localStorage.getItem('mud_admin_status_filter') || '');
  setAdminValue('adminPathFilter', localStorage.getItem('mud_admin_path_filter') || '');
  const auto = document.getElementById('adminAutoRefresh');
  if (auto) auto.checked = localStorage.getItem('mud_admin_auto_refresh') === 'true';
}

function persistAdminConsoleOptions() {
  localStorage.setItem('mud_admin_refresh_seconds', adminValue('adminRefreshSeconds'));
  localStorage.setItem('mud_admin_method_filter', adminValue('adminMethodFilter'));
  localStorage.setItem('mud_admin_status_filter', adminValue('adminStatusFilter'));
  localStorage.setItem('mud_admin_path_filter', adminValue('adminPathFilter'));
  localStorage.setItem('mud_admin_auto_refresh', String(Boolean(document.getElementById('adminAutoRefresh')?.checked)));
}

function configureAdminAutoRefresh() {
  if (ADMIN_UI.timer) clearInterval(ADMIN_UI.timer);
  ADMIN_UI.timer = null;
  persistAdminConsoleOptions();
  if (!document.getElementById('adminAutoRefresh')?.checked) return;
  const seconds = Math.max(3, Number(adminValue('adminRefreshSeconds') || 5));
  ADMIN_UI.timer = setInterval(() => {
    if (!document.hidden) refreshAdminConsole().catch(() => {});
  }, seconds * 1000);
}

async function refreshAdminConsole() {
  if (ADMIN_UI.busy) return ADMIN_UI.snapshot;
  ADMIN_UI.busy = true;
  setAdminStatus('loading');
  try {
    const [status, connections, audit, errors] = await Promise.all([
      adminRequest('/admin/status'),
      adminRequest('/admin/connections'),
      adminRequest('/admin/audit?limit=200'),
      adminRequest('/admin/errors?limit=50'),
    ]);
    const snapshot = {
      status: status.data || {},
      connections: connections.data || {},
      audit: audit.data || {},
      errors: errors.data?.errors || [],
      refreshedAt: new Date().toISOString(),
    };
    ADMIN_UI.snapshot = snapshot;
    renderAdminConsole(snapshot);
    setAdminStatus('ready');
    return snapshot;
  } catch (error) {
    renderAdminError(error);
    throw error;
  } finally {
    ADMIN_UI.busy = false;
  }
}

function renderAdminConsole(snapshot) {
  const status = snapshot.status || {};
  const health = status.health || {};
  const accounts = status.accounts || {};
  const auditStats = status.audit || snapshot.audit?.stats || {};
  const loop = status.loop || {};
  const connections = snapshot.connections || {};
  const metrics = [
    ['tick', health.tick ?? '-'],
    ['players', health.players ?? '-'],
    ['accounts', accounts.accounts ?? 0],
    ['active sessions', accounts.activeSessions ?? 0],
    ['API requests', auditStats.requests ?? 0],
    ['API errors', auditStats.errors ?? 0],
    ['SSE', connections.streams ?? 0],
    ['WebSocket', connections.sockets ?? 0],
    ['loop', loop.status || 'unknown'],
  ];
  const metricContainer = document.getElementById('adminMetrics');
  if (metricContainer) {
    metricContainer.innerHTML = metrics.map(([label, value]) => (
      '<div class="metric"><strong>' + escapeAdmin(value) + '</strong><span>' + escapeAdmin(label) + '</span></div>'
    )).join('');
  }

  renderAdminSummary(status, snapshot);
  renderAdminAudit(snapshot.audit?.log || []);
  renderAdminErrors(snapshot.errors || []);
  const raw = document.getElementById('adminConsoleRaw');
  if (raw) raw.textContent = JSON.stringify(snapshot, null, 2);
}

function renderAdminSummary(status, snapshot) {
  const runtime = status.runtime || {};
  const loop = status.loop || {};
  const accounts = status.accounts || {};
  const audit = status.audit || snapshot.audit?.stats || {};
  const methodBadges = Object.entries(audit.byMethod || {}).map(([key, value]) => key + ' ' + value);
  const statusBadges = Object.entries(audit.byStatus || {}).map(([key, value]) => key + ' ' + value);
  const cards = [
    adminSummaryCard('运行状态', [
      'runtime ' + (runtime.status || 'unknown'),
      'loop ' + (loop.status || 'unknown'),
      'ticks ' + (loop.ticksRun ?? runtime.ticksRun ?? 0),
      'errors ' + (loop.errorCount ?? runtime.errors?.length ?? 0),
    ]),
    adminSummaryCard('账号状态', [
      'active ' + (accounts.activeAccounts ?? 0),
      'sessions ' + (accounts.sessions ?? 0),
      'active sessions ' + (accounts.activeSessions ?? 0),
      'linked players ' + (accounts.stats?.playersLinked ?? 0),
    ]),
    adminSummaryCard('请求方法', methodBadges.length ? methodBadges : ['暂无请求']),
    adminSummaryCard('响应状态', statusBadges.length ? statusBadges : ['暂无响应']),
  ];
  const container = document.getElementById('adminSummaryCards');
  if (container) container.innerHTML = cards.join('');
}

function adminSummaryCard(title, values) {
  return '<div class="mini-card"><strong>' + escapeAdmin(title) + '</strong><div class="badge-row">' +
    values.map(value => '<span class="badge">' + escapeAdmin(value) + '</span>').join('') +
    '</div></div>';
}

function renderAdminAudit(log) {
  const filtered = filterAdminAudit(log).slice(0, 100);
  const count = document.getElementById('adminAuditCount');
  if (count) count.textContent = String(filtered.length);
  const body = document.getElementById('adminAuditBody');
  if (!body) return;
  if (!filtered.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">没有符合筛选条件的审计记录</td></tr>';
    return;
  }
  body.innerHTML = filtered.map(entry => {
    const identity = [entry.accountId, entry.playerId].filter(Boolean).join(' / ') || '-';
    const statusClass = Number(entry.statusCode || 0) >= 400 ? 'bad' : Number(entry.statusCode || 0) >= 300 ? 'warn' : 'ok';
    return '<tr>' +
      '<td>' + escapeAdmin(entry.tick ?? '-') + '</td>' +
      '<td><span class="admin-method">' + escapeAdmin(entry.method || '-') + '</span></td>' +
      '<td class="admin-path">' + escapeAdmin(entry.path || '-') + '</td>' +
      '<td><span class="admin-http-status ' + statusClass + '">' + escapeAdmin(entry.statusCode ?? '-') + '</span></td>' +
      '<td>' + escapeAdmin(entry.durationMs ?? 0) + ' ms</td>' +
      '<td>' + escapeAdmin(identity) + '</td>' +
      '<td class="admin-error-cell">' + escapeAdmin(entry.error || '-') + '</td>' +
      '</tr>';
  }).join('');
}

function filterAdminAudit(log) {
  const method = adminValue('adminMethodFilter').toUpperCase();
  const status = adminValue('adminStatusFilter');
  const pathValue = adminValue('adminPathFilter').toLowerCase();
  return (log || []).filter(entry => {
    if (method && String(entry.method || '').toUpperCase() !== method) return false;
    if (status && String(entry.statusCode || '') !== status) return false;
    if (pathValue && !String(entry.path || '').toLowerCase().includes(pathValue)) return false;
    return true;
  });
}

function renderAdminErrors(errors) {
  const count = document.getElementById('adminErrorCount');
  if (count) count.textContent = String(errors.length);
  const container = document.getElementById('adminErrorList');
  if (!container) return;
  if (!errors.length) {
    container.innerHTML = '<div class="admin-no-errors">当前没有已记录的 API 错误</div>';
    return;
  }
  container.innerHTML = errors.slice(0, 20).map(entry => (
    '<div class="admin-error-card">' +
      '<div><strong>' + escapeAdmin((entry.method || '-') + ' ' + (entry.path || '-')) + '</strong>' +
      '<small>tick ' + escapeAdmin(entry.tick ?? '-') + ' · HTTP ' + escapeAdmin(entry.statusCode ?? '-') + ' · ' + escapeAdmin(entry.durationMs ?? 0) + ' ms</small></div>' +
      '<span>' + escapeAdmin(entry.error || 'request_failed') + '</span>' +
    '</div>'
  )).join('');
}

function clearAdminFilters() {
  setAdminValue('adminMethodFilter', '');
  setAdminValue('adminStatusFilter', '');
  setAdminValue('adminPathFilter', '');
  persistAdminConsoleOptions();
  if (ADMIN_UI.snapshot) renderAdminAudit(ADMIN_UI.snapshot.audit?.log || []);
}

function setAdminStatus(state) {
  const badge = document.getElementById('adminConsoleStatus');
  if (!badge) return;
  badge.textContent = state;
  badge.className = 'admin-console-status ' + state;
}

function renderAdminError(error) {
  const message = error?.message || String(error);
  const forbidden = message.includes(' 401 ') || message.includes(' 403 ');
  setAdminStatus(forbidden ? 'restricted' : 'error');
  const metrics = document.getElementById('adminMetrics');
  if (metrics) {
    metrics.innerHTML = '<div class="admin-access-message"><strong>' +
      (forbidden ? '需要 GM/admin 权限' : '运维数据加载失败') +
      '</strong><span>' + escapeAdmin(message) + '</span></div>';
  }
  const raw = document.getElementById('adminConsoleRaw');
  if (raw) raw.textContent = message;
  if (typeof window.log === 'function') window.log('GM 控制台：' + message);
}

async function adminRequest(pathname) {
  const headers = { 'Content-Type': 'application/json' };
  const token = document.getElementById('tokenBox')?.value?.trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(pathname, { headers });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text || '{}'); }
  catch (_error) { json = { ok: false, error: text || 'invalid_json' }; }
  if (!response.ok) throw new Error('GET ' + pathname + ' ' + response.status + ' ' + (json.error || 'error'));
  return json;
}

function setAdminValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function adminValue(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function escapeAdmin(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

window.refreshAdminConsole = refreshAdminConsole;
