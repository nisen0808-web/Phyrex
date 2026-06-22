'use strict';

const CHARACTER_UI = {
  dashboard: null,
  renderingWrapped: false,
};

window.addEventListener('DOMContentLoaded', () => {
  wrapDashboardRenderer();
  bindCharacterButton('createAdditionalCharacterBtn', createAdditionalCharacter);
  bindCharacterButton('observerModeBtn', enterObserverMode);
  document.addEventListener('click', handleCharacterControlClick);
});

function wrapDashboardRenderer() {
  if (CHARACTER_UI.renderingWrapped || typeof window.renderDashboard !== 'function') return;
  const original = window.renderDashboard;
  window.renderDashboard = function renderDashboardWithCharacterControls(dashboard) {
    const result = original(dashboard);
    renderCharacterControls(dashboard);
    return result;
  };
  CHARACTER_UI.renderingWrapped = true;
}

function bindCharacterButton(id, handler) {
  document.getElementById(id)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      notifyCharacterError(error);
    } finally {
      button.disabled = false;
    }
  });
}

async function handleCharacterControlClick(event) {
  const switchButton = event.target.closest('[data-switch-character]');
  if (switchButton) {
    event.preventDefault();
    switchButton.disabled = true;
    try {
      await window.runGameAction({
        type: 'switch_character',
        entityId: switchButton.dataset.switchCharacter,
      }, { advance: false });
      notifyCharacter('已切换当前角色', true);
    } catch (error) {
      notifyCharacterError(error);
    } finally {
      switchButton.disabled = false;
    }
    return;
  }

  const playerButton = event.target.closest('[data-select-player]');
  if (playerButton) {
    event.preventDefault();
    const playerId = playerButton.dataset.selectPlayer;
    const input = document.getElementById('playerId');
    if (input) input.value = playerId;
    localStorage.setItem('mud_player_id', playerId);
    try {
      await window.loadDashboard();
      notifyCharacter('已切换账号玩家：' + playerId, true);
    } catch (error) {
      notifyCharacterError(error);
    }
  }
}

async function createAdditionalCharacter() {
  const playerId = valueOfCharacter('playerId');
  if (!playerId) throw new Error('请先选择玩家');
  const entityId = valueOfCharacter('newCharacterId');
  const name = valueOfCharacter('newCharacterName');
  const locationId = valueOfCharacter('newCharacterLocation') || CHARACTER_UI.dashboard?.map?.currentLocationId;
  const species = valueOfCharacter('newCharacterSpecies') || 'human';
  const active = Boolean(document.getElementById('newCharacterActive')?.checked);
  if (!entityId) throw new Error('请输入新角色 ID');
  if (!name) throw new Error('请输入新角色名');
  if (!locationId) throw new Error('请选择出生地点');

  const response = await window.runGameAction({
    type: 'create_character',
    character: {
      id: entityId,
      name,
      species,
      locationId,
      active,
    },
  }, { advance: false });

  const nextIndex = Number(localStorage.getItem('mud_character_counter') || 1) + 1;
  localStorage.setItem('mud_character_counter', String(nextIndex));
  setCharacterValue('newCharacterId', playerId + '_character_' + nextIndex);
  setCharacterValue('newCharacterName', '角色 ' + nextIndex);
  notifyCharacter(active ? '新角色已创建并切换' : '新角色已创建', true);
  return response;
}

async function enterObserverMode() {
  const locationId = valueOfCharacter('observerLocationId') || CHARACTER_UI.dashboard?.map?.currentLocationId || null;
  const response = await window.runGameAction({
    type: 'observer_mode',
    locationId,
  }, { advance: false });
  notifyCharacter('已进入观察者模式', true);
  return response;
}

function renderCharacterControls(dashboard) {
  CHARACTER_UI.dashboard = dashboard || null;
  if (!dashboard) return;
  renderAccountPlayers(dashboard.account);
  renderControlledCharacters(dashboard.player);
  renderControlMode(dashboard.player, dashboard.map);
  populateLocationSelects(dashboard.map);
}

