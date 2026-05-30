const SAVE_KEY = "mud_xianxia_world_v3";
const WORLD_VERSION = 3;

const ACTION_LABELS = {
  cultivate: "修炼",
  meditate: "打坐",
  work: "赚钱",
  explore: "探索",
  socialize: "社交",
  askItem: "索要物品",
  inviteTeam: "邀请组队",
  ambush: "偷袭",
};

const REALM_NAMES = ["凡人", "练气一层", "练气二层", "练气三层", "筑基初期", "筑基中期", "筑基后期", "金丹初期", "金丹中期", "金丹后期"];

const LOCATIONS = [
  { id: "starter_village", name: "新手村", region: "中州", type: "settlement", x: 50, y: 55, danger: 3, wealth: 4, qi: 3, desc: "凡人和散修聚集之地，安全但资源有限。" },
  { id: "qingyun", name: "青云宗", region: "中州", type: "sect", x: 50, y: 25, danger: 5, wealth: 5, qi: 8, sect: "青云宗", desc: "正道宗门，适合修炼和结交同门。" },
  { id: "market", name: "坊市", region: "中州", type: "market", x: 28, y: 62, danger: 8, wealth: 9, qi: 4, desc: "交易、赚钱、打听消息最方便的地方。" },
  { id: "capital", name: "皇城", region: "中州", type: "settlement", x: 70, y: 57, danger: 10, wealth: 8, qi: 5, desc: "权贵云集，机会多，规矩也多。" },
  { id: "blood_saber", name: "血刀门", region: "西荒", type: "sect danger", x: 18, y: 34, danger: 22, wealth: 6, qi: 7, sect: "血刀门", desc: "魔道宗门，强者为尊，争斗频繁。" },
  { id: "black_forest", name: "黑风林", region: "西荒", type: "danger", x: 22, y: 78, danger: 28, wealth: 6, qi: 6, desc: "野兽和劫修出没，适合探索但风险很高。" },
  { id: "spirit_mine", name: "灵石矿洞", region: "西荒", type: "danger", x: 42, y: 82, danger: 24, wealth: 10, qi: 5, desc: "资源丰富，容易发生抢夺和偷袭。" },
  { id: "poison_valley", name: "万毒谷", region: "南疆", type: "sect danger", x: 80, y: 76, danger: 26, wealth: 6, qi: 8, sect: "万毒谷", desc: "南疆毒修之地，危险但灵气浓厚。" },
  { id: "southern_mountains", name: "十万大山", region: "南疆", type: "danger", x: 88, y: 86, danger: 34, wealth: 8, qi: 7, desc: "妖兽横行，低境界修士可能一去不回。" },
  { id: "sword_sect", name: "剑宗", region: "北境", type: "sect", x: 72, y: 20, danger: 12, wealth: 5, qi: 9, sect: "剑宗", desc: "北境剑修圣地，修炼快但门规严。" },
  { id: "icefield", name: "冰原", region: "北境", type: "danger", x: 88, y: 30, danger: 30, wealth: 7, qi: 8, desc: "寒气刺骨，适合历练，也容易丧命。" },
  { id: "east_market", name: "东海坊市", region: "东海", type: "market", x: 62, y: 78, danger: 14, wealth: 9, qi: 5, desc: "海商、散修、妖族交易之地。" },
  { id: "sea_islands", name: "海妖群岛", region: "东海", type: "danger", x: 72, y: 88, danger: 32, wealth: 9, qi: 8, desc: "海妖出没，秘宝很多，死亡率也高。" },
];

const MAP_PATHS = [
  ["starter_village", "qingyun"], ["starter_village", "market"], ["starter_village", "capital"],
  ["market", "spirit_mine"], ["spirit_mine", "black_forest"], ["black_forest", "blood_saber"],
  ["capital", "sword_sect"], ["sword_sect", "icefield"], ["capital", "east_market"],
  ["east_market", "sea_islands"], ["east_market", "poison_valley"], ["poison_valley", "southern_mountains"],
];

