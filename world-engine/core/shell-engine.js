'use strict';

const fs = require('fs');
const path = require('path');
const { runSimulationTicks, getSimulationSummary } = require('./simulation-engine');
const { executePlayerCommand, getPlayerCommands } = require('./command-engine');
const { queryWorld } = require('./query-engine');
const { createWorldSnapshot } = require('./snapshot-engine');
const { getPlayerView, processPlayersTick } = require('./player-engine');
const { getPlayerQuests, processQuestsTick, claimCompletedPlayerQuests, claimQuestReward } = require('./quest-engine');
const { startTutorial, processTutorialTick, getTutorialView, formatTutorialView } = require('./tutorial-engine');
const { createTurnReport, formatTurnReport } = require('./turn-report-engine');
const { createPlayerMap, createLocationMap, formatLocationMap } = require('./map-engine');
const { normalizeShellCommand, normalizeShellTarget } = require('./shell-alias-engine');

const SHELL_STATUS = {
  OK: 'ok',
  EXIT: 'exit',
  ERROR: 'error',
};

const DEFAULT_SHELL_OPTIONS = {
  defaultWaitTicks: 1,
  snapshotPath: path.join(__dirname, '..', 'output', 'shell-snapshot.json'),
  simulation: {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
    information: { maxInformationItems: 1000, maxKnownItemsPerOwner: 120 },
    memory: { maxGlobalMemories: 3000, maxMemoriesPerOwner: 50 },
    process: { maxProcesses: 500, maxInactiveProcesses: 150, staleAfterTicks: 120 },
  },
};

const HELP_TEXT = [
  'Commands:',
  '  help / 帮助                  Show this help',
  '  status / 状态                Show player status',
  '  world / 世界                 Show world overview',
  '  tutorial / 教程              Start/show tutorial progress',
  '  quests / 任务                Show active/completed quests',
  '  claim / 领取 [questId]       Claim one completed quest or all completed quests',
  '  report / 报告 [ticks]        Show a turn report',
  '  map / 地图 [locationId]      Show local map and exits',
  '  inspect / 查看 [target] [id] Inspect world/player/location/entity/org/city/civ',
  '  move / 前往 <locationId>     Move active character',
  '  work / 工作 [resource] [n]   Work for resource, default currency 10',
  '  gather / 采集 [resource] [n] Gather from current location, default food 3',
  '  train / 修炼 [amount]        Train power',
  '  rest / 休息                  Recover health and energy',
  '  join / 加入 <orgId|name>     Join an organization',
  '  wait / 等待 [ticks]          Advance world ticks',
  '  leaderboard / 排行 [type]    power|wealth|overall|happiness|reputation',
  '  commands / 命令              Show recent player commands',
  '  snapshot / 快照 [file]       Export snapshot JSON',
  '  quit / exit / 退出           Leave shell',
].join('\n');

function createShellSession(world, playerId, options = {}) {
  if (!world) throw new Error('Shell session requires world');
  if (!playerId) throw new Error('Shell session requires playerId');
  return {
    world,
    playerId,
    options: mergeOptions(DEFAULT_SHELL_OPTIONS, options),
    history: [],
    createdAt: world.tick,
    lastReportTick: world.tick,
  };
}

function parseShellInput(line = '') {
  const raw = String(line || '').trim();
  if (!raw) return { raw, command: '', args: [] };
  const args = tokenize(raw);
  const command = normalizeShellCommand(String(args.shift() || ''));
  return { raw, command, args };
}

function executeShellInput(session, line) {
  const parsed = parseShellInput(line);
  if (!parsed.command) return ok('');
  session.history.push(parsed.raw);
  if (session.history.length > 200) session.history.shift();

  try {
    return dispatchShellCommand(session, parsed);
  } catch (error) {
    return fail(error.message || 'shell_error');
  }
}

