const SAVE_KEY = "mud_xianxia_world_v1";

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

const REALM_NAMES = [
  "凡人",
  "练气一层",
  "练气二层",
  "练气三层",
  "筑基初期",
  "筑基中期",
  "筑基后期",
  "金丹初期",
  "金丹中期",
  "金丹后期",
];

const NPC_BLUEPRINTS = [
  { name: "林青竹", temperament: "谨慎", ambition: 62 },
  { name: "陈不归", temperament: "贪婪", ambition: 78 },
  { name: "白洛", temperament: "温和", ambition: 45 },
  { name: "沈孤鸿", temperament: "冷漠", ambition: 84 },
  { name: "苏小满", temperament: "好奇", ambition: 55 },
  { name: "韩铁衣", temperament: "好战", ambition: 88 },
];

let state = loadWorld();

const el = {
  worldDate: document.getElementById("worldDate"),
  worldSub: document.getElementById("worldSub"),
  playerCard: document.getElementById("playerCard"),
  actionSelect: document.getElementById("actionSelect"),
  targetSelect: document.getElementById("targetSelect"),
  daysInput: document.getElementById("daysInput"),
  ordersList: document.getElementById("ordersList"),
  relationsGrid: document.getElementById("relationsGrid"),
  npcList: document.getElementById("npcList"),
  logList: document.getElementById("logList"),
  btnAssign: document.getElementById("btnAssign"),
  btnTick: document.getElementById("btnTick"),
  btnTick10: document.getElementById("btnTick10"),
  btnOffline: document.getElementById("btnOffline"),
  btnSave: document.getElementById("btnSave"),
  btnReset: document.getElementById("btnReset"),
};

function createWorld() {
  const actors = [
    createActor({ id: "player", name: "你", isPlayer: true, temperament: "玩家", ambition: 70 }),
    ...NPC_BLUEPRINTS.map((npc, index) => createActor({
      id: `npc_${index + 1}`,
      name: npc.name,
      isPlayer: false,
      temperament: npc.temperament,
      ambition: npc.ambition,
    })),
  ];

  const world = {
    version: 1,
    day: 1,
    year: 1,
    seasonIndex: 0,
    actors,
    relations: {},
    orders: [],
    logs: [],
    lastSavedAt: Date.now(),
  };

  initializeRelations(world);
  addLog(world, "世界初生，灵气复苏，第一批修行者进入此地。", "system");
  return world;
}

function createActor({ id, name, isPlayer, temperament, ambition }) {
  const realm = isPlayer ? 1 : randInt(0, 2);
  return {
    id,
    name,
    isPlayer,
    temperament,
    ambition,
    age: randInt(16, 31),
    lifespan: randInt(75, 105),
    realm,
    exp: randInt(0, 45),
    hp: 100,
    maxHp: 100,
    qi: randInt(25, 70),
    maxQi: 100,
    wealth: randInt(20, 130),
    items: randInt(0, 3),
    alive: true,
    teamWith: null,
    wounds: 0,
    kills: 0,
  };
}

function initializeRelations(world) {
  for (const a of world.actors) {
    for (const b of world.actors) {
      if (a.id === b.id) continue;
      setRelation(world, a.id, b.id, randInt(-10, 20));
    }
  }
}

function loadWorld() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return createWorld();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1) return createWorld();
    return parsed;
  } catch (error) {
    console.warn("读取存档失败，创建新世界", error);
    return createWorld();
  }
}

function saveWorld() {
  state.lastSavedAt = Date.now();
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
}

function resetWorld() {
  if (!confirm("确定要重开世界？当前本地存档会被删除。")) return;
  localStorage.removeItem(SAVE_KEY);
  state = createWorld();
  saveWorld();
  render();
}

function addLog(world, text, type = "event") {
  world.logs.unshift({
    day: world.day,
    year: world.year,
    season: getSeason(world),
    text,
    type,
  });
  world.logs = world.logs.slice(0, 120);
}

