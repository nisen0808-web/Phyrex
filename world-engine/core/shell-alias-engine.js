'use strict';

const SHELL_COMMAND_ALIASES = {
  help: ['help', '?', '帮助', '指令', '命令帮助'],
  status: ['status', 'me', 'player', '状态', '我', '角色'],
  world: ['world', '世界', '概览'],
  tutorial: ['tutorial', '教程', '引导', '新手'],
  quests: ['quests', 'quest', '任务', '任务列表'],
  claim: ['claim', '领取', '领奖', '领取奖励'],
  report: ['report', '回合', '报告', '回合报告'],
  inspect: ['inspect', 'look', '查看', '观察', '调查'],
  map: ['map', '地图', '地点', '附近'],
  move: ['move', 'go', 'travel', '前往', '移动', '去'],
  work: ['work', '工作', '打工', '赚钱'],
  gather: ['gather', 'collect', '采集', '收集'],
  train: ['train', 'practice', '修炼', '训练', '练功'],
  rest: ['rest', 'sleep', '休息', '睡觉'],
  join: ['join', '加入', '拜入', '投靠'],
  wait: ['wait', 'tick', '等待', '推进', '过回合'],
  leaderboard: ['leaderboard', 'rank', '排行', '排行榜', '榜单'],
  commands: ['commands', 'history', '命令', '历史', '命令历史'],
  snapshot: ['snapshot', 'save', '快照', '保存'],
  quit: ['quit', 'exit', '退出', '离开'],
};

const TARGET_ALIASES = {
  player: ['player', 'me', 'self', '玩家', '我', '自己'],
  world: ['world', '世界'],
  location: ['location', 'loc', 'place', '地点', '位置'],
  entity: ['entity', 'character', 'npc', '角色', '人物'],
  city: ['city', '城市'],
  organization: ['organization', 'org', 'sect', 'guild', '组织', '宗门', '公会'],
  civilization: ['civilization', 'civ', '文明'],
};

function normalizeShellCommand(command) {
  const value = String(command || '').trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(SHELL_COMMAND_ALIASES)) {
    if (aliases.map(alias => String(alias).toLowerCase()).includes(value)) return canonical;
  }
  return value;
}

function normalizeShellTarget(target) {
  const value = String(target || '').trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(TARGET_ALIASES)) {
    if (aliases.map(alias => String(alias).toLowerCase()).includes(value)) return canonical;
  }
  return value;
}

function getShellAliases() {
  return {
    commands: cloneAliasMap(SHELL_COMMAND_ALIASES),
    targets: cloneAliasMap(TARGET_ALIASES),
  };
}

function cloneAliasMap(input) {
  const out = {};
  for (const [key, value] of Object.entries(input)) out[key] = [...value];
  return out;
}

module.exports = {
  SHELL_COMMAND_ALIASES,
  TARGET_ALIASES,
  normalizeShellCommand,
  normalizeShellTarget,
  getShellAliases,
};