function dispatchShellCommand(session, parsed) {
  const { world, playerId } = session;
  const [a, b, c] = parsed.args;

  if (parsed.command === 'help') return ok(HELP_TEXT, { type: 'help' });
  if (parsed.command === 'quit') return { status: SHELL_STATUS.EXIT, message: 'Bye.', data: null };

  if (parsed.command === 'status') {
    return ok(formatPlayerStatus(world, playerId), queryWorld(world, { type: 'player', playerId }));
  }

  if (parsed.command === 'world') {
    const overview = queryWorld(world, { type: 'world' });
    return ok(formatWorldOverview(overview), overview);
  }

  if (parsed.command === 'tutorial') {
    startTutorial(world, playerId);
    processTutorialTick(world, { claimCompleted: false });
    const view = getTutorialView(world, playerId);
    return ok(formatTutorialView(view), view);
  }

  if (parsed.command === 'quests') {
    processQuestsTick(world);
    const quests = getPlayerQuests(world, playerId);
    return ok(formatQuestList(quests), quests);
  }

  if (parsed.command === 'claim') {
    processQuestsTick(world);
    if (a) {
      const result = claimQuestReward(world, a);
      if (!result) return fail(`Missing quest: ${a}`);
      return ok(`Claim result: ${result.status}`, result);
    }
    const claimed = claimCompletedPlayerQuests(world, playerId);
    return ok(`Claimed quests: ${claimed.length ? claimed.join(', ') : 'none'}`, { claimed });
  }

  if (parsed.command === 'report') {
    const ticks = numeric(a, Math.max(1, world.tick - (session.lastReportTick || world.tick - 1)));
    const report = createTurnReport(world, playerId, { ticks });
    session.lastReportTick = world.tick;
    return ok(formatTurnReport(report), report);
  }

  if (parsed.command === 'map') {
    const locationId = resolveLocationId(world, a) || getPlayerView(world, playerId)?.activeEntity?.locationId || null;
    const map = locationId ? createLocationMap(world, locationId) : createPlayerMap(world, playerId);
    return ok(formatLocationMap(map), map);
  }

  if (parsed.command === 'inspect') {
    const targetType = a || 'player';
    const targetId = b || defaultInspectTarget(world, playerId, targetType);
    return inspectTarget(world, playerId, targetType, targetId);
  }

  if (parsed.command === 'move') {
    const locationId = resolveLocationId(world, a);
    if (!locationId) return fail('Usage: move <locationId|locationName>');
    const result = executePlayerCommand(world, playerId, { type: 'move', locationId });
    return ok(formatCommandResult(result), result);
  }

  if (parsed.command === 'work') {
    const result = executePlayerCommand(world, playerId, { type: 'work', resource: a || 'currency', amount: numeric(b, 10) });
    return ok(formatCommandResult(result), result);
  }

  if (parsed.command === 'gather') {
    const result = executePlayerCommand(world, playerId, { type: 'gather', resource: a || 'food', amount: numeric(b, 3) });
    return ok(formatCommandResult(result), result);
  }

  if (parsed.command === 'train') {
    const result = executePlayerCommand(world, playerId, { type: 'train', amount: numeric(a, 2), power: numeric(b, 50) });
    return ok(formatCommandResult(result), result);
  }

  if (parsed.command === 'rest') {
    const result = executePlayerCommand(world, playerId, { type: 'rest' });
    return ok(formatCommandResult(result), result);
  }

  if (parsed.command === 'join') {
    const organizationId = resolveOrganizationId(world, parsed.args.join(' '));
    if (!organizationId) return fail('Usage: join <organizationId|organization name>');
    const result = executePlayerCommand(world, playerId, { type: 'join_organization', organizationId, role: c || 'member', createContract: false });
    return ok(formatCommandResult(result), result);
  }

  if (parsed.command === 'wait') {
    const ticks = Math.max(1, numeric(a, session.options.defaultWaitTicks));
    const beforeTick = world.tick;
    advanceShellTicks(session, ticks);
    const report = createTurnReport(world, playerId, { sinceTick: beforeTick });
    session.lastReportTick = world.tick;
    return ok(`Advanced ${ticks} tick(s). World tick=${world.tick}\n${formatTurnReport(report)}`, getSimulationSummary(world));
  }

  if (parsed.command === 'leaderboard') {
    const board = queryWorld(world, { type: 'leaderboard', options: { by: a || 'overall', limit: numeric(b, 10) } });
    return ok(formatLeaderboard(board), board);
  }

  if (parsed.command === 'commands') {
    const commands = getPlayerCommands(world, playerId, numeric(a, 20));
    return ok(formatCommands(commands), commands);
  }

  if (parsed.command === 'snapshot') {
    const file = a || session.options.snapshotPath;
    const snapshot = createWorldSnapshot(world);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8');
    return ok(`Snapshot written: ${file}`, { file, snapshot: { tick: snapshot.world.tick, population: snapshot.population.alive } });
  }

  return fail(`Unknown command: ${parsed.command}. Type help.`);
}

function advanceShellTicks(session, ticks) {
  runSimulationTicks(session.world, ticks, session.options.simulation || {});
  processPlayersTick(session.world);
  processTutorialTick(session.world, { autoStart: true, claimCompleted: false });
  processQuestsTick(session.world);
}

function inspectTarget(world, playerId, targetType, targetId) {
  const normalized = normalizeInspectType(targetType);
  if (normalized === 'player') return ok(formatPlayerStatus(world, playerId), queryWorld(world, { type: 'player', playerId }));
  if (normalized === 'world') return ok(formatWorldOverview(queryWorld(world, { type: 'world' })), queryWorld(world, { type: 'world' }));
  if (!targetId) return fail(`Missing target id for inspect ${normalized}`);
  if (normalized === 'location') return ok(formatJson(queryWorld(world, { type: 'location', locationId: targetId })), queryWorld(world, { type: 'location', locationId: targetId }));
  if (normalized === 'entity') return ok(formatJson(queryWorld(world, { type: 'entity', entityId: targetId })), queryWorld(world, { type: 'entity', entityId: targetId }));
  if (normalized === 'city') return ok(formatJson(queryWorld(world, { type: 'city', cityId: targetId })), queryWorld(world, { type: 'city', cityId: targetId }));
  if (normalized === 'organization') return ok(formatJson(queryWorld(world, { type: 'organization', organizationId: targetId })), queryWorld(world, { type: 'organization', organizationId: targetId }));
  if (normalized === 'civilization') return ok(formatJson(queryWorld(world, { type: 'civilization', civilizationId: targetId })), queryWorld(world, { type: 'civilization', civilizationId: targetId }));
  return fail(`Unknown inspect target: ${targetType}`);
}

