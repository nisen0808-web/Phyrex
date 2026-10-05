import { ConsoleSession } from '/console/session.mjs';
import { actionNames, actionDescriptions, displayName, itemName, itemDescription, receiptType, receiptText, nextStep } from '/console/guide.mjs';

const $ = id => document.getElementById(id);
let storage;
try { storage = window.sessionStorage; } catch { /* Reads still work; writes fail before sending. */ }
const session = new ConsoleSession({ storage });
let epoch = 0, busy = false, state = null, lastReceipt = null, historyCursor = null, auditCursor = null;
let auditQuery = '', adminLoaded = false;
let shownReceipt = null, waitingId = null;
const completed = new Set(), knownTypes = new Map(), viewedReceipts = new Map();
function remember(map, key, value) { map.set(key, value); if (map.size > 128) map.delete(map.keys().next().value); }
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
  shownReceipt = null; waitingId = null; completed.clear(); knownTypes.clear(); viewedReceipts.clear();
  for (const id of ['character-stats', 'inventory-list', 'shop-list', 'history-list', 'audit-list', 'admin-summary', 'receipt-body']) $(id).replaceChildren();
  for (const id of ['scope-label', 'updated-at', 'tick', 'revision', 'currency', 'location', 'player-mode', 'character-name', 'character-status', 'character-note', 'receipt-summary']) $(id).textContent = '';
  $('workspace').hidden = true; $('login-panel').hidden = false; $('receipt').hidden = true; $('admin-content').hidden = true;
  $('connection-status').textContent = '未连接'; $('token').value = ''; $('guide-result').textContent = ''; $('guide-result').hidden = true;
}
function canAct() { return state?.character?.status === 'alive' && state?.player?.controlMode === 'character'; }
function guideStep() { return nextStep(state, { pending: session.pending, waitingId, completed }); }
function renderGuide() {
  const step = guideStep();
  $('guide-title').textContent = step.title; $('guide-text').textContent = step.text;
  $('guide-primary').textContent = busy ? '正在处理，请稍候…' : step.label;
  $('guide-primary').disabled = busy || !state;
  $('guide-context').textContent = state ? `你正在操控「${displayName(state.character?.name || state.character?.id)}」，位于${displayName(state.location?.name || state.location?.id)}。` : '';
  $('settlement-help').textContent = state?.worldId === 'phyrex-trial' ? '试运行世界约每分钟结算一轮；刚唤醒或排队时可能更久。请点“查看执行结果”，不要重复提交。' : '行动在下一次世界推进时结算。稍后点“查看执行结果”；页面不会自动刷新。';
  for (let n = 1; n <= 3; n++) {
    const el = $(`guide-step-${n}`); el.classList.toggle('current', step.step === n); el.classList.toggle('done', step.step > n);
    if (step.step === n) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  }
  $('guide-result').hidden = !shownReceipt;
  if (shownReceipt) $('guide-result').textContent = receiptText(shownReceipt, knownTypes.get(shownReceipt.id));
  $('action-help').textContent = session.pending ? '上一条行动尚未确认收到。请先按原编号重试。' : waitingId ? '上一次行动还在等待结算。请在上方查看结果，完成后再做下一步。' : canAct() ? '点选行动后，在上方查看结果。数值来自当前世界规则，以实际结算为准。' : '当前没有可行动角色，按钮暂不可用。请联系管理员绑定或更换角色。';
}
function updateButtons() {
  for (const button of document.querySelectorAll('button[data-command]')) button.disabled = busy || !canAct() || Boolean(session.pending) || Boolean(waitingId) || Boolean(button.dataset.unavailable);
  for (const id of ['refresh', 'open-admin', 'history-first', 'audit-first', 'refresh-receipt']) $(id).disabled = busy;
  $('history-next').disabled = busy || !historyCursor; $('audit-next').disabled = busy || !auditCursor;
  $('retry').disabled = busy; $('pending-panel').hidden = !session.pending;
  $('pending-id').textContent = session.pending?.id || '';
  $('login-form').querySelector('button').disabled = busy;
  $('audit-form').querySelector('button').disabled = busy;
  renderGuide();
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
  const intentType = type || session.pending?.type;
  notice(`正在提交${actionNames[intentType] || '行动'}，请不要重复点击。`);
  const receipt = await session.submit(type, payload);
  remember(knownTypes, receipt.id, intentType);
  showReceipt(receipt);
  await refresh();
  notice(receiptText(shownReceipt, intentType));
  $('guide').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('guide-title').focus({ preventScroll: true });
}
function showReceipt(receipt) {
  lastReceipt = receipt.id; shownReceipt = receipt; remember(viewedReceipts, receipt.id, receipt);
  const type = receiptType(receipt) || knownTypes.get(receipt.id);
  if (receipt.result?.status === 'completed' && type) completed.add(type);
  $('receipt-summary').textContent = receiptText(receipt, type);
  $('receipt-body').textContent = `编号：${receipt.id}\n入库：${receipt.status === 'applied' ? '已处理' : '排队中'}\n\n${JSON.stringify(receipt.result, null, 2)}`;
  $('receipt').hidden = false;
}
function renderState(data) {
  state = data;
  $('scope-label').textContent = displayName(data.player.name || data.player.id);
  $('tick').textContent = data.tick; $('revision').textContent = data.revision;
  $('currency').textContent = data.character?.resources?.currency ?? '—'; $('location').textContent = displayName(data.location?.name || data.location?.id);
  $('player-mode').textContent = data.player.controlMode === 'character' ? '角色控制模式' : '观察模式';
  $('character-name').textContent = data.character ? displayName(data.character.name || data.character.id) : '尚无当前角色';
  $('character-status').textContent = data.character?.status === 'alive' ? '存活' : data.character?.status || '观察中';
  const stats = data.character?.stats || {};
  pairs('character-stats', [['生命', `${stats.health ?? '—'} / ${stats.maxHealth ?? '—'}`], ['体力', `${stats.energy ?? '—'} / ${stats.maxEnergy ?? '—'}`], ['力量', stats.power], ['防御', stats.defense], ['累计经验', data.character?.actionState?.experience], ['食物', data.character?.resources?.food]]);
  $('character-note').textContent = canAct() ? '体力不足时先休息；力量决定攻击能力，防御减少受到的伤害。当前状态也会受到世界运行的影响。' : '当前处于观察模式或角色不可行动。请联系管理员绑定或更换角色。';
  const descriptions = actionDescriptions(data.actionRules);
  $('action-buttons').replaceChildren(...['work', 'rest', 'train', 'wait'].map(type => {
    const card = node('div', undefined, 'action-card'), button = commandButton(actionNames[type], type, type === 'wait' ? { ticks: 1 } : {});
    const cost = type === 'work' ? data.actionRules?.workEnergy : type === 'train' ? data.actionRules?.trainingEnergy : 0;
    if (Number.isFinite(cost) && stats.energy < cost) { button.dataset.unavailable = 'energy'; button.textContent += '（体力不足）'; }
    card.append(button, node('p', descriptions[type] + (button.dataset.unavailable ? ' 请先休息。' : ''))); return card;
  }));
  renderCommerce(data.inventory);
  $('updated-at').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')}`;
}
function itemRow(title, detail, buttons = []) {
  const row = node('div', undefined, 'item-row'), text = node('div'), actions = node('div', undefined, 'button-row');
  text.append(node('strong', title), node('p', detail, 'muted')); actions.append(...buttons); row.append(text, actions); return row;
}
function renderCommerce(inventory = { items: [], shops: [] }) {
  $('inventory-count').textContent = `${inventory.itemCount ?? 0} 组物品`;
  $('shop-count').textContent = `${inventory.shopCount ?? 0} 家商店`;
  const items = inventory.items.map(item => {
    const buttons = [];
    if (item.type === 'equipment') buttons.push(commandButton(item.equipped ? '卸下' : '装备', item.equipped ? 'unequip_item' : 'equip_item', item.equipped ? { slot: item.slot } : { itemId: item.id }));
    if (item.type === 'consumable') buttons.push(commandButton('使用', 'use_item', { itemId: item.id }));
    if (!item.equipped && inventory.shops.length) {
      const select = node('select'); select.setAttribute('aria-label', `出售${itemName(item)}到商店`);
      for (const shop of inventory.shops) { const option = node('option', displayName(shop.name || shop.id)); option.value = shop.id; select.append(option); }
      const sell = node('button', '出售 1 件'); sell.type = 'button'; sell.dataset.command = 'sell_item';
      sell.addEventListener('click', () => run(() => send('sell_item', { shopId: select.value, itemId: item.id, quantity: 1 })));
      buttons.push(select, sell);
    }
    return itemRow(`${itemName(item)} × ${item.quantity}`, itemDescription(item), buttons);
  });
  $('inventory-list').replaceChildren(...(items.length ? items : [node('p', '背包还是空的。去旁边商店买一件装备，再回来点击“装备”。', 'empty')]));
  if (inventory.itemCount > items.length) $('inventory-list').append(node('p', `展示 ${items.length} / ${inventory.itemCount} 组物品`, 'muted'));
  const shops = [];
  for (const shop of inventory.shops) {
    shops.push(node('h3', displayName(shop.name || shop.id)));
    for (const stock of shop.stock) {
      const button = commandButton(stock.quantity > 0 ? `购买 · ${stock.price} 货币` : '已售罄', 'buy_item', { shopId: shop.id, definitionId: stock.definitionId, quantity: 1 });
      if (stock.quantity <= 0) button.dataset.unavailable = 'stock';
      else if ((state.character?.resources?.currency ?? 0) < stock.price) { button.dataset.unavailable = 'currency'; button.textContent = '货币不足，先工作'; }
      shops.push(itemRow(itemName(stock), `${itemDescription(stock)} · 库存 ${stock.quantity}`, [button]));
    }
    if (inventory.shopCount > inventory.shops.length) shops.push(node('p', `展示 ${inventory.shops.length} / ${inventory.shopCount} 家商店`, 'muted'));
    if (shop.stockCount > shop.stock.length) shops.push(node('p', `已显示 ${shop.stock.length} / ${shop.stockCount} 种商品`, 'muted'));
  }
  $('shop-list').replaceChildren(...(shops.length ? shops : [node('p', '当前地点没有商店。', 'empty')]));
}
function renderHistory(page) {
  historyCursor = page.nextBeforeSequence;
  const rows = page.records.map(record => {
    const row = node('tr'), action = node('td'), button = node('button', '查看结果');
    button.addEventListener('click', () => run(async () => showReceipt(await session.receipt(record.id))));
    const viewed = viewedReceipts.get(record.id), type = receiptType(viewed) || knownTypes.get(record.id);
    const label = actionNames[type] || `行动 #${record.sequence}`;
    action.append(button); row.append(node('td', record.sequence), node('td', label), node('td', viewed?.result?.status === 'completed' ? '已完成' : viewed?.result?.status === 'rejected' ? '未完成，请看原因' : record.status === 'applied' ? '已结算，查看结果' : '等待结算'), action); return row;
  });
  $('history-list').replaceChildren(...rows); $('history-empty').hidden = rows.length > 0;
}
async function refresh() {
  const history = await session.history();
  const queued = history.records.find(row => row.status === 'pending');
  if (queued) lastReceipt = queued.id;
  if (!lastReceipt && history.records.length) lastReceipt = history.records[0].id;
  if (lastReceipt) showReceipt(await session.receipt(lastReceipt));
  waitingId = queued && viewedReceipts.get(queued.id)?.status !== 'applied' ? queued.id : shownReceipt?.status === 'pending' || shownReceipt?.result?.status === 'accepted' ? shownReceipt.id : null;
  renderState(await session.state()); renderHistory(history);
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
    notice(session.pending ? '已恢复上次未确认的行动，请先按原编号重试。' : '已连接。先看下方入门引导，点击绿色按钮开始。');
  });
});
$('disconnect').addEventListener('click', () => { epoch++; session.disconnect(); busy = false; clearViews(); updateButtons(); notice('已退出连接，访问令牌已从页面清除。'); });
$('refresh').addEventListener('click', () => run(async () => { await refresh(); notice('已读取最新保存的世界状态。'); }));
$('retry').addEventListener('click', () => run(() => send()));
$('refresh-receipt').addEventListener('click', () => run(async () => { await refresh(); notice(receiptText(shownReceipt, knownTypes.get(lastReceipt))); }));
$('guide-primary').addEventListener('click', () => {
  const step = guideStep();
  if (step.kind === 'actions') { $('actions').scrollIntoView({ behavior: 'smooth' }); $('action-buttons').querySelector('button')?.focus({ preventScroll: true }); return; }
  run(async () => {
    if (step.kind === 'command') await send(step.type, step.payload);
    else if (step.kind === 'retry') await send();
    else { await refresh(); notice(shownReceipt ? receiptText(shownReceipt, knownTypes.get(lastReceipt)) : '角色状态已刷新。'); }
  });
});
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
window.addEventListener('pagehide', () => { epoch++; session.disconnect(); clearViews(); });
window.addEventListener('pageshow', event => { if (event.persisted) { busy = false; updateButtons(); notice('页面已恢复，请重新连接。'); } });
updateButtons();
