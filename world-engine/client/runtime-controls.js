'use strict';

const LOOP_UI = {
  timer: null,
  busy: false,
  summary: null,
};

window.addEventListener('DOMContentLoaded', () => {
  mountRuntimeLoopPanel();
  bindRuntimeLoopControls();
  restoreRuntimeLoopOptions();
  refreshRuntimeLoop().catch(() => {});
  LOOP_UI.timer = setInterval(() => {
    if (!document.hidden) refreshRuntimeLoop().catch(() => {});
  }, 3000);
});

function mountRuntimeLoopPanel() {
  if (document.getElementById('runtimeLoopPanel')) return;
  const worldPanel = document.getElementById('worldMetrics')?.closest('.panel');
  const panel = document.createElement('section');
  panel.id = 'runtimeLoopPanel';
  panel.className = 'panel wide runtime-loop-panel';
  panel.innerHTML = [
    '<div class="section-title">',
    '  <div><h2>持续世界运行</h2><p class="hint">让世界在本地后台持续推进，并按 tick 自动存档。</p></div>',
    '  <span id="runtimeLoopStatus" class="loop-state stopped">stopped</span>',
    '</div>',
    '<div class="grid four loop-config-grid">',
    '  <label>循环间隔（毫秒）<input id="loopIntervalMs" type="number" min="10" value="1000" /></label>',
    '  <label>每轮 tick<input id="loopTicksPerCycle" type="number" min="1" value="1" /></label>',
    '  <label>自动存档间隔（tick）<input id="loopAutosaveEvery" type="number" min="0" value="25" /></label>',
    '  <label>自动存档路径<input id="loopAutosavePath" value="world-engine/output/live-world-save.json" /></label>',
    '</div>',
    '<div class="actions">',
    '  <button id="loopStartBtn" class="primary">开始持续运行</button>',
    '  <button id="loopPauseBtn">暂停</button>',
    '  <button id="loopStepBtn">单步 1 tick</button>',
    '  <button id="loopStopBtn" class="danger">停止</button>',
    '  <button id="loopConfigBtn">应用配置</button>',
    '  <button id="loopRefreshBtn">刷新状态</button>',
    '</div>',
    '<div id="runtimeLoopMetrics" class="metric-grid loop-metrics"></div>',
    '<pre id="runtimeLoopRaw">等待运行状态</pre>',
  ].join('');
  if (worldPanel?.nextSibling) worldPanel.parentNode.insertBefore(panel, worldPanel.nextSibling);
  else document.querySelector('main')?.appendChild(panel);
}

function bindRuntimeLoopControls() {
  bindLoopButton('loopStartBtn', startRuntimeLoopFromClient);
  bindLoopButton('loopPauseBtn', pauseRuntimeLoopFromClient);
  bindLoopButton('loopStepBtn', stepRuntimeLoopFromClient);
  bindLoopButton('loopStopBtn', stopRuntimeLoopFromClient);
  bindLoopButton('loopConfigBtn', configureRuntimeLoopFromClient);
  bindLoopButton('loopRefreshBtn', refreshRuntimeLoop);
  for (const id of ['loopIntervalMs', 'loopTicksPerCycle', 'loopAutosaveEvery', 'loopAutosavePath']) {
    document.getElementById(id)?.addEventListener('change', persistRuntimeLoopOptions);
  }
}

