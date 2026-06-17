'use strict';

const S = { token: '', accountId: 'local_account', playerId: 'local_player', socket: null };
const $ = id => document.getElementById(id);

window.addEventListener('DOMContentLoaded', () => {
  S.token = localStorage.getItem('mud_token') || '';
  S.accountId = localStorage.getItem('mud_account_id') || S.accountId;
  S.playerId = localStorage.getItem('mud_player_id') || S.playerId;
  $('accountId').value = S.accountId;
  $('playerId').value = S.playerId;
  $('tokenBox').value = S.token;
  on('createAccountBtn', createAccount);
  on('createSessionBtn', createSession);
  on('checkSessionBtn', checkSession);
  on('createPlayerBtn', createPlayer);
  on('loadPlayerBtn', loadPlayer);
  on('loadPanelsBtn', loadPanels);
  on('refreshWorldBtn', refreshWorld);
  on('tickBtn', tickWorld);
  on('snapshotBtn', refreshSnapshot);
  on('sendCommandBtn', sendCommand);
  on('queueOfflineBtn', queueOffline);
  on('loadOfflineBtn', loadOffline);
  on('connectWsBtn', connectWs);
  on('clearLogBtn', async () => { $('eventLog').textContent = ''; });
  refreshWorld();
});

function on(id, fn) { $(id).addEventListener('click', () => fn().catch(showError)); }

async function createAccount() {
  S.accountId = $('accountId').value.trim() || S.accountId;
  localStorage.setItem('mud_account_id', S.accountId);
  show(await call('/accounts', 'POST', { id: S.accountId, name: $('accountName').value || S.accountId, roles: ['player'] }));
  log('account created ' + S.accountId);
}

async function createSession() {
  S.accountId = $('accountId').value.trim() || S.accountId;
  const json = await call('/sessions', 'POST', { accountId: S.accountId, options: { sessionTtlTicks: 100000 } });
  S.token = json.data.token;
  $('tokenBox').value = S.token;
  localStorage.setItem('mud_token', S.token);
  show(json);
  log('session created');
}

async function checkSession() { show(await call('/session')); }

async function createPlayer() {
  S.accountId = $('accountId').value.trim() || S.accountId;
  S.playerId = $('playerId').value.trim() || S.playerId;
  localStorage.setItem('mud_player_id', S.playerId);
  const entityId = $('entityId').value.trim() || 'local_hero';
  const payload = { player: { id: S.playerId, name: $('playerName').value || S.playerId }, character: { id: entityId, name: $('entityName').value || entityId, species: 'human', locationId: 'qingyun_city', stats: { health: 90, maxHealth: 100, energy: 100, maxEnergy: 100, power: 10, social: 50 }, resources: { currency: 100, food: 10 }, demographics: { age: 18, generation: 1 } } };
  show(await call('/accounts/' + encodeURIComponent(S.accountId) + '/players', 'POST', payload));
  await loadPlayer();
}

async function refreshWorld() {
  const json = await call('/world');
  show(json);
  const w = json.data.world || {};
  const t = json.data.totals || {};
  $('worldMetrics').innerHTML = ['tick:' + w.tick, 'alive:' + t.alive, 'players:' + t.players, 'offline:' + t.offlineCommands, 'items:' + t.itemInstances, 'shops:' + t.shops, 'quests:' + t.quests, 'commands:' + t.commands].map(metric).join('');
}

async function loadPlayer() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const json = await call('/players/' + encodeURIComponent(S.playerId));
  show(json);
  renderCharacter(json.data);
  await loadPanels();
}

async function loadPanels() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const [map, quests, inventory, shop, journal] = await Promise.all([
    call('/players/' + encodeURIComponent(S.playerId) + '/map'),
    call('/players/' + encodeURIComponent(S.playerId) + '/quests'),
    call('/players/' + encodeURIComponent(S.playerId) + '/inventory'),
    call('/players/' + encodeURIComponent(S.playerId) + '/shop'),
    call('/players/' + encodeURIComponent(S.playerId) + '/journal?limit=8'),
  ]);
  renderMap(map.data);
  renderQuests(quests.data);
  renderInventory(inventory.data);
  renderShop(shop.data);
  renderJournal(journal.data);
  show({ ok: true, data: { map: map.data, quests: quests.data, inventory: inventory.data, shop: shop.data, journal: journal.data } });
}

async function sendCommand() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const type = $('commandType').value;
  const arg = $('commandArg').value.trim();
  const cmd = { type, amount: Number($('commandAmount').value || 1) };
  if (type === 'move') cmd.locationId = arg || 'mist_forest'; else cmd.resource = arg || 'currency';
  show(await call('/commands', 'POST', { playerId: S.playerId, command: cmd }));
  await refreshWorld();
  await loadPlayer().catch(() => {});
}

async function queueOffline() {
  S.playerId = $('playerId').value.trim() || S.playerId;
  const type = $('offlineType').value;
  const cmd = { type, amount: Number($('offlineAmount').value || 1), durationTicks: Number($('offlineDuration').value || 2), runsEveryTicks: 1, repeat: Number($('offlineRepeat').value || 1) };
  if (type === 'work' || type === 'gather') cmd.resource = $('offlineArg').value.trim() || 'currency';
  show(await call('/offline', 'POST', { playerId: S.playerId, command: cmd }));
  await loadOffline();
}

