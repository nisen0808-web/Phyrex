'use strict';

window.addEventListener('DOMContentLoaded', () => {
  if (typeof COMMAND_PALETTE_UI === 'undefined' || !Array.isArray(COMMAND_PALETTE_UI.commands)) return;
  const existing = new Set(COMMAND_PALETTE_UI.commands.map(item => item.id));
  const additions = [
    extensionCommand('show-world-templates', '定位到世界模板', '滚动到世界模板管理与安全重置面板。', '运维', ['template', '模板', '重置世界'], () => scrollWorldControlPanel('worldTemplatePanel')),
    extensionCommand('refresh-world-templates', '刷新世界模板', '重新读取模板、当前世界和循环状态。', '运维', ['template refresh', '刷新模板'], () => callWorldControlFunction('refreshWorldTemplates')),
    extensionCommand('show-world-insights', '定位到世界洞察', '滚动到人口、排行榜和活动洞察。', '页面', ['insights', '洞察', '排行', '人口'], () => scrollWorldControlPanel('worldInsightsPanel')),
    extensionCommand('refresh-world-insights', '刷新世界洞察', '重新读取世界快照并刷新排行。', '页面', ['insights refresh', '刷新洞察', '排行榜'], () => callWorldControlFunction('refreshWorldInsights')),
    extensionCommand('copy-world-summary', '复制世界摘要', '复制当前世界、人口与排行摘要。', '页面', ['copy summary', '复制摘要', '世界摘要'], () => callWorldControlFunction('copyWorldInsightsSummary')),
    extensionCommand('export-world-snapshot', '导出世界快照', '下载当前世界快照 JSON。', '存档', ['export snapshot', '导出快照', 'json'], () => callWorldControlFunction('exportWorldSnapshot')),
    extensionCommand('open-workspace-navigator', '打开工作区导航', '搜索、跳转、固定和折叠页面面板。', '页面', ['workspace', '工作区', '面板导航', 'collapse'], () => callWorldControlFunction('openWorkspaceNavigator')),
    extensionCommand('collapse-workspace-panels', '折叠全部面板', '将工作区全部面板折叠为标题。', '设置', ['collapse all', '全部折叠', '布局'], () => callWorldControlFunction('collapseAllWorkspacePanels')),
    extensionCommand('expand-workspace-panels', '展开全部面板', '展开工作区的全部面板。', '设置', ['expand all', '全部展开', '布局'], () => callWorldControlFunction('expandAllWorkspacePanels')),
    extensionCommand('toggle-compact-workspace', '切换紧凑工作区', '切换更紧凑的面板间距和内边距。', '设置', ['compact', '紧凑模式', '布局'], () => {
      const next = !document.body.classList.contains('workspace-compact');
      return callWorldControlFunction('setWorkspaceCompact', next);
    }),
  ];
  for (const item of additions) {
    if (!existing.has(item.id)) COMMAND_PALETTE_UI.commands.push(item);
  }
  if (typeof renderCommandPalette === 'function') renderCommandPalette();
});

function extensionCommand(id, title, description, group, keywords, execute) {
  return { id, title, description, group, keywords, shortcut: '', execute };
}

async function callWorldControlFunction(name, ...args) {
  if (typeof window[name] !== 'function') throw new Error(name + ' 尚未就绪');
  return window[name](...args);
}

function scrollWorldControlPanel(id) {
  const target = document.getElementById(id);
  if (!target) throw new Error('页面面板不存在：' + id);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  target.classList.add('workspace-jump-highlight');
  setTimeout(() => target.classList.remove('workspace-jump-highlight'), 1500);
}