function bindLoopButton(id, fn) {
  document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await fn();
    } catch (error) {
      renderLoopError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function restoreRuntimeLoopOptions() {
  setValue('loopIntervalMs', localStorage.getItem('mud_loop_interval') || '1000');
  setValue('loopTicksPerCycle', localStorage.getItem('mud_loop_ticks') || '1');
  setValue('loopAutosaveEvery', localStorage.getItem('mud_loop_autosave_every') || '25');
  setValue('loopAutosavePath', localStorage.getItem('mud_loop_autosave_path') || 'world-engine/output/live-world-save.json');
}

function persistRuntimeLoopOptions() {
  localStorage.setItem('mud_loop_interval', valueOf('loopIntervalMs'));
  localStorage.setItem('mud_loop_ticks', valueOf('loopTicksPerCycle'));
  localStorage.setItem('mud_loop_autosave_every', valueOf('loopAutosaveEvery'));
  localStorage.setItem('mud_loop_autosave_path', valueOf('loopAutosavePath'));
}

function loopOptions() {
  persistRuntimeLoopOptions();
  return {
    intervalMs: Math.max(10, Number(valueOf('loopIntervalMs') || 1000)),
    ticksPerCycle: Math.max(1, Number(valueOf('loopTicksPerCycle') || 1)),
    autosaveEveryTicks: Math.max(0, Number(valueOf('loopAutosaveEvery') || 0)),
    autosavePath: valueOf('loopAutosavePath') || null,
  };
}

async function refreshRuntimeLoop() {
  if (LOOP_UI.busy) return LOOP_UI.summary;
  LOOP_UI.busy = true;
  try {
    const json = await runtimeRequest('/admin/loop');
    renderRuntimeLoop(json.data);
    return json.data;
  } finally {
    LOOP_UI.busy = false;
  }
}

async function configureRuntimeLoopFromClient() {
  const json = await runtimeRequest('/admin/loop/config', 'POST', { options: loopOptions() });
  renderRuntimeLoop(json.data);
  notifyLoop('持续运行配置已更新', true);
  return json.data;
}

async function startRuntimeLoopFromClient() {
  const json = await runtimeRequest('/admin/loop/start', 'POST', { options: loopOptions() });
  renderRuntimeLoop(json.data);
  notifyLoop('世界已开始持续运行', true);
  return json.data;
}

async function pauseRuntimeLoopFromClient() {
  const json = await runtimeRequest('/admin/loop/pause', 'POST', { reason: 'browser_pause' });
  renderRuntimeLoop(json.data);
  notifyLoop('持续运行已暂停', true);
  return json.data;
}

async function stopRuntimeLoopFromClient() {
  const json = await runtimeRequest('/admin/loop/stop', 'POST', { reason: 'browser_stop' });
  renderRuntimeLoop(json.data);
  notifyLoop('持续运行已停止', true);
  return json.data;
}

async function stepRuntimeLoopFromClient() {
  const json = await runtimeRequest('/admin/loop/step', 'POST', { ticks: 1 });
  renderRuntimeLoop(json.data.summary);
  notifyLoop('世界已单步推进 1 tick', true);
  if (typeof window.refreshAll === 'function') await window.refreshAll();
  return json.data;
}

function renderRuntimeLoop(summary) {
  LOOP_UI.summary = summary || {};
  const state = summary?.status || 'unknown';
  const badge = document.getElementById('runtimeLoopStatus');
  if (badge) {
    badge.textContent = state;
    badge.className = `loop-state ${state}`;
  }
  const metrics = [
    ['tick', summary?.tick ?? '-'],
    ['cycles', summary?.cycles ?? 0],
    ['ticks run', summary?.ticksRun ?? 0],
    ['interval ms', summary?.intervalMs ?? '-'],
    ['ticks/cycle', summary?.ticksPerCycle ?? '-'],
    ['last ms', summary?.lastDurationMs ?? 0],
    ['errors', summary?.errorCount ?? 0],
    ['autosave tick', summary?.lastAutosaveTick ?? '-'],
  ];
  const container = document.getElementById('runtimeLoopMetrics');
  if (container) {
    container.innerHTML = metrics.map(([label, value]) => `<div class="metric"><strong>${escapeLoop(value)}</strong><span>${escapeLoop(label)}</span></div>`).join('');
  }
  const raw = document.getElementById('runtimeLoopRaw');
  if (raw) raw.textContent = JSON.stringify(summary, null, 2);
  document.body.dataset.runtimeLoop = state;
}

function renderLoopError(error) {
  const message = error?.message || String(error);
  const raw = document.getElementById('runtimeLoopRaw');
  if (raw) raw.textContent = message;
  notifyLoop(message.includes('403') ? '需要 GM/admin 权限控制持续运行' : message, false);
}

async function runtimeRequest(pathname, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = document.getElementById('tokenBox')?.value?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text || '{}'); }
  catch (_error) { json = { ok: false, error: text || 'invalid_json' }; }
  if (!response.ok) throw new Error(`${method} ${pathname} ${response.status} ${json.error || 'error'}`);
  return json;
}

function notifyLoop(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log(message);
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function valueOf(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function escapeLoop(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

window.refreshRuntimeLoop = refreshRuntimeLoop;
