'use strict';

const S = {
  token: '',
  accountId: 'local_account',
  playerId: 'local_player',
  socket: null,
  refreshTimer: null,
  dashboard: null,
};
const $ = id => document.getElementById(id);

window.addEventListener('DOMContentLoaded', () => {
  S.token = localStorage.getItem('mud_token') || '';
  S.accountId = localStorage.getItem('mud_account_id') || S.accountId;
  S.playerId = localStorage.getItem('mud_player_id') || S.playerId;
  $('accountId').value = S.accountId;
  $('playerId').value = S.playerId;
  $('tokenBox').value = S.token;

  on('quickStartBtn', quickStart);
  on('createAccountBtn', createAccount);
  on('createSessionBtn', createSession);
  on('checkSessionBtn', checkSession);
  on('createPlayerBtn', createPlayer);
  on('loadPlayerBtn', loadPlayer);
  on('loadPanelsBtn', loadDashboard);
  on('refreshWorldBtn', refreshWorld);
  on('tickBtn', tickWorld);
  on('snapshotBtn', refreshSnapshot);
  on('saveWorldBtn', saveWorld);
  on('loadWorldBtn', loadWorld);
  on('sendCommandBtn', sendCommand);
  on('queueOfflineBtn', queueOffline);
  on('loadOfflineBtn', loadOffline);
  on('connectWsBtn', connectWs);
  on('clearLogBtn', async () => { $('eventLog').textContent = ''; });

  $('autoRefreshToggle').addEventListener('change', configureAutoRefresh);
  $('refreshSeconds').addEventListener('change', configureAutoRefresh);
  document.addEventListener('click', handleGameActionClick);
  refreshWorld();
});

function on(id, fn) {
  $(id).addEventListener('click', () => fn().catch(showError));
}

async function quickStart() {
  status('正在初始化...', null);
  S.accountId = $('accountId').value.trim() || S.accountId;
  S.playerId = $('playerId').value.trim() || S.playerId;
  localStorage.setItem('mud_account_id', S.accountId);
  localStorage.setItem('mud_player_id', S.playerId);

  await call('/accounts', 'POST', {
    id: S.accountId,
    name: $('accountName').value.trim() || S.accountId,
    roles: ['player'],
  });

  const session = await call('/sessions', 'POST', {
    accountId: S.accountId,
    options: { sessionTtlTicks: 100000 },
  });
  setToken(session.data.token);

  const account = await call('/accounts/' + encodeURIComponent(S.accountId));
  if (!(account.data.playerIds || []).includes(S.playerId)) {
    await createPlayer();
  } else {
    await loadDashboard();
  }

  connectWs();
  await refreshWorld();
  status('已就绪', true);
  log('一键开始完成');
}

async function createAccount() {
  S.accountId = $('accountId').value.trim() || S.accountId;
  localStorage.setItem('mud_account_id', S.accountId);
  const json = await call('/accounts', 'POST', {
    id: S.accountId,
    name: $('accountName').value.trim() || S.accountId,
    roles: ['player'],
  });
  show(json);
  log('账号已创建：' + S.accountId);
  return json;
}

async function createSession() {
  S.accountId = $('accountId').value.trim() || S.accountId;
  const json = await call('/sessions', 'POST', {
    accountId: S.accountId,
    options: { sessionTtlTicks: 100000 },
  });
  setToken(json.data.token);
  show(json);
  log('Session 已创建');
  return json;
}

async function checkSession() {
  const json = await call('/session');
  show(json);
  status('Session 有效', true);
  return json;
}

