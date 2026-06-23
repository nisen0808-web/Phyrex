'use strict';

const ACTION_QUEUE_UI = {
  items: [],
  running: false,
  paused: false,
  stopRequested: false,
  delayMs: 250,
  continueOnError: false,
};

window.addEventListener('DOMContentLoaded', () => {
  mountActionQueue();
  restoreActionQueue();
  bindActionQueueControls();
  updateActionQueueBuilder();
  renderActionQueue();
});

function mountActionQueue() {
  if (document.getElementById('actionQueuePanel')) return;
  const anchor = document.querySelector('.character-manager')
    || document.getElementById('characterPanel')?.closest('.panel')
    || document.getElementById('worldMetrics')?.closest('.panel');
  const panel = document.createElement('section');
  panel.id = 'actionQueuePanel';
  panel.className = 'panel wide action-queue-panel';
  panel.innerHTML = [
    '<div class="section-title">',
    '  <div><h2>行动队列 / 回合计划器</h2><p class="hint">把工作、修炼、采集、休息、探索和移动按顺序执行；命令类动作沿用顶部“动作后推进”设置。</p></div>',
    '  <span id="actionQueueStatus" class="action-queue-status idle">idle</span>',
    '</div>',
    '<div class="action-queue-presets">',
    '  <button class="small" data-queue-preset="work">工作 ×3</button>',
    '  <button class="small" data-queue-preset="train">修炼 ×3</button>',
    '  <button class="small" data-queue-preset="gather">采集木材 ×3</button>',
    '  <button class="small" data-queue-preset="rest">休息</button>',
    '  <button class="small" data-queue-preset="explore">探索</button>',
    '</div>',
    '<div class="grid four action-queue-builder">',
    '  <label>动作<select id="queueActionType"><option value="work">work / 工作</option><option value="train">train / 修炼</option><option value="gather">gather / 采集</option><option value="rest">rest / 休息</option><option value="explore">explore / 探索</option><option value="move">move / 移动</option></select></label>',
    '  <label id="queueArgumentLabel">资源 / 地点<input id="queueActionArgument" value="currency" /></label>',
    '  <label>数量<input id="queueActionAmount" type="number" min="1" value="10" /></label>',
    '  <label>重复<input id="queueActionRepeat" type="number" min="1" max="99" value="1" /></label>',
    '</div>',
    '<div class="actions action-queue-options">',
    '  <button id="queueAddBtn" class="primary">加入队列</button>',
    '  <label>步骤间隔<select id="queueDelayMs"><option value="0">无</option><option value="250" selected>250 ms</option><option value="1000">1 秒</option><option value="3000">3 秒</option></select></label>',
    '  <label class="inline-control"><input id="queueContinueOnError" type="checkbox" />出错后继续</label>',
    '</div>',
    '<div class="actions action-queue-run-actions">',
    '  <button id="queueStartBtn" class="primary">开始执行</button>',
    '  <button id="queuePauseBtn">暂停</button>',
    '  <button id="queueRetryFailedBtn">重试失败项</button>',
    '  <button id="queueClearDoneBtn">清除已完成</button>',
    '  <button id="queueResetBtn">全部重来</button>',
    '  <button id="queueClearBtn" class="danger">清空队列</button>',
    '</div>',
    '<div id="actionQueueMetrics" class="metric-grid action-queue-metrics"></div>',
    '<div id="actionQueueList" class="action-queue-list"><div class="empty">队列为空</div></div>',
  ].join('');

  if (anchor?.nextSibling) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
  else document.querySelector('main')?.appendChild(panel);
}

function bindActionQueueControls() {
  document.getElementById('queueActionType')?.addEventListener('change', updateActionQueueBuilder);
  document.getElementById('queueAddBtn')?.addEventListener('click', addActionQueueItemFromForm);
  document.getElementById('queueStartBtn')?.addEventListener('click', () => startActionQueue().catch(renderActionQueueError));
  document.getElementById('queuePauseBtn')?.addEventListener('click', pauseActionQueue);
  document.getElementById('queueRetryFailedBtn')?.addEventListener('click', retryFailedActionQueueItems);
  document.getElementById('queueClearDoneBtn')?.addEventListener('click', clearCompletedActionQueueItems);
  document.getElementById('queueResetBtn')?.addEventListener('click', resetActionQueueItems);
  document.getElementById('queueClearBtn')?.addEventListener('click', clearActionQueue);
  document.getElementById('queueDelayMs')?.addEventListener('change', persistActionQueue);
  document.getElementById('queueContinueOnError')?.addEventListener('change', persistActionQueue);
  document.getElementById('queueActionRepeat')?.addEventListener('keydown', event => {
    if (event.key === 'Enter') addActionQueueItemFromForm();
  });
  document.addEventListener('click', handleActionQueueDelegatedClick);
}