const SECTS = {
  "无门派": { alignment: "散修", home: "starter_village" },
  "青云宗": { alignment: "正道", home: "qingyun" },
  "血刀门": { alignment: "魔道", home: "blood_saber" },
  "剑宗": { alignment: "正道", home: "sword_sect" },
  "万毒谷": { alignment: "旁门", home: "poison_valley" },
};

const NPC_BLUEPRINTS = [
  { name: "林青竹", temperament: "谨慎", ambition: 62, sect: "青云宗", location: "qingyun" },
  { name: "陈不归", temperament: "贪婪", ambition: 78, sect: "无门派", location: "market" },
  { name: "白洛", temperament: "温和", ambition: 45, sect: "青云宗", location: "qingyun" },
  { name: "沈孤鸿", temperament: "冷漠", ambition: 84, sect: "剑宗", location: "sword_sect" },
  { name: "苏小满", temperament: "好奇", ambition: 55, sect: "无门派", location: "east_market" },
  { name: "韩铁衣", temperament: "好战", ambition: 88, sect: "血刀门", location: "blood_saber" },
  { name: "苗七娘", temperament: "阴狠", ambition: 74, sect: "万毒谷", location: "poison_valley" },
  { name: "陆采薇", temperament: "商人", ambition: 58, sect: "无门派", location: "market" },
];

let state;

const el = {
  worldDate: document.getElementById("worldDate"), worldSub: document.getElementById("worldSub"), playerCard: document.getElementById("playerCard"),
  actionSelect: document.getElementById("actionSelect"), targetSelect: document.getElementById("targetSelect"), daysInput: document.getElementById("daysInput"),
  ordersList: document.getElementById("ordersList"), relationsGrid: document.getElementById("relationsGrid"), npcList: document.getElementById("npcList"), logList: document.getElementById("logList"),
  worldMap: document.getElementById("worldMap"), locationLegend: document.getElementById("locationLegend"),
  btnAssign: document.getElementById("btnAssign"), btnTick: document.getElementById("btnTick"), btnTick10: document.getElementById("btnTick10"), btnOffline: document.getElementById("btnOffline"), btnSave: document.getElementById("btnSave"), btnReset: document.getElementById("btnReset"),
};

function createWorld() {
  const actors = [
    createActor({ id: "player", name: "你", isPlayer: true, temperament: "玩家", ambition: 70, sect: "无门派", location: "starter_village" }),
    ...NPC_BLUEPRINTS.map((npc, index) => createActor({ id: `npc_${index + 1}`, isPlayer: false, ...npc })),
  ];
  const world = { version: WORLD_VERSION, day: 1, year: 1, seasonIndex: 0, actors, relations: {}, hatred: {}, orders: [], logs: [], lastSavedAt: Date.now() };
  initializeRelations(world);
  addLog(world, "世界初生，五域开启，修士开始在地图中行动。", "system");
  return world;
}

function createActor({ id, name, isPlayer, temperament, ambition, sect, location }) {
  const realm = isPlayer ? 1 : randInt(0, 3);
  return { id, name, isPlayer, temperament, ambition, sect, location, age: randInt(16, 31), lifespan: randInt(75, 105), realm, exp: randInt(0, 45), hp: 100, maxHp: 100, qi: randInt(25, 70), maxQi: 100, wealth: randInt(20, 130), items: randInt(0, 3), alive: true, teamWith: null, spouse: null, wounds: 0, kills: 0, reputation: randInt(-5, 10), karma: 0 };
}

function initializeRelations(world) {
  for (const a of world.actors) for (const b of world.actors) {
    if (a.id === b.id) continue;
    let base = randInt(-10, 20);
    if (a.sect !== "无门派" && a.sect === b.sect) base += 15;
    if (SECTS[a.sect]?.alignment === "正道" && SECTS[b.sect]?.alignment === "魔道") base -= 20;
    if (SECTS[a.sect]?.alignment === "魔道" && SECTS[b.sect]?.alignment === "正道") base -= 20;
    setRelation(world, a.id, b.id, base);
    setHatred(world, a.id, b.id, Math.max(0, -base));
  }
}

