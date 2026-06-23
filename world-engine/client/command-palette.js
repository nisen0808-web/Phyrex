'use strict';

const COMMAND_PALETTE_UI = {
  open: false,
  busy: false,
  selectedIndex: 0,
  results: [],
  recentIds: [],
  favoriteIds: [],
  hotkeysEnabled: true,
  commands: [],
};

window.addEventListener('DOMContentLoaded', () => {
  mountCommandPalette();
  restoreCommandPaletteState();
  COMMAND_PALETTE_UI.commands = buildCommandPaletteCommands();
  bindCommandPaletteControls();
  renderCommandPalette();
});

function mountCommandPalette() {
  if (document.getElementById('commandPaletteOverlay')) return;

  const button = document.createElement('button');
  button.id = 'commandPaletteOpenBtn';
  button.className = 'command-palette-open';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = '<span>命令</span><kbd>Ctrl K</kbd>';
  document.querySelector('.top-actions')?.prepend(button);

  const overlay = document.createElement('div');
  overlay.id = 'commandPaletteOverlay';
  overlay.className = 'command-palette-overlay';
  overlay.hidden = true;
  overlay.innerHTML = [
    '<section class="command-palette-dialog" role="dialog" aria-modal="true" aria-labelledby="commandPaletteTitle">',
    '  <header class="command-palette-header">',
    '    <div><h2 id="commandPaletteTitle">命令面板</h2><p>搜索玩法动作、页面导航和本地运维命令。</p></div>',
    '    <button id="commandPaletteCloseBtn" class="command-palette-close" aria-label="关闭命令面板">×</button>',
    '  </header>',
    '  <div class="command-palette-search-wrap">',
    '    <span aria-hidden="true">⌕</span>',
    '    <input id="commandPaletteSearch" type="search" autocomplete="off" placeholder="输入命令，例如：探索、save、队列" role="combobox" aria-expanded="true" aria-controls="commandPaletteResults" />',
    '    <kbd>Esc</kbd>',
    '  </div>',
    '  <div class="command-palette-toolbar">',
    '    <div id="commandPaletteContext" class="command-palette-context"></div>',
    '    <label class="inline-control"><input id="commandPaletteHotkeys" type="checkbox" checked />启用单键快捷操作</label>',
    '  </div>',
    '  <div id="commandPaletteResults" class="command-palette-results" role="listbox"></div>',
    '  <footer class="command-palette-footer">',
    '    <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>',
    '    <span><kbd>Enter</kbd> 执行</span>',
    '    <span><kbd>★</kbd> 收藏</span>',
    '    <span><kbd>/</kbd> 打开</span>',
    '  </footer>',
    '</section>',
  ].join('');
  document.body.appendChild(overlay);
}

function restoreCommandPaletteState() {
  const model = commandPaletteModel();
  COMMAND_PALETTE_UI.recentIds = parseCommandIdList('mud_command_palette_recent', model);
  COMMAND_PALETTE_UI.favoriteIds = parseCommandIdList('mud_command_palette_favorites', model);
  COMMAND_PALETTE_UI.hotkeysEnabled = localStorage.getItem('mud_command_palette_hotkeys') !== 'false';
  const checkbox = document.getElementById('commandPaletteHotkeys');
  if (checkbox) checkbox.checked = COMMAND_PALETTE_UI.hotkeysEnabled;
}