function renderAccountPlayers(account) {
  const container = document.getElementById('accountPlayersPanel');
  if (!container) return;
  const players = account?.players || [];
  if (!players.length) {
    container.innerHTML = '<div class="empty">当前账号尚未绑定玩家</div>';
    return;
  }
  const currentPlayerId = valueOfCharacter('playerId');
  container.innerHTML = players.map(player => {
    const active = player.id === currentPlayerId;
    return '<div class="character-control-row ' + (active ? 'active' : '') + '">' +
      '<div><strong>' + escapeCharacter(player.name || player.id) + '</strong>' +
      '<small>' + escapeCharacter(player.id) + ' · ' + escapeCharacter(player.status || 'unknown') + '</small></div>' +
      (active ? '<span class="badge">当前玩家</span>' : '<button class="small" data-select-player="' + attributeCharacter(player.id) + '">选择</button>') +
      '</div>';
  }).join('');
}

function renderControlledCharacters(playerView) {
  const container = document.getElementById('controlledCharactersPanel');
  if (!container) return;
  const player = playerView?.player || {};
  const entities = playerView?.controlledEntities || [];
  if (!entities.length) {
    container.innerHTML = '<div class="empty">当前玩家没有受控角色</div>';
    return;
  }
  container.innerHTML = entities.map(entity => {
    const active = entity.id === player.activeEntityId && player.controlMode === 'character';
    return '<div class="character-control-row ' + (active ? 'active' : '') + '">' +
      '<div><strong>' + escapeCharacter(entity.name || entity.id) + '</strong>' +
      '<small>' + escapeCharacter(entity.species || 'unknown') + ' · ' + escapeCharacter(entity.locationId || '-') +
      ' · power ' + escapeCharacter(entity.stats?.power ?? 0) + ' · ' + escapeCharacter(entity.status || 'unknown') + '</small></div>' +
      (active ? '<span class="badge">当前角色</span>' : '<button class="small" data-switch-character="' + attributeCharacter(entity.id) + '">切换</button>') +
      '</div>';
  }).join('');
}

function renderControlMode(playerView, map) {
  const container = document.getElementById('controlModePanel');
  if (!container) return;
  const player = playerView?.player || {};
  const observing = player.controlMode === 'observer';
  container.innerHTML = '<div class="mini-card"><strong>控制状态</strong>' +
    '<div class="badge-row"><span class="badge">' + escapeCharacter(player.controlMode || 'unknown') + '</span>' +
    '<span class="badge">' + escapeCharacter(player.status || 'unknown') + '</span>' +
    '<span class="badge">受控角色 ' + escapeCharacter((player.controlledEntityIds || []).length) + '</span></div>' +
    '<small>' + (observing ? '观察地点：' + escapeCharacter(map?.current?.name || map?.currentLocationId || '-') : '当前角色：' + escapeCharacter(player.activeEntityId || '-')) + '</small></div>';
}

function populateLocationSelects(map) {
  const current = map?.current;
  const locations = [];
  if (current?.id) locations.push({ id: current.id, name: current.name || current.id });
  for (const neighbor of current?.neighbors || []) {
    if (!locations.some(location => location.id === neighbor.id)) locations.push({ id: neighbor.id, name: neighbor.name || neighbor.id });
  }
  for (const id of ['newCharacterLocation', 'observerLocationId']) {
    const select = document.getElementById(id);
    if (!select || !locations.length) continue;
    const previous = select.value;
    select.innerHTML = locations.map(location => '<option value="' + attributeCharacter(location.id) + '">' + escapeCharacter(location.name) + '</option>').join('');
    if (locations.some(location => location.id === previous)) select.value = previous;
    else if (current?.id) select.value = current.id;
  }
}

function notifyCharacter(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log(message);
}

function notifyCharacterError(error) {
  if (typeof window.showError === 'function') window.showError(error);
  else notifyCharacter(error?.message || String(error), false);
}

function valueOfCharacter(id) {
  return document.getElementById(id)?.value?.trim() || '';
}

function setCharacterValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.value = value;
}

function escapeCharacter(value) {
  return String(value).replace(/[&<>"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributeCharacter(value) {
  return escapeCharacter(value).replace(/'/g, '&#39;');
}