function loadWorld() {
  try { const raw = localStorage.getItem(SAVE_KEY); if (!raw) return createWorld(); const parsed = JSON.parse(raw); if (!parsed || parsed.version !== WORLD_VERSION) return createWorld(); return parsed; } catch { return createWorld(); }
}
function saveWorld() { if (!state) return; state.lastSavedAt = Date.now(); localStorage.setItem(SAVE_KEY, JSON.stringify(state)); }
function resetWorld() { if (!confirm("确定要重开世界？当前本地存档会被删除。")) return; localStorage.removeItem(SAVE_KEY); state = createWorld(); saveWorld(); render(); }
function addLog(world, text, type = "event") { world.logs.unshift({ day: world.day, year: world.year, season: getSeason(world), text, type }); world.logs = world.logs.slice(0, 160); }
function getSeason(world) { return ["春", "夏", "秋", "冬"][world.seasonIndex] || "春"; }

function advanceDays(days) { for (let i = 0; i < days; i++) advanceOneDay(); saveWorld(); render(); }
function advanceOneDay() { state.day++; if (state.day > 90) { state.day = 1; state.seasonIndex++; if (state.seasonIndex > 3) { state.seasonIndex = 0; state.year++; ageActors(); } } executeOrders(); npcAutonomy(); sectDynamics(); naturalRecovery(); checkDeaths(); }
function ageActors() { for (const actor of state.actors) if (actor.alive) { actor.age++; if (actor.age > actor.lifespan && roll(clamp((actor.age - actor.lifespan) * 7, 5, 90))) killActor(actor, "寿元耗尽"); } }
function checkDeaths() { for (const actor of state.actors) if (actor.alive && actor.hp <= 0) killActor(actor, "伤势过重"); }
function naturalRecovery() { for (const actor of state.actors) if (actor.alive) { const loc = getLocation(actor.location); actor.qi = clamp(actor.qi + 2 + actor.realm + Math.floor((loc?.qi || 3) / 3), 0, actor.maxQi); if (actor.wounds > 0 && roll(32)) actor.wounds--; if (actor.hp < actor.maxHp && actor.wounds <= 2) actor.hp = clamp(actor.hp + 4, 0, actor.maxHp); } }
function executeOrders() { const left = []; for (const order of state.orders) { const actor = findActor(order.actorId); if (!actor || !actor.alive) continue; const target = order.targetId ? findActor(order.targetId) : null; runAction(actor, order.action, target, true); order.remainingDays--; if (order.remainingDays > 0) left.push(order); } state.orders = left; }
function npcAutonomy() { for (const npc of state.actors.filter(a => !a.isPlayer && a.alive)) { const action = chooseNpcAction(npc); const target = chooseNpcTarget(npc, action); runAction(npc, action, target, false); } }

function chooseNpcAction(npc) { const hpRate = npc.hp / npc.maxHp; if (hpRate < 0.45) return "meditate"; if (npc.temperament === "好战" && roll(22)) return "ambush"; if (npc.temperament === "阴狠" && roll(18)) return "ambush"; if (npc.temperament === "贪婪" && roll(28)) return "askItem"; if (npc.temperament === "温和" && roll(30)) return "socialize"; if (npc.temperament === "商人" && roll(45)) return "work"; if (npc.temperament === "好奇" && roll(30)) return "explore"; if (npc.ambition > 75 && roll(45)) return "cultivate"; return pick(["cultivate", "meditate", "work", "explore", "socialize"]); }
function chooseNpcTarget(npc, action) { const others = state.actors.filter(a => a.id !== npc.id && a.alive); if (!others.length) return null; if (action === "ambush") { const samePlace = others.filter(a => a.location === npc.location); const pool = samePlace.length ? samePlace : others; return [...pool].sort((a, b) => scoreVictim(npc, b) - scoreVictim(npc, a))[0]; } if (["socialize", "askItem", "inviteTeam"].includes(action)) { const samePlace = others.filter(a => a.location === npc.location); const pool = samePlace.length ? samePlace : others; return [...pool].sort((a, b) => getRelation(state, npc.id, b.id) - getRelation(state, npc.id, a.id))[0]; } return pick(others); }
function scoreVictim(actor, target) { return getHatred(state, actor.id, target.id) + getRelation(state, target.id, actor.id) * 0.25 + (target.wealth / 20) - target.realm * 3; }

