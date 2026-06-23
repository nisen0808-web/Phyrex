'use strict';

const WORLD_INSIGHTS_UI = {
  snapshot: null,
  view: null,
  busy: false,
  timer: null,
  refreshWrapped: false,
};

window.addEventListener('DOMContentLoaded', () => {
  mountWorldInsights();
  restoreWorldInsightsOptions();
  bindWorldInsightsControls();
  wrapWorldInsightsRefresh();
  refreshWorldInsights().catch(() => {});
  configureWorldInsightsAutoRefresh();
});

function mountWorldInsights() {
  if (document.getElementById('worldInsightsPanel')) return;
  const anchor = document.getElementById('worldTemplatePanel')
    || document.getElementById('runtimeLoopPanel')
    || document.getElementById('worldMetrics')?.closest('.panel');
  const panel = document.createElement('section');
  panel.id = 'worldInsightsPanel';
  panel.className = 'panel wide world-insights-panel';
  panel.innerHTML = [
    '<div class="section-title">',
    '  <div><h2>世界洞察 / 排行榜</h2><p class="hint">从世界快照聚合人口、势力、文明、活动和运行诊断。</p></div>',
    '  <span id="worldInsightsStatus" class="world-insights-status idle">idle</span>',
    '</div>',
    '<div class="actions world-insights-actions">',
    '  <button id="refreshWorldInsightsBtn" class="primary">刷新洞察</button>',
    '  <button id="copyWorldInsightsBtn">复制摘要</button>',
    '  <button id="exportWorldSnapshotBtn">导出快照 JSON</button>',
    '  <label>排行榜<select id="worldInsightsRanking"><option value="entities">实体</option><option value="cities">城市</option><option value="organizations">组织</option><option value="civilizations">文明</option></select></label>',
    '  <label>刷新间隔<select id="worldInsightsRefreshSeconds"><option value="10">10 秒</option><option value="30" selected>30 秒</option><option value="60">60 秒</option></select></label>',
    '  <label class="inline-control"><input id="worldInsightsAutoRefresh" type="checkbox" />自动刷新</label>',
    '</div>',
    '<div id="worldInsightsMetrics" class="metric-grid world-insights-metrics"></div>',
    '<div class="world-insights-grid">',
    '  <section class="world-insights-card"><div class="world-insights-card-title"><h3>人口分布</h3><span id="worldInsightsLocationCount" class="badge">0</span></div><div id="worldInsightsLocations" class="world-insights-bars"><div class="empty">等待人口数据</div></div></section>',
    '  <section class="world-insights-card"><div class="world-insights-card-title"><h3 id="worldInsightsRankingTitle">实体排行</h3><span id="worldInsightsRankingCount" class="badge">0</span></div><div id="worldInsightsRankings" class="world-insights-ranking"><div class="empty">等待排行数据</div></div></section>',
    '</div>',
    '<section class="world-insights-card world-insights-activity-card">',
    '  <div class="world-insights-card-title"><h3>最近活动</h3><span id="worldInsightsActivityCount" class="badge">0</span></div>',
    '  <div class="grid two world-insights-filters"><label>搜索<input id="worldInsightsActivityQuery" placeholder="标题、摘要、类型" /></label><label>来源<select id="worldInsightsActivitySource"><option value="all">全部</option><option value="journal">日志</option><option value="encounter">遭遇</option><option value="command">命令</option><option value="report">报告</option></select></label></div>',
    '  <div id="worldInsightsActivity" class="world-insights-activity"><div class="empty">等待活动数据</div></div>',
    '</section>',
    '<details class="world-insights-raw"><summary>运行诊断与原始快照</summary><pre id="worldInsightsRaw">等待世界快照</pre></details>',
  ].join('');

  if (anchor?.nextSibling) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.querySelector('main')?.appendChild(panel);
}

