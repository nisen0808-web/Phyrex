'use strict';

const SAVE_UI = {
  timer: null,
  busy: false,
  saves: [],
  loop: null,
};

window.addEventListener('DOMContentLoaded', () => {
  mountSaveManager();
  restoreSaveManagerOptions();
  bindSaveManagerControls();
  refreshSaveManager().catch(() => {});
  configureSaveManagerAutoRefresh();
});

function mountSaveManager() {
  if (document.getElementById('saveManagerPanel')) return;
  const anchor = document.getElementById('adminConsolePanel')
    || document.getElementById('runtimeLoopPanel')
    || document.getElementById('worldMetrics')?.closest('.panel');
  const panel = document.createElement('section');
  panel.id = 'saveManagerPanel';
  panel.className = 'panel wide save-manager-panel';
  panel.innerHTML = [
    '<div class="section-title">',
    '  <div><h2>本地存档管理</h2><p class="hint">创建带名称和备注的存档，浏览元数据，并在确认后恢复世界。</p></div>',
    '  <span id="saveManagerStatus" class="save-manager-status idle">idle</span>',
    '</div>',
    '<div class="grid four save-manager-grid">',
    '  <label>存档路径<input id="managedSavePath" value="world-engine/output/local-client-save.json" /></label>',
    '  <label>存档目录<input id="saveDirectory" value="world-engine/output" /></label>',
    '  <label>显示名称<input id="saveLabel" placeholder="例如：进入迷雾森林前" /></label>',
    '  <label>刷新间隔<select id="saveRefreshSeconds"><option value="10" selected>10 秒</option><option value="30">30 秒</option><option value="60">60 秒</option></select></label>',
    '</div>',
    '<label class="save-notes-label">备注<textarea id="saveNotes" rows="2" placeholder="记录这个存档的目的或当前进度"></textarea></label>',
    '<div class="actions save-manager-actions">',
    '  <button id="managedSaveBtn" class="primary">保存为新存档</button>',
    '  <button id="generateSavePathBtn">生成新路径</button>',
    '  <button id="refreshSaveListBtn">刷新存档列表</button>',
    '  <label class="inline-control"><input id="saveAutoRefresh" type="checkbox" />自动刷新</label>',
    '</div>',
    '<div id="saveAutosaveStatus" class="save-autosave-status"><div class="empty">等待自动存档状态</div></div>',
    '<div class="save-list-heading"><h3>已有存档</h3><span id="saveListCount" class="badge">0</span></div>',
    '<div id="saveList" class="save-list"><div class="empty">等待存档列表</div></div>',
  ].join('');

  if (anchor?.nextSibling) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.querySelector('main')?.appendChild(panel);
}

function bindSaveManagerControls() {
  bindSaveManagerButton('managedSaveBtn', createManagedSave);
  bindSaveManagerButton('generateSavePathBtn', generateManagedSavePath);
  bindSaveManagerButton('refreshSaveListBtn', refreshSaveManager);
  document.getElementById('saveAutoRefresh')?.addEventListener('change', configureSaveManagerAutoRefresh);
  document.getElementById('saveRefreshSeconds')?.addEventListener('change', configureSaveManagerAutoRefresh);
  document.getElementById('managedSavePath')?.addEventListener('change', () => {
    syncManagedPath();
    persistSaveManagerOptions();
  });
  for (const id of ['saveDirectory', 'saveLabel', 'saveNotes']) {
    document.getElementById(id)?.addEventListener('change', persistSaveManagerOptions);
  }
  document.addEventListener('click', handleSaveManagerActionClick);
}