function runAction(actor, action, target, fromOrder) { if (!actor.alive) return; if (["socialize", "askItem", "inviteTeam", "ambush"].includes(action) && target && target.alive && actor.location !== target.location) { moveTo(actor, target.location, `${actor.name} 为了${ACTION_LABELS[action]}前往 ${getLocationName(target.location)}。`); if (fromOrder) addLog(state, `${actor.name} 与 ${target.name} 不在同一地点，先移动到 ${getLocationName(target.location)}。`, "move"); return; } if (action === "cultivate") return cultivate(actor, fromOrder); if (action === "meditate") return meditate(actor, fromOrder); if (action === "work") return work(actor, fromOrder); if (action === "explore") return explore(actor, fromOrder); if (action === "socialize") return socialize(actor, target, fromOrder); if (action === "askItem") return askItem(actor, target, fromOrder); if (action === "inviteTeam") return inviteTeam(actor, target, fromOrder); if (action === "ambush") return ambush(actor, target, fromOrder); }
function moveTo(actor, locationId, logText) { if (!getLocation(locationId)) return; const old = actor.location; actor.location = locationId; if (old !== locationId && roll(actor.isPlayer ? 100 : 16)) addLog(state, logText || `${actor.name} 从 ${getLocationName(old)} 前往 ${getLocationName(locationId)}。`, "move"); }
function moveForAction(actor, action) { if (action === "work") return moveTo(actor, actor.wealth < 80 ? "market" : pick(["market", "capital", "east_market"])); if (action === "cultivate") return moveTo(actor, SECTS[actor.sect]?.home || "starter_village"); if (action === "explore") return moveTo(actor, pick(["black_forest", "spirit_mine", "icefield", "sea_islands", "southern_mountains"])); }

