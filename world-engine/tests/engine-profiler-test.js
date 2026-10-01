'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createEngineWorld } = require('../demo/engine-v1-world');
const { profileEngineWorld } = require('../runtime/engine-profiler');
const { advanceDeterministicBatch } = require('../runtime/durable-world-runtime');
const { createSaveEnvelope } = require('../core/persistence-engine');
const { detachedJson, digest } = require('../storage/postgres/codec');
const { parseArguments } = require('../demo/engine-profile-cli');

const input = createEngineWorld({ seed: 'profiler-equivalence', population: 2 });
input.operatorFixture = { token: 'secret-token-do-not-output', database: 'secret-db-do-not-output' };
const before = JSON.stringify(input), reference = detachedJson(input);
advanceDeterministicBatch(reference, 1);
advanceDeterministicBatch(reference, 2);
const { report, world } = profileEngineWorld(input, { warmup: 1, ticks: 2 });
assert.strictEqual(JSON.stringify(input), before, 'profiling cannot mutate the supplied world');
assert.deepStrictEqual(world, reference, 'timing instrumentation cannot change simulation state');
assert.strictEqual(report.start.tick, 1);
assert.strictEqual(report.end.tick, 3);
assert.strictEqual(report.end.digest, digest(reference));
assert.strictEqual(report.samples.length, 2);
assert.strictEqual(report.mode, 'offline-world-copy');
assert.ok(report.systems.length > 20 && report.systems.some(row => row.calls === 2));
assert.ok(report.systems.every(row => row.calls <= 2 && row.failures === 0 && row.totalMs >= 0 && row.maxMs >= 0));
assert.ok(report.elapsedMs >= 0 && report.timing.p95Ms >= report.timing.medianMs);
assert.ok(report.samples.every(row => row.totalMs >= 0 && row.normalizationMs >= 0 && row.schedulerAndIntegrityMs >= 0));
assert.ok(!JSON.stringify(report).includes('secret-'));
assert.ok(!Object.hasOwn(world, 'profile'));
for (const ticks of [0, -1, 1.5, 1001, Infinity, '2']) assert.throws(() => profileEngineWorld(input, { ticks }));
for (const warmup of [-1, 1.5, 1001, Infinity]) assert.throws(() => profileEngineWorld(input, { warmup }));
for (const argv of [
  [], ['--output', 'x', '--ticks', '0'], ['--output', 'x', '--ticks', '01'], ['--output', 'x', '--ticks', '1001'],
  ['--output', 'x', '--population', '1'], ['--output', 'x', '--unknown', 'yes'], ['--output', 'x', '--output', 'y'],
  ['--output', 'x', '--input', 'save', '--seed', 's'], ['--output', 'x', '--input', 'save', '--population', '4'],
]) assert.throws(() => parseArguments(argv));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phyrex-profiler-'));
const cli = path.resolve(__dirname, '../demo/engine-profile-cli.js');
try {
  const save = path.join(directory, 'save.json'), output = path.join(directory, 'profile.json');
  fs.writeFileSync(save, JSON.stringify(createSaveEnvelope(input, { metadata: { token: 'secret-metadata-do-not-output' } })));
  const bytes = fs.readFileSync(save);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const result = run('--input', save, '--output', output, '--ticks', '1');
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).ok);
  const text = fs.readFileSync(output, 'utf8');
  assert.ok(!text.includes('secret-') && !result.stdout.includes('secret-') && !result.stderr.includes('secret-'));
  assert.strictEqual(JSON.parse(text).end.tick, 1);
  assert.deepStrictEqual(fs.readFileSync(save), bytes);
  const duplicate = run('--input', save, '--output', output, '--ticks', '1');
  assert.notStrictEqual(duplicate.status, 0);
  assert.strictEqual(fs.readFileSync(output, 'utf8'), text, 'existing output must not be replaced');
  assert.strictEqual(JSON.parse(duplicate.stderr).error, 'ENGINE_PROFILE_FAILED');
  const generated = run('--population', '2', '--seed', 'profile-cli-generated', '--output', path.join(directory, 'generated.json'), '--ticks', '1');
  assert.strictEqual(generated.status, 0, generated.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'generated.json'), 'utf8')).start.entities, 2);
  const future = path.join(directory, 'future.json');
  fs.writeFileSync(future, JSON.stringify({ schemaVersion: 999, world: input }));
  assert.notStrictEqual(run('--input', future, '--output', path.join(directory, 'future-report.json')).status, 0);
  assert.ok(!fs.existsSync(path.join(directory, 'future-report.json')));
  const huge = path.join(directory, 'huge.json');
  const fd = fs.openSync(huge, 'w'); fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1); fs.closeSync(fd);
  assert.notStrictEqual(run('--input', huge, '--output', path.join(directory, 'huge-report.json')).status, 0);
  assert.ok(!fs.existsSync(path.join(directory, 'huge-report.json')));
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
console.log('engine profiler passed: identical world, isolated timings, bounded arguments, private output and CLI recovery input');

