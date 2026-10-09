'use strict';
const assert = require('node:assert/strict');
const { consoleFixture } = require('./helpers/console-fixture');
async function main() {
  const f = await consoleFixture(), base = `http://127.0.0.1:${f.port}`, before = JSON.stringify(f.world);
  try {
    for (const route of ['/world-builder','/console/workbench.mjs','/console/workbench-model.mjs','/console/workbench.css','/console/template-validation.js','/console/template-catalog.json']) {
      const response = await fetch(base+route); assert.equal(response.status,200);
      assert.match(response.headers.get('Content-Security-Policy'),/script-src 'self'/); assert.equal(response.headers.get('Cache-Control'),'no-store');
      assert((await response.text()).length > 100);
      const head = await fetch(base+route,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
      assert.equal((await fetch(base+route,{method:'POST',body:'private-test-config'})).status,405);
      assert.equal((await fetch(base+route+'?config=private-test-config')).status,400);
    }
    const catalog = await (await fetch(base+'/console/template-catalog.json')).json(); assert.equal(catalog.species.length,4);
    assert.equal(require('..').validateEngineTemplate(catalog.sample).valid,true);
    for (const route of ['/console/template-catalog.json/extra','/shared/template-validation.js','/world-builder/configure']) assert.equal((await fetch(base+route)).status,404);
    assert.equal(JSON.stringify(f.world),before); assert.equal(f.rows.length,0);
    assert(!JSON.stringify(f.audits).includes('private-test-config'));
    assert(!JSON.stringify(catalog).includes('console-admin-fixture'));
  } finally { await f.api.close(); }
  console.log('template workbench HTTP passed: exact static allowlist, no credentials, no write routes and unchanged running world');
}
main().catch(error => { console.error(error); process.exitCode=1; });
