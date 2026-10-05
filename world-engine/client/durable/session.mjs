// No token is stored in browser storage, URLs, errors or receipts. Only an
// unacknowledged command is kept in this tab so reload/reconnect can reuse its ID.
export class ConsoleError extends Error {
  constructor(code, status = 0, retryAfter = 0) { super(code); this.code = code; this.status = status; this.retryAfter = retryAfter; }
}
export class ConsoleSession {
  #auth = null;
  #generation = 0;
  #controllers = new Set();
  #busy = false;
  #pending = null;
  #storage;
  #fetch;
  #uuid;
  #timeout;
  constructor({ storage, fetcher = (...args) => globalThis.fetch(...args), uuid = () => crypto.randomUUID(), timeout = 20000 } = {}) {
    this.#storage = storage; this.#fetch = fetcher; this.#uuid = uuid; this.#timeout = timeout;
  }
  get connected() { return this.#auth !== null; }
  get pending() { return this.#pending ? JSON.parse(this.#pending) : null; }
  get busy() { return this.#busy; }
  get scope() { return this.#auth ? { worldId: this.#auth.worldId, playerId: this.#auth.playerId } : null; }
  get #key() { return `phyrex.pending.v1:${JSON.stringify([this.#auth.worldId, this.#auth.playerId])}`; }
  connect(worldId, playerId, token) {
    this.disconnect();
    if (![worldId, playerId, token].every(v => typeof v === 'string' && v.trim() && v.length <= 4096) || /\s/.test(token)) throw new ConsoleError('invalid_login');
    this.#auth = { worldId: worldId.trim(), playerId: playerId.trim(), token };
    try {
      const saved = this.#storage?.getItem(this.#key);
      if (saved) {
        const value = JSON.parse(saved);
        if (saved.length > 8192 || typeof value.id !== 'string' || typeof value.type !== 'string' || !value.payload || typeof value.payload !== 'object') throw new Error();
        this.#pending = saved;
      }
    } catch { this.disconnect(); throw new ConsoleError('pending_storage_unavailable'); }
  }
  disconnect() {
    this.#generation++;
    this.#auth = null; this.#pending = null; this.#busy = false;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }
  async request(suffix, { body, method = 'GET' } = {}) {
    if (!this.#auth) throw new ConsoleError('auth_required', 401);
    const auth = this.#auth, generation = this.#generation, controller = new AbortController();
    this.#controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await this.#fetch(`/durable/worlds/${encodeURIComponent(auth.worldId)}${suffix}`, {
        method, signal: controller.signal, credentials: 'omit', mode: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { Authorization: `Bearer ${auth.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body } : {}),
      });
      if (generation !== this.#generation) throw new ConsoleError('session_changed');
      if (response.status === 401) { this.disconnect(); throw new ConsoleError('auth_required', 401); }
      const json = await response.json();
      if (generation !== this.#generation) throw new ConsoleError('session_changed');
      if (!response.ok || json.ok !== true) throw new ConsoleError(typeof json.error === 'string' ? json.error : 'request_failed', response.status, Number(response.headers.get('Retry-After')) || 0);
      return json.data;
    } catch (error) {
      if (error instanceof ConsoleError) throw error;
      throw new ConsoleError(generation !== this.#generation ? 'session_changed' : 'connection_unknown');
    } finally { clearTimeout(timeout); this.#controllers.delete(controller); }
  }
  playerPath(suffix) {
    if (!this.#auth) throw new ConsoleError('auth_required', 401);
    return `/players/${encodeURIComponent(this.#auth.playerId)}${suffix}`;
  }
  state() { return this.request(this.playerPath('/state')); }
  history(before = null) { return this.request(this.playerPath(`/commands?limit=20${before ? `&beforeSequence=${encodeURIComponent(before)}` : ''}`)); }
  receipt(id) { return this.request(`/commands/${encodeURIComponent(id)}`); }
  async submit(type, payload = {}) {
    if (!this.#auth) throw new ConsoleError('auth_required', 401);
    if (this.#busy) throw new ConsoleError('submission_busy');
    if (type !== undefined) {
      if (this.#pending) throw new ConsoleError('pending_confirmation');
      const pending = JSON.stringify({ id: `web-${this.#uuid()}`, type, payload });
      // Persist before sending. If this fails, no network write is attempted.
      try { if (!this.#storage) throw new Error(); this.#storage.setItem(this.#key, pending); }
      catch { throw new ConsoleError('pending_storage_unavailable'); }
      this.#pending = pending;
    }
    if (!this.#pending) throw new ConsoleError('no_pending_command');
    const pending = this.#pending, id = JSON.parse(pending).id, generation = this.#generation;
    this.#busy = true;
    try {
      const result = await this.request(this.playerPath('/commands'), { method: 'POST', body: pending });
      if (!result || result.id !== id || result.worldId !== this.#auth.worldId || result.playerId !== this.#auth.playerId || !['pending', 'applied'].includes(result.status)) throw new ConsoleError('connection_unknown');
      // A receipt confirms acceptance, not domain success. Rejected domain
      // outcomes remain visible and are never automatically sent as new intents.
      this.#storage.removeItem(this.#key); this.#pending = null;
      return result;
    } finally { if (generation === this.#generation) this.#busy = false; }
  }
}
