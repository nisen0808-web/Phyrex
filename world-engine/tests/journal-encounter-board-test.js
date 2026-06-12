'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const { createPlayerWithCharacter } = require('../core/player-engine');
const { createShellSession, executeShellInput } = require('../core/shell-engine');
const { getPlayerJournal } = require('../core/player-journal-engine');
const { exploreLocation, getPlayerEncounters } = require('../core/encounter-engine');
const { getPlayerQuestBoard, acceptBoardQuest } = require('../core/quest-board-engine');
const { getPlayerQuests } = require('../core/quest-engine');
const { queryWorld } = require('../core/query-engine');
const { createWorldSnapshot } = require('../core/snapshot-engine');

function main() {
  const world = buildDemoWorld();
  runDemoWorld(world, 5, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const { player, entity } = createPlayerWithCharacter(world, {
    player: { id: 'content_player', name: 'Content Player' },
    character: {
      id: 'content_hero',
      name: 'Content Hero',
      species: 'human',
      locationId: 'qingyun_city',
      resources: { currency: 100, food: 10 },
      demographics: { age: 18, generation: 1 },
    },
  });

  const board = getPlayerQuestBoard(world, player.id);
  assert.strictEqual(board.locationId, 'qingyun_city', 'board should use player location');
  assert.ok(board.items.length >= 1, 'board should generate commissions');

  const first = board.items[0];
  const accepted = acceptBoardQuest(world, player.id, first.id);
  assert.strictEqual(accepted.item.status, 'accepted', 'accepted board item should change status');
  assert.ok(accepted.quest.id, 'accepting board item should create quest');
  assert.ok(getPlayerQuests(world, player.id).some(quest => quest.id === accepted.quest.id), 'accepted quest should be in player quests');

  const encounter = exploreLocation(world, player.id);
  assert.ok(encounter.id, 'explore should create encounter');
  assert.strictEqual(encounter.playerId, player.id, 'encounter should belong to player');
  assert.ok(getPlayerEncounters(world, player.id).length >= 1, 'encounter history should be queryable');

  const journal = getPlayerJournal(world, player.id, { limit: 20 });
  assert.ok(journal.length >= 2, 'journal should include board and encounter entries');
  assert.ok(journal.some(entry => entry.type === 'quest'), 'journal should include quest entry');
  assert.ok(journal.some(entry => entry.type === 'encounter'), 'journal should include encounter entry');

  const session = createShellSession(world, player.id);
  let result = executeShellInput(session, 'journal');
  assert.strictEqual(result.status, 'ok', 'journal shell command should succeed');
  assert.ok(result.message.includes('Accepted') || result.message.includes('discovery') || result.message.includes('Encounter') || result.message.length > 0, 'journal should render entries');

  result = executeShellInput(session, 'board');
  assert.strictEqual(result.status, 'ok', 'board shell command should succeed');
  assert.ok(result.message.includes('Quest Board'), 'board should render board title');

  result = executeShellInput(session, 'explore');
  assert.strictEqual(result.status, 'ok', 'explore shell command should succeed');
  assert.ok(result.message.includes('Rewards:'), 'explore should render encounter rewards');

  result = executeShellInput(session, '日志');
  assert.strictEqual(result.status, 'ok', 'Chinese journal alias should succeed');

  result = executeShellInput(session, '委托');
  assert.strictEqual(result.status, 'ok', 'Chinese board alias should succeed');

  result = executeShellInput(session, '探索');
  assert.strictEqual(result.status, 'ok', 'Chinese explore alias should succeed');

  const boardAfter = getPlayerQuestBoard(world, player.id).items.find(item => item.status === 'open');
  if (boardAfter) {
    result = executeShellInput(session, `接取 ${boardAfter.id}`);
    assert.strictEqual(result.status, 'ok', 'Chinese accept alias should succeed');
  }

  const journalQuery = queryWorld(world, { type: 'journal', playerId: player.id });
  assert.ok(journalQuery.entries.length >= 1, 'journal query should return entries');

  const encounterQuery = queryWorld(world, { type: 'encounters', playerId: player.id });
  assert.ok(encounterQuery.encounters.length >= 1, 'encounter query should return encounters');

  const boardQuery = queryWorld(world, { type: 'board', playerId: player.id });
  assert.ok(Array.isArray(boardQuery.items), 'board query should return items');

  const snapshot = createWorldSnapshot(world);
  assert.ok(snapshot.journals.total >= 1, 'snapshot should include journals');
  assert.ok(snapshot.encounters.total >= 1, 'snapshot should include encounters');
  assert.ok(snapshot.questBoards.total >= 1, 'snapshot should include quest boards');
  assert.ok(snapshot.limits.journals.current <= snapshot.limits.journals.limit, 'journal cap should hold');
  assert.ok(snapshot.limits.encounters.current <= snapshot.limits.encounters.limit, 'encounter cap should hold');
  assert.ok(snapshot.limits.questBoards.current <= snapshot.limits.questBoards.limit, 'quest board cap should hold');

  const out = path.join(__dirname, '..', 'output', 'journal-encounter-board-snapshot.json');
  fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
  assert.ok(fs.existsSync(out), 'content snapshot should be written');

  assert.ok(world.entities[entity.id].status === 'alive', 'content test should not kill player');

  console.log('journal encounter board integration test passed');
}

main();
