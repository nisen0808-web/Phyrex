'use strict';

const WORKSPACE_UI = {
  panels: [],
  collapsed: [],
  pinned: [],
  compact: false,
  open: false,
  observer: null,
};

window.addEventListener('DOMContentLoaded', () => {
  mountWorkspaceNavigator();
  restoreWorkspaceState();
  bindWorkspaceControls();
  decorateWorkspacePanels();
  observeWorkspacePanels();
  applyWorkspaceState();
  renderWorkspaceNavigator();
});

function mountWorkspaceNavigator() {
  if (document.getElementById('workspaceNavigatorOverlay')) return;
  const button = document.createElement('button');
  button.id = 'workspaceNavigatorOpenBtn';
  button.className = 'workspace-navigator-open';
  button.type = 'button';
  button.setAttribute('aria-haspopup', 'dialog');
  button.innerHTML = '<span>面板</span><kbd>Ctrl ⇧ L</kbd>';
  document.querySelector('.top-actions')?.prepend(button);

  const overlay = document.createElement('div');
  overlay.id = 'workspaceNavigatorOverlay';
  overlay.className = 'workspace-navigator-overlay';
  overlay.hidden = true;
  overlay.innerHTML = [
    '<aside class="workspace-navigator-drawer" role="dialog" aria-modal="true" aria-labelledby="workspaceNavigatorTitle">',
    '  <header class="workspace-navigator-header"><div><h2 id="workspaceNavigatorTitle">工作区导航</h2><p>搜索、跳转、固定或折叠页面面板。</p></div><button id="workspaceNavigatorCloseBtn" aria-label="关闭工作区导航">×</button></header>',
    '  <div class="workspace-navigator-search"><input id="workspaceNavigatorSearch" type="search" placeholder="搜索面板" autocomplete="off" /><span id="workspaceNavigatorCount" class="badge">0</span></div>',
    '  <div class="workspace-navigator-actions">',
    '    <button id="workspaceCollapseAllBtn" class="small">全部折叠</button>',
    '    <button id="workspaceExpandAllBtn" class="small">全部展开</button>',
    '    <label class="inline-control"><input id="workspaceCompactToggle" type="checkbox" />紧凑模式</label>',
    '  </div>',
    '  <div id="workspaceNavigatorList" class="workspace-navigator-list"><div class="empty">等待页面面板</div></div>',
    '  <footer><span>固定项优先显示</span><kbd>Esc</kbd></footer>',
    '</aside>',
  ].join('');
  document.body.appendChild(overlay);
}

function restoreWorkspaceState() {
  const model = workspaceModel();
  let parsed = {};
  try { parsed = JSON.parse(localStorage.getItem('mud_workspace_state') || '{}'); }
  catch (_error) { parsed = {}; }
  const state = model.normalizeWorkspaceState(parsed);
  WORKSPACE_UI.collapsed = state.collapsed;
  WORKSPACE_UI.pinned = state.pinned;
  WORKSPACE_UI.compact = state.compact;
  const compact = document.getElementById('workspaceCompactToggle');
  if (compact) compact.checked = WORKSPACE_UI.compact;
}

function persistWorkspaceState() {
  localStorage.setItem('mud_workspace_state', JSON.stringify({
    collapsed: WORKSPACE_UI.collapsed,
    pinned: WORKSPACE_UI.pinned,
    compact: WORKSPACE_UI.compact,
  }));
}

function bindWorkspaceControls() {
  document.getElementById('workspaceNavigatorOpenBtn')?.addEventListener('click', openWorkspaceNavigator);
  document.getElementById('workspaceNavigatorCloseBtn')?.addEventListener('click', closeWorkspaceNavigator);
  document.getElementById('workspaceNavigatorOverlay')?.addEventListener('click', event => {
    if (event.target.id === 'workspaceNavigatorOverlay') closeWorkspaceNavigator();
  });
  document.getElementById('workspaceNavigatorSearch')?.addEventListener('input', renderWorkspaceNavigator);
  document.getElementById('workspaceCollapseAllBtn')?.addEventListener('click', collapseAllWorkspacePanels);
  document.getElementById('workspaceExpandAllBtn')?.addEventListener('click', expandAllWorkspacePanels);
  document.getElementById('workspaceCompactToggle')?.addEventListener('change', event => {
    setWorkspaceCompact(Boolean(event.target.checked));
  });
  document.getElementById('workspaceNavigatorList')?.addEventListener('click', handleWorkspaceNavigatorClick);
  document.addEventListener('click', handleWorkspacePanelToolClick);
  document.addEventListener('keydown', handleWorkspaceKeydown);
}

