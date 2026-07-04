/* global document, fetch */
'use strict';

const databaseEls = {
  url: document.getElementById('database-url'),
  load: document.getElementById('load-database-button'),
  summary: document.getElementById('databaseSummary'),
  health: document.getElementById('databaseHealth'),
  status: document.getElementById('status'),
};

async function loadDatabaseSummary(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load database summary: ${response.status} ${response.statusText}`);
  return response.json();
}

function renderDatabaseSummary(payload) {
  const summary = payload?.data || payload;
  if (!summary || typeof summary !== 'object') {
    databaseEls.summary.innerHTML = '<p class="muted">No database summary loaded.</p>';
    databaseEls.health.innerHTML = '<p class="muted">No health data.</p>';
    return;
  }
  const rows = [
    ['Provider', summary.status?.provider || 'unknown'],
    ['Ready', summary.status?.ready ? 'yes' : 'no'],
    ['Records', summary.totals?.records ?? 0],
    ['Events', summary.totals?.events ?? 0],
    ['Worlds shown', summary.totals?.worlds ?? 0],
    ['Latest world', summary.latestWorld?.worldId || 'none'],
    ['Latest tick', summary.latestWorld?.tick ?? 'n/a'],
  ];
  databaseEls.summary.innerHTML = `${renderDatabaseMiniTable(rows)}${renderDatabaseWorlds(summary.worlds || [])}`;
  renderDatabaseHealth(summary.health || {});
}

function renderDatabaseWorlds(worlds) {
  if (!worlds.length) return '<p class="muted">No database worlds.</p>';
  const rows = worlds.slice(0, 5).map(world => [world.worldId, world.tick, world.sequence, world.savedAt]);
  const body = rows.map(row => `<tr>${row.map(value => `<td>${escapeDatabaseHtml(formatDatabaseValue(value))}</td>`).join('')}</tr>`).join('');
  return `<h3>Recent Worlds</h3><table class="data-table"><thead><tr><th>World</th><th>Tick</th><th>Seq</th><th>Saved</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderDatabaseHealth(health) {
  const rows = [
    ['OK', health.ok ? 'yes' : 'no'],
    ['Ready', health.ready ? 'yes' : 'no'],
    ['Supported', health.supported ? 'yes' : 'no'],
    ['Has records', health.hasRecords ? 'yes' : 'no'],
    ['Has events', health.hasEvents ? 'yes' : 'no'],
    ['Latest world', health.latestWorldId || 'none'],
    ['Latest tick', health.latestTick ?? 'n/a'],
  ];
  databaseEls.health.innerHTML = [
    renderDatabaseMiniTable(rows),
    '<h3>Recent Event Types</h3>',
    renderDatabaseList(health.recentEventTypes || [], item => `<strong>${escapeDatabaseHtml(item.type)}</strong><span>${formatDatabaseValue(item.count)} recent events</span>`),
    '<h3>Warnings</h3>',
    (health.warnings || []).length ? renderDatabaseList(health.warnings, item => `<strong>${escapeDatabaseHtml(item)}</strong>`) : '<p class="muted">No warnings.</p>',
  ].join('');
}

function renderDatabaseMiniTable(rows) {
  return `<table class="data-table"><tbody>${rows.map(([key, value]) => `<tr><th>${escapeDatabaseHtml(key)}</th><td>${escapeDatabaseHtml(formatDatabaseValue(value))}</td></tr>`).join('')}</tbody></table>`;
}

function renderDatabaseList(items, renderer) {
  if (!items.length) return '<p class="muted">No data.</p>';
  return `<div class="list">${items.map(item => `<div class="item">${renderer(item)}</div>`).join('')}</div>`;
}

function formatDatabaseValue(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num) || value === '' || value === null || value === undefined) return String(value ?? '');
  return String(Math.round(num * 100) / 100);
}

function escapeDatabaseHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function bootDatabaseSummary(showError = true) {
  try {
    const summary = await loadDatabaseSummary(databaseEls.url.value);
    renderDatabaseSummary(summary);
  } catch (error) {
    renderDatabaseSummary(null);
    if (showError && databaseEls.status) databaseEls.status.textContent = error.message;
  }
}

if (databaseEls.load && databaseEls.url) {
  databaseEls.load.addEventListener('click', () => bootDatabaseSummary(true));
  databaseEls.url.addEventListener('keydown', event => { if (event.key === 'Enter') bootDatabaseSummary(true); });
  bootDatabaseSummary(false);
}