function restoreActionQueue() {
  const model = actionQueueModel();
  try {
    const parsed = JSON.parse(localStorage.getItem('mud_action_queue') || '[]');
    ACTION_QUEUE_UI.items = model.normalizeQueue(parsed);
  } catch (_error) {
    ACTION_QUEUE_UI.items = [];
  }
  ACTION_QUEUE_UI.delayMs = Math.max(0, Number(localStorage.getItem('mud_action_queue_delay') || 250));
  ACTION_QUEUE_UI.continueOnError = localStorage.getItem('mud_action_queue_continue') === 'true';
  const delay = document.getElementById('queueDelayMs');
  if (delay) delay.value = String(ACTION_QUEUE_UI.delayMs);
  const continueBox = document.getElementById('queueContinueOnError');
  if (continueBox) continueBox.checked = ACTION_QUEUE_UI.continueOnError;
}

function persistActionQueue() {
  ACTION_QUEUE_UI.delayMs = Math.max(0, Number(document.getElementById('queueDelayMs')?.value || 0));
  ACTION_QUEUE_UI.continueOnError = Boolean(document.getElementById('queueContinueOnError')?.checked);
  localStorage.setItem('mud_action_queue', JSON.stringify(ACTION_QUEUE_UI.items));
  localStorage.setItem('mud_action_queue_delay', String(ACTION_QUEUE_UI.delayMs));
  localStorage.setItem('mud_action_queue_continue', String(ACTION_QUEUE_UI.continueOnError));
}

function updateActionQueueBuilder() {
  const type = document.getElementById('queueActionType')?.value || 'work';
  const argument = document.getElementById('queueActionArgument');
  const argumentLabel = document.getElementById('queueArgumentLabel');
  const amount = document.getElementById('queueActionAmount');
  if (!argument || !argumentLabel || !amount) return;

  if (type === 'work') {
    argument.disabled = false;
    argument.value = argument.value || 'currency';
    argument.placeholder = 'currency';
    argumentLabel.firstChild.textContent = '资源';
    amount.disabled = false;
    if (Number(amount.value || 0) <= 1) amount.value = '10';
  } else if (type === 'gather') {
    argument.disabled = false;
    argument.value = argument.value === 'currency' || !argument.value ? 'wood' : argument.value;
    argument.placeholder = 'wood';
    argumentLabel.firstChild.textContent = '资源';
    amount.disabled = false;
    if (Number(amount.value || 0) > 5 || Number(amount.value || 0) <= 1) amount.value = '3';
  } else if (type === 'move') {
    argument.disabled = false;
    argument.value = ['currency', 'wood'].includes(argument.value) || !argument.value ? 'mist_forest' : argument.value;
    argument.placeholder = 'mist_forest';
    argumentLabel.firstChild.textContent = '地点 ID';
    amount.disabled = true;
    amount.value = '1';
  } else {
    argument.disabled = true;
    argumentLabel.firstChild.textContent = '资源 / 地点';
    amount.disabled = type === 'explore';
    if (type === 'train' && Number(amount.value || 0) > 5) amount.value = '2';
    if (type === 'rest' || type === 'explore') amount.value = '1';
  }
}

function addActionQueueItemFromForm() {
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('执行中不能修改队列', false);
  const model = actionQueueModel();
  try {
    const item = model.createQueueItem({
      type: document.getElementById('queueActionType')?.value,
      argument: document.getElementById('queueActionArgument')?.value?.trim(),
      amount: Number(document.getElementById('queueActionAmount')?.value || 1),
      repeat: Number(document.getElementById('queueActionRepeat')?.value || 1),
    });
    ACTION_QUEUE_UI.items.push(item);
    persistActionQueue();
    renderActionQueue();
    notifyActionQueue('已加入：' + item.label, true);
  } catch (error) {
    renderActionQueueError(error);
  }
}

function addActionQueuePreset(name) {
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('执行中不能修改队列', false);
  const presets = {
    work: { type: 'work', argument: 'currency', amount: 10, repeat: 3 },
    train: { type: 'train', amount: 2, repeat: 3 },
    gather: { type: 'gather', argument: 'wood', amount: 3, repeat: 3 },
    rest: { type: 'rest', amount: 1, repeat: 1 },
    explore: { type: 'explore', repeat: 1 },
  };
  const preset = presets[name];
  if (!preset) return;
  const item = actionQueueModel().createQueueItem(preset);
  ACTION_QUEUE_UI.items.push(item);
  persistActionQueue();
  renderActionQueue();
  notifyActionQueue('已加入预设：' + item.label, true);
}

