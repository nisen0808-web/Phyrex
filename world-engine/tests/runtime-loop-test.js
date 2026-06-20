'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { buildDemoWorld, runDemoWorld } = require('../demo/run-demo');
const {
  createRuntimeLoop,
  startRuntimeLoop,
  pauseRuntimeLoop,
  stopRuntimeLoop,
  configureRuntimeLoop,
  stepRuntimeLoop,
  getRuntimeLoopSummary,
} = require('../core/runtime-loop-engine');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  await testRuntimeLoopEngine();
  await testRuntimeLoopApi();
  console.log('continuous runtime loop integration test passed');
}

async function testRuntimeLoopEngine() {
  const world = buildDemoWorld();
  runDemoWorld(world, 2, {
    autoNovel: false,
    autoNarrative: false,
    population: { baseBirthChance: 0, baseMortalityChance: 0 },
  });

  const savePath = path.join(
    __dirname,
    '..',
    'output',
    `runtime-loop-test-${process.pid}-${Date.now()}.json`,
  );
  const loop = createRuntimeLoop(world, {
    intervalMs: 20,
    ticksPerCycle: 1,
    autosaveEveryTicks: 2,
    autosavePath: savePath,
    immediate: true,
    stopOnError: true,
    simulation: {
      autoNovel: false,
      autoNarrative: false,
      population: { baseBirthChance: 0, baseMortalityChance: 0 },
    },
  });

  const tickBefore = world.tick;
  const manual = stepRuntimeLoop(loop, 2, { source: 'test_manual' });
  assert.strictEqual(manual.ok, true, 'manual runtime loop step should succeed');
  assert.strictEqual(world.tick, tickBefore + 2, 'manual step should advance requested ticks');
  assert.ok(fs.existsSync(savePath), 'runtime loop should autosave after configured tick interval');

  let summary = getRuntimeLoopSummary(loop);
  assert.strictEqual(summary.cycles, 1, 'manual step should count one cycle');
  assert.strictEqual(summary.ticksRun, 2, 'manual step should count ticks');
  assert.ok(summary.lastAutosave, 'summary should include last autosave');

  configureRuntimeLoop(loop, {
    intervalMs: 15,
    ticksPerCycle: 1,
    immediate: true,
  });
  startRuntimeLoop(loop);
  await waitFor(() => getRuntimeLoopSummary(loop).cycles >= 3, 2000);

  summary = pauseRuntimeLoop(loop, 'test_pause');
  assert.strictEqual(summary.status, 'paused', 'pause should set paused status');
  assert.ok(summary.ticksRun >= 4, 'timer cycles should advance world ticks');
  assert.strictEqual(summary.errorCount, 0, 'runtime loop should have no errors');

  const pausedTick = world.tick;
  await delay(50);
  assert.strictEqual(world.tick, pausedTick, 'paused loop should not advance ticks');

  summary = startRuntimeLoop(loop, { immediate: true });
  assert.strictEqual(summary.status, 'running', 'paused loop should resume');
  await waitFor(() => world.tick > pausedTick, 2000);

  summary = stopRuntimeLoop(loop, 'test_stop');
  assert.strictEqual(summary.status, 'stopped', 'stop should set stopped status');
  const stoppedTick = world.tick;
  await delay(40);
  assert.strictEqual(world.tick, stoppedTick, 'stopped loop should not advance ticks');
}

