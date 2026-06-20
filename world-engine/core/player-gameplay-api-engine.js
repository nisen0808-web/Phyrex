'use strict';

const {
  bootstrapLocalPlayer,
  getPlayerDashboard,
  movePlayer,
  acceptPlayerBoardQuest,
  claimPlayerQuest,
  claimAllPlayerQuests,
  equipPlayerItem,
  unequipPlayerItem,
  usePlayerItem,
  buyPlayerItem,
  sellPlayerItem,
} = require('./player-gameplay-engine');

async function dispatchPlayerGameplayApi(input = {}) {
  const { world, method, pathname, readBody, authorizePlayer, allowBootstrap = true } = input;

  if (method === 'POST' && pathname === '/client/bootstrap') {
    if (!allowBootstrap) throw apiError(403, 'local_bootstrap_disabled');
    const body = await readBody();
    const result = bootstrapLocalPlayer(world, body || {});
    return response(201, result, result.player?.player?.id || body.playerId || 'local_player', {
      type: 'client.bootstrap',
      accountId: result.account?.id,
      playerId: result.player?.player?.id,
    });
  }

  const dashboardMatch = pathname.match(/^\/players\/([^/]+)\/dashboard$/);
  if (method === 'GET' && dashboardMatch) {
    const playerId = decodeURIComponent(dashboardMatch[1]);
    authorizePlayer(playerId);
    return response(200, getPlayerDashboard(world, playerId), playerId);
  }

  const moveMatch = pathname.match(/^\/players\/([^/]+)\/move$/);
  if (method === 'POST' && moveMatch) {
    const playerId = decodeURIComponent(moveMatch[1]);
    authorizePlayer(playerId);
    const body = await readBody();
    const result = movePlayer(world, playerId, required(body, 'locationId'));
    return response(200, result, playerId, { type: 'player.move', playerId, locationId: body.locationId });
  }

  const acceptMatch = pathname.match(/^\/players\/([^/]+)\/board\/([^/]+)\/accept$/);
  if (method === 'POST' && acceptMatch) {
    const playerId = decodeURIComponent(acceptMatch[1]);
    const boardItemId = decodeURIComponent(acceptMatch[2]);
    authorizePlayer(playerId);
    const result = acceptPlayerBoardQuest(world, playerId, boardItemId);
    return response(201, result, playerId, { type: 'quest.accepted', playerId, boardItemId, questId: result.quest?.id });
  }

  const claimAllMatch = pathname.match(/^\/players\/([^/]+)\/quests\/claim-all$/);
  if (method === 'POST' && claimAllMatch) {
    const playerId = decodeURIComponent(claimAllMatch[1]);
    authorizePlayer(playerId);
    const result = claimAllPlayerQuests(world, playerId);
    return response(200, result, playerId, { type: 'quest.claimed_all', playerId, claimed: result.claimed });
  }

  const claimMatch = pathname.match(/^\/players\/([^/]+)\/quests\/([^/]+)\/claim$/);
  if (method === 'POST' && claimMatch) {
    const playerId = decodeURIComponent(claimMatch[1]);
    const questId = decodeURIComponent(claimMatch[2]);
    authorizePlayer(playerId);
    const result = claimPlayerQuest(world, playerId, questId);
    return response(200, result, playerId, { type: 'quest.claimed', playerId, questId, status: result?.status });
  }

  const inventoryMatch = pathname.match(/^\/players\/([^/]+)\/inventory\/([^/]+)\/(equip|unequip|use)$/);
  if (method === 'POST' && inventoryMatch) {
    const playerId = decodeURIComponent(inventoryMatch[1]);
    const itemRef = decodeURIComponent(inventoryMatch[2]);
    const action = inventoryMatch[3];
    authorizePlayer(playerId);
    let result;
    if (action === 'equip') result = equipPlayerItem(world, playerId, itemRef);
    if (action === 'unequip') result = unequipPlayerItem(world, playerId, itemRef);
    if (action === 'use') result = usePlayerItem(world, playerId, itemRef);
    return response(200, result, playerId, { type: `inventory.${action}`, playerId, itemRef });
  }

  const unequipSlotMatch = pathname.match(/^\/players\/([^/]+)\/inventory\/unequip$/);
  if (method === 'POST' && unequipSlotMatch) {
    const playerId = decodeURIComponent(unequipSlotMatch[1]);
    authorizePlayer(playerId);
    const body = await readBody();
    const itemOrSlot = body.slot || body.itemId || body.itemRef;
    if (!itemOrSlot) throw apiError(400, 'Request body requires slot or itemId');
    const result = unequipPlayerItem(world, playerId, itemOrSlot);
    return response(200, result, playerId, { type: 'inventory.unequip', playerId, itemOrSlot });
  }

  const buyMatch = pathname.match(/^\/players\/([^/]+)\/shop\/buy$/);
  if (method === 'POST' && buyMatch) {
    const playerId = decodeURIComponent(buyMatch[1]);
    authorizePlayer(playerId);
    const body = await readBody();
    required(body, 'shopId');
    if (!body.itemDefinitionId && !body.definitionId) throw apiError(400, 'Request body requires itemDefinitionId');
    const result = buyPlayerItem(world, playerId, body);
    return response(201, result, playerId, { type: 'shop.buy', playerId, shopId: body.shopId, itemDefinitionId: body.itemDefinitionId || body.definitionId });
  }

  const sellMatch = pathname.match(/^\/players\/([^/]+)\/shop\/sell$/);
  if (method === 'POST' && sellMatch) {
    const playerId = decodeURIComponent(sellMatch[1]);
    authorizePlayer(playerId);
    const body = await readBody();
    if (!body.itemId && !body.itemRef && !body.definitionId) throw apiError(400, 'Request body requires itemId');
    const result = sellPlayerItem(world, playerId, body);
    return response(200, result, playerId, { type: 'shop.sell', playerId, itemId: body.itemId || body.itemRef || body.definitionId });
  }

  return null;
}

function response(status, data, playerId = null, event = null) {
  return { status, data, playerId, event };
}

function required(body, key) {
  if (!body || body[key] === undefined || body[key] === null || body[key] === '') throw apiError(400, `Request body requires ${key}`);
  return body[key];
}

function apiError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  dispatchPlayerGameplayApi,
};
