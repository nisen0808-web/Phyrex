'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createPostgresDatabaseStore } = require('../storage/postgres/store');
const { administerAccount } = require('../runtime/durable-account-admin');
const { getAccountView } = require('../core/account-session-engine');

function invalid() { const error = new Error('Invalid account administration arguments'); error.code = 'WORLD_ADMIN_INVALID_INPUT'; throw error; }
function parseArguments(argv) {
  const [command, ...args] = argv;
  const commands = {
    'token.create': ['output'], inspect: ['world-id', 'account-id'],
    'account.create': ['name', 'roles'], 'account.roles': ['roles'], 'account.status': ['status'],
    'player.link': ['player-id'], 'player.unlink': ['player-id'],
    'session.issue': ['token-file', 'ttl-ticks', 'max-sessions'],
    'session.revoke': ['session-id'], 'session.revoke-all': [],
  };
  if (!Object.hasOwn(commands, command)) invalid();
  const mutation = command !== 'token.create' && command !== 'inspect';
  const allowed = [...commands[command], ...(mutation ? ['world-id', 'account-id', 'request-id', 'expected-revision'] : [])];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i].slice(2);
    if (!args[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(options, key)) invalid();
    const value = args[++i];
    if (!value || value.startsWith('--')) invalid();
    options[key] = value;
  }
  for (const key of ['expected-revision', 'ttl-ticks', 'max-sessions']) {
    if (options[key] === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(options[key]) || !Number.isSafeInteger(Number(options[key]))) invalid();
    options[key] = Number(options[key]);
  }
  const required = command === 'token.create' ? ['output']
    : ['world-id', 'account-id', ...(mutation ? ['request-id', 'expected-revision'] : [])];
  if (required.some(key => options[key] === undefined)) invalid();
  return { command, options };
}
async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Trusted database operator tool. Stop/restart the world runtime around writes.\nCommands: token.create, inspect, account.create, account.roles, account.status, player.link, player.unlink, session.issue, session.revoke, session.revoke-all.\nMutations require --world-id ID --account-id ID --request-id UNIQUE --expected-revision N.\nUse --roles player,gm,admin; --status active|suspended|closed; --player-id ID; --session-id ID as applicable.\nIssue a session with --token-file FILE or WORLD_ENGINE_SESSION_TOKEN, optionally --ttl-ticks 10000 --max-sessions 20. Raw tokens never go in arguments/output.\nGenerate an unbound token: token.create --output NEW_FILE. Inspect: inspect --world-id ID --account-id ID.');
    return;
  }
  const { command, options } = parseArguments(argv);
  if (command === 'token.create') {
    const file = path.resolve(options.output);
    const token = crypto.randomBytes(48).toString('base64url');
    await fs.promises.writeFile(file, token + '\n', { flag: 'wx', mode: 0o600 });
    return { created: true, file };
  }
  const operation = { type: command, accountId: options['account-id'] };
  for (const [argument, key] of [['name', 'name'], ['status', 'status'], ['player-id', 'playerId'], ['session-id', 'sessionId'], ['ttl-ticks', 'ttlTicks'], ['max-sessions', 'maxSessions']]) {
    if (options[argument] !== undefined) operation[key] = options[argument];
  }
  if (options.roles !== undefined) operation.roles = options.roles.split(',');
  if (command === 'session.issue') {
    if (options['token-file']) {
      if (env.WORLD_ENGINE_SESSION_TOKEN) invalid();
      const handle = await fs.promises.open(options['token-file'], 'r');
      try {
        if ((await handle.stat()).size > 1024) invalid();
        operation.token = (await handle.readFile({ encoding: 'utf8' })).trim();
      } finally { await handle.close(); }
    } else operation.token = env.WORLD_ENGINE_SESSION_TOKEN;
  }
  const store = createPostgresDatabaseStore({ env });
  try {
    if (command === 'inspect') {
      const saved = await store.loadWorld(options['world-id']);
      const account = saved && getAccountView(saved.world, options['account-id']);
      if (!account) { const error = new Error('Account does not exist'); error.code = 'WORLD_ADMIN_MISSING_ACCOUNT'; throw error; }
      // Inspection contains no token hashes or token prefixes.
      account.sessions = account.sessions.map(({ tokenPrefix: _prefix, ...session }) => session);
      return { worldId: saved.worldId, revision: saved.revision, account };
    }
    return await administerAccount(store, { worldId: options['world-id'], requestId: options['request-id'],
      expectedRevision: options['expected-revision'], operation });
  } finally { await store.close(); }
}
if (require.main === module) main().then(result => { if (result) console.log(JSON.stringify({ ok: true, ...result })); }).catch(error => {
  const code = /^WORLD_(DB|ADMIN)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'ACCOUNT_ADMINISTRATION_FAILED';
  console.error(JSON.stringify({ ok: false, error: code })); process.exitCode = 1;
});
module.exports = { main, parseArguments };
