'use strict';

const TEMPLATE_UI = {
  templates: [],
  current: null,
  selectedId: null,
  busy: false,
};

window.addEventListener('DOMContentLoaded', () => {
  mountWorldTemplateManager();
  restoreWorldTemplateOptions();
  bindWorldTemplateControls();
  refreshWorldTemplates().catch(() => {});
});

function mountWorldTemplateManager() {
  if (document.getElementById('worldTemplatePanel')) return;
  const anchor = document.getElementById('saveManagerPanel')
    || document.getElementById('adminConsolePanel')
    || document.getElementById('runtimeLoopPanel')
    || document.getElementById('worldMetrics')?.closest('.panel');
  const panel = document.createElement('section');
  panel.id = 'worldTemplatePanel';
  panel.className = 'panel wide world-template-panel';
  panel.innerHTML = [
    '<div class="section-title">',
    '  <div><h2>世界模板管理</h2><p class="hint">查看内置世界模板，备份当前世界，并在确认后安全重置。</p></div>',
    '  <span id="worldTemplateStatus" class="world-template-status idle">idle</span>',
    '</div>',
    '<div id="currentTemplateSummary" class="current-template-summary"><div class="empty">等待世界模板状态</div></div>',
    '<div class="world-template-heading"><h3>可用模板</h3><span id="worldTemplateCount" class="badge">0</span></div>',
    '<div id="worldTemplateList" class="world-template-list"><div class="empty">等待模板列表</div></div>',
    '<div class="grid three world-template-options">',
    '  <label>新世界 ID<input id="templateWorldId" placeholder="留空使用模板默认值" /></label>',
    '  <label>初始化 tick<input id="templateSeedTicks" type="number" min="0" value="0" /></label>',
    '  <label>备份路径<input id="templateBackupPath" value="world-engine/output/template-reset-backup.json" /></label>',
    '</div>',
    '<div class="world-template-checks">',
    '  <label class="inline-control"><input id="templateBackupCurrent" type="checkbox" checked />重置前备份</label>',
    '  <label class="inline-control"><input id="templatePreserveAccounts" type="checkbox" checked />保留账号和 Session</label>',
    '  <label class="inline-control"><input id="templatePreserveAudit" type="checkbox" checked />保留 API 审计</label>',
    '  <label class="inline-control"><input id="templatePauseLoop" type="checkbox" checked />运行中自动暂停</label>',
    '  <label class="inline-control"><input id="templateRecreatePlayer" type="checkbox" checked />重建当前玩家和角色</label>',
    '</div>',
    '<div class="actions world-template-actions">',
    '  <button id="resetWorldTemplateBtn" class="danger">重置为所选模板</button>',
    '  <button id="recreateTemplatePlayerBtn">在当前世界重建玩家</button>',
    '  <button id="refreshWorldTemplatesBtn">刷新模板</button>',
    '</div>',
    '<div id="worldTemplateResult" class="world-template-result"><div class="empty">尚未执行模板操作</div></div>',
  ].join('');

  if (anchor?.nextSibling) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.querySelector('main')?.appendChild(panel);
}

function bindWorldTemplateControls() {
  bindWorldTemplateButton('refreshWorldTemplatesBtn', refreshWorldTemplates);
  bindWorldTemplateButton('resetWorldTemplateBtn', resetWorldFromSelectedTemplate);
  bindWorldTemplateButton('recreateTemplatePlayerBtn', recreatePlayerForCurrentTemplate);
  document.getElementById('worldTemplateList')?.addEventListener('click', event => {
    const button = event.target.closest('[data-template-id]');
    if (!button) return;
    selectWorldTemplate(button.dataset.templateId);
  });
  for (const id of [
    'templateWorldId',
    'templateSeedTicks',
    'templateBackupPath',
    'templateBackupCurrent',
    'templatePreserveAccounts',
    'templatePreserveAudit',
    'templatePauseLoop',
    'templateRecreatePlayer',
  ]) {
    document.getElementById(id)?.addEventListener('change', persistWorldTemplateOptions);
  }
}

function bindWorldTemplateButton(id, handler) {
  document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      renderWorldTemplateError(error);
    } finally {
      button.disabled = false;
    }
  });
}