async function startActionQueue() {
  const model = actionQueueModel();
  if (ACTION_QUEUE_UI.running) return;
  if (typeof window.runGameAction !== 'function') throw new Error('浏览器玩法动作尚未就绪');
  if (model.nextRunnableIndex(ACTION_QUEUE_UI.items) < 0) {
    const failed = ACTION_QUEUE_UI.items.some(item => item.status === 'failed');
    notifyActionQueue(failed ? '请先重试失败项' : '没有待执行动作', false);
    return;
  }

  ACTION_QUEUE_UI.running = true;
  ACTION_QUEUE_UI.paused = false;
  ACTION_QUEUE_UI.stopRequested = false;
  setActionQueueStatus('running');
  renderActionQueue();

  while (!ACTION_QUEUE_UI.stopRequested) {
    const index = model.nextRunnableIndex(ACTION_QUEUE_UI.items);
    if (index < 0) break;
    const item = model.markRunning(ACTION_QUEUE_UI.items, index);
    persistActionQueue();
    renderActionQueue();
    notifyActionQueue('执行：' + item.label, true);

    try {
      await window.runGameAction(item.action);
      model.markSuccess(ACTION_QUEUE_UI.items, index);
    } catch (error) {
      model.markFailure(ACTION_QUEUE_UI.items, index, error);
      notifyActionQueue(item.label + '失败：' + error.message, false);
      if (!ACTION_QUEUE_UI.continueOnError) {
        ACTION_QUEUE_UI.stopRequested = true;
        ACTION_QUEUE_UI.paused = true;
      }
    }

    persistActionQueue();
    renderActionQueue();
    if (!ACTION_QUEUE_UI.stopRequested && ACTION_QUEUE_UI.delayMs > 0) {
      await waitForActionQueue(ACTION_QUEUE_UI.delayMs);
    }
  }

  ACTION_QUEUE_UI.running = false;
  const summary = model.summarizeQueue(ACTION_QUEUE_UI.items);
  if (ACTION_QUEUE_UI.paused) setActionQueueStatus('paused');
  else if (summary.failed) setActionQueueStatus('attention');
  else if (!summary.pending) setActionQueueStatus('complete');
  else setActionQueueStatus('ready');
  persistActionQueue();
  renderActionQueue();
}

function pauseActionQueue() {
  if (!ACTION_QUEUE_UI.running) return;
  ACTION_QUEUE_UI.stopRequested = true;
  ACTION_QUEUE_UI.paused = true;
  setActionQueueStatus('pausing');
  notifyActionQueue('将在当前动作结束后暂停', true);
}

function retryFailedActionQueueItems() {
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('请先暂停队列', false);
  const model = actionQueueModel();
  let count = 0;
  ACTION_QUEUE_UI.items.forEach((item, index) => {
    if (item.status === 'failed') {
      model.retryItem(ACTION_QUEUE_UI.items, index);
      count += 1;
    }
  });
  persistActionQueue();
  renderActionQueue();
  notifyActionQueue(count ? `已重试 ${count} 项` : '没有失败项', Boolean(count));
}

function clearCompletedActionQueueItems() {
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('请先暂停队列', false);
  ACTION_QUEUE_UI.items = ACTION_QUEUE_UI.items.filter(item => item.status !== 'done');
  persistActionQueue();
  renderActionQueue();
}

function resetActionQueueItems() {
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('请先暂停队列', false);
  ACTION_QUEUE_UI.items = ACTION_QUEUE_UI.items.map(item => ({
    ...item,
    completed: 0,
    attempts: 0,
    status: 'pending',
    error: null,
    updatedAt: null,
  }));
  persistActionQueue();
  renderActionQueue();
  setActionQueueStatus('ready');
}

function clearActionQueue() {
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('请先暂停队列', false);
  const confirmed = typeof window.confirm !== 'function' || window.confirm('清空全部行动队列？');
  if (!confirmed) return;
  ACTION_QUEUE_UI.items = [];
  persistActionQueue();
  renderActionQueue();
  setActionQueueStatus('idle');
}

function handleActionQueueDelegatedClick(event) {
  const preset = event.target.closest('[data-queue-preset]');
  if (preset) {
    event.preventDefault();
    addActionQueuePreset(preset.dataset.queuePreset);
    return;
  }

  const button = event.target.closest('[data-queue-item-action]');
  if (!button) return;
  event.preventDefault();
  if (ACTION_QUEUE_UI.running) return notifyActionQueue('请先暂停队列', false);
  const id = button.dataset.queueId;
  const action = button.dataset.queueItemAction;
  const index = ACTION_QUEUE_UI.items.findIndex(item => item.id === id);
  if (index < 0) return;

  if (action === 'remove') ACTION_QUEUE_UI.items.splice(index, 1);
  if (action === 'up' && index > 0) swapActionQueueItems(index, index - 1);
  if (action === 'down' && index < ACTION_QUEUE_UI.items.length - 1) swapActionQueueItems(index, index + 1);
  if (action === 'retry') actionQueueModel().retryItem(ACTION_QUEUE_UI.items, index);
  persistActionQueue();
  renderActionQueue();
}