function bindWorldInsightsControls() {
  bindWorldInsightsButton('refreshWorldInsightsBtn', refreshWorldInsights);
  bindWorldInsightsButton('copyWorldInsightsBtn', copyWorldInsightsSummary);
  bindWorldInsightsButton('exportWorldSnapshotBtn', exportWorldSnapshot);
  document.getElementById('worldInsightsRanking')?.addEventListener('change', () => {
    persistWorldInsightsOptions();
    renderWorldInsightsRankings();
  });
  document.getElementById('worldInsightsActivityQuery')?.addEventListener('input', renderWorldInsightsActivity);
  document.getElementById('worldInsightsActivitySource')?.addEventListener('change', () => {
    persistWorldInsightsOptions();
    renderWorldInsightsActivity();
  });
  document.getElementById('worldInsightsAutoRefresh')?.addEventListener('change', configureWorldInsightsAutoRefresh);
  document.getElementById('worldInsightsRefreshSeconds')?.addEventListener('change', configureWorldInsightsAutoRefresh);
}

function bindWorldInsightsButton(id, handler) {
  document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      renderWorldInsightsError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function restoreWorldInsightsOptions() {
  setWorldInsightsValue('worldInsightsRanking', localStorage.getItem('mud_world_insights_ranking') || 'entities');
  setWorldInsightsValue('worldInsightsActivitySource', localStorage.getItem('mud_world_insights_activity_source') || 'all');
  setWorldInsightsValue('worldInsightsRefreshSeconds', localStorage.getItem('mud_world_insights_refresh_seconds') || '30');
  const auto = document.getElementById('worldInsightsAutoRefresh');
  if (auto) auto.checked = localStorage.getItem('mud_world_insights_auto_refresh') === 'true';
}

function persistWorldInsightsOptions() {
  localStorage.setItem('mud_world_insights_ranking', worldInsightsValue('worldInsightsRanking'));
  localStorage.setItem('mud_world_insights_activity_source', worldInsightsValue('worldInsightsActivitySource'));
  localStorage.setItem('mud_world_insights_refresh_seconds', worldInsightsValue('worldInsightsRefreshSeconds'));
  localStorage.setItem('mud_world_insights_auto_refresh', String(Boolean(document.getElementById('worldInsightsAutoRefresh')?.checked)));
}

function configureWorldInsightsAutoRefresh() {
  if (WORLD_INSIGHTS_UI.timer) clearInterval(WORLD_INSIGHTS_UI.timer);
  WORLD_INSIGHTS_UI.timer = null;
  persistWorldInsightsOptions();
  if (!document.getElementById('worldInsightsAutoRefresh')?.checked) return;
  const seconds = Math.max(10, Number(worldInsightsValue('worldInsightsRefreshSeconds') || 30));
  WORLD_INSIGHTS_UI.timer = setInterval(() => {
    if (!document.hidden) refreshWorldInsights().catch(() => {});
  }, seconds * 1000);
}

function wrapWorldInsightsRefresh() {
  if (WORLD_INSIGHTS_UI.refreshWrapped || typeof window.refreshAll !== 'function') return;
  const original = window.refreshAll;
  window.refreshAll = async function refreshAllWithWorldInsights(...args) {
    const result = await original(...args);
    await refreshWorldInsights().catch(() => {});
    return result;
  };
  WORLD_INSIGHTS_UI.refreshWrapped = true;
}

async function refreshWorldInsights() {
  if (WORLD_INSIGHTS_UI.busy) return WORLD_INSIGHTS_UI.view;
  WORLD_INSIGHTS_UI.busy = true;
  setWorldInsightsStatus('loading');
  try {
    const json = await worldInsightsRequest('/snapshot');
    WORLD_INSIGHTS_UI.snapshot = json.data || {};
    WORLD_INSIGHTS_UI.view = worldInsightsModel().buildInsightView(WORLD_INSIGHTS_UI.snapshot, {
      locationLimit: 20,
      rankingLimit: 12,
      activityLimit: 40,
    });
    renderWorldInsights();
    setWorldInsightsStatus('ready');
    return WORLD_INSIGHTS_UI.view;
  } catch (error) {
    renderWorldInsightsError(error);
    throw error;
  } finally {
    WORLD_INSIGHTS_UI.busy = false;
  }
}

function renderWorldInsights() {
  const view = WORLD_INSIGHTS_UI.view;
  if (!view) return;
  renderWorldInsightsMetrics(view);
  renderWorldInsightsLocations(view.locations || []);
  renderWorldInsightsRankings();
  renderWorldInsightsActivity();
  const raw = document.getElementById('worldInsightsRaw');
  if (raw) raw.textContent = JSON.stringify({ diagnostics: view.diagnostics, snapshot: WORLD_INSIGHTS_UI.snapshot }, null, 2);
}

function renderWorldInsightsMetrics(view) {
  const values = [
    ['tick', view.world.tick ?? '-'],
    ['alive', `${view.metrics.alive}/${view.metrics.population}`],
    ['avg power', formatWorldInsightsNumber(view.metrics.averagePower)],
    ['avg happiness', formatWorldInsightsNumber(view.metrics.averageHappiness)],
    ['players', view.metrics.players],
    ['quests', `${view.metrics.activeQuests}/${view.metrics.quests}`],
    ['commands', view.metrics.commands],
    ['items', view.metrics.items],
    ['shops', view.metrics.shops],
  ];
  const container = document.getElementById('worldInsightsMetrics');
  if (container) {
    container.innerHTML = values.map(([label, value]) => (
      '<div class="metric"><strong>' + escapeWorldInsights(value) + '</strong><span>' + escapeWorldInsights(label) + '</span></div>'
    )).join('');
  }
}

function renderWorldInsightsLocations(locations) {
  const count = document.getElementById('worldInsightsLocationCount');
  if (count) count.textContent = String(locations.length);
  const container = document.getElementById('worldInsightsLocations');
  if (!container) return;
  if (!locations.length) {
    container.innerHTML = '<div class="empty">暂无地点人口数据</div>';
    return;
  }
  const maximum = Math.max(1, ...locations.map(item => Number(item.value || 0)));
  container.innerHTML = locations.map(item => {
    const width = Math.max(item.value > 0 ? 5 : 0, Math.round(Number(item.value || 0) / maximum * 100));
    return '<div class="world-insights-bar-row"><div class="world-insights-bar-label"><strong>' + escapeWorldInsights(item.name) + '</strong><span>' + escapeWorldInsights(item.value) + ' · ' + escapeWorldInsights(formatWorldInsightsPercent(item.share)) + '</span></div>' +
      '<div class="world-insights-bar"><i style="width:' + width + '%"></i></div></div>';
  }).join('');
}

function renderWorldInsightsRankings() {
  const view = WORLD_INSIGHTS_UI.view;
  if (!view) return;
  const category = worldInsightsValue('worldInsightsRanking') || 'entities';
  const names = {
    entities: '实体排行',
    cities: '城市排行',
    organizations: '组织排行',
    civilizations: '文明排行',
  };
  const items = view.rankings?.[category] || [];
  const title = document.getElementById('worldInsightsRankingTitle');
  if (title) title.textContent = names[category] || '排行';
  const count = document.getElementById('worldInsightsRankingCount');
  if (count) count.textContent = String(items.length);
  const container = document.getElementById('worldInsightsRankings');
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="empty">当前类别没有排行数据</div>';
    return;
  }
  container.innerHTML = items.map((item, index) => (
    '<div class="world-insights-rank-row"><span class="world-insights-rank-index">' + (index + 1) + '</span><div><strong>' + escapeWorldInsights(item.name) + '</strong><small>' + escapeWorldInsights(item.subtitle || item.id) + '</small></div><span class="world-insights-rank-score">' + escapeWorldInsights(formatWorldInsightsNumber(item.score)) + '</span></div>'
  )).join('');
}

