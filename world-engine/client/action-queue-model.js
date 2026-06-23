'use strict';

(function exposeActionQueueModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MudActionQueue = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const ITEM_STATUSES = ['pending', 'running', 'done', 'failed'];
  const COMMAND_TYPES = ['work', 'train', 'gather', 'rest'];
  const ACTION_TYPES = [...COMMAND_TYPES, 'explore', 'move'];

  function buildAction(input = {}) {
    const type = String(input.type || '').trim();
    if (!ACTION_TYPES.includes(type)) throw new Error(`Unsupported queue action ${type || '(empty)'}`);

    if (COMMAND_TYPES.includes(type)) {
      const command = {
        type,
        amount: positiveNumber(input.amount, 1),
      };
      if (type === 'work' || type === 'gather') {
        command.resource = String(input.argument || input.resource || (type === 'gather' ? 'wood' : 'currency')).trim();
      }
      return { type: 'command', command };
    }

    if (type === 'move') {
      const locationId = String(input.argument || input.locationId || '').trim();
      if (!locationId) throw new Error('Move action requires locationId');
      return { type: 'move', locationId };
    }

    return { type: 'explore' };
  }

  function createQueueItem(input = {}, options = {}) {
    const action = input.action ? clone(input.action) : buildAction(input);
    const repeat = positiveInteger(input.repeat, 1, 99);
    return {
      id: String(input.id || createId(options.now)),
      label: String(input.label || describeAction(action)),
      action,
      repeat,
      completed: clampInteger(input.completed, 0, repeat, 0),
      attempts: Math.max(0, Number(input.attempts || 0)),
      status: normalizeStatus(input.status),
      error: input.error ? String(input.error) : null,
      createdAt: input.createdAt || new Date(options.now || Date.now()).toISOString(),
      updatedAt: input.updatedAt || null,
    };
  }

  function normalizeQueue(items) {
    if (!Array.isArray(items)) return [];
    return items.map((input, index) => {
      const item = createQueueItem({
        ...input,
        id: input?.id || `queue_recovered_${index + 1}`,
      });
      if (item.status === 'running') item.status = 'pending';
      if (item.completed >= item.repeat) item.status = 'done';
      if (item.status === 'done' && item.completed < item.repeat) item.status = 'pending';
      return item;
    });
  }

  function nextRunnableIndex(items) {
    return (items || []).findIndex(item => item.status === 'pending' && Number(item.completed || 0) < Number(item.repeat || 1));
  }

  function markRunning(items, index, now = Date.now()) {
    const item = requireItem(items, index);
    item.status = 'running';
    item.error = null;
    item.updatedAt = new Date(now).toISOString();
    return item;
  }

  function markSuccess(items, index, now = Date.now()) {
    const item = requireItem(items, index);
    item.completed = Math.min(item.repeat, Number(item.completed || 0) + 1);
    item.attempts = Number(item.attempts || 0) + 1;
    item.status = item.completed >= item.repeat ? 'done' : 'pending';
    item.error = null;
    item.updatedAt = new Date(now).toISOString();
    return item;
  }

  function markFailure(items, index, error, now = Date.now()) {
    const item = requireItem(items, index);
    item.attempts = Number(item.attempts || 0) + 1;
    item.status = 'failed';
    item.error = error?.message || String(error || 'action_failed');
    item.updatedAt = new Date(now).toISOString();
    return item;
  }

  function retryItem(items, index) {
    const item = requireItem(items, index);
    if (item.completed >= item.repeat) return item;
    item.status = 'pending';
    item.error = null;
    return item;
  }

  function summarizeQueue(items) {
    const summary = {
      items: 0,
      pending: 0,
      running: 0,
      done: 0,
      failed: 0,
      totalRuns: 0,
      completedRuns: 0,
    };
    for (const item of items || []) {
      summary.items += 1;
      const status = normalizeStatus(item.status);
      summary[status] += 1;
      summary.totalRuns += Math.max(1, Number(item.repeat || 1));
      summary.completedRuns += Math.max(0, Number(item.completed || 0));
    }
    return summary;
  }

  function describeAction(action = {}) {
    if (action.type === 'explore') return '探索当前地点';
    if (action.type === 'move') return `移动到 ${action.locationId || '-'}`;
    if (action.type === 'command') {
      const command = action.command || {};
      const names = { work: '工作', train: '修炼', gather: '采集', rest: '休息' };
      const target = command.resource ? ` ${command.resource}` : '';
      const amount = Number(command.amount || 1) !== 1 ? ` ×${command.amount}` : '';
      return `${names[command.type] || command.type || '命令'}${target}${amount}`;
    }
    return String(action.type || '未知动作');
  }

  function normalizeStatus(value) {
    return ITEM_STATUSES.includes(value) ? value : 'pending';
  }

  function requireItem(items, index) {
    if (!Array.isArray(items) || !items[index]) throw new Error(`Missing queue item at index ${index}`);
    return items[index];
  }

  function positiveInteger(value, fallback, max) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 1) return fallback;
    return Math.min(max, number);
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function clampInteger(value, min, max, fallback) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number)) return fallback;
    return Math.max(min, Math.min(max, number));
  }

  function createId(now = Date.now()) {
    return `queue_${Number(now)}_${Math.random().toString(16).slice(2, 10)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  return {
    ACTION_TYPES,
    COMMAND_TYPES,
    ITEM_STATUSES,
    buildAction,
    createQueueItem,
    normalizeQueue,
    nextRunnableIndex,
    markRunning,
    markSuccess,
    markFailure,
    retryItem,
    summarizeQueue,
    describeAction,
  };
}));
