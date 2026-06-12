'use strict';

const {
  seedTutorialQuests,
  processQuestsTick,
  getPlayerQuests,
  claimCompletedPlayerQuests,
} = require('./quest-engine');

const TUTORIAL_STATUS = {
  NOT_STARTED: 'not_started',
  ACTIVE: 'active',
  COMPLETED: 'completed',
};

function ensureTutorialState(world) {
  if (!world.tutorials) {
    world.tutorials = {
      byPlayer: {},
      stats: { started: 0, completed: 0, updated: 0 },
    };
  }
  return world.tutorials;
}

function startTutorial(world, playerId) {
  const state = ensureTutorialState(world);
  if (!state.byPlayer[playerId]) {
    state.byPlayer[playerId] = {
      playerId,
      status: TUTORIAL_STATUS.ACTIVE,
      startedAt: world.tick,
      completedAt: null,
      lastUpdatedAt: world.tick,
      activeQuestId: null,
      completedQuestIds: [],
      claimedQuestIds: [],
    };
    state.stats.started += 1;
  }
  const created = seedTutorialQuests(world, playerId);
  const view = updateTutorialProgress(world, playerId, { claimCompleted: false });
  return { tutorial: view.tutorial, created, quests: view.quests };
}

function processTutorialTick(world, options = {}) {
  const state = ensureTutorialState(world);
  const reports = [];
  for (const playerId of Object.keys(world.players?.byId || {})) {
    if (!state.byPlayer[playerId] && options.autoStart !== false) startTutorial(world, playerId);
    reports.push(updateTutorialProgress(world, playerId, options));
  }
  return reports;
}

function updateTutorialProgress(world, playerId, options = {}) {
  const state = ensureTutorialState(world);
  if (!state.byPlayer[playerId]) startTutorial(world, playerId);
  const tutorial = state.byPlayer[playerId];
  const questReport = processQuestsTick(world, options.quest || {});
  const quests = getPlayerQuests(world, playerId, { tag: 'tutorial' });
  const active = quests.find(q => q.status === 'active') || null;
  const completed = quests.filter(q => q.status === 'completed');
  const claimed = quests.filter(q => q.status === 'claimed');

  if (options.claimCompleted) claimCompletedPlayerQuests(world, playerId);

  tutorial.activeQuestId = active?.id || null;
  tutorial.completedQuestIds = completed.map(q => q.id);
  tutorial.claimedQuestIds = claimed.map(q => q.id);
  tutorial.lastUpdatedAt = world.tick;

  const done = quests.length > 0 && quests.every(q => q.status === 'claimed' || q.status === 'completed');
  const hasActive = quests.some(q => q.status === 'active');
  if (done && !hasActive && tutorial.status !== TUTORIAL_STATUS.COMPLETED) {
    tutorial.status = TUTORIAL_STATUS.COMPLETED;
    tutorial.completedAt = world.tick;
    state.stats.completed += 1;
  } else if (quests.length > 0 && tutorial.status === TUTORIAL_STATUS.NOT_STARTED) {
    tutorial.status = TUTORIAL_STATUS.ACTIVE;
  }

  state.stats.updated += 1;
  return { playerId, tutorial: { ...tutorial }, quests, questReport };
}

function getTutorialView(world, playerId) {
  const state = ensureTutorialState(world);
  const tutorial = state.byPlayer[playerId] || null;
  const quests = getPlayerQuests(world, playerId, { tag: 'tutorial' });
  return {
    tutorial: tutorial ? { ...tutorial } : { playerId, status: TUTORIAL_STATUS.NOT_STARTED },
    quests,
    nextHint: inferNextHint(quests),
  };
}

function inferNextHint(quests = []) {
  const active = quests.find(q => q.status === 'active');
  if (!active) return quests.length ? 'Tutorial objectives are complete. Use claim to collect rewards.' : 'Use tutorial to start the tutorial quest chain.';
  const objective = active.objectives.find(o => !o.done) || active.objectives[0];
  if (!objective) return `Complete quest: ${active.title}`;
  if (objective.type === 'command') return `Try command: ${objective.commandType}`;
  if (objective.type === 'location') return `Move to: ${objective.locationId}`;
  if (objective.type === 'have_resource') return `Collect ${objective.resource}: ${objective.amount || objective.target}`;
  if (objective.type === 'join_organization') return `Join an organization${objective.organizationName ? ` such as ${objective.organizationName}` : ''}.`;
  return active.description || active.title;
}

function formatTutorialView(view) {
  const lines = [];
  lines.push(`Tutorial: ${view.tutorial.status}`);
  if (view.nextHint) lines.push(`Hint: ${view.nextHint}`);
  for (const quest of view.quests || []) {
    lines.push(`\n${quest.title} [${quest.status}]`);
    for (const objective of quest.objectives || []) {
      const mark = objective.done ? 'x' : ' ';
      lines.push(`  [${mark}] ${objective.title || objective.type} ${objective.progress || 0}/${objective.target || 1}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  TUTORIAL_STATUS,
  ensureTutorialState,
  startTutorial,
  processTutorialTick,
  updateTutorialProgress,
  getTutorialView,
  formatTutorialView,
};
