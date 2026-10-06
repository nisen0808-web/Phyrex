// Presentation only: costs and effects come from the authorized server view.
export const actionNames = { wait: '等待', work: '工作', rest: '休息', train: '训练', buy_item: '购买物品', sell_item: '出售物品', equip_item: '装备物品', unequip_item: '卸下装备', use_item: '使用物品' };
const defaults = { wooden_sword: ['Wooden Sword', '木剑'], cloth_robe: ['Cloth Robe', '布衣'], healing_pill: ['Healing Pill', '疗伤丹'], spirit_stone: ['Spirit Stone', '灵石'], forest_herb: ['Forest Herb', '林间草药'] };
export const statNames = { health: '生命', energy: '体力', power: '力量', defense: '防御', speed: '速度', intelligence: '智力', social: '社交', maxHealth: '生命上限', maxEnergy: '体力上限' };
export function itemName(item = {}) {
  const preset = Object.hasOwn(defaults, item.definitionId) ? defaults[item.definitionId] : null;
  return preset && (!item.name || item.name === preset[0] || item.name === item.definitionId) ? preset[1] : item.name || item.definitionId || '物品';
}
export function displayName(value) {
  const names = { village: '村庄', forest: '森林', town: '城镇', 'Trial Player': '试运行玩家', 'village Market': '村庄杂货铺', 'village Herbalist': '村庄药铺' };
  if (Object.hasOwn(names, value)) return names[value];
  if (/^founder_\d+$/.test(value || '')) return `旅人 ${Number(value.slice(8)) + 1}`;
  return value || '未指定';
}
export function itemDescription(item) {
  const details = [];
  for (const [key, value] of Object.entries(item.type === 'consumable' ? item.effects || {} : item.stats || {})) {
    const shownKey = item.type === 'equipment' && ['health', 'energy'].includes(key) ? key === 'health' ? 'maxHealth' : 'maxEnergy' : key;
    if (Object.hasOwn(statNames, shownKey) && Number.isFinite(value) && value > 0) details.push(`${statNames[shownKey]} +${value}`);
  }
  const type = { equipment: '装备', consumable: '消耗品', material: '材料', treasure: '宝物' }[item.type] || '物品';
  return `${type}${details.length ? ` · ${item.type === 'consumable' ? '使用恢复，最多 ' : '装备后 '}${details.join('，')}` : ''}${item.equipped ? ' · 已装备' : ''}`;
}
export function actionDescriptions(rules = {}) {
  const resource = rules.workResource === 'currency' ? '货币' : rules.workResource || '资源';
  return { work: `获得 ${rules.workYield ?? '—'} ${resource}，消耗 ${rules.workEnergy ?? '—'} 体力。`,
    rest: `最多恢复 ${rules.restEnergy ?? '—'} 体力、${rules.restHealth ?? '—'} 生命，不超过上限。`,
    train: `获得 ${rules.trainingExperience ?? '—'} 经验，消耗 ${rules.trainingEnergy ?? '—'} 体力；每累计 ${rules.experiencePerPower ?? '—'} 经验提升力量。`,
    wait: '不主动工作或训练，等待世界处理这条行动。' };
}
const reasons = {
  insufficient_energy: '体力不足，先休息恢复后再试。', action_budget_exhausted: '同一轮已执行过行动。等下一轮再试，不要连续提交。',
  insufficient_currency: '货币不足，可以先工作，或选择更便宜的商品。', insufficient_stock: '商店库存不足，请刷新后选择其他商品。',
  out_of_stock: '商品已售罄，请选择其他商品。', inventory_full: '背包已满，可以出售不需要的物品。',
  shop_not_at_location: '角色已不在这家商店所在地点，请刷新商店。', shop_insufficient_currency: '商店的钱不够，暂时无法收购物品。',
  missing_item: '这件物品已不存在，请刷新背包。', item_not_owned: '这件物品不属于当前角色，请刷新背包。',
  active_character_not_alive: '角色已无法行动，需要管理员处理角色。', actor_not_alive: '角色已无法行动，需要管理员处理角色。',
  observer_cannot_act: '当前在观察模式，需要绑定可控制的角色后才能行动。', missing_active_character: '当前没有可控制的角色，请联系管理员绑定角色。',
  training_cap: '训练已达到当前上限，可以尝试其他行动。', invalid_actor_state: '角色状态异常，请联系管理员检查。',
  no_item_effect: '当前生命或体力已满，这件物品现在没有效果，无需消耗。',
};
export function receiptType(receipt) { return receipt?.result?.outcome?.actionType || receipt?.result?.type || ''; }
export function waitingReceiptId(receipt) { return receipt?.status === 'pending' || receipt?.result?.status === 'accepted' ? receipt.id : null; }
export function receiptText(receipt, knownType = '') {
  if (!receipt) return '还没有行动记录。';
  const type = receiptType(receipt) || knownType, label = actionNames[type] || '行动';
  if (receipt.status === 'pending') return `${label}已收到，正在等待世界结算。请稍后点击“查看执行结果”，不必重复提交。`;
  const result = receipt.result, outcome = result?.outcome || {}, value = outcome.value || {};
  if (result?.status === 'rejected') return `${label}未完成：${reasons[outcome.reason] || '执行条件不满足，请刷新角色和物品状态后再试。'}`;
  if (result?.status !== 'completed') return `${label}尚未确认完成，请稍后查看执行结果。`;
  const effects = [];
  if (Number.isFinite(value.amount)) effects.push(`${value.resource === 'currency' ? '货币' : value.resource || '资源'} +${value.amount}`);
  for (const [key, label] of [['energyCost', '体力消耗'], ['energyGain', '体力恢复'], ['healthGain', '生命恢复'], ['gainedExperience', '经验增加'], ['powerGain', '力量增加'], ['cost', '花费货币'], ['revenue', '获得货币']]) {
    if (Number.isFinite(value[key]) && value[key] > 0) effects.push(`${label} ${value[key]}`);
  }
  if (type === 'buy_item') effects.push(`${itemName({ definitionId: value.definitionId })}已放入背包`);
  if (type === 'equip_item') effects.push('装备已生效，角色属性已更新');
  if (type === 'use_item') effects.push('已使用 1 件物品，角色状态已更新');
  if (type === 'wait') effects.push('现在可以选择工作、休息或训练');
  return `${label}完成${effects.length ? `：${effects.join('；')}` : '。角色状态已更新。'}`;
}
export function nextStep(state, { pending, waitingId, completed = new Set() } = {}) {
  if (pending) return { title: '先确认上一次操作', text: '刚才的连接没有返回确认。用原编号重试，可以避免重复扣款或重复执行。', label: '确认上一次操作', kind: 'retry', step: 0 };
  if (waitingId) return { title: '行动已收到，等待结算', text: '现在不用再点行动按钮。等待世界推进，再查看这条行动的结果。', label: '查看执行结果', kind: 'refresh', step: 0 };
  if (!state?.character || state.player?.controlMode !== 'character' || state.character.status !== 'alive') return { title: '当前只能查看世界', text: '你的账号目前没有可以行动的角色。需要管理员绑定或更换角色；本页面暂不支持创建角色。', label: '刷新角色状态', kind: 'refresh', step: 0 };
  const rules = state.actionRules || {}, stats = state.character.stats || {}, inventory = state.inventory || { items: [], shops: [] };
  const action = (title, text, label, type, payload = {}, step = 1) => ({ title, text, label, type, payload, kind: 'command', step });
  if ((stats.energy ?? 0) < (rules.workEnergy ?? 0)) return action('先恢复体力', `当前体力 ${stats.energy ?? 0}，不足以工作。先休息一次，再继续体验。`, '休息，恢复体力', 'rest');
  if (!completed.has('work')) return action('第一步：亲手完成一次工作', `${actionDescriptions(rules).work} 点一次即可；收到指令后，我们会告诉你何时查看结果。`, '开始工作', 'work');
  const equipment = inventory.items.find(item => item.type === 'equipment' && !item.equipped);
  if (equipment) return action('下一步：穿戴刚获得的装备', `${itemName(equipment)} · ${itemDescription(equipment)}。装备后查看角色属性的变化。`, `装备${itemName(equipment)}`, 'equip_item', { itemId: equipment.id }, 3);
  if (inventory.items.some(item => item.equipped)) return { title: '你已掌握基本操作', text: '接下来可以工作积累资源、训练提升力量、休息恢复体力，或到商店选择其他物品。每次操作完成后都能看到实际结果。', label: '选择下一步行动', kind: 'actions', step: 4 };
  const goods = inventory.shops.flatMap(shop => shop.stock.filter(stock => stock.type === 'equipment' && stock.quantity > 0).map(stock => ({ ...stock, shopId: shop.id })));
  goods.sort((a, b) => a.price - b.price || a.definitionId.localeCompare(b.definitionId));
  const choice = goods[0];
  if (!choice) return { title: '工作完成，继续探索角色成长', text: '当前商店没有可购买的装备。你可以继续工作、训练，或休息恢复状态。', label: '选择下一步行动', kind: 'actions', step: 2 };
  if ((state.character.resources?.currency ?? 0) < choice.price) return action('再积累一些货币', `${itemName(choice)}需要 ${choice.price} 货币。${actionDescriptions(rules).work}`, '再工作一次', 'work', {}, 2);
  return action('第二步：购买第一件装备', `${itemName(choice)}，${choice.price} 货币。${itemDescription(choice)}。购买完成后，下一步会带你装备它。`, `购买${itemName(choice)} · ${choice.price} 货币`, 'buy_item', { shopId: choice.shopId, definitionId: choice.definitionId, quantity: 1 }, 2);
}