function getSeason(world) {
  return ["春", "夏", "秋", "冬"][world.seasonIndex] || "春";
}

function advanceDays(days) {
  for (let i = 0; i < days; i += 1) {
    advanceOneDay();
  }
  saveWorld();
  render();
}

function advanceOneDay() {
  state.day += 1;
  if (state.day > 90) {
    state.day = 1;
    state.seasonIndex += 1;
    if (state.seasonIndex > 3) {
      state.seasonIndex = 0;
      state.year += 1;
      ageActors();
    }
  }

  executeOrders();
  npcAutonomy();
  naturalRecovery();
  checkDeathsByAge();
}

function ageActors() {
  for (const actor of state.actors) {
    if (!actor.alive) continue;
    actor.age += 1;
    if (actor.age > actor.lifespan) {
      const deathChance = clamp((actor.age - actor.lifespan) * 7, 5, 90);
      if (roll(deathChance)) {
        actor.alive = false;
        addLog(state, `${actor.name} 寿元耗尽，坐化于第 ${state.year} 年。`, "death");
      }
    }
  }
}

function checkDeathsByAge() {
  for (const actor of state.actors) {
    if (!actor.alive) continue;
    if (actor.hp <= 0) killActor(actor, "伤势过重而死");
  }
}

function naturalRecovery() {
  for (const actor of state.actors) {
    if (!actor.alive) continue;
    actor.qi = clamp(actor.qi + 3 + actor.realm, 0, actor.maxQi);
    if (actor.wounds > 0 && roll(35)) actor.wounds -= 1;
    if (actor.hp < actor.maxHp && actor.wounds <= 2) actor.hp = clamp(actor.hp + 4, 0, actor.maxHp);
  }
}

function executeOrders() {
  const remaining = [];
  for (const order of state.orders) {
    const actor = findActor(order.actorId);
    if (!actor || !actor.alive) continue;
    const target = order.targetId ? findActor(order.targetId) : null;
    runAction(actor, order.action, target, true);
    order.remainingDays -= 1;
    if (order.remainingDays > 0) remaining.push(order);
  }
  state.orders = remaining;
}

function npcAutonomy() {
  const npcs = state.actors.filter(a => !a.isPlayer && a.alive);
  for (const npc of npcs) {
    const action = chooseNpcAction(npc);
    const target = chooseNpcTarget(npc, action);
    runAction(npc, action, target, false);
  }
}

function chooseNpcAction(npc) {
  const hpRate = npc.hp / npc.maxHp;
  if (hpRate < 0.45) return "meditate";
  if (npc.temperament === "好战" && roll(18)) return "ambush";
  if (npc.temperament === "贪婪" && roll(25)) return "askItem";
  if (npc.temperament === "温和" && roll(30)) return "socialize";
  if (npc.temperament === "好奇" && roll(25)) return "explore";
  if (npc.ambition > 75 && roll(45)) return "cultivate";
  return pick(["cultivate", "meditate", "work", "explore", "socialize"]);
}

function chooseNpcTarget(npc, action) {
  const others = state.actors.filter(a => a.id !== npc.id && a.alive);
  if (others.length === 0) return null;

  if (action === "ambush") {
    const sorted = [...others].sort((a, b) => getRelation(state, npc.id, b.id) - getRelation(state, npc.id, a.id));
    return roll(55) ? sorted[0] : pick(others);
  }

  if (["socialize", "askItem", "inviteTeam"].includes(action)) {
    const sorted = [...others].sort((a, b) => getRelation(state, npc.id, b.id) - getRelation(state, npc.id, a.id));
    return roll(70) ? sorted[0] : pick(others);
  }

  return pick(others);
}