function restoreWorldTemplateOptions() {
  setWorldTemplateValue('templateWorldId', localStorage.getItem('mud_template_world_id') || '');
  setWorldTemplateValue('templateSeedTicks', localStorage.getItem('mud_template_seed_ticks') || '0');
  setWorldTemplateValue(
    'templateBackupPath',
    localStorage.getItem('mud_template_backup_path') || 'world-engine/output/template-reset-backup.json',
  );
  setWorldTemplateChecked('templateBackupCurrent', localStorage.getItem('mud_template_backup') !== 'false');
  setWorldTemplateChecked('templatePreserveAccounts', localStorage.getItem('mud_template_preserve_accounts') !== 'false');
  setWorldTemplateChecked('templatePreserveAudit', localStorage.getItem('mud_template_preserve_audit') !== 'false');
  setWorldTemplateChecked('templatePauseLoop', localStorage.getItem('mud_template_pause_loop') !== 'false');
  setWorldTemplateChecked('templateRecreatePlayer', localStorage.getItem('mud_template_recreate_player') !== 'false');
  TEMPLATE_UI.selectedId = localStorage.getItem('mud_template_selected_id') || null;
}

function persistWorldTemplateOptions() {
  localStorage.setItem('mud_template_selected_id', TEMPLATE_UI.selectedId || '');
  localStorage.setItem('mud_template_world_id', worldTemplateValue('templateWorldId'));
  localStorage.setItem('mud_template_seed_ticks', worldTemplateValue('templateSeedTicks'));
  localStorage.setItem('mud_template_backup_path', worldTemplateValue('templateBackupPath'));
  localStorage.setItem('mud_template_backup', String(worldTemplateChecked('templateBackupCurrent')));
  localStorage.setItem('mud_template_preserve_accounts', String(worldTemplateChecked('templatePreserveAccounts')));
  localStorage.setItem('mud_template_preserve_audit', String(worldTemplateChecked('templatePreserveAudit')));
  localStorage.setItem('mud_template_pause_loop', String(worldTemplateChecked('templatePauseLoop')));
  localStorage.setItem('mud_template_recreate_player', String(worldTemplateChecked('templateRecreatePlayer')));
}

async function refreshWorldTemplates() {
  if (TEMPLATE_UI.busy) return TEMPLATE_UI.templates;
  TEMPLATE_UI.busy = true;
  setWorldTemplateStatus('loading');
  try {
    const json = await worldTemplateRequest('/admin/templates');
    TEMPLATE_UI.templates = json.data?.templates || [];
    TEMPLATE_UI.current = json.data?.current || null;
    if (!TEMPLATE_UI.templates.some(template => template.id === TEMPLATE_UI.selectedId)) {
      TEMPLATE_UI.selectedId = TEMPLATE_UI.current?.template?.id
        || TEMPLATE_UI.templates[0]?.id
        || null;
    }
    renderWorldTemplateList();
    renderCurrentTemplateSummary(TEMPLATE_UI.current, json.data?.loop || null);
    if (TEMPLATE_UI.selectedId) selectWorldTemplate(TEMPLATE_UI.selectedId, { preserveInputs: true });
    setWorldTemplateStatus('ready');
    persistWorldTemplateOptions();
    return TEMPLATE_UI.templates;
  } catch (error) {
    renderWorldTemplateError(error);
    throw error;
  } finally {
    TEMPLATE_UI.busy = false;
  }
}

function selectWorldTemplate(templateId, options = {}) {
  const template = TEMPLATE_UI.templates.find(item => item.id === templateId);
  if (!template) return null;
  TEMPLATE_UI.selectedId = template.id;
  document.querySelectorAll('[data-template-id]').forEach(element => {
    element.classList.toggle('selected', element.dataset.templateId === template.id);
    element.setAttribute('aria-pressed', String(element.dataset.templateId === template.id));
  });
  if (!options.preserveInputs || !worldTemplateValue('templateWorldId')) {
    setWorldTemplateValue('templateWorldId', template.defaultWorldId || template.id);
  }
  if (!options.preserveInputs || worldTemplateValue('templateSeedTicks') === '') {
    setWorldTemplateValue('templateSeedTicks', String(template.seedTicks || 0));
  }
  if (!options.preserveInputs || !worldTemplateValue('templateBackupPath')) {
    setWorldTemplateValue('templateBackupPath', suggestedTemplateBackupPath(template.id));
  }
  persistWorldTemplateOptions();
  return template;
}

