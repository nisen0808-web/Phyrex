'use strict';

const assert = require('assert');
const http = require('http');
const { createWorldApiServer } = require('../core/api-server-engine');

async function main() {
  const { server } = createWorldApiServer(null, { seedTicks: 5 });
  const base = await listen(server);
  try {
    const root = await request(base, 'GET', '/');
    assert.strictEqual(root.statusCode, 200, 'root should serve client index');
    assert.ok(root.text.includes('MUD 世界模拟器'), 'index should include title');

    const index = await request(base, 'GET', '/client');
    assert.strictEqual(index.statusCode, 200, '/client should serve index');
    assert.ok(index.text.includes('/client/app.js'), 'index should reference app.js');
    assert.ok(index.text.includes('/client/style.css'), 'index should reference style.css');
    assert.ok(index.text.includes('/client/runtime-controls.js'), 'index should reference runtime controls');
    assert.ok(index.text.includes('/client/runtime-controls.css'), 'index should reference runtime control styles');
    assert.ok(index.text.includes('quickStartBtn'), 'index should include quick start');
    assert.ok(index.text.includes('