function runAction(actor, action, target, fromOrder) {
  if (!actor.alive) return;
  switch (action) {
    case "cultivate": return cultivate(actor, fromOrder);
    case "meditate": return meditate(actor, fromOrder);
    case "work": return work(actor, fromOrder);
    case "explore": return explore(actor, fromOrder);
    case "socialize": return socialize(actor, target, fromOrder);
    case "askItem": return askItem(actor, target, fromOrder);
    case "inviteTeam": return inviteTeam(actor, target, fromOrder);
    case "ambush": return ambush(actor, target, fromOrder);
    default: return;
  }
}

function cultivate(actor, fromOrder) {
  const gain = randInt(5, 12) + actor.realm;
  actor.exp += gain;
  actor.qi = clamp(actor.qi - randInt(3, 8), 0, actor.maxQi);
  if (actor.qi <= 5 && roll(20)) suffer(actor, randInt(3, 8), "强行修炼导致气血逆行");

  const need = 80 + actor.realm * 45;
  if (actor.exp >= need && actor.realm < REALM_NAMES.length - 1) {
    actor.exp -= need;
    actor.realm += 1;
    actor.maxHp += 12;
    actor.maxQi += 10;
    actor.hp = actor.maxHp;
    actor.qi = actor.maxQi;
    actor.lifespan += randInt(4, 10);
    addLog(state, `${actor.name} 突破到 ${REALM_NAMES[actor.realm]}，寿元有所增长。`, "breakthrough");
  } else if (fromOrder && roll(12)) {
    addLog(state, `${actor.name} 修炼一日，修为增加 ${gain}。`, "action");
  }
}

function meditate(actor, fromOrder) {
  const hpGain = randInt(6, 14);
  const qiGain = randInt(8, 18);
  actor.hp = clamp(actor.hp + hpGain, 0, actor.maxHp);
  actor.qi = clamp(actor.qi + qiGain, 0, actor.maxQi);
  if (actor.wounds > 0 && roll(45)) actor.wounds -= 1;
  if (fromOrder && roll(18)) addLog(state, `${actor.name} 打坐调息，恢复了气血与灵气。`, "action");
}

function work(actor, fromOrder) {
  const money = randInt(6, 18) + Math.floor(actor.realm * 1.5);
  actor.wealth += money;
  actor.qi = clamp(actor.qi - randInt(1, 5), 0, actor.maxQi);
  if (roll(7)) suffer(actor, randInt(1, 5), "劳累过度");
  if (fromOrder || roll(10)) addLog(state, `${actor.name} 做工赚钱，获得 ${money} 灵石。`, "action");
}

function explore(actor, fromOrder) {
  const danger = 18 + actor.wounds * 6;
  const reward = randInt(8, 28) + actor.realm * 2;
  if (roll(danger)) {
    const damage = randInt(8, 26);
    suffer(actor, damage, "外出探索遭遇危险");
    if (actor.alive) addLog(state, `${actor.name} 探索荒野受伤，损失 ${damage} 气血。`, "danger");
  } else {
    actor.wealth += reward;
    actor.items += roll(32) ? 1 : 0;
    actor.exp += randInt(2, 8);
    if (fromOrder || roll(30)) addLog(state, `${actor.name} 探索有获，得到约 ${reward} 灵石的资源。`, "action");
  }
}

function socialize(actor, target, fromOrder) {
  if (!target || !target.alive) return;
  const delta = randInt(3, 9);
  changeRelation(actor.id, target.id, delta);
  changeRelation(target.id, actor.id, Math.max(1, delta - randInt(0, 3)));
  if (fromOrder || roll(22)) addLog(state, `${actor.name} 与 ${target.name} 来往，情感值上升。`, "relation");
}

