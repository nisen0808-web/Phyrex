'use strict';

(function exposeCommandPaletteModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MudCommandPalette = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function normalizeText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[\s/_-]+/g, ' ')
      .trim();
  }

  function tokenize(value) {
    const normalized = normalizeText(value);
    return normalized ? normalized.split(' ').filter(Boolean) : [];
  }

  function createSearchDocument(command = {}) {
    const fields = [
      command.id,
      command.title,
      command.description,
      command.group,
      ...(command.keywords || []),
    ].map(normalizeText).filter(Boolean);
    return {
      id: String(command.id || ''),
      title: normalizeText(command.title),
      fields,
      text: fields.join(' '),
    };
  }

  function scoreCommand(command, query, context = {}) {
    const document = createSearchDocument(command);
    const normalizedQuery = normalizeText(query);
    const tokens = tokenize(normalizedQuery);
    if (!tokens.length) {
      return recencyBoost(command.id, context.recentIds) + favoriteBoost(command.id, context.favoriteIds);
    }
    if (!tokens.every(token => document.text.includes(token))) return Number.NEGATIVE_INFINITY;

    let score = 0;
    if (document.id === normalizedQuery) score += 160;
    if (document.title === normalizedQuery) score += 150;
    if (document.title.startsWith(normalizedQuery)) score += 110;
    if (document.fields.some(field => field.startsWith(normalizedQuery))) score += 90;
    if (document.title.includes(normalizedQuery)) score += 70;
    if (document.fields.some(field => field.includes(normalizedQuery))) score += 50;

    for (const token of tokens) {
      if (document.title === token) score += 35;
      else if (document.title.startsWith(token)) score += 24;
      else if (document.title.includes(token)) score += 16;
      if (document.fields.some(field => field === token)) score += 12;
      else if (document.fields.some(field => field.startsWith(token))) score += 8;
    }

    score += recencyBoost(command.id, context.recentIds);
    score += favoriteBoost(command.id, context.favoriteIds);
    return score;
  }

  function rankCommands(commands, query = '', context = {}) {
    const limit = Math.max(1, Number(context.limit || 12));
    return (commands || [])
      .filter(command => command && command.id && command.hidden !== true)
      .map((command, index) => ({
        command,
        index,
        score: scoreCommand(command, query, context),
      }))
      .filter(entry => Number.isFinite(entry.score))
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        const groupCompare = String(left.command.group || '').localeCompare(String(right.command.group || ''));
        if (groupCompare) return groupCompare;
        return left.index - right.index;
      })
      .slice(0, limit)
      .map(entry => entry.command);
  }

  function recordRecent(recentIds, commandId, maxItems = 8) {
    const id = String(commandId || '').trim();
    if (!id) return sanitizeIdList(recentIds, maxItems);
    return [id, ...sanitizeIdList(recentIds).filter(item => item !== id)].slice(0, Math.max(1, Number(maxItems || 8)));
  }

  function toggleFavorite(favoriteIds, commandId, maxItems = 20) {
    const id = String(commandId || '').trim();
    const current = sanitizeIdList(favoriteIds, maxItems);
    if (!id) return current;
    if (current.includes(id)) return current.filter(item => item !== id);
    return [id, ...current].slice(0, Math.max(1, Number(maxItems || 20)));
  }

  function resolveShortcut(commands, keyboardEvent = {}) {
    if (isEditableTarget(keyboardEvent.target)) return null;
    const key = normalizeShortcutKey(keyboardEvent.key);
    if (!key) return null;
    return (commands || []).find(command => {
      const shortcut = parseShortcut(command.shortcut);
      if (!shortcut) return false;
      return shortcut.key === key
        && shortcut.ctrl === Boolean(keyboardEvent.ctrlKey)
        && shortcut.meta === Boolean(keyboardEvent.metaKey)
        && shortcut.alt === Boolean(keyboardEvent.altKey)
        && shortcut.shift === Boolean(keyboardEvent.shiftKey);
    }) || null;
  }

  function parseShortcut(value) {
    const text = String(value || '').trim().toLocaleLowerCase();
    if (!text) return null;
    const parts = text.split('+').map(part => part.trim()).filter(Boolean);
    const key = normalizeShortcutKey(parts.pop());
    if (!key) return null;
    return {
      key,
      ctrl: parts.includes('ctrl') || parts.includes('control'),
      meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('command'),
      alt: parts.includes('alt') || parts.includes('option'),
      shift: parts.includes('shift'),
    };
  }

  function normalizeShortcutKey(value) {
    const key = String(value || '').toLocaleLowerCase();
    const aliases = {
      ' ': 'space',
      escape: 'esc',
      arrowup: 'up',
      arrowdown: 'down',
      arrowleft: 'left',
      arrowright: 'right',
      return: 'enter',
    };
    return aliases[key] || key;
  }

  function isEditableTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLocaleLowerCase();
    return Boolean(target.isContentEditable || ['input', 'textarea', 'select'].includes(tag));
  }

  function sanitizeIdList(value, maxItems = 100) {
    const output = [];
    for (const item of Array.isArray(value) ? value : []) {
      const id = String(item || '').trim();
      if (id && !output.includes(id)) output.push(id);
      if (output.length >= maxItems) break;
    }
    return output;
  }

  function recencyBoost(commandId, recentIds) {
    const index = sanitizeIdList(recentIds).indexOf(String(commandId || ''));
    return index < 0 ? 0 : Math.max(2, 18 - index * 2);
  }

  function favoriteBoost(commandId, favoriteIds) {
    return sanitizeIdList(favoriteIds).includes(String(commandId || '')) ? 28 : 0;
  }

  return {
    normalizeText,
    tokenize,
    createSearchDocument,
    scoreCommand,
    rankCommands,
    recordRecent,
    toggleFavorite,
    resolveShortcut,
    parseShortcut,
    isEditableTarget,
    sanitizeIdList,
  };
}));