function cultivate(actor, fromOrder) { moveForAction(actor, "cultivate"); const loc = getLocation(actor.location); const gain = randInt(5, 12) + actor.realm + Math.floor((loc?.qi || 4) / 2); actor.exp += gain; actor.qi = clamp(actor.qi - randInt(3, 8), 0, actor.maxQi); if (actor.qi <= 5 && roll(18)) suffer(actor, randInt(3, 8), "强行修炼导致气血逆行"); const need = 80 + actor.realm * 45; if (actor.exp >= need && actor.realm < REALM_NAMES.length - 1) { actor.exp -= need; actor.realm++; actor.maxHp += 12; actor.maxQi += 10; actor.hp = actor.maxHp; actor.qi = actor.maxQi; actor.lifespan += randInt(4, 10); actor.reputation += 2; addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 突破到 ${REALM_NAMES[actor.realm]}。`, "breakthrough"); } else if (fromOrder && roll(18)) addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 修炼，修为增加 ${gain}。`, "action"); }
function meditate(actor, fromOrder) { const loc = getLocation(actor.location); actor.hp = clamp(actor.hp + randInt(6, 14), 0, actor.maxHp); actor.qi = clamp(actor.qi + randInt(8, 18) + Math.floor((loc?.qi || 4) / 2), 0, actor.maxQi); if (actor.wounds > 0 && roll(45)) actor.wounds--; if (fromOrder && roll(20)) addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 打坐恢复。`, "action"); }
function work(actor, fromOrder) { moveForAction(actor, "work"); const loc = getLocation(actor.location); const money = randInt(6, 18) + Math.floor(actor.realm * 1.5) + Math.floor((loc?.wealth || 4) / 2); actor.wealth += money; actor.qi = clamp(actor.qi - randInt(1, 5), 0, actor.maxQi); if (roll((loc?.danger || 5) / 3)) suffer(actor, randInt(1, 5), "谋生劳累或被人盘剥"); if (fromOrder || roll(12)) addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 赚钱，获得 ${money} 灵石。`, "action"); }
function explore(actor, fromOrder) { moveForAction(actor, "explore"); const loc = getLocation(actor.location); const danger = (loc?.danger || 18) + actor.wounds * 5 - actor.realm * 2; const reward = randInt(8, 28) + actor.realm * 2 + Math.floor((loc?.wealth || 5) / 2); if (roll(clamp(danger, 4, 75))) { const damage = randInt(8, 26) + Math.floor((loc?.danger || 10) / 6); suffer(actor, damage, `在${getLocationName(actor.location)}探索遇险`); if (actor.alive) addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 探索受伤，损失 ${damage} 气血。`, "danger"); } else { actor.wealth += reward; actor.items += roll(35) ? 1 : 0; actor.exp += randInt(2, 8); if (fromOrder || roll(34)) addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 探索有获，得到约 ${reward} 灵石资源。`, "action"); } }
function socialize(actor, target, fromOrder) { if (!target?.alive) return; const delta = randInt(3, 9) + (actor.sect === target.sect && actor.sect !== "无门派" ? 2 : 0); changeRelation(actor.id, target.id, delta); changeRelation(target.id, actor.id, Math.max(1, delta - randInt(0, 3))); changeHatred(actor.id, target.id, -2); changeHatred(target.id, actor.id, -2); if (fromOrder || roll(24)) addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 与 ${target.name} 来往，情感上升。`, "relation"); }
function askItem(actor, target, fromOrder) { if (!target?.alive) return; const rel = getRelation(state, actor.id, target.id); const chance = clamp(20 + rel * 0.55 + actor.realm * 3, 5, 92); if (target.items <= 0) { changeRelation(actor.id, target.id, -2); if (fromOrder) addLog(state, `${actor.name} 向 ${target.name} 索要物品，但对方没有可给之物。`, "relation"); return; } if (roll(chance)) { target.items--; actor.items++; changeRelation(actor.id, target.id, 2); addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 从 ${target.name} 处获得一件物品。`, "relation"); } else { changeRelation(actor.id, target.id, -4); changeRelation(target.id, actor.id, -7); changeHatred(target.id, actor.id, 5); if (fromOrder || roll(35)) addLog(state, `${actor.name} 向 ${target.name} 索要物品失败，关系变差。`, "relation"); } }
function inviteTeam(actor, target, fromOrder) { if (!target?.alive) return; const rel = getRelation(state, actor.id, target.id); const chance = clamp(15 + rel * 0.65 + actor.realm * 2, 3, 95); if (roll(chance)) { actor.teamWith = target.id; target.teamWith = actor.id; changeRelation(actor.id, target.id, 5); changeRelation(target.id, actor.id, 5); addLog(state, `${actor.name} 与 ${target.name} 在 ${getLocationName(actor.location)} 组队，彼此防备下降。`, "team"); } else { changeRelation(actor.id, target.id, -2); if (fromOrder || roll(30)) addLog(state, `${actor.name} 邀请 ${target.name} 组队失败。`, "relation"); } }
function ambush(actor, target, fromOrder) { if (!target?.alive) return; const rel = getRelation(state, target.id, actor.id); const hate = getHatred(state, actor.id, target.id); const trustBonus = clamp(rel * 0.45, -25, 45); const realmGap = (actor.realm - target.realm) * 8; const teamBonus = actor.teamWith === target.id ? 18 : 0; const chance = clamp(30 + trustBonus + realmGap + teamBonus + hate * 0.2 - target.wounds * 2, 5, 96); if (roll(chance)) { const stolen = Math.min(target.wealth, randInt(4, 18)); const damage = randInt(22, 48) + Math.max(0, actor.realm - target.realm) * 8; suffer(target, damage, `${actor.name} 偷袭`); actor.wealth += stolen; target.wealth = Math.max(0, target.wealth - stolen); changeRelation(target.id, actor.id, -45); changeRelation(actor.id, target.id, -15); changeHatred(target.id, actor.id, 40); actor.reputation -= 1; addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 偷袭 ${target.name} 成功，成功率 ${Math.round(chance)}%。`, "danger"); if (!target.alive) actor.kills++; } else { const counter = randInt(8, 24) + target.realm * 3; suffer(actor, counter, `${target.name} 反击`); changeRelation(target.id, actor.id, -35); changeRelation(actor.id, target.id, -20); changeHatred(target.id, actor.id, 30); addLog(state, `${actor.name} 在 ${getLocationName(actor.location)} 偷袭 ${target.name} 失败，被反击受伤。`, "danger"); } }

function sectDynamics() { if (state.day % 12 !== 0) return; for (const actor of state.actors.filter(a => a.alive && !a.isPlayer)) { if (actor.sect === "无门派" && actor.realm >= 2 && roll(20 + actor.ambition / 4)) { const sect = pick(["青云宗", "血刀门", "剑宗", "万毒谷"]); actor.sect = sect; actor.location = SECTS[sect].home; actor.reputation += 2; addLog(state, `${actor.name} 拜入 ${sect}，前往 ${getLocationName(actor.location)}。`, "sect"); } else if (actor.sect !== "无门派" && getSectMembers(actor.sect).length > 2 && roll(3)) { addLog(state, `${actor.name} 在 ${actor.sect} 与同门发生争执，门派内部关系震荡。`, "sect"); for (const other of getSectMembers(actor.sect)) if (other.id !== actor.id) changeRelation(actor.id, other.id, -randInt(1, 4)); } } }
function getSectMembers(sect) { return state.actors.filter(a => a.alive && a.sect === sect); }
function suffer(actor, damage, reason) { actor.hp = clamp(actor.hp - damage, 0, actor.maxHp); if (damage >= 12) actor.wounds++; if (actor.hp <= 0) killActor(actor, reason); }
function killActor(actor, reason) { if (!actor.alive) return; actor.alive = false; actor.hp = 0; actor.teamWith = null; for (const other of state.actors) if (other.teamWith === actor.id) other.teamWith = null; state.orders = state.orders.filter(o => o.actorId !== actor.id && o.targetId !== actor.id); addLog(state, `${actor.name} 因 ${reason} 死亡，地点：${getLocationName(actor.location)}。`, "death"); }
function assignOrder() { const player = findActor("player"); if (!player?.alive) { alert("玩家已经死亡，不能继续下达命令。可以重开世界。"); return; } const action = el.actionSelect.value; const days = clamp(Number(el.daysInput.value || 1), 1, 365); const needsTarget = ["socialize", "askItem", "inviteTeam", "ambush"].includes(action); const targetId = needsTarget ? el.targetSelect.value : null; if (needsTarget && !targetId) { alert("这个行动需要选择目标。 "); return; } state.orders.push({ id: `order_${Date.now()}_${Math.random().toString(16).slice(2)}`, actorId: "player", action, targetId, remainingDays: days, totalDays: days }); const target = targetId ? findActor(targetId) : null; addLog(state, `你下达命令：${ACTION_LABELS[action]}${target ? `，目标 ${target.name}` : ""}，持续 ${days} 天。`, "system"); saveWorld(); render(); }
function relationKey(a, b) { return `${a}->${b}`; }
function getRelation(world, a, b) { return world.relations[relationKey(a, b)] ?? 0; }
function setRelation(world, a, b, value) { world.relations[relationKey(a, b)] = clamp(Math.round(value), -100, 100); }
function changeRelation(a, b, delta) { setRelation(state, a, b, getRelation(state, a, b) + delta); }
function getHatred(world, a, b) { return world.hatred?.[relationKey(a, b)] ?? 0; }
function setHatred(world, a, b, value) { if (!world.hatred) world.hatred = {}; world.hatred[relationKey(a, b)] = clamp(Math.round(value), 0, 100); }
function changeHatred(a, b, delta) { setHatred(state, a, b, getHatred(state, a, b) + delta); }
function findActor(id) { return state.actors.find(actor => actor.id === id); }
function getLocation(id) { return LOCATIONS.find(l => l.id === id); }
function getLocationName(id) { return getLocation(id)?.name || "未知之地"; }
function relationName(value) { if (value <= -70) return "死敌"; if (value <= -30) return "仇怨"; if (value < 10) return "陌生"; if (value < 35) return "熟人"; if (value < 65) return "朋友"; if (value < 85) return "挚友"; return "生死之交"; }
function render() { renderWorld(); renderPlayer(); renderTargets(); renderMap(); renderOrders(); renderRelations(); renderNpcs(); renderLogs(); }
function renderWorld() { const alive = state.actors.filter(a => a.alive).length; const dead = state.actors.length - alive; const sectSummary = Object.keys(SECTS).filter(s => s !== "无门派").map(s => `${s}${getSectMembers(s).length}`).join("｜"); el.worldDate.textContent = `第 ${state.year} 年 ${getSeason(state)} 第 ${state.day} 日`; el.worldSub.textContent = `存活 ${alive} 人，死亡 ${dead} 人，长期命令 ${state.orders.length} 条｜门派：${sectSummary}`; }
function renderPlayer() { el.playerCard.innerHTML = renderActorStats(findActor("player")); }
function renderActorStats(actor) { if (!actor) return `<div class="empty">没有角色</div>`; const team = actor.teamWith ? findActor(actor.teamWith) : null; return `<div class="npc-title"><strong>${escapeHtml(actor.name)}</strong><span class="badge ${actor.alive ? "alive" : "dead"}">${actor.alive ? "存活" : "死亡"}</span></div><div class="stat-grid"><div class="stat"><div class="label">年龄 / 寿命</div><div class="value">${actor.age}/${actor.lifespan}</div></div><div class="stat"><div class="label">境界</div><div class="value">${REALM_NAMES[actor.realm]}</div></div><div class="stat"><div class="label">气血</div><div class="value">${actor.hp}/${actor.maxHp}</div></div><div class="stat"><div class="label">灵气</div><div class="value">${actor.qi}/${actor.maxQi}</div></div><div class="stat"><div class="label">灵石</div><div class="value">${actor.wealth}</div></div><div class="stat"><div class="label">物品</div><div class="value">${actor.items}</div></div><div class="stat"><div class="label">声望</div><div class="value">${actor.reputation}</div></div><div class="stat"><div class="label">伤势</div><div class="value">${actor.wounds}</div></div></div><div><span class="badge">位置：${getLocationName(actor.location)}</span><span class="badge">门派：${actor.sect}</span><span class="badge">性格：${escapeHtml(actor.temperament)}</span>${team ? `<span class="badge team">组队：${escapeHtml(team.name)}</span>` : ""}${actor.kills ? `<span class="badge dead">击杀：${actor.kills}</span>` : ""}</div>`; }
function renderTargets() { const targets = state.actors.filter(a => a.id !== "player" && a.alive); el.targetSelect.innerHTML = targets.map(a => `<option value="${a.id}">${escapeHtml(a.name)}｜${getLocationName(a.location)}｜${relationName(getRelation(state, "player", a.id))} ${getRelation(state, "player", a.id)}</option>`).join(""); }
function renderMap() { if (!el.worldMap) return; const regionLabels = [{ name: "中州", x: 51, y: 46 }, { name: "西荒", x: 23, y: 53 }, { name: "南疆", x: 83, y: 78 }, { name: "北境", x: 78, y: 18 }, { name: "东海", x: 68, y: 78 }]; const paths = MAP_PATHS.map(([a, b]) => renderPath(getLocation(a), getLocation(b))).join(""); const labels = regionLabels.map(r => `<div class="map-region-label" style="left:${r.x}%;top:${r.y}%">${r.name}</div>`).join(""); const locs = LOCATIONS.map(loc => { const actors = state.actors.filter(a => a.location === loc.id); const chips = actors.map(a => `<span class="actor-chip ${a.isPlayer ? "player" : ""} ${a.alive ? "" : "inactive"}">${a.isPlayer ? "你" : escapeHtml(a.name)}</span>`).join("") || `<span class="actor-chip inactive">无人</span>`; return `<div class="map-location ${loc.type}" style="left:${loc.x}%;top:${loc.y}%"><div class="map-location-title"><span>${loc.name}</span><span class="badge">险 ${loc.danger}</span></div><div class="map-location-meta">${loc.region}｜财 ${loc.wealth}｜灵 ${loc.qi}<br>${loc.desc}</div><div class="map-actors">${chips}</div></div>`; }).join(""); el.worldMap.innerHTML = paths + labels + locs; el.locationLegend.innerHTML = Object.keys(SECTS).filter(s => s !== "无门派").map(s => `<div class="legend-item"><strong>${s}</strong><br>${SECTS[s].alignment}｜山门：${getLocationName(SECTS[s].home)}｜弟子：${getSectMembers(s).length}</div>`).join(""); }
function renderPath(a, b) { if (!a || !b) return ""; const dx = b.x - a.x, dy = b.y - a.y; const len = Math.sqrt(dx * dx + dy * dy); const angle = Math.atan2(dy, dx) * 180 / Math.PI; return `<div class="map-path" style="left:${a.x}%;top:${a.y}%;width:${len}%;transform:rotate(${angle}deg)"></div>`; }
function renderOrders() { if (!state.orders.length) { el.ordersList.innerHTML = `<div class="empty">暂无长期命令。</div>`; return; } el.ordersList.innerHTML = state.orders.map(o => { const a = findActor(o.actorId); const t = o.targetId ? findActor(o.targetId) : null; return `<div class="order"><div class="order-title"><strong>${a ? escapeHtml(a.name) : "未知"}：${ACTION_LABELS[o.action]}</strong><span class="badge">剩余 ${o.remainingDays}/${o.totalDays} 天</span></div><div class="order-meta">${t ? `目标：${escapeHtml(t.name)}｜位置：${getLocationName(t.location)}` : "无指定目标"}</div></div>`; }).join(""); }
function renderRelations() { const pairs = []; for (let i = 0; i < state.actors.length; i++) for (let j = i + 1; j < state.actors.length; j++) { const a = state.actors[i], b = state.actors[j]; if (!a.alive && !b.alive) continue; const ab = getRelation(state, a.id, b.id), ba = getRelation(state, b.id, a.id); pairs.push({ a, b, score: Math.round((ab + ba) / 2), ab, ba }); } pairs.sort((x, y) => Math.abs(y.score) - Math.abs(x.score)); el.relationsGrid.innerHTML = pairs.slice(0, 18).map(p => `<div class="relation"><div class="relation-title"><strong>${escapeHtml(p.a.name)} ↔ ${escapeHtml(p.b.name)}</strong><span class="badge">${relationName(p.score)}</span></div><div class="relation-meta">平均 ${p.score}｜${p.a.name}→${p.b.name} ${p.ab}｜${p.b.name}→${p.a.name} ${p.ba}</div><div class="relation-bar"><div class="relation-fill" style="width:${clamp((p.score + 100) / 2, 0, 100)}%"></div></div></div>`).join(""); }
function renderNpcs() { el.npcList.innerHTML = state.actors.filter(a => !a.isPlayer).map(a => `<div class="npc-card">${renderActorStats(a)}<div class="npc-meta">与玩家关系：${relationName(getRelation(state, "player", a.id))} ${getRelation(state, "player", a.id)}｜对玩家态度：${relationName(getRelation(state, a.id, "player"))} ${getRelation(state, a.id, "player")}｜仇恨：${getHatred(state, a.id, "player")}</div></div>`).join(""); }
function renderLogs() { if (!state.logs.length) { el.logList.innerHTML = `<div class="empty">暂无日志。</div>`; return; } el.logList.innerHTML = state.logs.map(l => `<div class="log-item"><strong>第 ${l.year} 年 ${l.season} 第 ${l.day} 日</strong> ${escapeHtml(l.text)}</div>`).join(""); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function roll(percent) { return Math.random() * 100 < percent; }
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function escapeHtml(value) { return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }

state = loadWorld();
el.btnAssign.addEventListener("click", assignOrder);
el.btnTick.addEventListener("click", () => advanceDays(1));
el.btnTick10.addEventListener("click", () => advanceDays(10));
el.btnOffline.addEventListener("click", () => advanceDays(30));
el.btnSave.addEventListener("click", () => { saveWorld(); addLog(state, "世界已经保存到浏览器本地。", "system"); render(); });
el.btnReset.addEventListener("click", resetWorld);
window.addEventListener("beforeunload", saveWorld);
render();