function askItem(actor, target, fromOrder) {
  if (!target || !target.alive) return;
  const rel = getRelation(state, actor.id, target.id);
  const chance = clamp(20 + rel * 0.55 + actor.realm * 3, 5, 92);
  if (target.items <= 0) {
    changeRelation(actor.id, target.id, -2);
    if (fromOrder) addLog(state, `${actor.name} 向 ${target.name} 索要物品，但对方没有可给之物。`, "relation");
    return;
  }
  if (roll(chance)) {
    target.items -= 1;
    actor.items += 1;
    changeRelation(actor.id, target.id, 2);
    changeRelation(target.id, actor.id, -randInt(0, 3));
    addLog(state, `${actor.name} 从 ${target.name} 处获得一件物品。`, "relation");
  } else {
    changeRelation(actor.id, target.id, -4);
    changeRelation(target.id, actor.id, -7);
    if (fromOrder || roll(35)) addLog(state, `${actor.name} 向 ${target.name} 索要物品失败，关系变差。`, "relation");
  }
}

function inviteTeam(actor, target, fromOrder) {
  if (!target || !target.alive) return;
  const rel = getRelation(state, actor.id, target.id);
  const chance = clamp(15 + rel * 0.65 + actor.realm * 2, 3, 95);
  if (roll(chance)) {
    actor.teamWith = target.id;
    target.teamWith = actor.id;
    changeRelation(actor.id, target.id, 5);
    changeRelation(target.id, actor.id, 5);
    addLog(state, `${actor.name} 与 ${target.name} 暂时组队，彼此防备下降。`, "team");
  } else {
    changeRelation(actor.id, target.id, -2);
    if (fromOrder || roll(30)) addLog(state, `${actor.name} 邀请 ${target.name} 组队失败。`, "relation");
  }
}

function ambush(actor, target, fromOrder) {
  if (!target || !target.alive) return;
  const rel = getRelation(state, target.id, actor.id);
  const trustBonus = clamp(rel * 0.45, -25, 45);
  const realmGap = (actor.realm - target.realm) * 8;
  const teamBonus = actor.teamWith === target.id ? 18 : 0;
  const chance = clamp(30 + trustBonus + realmGap + teamBonus - target.wounds * 2, 5, 96);

  if (roll(chance)) {
    const damage = randInt(22, 48) + Math.max(0, actor.realm - target.realm) * 8;
    suffer(target, damage, `${actor.name} 偷袭`);
    changeRelation(target.id, actor.id, -45);
    changeRelation(actor.id, target.id, -15);
    actor.wealth += Math.min(target.wealth, randInt(4, 18));
    target.wealth = Math.max(0, target.wealth - randInt(4, 18));
    addLog(state, `${actor.name} 偷袭 ${target.name} 成功。情感越高，防备越低，此次成功率为 ${Math.round(chance)}%。`, "danger");
    if (!target.alive) actor.kills += 1;
  } else {
    const counter = randInt(8, 24) + target.realm * 3;
    suffer(actor, counter, `${target.name} 反击`);
    changeRelation(target.id, actor.id, -35);
    changeRelation(actor.id, target.id, -20);
    addLog(state, `${actor.name} 偷袭 ${target.name} 失败，被反击受伤。`, "danger");
  }
}

function suffer(actor, damage, reason) {
  actor.hp = clamp(actor.hp - damage, 0, actor.maxHp);
  if (damage >= 12) actor.wounds += 1;
  if (actor.hp <= 0) killActor(actor, reason);
}

function killActor(actor, reason) {
  if (!actor.alive) return;
  actor.alive = false;
  actor.hp = 0;
  actor.teamWith = null;
  for (const other of state.actors) {
    if (other.teamWith === actor.id) other.teamWith = null;
  }
  state.orders = state.orders.filter(order => order.actorId !== actor.id && order.targetId !== actor.id);
  addLog(state, `${actor.name} 因 ${reason} 死亡。`, "death");
}