function observeWorkspacePanels() {
  const main = document.querySelector('main');
  if (!main || WORKSPACE_UI.observer) return;
  WORKSPACE_UI.observer = new MutationObserver(mutations => {
    if (!mutations.some(mutation => mutation.addedNodes.length || mutation.removedNodes.length)) return;
    decorateWorkspacePanels();
    applyWorkspaceState();
    renderWorkspaceNavigator();
  });
  WORKSPACE_UI.observer.observe(main, { childList: true, subtree: true });
}

function decorateWorkspacePanels() {
  const model = workspaceModel();
  const panels = [...document.querySelectorAll('main > .panel')];
  const used = new Set();
  WORKSPACE_UI.panels = panels.map((panel, index) => {
    const title = panel.querySelector('h2')?.textContent?.trim() || panel.id || `面板 ${index + 1}`;
    let key = panel.dataset.workspaceKey || model.createPanelKey({ id: panel.id, title }, index);
    if (used.has(key)) key += '-' + (index + 1);
    used.add(key);
    panel.dataset.workspaceKey = key;
    panel.classList.add('workspace-panel');
    if (!panel.querySelector(':scope > .workspace-panel-tools')) {
      const tools = document.createElement('div');
      tools.className = 'workspace-panel-tools';
      tools.innerHTML = '<button class="workspace-tool-pin" data-workspace-pin="' + attributeWorkspace(key) + '" aria-label="固定面板" title="固定面板">☆</button>' +
        '<button class="workspace-tool-collapse" data-workspace-collapse="' + attributeWorkspace(key) + '" aria-label="折叠面板" title="折叠面板">−</button>';
      panel.appendChild(tools);
    }
    return {
      key,
      title,
      description: panel.querySelector('.hint')?.textContent?.trim() || '',
      element: panel,
    };
  });
}

function applyWorkspaceState() {
  document.body.classList.toggle('workspace-compact', WORKSPACE_UI.compact);
  for (const panel of WORKSPACE_UI.panels) {
    const collapsed = WORKSPACE_UI.collapsed.includes(panel.key);
    const pinned = WORKSPACE_UI.pinned.includes(panel.key);
    panel.element.classList.toggle('workspace-collapsed', collapsed);
    panel.element.classList.toggle('workspace-pinned', pinned);
    const collapseButton = panel.element.querySelector('[data-workspace-collapse]');
    if (collapseButton) {
      collapseButton.textContent = collapsed ? '+' : '−';
      collapseButton.title = collapsed ? '展开面板' : '折叠面板';
      collapseButton.setAttribute('aria-label', collapseButton.title);
      collapseButton.setAttribute('aria-expanded', String(!collapsed));
    }
    const pinButton = panel.element.querySelector('[data-workspace-pin]');
    if (pinButton) {
      pinButton.textContent = pinned ? '★' : '☆';
      pinButton.classList.toggle('active', pinned);
      pinButton.title = pinned ? '取消固定' : '固定面板';
      pinButton.setAttribute('aria-label', pinButton.title);
    }
  }
}

function renderWorkspaceNavigator() {
  const model = workspaceModel();
  const query = document.getElementById('workspaceNavigatorSearch')?.value || '';
  const sorted = model.sortPanels(WORKSPACE_UI.panels, WORKSPACE_UI.pinned);
  const panels = model.filterPanels(sorted, query);
  const count = document.getElementById('workspaceNavigatorCount');
  if (count) count.textContent = String(panels.length);
  const list = document.getElementById('workspaceNavigatorList');
  if (!list) return;
  if (!panels.length) {
    list.innerHTML = '<div class="empty">没有匹配面板</div>';
    return;
  }
  list.innerHTML = panels.map(panel => {
    const collapsed = WORKSPACE_UI.collapsed.includes(panel.key);
    const pinned = WORKSPACE_UI.pinned.includes(panel.key);
    return '<article class="workspace-navigator-row ' + (pinned ? 'pinned' : '') + '">' +
      '<button class="workspace-navigator-jump" data-workspace-jump="' + attributeWorkspace(panel.key) + '"><strong>' + escapeWorkspace(panel.title) + '</strong><small>' + escapeWorkspace(panel.description || panel.key) + '</small></button>' +
      '<button class="workspace-navigator-pin ' + (pinned ? 'active' : '') + '" data-workspace-pin="' + attributeWorkspace(panel.key) + '" title="' + (pinned ? '取消固定' : '固定') + '">' + (pinned ? '★' : '☆') + '</button>' +
      '<button class="workspace-navigator-collapse" data-workspace-collapse="' + attributeWorkspace(panel.key) + '">' + (collapsed ? '展开' : '折叠') + '</button>' +
      '</article>';
  }).join('');
}

function handleWorkspaceNavigatorClick(event) {
  const jump = event.target.closest('[data-workspace-jump]');
  if (jump) {
    jumpToWorkspacePanel(jump.dataset.workspaceJump);
    return;
  }
  const pin = event.target.closest('[data-workspace-pin]');
  if (pin) {
    toggleWorkspacePinned(pin.dataset.workspacePin);
    return;
  }
  const collapse = event.target.closest('[data-workspace-collapse]');
  if (collapse) toggleWorkspaceCollapsed(collapse.dataset.workspaceCollapse);
}

