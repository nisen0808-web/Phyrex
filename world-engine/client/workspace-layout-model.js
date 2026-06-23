'use strict';

(function exposeWorkspaceLayoutModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MudWorkspaceLayout = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function createPanelKey(input = {}, fallbackIndex = 0) {
    const source = input.id || input.title || input.label || `panel-${fallbackIndex + 1}`;
    const normalized = String(source || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || `panel-${fallbackIndex + 1}`;
  }

  function normalizeWorkspaceState(input = {}) {
    return {
      collapsed: sanitizeIds(input.collapsed),
      pinned: sanitizeIds(input.pinned),
      compact: Boolean(input.compact),
      navigatorOpen: Boolean(input.navigatorOpen),
    };
  }

  function toggleId(items, id, enabled = null) {
    const key = String(id || '').trim();
    const current = sanitizeIds(items);
    if (!key) return current;
    const has = current.includes(key);
    const nextEnabled = enabled === null ? !has : Boolean(enabled);
    if (nextEnabled && !has) return [...current, key];
    if (!nextEnabled && has) return current.filter(item => item !== key);
    return current;
  }

  function sortPanels(panels, pinnedIds = []) {
    const pinned = new Set(sanitizeIds(pinnedIds));
    return (panels || []).map((panel, index) => ({ ...panel, index }))
      .sort((left, right) => {
        const leftPinned = pinned.has(left.key);
        const rightPinned = pinned.has(right.key);
        if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
        return left.index - right.index;
      });
  }

  function filterPanels(panels, query = '') {
    const normalized = normalizeText(query);
    if (!normalized) return [...(panels || [])];
    const tokens = normalized.split(' ').filter(Boolean);
    return (panels || []).filter(panel => {
      const text = normalizeText([panel.key, panel.title, panel.description].join(' '));
      return tokens.every(token => text.includes(token));
    });
  }

  function sanitizeIds(value, limit = 200) {
    const output = [];
    for (const item of Array.isArray(value) ? value : []) {
      const id = String(item || '').trim();
      if (id && !output.includes(id)) output.push(id);
      if (output.length >= limit) break;
    }
    return output;
  }

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\s/_-]+/g, ' ')
      .trim();
  }

  return {
    createPanelKey,
    normalizeWorkspaceState,
    toggleId,
    sortPanels,
    filterPanels,
    sanitizeIds,
    normalizeText,
  };
}));