function normalizeInspectType(value) {
  return normalizeShellTarget(value || 'player');
}

function defaultInspectTarget(world, playerId, targetType) {
  const view = getPlayerView(world, playerId);
  const entity = view?.activeEntity;
  const normalized = normalizeInspectType(targetType);
  if (normalized === 'entity') return entity?.id || null;
  if (normalized === 'location') return entity?.locationId || view?.observerLocation?.id || null;
  if (normalized === 'city') return Object.keys(world.cities?.byId || {})[0] || null;
  if (normalized === 'organization') return Object.keys(world.organizations?.byId || {})[0] || null;
  if (normalized === 'civilization') return Object.keys(world.civilizations?.byId || {})[0] || null;
  return null;
}

function resolveLocationId(world, value) {
  if (!value) return null;
  if (world.locations[value]) return value;
  const text = String(value).toLowerCase();
  return Object.values(world.locations || {}).find(location => String(location.name || '').toLowerCase() === text)?.id || null;
}

function resolveOrganizationId(world, value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  if (world.organizations?.byId?.[value]) return value;
  return Object.values(world.organizations?.byId || {}).find(org => String(org.name || '').toLowerCase() === text || String(org.id || '').toLowerCase() === text)?.id || null;
}

function formatPlayerStatus(world, playerId) {
  const view = getPlayerView(world, playerId);
  if (!view) return `Missing player: ${playerId}`;
  const e = view.activeEntity;
  if (!e) return `Player ${playerId}: no active character`;
  return [
    `Player: ${view.player.name} (${view.player.status}/${view.player.controlMode})`,
    `Character: ${e.name} [${e.id}] status=${e.status} species=${e.species}`,
    `Location: ${e.locationId}`,
    `Health: ${e.stats.health}/${e.stats.maxHealth} Energy: ${e.stats.energy}/${e.stats.maxEnergy} Power: ${e.stats.power}`,
    `Resources: ${Object.entries(e.resources || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `Organizations: ${(e.organizations || []).join(', ') || 'none'}`,
  ].join('\n');
}

function formatWorldOverview(overview) {
  return [
    `World: ${overview.world.id} tick=${overview.world.tick}`,
    `Alive: ${overview.totals.alive}/${overview.totals.entities}`,
    `Locations: ${overview.totals.locations} Cities: ${overview.totals.cities} Organizations: ${overview.totals.organizations} Civilizations: ${overview.totals.civilizations}`,
    `Players: ${overview.totals.players} Commands: ${overview.totals.commands}`,
    `Limits: memory=${overview.limits.worldMemory}, reports=${overview.limits.reports}, processes=${overview.limits.processes}, information=${overview.limits.information}, memories=${overview.limits.memories}`,
  ].join('\n');
}

function formatCommandResult(result) {
  const command = result.command;
  const data = result.result;
  if (!data.ok) return `Command ${command.type} rejected: ${data.reason}`;
  if (command.status === 'accepted') return `Command ${command.type} accepted: action=${data.actionType || 'n/a'} id=${data.actionId || 'n/a'}`;
  return `Command ${command.type} completed`;
}

function formatLeaderboard(board) {
  return board.map((item, index) => `${index + 1}. ${item.name} [${item.entityId}] score=${item.score} power=${item.power} wealth=${item.currency}`).join('\n') || 'No entities.';
}

function formatCommands(commands) {
  return commands.map(command => `${command.id} ${command.type} ${command.status}`).join('\n') || 'No commands.';
}

function formatQuestList(quests = []) {
  if (!quests.length) return 'No quests. Use tutorial to start tutorial quests.';
  return quests.map(quest => {
    const objectives = (quest.objectives || []).map(objective => {
      const mark = objective.done ? 'x' : ' ';
      return `  [${mark}] ${objective.title || objective.type} ${objective.progress || 0}/${objective.target || 1}`;
    }).join('\n');
    return `${quest.id}\n${quest.title} [${quest.status}]\n${objectives}`;
  }).join('\n\n');
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function ok(message, data = null) {
  return { status: SHELL_STATUS.OK, message, data };
}

function fail(message) {
  return { status: SHELL_STATUS.ERROR, message, data: null };
}

function numeric(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function tokenize(input) {
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  const out = [];
  let match;
  while ((match = re.exec(input))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function mergeOptions(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object') {
      out[key] = mergeOptions(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

module.exports = {
  SHELL_STATUS,
  DEFAULT_SHELL_OPTIONS,
  HELP_TEXT,
  createShellSession,
  parseShellInput,
  executeShellInput,
  dispatchShellCommand,
  advanceShellTicks,
  resolveLocationId,
  resolveOrganizationId,
  formatPlayerStatus,
  formatWorldOverview,
  formatCommandResult,
  formatLeaderboard,
  formatCommands,
  formatQuestList,
};