async function createPlayer() {
  S.accountId = $('accountId').value.trim() || S.accountId;
  S.playerId = $('playerId').value.trim() || S.playerId;
  localStorage.setItem('mud_player_id', S.playerId);
  const entityId = $('entityId').value.trim() || 'local_hero';
  const payload = {
    player: {
      id: S.playerId,
      name: $('playerName').value.trim() || S.playerId,
    },
    character: {
      id: entityId,
      name: $('entityName').value.trim() || entityId,
      species: 'human',
      locationId: 'qingyun_city',
      stats: {
        health: 90,
        maxHealth: 100,
        energy: 100,
        maxEnergy: 100,
        power: 10,
        social: 50,
      },
      resources: { currency: 100, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  };
  const json = await call('/accounts/' + encodeURIComponent(S.accountId) + '/players', 'POST', payload);
  show(json);
  log('角色已创建：' + S.playerId);
  await loadDashboard();
  return json;
}

async function refreshWorld() {
  const json = await call('/world');
  const w = json.data.world || {};
  const t = json.data.totals || {};
  $('worldMetrics').innerHTML = [
    ['tick', w.tick],
    ['alive', t.alive],
    ['players', t.players],
    ['offline', t.offlineCommands],
    ['items', t.itemInstances],
    ['shops', t.shops],
    ['quests', t.quests],
    ['commands', t.commands],
  ].map(([label, value]) => metric(label, value)).join('');
  return json;
}

async function loadPlayer() {
  return loadDashboard();
}

async function loadDashboard() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const json = await call('/players/' + encodeURIComponent(S.playerId) + '/dashboard?limit=20');
  S.dashboard = json.data;
  renderDashboard(json.data);
  show(json);
  return json;
}

function renderDashboard(dashboard) {
  if (!dashboard) return;
  renderCharacter(dashboard.player);
  renderMap(dashboard.map);
  renderQuests(dashboard.quests);
  renderBoard(dashboard.board);
  renderInventory(dashboard.inventory);
  renderShop(dashboard.shop);
  renderJournal(dashboard.journal, dashboard.encounters);
  renderOffline(dashboard.offline);
}

async function sendCommand() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const type = $('commandType').value;
  const arg = $('commandArg').value.trim();
  const command = { type, amount: Number($('commandAmount').value || 1) };
  if (type === 'move') command.locationId = arg || 'mist_forest';
  else command.resource = arg || (type === 'gather' ? 'wood' : 'currency');
  const json = await runGameAction({ type: 'command', command });
  log('命令已提交：' + type);
  return json;
}

async function queueOffline() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const type = $('offlineType').value;
  const command = {
    type,
    amount: Number($('offlineAmount').value || 1),
    durationTicks: Number($('offlineDuration').value || 2),
    runsEveryTicks: 1,
    repeat: Number($('offlineRepeat').value || 1),
  };
  if (type === 'work' || type === 'gather') command.resource = $('offlineArg').value.trim() || 'currency';
  const json = await call('/offline', 'POST', { playerId: S.playerId, command });
  show(json);
  log('离线任务已安排：' + type);
  await loadOffline();
  return json;
}

async function loadOffline() {
  const json = await call('/players/' + encodeURIComponent(S.playerId) + '/offline');
  renderOffline(json.data);
  show(json);
  return json;
}

async function tickWorld() {
  const json = await call('/tick', 'POST', { ticks: 1 });
  show(json);
  log('世界推进 1 tick');
  await refreshAll();
  return json;
}

async function refreshSnapshot() {
  const json = await call('/snapshot');
  show(json);
  log('快照已刷新：tick ' + (json.data?.world?.tick ?? '-'));
  return json;
}

async function saveWorld() {
  const filePath = $('savePath').value.trim() || 'world-engine/output/local-client-save.json';
  const json = await call('/save', 'POST', {
    filePath,
    options: { createBackup: true },
  });
  show(json);
  log('世界已保存：' + filePath);
  return json;
}

async function loadWorld() {
  const filePath = $('savePath').value.trim() || 'world-engine/output/local-client-save.json';
  const json = await call('/load', 'POST', { filePath });
  show(json);
  log('世界已读取：' + filePath);
  await refreshAll();
  return json;
}

async function refreshAll() {
  await refreshWorld();
  if ($('playerId').value.trim()) await loadDashboard().catch(error => log('面板刷新失败：' + error.message));
}