function handleWorkspacePanelToolClick(event) {
  if (event.target.closest('#workspaceNavigatorList')) return;
  const pin = event.target.closest('.workspace-panel-tools [data-workspace-pin]');
  if (pin) {
    event.preventDefault();
    toggleWorkspacePinned(pin.dataset.workspacePin);
    return;
  }
  const collapse = event.target.closest('.workspace-panel-tools [data-workspace-collapse]');
  if (collapse) {
    event.preventDefault();
    toggleWorkspaceCollapsed(collapse.dataset.workspaceCollapse);
  }
}

function handleWorkspaceKeydown(event) {
  if (event.key === 'Escape' && WORKSPACE_UI.open) {
    event.preventDefault();
    closeWorkspaceNavigator();
    return;
  }
  if (event.key.toLocaleLowerCase() === 'l' && (event.ctrlKey || event.metaKey) && event.shiftKey) {
    event.preventDefault();
    WORKSPACE_UI.open ? closeWorkspaceNavigator() : openWorkspaceNavigator();
  }
}

function openWorkspaceNavigator() {
  const overlay = document.getElementById('workspaceNavigatorOverlay');
  if (!overlay) return;
  decorateWorkspacePanels();
  applyWorkspaceState();
  renderWorkspaceNavigator();
  WORKSPACE_UI.open = true;
  overlay.hidden = false;
  document.body.classList.add('workspace-navigator-opened');
  requestAnimationFrame(() => document.getElementById('workspaceNavigatorSearch')?.focus());
}

function closeWorkspaceNavigator() {
  const overlay = document.getElementById('workspaceNavigatorOverlay');
  if (!overlay) return;
  WORKSPACE_UI.open = false;
  overlay.hidden = true;
  document.body.classList.remove('workspace-navigator-opened');
  document.getElementById('workspaceNavigatorOpenBtn')?.focus({ preventScroll: true });
}

function jumpToWorkspacePanel(key) {
  const panel = findWorkspacePanel(key);
  if (!panel) return;
  WORKSPACE_UI.collapsed = workspaceModel().toggleId(WORKSPACE_UI.collapsed, key, false);
  persistWorkspaceState();
  applyWorkspaceState();
  closeWorkspaceNavigator();
  panel.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  panel.element.classList.add('workspace-jump-highlight');
  setTimeout(() => panel.element.classList.remove('workspace-jump-highlight'), 1500);
}

function toggleWorkspaceCollapsed(key, enabled = null) {
  WORKSPACE_UI.collapsed = workspaceModel().toggleId(WORKSPACE_UI.collapsed, key, enabled);
  persistWorkspaceState();
  applyWorkspaceState();
  renderWorkspaceNavigator();
}

function toggleWorkspacePinned(key, enabled = null) {
  WORKSPACE_UI.pinned = workspaceModel().toggleId(WORKSPACE_UI.pinned, key, enabled);
  persistWorkspaceState();
  applyWorkspaceState();
  renderWorkspaceNavigator();
}

function collapseAllWorkspacePanels() {
  WORKSPACE_UI.collapsed = WORKSPACE_UI.panels.map(panel => panel.key);
  persistWorkspaceState();
  applyWorkspaceState();
  renderWorkspaceNavigator();
}

function expandAllWorkspacePanels() {
  WORKSPACE_UI.collapsed = [];
  persistWorkspaceState();
  applyWorkspaceState();
  renderWorkspaceNavigator();
}

function setWorkspaceCompact(value) {
  WORKSPACE_UI.compact = Boolean(value);
  const checkbox = document.getElementById('workspaceCompactToggle');
  if (checkbox) checkbox.checked = WORKSPACE_UI.compact;
  persistWorkspaceState();
  applyWorkspaceState();
}

function findWorkspacePanel(key) {
  return WORKSPACE_UI.panels.find(panel => panel.key === key) || null;
}

function workspaceModel() {
  if (!window.MudWorkspaceLayout) throw new Error('工作区布局模型未加载');
  return window.MudWorkspaceLayout;
}

function escapeWorkspace(value) {
  return String(value).replace(/[&<>\"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
}

function attributeWorkspace(value) {
  return escapeWorkspace(value).replace(/'/g, '&#39;');
}

window.openWorkspaceNavigator = openWorkspaceNavigator;
window.closeWorkspaceNavigator = closeWorkspaceNavigator;
window.collapseAllWorkspacePanels = collapseAllWorkspacePanels;
window.expandAllWorkspacePanels = expandAllWorkspacePanels;
window.setWorkspaceCompact = setWorkspaceCompact;
window.jumpToWorkspacePanel = jumpToWorkspacePanel;
