'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardClientLease } = require('../storage/postgres/client-lease');
const { sanitizeError, createPostgresDatabaseStore } = require('../storage/postgres/store');
const { createPostgresCommandApiAuditStore } = require('../storage/postgres/command-api-audit-store');
const { MIGRATIONS } = require('../storage/postgres/migrations');
async function main() {
  const client = new EventEmitter(); let queries = 0, released;
  client.query = async () => { queries++; return { rows: [] }; };
  client.release = broken => { released = broken; };
  for (let n = 0; n < 3; n++) {
    const lease = guardClientLease(client); await lease.query('SELECT 1'); lease.release(false);
    assert.equal(client.listenerCount('error'), 0); assert.equal(released, false);
  }
  const between = guardClientLease(client);
  // This used to terminate the process when the connection was between queries.
  client.emit('error', new Error('secret-database-url'));
  const before = queries;
  await assert.rejects(between.query('COMMIT'), e => e.code === 'WORLD_DB_UNAVAILABLE' && !e.message.includes('secret'));
  assert.equal(queries,before); between.release(false); assert.equal(released,true);
  assert.equal(client.listenerCount('error'),0);
  const during = guardClientLease(client);
  client.query = async () => { client.emit('error',new Error('secret')); return { rows:['unconfirmed'] }; };
  await assert.rejects(during.query('COMMIT'), { code:'WORLD_DB_UNAVAILABLE' }); during.release(false);
  assert.equal(released,true);
  for (const message of ['Connection terminated unexpectedly','Connection terminated','Client has encountered a connection error and is not queryable']) {
    assert.equal(sanitizeError(new Error(message)).code,'WORLD_DB_UNAVAILABLE');
  }
  for (const create of [createPostgresDatabaseStore,createPostgresCommandApiAuditStore]) {
    let leaseClient;
    class Pool extends EventEmitter {
      async connect() {
        leaseClient = new EventEmitter();
        leaseClient.release = broken => { assert.equal(broken,true); };
        leaseClient.query = async sql => {
          if (sql.startsWith('SELECT version')) { leaseClient.emit('error',new Error('private')); return { rows:MIGRATIONS }; }
          return { rows:[] };
        };
        return leaseClient;
      }
      async end() {}
    }
    const store = create({ connectionString:'postgres://test:secret@127.0.0.1/world_engine_test',Pool });
    try { await assert.rejects(store.summary(),{ code:'WORLD_DB_UNAVAILABLE' }); assert.equal(leaseClient.listenerCount('error'),0); }
    finally { await store.close(); }
  }
  console.log('postgres client lease test passed: between-query loss, ambiguous commit, both stores, redaction and listener cleanup');
}
main().catch(error => { console.error(error); process.exitCode=1; });