async function resetWorldFromSelectedTemplate() {
  const template = selectedWorldTemplate();
  if (!template) throw new Error('请选择世界模板');
  assertTemplateResetClientSafe();

  const backup = worldTemplateChecked('templateBackupCurrent');
  const preserveAccounts = worldTemplateChecked('templatePreserveAccounts');
  const recreatePlayer = worldTemplateChecked('templateRecreatePlayer');
  const confirmation = [
    '即将把当前世界重置为“' + template.name + '”。',
    backup ? '当前世界会先保存备份。' : '当前世界不会自动备份。',
    preserveAccounts ? '账号和 Session 会保留，但旧玩家与角色会移除。' : '账号、Session、玩家和角色都会移除。',
    recreatePlayer && preserveAccounts ? '随后会尝试在新世界默认地点重建当前玩家。' : '',
    '此操作不可直接撤销。继续？',
  ].filter(Boolean).join('\n\n');
  if (typeof window.confirm === 'function' && !window.confirm(confirmation)) return null;

  const identity = captureTemplatePlayerIdentity();
  setWorldTemplateStatus('resetting');
  const payload = {
    templateId: template.id,
    worldId: worldTemplateValue('templateWorldId') || undefined,
    seedTicks: Math.max(0, Number(worldTemplateValue('templateSeedTicks') || template.seedTicks || 0)),
    backup,
    backupPath: backup ? worldTemplateValue('templateBackupPath') || suggestedTemplateBackupPath(template.id) : undefined,
    preserveAccounts,
    preserveAudit: worldTemplateChecked('templatePreserveAudit'),
    pauseLoop: worldTemplateChecked('templatePauseLoop'),
  };
  const json = await worldTemplateRequest('/admin/templates/reset', 'POST', payload);

  if (!preserveAccounts) clearWorldTemplateSession();

  let recreated = null;
  let recreateError = null;
  if (recreatePlayer && preserveAccounts && identity.accountId && identity.playerId) {
    try {
      recreated = await recreateTemplatePlayer(identity, template.defaultLocationId);
    } catch (error) {
      recreateError = error.message;
    }
  }

  renderWorldTemplateResult(json.data, recreated, recreateError);
  await refreshAfterTemplateReset({ preserveAccounts });
  setWorldTemplateStatus(recreateError ? 'warning' : 'ready');
  notifyWorldTemplate(
    recreateError
      ? '世界已重置，但玩家重建失败：' + recreateError
      : '世界已重置为：' + template.name,
    !recreateError,
  );
  return { reset: json, recreated, recreateError };
}

function assertTemplateResetClientSafe() {
  const queueState = document.getElementById('actionQueueStatus')?.textContent?.trim().toLowerCase();
  if (queueState === 'running' || queueState === 'pausing') {
    throw new Error('请先暂停行动队列，再重置世界');
  }
}

async function recreatePlayerForCurrentTemplate() {
  const identity = captureTemplatePlayerIdentity();
  if (!identity.accountId || !identity.playerId) throw new Error('账号 ID 和玩家 ID 不能为空');
  const locationId = TEMPLATE_UI.current?.locations?.[0]?.id
    || selectedWorldTemplate()?.defaultLocationId
    || null;
  const json = await recreateTemplatePlayer(identity, locationId);
  renderWorldTemplateResult(null, json, null);
  await refreshAfterTemplateReset({ preserveAccounts: true });
  notifyWorldTemplate('当前玩家已在世界中重建', true);
  return json;
}

