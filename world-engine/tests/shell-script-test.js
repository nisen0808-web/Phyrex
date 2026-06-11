'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function main() {
  const root = path.join(__dirname, '..');
  const scriptPath = path.join(root, 'demo', 'sample-commands.txt');
  const snapshotPath = path.join(root, 'output', 'sample-shell-snapshot.json');
  const demoPath = path.join(root, 'demo', 'play-shell.js');

  if (fs.existsSync(snapshotPath)) fs.unlinkSync(snapshotPath);

  const result = spawnSync(process.execPath, [demoPath, '--script', scriptPath], {
    cwd: path.join(root, '..'),
    encoding: 'utf8',
    timeout: 30000,
  });

  assert.strictEqual(result.status, 0, `play-shell sample script should exit 0\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.ok(result.stdout.includes('World Engine Scripted Shell'), 'script output should include shell header');
  assert.ok(result.stdout.includes('Script completed.'), 'script output should complete');
  assert.ok(result.stdout.includes('Snapshot written'), 'script output should write snapshot');
  assert.ok(fs.existsSync(snapshotPath), 'sample shell snapshot should be created');

  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  assert.ok(snapshot.world.tick >= 10, 'snapshot should contain advanced world tick');
  assert.ok(snapshot.players.total >= 1, 'snapshot should include shell player');
  assert.ok(snapshot.commands.total >= 1, 'snapshot should include shell commands');
  assert.ok(snapshot.limits.worldMemory.current <= snapshot.limits.worldMemory.limit, 'world memory cap should hold');
  assert.ok(snapshot.limits.commands.current <= snapshot.limits.commands.limit, 'command cap should hold');

  console.log('shell-script integration test passed');
}

main();