function renderWorldInsightsActivity() {
  const view = WORLD_INSIGHTS_UI.view;
  if (!view) return;
  const query = document.getElementById('worldInsightsActivityQuery')?.value || '';
  const source = worldInsightsValue('worldInsightsActivitySource') || 'all';
  const items = worldInsightsModel().filterActivity(view.activity || [], query, source);
  const count = document.getElementById('worldInsightsActivityCount');
  if (count) count.textContent = String(items.length);
  const container = document.getElementById('worldInsightsActivity');
  if (!container) return;
  if (!items.length) {
    container.innerHTML = '<div class="empty">没有符合条件的活动</div>';
    return;
  }
  container.innerHTML = items.map(item => (
    '<article class="world-insights-activity-item"><span class="world-insights-source ' + attributeWorldInsights(item.source) + '">' + escapeWorldInsights(worldInsightsSourceName(item.source)) + '</span><div><strong>' + escapeWorldInsights(item.title) + '</strong><p>' + escapeWorldInsights(item.summary || '-') + '</p></div><small>' + escapeWorldInsights(formatWorldInsightsTick(item.tick)) + '</small></article>'
  )).join('');
}

async function copyWorldInsightsSummary() {
  if (!WORLD_INSIGHTS_UI.view) await refreshWorldInsights();
  const text = worldInsightsModel().createTextSummary(WORLD_INSIGHTS_UI.view);
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
  else fallbackCopyWorldInsights(text);
  notifyWorldInsights('世界洞察摘要已复制', true);
  return text;
}