async function recreateTemplatePlayer(identity, locationId) {
  const payload = {
    player: {
      id: identity.playerId,
      name: identity.playerName || identity.playerId,
    },
    character: {
      id: identity.entityId || identity.playerId + '_hero',
      name: identity.entityName || identity.entityId || identity.playerId,
      species: 'human',
      locationId: locationId || undefined,
      resources: { currency: 100, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  };
  const json = await worldTemplateRequest(
    '/accounts/' + encodeURIComponent(identity.accountId) + '/players',
    'POST',
    payload,
  );
  const recreatedPlayerId = json.data?.player?.id || identity.playerId;
  const recreatedEntityId = json.data?.entity?.id || payload.character.id;
  localStorage.setItem('mud_player_id', recreatedPlayerId);
  const playerInput = document.getElementById('playerId');
  if (playerInput) playerInput.value = recreatedPlayerId;
  const entityInput = document.getElementById('entityId');
  if (entityInput) entityInput.value = recreatedEntityId;
  return json;
}

function captureTemplatePlayerIdentity() {
  return {
    accountId: document.getElementById('accountId')?.value?.trim() || '',
    playerId: document.getElementById('playerId')?.value?.trim() || '',
    entityId: document.getElementById('entityId')?.value?.trim() || '',
    playerName: document.getElementById('playerName')?.value?.trim() || '',
    entityName: document.getElementById('entityName')?.value?.trim() || '',
  };
}

function clearWorldTemplateSession() {
  if (typeof window.setToken === 'function') window.setToken('');
  else {
    localStorage.removeItem('mud_token');
    const tokenBox = document.getElementById('tokenBox');
    if (tokenBox) tokenBox.value = '';
  }
  const connectionStatus = document.getElementById('connectionStatus');
  if (connectionStatus) {
    connectionStatus.textContent = 'Session 已清除';
    connectionStatus.className = 'status-pill';
  }
}

async function refreshAfterTemplateReset(options = {}) {
  const tasks = [];
  if (options.preserveAccounts !== false) {
    if (typeof window.refreshAll === 'function') tasks.push(window.refreshAll());
    else if (typeof refreshAll === 'function') tasks.push(refreshAll());
  } else if (typeof window.refreshWorld === 'function') {
    tasks.push(window.refreshWorld());
  }
  if (typeof window.refreshAdminConsole === 'function') tasks.push(window.refreshAdminConsole());
  if (typeof window.refreshSaveManager === 'function') tasks.push(window.refreshSaveManager());
  if (typeof window.refreshRuntimeLoop === 'function') tasks.push(window.refreshRuntimeLoop());
  await Promise.allSettled(tasks);
  if (options.preserveAccounts !== false) await refreshWorldTemplates();
}

function renderWorldTemplateList() {
  const count = document.getElementById('worldTemplateCount');
  if (count) count.textContent = String(TEMPLATE_UI.templates.length);
  const container = document.getElementById('worldTemplateList');
  if (!container) return;
  if (!TEMPLATE_UI.templates.length) {
    container.innerHTML = '<div class="empty">没有可用世界模板</div>';
    return;
  }
  container.innerHTML = TEMPLATE_UI.templates.map(template => {
    const selected = template.id === TEMPLATE_UI.selectedId;
    const locations = (template.locations || []).slice(0, 5).map(location => location.name).join('、');
    const tags = (template.tags || []).map(tag => '<span class="badge">' + escapeWorldTemplate(tag) + '</span>').join('');
    return '<button type="button" class="world-template-card ' + (selected ? 'selected' : '') + '" ' +
      'data-template-id="' + attributeWorldTemplate(template.id) + '" aria-pressed="' + selected + '">' +
      '<div class="world-template-card-header"><strong>' + escapeWorldTemplate(template.name) + '</strong>' +
      '<span>v' + escapeWorldTemplate(template.version) + '</span></div>' +
      '<p>' + escapeWorldTemplate(template.description || '') + '</p>' +
      '<div class="badge-row">' + tags + '</div>' +
      '<dl><div><dt>地点</dt><dd>' + escapeWorldTemplate(template.locations?.length || 0) + '</dd></div>' +
      '<div><dt>实体</dt><dd>' + escapeWorldTemplate(template.entities || 0) + '</dd></div>' +
      '<div><dt>组织</dt><dd>' + escapeWorldTemplate(template.organizations || 0) + '</dd></div>' +
      '<div><dt>种子 tick</dt><dd>' + escapeWorldTemplate(template.seedTicks || 0) + '</dd></div></dl>' +
      '<small>' + escapeWorldTemplate(locations || '无地点') + '</small>' +
      '</button>';
  }).join('');
}

function renderCurrentTemplateSummary(current, loop) {
  const container = document.getElementById('currentTemplateSummary');
  if (!container) return;
  if (!current) {
    container.innerHTML = '<div class="empty">当前世界状态不可用</div>';
    return;
  }
  const totals = current.totals || {};
  container.innerHTML = '<div class="current-template-card">' +
    '<div><strong>' + escapeWorldTemplate(current.template?.name || '未标记模板的世界') + '</strong>' +
    '<small>' + escapeWorldTemplate(current.id || '-') + ' · tick ' + escapeWorldTemplate(current.tick ?? '-') + '</small></div>' +
    '<div class="badge-row">' +
    ['地点 ' + (totals.locations || 0), '实体 ' + (totals.entities || 0), '组织 ' + (totals.organizations || 0), '玩家 ' + (totals.players || 0), '账号 ' + (totals.accounts || 0), 'loop ' + (loop?.status || 'unknown')]
      .map(value => '<span class="badge">' + escapeWorldTemplate(value) + '</span>').join('') +
    '</div></div>';
}

function renderWorldTemplateResult(reset, recreated, recreateError) {
  const container = document.getElementById('worldTemplateResult');
  if (!container) return;
  const parts = [];
  if (reset) {
    parts.push('<div><strong>世界重置完成</strong><small>' +
      escapeWorldTemplate(reset.world?.id || '-') + ' · tick ' + escapeWorldTemplate(reset.world?.tick ?? '-') +
      ' · template ' + escapeWorldTemplate(reset.template?.id || '-') + '</small></div>');
    if (reset.backup) parts.push('<div><strong>备份</strong><small>' + escapeWorldTemplate(reset.backup.file) + '</small></div>');
  }
  if (recreated) {
    parts.push('<div><strong>玩家已重建</strong><small>' +
      escapeWorldTemplate(recreated.data?.player?.id || recreated.data?.account?.playerIds?.slice(-1)[0] || '-') +
      '</small></div>');
  }
  if (recreateError) parts.push('<div class="bad"><strong>玩家重建失败</strong><small>' + escapeWorldTemplate(recreateError) + '</small></div>');
  container.innerHTML = parts.length ? parts.join('') : '<div class="empty">模板操作完成</div>';
}

function selectedWorldTemplate() {
  return TEMPLATE_UI.templates.find(template => template.id === TEMPLATE_UI.selectedId) || null;
}

function suggestedTemplateBackupPath(templateId) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return 'world-engine/output/template-backup-' + sanitizeWorldTemplatePart(templateId) + '-' + stamp + '.json';
}

function setWorldTemplateStatus(state) {
  const element = document.getElementById('worldTemplateStatus');
  if (!element) return;
  element.textContent = state;
  element.className = 'world-template-status ' + state;
}

function renderWorldTemplateError(error) {
  const message = error?.message || String(error);
  const restricted = message.includes(' 401 ') || message.includes(' 403 ');
  setWorldTemplateStatus(restricted ? 'restricted' : 'error');
  const result = document.getElementById('worldTemplateResult');
  if (result) {
    result.innerHTML = '<div class="world-template-error"><strong>' +
      (restricted ? '需要 GM/admin 权限' : '世界模板操作失败') +
      '</strong><small>' + escapeWorldTemplate(message) + '</small></div>';
  }
  notifyWorldTemplate(restricted ? '需要 GM/admin 权限管理世界模板' : message, false);
}

async function worldTemplateRequest(pathname, method = 'GET', body = null) {
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

function notifyWorldTemplate(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log(message);
}

function setWorldTemplateValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function worldTemplateValue(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function setWorldTemplateChecked(id, value) {
  const element = document.getElementById(id);
  if (element) element.checked = Boolean(value);
}

function worldTemplateChecked(id) {
  return Boolean(document.getElementById(id)?.checked);
}

function sanitizeWorldTemplatePart(value) {
  return String(value || 'world').replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

function escapeWorldTemplate(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributeWorldTemplate(value) {
  return escapeWorldTemplate(value).replace(/'/g, '&#39;');
}

window.refreshWorldTemplates = refreshWorldTemplates;
window.resetWorldFromSelectedTemplate = resetWorldFromSelectedTemplate;
