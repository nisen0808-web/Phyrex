'use strict';

const { getPlayerView } = require('./player-engine');
const { getPlayerCommands } = require('./command-engine');
const { getPlayerQuests } = require('./quest-engine');

const DEFAULT_TURN_REPORT_OPTIONS = {
  recentCommands: 8,
  recentReports: 5,
  recentQuests: 8,
};

function createTurnReport(world, playerId, options = {}) {
  const config = { ...DEFAULT_TURN_REPORT_OPTIONS, ...(options || {}) };
  const view = getPlayerView(world, playerId);
  const commands = getPlayerCommands(world, playerId, config.recentCommands);
  const quests = getPlayerQuests(world, playerId).slice(0, config.recentQuests);
  const reports = (world.simulation?.reports || []).slice(-config.recentReports);
  const active = view?.activeEntity || null;

  return {
    playerId,
    tick: world.tick,
    player: view?.player || null,
    activeEntity: active ? {
      id: active.id,
      name: active.name,
      status: active.status,
      locationId: active.locationId,
      health: active.stats?.health,
      energy: active.stats?.energy,
      power: active.stats?.power,
      resources: { ...(active.resources || {}) },
      organizations: [...(active.organizations || [])],
    } : null,
    recentCommands: commands.map(command => ({
      id: command.id,
      type: command.type,
      status: command.status,
      tick: command.updatedAt,
      ok: command.result?.ok ?? null,
      actionType: command.result?.actionType || null,
      reason: command.result?.reason || null,
    })),
    quests: quests.map(quest => ({
      id: quest.id,
      title: quest.title,
      status: quest.status,
      progress: questProgress(quest),
      objectives: quest.objectives.map(objective => ({
        title: objective.title || objective.type,
        type: objective.type,
        progress: objective.progress,
        target: objective.target,
        done: objective.done,
      })),
    })),
    reports,
    summary: summarizeReports(reports),
  };
}

function formatTurnReport(report) {
  const lines = [];
  lines.push(`Turn Report: tick=${report.tick}`);
  if (report.activeEntity) {
    const e = report.activeEntity;
    lines.push(`Character: ${e.name} [${e.status}] location=${e.locationId} HP=${e.health} EN=${e.energy} Power=${e.power}`);
    lines.push(`Resources: ${Object.entries(e.resources || {}).map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`);
  } else {
    lines.push('Character: none');
  }

  lines.push(`World: actions=${report.summary.completedActions} events=${report.summary.processedEvents} births=${report.summary.births} deaths=${report.summary.deaths}`);

  if (report.recentCommands.length) {
    lines.push('Recent commands:');
    for (const command of report.recentCommands.slice(-5)) {
      lines.push(`- ${command.type} ${command.status}${command.actionType ? ` action=${command.actionType}` : ''}${command.reason ? ` reason=${command.reason}` : ''}`);
    }
  }

  if (report.quests.length) {
    lines.push('Quests:');
    for (const quest of report.quests.slice(0, 6)) {
      lines.push(`- ${quest.title}: ${quest.status} ${quest.progress}%`);
    }
  }

  return lines.join('\n');
}

function summarizeReports(reports) {
  return {
    births: sum(reports.map(report => report.births || 0)),
    deaths: sum(reports.map(report => report.deaths || 0)),
    completedActions: sum(reports.map(report => report.completedActions || 0)),
    processedEvents: sum(reports.map(report => report.processedEvents || 0)),
    conflictsCreated: sum(reports.map(report => report.conflictsCreated || 0)),
    questsChanged: sum(reports.map(report => report.questsCompleted || 0)),
  };
}

function questProgress(quest) {
  if (!quest.objectives?.length) return 0;
  const progress = quest.objectives.reduce((sum, objective) => sum + Math.min(1, Number(objective.progress || 0) / Math.max(1, Number(objective.target || 1))), 0);
  return Math.round((progress / quest.objectives.length) * 100);
}

function sum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((a, b) => a + b, 0);
}

module.exports = {
  DEFAULT_TURN_REPORT_OPTIONS,
  createTurnReport,
  formatTurnReport,
  summarizeReports,
};