function configureAutoRefresh() {
  if (S.refreshTimer) clearInterval(S.refreshTimer);
  S.refreshTimer = null;
  if (!$('autoRefreshToggle').checked) {
    log('自动刷新已关闭');
    return;
  }
  const seconds = Math.max(2, Number($('refreshSeconds').value || 5));
  S.refreshTimer = setInterval(() => refreshAll().catch(showError), seconds * 1000);
  log('自动刷新：' + seconds + ' 秒');
}

async function handleGameActionClick(event) {
  const button = event.target.closest('[data-game-action]');
  if (!button) return;
  event.preventDefault();
  const action = actionFromButton(button);
  button.disabled = true;
  try {
    await runGameAction(action);
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
}

function actionFromButton(button) {
  const type = button.dataset.gameAction;
  if (type === 'move') return { type, locationId: button.dataset.locationId };
  if (type === 'accept_board_quest') return { type, boardItemId: button.dataset.boardItemId };
  if (type === 'claim_quest') return { type, questId: button.dataset.questId };
  if (type === 'claim_all_quests' || type === 'explore') return { type };
  if (type === 'equip_item' || type === 'use_item' || type === 'sell_item') {
    return { type, itemId: button.dataset.itemId, quantity: Number(button.dataset.quantity || 1) };
  }
  if (type === 'unequip_item') return { type, slotOrItemId: button.dataset.slot || button.dataset.itemId };
  if (type === 'buy_item') {
    return {
      type,
      shopId: button.dataset.shopId,
      itemDefinitionId: button.dataset.definitionId,
      quantity: Number(button.dataset.quantity || 1),
    };
  }
  return { type };
}

async function runGameAction(action) {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const json = await call('/players/' + encodeURIComponent(S.playerId) + '/actions', 'POST', action);
  show(json);
  if (json.data?.dashboard) {
    S.dashboard = json.data.dashboard;
    renderDashboard(json.data.dashboard);
  } else {
    await loadDashboard();
  }
  await refreshWorld();
  log('玩法动作：' + action.type);
  return json;
}

function renderCharacter(data) {
  const entity = data?.activeEntity || {};
  const stats = entity.stats || {};
  const resources = entity.resources || {};
  $('characterPanel').innerHTML = card(entity.name || S.playerId, [
    '位置：' + esc(entity.locationId || '-'),
    bar('生命', stats.health, stats.maxHealth),
    bar('精力', stats.energy, stats.maxEnergy),
    badges([
      'power ' + (stats.power || 0),
      'defense ' + (stats.defense || 0),
      'currency ' + (resources.currency || 0),
      'food ' + (resources.food || 0),
    ]),
  ].join(''));
}

function renderMap(data) {
  const current = data?.current || data;
  if (!current?.id) return empty('mapPanel', '暂无地图数据');
  const resourceBadges = Object.entries(current.resources || {}).map(([key, value]) => key + ' ' + value);
  const exits = (current.neighbors || []).map(neighbor => {
    return '<div class="exit-row"><span>' + esc(neighbor.name || neighbor.id) + ' · danger ' + esc(neighbor.danger || 0) + '</span>' + actionButton('前往', 'move', { locationId: neighbor.id }) + '</div>';
  }).join('');
  $('mapPanel').innerHTML = card(current.name || current.id, [
    '类型：' + esc(current.type || '-') + ' · danger ' + esc(current.danger || 0),
    resourceBadges.length ? badges(resourceBadges) : '',
    '<div class="actions">' + actionButton('探索当前地点', 'explore') + '</div>',
    exits || '<div class="empty">没有出口</div>',
  ].join(''));
}

function renderQuests(data) {
  const quests = data?.quests || [];
  if (!quests.length) return empty('questPanel', '暂无任务');
  $('questPanel').innerHTML = quests.slice(0, 20).map(quest => {
    const objectives = (quest.objectives || []).map(objective => {
      const current = Number(objective.progress || 0);
      const target = Math.max(1, Number(objective.target || 1));
      return '<small>' + esc(objective.title || objective.type) + ' ' + current + '/' + target + '</small>' + bar('', current, target);
    }).join('');
    const action = quest.status === 'completed'
      ? '<div class="actions">' + actionButton('领取奖励', 'claim_quest', { questId: quest.id }) + '</div>'
      : '';
    return card(quest.title || quest.id, '状态：' + esc(quest.status || '-') + '<br>' + esc(quest.description || '') + objectives + action);
  }).join('');
}

function renderBoard(data) {
  const items = data?.items || [];
  if (!items.length) return empty('boardPanel', '当前地点暂无开放委托');
  $('boardPanel').innerHTML = items.map(item => {
    const rewards = Object.entries(item.rewards?.resources || {}).map(([key, value]) => key + '+' + value);
    return card(item.title || item.id, [
      esc(item.summary || ''),
      rewards.length ? badges(rewards) : '',
      '<div class="actions">' + actionButton('接取委托', 'accept_board_quest', { boardItemId: item.id }) + '</div>',
    ].join(''));
  }).join('');
}

function renderInventory(data) {
  const items = data?.items || [];
  const equipment = data?.equipment || {};
  const equipped = Object.entries(equipment).filter(([, item]) => item).map(([slot, item]) => {
    return '<div class="item-row"><span>' + esc(slot) + '：' + esc(item.name || item.id) + '</span>' + actionButton('卸下', 'unequip_item', { slot }) + '</div>';
  }).join('');
  const itemCards = items.map(item => {
    const buttons = [];
    if (item.type === 'equipment' && !item.equipped) buttons.push(actionButton('装备', 'equip_item', { itemId: item.id }));
    if (item.type === 'consumable') buttons.push(actionButton('使用', 'use_item', { itemId: item.id }));
    if (!item.equipped) buttons.push(actionButton('出售 1 个', 'sell_item', { itemId: item.id, quantity: 1 }, 'danger'));
    return card(item.name || item.id, '数量：' + esc(item.quantity || 1) + ' · ' + esc(item.type || '-') + '<br>价格：' + esc(item.price || 0) + '<div class="actions">' + buttons.join('') + '</div>');
  }).join('');
  $('inventoryPanel').innerHTML = (equipped ? card('当前装备', equipped) : card('当前装备', '<span class="empty">无</span>')) + (itemCards || '<div class="empty">暂无物品</div>');
}

function renderShop(data) {
  const shops = data?.shops || [];
  if (!shops.length) return empty('shopPanel', '当前地点暂无商店');
  $('shopPanel').innerHTML = shops.map(shop => {
    const stock = (shop.stock || []).map(item => {
      return '<div class="stock-row"><span>' + esc(item.name || item.definitionId) + ' · ' + esc(item.price || 0) + ' 金币 · 库存 ' + esc(item.quantity || 0) + '</span>' + actionButton('购买', 'buy_item', { shopId: shop.id, definitionId: item.definitionId, quantity: 1 }) + '</div>';
    }).join('');
    return card(shop.name || shop.id, '类型：' + esc(shop.type || '-') + stock);
  }).join('');
}

function renderJournal(data, encountersData) {
  const entries = data?.entries || [];
  const encounters = encountersData?.encounters || [];
  const combined = [
    ...entries.map(entry => ({ tick: entry.tick, type: entry.type, title: entry.title, summary: entry.summary || entry.message || entry.text })),
    ...encounters.map(entry => ({ tick: entry.resolvedAt || entry.createdAt, type: 'encounter', title: entry.title, summary: entry.summary })),
  ].sort((a, b) => Number(b.tick || 0) - Number(a.tick || 0)).slice(0, 20);
  if (!combined.length) return empty('journalPanel', '暂无日志');
  $('journalPanel').innerHTML = combined.map(entry => {
    return '<div class="timeline-item"><strong>' + esc(entry.title || entry.type || 'entry') + '</strong><small>tick ' + esc(entry.tick ?? '-') + ' · ' + esc(entry.type || '-') + '</small><br>' + esc(entry.summary || '') + '</div>';
  }).join('');
}

function renderOffline(data) {
  const commands = data?.offlineCommands || [];
  $('offlineView').textContent = JSON.stringify(commands, null, 2);
  if (!commands.length) return empty('offlineProgress', '暂无离线任务');
  $('offlineProgress').innerHTML = commands.slice(0, 10).map(command => {
    const completed = Number(command.completedRuns || 0);
    const repeat = Math.max(1, Number(command.repeat || 1));
    return card(command.type || command.id, '状态：' + esc(command.status || '-') + bar('进度', completed, repeat));
  }).join('');
}

function connectWs() {
  if (S.socket) S.socket.close();
  const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/ticks';
  S.socket = new WebSocket(url);
  S.socket.onopen = () => { status('WebSocket 已连接', true); log('WebSocket 已连接'); };
  S.socket.onmessage = event => {
    log('ws ' + event.data);
    let payload = null;
    try { payload = JSON.parse(event.data); } catch (_) {}
    if (payload && ['tick', 'browser.action', 'load'].includes(payload.type)) refreshAll().catch(showError);
  };
  S.socket.onclose = () => status('WebSocket 已关闭');
  S.socket.onerror = () => status('WebSocket 错误', false);
}

async function call(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = $('tokenBox').value.trim() || S.token;
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text || '{}'); }
  catch (_) { json = { ok: false, error: text || 'invalid_json' }; }
  if (!response.ok) throw new Error(method + ' ' + path + ' ' + response.status + ' ' + (json.error || 'error'));
  return json;
}