function swapActionQueueItems(left, right) {
  const value = ACTION_QUEUE_UI.items[left];
  ACTION_QUEUE_UI.items[left] = ACTION_QUEUE_UI.items[right];
  ACTION_QUEUE_UI.items[right] = value;
}

function renderActionQueue() {
  const model = actionQueueModel();
  const summary = model.summarizeQueue(ACTION_QUEUE_UI.items);
  const metrics = document.getElementById('actionQueueMetrics');
  if (metrics) {
    const values = [
      ['items', summary.items],
      ['pending', summary.pending],
      ['running', summary.running],
      ['done', summary.done],
      ['failed', summary.failed],
      ['runs', `${summary.completedRuns}/${summary.totalRuns}`],
    ];
    metrics.innerHTML = values.map(([label, value]) => (
      '<div class="metric"><strong>' + escapeActionQueue(value) + '</strong><span>' + escapeActionQueue(label) + '</span></div>'
    )).join('');
  }

  const list = document.getElementById('actionQueueList');
  if (list) {
    if (!ACTION_QUEUE_UI.items.length) {
      list.innerHTML = '<div class="empty">队列为空；可使用预设或表单添加动作。</div>';
    } else {
      list.innerHTML = ACTION_QUEUE_UI.items.map((item, index) => renderActionQueueItem(item, index)).join('');
    }
  }

  const start = document.getElementById('queueStartBtn');
  const pause = document.getElementById('queuePauseBtn');
  if (start) {
    start.disabled = ACTION_QUEUE_UI.running || summary.pending === 0;
    start.textContent = ACTION_QUEUE_UI.paused ? '继续执行' : '开始执行';
  }
  if (pause) pause.disabled = !ACTION_QUEUE_UI.running;
}

function renderActionQueueItem(item, index) {
  const statusLabels = { pending: '等待', running: '执行中', done: '完成', failed: '失败' };
  const progress = Math.max(0, Math.min(100, Math.round(Number(item.completed || 0) / Math.max(1, Number(item.repeat || 1)) * 100)));
  const retry = item.status === 'failed'
    ? '<button class="small" data-queue-item-action="retry" data-queue-id="' + attributeActionQueue(item.id) + '">重试</button>'
    : '';
  return '<div class="action-queue-item ' + escapeActionQueue(item.status) + '">' +
    '<div class="action-queue-index">' + (index + 1) + '</div>' +
    '<div class="action-queue-main"><div class="action-queue-title"><strong>' + escapeActionQueue(item.label) + '</strong>' +
    '<span class="action-queue-badge ' + escapeActionQueue(item.status) + '">' + escapeActionQueue(statusLabels[item.status] || item.status) + '</span></div>' +
    '<small>进度 ' + escapeActionQueue(item.completed) + '/' + escapeActionQueue(item.repeat) + ' · 尝试 ' + escapeActionQueue(item.attempts || 0) + '</small>' +
    '<div class="progress"><i style="width:' + progress + '%"></i></div>' +
    (item.error ? '<div class="action-queue-error">' + escapeActionQueue(item.error) + '</div>' : '') +
    '</div><div class="action-queue-item-actions">' +
    '<button class="small" data-queue-item-action="up" data-queue-id="' + attributeActionQueue(item.id) + '"' + (index === 0 ? ' disabled' : '') + '>上移</button>' +
    '<button class="small" data-queue-item-action="down" data-queue-id="' + attributeActionQueue(item.id) + '"' + (index === ACTION_QUEUE_UI.items.length - 1 ? ' disabled' : '') + '>下移</button>' +
    retry +
    '<button class="small danger" data-queue-item-action="remove" data-queue-id="' + attributeActionQueue(item.id) + '">移除</button>' +
    '</div></div>';
}

function setActionQueueStatus(state) {
  const badge = document.getElementById('actionQueueStatus');
  if (!badge) return;
  badge.textContent = state;
  badge.className = 'action-queue-status ' + state;
}

function renderActionQueueError(error) {
  setActionQueueStatus('error');
  notifyActionQueue(error?.message || String(error), false);
}

function actionQueueModel() {
  if (!window.MudActionQueue) throw new Error('行动队列模型未加载');
  return window.MudActionQueue;
}

function notifyActionQueue(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log('行动队列：' + message);
}

function waitForActionQueue(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(milliseconds || 0))));
}

function escapeActionQueue(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributeActionQueue(value) {
  return escapeActionQueue(value).replace(/'/g, '&#39;');
}

window.startActionQueue = startActionQueue;
window.renderActionQueue = renderActionQueue;
