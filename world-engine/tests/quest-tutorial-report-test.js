'use strict';

const assert = require('assert');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { executePlayerCommand } = require('../core/command-engine');
const { runSimulationTicks } = require('../core/simulation-engine');
const { seedTutorialQuests, processQuestsTick, getPlayerQuests, claimCompletedPlayerQuests } = require('../core/quest-engine');
const { startTutorial, processTutorialTick, getTutorialView, formatTutorialView } = require('../core/tutorial-engine');
const { createTurnReport, formatTurnReport } = require('../core/turn-report-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'quest_player', name: 'Quest Player' },
    character: {
      id: 'quest_hero',
      name: 'Quest Hero',
      species: 'human',
      locationId: 'qingyun_city',
      stats: { power: 18, intelligence: 30, social: 60 },
      resources: { currency: 150, food: 10 },
      demographics: { age: 19, generation: 1 },
    },
  });

  const seeded = seedTutorialQuests(world, player.id);
  assert.ok(seeded.length >= 1, 'tutorial quests should seed');

  const tutorialStart = startTutorial(world, player.id);
  assert.ok(tutorialStart.quests.length >= 1, 'tutorial start should expose quests');

  executePlayerCommand(world, player.id, { type: 'inspect', targetType: 'player' });
  executePlayerCommand(world, player.id, { type: 'work', resource: 'currency', amount: 20, energyCost: 5 });
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });

  executePlayerCommand(world, player.id, { type: 'move', locationId: 'mist_forest' });
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });

  executePlayerCommand(world, player.id, { type: 'gather', resource: 'wood', amount: 5 });
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });

  executePlayerCommand(world, player.id, { type: 'train', amount: 3, power: 40 });
  runSimulationTicks(world, 1, { autoNovel: false, autoNarrative: false, population: { baseBirthChance: 0, baseMortalityChance: 0 } });

  const sectId = Object.values(world.organizations.byId).find(org => org.name === 'Qingyun Sect')?.id;
  assert.ok(sectId, 'Qingyun Sect should exist');
  executePlayerCommand(world, player.id, { type: 'join_organization', organizationId: sectId, role: 'student', createContract: false });

  const questReport = processQuestsTick(world);
  assert.ok(questReport.completed.length >= 1, 'some tutorial quests should complete');

  const tutorialReports = processTutorialTick(world, { claimCompleted: false });
  assert.ok(tutorialReports.length >= 1, 'tutorial tick should run');

  const tutorialView = getTutorialView(world, player.id);
  assert.ok(tutorialView.quests.length >= 1, 'tutorial view should expose quests');
  assert.ok(formatTutorialView(tutorialView).includes('Tutorial'), 'tutorial view should format');

  const completedBeforeClaim = getPlayerQuests(world, player.id, { status: 'completed' });
  assert.ok(completedBeforeClaim.length >= 1, 'completed quests should be queryable before claim');

  const currencyBefore = Number(world.entities[entity.id].resources.currency || 0);
  const claimed = claimCompletedPlayerQuests(world, player.id);
  assert.ok(claimed.length >= 1, 'completed quests should be claimable');
  assert.ok(Number(world.entities[entity.id].resources.currency || 0) >= currencyBefore, 'claim should not reduce currency');

  const turnReport = createTurnReport(world, player.id, { recentCommands: 20, recentReports: 10, recentQuests: 20 });
  assert.strictEqual(turnReport.playerId, player.id, 'turn report should preserve player id');
  assert.ok(turnReport.recentCommands.length >= 1, 'turn report should include commands');
  assert.ok(turnReport.quests.length >= 1, 'turn report should include quests');
  assert.ok(formatTurnReport(turnReport).includes('Turn Report'), 'turn report should format');

  console.log('quest tutorial turn-report integration test passed');
}

main();