async function testRuntimeLoopApi() {
  const savePath = path.join(
    __dirname,
    '..',
    'output',
    `runtime-loop-api-${process.pid}-${Date.now()}.json`,
  );
  const { server } = createWorldApiServer(null, {
    seedTicks: 2,
    requireAuth: true,
    runtimeLoop: {
      intervalMs: 20,
      ticksPerCycle: 1,
      autosaveEveryTicks: 2,
      autosavePath: savePath,
      immediate: true,
      stopOnError: true,
    },
  });
  const base = await listen(server);

  try {
    await requestJson(base, 'POST', '/accounts', {
      id: 'loop_player_account',
      name: 'Loop Player',
      roles: ['player'],
    });
    await requestJson(base, 'POST', '/accounts', {
      id: 'loop_gm_account',
      name: 'Loop GM',
      roles: ['gm'],
    });

    const playerSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'loop_player_account',
    });
    const gmSession = await requestJson(base, 'POST', '/sessions', {
      accountId: 'loop_gm_account',
    });
    const playerHeaders = bearer(playerSession.data.token);
    const gmHeaders = bearer(gmSession.data.token);

    const forbidden = await requestJsonAllowError(
      base,
      'GET',
      '/admin/loop',
      null,
      playerHeaders,
    );
    assert.strictEqual(forbidden.statusCode, 403, 'normal player should not read runtime loop state');

    let state = await requestJson(base, 'GET', '/admin/loop', null, gmHeaders);
    assert.strictEqual(state.data.status, 'stopped', 'runtime loop should start stopped by default');

    const configured = await requestJson(base, 'POST', '/admin/loop/config', {
      options: {
        intervalMs: 15,
        ticksPerCycle: 1,
        autosaveEveryTicks: 2,
        autosavePath: savePath,
        immediate: true,
      },
    }, gmHeaders);
    assert.strictEqual(configured.data.intervalMs, 15, 'gm should configure runtime loop interval');

    const tickBefore = configured.data.tick;
    const stepped = await requestJson(base, 'POST', '/admin/loop/step', {
      ticks: 2,
    }, gmHeaders);
    assert.strictEqual(stepped.data.report.ok, true, 'gm loop step should succeed');
    assert.strictEqual(stepped.data.summary.tick, tickBefore + 2, 'gm loop step should advance ticks');
    assert.ok(fs.existsSync(savePath), 'API runtime loop step should trigger autosave');

    const started = await requestJson(base, 'POST', '/admin/loop/start', {
      options: { intervalMs: 15, ticksPerCycle: 1, immediate: true },
    }, gmHeaders);
    assert.strictEqual(started.data.status, 'running', 'gm should start runtime loop');

    await waitFor(async () => {
      const response = await requestJson(base, 'GET', '/admin/loop', null, gmHeaders);
      return response.data.cycles >= 3;
    }, 2500);

    const paused = await requestJson(base, 'POST', '/admin/loop/pause', {
      reason: 'test_pause',
    }, gmHeaders);
    assert.strictEqual(paused.data.status, 'paused', 'gm should pause runtime loop');
    assert.strictEqual(paused.data.errorCount, 0, 'API runtime loop should have no errors');

    const pausedTick = paused.data.tick;
    await delay(50);
    state = await requestJson(base, 'GET', '/admin/loop', null, gmHeaders);
    assert.strictEqual(state.data.tick, pausedTick, 'paused API runtime loop should not advance');

    const stopped = await requestJson(base, 'POST', '/admin/loop/stop', {
      reason: 'test_stop',
    }, gmHeaders);
    assert.strictEqual(stopped.data.status, 'stopped', 'gm should stop runtime loop');

    const health = await requestJson(base, 'GET', '/health');
    assert.ok(health.runtimeLoop, 'health should expose runtime loop summary');
  } finally {
    await close(server);
  }
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
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

function requestJson(base, method, pathname, body = null, headers = {}) {
  return requestJsonAllowError(base, method, pathname, body, headers).then(result => {
    if (result.statusCode >= 400) {
      throw new Error(`HTTP ${result.statusCode}: ${JSON.stringify(result.body)}`);
    }
    return result.body;
  });
}

function requestJsonAllowError(base, method, pathname, body = null, headers = {}) {
  const url = new URL(pathname, base);
  const payload = body ? JSON.stringify(body) : null;
  const requestHeaders = { ...headers };
  if (payload) {
    requestHeaders['Content-Type'] = 'application/json';
    requestHeaders['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: requestHeaders }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(text || '{}'),
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await delay(15);
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
