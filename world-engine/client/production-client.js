'use strict';

const PRODUCTION_CLIENT = {
  detected: false,
  ready: null,
  nativeFetch: window.fetch.bind(window),
  NativeWebSocket: window.WebSocket,
};

installProductionFetchBridge();
installProductionWebSocketBridge();

window.addEventListener('DOMContentLoaded', () => {
  mountProductionSessionControls();
  detectProductionServer().catch(() => {});
});

function mountProductionSessionControls() {
  if (document.getElementById('accountSecret')) return;
  const accountSection = document.getElementById('accountId')?.closest('.panel');
  const grid = accountSection?.querySelector('.grid');
  if (!accountSection || !grid) return;

  const label = document.createElement('label');
  label.className = 'production-secret-label';
  label.innerHTML = '登录密钥<input id="accountSecret" type="password" autocomplete="current-password" minlength="12" maxlength="256" placeholder="正式模式至少 12 位" />';
  grid.appendChild(label);
  grid.classList.remove('two');
  grid.classList.add('three');

  const actions = accountSection.querySelector('.actions');
  const logout = document.createElement('button');
  logout.id = 'logoutSessionBtn';
  logout.type = 'button';
  logout.textContent = '退出 Session';
  logout.addEventListener('click', revokeCurrentSession);
  actions?.appendChild(logout);

  const notice = document.createElement('p');
  notice.id = 'productionSecurityNotice';
  notice.className = 'hint production-security-notice';
  notice.textContent = '本地开发模式：登录密钥可留空。';
  accountSection.appendChild(notice);
}

async function detectProductionServer() {
  const response = await PRODUCTION_CLIENT.nativeFetch('/ready', {
    headers: { Accept: 'application/json' },
  });
  if (response.status === 404) return null;
  const payload = await response.json();
  PRODUCTION_CLIENT.detected = true;
  PRODUCTION_CLIENT.ready = payload;
  document.body.dataset.production = 'true';
  renderProductionSecurityNotice(payload);
  return payload;
}

function renderProductionSecurityNotice(payload) {
  const notice = document.getElementById('productionSecurityNotice');
  if (!notice) return;
  const policy = payload.registrationPolicy || 'admin';
  const policyText = {
    open: '允许公开注册，所有新账号强制为 player。',
    admin: '仅 GM/admin 可创建账号。',
    disabled: '已关闭账号注册。',
  }[policy] || policy;
  notice.textContent = `正式运营模式：登录必须提供密钥；${policyText}`;
  notice.classList.toggle('bad', payload.ready === false);
}

function installProductionFetchBridge() {
  window.fetch = async function productionAwareFetch(input, init = {}) {
    const requestUrl = typeof input === 'string' ? input : input?.url || '';
    const method = String(init.method || (typeof input !== 'string' ? input?.method : '') || 'GET').toUpperCase();
    if (method === 'POST' && isCredentialRoute(requestUrl) && init.body) {
      const secret = document.getElementById('accountSecret')?.value || '';
      try {
        const body = JSON.parse(String(init.body));
        if (!body.secret) body.secret = secret;
        init = { ...init, body: JSON.stringify(body) };
      } catch (_error) {
        // Leave non-JSON requests untouched.
      }
    }
    return PRODUCTION_CLIENT.nativeFetch(input, init);
  };
}

function installProductionWebSocketBridge() {
  if (typeof PRODUCTION_CLIENT.NativeWebSocket !== 'function') return;
  function ProductionWebSocket(url, protocols) {
    const token = document.getElementById('tokenBox')?.value?.trim() || localStorage.getItem('mud_token') || '';
    let nextUrl = String(url || '');
    if (token && /\/ws\/ticks(?:\?|$)/.test(nextUrl)) {
      const parsed = new URL(nextUrl, window.location.href);
      parsed.searchParams.set('token', token);
      nextUrl = parsed.toString();
    }
    return protocols === undefined
      ? new PRODUCTION_CLIENT.NativeWebSocket(nextUrl)
      : new PRODUCTION_CLIENT.NativeWebSocket(nextUrl, protocols);
  }
  ProductionWebSocket.prototype = PRODUCTION_CLIENT.NativeWebSocket.prototype;
  Object.setPrototypeOf(ProductionWebSocket, PRODUCTION_CLIENT.NativeWebSocket);
  for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
    ProductionWebSocket[key] = PRODUCTION_CLIENT.NativeWebSocket[key];
  }
  window.WebSocket = ProductionWebSocket;
}

async function revokeCurrentSession() {
  const tokenBox = document.getElementById('tokenBox');
  const token = tokenBox?.value?.trim() || localStorage.getItem('mud_token') || '';
  if (token) {
    try {
      await PRODUCTION_CLIENT.nativeFetch('/sessions/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason: 'browser_logout' }),
      });
    } catch (_error) {
      // Local state is still cleared if the service is unavailable.
    }
  }
  if (tokenBox) tokenBox.value = '';
  localStorage.removeItem('mud_token');
  if (typeof window.status === 'function') window.status('已退出 Session');
  if (typeof window.toast === 'function') window.toast('Session 已退出', true);
  if (window.S && typeof window.S === 'object') window.S.token = '';
}

function isCredentialRoute(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.pathname === '/accounts' || url.pathname === '/sessions' || url.pathname === '/admin/accounts';
  } catch (_error) {
    return false;
  }
}

window.detectProductionServer = detectProductionServer;
window.revokeCurrentSession = revokeCurrentSession;
