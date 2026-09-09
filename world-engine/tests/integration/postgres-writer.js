'use strict';
const { createPostgresDatabaseStore } = require('../../core/postgres-database-engine');
async function main() {
  const [schema, worldId, revision, requestId] = process.argv.slice(2);
  const store = createPostgresDatabaseStore({ schema, connectionString: process.env.WORLD_ENGINE_TEST_DATABASE_URL });
  try {
    const saved = await store.loadWorld(worldId);
    saved.world.tick += 1;
    console.log(JSON.stringify(await store.saveWorld(saved.world, { expectedRevision: Number(revision), requestId })));
  } finally { await store.close(); }
}
main().catch(error => {
  console.error(error.code || 'WRITER_FAILED');
  process.exitCode = error.code === 'WORLD_DB_REVISION_CONFLICT' ? 2 : 1;
});