function fallbackCopyWorldInsights(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function exportWorldSnapshot() {
  if (!WORLD_INSIGHTS_UI.snapshot) await refreshWorldInsights();
  const worldId = WORLD_INSIGHTS_UI.view?.world?.id || 'world';
  const tick = WORLD_INSIGHTS_UI.view?.world?.tick ?? 0;
  const fileName = sanitizeWorldInsightsFile(worldId) + '-tick-' + tick + '-snapshot.json';
  const blob = new Blob([JSON.stringify(WORLD_INSIGHTS_UI.snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  notifyWorldInsights('世界快照已导出：' + fileName, true);
  return fileName;
}

async function worldInsightsRequest(pathname) {
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

function setWorldInsightsStatus(state) {
  const status = document.getElementById('worldInsightsStatus');
  if (!status) return;
  status.textContent = state;
  status.className = 'world-insights-status ' + state;
}

function renderWorldInsightsError(error) {
  const message = error?.message || String(error);
  setWorldInsightsStatus('error');
  const container = document.getElementById('worldInsightsActivity');
  if (container) container.innerHTML = '<div class="world-insights-error"><strong>世界洞察加载失败</strong><span>' + escapeWorldInsights(message) + '</span></div>';
  notifyWorldInsights(message, false);
}

function worldInsightsSourceName(source) {
  return ({ journal: '日志', encounter: '遭遇', command: '命令', report: '报告' })[source] || source;
}

function formatWorldInsightsTick(value) {
  if (value === undefined || value === null || value === '') return '-';
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return 'tick ' + numeric;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatWorldInsightsNumber(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1000000) return (number / 1000000).toFixed(1) + 'm';
  if (Math.abs(number) >= 1000) return (number / 1000).toFixed(1) + 'k';
  return String(Math.round(number * 100) / 100);
}

function formatWorldInsightsPercent(value) {
  return (Number(value || 0) * 100).toFixed(1) + '%';
}

function sanitizeWorldInsightsFile(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function notifyWorldInsights(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log('世界洞察：' + message);
}

function worldInsightsModel() {
  if (!window.MudWorldInsights) throw new Error('世界洞察模型未加载');
  return window.MudWorldInsights;
}

function setWorldInsightsValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function worldInsightsValue(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function escapeWorldInsights(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributeWorldInsights(value) {
  return escapeWorldInsights(value).replace(/'/g, '&#39;');
}

window.refreshWorldInsights = refreshWorldInsights;
window.copyWorldInsightsSummary = copyWorldInsightsSummary;
window.exportWorldSnapshot = exportWorldSnapshot;