async function loadOffline() {
  const json = await call('/offline/' + encodeURIComponent(S.playerId));
  $('offlineView').textContent = JSON.stringify(json.data.offlineCommands || [], null, 2);
  show(json);
}

async function tickWorld() { show(await call('/tick', 'POST', { ticks: 1 })); await refreshWorld(); await loadOffline().catch(() => {}); await loadPanels().catch(() => {}); }
async function refreshSnapshot() { show(await call('/snapshot')); }

function renderCharacter(data) {
  const entity = data?.entity || data?.character || {};
  const stats = entity.stats || {};
  const res = entity.resources || {};
  const loc = entity.location || data?.location || {};
  $('characterPanel').innerHTML = card(entity.name || S.playerId, [
    '位置：' + (loc.name || entity.locationId || '-'),
    bar('生命', stats.health, stats.maxHealth),
    bar('精力', stats.energy, stats.maxEnergy),
    badges(['power ' + (stats.power || 0), 'social ' + (stats.social || 0), 'currency ' + (res.currency || 0), 'food ' + (res.food || 0)])
  ].join(''));
}

function renderMap(data) {
  const locations = data?.locations || data?.nodes || [];
  if (!locations.length) return empty('mapPanel', '暂无地图数据');
  $('mapPanel').innerHTML = locations.slice(0, 8).map(l => card(l.name || l.id, '地点：' + (l.id || '-') + '<br>类型：' + (l.type || '-'))).join('');
}

function renderQuests(data) {
  const quests = data?.quests || [];
  if (!quests.length) return empty('questPanel', '暂无任务');
  $('questPanel').innerHTML = quests.slice(0, 8).map(q => card(q.title || q.name || q.questId || q.id, '状态：' + (q.status || '-') + '<br>' + esc(q.description || q.summary || ''))).join('');
}

function renderInventory(data) {
  const items = data?.items || data?.inventory || [];
  const equipment = data?.equipment || {};
  const equipText = Object.keys(equipment).length ? '<br>' + badges(Object.entries(equipment).map(([k, v]) => k + ':' + (v?.name || v || '-'))) : '';
  if (!items.length) return $('inventoryPanel').innerHTML = card('装备', equipText || '暂无物品');
  $('inventoryPanel').innerHTML = items.slice(0, 12).map(i => card(i.name || i.itemId || i.id, '数量：' + (i.quantity || 1) + '<br>类型：' + (i.type || i.itemType || '-'))).join('') + equipText;
}

function renderShop(data) {
  const shops = data?.shops || [];
  if (!shops.length) return empty('shopPanel', '当前地点暂无商店');
  $('shopPanel').innerHTML = shops.map(s => card(s.name || s.id, '类型：' + (s.type || '-') + '<br>库存：' + ((s.stock || s.items || []).length || 0))).join('');
}

function renderJournal(data) {
  const entries = data?.entries || [];
  if (!entries.length) return empty('journalPanel', '暂无日志');
  $('journalPanel').innerHTML = entries.map(e => '<div class="timeline-item"><strong>' + esc(e.type || 'entry') + '</strong><small>tick ' + esc(e.tick ?? '-') + '</small><br>' + esc(e.message || e.summary || e.text || '') + '</div>').join('');
}

function connectWs() {
  if (S.socket) S.socket.close();
  const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/ticks';
  S.socket = new WebSocket(url);
  S.socket.onopen = () => status('WebSocket 已连接', true);
  S.socket.onmessage = e => log('ws ' + e.data);
  S.socket.onclose = () => status('WebSocket 已关闭');
  S.socket.onerror = () => status('WebSocket 错误', false);
}

async function call(path, method = 'GET', body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = $('tokenBox').value.trim();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(method + ' ' + path + ' ' + res.status + ' ' + (json.error || 'error'));
  return json;
}

function card(title, body) { return '<div class="mini-card"><strong>' + esc(title) + '</strong>' + body + '</div>'; }
function badges(list) { return '<div class="badge-row">' + list.map(x => '<span class="badge">' + esc(String(x)) + '</span>').join('') + '</div>'; }
function bar(label, value, max) { const n = Number(value || 0); const m = Number(max || 100); const pct = Math.max(0, Math.min(100, Math.round(n / m * 100))); return '<div><small>' + esc(label) + ' ' + n + '/' + m + '</small><div class="progress"><i style="width:' + pct + '%"></i></div></div>'; }
function empty(id, text) { $(id).innerHTML = '<div class="empty">' + esc(text) + '</div>'; }
function metric(text) { const p = text.split(':'); return '<div class="metric"><strong>' + esc(p[1]) + '</strong><span>' + esc(p[0]) + '</span></div>'; }
function show(v) { $('rawOutput').textContent = JSON.stringify(v, null, 2); }
function log(v) { $('eventLog').textContent = '[' + new Date().toLocaleTimeString() + '] ' + v + '\n' + $('eventLog').textContent; }
function status(text, ok) { $('connectionStatus').textContent = text; $('connectionStatus').className = 'status-pill ' + (ok === true ? 'ok' : ok === false ? 'bad' : ''); }
function showError(e) { status('错误', false); log('ERROR ' + e.message); $('rawOutput').textContent = e.stack || e.message; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
