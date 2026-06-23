'use strict';

const OPERATIONAL_TRANSPORT = {
  generation: 0,
  reconnectTimer: null,
  reconnectAttempts: 0,
  closedByUser: false,
};

function connectOperationalWebSocket() {
  OPERATIONAL_TRANSPORT.generation += 1;
  const generation = OPERATIONAL_TRANSPORT.generation;
  OPERATIONAL_TRANSPORT.closedByUser = false;
  if (OPERATIONAL_TRANSPORT.reconnectTimer) clearTimeout(OPERATIONAL_TRANSPORT.reconnectTimer);
  if (S.socket) {
    try { S.socket.close(); } catch (_error) {}
  }

  const token = document.getElementById('tokenBox')?.value?.trim() || S.token || '';
  const query = token ? '?token=' + encodeURIComponent(token) : '';
  const url = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws/ticks' + query;
  const socket = new WebSocket(url);
  S.socket = socket;

  socket.onopen = () => {
    if (generation !== OPERATIONAL_TRANSPORT.generation) return;
    OPERATIONAL_TRANSPORT.reconnectAttempts = 0;
    status('WebSocket 已连接', true);
    log('WebSocket 已连接');
  };
  socket.onmessage = event => {
    if (generation !== OPERATIONAL_TRANSPORT.generation) return;
    log('ws ' + event.data);
    let payload = null;
    try { payload = JSON.parse(event.data); } catch (_error) {}
    if (payload && [
      'tick',
      'browser.action',
      'player.action',
      'load',
      'offline.queued',
      'runtime.loop.tick',
      'runtime.loop.state',
      'world.template.reset',
    ].includes(payload.type)) {
      scheduleWsRefresh();
    }
  };
  socket.onclose = event => {
    if (generation !== OPERATIONAL_TRANSPORT.generation) return;
    status('WebSocket 已关闭');
    if (!OPERATIONAL_TRANSPORT.closedByUser && token && event.code !== 1000) {
      scheduleOperationalReconnect(generation);
    }
  };
  socket.onerror = () => {
    if (generation === OPERATIONAL_TRANSPORT.generation) status('WebSocket 错误', false);
  };
  return socket;
}

function scheduleOperationalReconnect(generation) {
  if (OPERATIONAL_TRANSPORT.reconnectTimer) clearTimeout(OPERATIONAL_TRANSPORT.reconnectTimer);
  OPERATIONAL_TRANSPORT.reconnectAttempts += 1;
  const delay = Math.min(30000, 1000 * (2 ** Math.min(5, OPERATIONAL_TRANSPORT.reconnectAttempts - 1)));
  log('WebSocket 将在 ' + delay + 'ms 后重连');
  OPERATIONAL_TRANSPORT.reconnectTimer = setTimeout(() => {
    if (
      generation === OPERATIONAL_TRANSPORT.generation
      && !OPERATIONAL_TRANSPORT.closedByUser
      && !document.hidden
      && navigator.onLine !== false
    ) {
      connectOperationalWebSocket();
    }
  }, delay);
}

function disconnectOperationalWebSocket() {
  OPERATIONAL_TRANSPORT.closedByUser = true;
  OPERATIONAL_TRANSPORT.generation += 1;
  if (OPERATIONAL_TRANSPORT.reconnectTimer) clearTimeout(OPERATIONAL_TRANSPORT.reconnectTimer);
  OPERATIONAL_TRANSPORT.reconnectTimer = null;
  if (S.socket) {
    try { S.socket.close(1000, 'client_disconnect'); } catch (_error) {}
    S.socket = null;
  }
}

window.addEventListener('online', () => {
  if (!OPERATIONAL_TRANSPORT.closedByUser && S.token && (!S.socket || S.socket.readyState > 1)) {
    connectOperationalWebSocket();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !OPERATIONAL_TRANSPORT.closedByUser && S.token && (!S.socket || S.socket.readyState > 1)) {
    connectOperationalWebSocket();
  }
});

window.connectWs = connectOperationalWebSocket;
window.disconnectOperationalWebSocket = disconnectOperationalWebSocket;
