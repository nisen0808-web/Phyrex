// V0.3 Combat / Gear Engine
// This file patches the existing browser MUD engine without replacing game.js.

(function installCombatEngine() {
  if (window.__combatEngineInstalled) return;
  window.__combatEngineInstalled = true;

  const GEAR_TABLE = {
    weapon: [
      { id: "wood_sword", name: "桃木剑", atk: 6, def: 0, speed: 1, price: 35, tier: 1 },
      { id: "iron_sword", name: "玄铁剑", atk: 13, def: 0, speed: 0, price: 95, tier: 2 },
      { id: "blood_blade", name: "血纹刀", atk: 21, def: -2, speed: 1, price: 210, tier: 3 },
      { id: "flying_sword", name: "飞剑", atk: 28, def: 0, speed: 5, price: 420, tier: 4 },
    ],
    armor: [
      { id: "cloth_robe", name: "粗布法袍", atk: 0, def: 5, speed: 0, price: 30, tier: 1 },
      { id: "scale_armor", name: "鳞甲", atk: 0, def: 14, speed: -2, price: 120, tier: 2 },
      { id: "spirit_robe", name: "灵纹法袍", atk: 2, def: 20, speed: 2, price: 260, tier: 3 },
      { id: "cloud_armor", name: "云纹宝甲", atk: 4, def: 32, speed: 1, price: 520, tier: 4 },
    ],
    charm: [
      { id: "small_talisman", name: "护身符", atk: 0, def: 4, speed: 2, price: 60, tier: 1 },
      { id: "wind_charm", name: "疾风符", atk: 2, def: 2, speed: 7, price: 180, tier: 2 },
      { id: "thunder_mark", name: "雷纹玉佩", atk: 9, def: 5, speed: 3, price: 360, tier: 3 },
    ],
  };

  function ensureCombatState(actor) {
    if (!actor) return;
    if (!actor.inventory) actor.inventory = [];
    if (!actor.gear) actor.gear = { weapon: null, armor: null, charm: null };
    if (typeof actor.attack !== "number") actor.attack = 8 + actor.realm * 6;
    if (typeof actor.defense !== "number") actor.defense = 5 + actor.realm * 4;
    if (typeof actor.speed !== "number") actor.speed = 10 + actor.realm * 2;
    if (typeof actor.combatWins !== "number") actor.combatWins = 0;
    if (typeof actor.combatLosses !== "number") actor.combatLosses = 0;
  }

  function allGear() {
    return [...GEAR_TABLE.weapon, ...GEAR_TABLE.armor, ...GEAR_TABLE.charm];
  }

  function cloneGear(item) {
    return { ...item, uid: `gear_${Date.now()}_${Math.random().toString(16).slice(2)}` };
  }

  function gearScore(actor, key) {
    ensureCombatState(actor);
    const item = actor.gear[key];
    return item ? item : { atk: 0, def: 0, speed: 0, name: "无" };
  }

  function combatStats(actor) {
    ensureCombatState(actor);
    const weapon = gearScore(actor, "weapon");
    const armor = gearScore(actor, "armor");
    const charm = gearScore(actor, "charm");
    return {
      atk: actor.attack + actor.realm * 5 + weapon.atk + armor.atk + charm.atk,
      def: actor.defense + actor.realm * 4 + weapon.def + armor.def + charm.def,
      speed: actor.speed + actor.realm * 2 + weapon.speed + armor.speed + charm.speed,
      power: actor.realm * 20 + actor.hp * 0.35 + actor.qi * 0.25 + weapon.atk + armor.def + charm.speed,
    };
  }

  function locationAllowsTrade(actor) {
    const loc = typeof getLocation === "function" ? getLocation(actor.location) : null;
    return loc && String(loc.type || "").includes("market");
  }

  function buyGear(actor, target, fromOrder) {
    ensureCombatState(actor);
    if (!locationAllowsTrade(actor)) {
      if (typeof moveTo === "function") moveTo(actor, "market", `${actor.name} 前往坊市购买装备。`);
      if (typeof addLog === "function") addLog(state, `${actor.name} 不在交易地点，先前往坊市。`, "move");
      return;
    }
    const affordable = allGear().filter(item => item.price <= actor.wealth && item.tier <= Math.max(1, actor.realm + 1));
    if (!affordable.length) {
      if (typeof addLog === "function") addLog(state, `${actor.name} 灵石不足，买不起合适的装备。`, "market");
      return;
    }
    const item = cloneGear(affordable.sort((a, b) => b.price - a.price)[0]);
    const slot = GEAR_TABLE.weapon.some(x => x.id === item.id) ? "weapon" : GEAR_TABLE.armor.some(x => x.id === item.id) ? "armor" : "charm";
    actor.wealth -= item.price;
    actor.inventory.push(item);
    actor.gear[slot] = item;
    if (typeof addLog === "function") addLog(state, `${actor.name} 在坊市花费 ${item.price} 灵石购买并装备了 ${item.name}。`, "market");
  }

  function heal(actor, target, fromOrder) {
    ensureCombatState(actor);
    const cost = Math.min(actor.wealth, Math.max(8, actor.wounds * 18 + Math.floor((actor.maxHp - actor.hp) / 4)));
    if (cost <= 0 && actor.hp >= actor.maxHp && actor.wounds <= 0) {
      if (fromOrder && typeof addLog === "function") addLog(state, `${actor.name} 暂无明显伤势，不需要疗伤。`, "heal");
      return;
    }
    actor.wealth -= cost;
    actor.hp = Math.min(actor.maxHp, actor.hp + 25 + cost);
    actor.qi = Math.min(actor.maxQi, actor.qi + 15);
    actor.wounds = Math.max(0, actor.wounds - 2);
    if (typeof addLog === "function") addLog(state, `${actor.name} 花费 ${cost} 灵石疗伤，气血和灵气有所恢复。`, "heal");
  }

  function challenge(actor, target, fromOrder) {
    if (!target || !target.alive) return;
    ensureCombatState(actor);
    ensureCombatState(target);
    if (actor.location !== target.location && typeof moveTo === "function") {
      moveTo(actor, target.location, `${actor.name} 前往 ${getLocationName(target.location)} 挑战 ${target.name}。`);
      if (fromOrder && typeof addLog === "function") addLog(state, `${actor.name} 与 ${target.name} 不在同一地点，先前往对方所在地。`, "move");
      return;
    }
    resolveCombat(actor, target, { mode: "challenge", lethal: false, reason: "挑战" });
  }

  function hunt(actor, target, fromOrder) {
    if (!target || !target.alive) return;
    ensureCombatState(actor);
    ensureCombatState(target);
    if (actor.location !== target.location && typeof moveTo === "function") {
      moveTo(actor, target.location, `${actor.name} 追击 ${target.name} 至 ${getLocationName(target.location)}。`);
      if (typeof addLog === "function") addLog(state, `${actor.name} 开始追击 ${target.name}。`, "hunt");
      return;
    }
    resolveCombat(actor, target, { mode: "hunt", lethal: true, reason: "追杀" });
  }

  function resolveCombat(attacker, defender, options) {
    const a = combatStats(attacker);
    const d = combatStats(defender);
    const firstStrike = a.speed + randInt(1, 20) >= d.speed + randInt(1, 20);
    const hitChance = clamp(55 + (a.speed - d.speed) * 1.2 + (attacker.realm - defender.realm) * 6, 12, 92);
    const critChance = clamp(6 + (a.speed - d.speed) * 0.35 + attacker.realm * 1.5, 3, 35);
    let attackerDamage = 0;
    let defenderDamage = 0;

    if (firstStrike && roll(hitChance)) attackerDamage = calcDamage(a, d, roll(critChance));
    if (defender.alive && roll(clamp(50 + (d.speed - a.speed), 10, 88))) defenderDamage = calcDamage(d, a, roll(critChance / 2));
    if (!firstStrike && roll(hitChance)) attackerDamage += calcDamage(a, d, roll(critChance));

    if (attackerDamage > 0 && typeof suffer === "function") suffer(defender, attackerDamage, `${attacker.name}${options.reason}${defender.name}`);
    if (defenderDamage > 0 && attacker.alive && typeof suffer === "function") suffer(attacker, defenderDamage, `${defender.name}反击`);

    const defenderDown = !defender.alive || defender.hp <= 0 || attackerDamage > defenderDamage + 12;
    const attackerDown = !attacker.alive || attacker.hp <= 0 || defenderDamage > attackerDamage + 12;

    if (defenderDown && !attackerDown) {
      attacker.combatWins += 1;
      defender.combatLosses += 1;
      attacker.reputation = (attacker.reputation || 0) + (options.mode === "challenge" ? 2 : -1);
      applyLoot(attacker, defender, options);
      if (typeof changeHatred === "function") changeHatred(defender.id, attacker.id, options.mode === "challenge" ? 8 : 35);
      if (typeof changeRelation === "function") changeRelation(defender.id, attacker.id, options.mode === "challenge" ? -8 : -30);
      if (typeof addLog === "function") addLog(state, `${attacker.name} ${options.reason} ${defender.name} 获胜，造成 ${attackerDamage} 伤害。`, "combat");
    } else if (attackerDown && !defenderDown) {
      attacker.combatLosses += 1;
      defender.combatWins += 1;
      if (typeof changeHatred === "function") changeHatred(attacker.id, defender.id, 12);
      if (typeof addLog === "function") addLog(state, `${attacker.name} ${options.reason} ${defender.name} 失败，被反击造成 ${defenderDamage} 伤害。`, "combat");
    } else {
      if (typeof addLog === "function") addLog(state, `${attacker.name} 与 ${defender.name} 战成平手，双方各有损伤。`, "combat");
      if (typeof changeHatred === "function") changeHatred(defender.id, attacker.id, 5);
    }
  }

  function calcDamage(src, dst, crit) {
    const raw = src.atk + randInt(4, 18) - dst.def * 0.45;
    const scaled = Math.max(3, Math.round(raw * (crit ? 1.8 : 1)));
    return scaled;
  }

  function applyLoot(winner, loser, options) {
    ensureCombatState(winner);
    ensureCombatState(loser);
    const lootMoneyRate = options.mode === "challenge" ? 0.08 : 0.28;
    const money = Math.floor(loser.wealth * lootMoneyRate);
    if (money > 0) {
      loser.wealth -= money;
      winner.wealth += money;
    }
    const dropChance = options.mode === "challenge" ? 12 : 45;
    if (loser.inventory.length && roll(dropChance)) {
      const item = loser.inventory.splice(randInt(0, loser.inventory.length - 1), 1)[0];
      winner.inventory.push(item);
      if (loser.gear) {
        for (const key of Object.keys(loser.gear)) if (loser.gear[key]?.uid === item.uid) loser.gear[key] = null;
      }
      if (typeof addLog === "function") addLog(state, `${winner.name} 从 ${loser.name} 身上获得 ${item.name}。`, "loot");
    }
  }

  function extendActorRender() {
    if (typeof renderActorStats !== "function") return;
    const original = renderActorStats;
    renderActorStats = function patchedRenderActorStats(actor) {
      ensureCombatState(actor);
      const base = original(actor);
      if (!actor) return base;
      const s = combatStats(actor);
      const gear = actor.gear || {};
      const extra = `<div class="stat-grid"><div class="stat"><div class="label">攻击</div><div class="value">${Math.round(s.atk)}</div></div><div class="stat"><div class="label">防御</div><div class="value">${Math.round(s.def)}</div></div><div class="stat"><div class="label">速度</div><div class="value">${Math.round(s.speed)}</div></div><div class="stat"><div class="label">胜负</div><div class="value">${actor.combatWins}/${actor.combatLosses}</div></div></div><div><span class="badge">武器：${gear.weapon?.name || "无"}</span><span class="badge">护甲：${gear.armor?.name || "无"}</span><span class="badge">法宝：${gear.charm?.name || "无"}</span><span class="badge">背包：${actor.inventory?.length || 0}</span></div>`;
      return base + extra;
    };
  }

  function patchRunAction() {
    if (typeof runAction !== "function") return;
    const original = runAction;
    runAction = function patchedRunAction(actor, action, target, fromOrder) {
      ensureCombatState(actor);
      if (target) ensureCombatState(target);
      if (action === "challenge") return challenge(actor, target, fromOrder);
      if (action === "hunt") return hunt(actor, target, fromOrder);
      if (action === "buyGear") return buyGear(actor, target, fromOrder);
      if (action === "heal") return heal(actor, target, fromOrder);
      return original(actor, action, target, fromOrder);
    };
  }

  function patchNpcAction() {
    if (typeof chooseNpcAction !== "function") return;
    const original = chooseNpcAction;
    chooseNpcAction = function patchedChooseNpcAction(npc) {
      ensureCombatState(npc);
      if (npc.hp < npc.maxHp * 0.35 && roll(55)) return "heal";
      if (npc.wealth > 120 && roll(18)) return "buyGear";
      const enemies = state.actors.filter(a => a.alive && a.id !== npc.id && typeof getHatred === "function" && getHatred(state, npc.id, a.id) > 70);
      if (enemies.length && roll(28)) return "hunt";
      if (npc.temperament === "好战" && roll(12)) return "challenge";
      return original(npc);
    };
  }

  function patchTargetNeed() {
    if (typeof assignOrder !== "function") return;
    const original = assignOrder;
    assignOrder = function patchedAssignOrder() {
      return original();
    };
  }

  function patchAssignOrderTargetRule() {
    // The existing assignOrder already treats unknown actions as non-target actions.
    // We need challenge/hunt to carry targets, so we replace it safely here.
    if (typeof assignOrder !== "function") return;
    assignOrder = function combatAssignOrder() {
      const player = typeof findActor === "function" ? findActor("player") : null;
      if (!player || !player.alive) { alert("玩家已经死亡，不能继续下达命令。可以重开世界。"); return; }
      const action = el.actionSelect.value;
      const days = clamp(Number(el.daysInput.value || 1), 1, 365);
      const needsTarget = ["socialize", "askItem", "inviteTeam", "ambush", "challenge", "hunt"].includes(action);
      const targetId = needsTarget ? el.targetSelect.value : null;
      if (needsTarget && !targetId) { alert("这个行动需要选择目标。"); return; }
      state.orders.push({ id: `order_${Date.now()}_${Math.random().toString(16).slice(2)}`, actorId: "player", action, targetId, remainingDays: days, totalDays: days });
      const target = targetId ? findActor(targetId) : null;
      const label = ACTION_LABELS[action] || action;
      addLog(state, `你下达命令：${label}${target ? `，目标 ${target.name}` : ""}，持续 ${days} 天。`, "system");
      saveWorld();
      render();
    };
    if (el?.btnAssign) {
      const cloned = el.btnAssign.cloneNode(true);
      el.btnAssign.parentNode.replaceChild(cloned, el.btnAssign);
      el.btnAssign = cloned;
      el.btnAssign.addEventListener("click", assignOrder);
    }
  }

  function initExistingActors() {
    if (!state?.actors) return;
    for (const actor of state.actors) ensureCombatState(actor);
  }

  ACTION_LABELS.challenge = "挑战";
  ACTION_LABELS.hunt = "追击";
  ACTION_LABELS.buyGear = "购买装备";
  ACTION_LABELS.heal = "疗伤";

  initExistingActors();
  patchRunAction();
  patchNpcAction();
  patchAssignOrderTargetRule();
  extendActorRender();

  if (typeof addLog === "function") addLog(state, "战斗与装备引擎已载入：挑战、追击、购买装备、疗伤开始生效。", "system");
  if (typeof saveWorld === "function") saveWorld();
  if (typeof render === "function") render();
})();
