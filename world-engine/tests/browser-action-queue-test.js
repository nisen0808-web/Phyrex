'use strict';

const assert = require('assert');
const http = require('http');
const vm = require('vm');
const queueModel = require('../client/action-queue-model');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  testQueueModel();

  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);

  try {
    const index = await request(base, '/client');
    assert.strictEqual(index.statusCode, 200, 'browser client should load');
    assert.ok(index.text.includes('/client/action-queue-model.js'), 'client should load queue model');
    assert.ok(index.text.includes('/client/action-queue.js'), 'client should load queue controller');
    assert.ok(index.text.includes('/client/action-queue.css'), 'client should load queue styles');

    const modelScript = await request(base, '/client/action-queue-model.js');
    assert.strictEqual(modelScript.statusCode, 200, 'queue model should be served');
    assert.ok(modelScript.headers['content-type'].includes('application/javascript'));
    assert.ok(modelScript.text.includes('createQueueItem'));
    assert.ok(modelScript.text.includes('markFailure'));
    new vm.Script(modelScript.text, { filename: 'action-queue-model.js' });

    const controller = await request(base, '/client/action-queue.js');
    assert.strictEqual(controller.statusCode, 200, 'queue controller should be served');
    assert.ok(controller.headers['content-type'].includes('application/javascript'));
    assert.ok(controller.text.includes('startActionQueue'));
    assert.ok(controller.text.includes('pauseActionQueue'));
    assert.ok(controller.text.includes('window.runGameAction'));
    assert.ok(controller.text.includes('mud_action_queue'));
    assert.ok(controller.text.includes('queueContinueOnError'));
    new vm.Script(controller.text, { filename: 'action-queue.js' });

    const stylesheet = await request(base, '/client/action-queue.css');
    assert.strictEqual(stylesheet.statusCode, 200, 'queue stylesheet should be served');
    assert.ok(stylesheet.headers['content-type'].includes('text/css'));
    assert.ok(stylesheet.text.includes('.action-queue-panel'));
    assert.ok(stylesheet.text.includes('.action-queue-item.failed'));

    console.log('browser action queue integration test passed');
  } finally {
    await close(server);
  }
}

function testQueueModel() {
  const work = queueModel.buildAction({
    type: 'work',
    argument: 'currency',
    amount: 10,
  });
  assert.deepStrictEqual(work, {
    type: 'command',
    command: { type: 'work', amount: 10, resource: 'currency' },
  });

  const gather = queueModel.buildAction({ type: 'gather', amount: 3 });
  assert.strictEqual(gather.command.resource, 'wood', 'gather should default to wood');
  assert.deepStrictEqual(queueModel.buildAction({ type: 'explore' }), { type: 'explore' });
  assert.deepStrictEqual(queueModel.buildAction({ type: 'move', argument: 'mist_forest' }), {
    type: 'move',
    locationId: 'mist_forest',
  });
  assert.throws(() => queueModel.buildAction({ type: 'move' }), /requires locationId/);
  assert.throws(() => queueModel.buildAction({ type: 'unknown' }), /Unsupported queue action/);

  const items = [
    queueModel.createQueueItem({
      id: 'work_item',
      type: 'work',
      argument: 'currency',
      amount: 10,
      repeat: 2,
    }, { now: 1000 }),
    queueModel.createQueueItem({
      id: 'move_item',
      type: 'move',
      argument: 'mist_forest',
    }, { now: 2000 }),
  ];

  assert.strictEqual(queueModel.nextRunnableIndex(items), 0);
  queueModel.markRunning(items, 0, 3000);
  assert.strictEqual(items[0].status, 'running');
  queueModel.markSuccess(items, 0, 4000);
  assert.strictEqual(items[0].status, 'pending');
  assert.strictEqual(items[0].completed, 1);
  queueModel.markSuccess(items, 0, 5000);
  assert.strictEqual(items[0].status, 'done');
  assert.strictEqual(queueModel.nextRunnableIndex(items), 1);

  queueModel.markRunning(items, 1, 6000);
  queueModel.markFailure(items, 1, new Error('blocked path'), 7000);
  assert.strictEqual(items[1].status, 'failed');
  assert.strictEqual(items[1].error, 'blocked path');
  assert.strictEqual(queueModel.nextRunnableIndex(items), -1);
  queueModel.retryItem(items, 1);
  assert.strictEqual(items[1].status, 'pending');

  const summary = queueModel.summarizeQueue(items);
  assert.deepStrictEqual(summary, {
    items: 2,
    pending: 1,
    running: 0,
    done: 1,
    failed: 0,
    totalRuns: 3,
    completedRuns: 2,
  });

  const restored = queueModel.normalizeQueue([{
    id: 'interrupted',
    label: 'Interrupted',
    action: { type: 'explore' },
    repeat: 2,
    completed: 1,
    status: 'running',
  }]);
  assert.strictEqual(restored[0].status, 'pending', 'running items should recover as pending');
  assert.strictEqual(restored[0].completed, 1);

  const complete = queueModel.normalizeQueue([{
    id: 'complete',
    action: { type: 'explore' },
    repeat: 1,
    completed: 1,
    status: 'pending',
  }]);
  assert.strictEqual(complete[0].status, 'done', 'completed repetitions should recover as done');
}

function listen(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function request(base, pathname) {
  const url = new URL(pathname, base);
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