function assignOrder() {
  const player = findActor("player");
  if (!player || !player.alive) {
    alert("玩家已经死亡，不能继续下达命令。可以重开世界。");
    return;
  }

  const action = el.actionSelect.value;
  const days = clamp(Number(el.daysInput.value || 1), 1, 365);
  const needsTarget = ["socialize", "askItem", "inviteTeam", "ambush"].includes(action);
  const targetId = needsTarget ? el.targetSelect.value : null;
  if (needsTarget && !targetId) {
    alert("这个行动需要选择目标。 ");
    return;
  }

  state.orders.push({
    id: `order_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    actorId: "player",
    action,
    targetId,
    remainingDays: days,
    totalDays: days,
  });

  const target = targetId ? findActor(targetId) : null;
  addLog(state, `你下达命令：${ACTION_LABELS[action]}${target ? `，目标 ${target.name}` : ""}，持续 ${days} 天。`, "system");
  saveWorld();
  render();
}

function relationKey(a, b) {
  return `${a}->${b}`;
}

function getRelation(world, a, b) {
  return world.relations[relationKey(a, b)] ?? 0;
}

function setRelation(world, a, b, value) {
  world.relations[relationKey(a, b)] = clamp(Math.round(value), -100, 100);
}

function changeRelation(a, b, delta) {
  setRelation(state, a, b, getRelation(state, a, b) + delta);
}

function findActor(id) {
  return state.actors.find(actor => actor.id === id);
}

function relationName(value) {
  if (value <= -70) return "死敌";
  if (value <= -30) return "仇怨";
  if (value < 10) return "陌生";
  if (value < 35) return "熟人";
  if (value < 65) return "朋友";
  if (value < 85) return "挚友";
  return "生死之交";
}

function render() {
  renderWorld();
  renderPlayer();
  renderTargets();
  renderOrders();
  renderRelations();
  renderNpcs();
  renderLogs();
}

function renderWorld() {
  el.worldDate.textContent = `第 ${state.year} 年 ${getSeason(state)} 第 ${state.day} 日`;
  const aliveCount = state.actors.filter(a => a.alive).length;
  const deadCount = state.actors.length - aliveCount;
  el.worldSub.textContent = `存活 ${aliveCount} 人，死亡 ${deadCount} 人，当前有 ${state.orders.length} 条玩家离线命令。`;
}

function renderPlayer() {
  const player = findActor("player");
  el.playerCard.innerHTML = renderActorStats(player);
}

function renderActorStats(actor) {
  if (!actor) return `<div class="empty">没有角色</div>`;
  const team = actor.teamWith ? findActor(actor.teamWith) : null;
  return `
    <div class="npc-title">
      <strong>${escapeHtml(actor.name)}</strong>
      <span class="badge ${actor.alive ? "alive" : "dead"}">${actor.alive ? "存活" : "死亡"}</span>
    </div>
    <div class="stat-grid">
      <div class="stat"><div class="label">年龄 / 寿命</div><div class="value">${actor.age}/${actor.lifespan}</div></div>
      <div class="stat"><div class="label">境界</div><div class="value">${REALM_NAMES[actor.realm]}</div></div>
      <div class="stat"><div class="label">气血</div><div class="value">${actor.hp}/${actor.maxHp}</div></div>
      <div class="stat"><div class="label">灵气</div><div class="value">${actor.qi}/${actor.maxQi}</div></div>
      <div class="stat"><div class="label">修为</div><div class="value">${actor.exp}</div></div>
      <div class="stat"><div class="label">灵石</div><div class="value">${actor.wealth}</div></div>
      <div class="stat"><div class="label">物品</div><div class="value">${actor.items}</div></div>
      <div class="stat"><div class="label">伤势</div><div class="value">${actor.wounds}</div></div>
    </div>
    <div>
      <span class="badge">性格：${escapeHtml(actor.temperament)}</span>
      <span class="badge">野心：${actor.ambition}</span>
      ${team ? `<span class="badge team">组队：${escapeHtml(team.name)}</span>` : ""}
      ${actor.kills ? `<span class="badge dead">击杀：${actor.kills}</span>` : ""}
    </div>
  `;
}

function renderTargets() {
  const liveTargets = state.actors.filter(a => a.id !== "player" && a.alive);
  el.targetSelect.innerHTML = liveTargets.map(actor => {
    const rel = getRelation(state, "player", actor.id);
    return `<option value="${actor.id}">${escapeHtml(actor.name)}｜${relationName(rel)} ${rel}</option>`;
  }).join("");
}

function renderOrders() {
  if (state.orders.length === 0) {
    el.ordersList.innerHTML = `<div class="empty">暂无离线命令。</div>`;
    return;
  }
  el.ordersList.innerHTML = state.orders.map(order => {
    const actor = findActor(order.actorId);
    const target = order.targetId ? findActor(order.targetId) : null;
    return `
      <div class="order">
        <div class="order-title">
          <strong>${actor ? escapeHtml(actor.name) : "未知"}：${ACTION_LABELS[order.action]}</strong>
          <span class="badge">剩余 ${order.remainingDays}/${order.totalDays} 天</span>
        </div>
        <div class="order-meta">${target ? `目标：${escapeHtml(target.name)}` : "无指定目标"}</div>
      </div>
    `;
  }).join("");
}

function renderRelations() {
  const pairs = [];
  const actors = state.actors;
  for (let i = 0; i < actors.length; i += 1) {
    for (let j = i + 1; j < actors.length; j += 1) {
      const a = actors[i];
      const b = actors[j];
      if (!a.alive && !b.alive) continue;
      const ab = getRelation(state, a.id, b.id);
      const ba = getRelation(state, b.id, a.id);
      pairs.push({ a, b, score: Math.round((ab + ba) / 2), ab, ba });
    }
  }
  pairs.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
  el.relationsGrid.innerHTML = pairs.slice(0, 18).map(pair => {
    const width = clamp((pair.score + 100) / 2, 0, 100);
    return `
      <div class="relation">
        <div class="relation-title">
          <strong>${escapeHtml(pair.a.name)} ↔ ${escapeHtml(pair.b.name)}</strong>
          <span class="badge">${relationName(pair.score)}</span>
        </div>
        <div class="relation-meta">平均 ${pair.score}｜${pair.a.name}→${pair.b.name} ${pair.ab}｜${pair.b.name}→${pair.a.name} ${pair.ba}</div>
        <div class="relation-bar"><div class="relation-fill" style="width:${width}%"></div></div>
      </div>
    `;
  }).join("");
}

function renderNpcs() {
  const npcs = state.actors.filter(a => !a.isPlayer);
  el.npcList.innerHTML = npcs.map(actor => `
    <div class="npc-card">
      ${renderActorStats(actor)}
      <div class="npc-meta">与玩家关系：${relationName(getRelation(state, "player", actor.id))} ${getRelation(state, "player", actor.id)}｜对玩家态度：${relationName(getRelation(state, actor.id, "player"))} ${getRelation(state, actor.id, "player")}</div>
    </div>
  `).join("");
}

function renderLogs() {
  if (state.logs.length === 0) {
    el.logList.innerHTML = `<div class="empty">暂无日志。</div>`;
    return;
  }
  el.logList.innerHTML = state.logs.map(log => `
    <div class="log-item"><strong>第 ${log.year} 年 ${log.season} 第 ${log.day} 日</strong> ${escapeHtml(log.text)}</div>
  `).join("");
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function roll(percent) {
  return Math.random() * 100 < percent;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

el.btnAssign.addEventListener("click", assignOrder);
el.btnTick.addEventListener("click", () => advanceDays(1));
el.btnTick10.addEventListener("click", () => advanceDays(10));
el.btnOffline.addEventListener("click", () => advanceDays(30));
el.btnSave.addEventListener("click", () => {
  saveWorld();
  addLog(state, "世界已经保存到浏览器本地。", "system");
  render();
});
el.btnReset.addEventListener("click", resetWorld);

window.addEventListener("beforeunload", saveWorld);

render();
