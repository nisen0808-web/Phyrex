import { ConsoleSession } from '/console/session.mjs';

const $ = id => document.getElementById(id);
let storage;
try { storage = window.sessionStorage; } catch { /* Reads still work; writes fail before sending. */ }
const session = new ConsoleSession({ storage });
let epoch = 0, busy = false, state = null, lastReceipt = null, historyCursor = null, auditCursor = null;
let auditQuery = '', adminLoaded = false;
const errorText = {
  auth_required: '令牌无效或已过期，请重新连接。待确认指令会保留原编号。',
  player_forbidden: '这个令牌无权查看该玩家，请核对玩家 ID。',
  summary_forbidden: '当前账号没有管理员 / GM 权限。玩家功能仍可使用。',
  audit_forbidden: '当前账号没有审计查询权限。', queue_forbidden: '当前账号没有队列管理权限。',
  world_not_found: '此服务没有这个世界，请核对世界 ID。', player_not_found: '找不到该玩家，请核对玩家 ID。',
  connection_unknown: '连接中断或服务正在唤醒，请稍后重试。若有待确认指令，请保留原编号。',
  pending_confirmation: '先按原编号确认上一条指令，再提交新的行动。',
  service_unavailable: '引擎暂时不能接收指令。稍后刷新或按原编号重试。',
  rate_limited: '请求过于频繁，请稍后再试。', command_queue_full: '世界指令队列已满，请稍后重试。',
  player_queue_full: '你的待执行指令过多，请等待结算后重试。',
  pending_storage_unavailable: '浏览器无法保存待确认编号。请允许当前网站使用会话存储后再连接或提交。',
  invalid_login: '请填写世界 ID、玩家 ID 和不含空格的访问令牌。',
  command_id_conflict: '该编号已对应另一条指令，请保留编号并联系管理员核查。',
  world_revision_changed: '世界状态正在更新，请稍后按原编号重试。',
  command_not_found: '尚未找到这条指令。若提交时断线，请按原编号重试。',
};
function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = String(text); if (className) el.className = className; return el; }
function clearViews() {
  state = null; lastReceipt = null; historyCursor = null; auditCursor = null; adminLoaded = false;
  for (const id of ['character-stats', 'inventory-list', 'shop-list', 'history-list', 'audit-list', 'admin-summary', 'receipt-body']) $(id).replaceChildren();
  for (const id of ['scope-label', 'updated-at', 'tick', 'revision', 'currency', 'location', 'player-mode', 'character-name', 'character-status', 'character-note', 'receipt-summary']) $(id).textContent = '';
  $('workspace').hidden = true; $('login-panel').hidden = false; $('receipt').hidden = true; $('admin-content').hidden = true;
  $('connection-status').textContent = '未连接'; $('token').value = '';
}
function canAct() { return state?.character?.status === 'alive' && state?.player?.controlMode === 'character'; }
function updateButtons() {
  for (const button of document.querySelectorAll('button[data-command]')) button.disabled = busy || !canAct() || Boolean(session.pending);
  for (const id of ['refresh', 'open-admin', 'history-first', 'audit-first', 'refresh-receipt']) $(id).disabled = busy;
  $('history-next').disabled = busy || !historyCursor; $('audit-next').disabled = busy || !auditCursor;
  $('retry').disabled = busy; $('pending-panel').hidden = !session.pending;
  $('pending-id').textContent = session.pending?.id || '';
  $('login-form').querySelector('button').disabled = busy;
  $('audit-form').querySelector('button').disabled = busy;
}
async function run(action) {
  if (busy) return;
  busy = true; const generation = epoch; updateButtons();
  try { await action(); }
  catch (error) {
    if (generation !== epoch || error.code === 'session_changed') return;
    if (error.code === 'player_forbidden') session.disconnect();
    if (!session.connected) clearViews();
    notice((errorText[error.code] || '请求未完成，请稍后再试。') + (error.retryAfter ? ` 建议等待 ${error.retryAfter} 秒。` : ''), true);
  } finally { if (generation === epoch) { busy = false; updateButtons(); } }
}
function pairs(target, data) {
  const fragment = document.createDocumentFragment();
  for (const [key, value] of data) { const row = node('div'); row.append(node('dt', key), node('dd', value ?? '—')); fragment.append(row); }
  $(target).replaceChildren(fragment);
}
function commandButton(label, type, payload) {
  const button = node('button', label); button.type = 'button'; button.dataset.command = type;
  button.addEventListener('click', () => run(() => send(type, payload)));
  return button;
}
async function send(type, payload) {
  const receipt = await session.submit(type, payload);
  showReceipt(receipt);
  await refresh();
  notice(receipt.status === 'pending' ? '指令已入队。世界推进后，点击“更新回执”查看实际结果。' : '已返回原指令回执，没有重复执行。');
}
function showReceipt(receipt) {
  lastReceipt = receipt.id;
  const status = { accepted: '已接收，尚无最终领域结果', completed: '完成', rejected: '拒绝' }[receipt.result?.status] || '等待世界结算';
  $('receipt-summary').textContent = `执行结果：${status}${receipt.result?.outcome?.reason ? `（${receipt.result.outcome.reason}）` : ''}`;
  $('receipt-body').textContent = `编号：${receipt.id}\n入库：${receipt.status === 'applied' ? '已处理' : '排队中'}\n\n${JSON.stringify(receipt.result, null, 2)}`;
  $('receipt').hidden = false;
}
function renderState(data) {
  state = data;
  $('scope-label').textContent = `${data.worldId} / ${data.player.name || data.player.id}`;
  $('tick').textContent = data.tick; $('revision').textContent = data.revision;
  $('currency').textContent = data.character?.resources?.currency ?? '—'; $('location').textContent = data.location?.name || data.location?.id || '未指定';
  $('player-mode').textContent = data.player.controlMode === 'character' ? '角色控制模式' : '观察模式';
  $('character-name').textContent = data.character?.name || data.character?.id || '尚无当前角色';
  $('character-status').textContent = data.character?.status === 'alive' ? '存活' : data.character?.status || '观察中';
  const stats = data.character?.stats || {};
  pairs('character-stats', [['生命', `${stats.health ?? '—'} / ${stats.maxHealth ?? '—'}`], ['体力', `${stats.energy ?? '—'} / ${stats.maxEnergy ?? '—'}`], ['力量', stats.power], ['防御', stats.defense], ['累计经验', data.character?.actionState?.experience], ['食物', data.character?.resources?.food]]);
  $('character-note').textContent = canAct() ? '每个角色每个世界步最多结算一次规则行动。' : '当前处于观察模式或角色不可行动。此控制台暂不提供角色创建与切换。';
  renderCommerce(data.inventory);
  $('updated-at').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
}
function itemRow(title, detail, buttons = []) {
  const row = node('div', undefined, 'item-row'), text = node('div'), actions = node('div', undefined, 'button-row');
  text.append(node('strong', title), node('p', detail, 'muted')); actions.append(...buttons); row.append(text, actions); return row;
}
function renderCommerce(inventory = { items: [], shops: [] }) {
  $('inventory-count').textContent = `${inventory.items.length} / ${inventory.itemCount ?? 0}`;
  $('shop-count').textContent = `${inventory.shops.length} / ${inventory.shopCount ?? 0}`;
  const items = inventory.items.map(item => {
    const buttons = [];
    if (item.type === 'equipment') buttons.push(commandButton(item.equipped ? '卸下' : '装备', item.equipped ? 'unequip_item' : 'equip_item', item.equipped ? { slot: item.slot } : { itemId: item.id }));
    if (item.type === 'consumable') buttons.push(commandButton('使用', 'use_item', { itemId: item.id }));
    if (!item.equipped && inventory.shops.length) {
      const select = node('select'); select.setAttribute('aria-label', `出售 ${item.name || item.id} 到商店`);
      for (const shop of inventory.shops) { const option = node('option', shop.name || shop.id); option.value = shop.id; select.append(option); }
      const sell = node('button', '出售 1 件'); sell.type = 'button'; sell.dataset.command = 'sell_item';
      sell.addEventListener('click', () => run(() => send('sell_item', { shopId: select.value, itemId: item.id, quantity: 1 })));
      buttons.push(select, sell);
    }
    return itemRow(`${item.name || item.id} × ${item.quantity}`, `${item.id}${item.equipped ? ' · 已装备' : ''}`, buttons);
  });
  $('inventory-list').replaceChildren(...(items.length ? items : [node('p', '背包里还没有物品。', 'empty')]));
  const shops = [];
  for (const shop of inventory.shops) {
    shops.push(node('h3', shop.name || shop.id));
    for (const stock of shop.stock) shops.push(itemRow(stock.definitionId, `${stock.price} 货币 / 件 · 库存 ${stock.quantity}`, stock.quantity > 0 ? [commandButton('购买 1 件', 'buy_item', { shopId: shop.id, definitionId: stock.definitionId, quantity: 1 })] : []));
    if (shop.stockCount > shop.stock.length) shops.push(node('p', `已显示 ${shop.stock.length} / ${shop.stockCount} 种商品`, 'muted'));
  }
  $('shop-list').replaceChildren(...(shops.length ? shops : [node('p', '当前地点没有商店。', 'empty')]));
}
function renderHistory(page) {
  historyCursor = page.nextBeforeSequence;
  const rows = page.records.map(record => {
    const row = node('tr'), action = node('td'), button = node('button', '查看结果');
    button.addEventListener('click', () => run(async () => showReceipt(await session.receipt(record.id))));
    action.append(button); row.append(node('td', record.sequence), node('td', record.id, 'mono'), node('td', record.status === 'applied' ? '已处理' : '排队中'), action); return row;
  });
  $('history-list').replaceChildren(...rows); $('history-empty').hidden = rows.length > 0;
}
async function refresh() {
  const [data, history] = await Promise.all([session.state(), session.history()]);
  renderState(data); renderHistory(history);
}
async function readAudit(before = null) {
  const data = await session.request(`/admin/audit?limit=20${auditQuery}${before ? `&beforeSequence=${encodeURIComponent(before)}` : ''}`);
  auditCursor = data.nextBeforeSequence;
  $('audit-list').replaceChildren(...data.records.map(record => {
    const row = node('tr');
    for (const value of [record.sequence, record.createdAt, record.route, record.statusCode, `${record.accountId || '—'} / ${record.playerId || '—'}`, record.errorCode || '—']) row.append(node('td', value));
    return row;
  }));
  $('audit-empty').hidden = data.records.length > 0;
}
async function admin() {
  // Clear previous privileged data before re-authorizing; never keep an old
  // admin table on screen after access has been revoked.
  $('admin-content').hidden = true; $('audit-list').replaceChildren(); $('admin-summary').replaceChildren(); adminLoaded = false;
  const [summary, queue] = await Promise.all([session.request('/admin/summary'), session.request('/admin/queue')]);
  pairs('admin-summary', [['世界步数', summary.tick], ['存档版本', summary.revision], ['存活角色', summary.counts.alive], ['玩家', summary.counts.players], ['待处理指令', `${queue.pendingIsLowerBound ? '≥ ' : ''}${queue.pending}`], ['队列上限', queue.limits.maxPendingCommands]]);
  await readAudit(); adminLoaded = true; $('admin-content').hidden = false; notice('管理信息已更新。审计只展示安全字段。');
}
async function auditAction(before = null) {
  if (!adminLoaded) return;
  // Hide a stale audit page if this re-authorization fails.
  $('audit-list').replaceChildren();
  try { await readAudit(before); }
  catch (error) { $('admin-content').hidden = true; adminLoaded = false; throw error; }
}
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  run(async () => {
    session.connect($('world-id').value, $('player-id').value, $('token').value.trim()); $('token').value = '';
    try { await refresh(); } catch (error) { session.disconnect(); throw error; }
    $('login-panel').hidden = true; $('workspace').hidden = false; $('connection-status').textContent = '已连接';
    notice(session.pending ? '已恢复待确认指令，请按原编号重试。' : '连接成功。页面只在你操作时更新，不会自动保活服务。');
  });
});
$('disconnect').addEventListener('click', () => { epoch++; session.disconnect(); busy = false; clearViews(); updateButtons(); notice('已退出连接，访问令牌已从页面清除。'); });
$('refresh').addEventListener('click', () => run(async () => { await refresh(); notice('已读取最新保存的世界状态。'); }));
$('retry').addEventListener('click', () => run(() => send()));
$('refresh-receipt').addEventListener('click', () => run(async () => { if (lastReceipt) showReceipt(await session.receipt(lastReceipt)); await refresh(); }));
$('history-first').addEventListener('click', () => run(async () => renderHistory(await session.history())));
$('history-next').addEventListener('click', () => run(async () => renderHistory(await session.history(historyCursor))));
$('open-admin').addEventListener('click', () => run(admin));
$('audit-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = new URLSearchParams();
  for (const [key, id] of [['statusCode', 'audit-status'], ['route', 'audit-route'], ['playerId', 'audit-player']]) if ($(id).value.trim()) query.set(key, $(id).value.trim());
  auditQuery = query.size ? `&${query}` : ''; run(() => auditAction());
});
$('audit-first').addEventListener('click', () => run(() => auditAction()));
$('audit-next').addEventListener('click', () => run(() => auditAction(auditCursor)));
for (const [label, type, payload] of [['等待', 'wait', { ticks: 1 }], ['工作', 'work', {}], ['休息', 'rest', {}], ['训练', 'train', {}]]) $('action-buttons').append(commandButton(label, type, payload));
window.addEventListener('pagehide', () => { epoch++; session.disconnect(); clearViews(); });
window.addEventListener('pageshow', event => { if (event.persisted) { busy = false; updateButtons(); notice('页面已恢复，请重新连接。'); } });
updateButtons();