function parseCommandIdList(key, model) {
  try {
    return model.sanitizeIdList(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch (_error) {
    return [];
  }
}

function persistCommandPaletteState() {
  localStorage.setItem('mud_command_palette_recent', JSON.stringify(COMMAND_PALETTE_UI.recentIds));
  localStorage.setItem('mud_command_palette_favorites', JSON.stringify(COMMAND_PALETTE_UI.favoriteIds));
  localStorage.setItem('mud_command_palette_hotkeys', String(COMMAND_PALETTE_UI.hotkeysEnabled));
}

function bindCommandPaletteControls() {
  document.getElementById('commandPaletteOpenBtn')?.addEventListener('click', openCommandPalette);
  document.getElementById('commandPaletteCloseBtn')?.addEventListener('click', closeCommandPalette);
  document.getElementById('commandPaletteOverlay')?.addEventListener('click', event => {
    if (event.target.id === 'commandPaletteOverlay') closeCommandPalette();
  });
  document.getElementById('commandPaletteSearch')?.addEventListener('input', () => {
    COMMAND_PALETTE_UI.selectedIndex = 0;
    renderCommandPalette();
  });
  document.getElementById('commandPaletteHotkeys')?.addEventListener('change', event => {
    COMMAND_PALETTE_UI.hotkeysEnabled = Boolean(event.target.checked);
    persistCommandPaletteState();
  });
  document.getElementById('commandPaletteResults')?.addEventListener('click', handleCommandPaletteResultClick);
  document.addEventListener('keydown', handleCommandPaletteKeydown);
}

function buildCommandPaletteCommands() {
  return [
    command('explore', '探索当前地点', '在当前地点触发一次探索。', '玩法动作', ['explore', '探索', '冒险'], 'e', () => runPaletteGameAction({ type: 'explore' })),
    command('work', '工作赚取货币', '提交 work 命令，默认产出 currency 10。', '玩法动作', ['work', '工作', 'currency', '金币'], 'w', () => runPaletteGameAction({ type: 'command', command: { type: 'work', resource: 'currency', amount: 10 } })),
    command('train', '修炼', '提交 train 命令，训练量为 2。', '玩法动作', ['train', '修炼', '训练'], 't', () => runPaletteGameAction({ type: 'command', command: { type: 'train', amount: 2 } })),
    command('gather', '采集木材', '提交 gather 命令，采集 wood 3。', '玩法动作', ['gather', '采集', 'wood', '木材'], 'g', () => runPaletteGameAction({ type: 'command', command: { type: 'gather', resource: 'wood', amount: 3 } })),
    command('rest', '休息', '提交 rest 命令恢复角色状态。', '玩法动作', ['rest', '休息', '恢复'], 'r', () => runPaletteGameAction({ type: 'command', command: { type: 'rest', amount: 1 } })),
    command('claim-all', '领取全部任务奖励', '领取所有已完成任务的奖励。', '玩法动作', ['claim', '任务', '奖励', '领取'], 'c', () => runPaletteGameAction({ type: 'claim_all_quests' }, { advance: false })),
    command('quick-start', '一键开始冒险', '创建本地账号、Session、玩家与新手资源。', '会话', ['quick start', '开始', '初始化', '账号'], '', () => callPaletteFunction('quickStart')),
    command('connect-events', '连接实时事件', '连接 WebSocket 世界事件流。', '会话', ['websocket', '连接', 'events', '实时'], '', () => callPaletteFunction('connectWs')),
    command('refresh-all', '刷新全部面板', '重新读取世界和当前玩家面板。', '页面', ['refresh', '刷新', 'reload'], 'f', () => callPaletteFunction('refreshAll')),
    command('show-map', '定位到地图', '滚动到当前地图面板。', '页面', ['map', '地图', '地点'], 'm', () => scrollPaletteTo('mapPanel')),
    command('show-inventory', '定位到背包', '滚动到背包与装备面板。', '页面', ['inventory', '背包', '装备'], 'i', () => scrollPaletteTo('inventoryPanel')),
    command('show-quests', '定位到任务', '滚动到任务面板。', '页面', ['quests', '任务', '委托'], '', () => scrollPaletteTo('questPanel')),
    command('show-shop', '定位到商店', '滚动到当前地点商店。', '页面', ['shop', '商店', '购买'], '', () => scrollPaletteTo('shopPanel')),
    command('show-journal', '定位到日志', '滚动到角色日志与事件。', '页面', ['journal', '日志', '事件'], 'j', () => scrollPaletteTo('journalPanel')),
    command('show-characters', '定位到多角色控制', '滚动到角色切换和观察者模式。', '页面', ['character', '角色', '切换', '观察'], '', () => scrollPaletteTo('controlModePanel')),
    command('show-action-queue', '定位到行动队列', '滚动到回合计划器。', '自动化', ['queue', '队列', '计划', 'planner'], 'p', () => scrollPaletteTo('actionQueuePanel')),
    command('start-action-queue', '开始行动队列', '执行当前待处理的行动计划。', '自动化', ['queue start', '队列执行', '自动'], '', () => callPaletteFunction('startActionQueue')),
    command('show-save-manager', '定位到存档管理', '滚动到本地存档列表。', '存档', ['save', '存档', '备份'], '', () => scrollPaletteTo('saveManagerPanel')),
    command('save-world', '立即保存世界', '使用当前快速存档路径保存。', '存档', ['save now', '保存世界', 'checkpoint'], '', () => callPaletteFunction('saveWorld')),
    command('load-world', '读取当前存档', '确认后使用当前快速存档路径替换世界。', '存档', ['load', '读取', '恢复'], '', async () => {
      const confirmed = typeof window.confirm !== 'function' || window.confirm('读取当前存档将替换世界状态。继续？');
      if (confirmed) await callPaletteFunction('loadWorld');
    }),
    command('show-runtime', '定位到持续运行', '滚动到世界运行循环控制面板。', '运维', ['runtime', '持续运行', 'loop'], '', () => scrollPaletteTo('runtimeLoopPanel')),
    command('runtime-start', '开始持续世界运行', '按当前循环配置启动世界。', '运维', ['runtime start', 'loop start', '持续运行'], '', () => callPaletteFunction('startRuntimeLoopFromClient')),
    command('runtime-pause', '暂停持续世界运行', '暂停后台世界循环。', '运维', ['runtime pause', 'loop pause', '暂停'], '', () => callPaletteFunction('pauseRuntimeLoopFromClient')),
    command('runtime-step', '单步推进世界', '通过持续运行控制器推进 1 tick。', '运维', ['runtime step', 'tick', '单步'], '', () => callPaletteFunction('stepRuntimeLoopFromClient')),
    command('show-admin', '定位到 GM 控制台', '滚动到状态、审计和错误面板。', '运维', ['admin', 'gm', '运维', '审计'], '', () => scrollPaletteTo('adminConsolePanel')),
    command('refresh-admin', '刷新 GM 控制台', '重新读取运维状态与 API 审计。', '运维', ['admin refresh', '运维刷新', '审计刷新'], '', () => callPaletteFunction('refreshAdminConsole')),
    command('toggle-auto-tick', '切换动作后推进', '开启或关闭玩法动作后的自动 tick。', '设置', ['auto tick', '动作后推进', '设置'], '', () => togglePaletteCheckbox('autoTickToggle', 'change')),
    command('toggle-auto-refresh', '切换自动刷新', '开启或关闭浏览器面板自动刷新。', '设置', ['auto refresh', '自动刷新', '设置'], '', () => togglePaletteCheckbox('autoRefreshToggle', 'change')),
    command('clear-event-log', '清空实时日志', '清除浏览器事件日志显示。', '页面', ['clear log', '清空日志', 'events'], '', () => {
      const log = document.getElementById('eventLog');
      if (log) log.textContent = '';
    }),
  ];
}

function command(id, title, description, group, keywords, shortcut, execute) {
  return { id, title, description, group, keywords, shortcut, execute };
}

function openCommandPalette(initialQuery = '') {
  const overlay = document.getElementById('commandPaletteOverlay');
  const search = document.getElementById('commandPaletteSearch');
  if (!overlay || !search) return;
  COMMAND_PALETTE_UI.open = true;
  COMMAND_PALETTE_UI.selectedIndex = 0;
  overlay.hidden = false;
  document.body.classList.add('command-palette-opened');
  search.value = initialQuery;
  renderCommandPalette();
  requestAnimationFrame(() => search.focus());
}

function closeCommandPalette() {
  const overlay = document.getElementById('commandPaletteOverlay');
  if (!overlay) return;
  COMMAND_PALETTE_UI.open = false;
  overlay.hidden = true;
  document.body.classList.remove('command-palette-opened');
  document.getElementById('commandPaletteOpenBtn')?.focus({ preventScroll: true });
}

function renderCommandPalette() {
  const model = commandPaletteModel();
  const query = document.getElementById('commandPaletteSearch')?.value || '';
  COMMAND_PALETTE_UI.results = model.rankCommands(COMMAND_PALETTE_UI.commands, query, {
    recentIds: COMMAND_PALETTE_UI.recentIds,
    favoriteIds: COMMAND_PALETTE_UI.favoriteIds,
    limit: 14,
  });
  COMMAND_PALETTE_UI.selectedIndex = clampPaletteSelection(COMMAND_PALETTE_UI.selectedIndex, COMMAND_PALETTE_UI.results.length);

  const context = document.getElementById('commandPaletteContext');
  if (context) {
    const favorites = COMMAND_PALETTE_UI.favoriteIds.length;
    const recent = COMMAND_PALETTE_UI.recentIds.length;
    context.innerHTML = '<span class="badge">结果 ' + COMMAND_PALETTE_UI.results.length + '</span>' +
      '<span class="badge">收藏 ' + favorites + '</span><span class="badge">最近 ' + recent + '</span>';
  }

  const container = document.getElementById('commandPaletteResults');
  const search = document.getElementById('commandPaletteSearch');
  if (!container) return;
  if (!COMMAND_PALETTE_UI.results.length) {
    container.innerHTML = '<div class="command-palette-empty">没有匹配命令。尝试“探索”“队列”或“save”。</div>';
    if (search) search.removeAttribute('aria-activedescendant');
    return;
  }

  container.innerHTML = COMMAND_PALETTE_UI.results.map((item, index) => {
    const selected = index === COMMAND_PALETTE_UI.selectedIndex;
    const favorite = COMMAND_PALETTE_UI.favoriteIds.includes(item.id);
    const resultId = 'commandPaletteResult' + index;
    return '<div id="' + resultId + '" class="command-palette-result ' + (selected ? 'selected' : '') + '" role="option" aria-selected="' + selected + '" data-command-id="' + attributePalette(item.id) + '">' +
      '<button class="command-palette-main" data-command-run="' + attributePalette(item.id) + '">' +
      '<span class="command-palette-icon">' + escapePalette(commandPaletteIcon(item.group)) + '</span>' +
      '<span class="command-palette-copy"><strong>' + escapePalette(item.title) + '</strong><small>' + escapePalette(item.description) + '</small></span>' +
      '<span class="command-palette-meta"><span>' + escapePalette(item.group) + '</span>' + (item.shortcut ? '<kbd>' + escapePalette(formatPaletteShortcut(item.shortcut)) + '</kbd>' : '') + '</span>' +
      '</button><button class="command-palette-favorite ' + (favorite ? 'active' : '') + '" data-command-favorite="' + attributePalette(item.id) + '" aria-label="' + (favorite ? '取消收藏' : '收藏命令') + '">★</button>' +
      '</div>';
  }).join('');

  if (search) search.setAttribute('aria-activedescendant', 'commandPaletteResult' + COMMAND_PALETTE_UI.selectedIndex);
  requestAnimationFrame(scrollSelectedPaletteResultIntoView);
}

async function handleCommandPaletteResultClick(event) {
  const favoriteButton = event.target.closest('[data-command-favorite]');
  if (favoriteButton) {
    event.preventDefault();
    togglePaletteFavorite(favoriteButton.dataset.commandFavorite);
    return;
  }
  const runButton = event.target.closest('[data-command-run]');
  if (runButton) {
    event.preventDefault();
    await executePaletteCommand(runButton.dataset.commandRun);
  }
}

function handleCommandPaletteKeydown(event) {
  const model = commandPaletteModel();
  const openShortcut = (event.key.toLocaleLowerCase() === 'k' && (event.ctrlKey || event.metaKey));
  const slashShortcut = event.key === '/' && !model.isEditableTarget(event.target);
  const helpShortcut = event.key === '?' && !model.isEditableTarget(event.target);
  if (openShortcut || slashShortcut || helpShortcut) {
    event.preventDefault();
    if (COMMAND_PALETTE_UI.open) closeCommandPalette();
    else openCommandPalette();
    return;
  }

  if (COMMAND_PALETTE_UI.open) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeCommandPalette();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      movePaletteSelection(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      movePaletteSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = COMMAND_PALETTE_UI.results[COMMAND_PALETTE_UI.selectedIndex];
      if (selected) executePaletteCommand(selected.id).catch(renderPaletteError);
    }
    return;
  }

  if (!COMMAND_PALETTE_UI.hotkeysEnabled || event.ctrlKey || event.metaKey || event.altKey) return;
  const matched = model.resolveShortcut(COMMAND_PALETTE_UI.commands, event);
  if (!matched) return;
  event.preventDefault();
  executePaletteCommand(matched.id).catch(renderPaletteError);
}

function movePaletteSelection(delta) {
  const count = COMMAND_PALETTE_UI.results.length;
  if (!count) return;
  COMMAND_PALETTE_UI.selectedIndex = (COMMAND_PALETTE_UI.selectedIndex + delta + count) % count;
  renderCommandPalette();
}

async function executePaletteCommand(commandId) {
  if (COMMAND_PALETTE_UI.busy) return;
  const item = COMMAND_PALETTE_UI.commands.find(commandItem => commandItem.id === commandId);
  if (!item) throw new Error('Missing palette command ' + commandId);
  COMMAND_PALETTE_UI.busy = true;
  const overlay = document.getElementById('commandPaletteOverlay');
  if (overlay) overlay.dataset.busy = 'true';
  try {
    await item.execute();
    COMMAND_PALETTE_UI.recentIds = commandPaletteModel().recordRecent(COMMAND_PALETTE_UI.recentIds, item.id, 10);
    persistCommandPaletteState();
    closeCommandPalette();
    notifyPalette(item.title + '：已执行', true);
  } catch (error) {
    renderPaletteError(error);
    throw error;
  } finally {
    COMMAND_PALETTE_UI.busy = false;
    if (overlay) delete overlay.dataset.busy;
  }
}

function togglePaletteFavorite(commandId) {
  COMMAND_PALETTE_UI.favoriteIds = commandPaletteModel().toggleFavorite(COMMAND_PALETTE_UI.favoriteIds, commandId, 20);
  persistCommandPaletteState();
  renderCommandPalette();
}

async function runPaletteGameAction(action, options) {
  if (typeof window.runGameAction !== 'function') throw new Error('玩法动作尚未就绪');
  return window.runGameAction(action, options);
}

async function callPaletteFunction(name, ...args) {
  if (typeof window[name] !== 'function') throw new Error(name + ' 尚未就绪');
  return window[name](...args);
}

function scrollPaletteTo(id) {
  const target = document.getElementById(id)?.closest('.panel') || document.getElementById(id);
  if (!target) throw new Error('页面面板不存在：' + id);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.add('command-palette-highlight');
  setTimeout(() => target.classList.remove('command-palette-highlight'), 1500);
}

function togglePaletteCheckbox(id, eventName) {
  const checkbox = document.getElementById(id);
  if (!checkbox) throw new Error('设置项不存在：' + id);
  checkbox.checked = !checkbox.checked;
  checkbox.dispatchEvent(new Event(eventName || 'change', { bubbles: true }));
}

function scrollSelectedPaletteResultIntoView() {
  document.querySelector('.command-palette-result.selected')?.scrollIntoView({ block: 'nearest' });
}

function clampPaletteSelection(index, count) {
  if (!count) return 0;
  return Math.max(0, Math.min(count - 1, Number(index || 0)));
}

function commandPaletteIcon(group) {
  const icons = {
    '玩法动作': '⚔',
    '会话': '◎',
    '页面': '◫',
    '自动化': '↻',
    '存档': '▣',
    '运维': '⚙',
    '设置': '◉',
  };
  return icons[group] || '•';
}

function formatPaletteShortcut(shortcut) {
  return String(shortcut || '').split('+').map(part => {
    const names = { ctrl: 'Ctrl', meta: 'Cmd', shift: 'Shift', alt: 'Alt' };
    return names[part] || part.toLocaleUpperCase();
  }).join(' ');
}

function renderPaletteError(error) {
  notifyPalette(error?.message || String(error), false);
}

function notifyPalette(message, ok) {
  if (typeof window.toast === 'function') window.toast(message, ok);
  if (typeof window.log === 'function') window.log('命令面板：' + message);
}

function commandPaletteModel() {
  if (!window.MudCommandPalette) throw new Error('命令面板模型未加载');
  return window.MudCommandPalette;
}

function escapePalette(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributePalette(value) {
  return escapePalette(value).replace(/'/g, '&#39;');
}

window.openCommandPalette = openCommandPalette;
window.closeCommandPalette = closeCommandPalette;
window.executePaletteCommand = executePaletteCommand;