function bindSaveManagerButton(id, handler) {
  document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      renderSaveManagerError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function restoreSaveManagerOptions() {
  const quickPath = document.getElementById('savePath')?.value?.trim()
    || 'world-engine/output/local-client-save.json';
  const managedPath = localStorage.getItem('mud_managed_save_path') || quickPath;
  setSaveManagerValue('managedSavePath', managedPath);
  setSaveManagerValue(
    'saveDirectory',
    localStorage.getItem('mud_save_directory') || directoryOfSavePath(managedPath),
  );
  setSaveManagerValue('saveLabel', localStorage.getItem('mud_save_label') || '');
  setSaveManagerValue('saveNotes', localStorage.getItem('mud_save_notes') || '');
  setSaveManagerValue('saveRefreshSeconds', localStorage.getItem('mud_save_refresh_seconds') || '10');
  const auto = document.getElementById('saveAutoRefresh');
  if (auto) auto.checked = localStorage.getItem('mud_save_auto_refresh') === 'true';
  setManagedPath(managedPath);
}

function persistSaveManagerOptions() {
  localStorage.setItem('mud_managed_save_path', saveManagerValue('managedSavePath'));
  localStorage.setItem('mud_save_directory', saveManagerValue('saveDirectory'));
  localStorage.setItem('mud_save_label', saveManagerValue('saveLabel'));
  localStorage.setItem('mud_save_notes', saveManagerValue('saveNotes'));
  localStorage.setItem('mud_save_refresh_seconds', saveManagerValue('saveRefreshSeconds'));
  localStorage.setItem(
    'mud_save_auto_refresh',
    String(Boolean(document.getElementById('saveAutoRefresh')?.checked)),
  );
}

function configureSaveManagerAutoRefresh() {
  if (SAVE_UI.timer) clearInterval(SAVE_UI.timer);
  SAVE_UI.timer = null;
  persistSaveManagerOptions();
  if (!document.getElementById('saveAutoRefresh')?.checked) return;
  const seconds = Math.max(10, Number(saveManagerValue('saveRefreshSeconds') || 10));
  SAVE_UI.timer = setInterval(() => {
    if (!document.hidden) refreshSaveManager().catch(() => {});
  }, seconds * 1000);
}

async function refreshSaveManager() {
  if (SAVE_UI.busy) return SAVE_UI.saves;
  SAVE_UI.busy = true;
  setSaveManagerStatus('loading');
  try {
    const directory = saveManagerValue('saveDirectory') || 'world-engine/output';
    const savesResponse = await saveManagerRequest('/saves?dir=' + encodeURIComponent(directory));
    let loop = null;
    try {
      const loopResponse = await saveManagerRequest('/admin/loop');
      loop = loopResponse.data || {};
    } catch (error) {
      loop = { restricted: true, error: error.message };
    }
    SAVE_UI.saves = savesResponse.data?.saves || [];
    SAVE_UI.loop = loop;
    renderSaveList(SAVE_UI.saves);
    renderSaveAutosaveStatus(loop);
    setSaveManagerStatus('ready');
    return SAVE_UI.saves;
  } catch (error) {
    renderSaveManagerError(error);
    throw error;
  } finally {
    SAVE_UI.busy = false;
  }
}

async function createManagedSave() {
  const filePath = saveManagerValue('managedSavePath');
  if (!filePath) throw new Error('请输入存档路径');
  syncManagedPath();
  persistSaveManagerOptions();
  const label = saveManagerValue('saveLabel');
  const notes = saveManagerValue('saveNotes');
  const json = await saveManagerRequest('/save', 'POST', {
    filePath,
    options: {
      createBackup: true,
      metadata: {
        label: label || null,
        notes: notes || null,
        source: 'browser_save_manager',
      },
    },
  });
  if (typeof window.show === 'function') window.show(json);
  notifySaveManager('存档已创建：' + fileNameOfSavePath(filePath), true);
  await refreshSaveManager();
  return json;
}

function generateManagedSavePath() {
  const directory = saveManagerValue('saveDirectory') || 'world-engine/output';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const filePath = joinSavePath(directory, 'manual-save-' + stamp + '.json');
  setManagedPath(filePath);
  persistSaveManagerOptions();
  notifySaveManager('已生成新存档路径', true);
  return filePath;
}

async function handleSaveManagerActionClick(event) {
  const selectButton = event.target.closest('[data-save-select]');
  if (selectButton) {
    event.preventDefault();
    setManagedPath(selectButton.dataset.saveSelect);
    persistSaveManagerOptions();
    notifySaveManager('已选择存档路径', true);
    return;
  }

  const loadButton = event.target.closest('[data-save-load]');
  if (!loadButton) return;
  event.preventDefault();
  const filePath = loadButton.dataset.saveLoad;
  const label = loadButton.dataset.saveLabel || fileNameOfSavePath(filePath);
  const confirmed = typeof window.confirm !== 'function'
    || window.confirm('读取“' + label + '”将替换当前世界状态。继续？');
  if (!confirmed) return;

  loadButton.disabled = true;
  try {
    const json = await saveManagerRequest('/load', 'POST', { filePath });
    setManagedPath(filePath);
    persistSaveManagerOptions();
    if (typeof window.show === 'function') window.show(json);
    if (typeof window.refreshAll === 'function') await window.refreshAll();
    notifySaveManager('世界已从存档恢复', true);
    await refreshSaveManager();
  } catch (error) {
    renderSaveManagerError(error);
  } finally {
    loadButton.disabled = false;
  }
}

function renderSaveList(saves) {
  const count = document.getElementById('saveListCount');
  if (count) count.textContent = String(saves.length);
  const container = document.getElementById('saveList');
  if (!container) return;
  if (!saves.length) {
    container.innerHTML = '<div class="empty">当前目录没有 JSON 存档</div>';
    return;
  }

  container.innerHTML = saves.map(save => {
    if (save.unreadable) {
      return '<div class="save-card unreadable"><div><strong>' + escapeSave(save.name) +
        '</strong><small>无法读取存档头信息</small></div></div>';
    }
    const metadata = save.metadata || {};
    const label = save.label || metadata.label || save.name;
    const notes = metadata.notes || metadata.note || '';
    const badges = [
      'world ' + (save.worldId || '-'),
      'tick ' + (save.tick ?? '-'),
      'schema ' + (save.schemaVersion ?? '-'),
      save.reason || metadata.reason || 'manual',
      formatSaveBytes(save.size),
    ];
    return '<div class="save-card">' +
      '<div class="save-card-main"><strong>' + escapeSave(label) + '</strong>' +
      '<small>' + escapeSave(save.name) + ' · ' + escapeSave(formatSaveDate(save.savedAt || save.mtimeMs)) + '</small>' +
      (notes ? '<p>' + escapeSave(notes) + '</p>' : '') +
      '<div class="badge-row">' + badges.map(value => '<span class="badge">' + escapeSave(value) + '</span>').join('') + '</div></div>' +
      '<div class="save-card-actions">' +
      '<button class="small" data-save-select="' + attributeSave(save.file) + '">选择路径</button>' +
      '<button class="small primary" data-save-load="' + attributeSave(save.file) + '" data-save-label="' + attributeSave(label) + '">读取</button>' +
      '</div></div>';
  }).join('');
}

function renderSaveAutosaveStatus(loop) {
  const container = document.getElementById('saveAutosaveStatus');
  if (!container) return;
  if (loop?.restricted) {
    container.innerHTML = '<div class="save-autosave-card restricted"><strong>自动存档状态受限</strong><small>需要 GM/admin 权限读取持续运行配置。</small></div>';
    return;
  }
  const every = Number(loop?.autosaveEveryTicks || 0);
  const file = loop?.autosavePath || null;
  const enabled = every > 0 && Boolean(file);
  const last = loop?.lastAutosave || null;
  container.innerHTML = '<div class="save-autosave-card ' + (enabled ? 'enabled' : 'disabled') + '">' +
    '<div><strong>' + (enabled ? '持续运行自动存档已启用' : '持续运行自动存档未启用') + '</strong>' +
    '<small>loop ' + escapeSave(loop?.status || 'unknown') + ' · 当前 tick ' + escapeSave(loop?.tick ?? '-') + '</small></div>' +
    '<div class="save-autosave-meta">' +
    '<span>间隔：' + escapeSave(enabled ? every + ' tick' : '-') + '</span>' +
    '<span>路径：' + escapeSave(file || '-') + '</span>' +
    '<span>最近 tick：' + escapeSave(loop?.lastAutosaveTick ?? '-') + '</span>' +
    '<span>最近时间：' + escapeSave(formatSaveDate(last?.savedAt)) + '</span>' +
    '</div></div>';
}

function syncManagedPath() {
  const filePath = saveManagerValue('managedSavePath');
  setManagedPath(filePath);
  if (!saveManagerValue('saveDirectory')) setSaveManagerValue('saveDirectory', directoryOfSavePath(filePath));
}

function setManagedPath(filePath) {
  setSaveManagerValue('managedSavePath', filePath || '');
  const quickPath = document.getElementById('savePath');
  if (quickPath && filePath) quickPath.value = filePath;
  if (filePath) {
    localStorage.setItem('mud_managed_save_path', filePath);
    localStorage.setItem('mud_save_path', filePath);
  }
}

function setSaveManagerStatus(state) {
  const element = document.getElementById('saveManagerStatus');
  if (!element) return;
  element.textContent = state;
  element.className = 'save-manager-status ' + state;
}

function renderSaveManagerError(error) {
  const message = error?.message || String(error);
  const restricted = message.includes(' 401 ') || message.includes(' 403 ');
  setSaveManagerStatus(restricted ? 'restricted' : 'error');
  const container = document.getElementById('saveList');
  if (container) {
    container.innerHTML = '<div class="save-manager-error"><strong>' +
      (restricted ? '需要 GM/admin 权限' : '存档管理加载失败') +
      '</strong><span>' + escapeSave(message) + '</span></div>';
  }
  notifySaveManager(restricted ? '需要 GM/admin 权限管理存档' : message, false);
}

async function saveManagerRequest(pathname, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = document.getElementById('tokenBox')?.value?.trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text || '{}'); }
  catch (_error) { json = { ok: false, error: text || 'invalid_json' }; }
  if (!response.ok) throw new Error(method + ' ' + pathname + ' ' + response.status + ' ' + (json.error || 'error'));
  return json;
}

function notifySaveManager(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log(message);
}

function directoryOfSavePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : 'world-engine/output';
}

function fileNameOfSavePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function joinSavePath(directory, name) {
  return String(directory || '').replace(/[\\/]+$/, '') + '/' + String(name || '').replace(/^[\\/]+/, '');
}

function formatSaveBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatSaveDate(value) {
  if (value === undefined || value === null || value === '') return '-';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function setSaveManagerValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function saveManagerValue(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function escapeSave(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributeSave(value) {
  return escapeSave(value).replace(/'/g, '&#39;');
}

window.refreshSaveManager = refreshSaveManager;
