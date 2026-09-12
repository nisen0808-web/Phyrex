from pathlib import Path

p = Path('world-engine/core/durable-command-api-engine.js')
s = p.read_text()

old = """  if (store.provider !== 'postgres' || !['loadWorld', 'enqueueCommand', 'getCommand', 'summary', 'close'].every(key => typeof store[key] === 'function')) {"""
new = """  if (store.provider !== 'postgres' || !['loadWorld', 'enqueueCommand', 'getCommand', 'appendCommandApiAudit', 'summary', 'close'].every(key => typeof store[key] === 'function')) {"""
if s.count(old) != 1: raise SystemExit('store contract anchor mismatch')
s = s.replace(old, new)

old = """    const row = await withFreshPlayerAuthorization(
      store,
      route.worldId,
      route.playerId,
      token,
      options.authorizationAttempts,
      options.rateLimiters.submit,
      context => store.enqueueCommand({
        worldId: route.worldId,
        id: body.id,
        playerId: route.playerId,
        input: body,
      }, { expectedWorldRevision: context.revision }),
    );"""
new = """    const row = await withFreshPlayerAuthorization(
      store,
      route.worldId,
      route.playerId,
      body.id,
      token,
      options.authorizationAttempts,
      options.rateLimiters.submit,
      context => store.enqueueCommand({
        worldId: route.worldId,
        id: body.id,
        playerId: route.playerId,
        input: body,
      }, { expectedWorldRevision: context.revision, audit: { accountId: context.auth.account.id } }),
    );"""
if s.count(old) != 1: raise SystemExit('submit call anchor mismatch')
s = s.replace(old, new)

start = s.index('async function withFreshPlayerAuthorization(')
end = s.index('async function withFreshCommandAuthorization(', start)
player_helper = """async function withFreshPlayerAuthorization(store, worldId, playerId, commandId, token, attempts, accountLimiter, action) {
  let accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token);
    if (!accountRateChecked) {
      enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id)));
      accountRateChecked = true;
    }
    if (!context.world.players?.byId?.[playerId]) {
      const error = apiError(404, 'player_not_found');
      await appendFailureAudit(store, context, {
        playerId, commandId, method: 'POST', route: 'command.submit',
      }, error);
      throw error;
    }
    try {
      requirePermission(canAccessPlayer(context.auth.account, playerId), 'player_forbidden');
    } catch (error) {
      await appendFailureAudit(store, context, {
        playerId, commandId, method: 'POST', route: 'command.submit',
      }, error);
      throw error;
    }
    try {
      return await action(context);
    } catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) continue;
      await appendFailureAudit(store, context, {
        playerId, commandId, method: 'POST', route: 'command.submit',
      }, error);
      throw error;
    }
  }
  throw apiError(409, 'world_revision_changed');
}

"""
s = s[:start] + player_helper + s[end:]

start = s.index('async function withFreshCommandAuthorization(')
end = s.index('async function authenticateWorld(', start)
status_helper = """async function withFreshCommandAuthorization(store, worldId, commandId, token, attempts, accountLimiter) {
  let accountRateChecked = false;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const context = await authenticateWorld(store, worldId, token);
    if (!accountRateChecked) {
      enforceRateLimit(accountLimiter.consume(accountRateKey(worldId, context.auth.account.id)));
      accountRateChecked = true;
    }
    let row;
    try {
      row = await store.getCommand(worldId, commandId, { expectedWorldRevision: context.revision });
    } catch (error) {
      if (error?.code === 'WORLD_DB_REVISION_CONFLICT' && attempt + 1 < attempts) continue;
      await appendFailureAudit(store, context, {
        commandId, method: 'GET', route: 'command.status',
      }, error);
      throw error;
    }
    if (!row) {
      const error = apiError(404, 'command_not_found');
      await appendFailureAudit(store, context, {
        commandId, method: 'GET', route: 'command.status',
      }, error);
      throw error;
    }
    try {
      requirePermission(canAccessPlayer(context.auth.account, row.playerId), 'command_forbidden');
    } catch (error) {
      await appendFailureAudit(store, context, {
        playerId: row.playerId, commandId: row.id, commandSequence: row.sequence,
        method: 'GET', route: 'command.status',
      }, error);
      throw error;
    }
    await store.appendCommandApiAudit({
      worldId,
      accountId: context.auth.account.id,
      playerId: row.playerId,
      commandId: row.id,
      commandSequence: row.sequence,
      method: 'GET',
      route: 'command.status',
      statusCode: 200,
      outcome: row.status === 'applied' ? 'read_applied' : 'read_pending',
    });
    return row;
  }
  throw apiError(409, 'world_revision_changed');
}

async function appendFailureAudit(store, context, input, error) {
  const mapped = mapError(error);
  if (mapped.status < 400 || mapped.status >= 500 || mapped.status === 429) return null;
  return store.appendCommandApiAudit({
    worldId: context.world.id,
    accountId: context.auth.account.id,
    playerId: input.playerId ?? null,
    commandId: input.commandId ?? null,
    commandSequence: input.commandSequence ?? null,
    method: input.method,
    route: input.route,
    statusCode: mapped.status,
    outcome: mapped.code,
  });
}

"""
s = s[:start] + status_helper + s[end:]

old = """  enforceRateLimit,
};"""
new = """  enforceRateLimit,
  appendFailureAudit,
};"""
if s.count(old) != 1: raise SystemExit('export anchor mismatch')
s = s.replace(old, new)

p.write_text(s)