function setToken(token) {
  S.token = token || '';
  $('tokenBox').value = S.token;
  localStorage.setItem('mud_token', S.token);
}

function actionButton(label, type, values = {}, extraClass = '') {
  const attrs = Object.entries(values).map(([key, value]) => ' data-' + kebab(key) + '="' + attr(value) + '"').join('');
  return '<button class="small ' + esc(extraClass) + '" data-game-action="' + attr(type) + '"' + attrs + '>' + esc(label) + '</button>';
}

function card(title, body) {
  return '<div class="mini-card"><strong>' + esc(title) + '</strong>' + body + '</div>';
}

function badges(list) {
  return '<div class="badge-row">' + list.map(value => '<span class="badge">' + esc(String(value)) + '</span>').join('') + '</div>';
}

function bar(label, value, max) {
  const current = Number(value || 0);
  const total = Math.max(1, Number(max || 100));
  const percent = Math.max(0, Math.min(100, Math.round(current / total * 100)));
  return '<div><small>' + esc(label ? label + ' ' : '') + current + '/' + total + '</small><div class="progress"><i style="width:' + percent + '%"></i></div></div>';
}

function empty(id, text) {
  $(id).innerHTML = '<div class="empty">' + esc(text) + '</div>';
}

function metric(label, value) {
  return '<div class="metric"><strong>' + esc(value ?? '-') + '</strong><span>' + esc(label) + '</span></div>';
}

function show(value) {
  $('rawOutput').textContent = JSON.stringify(value, null, 2);
}

function log(value) {
  $('eventLog').textContent = '[' + new Date().toLocaleTimeString() + '] ' + value + '\n' + $('eventLog').textContent;
  $('eventLog').textContent = $('eventLog').textContent.slice(0, 16000);
}

function status(text, ok) {
  $('connectionStatus').textContent = text;
  $('connectionStatus').className = 'status-pill ' + (ok === true ? 'ok' : ok === false ? 'bad' : '');
}

function showError(error) {
  status('错误', false);
  log('ERROR ' + error.message);
  $('rawOutput').textContent = error.stack || error.message;
}

function kebab(value) {
  return String(value).replace(/[A-Z]/g, match => '-' + match.toLowerCase());
}

function attr(value) {
  return esc(String(value)).replace(/'/g, '&#39;');
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}
