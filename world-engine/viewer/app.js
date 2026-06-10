/* global document, fetch */
'use strict';

const els = {
  status: document.getElementById('status'),
  url: document.getElementById('snapshot-url'),
  load: document.getElementById('load-button'),
  metrics: document.getElementById('metrics'),
  players: document.getElementById('players'),
  commands: document.getElementById('commands'),
  civilizations: document.getElementById('civilizations'),
  cities: document.getElementById('cities'),
  organizations: document.getElementById('organizations'),
  entities: document.getElementById('entities'),
  systems: document.getElementById('systems'),
  limits: document.getElementById('limits'),
  reports: document.getElementById('reports'),
  raw: document.getElementById('raw'),
};

async function loadSnapshot(url) {
  setStatus(`Loading ${url}...`);
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load snapshot: ${response.status} ${response.statusText}`);
  return response.json();
}

function render(snapshot) {
  renderMetrics(snapshot);
  renderPlayers(snapshot.players?.items || []);
  renderCommands(snapshot.commands?.recent || []);
  renderCivilizations(snapshot.civilizations || []);
  renderCities(snapshot.cities || []);
  renderOrganizations(snapshot.organizations || []);
  renderEntities(snapshot.narrative?.topEntities || []);
  renderSystems(snapshot);
  renderLimits(snapshot.limits || {});
  renderReports(snapshot.recentReports || []);
  els.raw.textContent = JSON.stringify(snapshot, null, 2);
  setStatus(`Loaded world=${snapshot.world?.id || 'unknown'} tick=${snapshot.world?.tick ?? 'n/a'} schema=${snapshot.schemaVersion || 'n/a'}`);
}

function renderMetrics(snapshot) {
  const metrics = [
    ['Tick', snapshot.world?.tick ?? 0],
    ['Alive', snapshot.population?.alive ?? 0],
    ['Players', snapshot.players?.total ?? 0],
    ['Commands', snapshot.commands?.total ?? 0],
    ['Cities', snapshot.cities?.length ?? 0],
    ['Organizations', snapshot.organizations?.length ?? 0],
    ['Civilizations', snapshot.civilizations?.length ?? 0],
    ['Tech Unlocked', snapshot.technology?.unlocked ?? 0],
    ['Conflicts', snapshot.conflicts?.total ?? 0],
    ['Processes', snapshot.processes?.total ?? 0],
  ];

  els.metrics.innerHTML = metrics.map(([label, value]) => `
    <article class="metric">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(String(formatNumber(value)))}</div>
    </article>
  `).join('');
}

function renderPlayers(items) {
  els.players.innerHTML = renderList(items, item => `
    <strong>${escapeHtml(item.name || item.id)}</strong>
    <span>${escapeHtml(item.status || 'unknown')} · ${escapeHtml(item.controlMode || 'unknown')}</span>
    <span>entity ${escapeHtml(item.activeEntityName || item.activeEntityId || 'none')} · location ${escapeHtml(item.locationId || 'unknown')}</span>
    <span>controlled entities ${formatNumber(item.controlledEntities || 0)}</span>
  `);
}

function renderCommands(items) {
  els.commands.innerHTML = renderList(items.slice().reverse(), item => `
    <strong>${escapeHtml(item.type || 'command')} · ${escapeHtml(item.status || 'unknown')}</strong>
    <span>player ${escapeHtml(item.playerId || 'unknown')} · tick ${formatNumber(item.updatedAt ?? item.createdAt ?? 0)}</span>
    <span>${item.result?.ok ? 'ok' : 'not ok'}${item.result?.reason ? ` · ${escapeHtml(item.result.reason)}` : ''}${item.result?.actionType ? ` · action ${escapeHtml(item.result.actionType)}` : ''}</span>
  `);
}

function renderCivilizations(items) {
  els.civilizations.innerHTML = renderList(items, item => `
    <strong>${escapeHtml(item.name)}</strong>
    <span>${escapeHtml(item.level)} · score ${formatNumber(item.score)} · ${escapeHtml(item.dominantSpecies || 'unknown')}</span>
    <div class="badge-row">${(item.values || []).slice(0, 5).map(value => `<span class="badge">${escapeHtml(value)}</span>`).join('')}</div>
  `);
}

function renderCities(items) {
  els.cities.innerHTML = renderList(items, item => `
    <strong>${escapeHtml(item.name)}</strong>
    <span>${escapeHtml(item.type || 'city')} · pop ${formatNumber(item.population)} · wealth ${formatNumber(item.wealth)}</span>
    <span>security ${formatNumber(item.security)} · culture ${formatNumber(item.culture)} · infrastructure ${formatNumber(item.infrastructure)}</span>
  `);
}

function renderOrganizations(items) {
  els.organizations.innerHTML = renderList(items, item => `
    <strong>${escapeHtml(item.name)}</strong>
    <span>${escapeHtml(item.type)} · ${escapeHtml(item.status)} · members ${formatNumber(item.members)}</span>
    <span>wealth ${formatNumber(item.wealth)} · authority ${formatNumber(item.authority)} · reputation ${formatNumber(item.reputation)}</span>
  `);
}

function renderEntities(items) {
  els.entities.innerHTML = renderList(items, item => `
    <strong>${escapeHtml(item.name || item.entityId)}</strong>
    <span>${escapeHtml(item.entityId)} · ${escapeHtml(item.status || 'unknown')}</span>
    <span>score ${formatNumber(item.score)}</span>
  `);
}

function renderSystems(snapshot) {
  const rows = [
    ['Players', `${snapshot.players?.active || 0}/${snapshot.players?.total || 0} active · commands ${snapshot.commands?.total || 0}`],
    ['Infrastructure', `${snapshot.infrastructure?.active || 0}/${snapshot.infrastructure?.total || 0} active`],
    ['Governance', `${snapshot.governance?.active || 0}/${snapshot.governance?.total || 0} active · unrest ${formatNumber(snapshot.governance?.averageUnrest || 0)}`],
    ['Conflicts', `${snapshot.conflicts?.active || 0} active · casualties ${formatNumber(snapshot.conflicts?.casualties || 0)}`],
    ['Emergence', `${snapshot.emergence?.active || 0}/${snapshot.emergence?.total || 0} active`],
    ['Information', `${snapshot.information?.total || 0} items · ${snapshot.information?.knownOwners || 0} owners`],
    ['Memories', `${snapshot.memories?.total || 0} memories · ${snapshot.memories?.owners || 0} owners`],
  ];

  els.systems.innerHTML = renderList(rows, ([name, value]) => `
    <strong>${escapeHtml(name)}</strong>
    <span>${escapeHtml(value)}</span>
  `);
}

function renderLimits(limits) {
  const rows = Object.entries(limits).map(([key, value]) => [key, value.current, value.limit]);
  els.limits.innerHTML = renderList(rows, ([key, current, limit]) => {
    const ratio = limit ? current / limit : 0;
    const label = ratio >= 0.9 ? 'near cap' : ratio >= 0.7 ? 'watch' : 'ok';
    return `
      <strong>${escapeHtml(key)}</strong>
      <span>${formatNumber(current)} / ${formatNumber(limit)} · ${label}</span>
    `;
  });
}

function renderReports(reports) {
  els.reports.innerHTML = renderList(reports.slice().reverse(), report => `
    <strong>tick ${formatNumber(report.tickAfter ?? report.tickBefore ?? 0)}</strong>
    <span>births ${report.births || 0} · deaths ${report.deaths || 0} · actions ${report.completedActions || 0} · events ${report.processedEvents || 0}</span>
    <span>players ${report.playersChanged || 0} · cities ${report.cityProcessed ? 'yes' : 'no'} · economy ${report.economyProcessed ? 'yes' : 'no'} · conflicts ${report.conflictsCreated || 0}</span>
  `);
}

function renderList(items, renderer) {
  if (!items.length) return '<p class="muted">No data.</p>';
  return `<div class="list">${items.map(item => `<div class="item">${renderer(item)}</div>`).join('')}</div>`;
}

function setStatus(message) {
  els.status.textContent = message;
}

function formatNumber(value) {
  const num = Number(value || 0);
  if (!Number.isFinite(num)) return value;
  return Math.round(num * 100) / 100;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function boot() {
  try {
    const snapshot = await loadSnapshot(els.url.value);
    render(snapshot);
  } catch (error) {
    setStatus(error.message);
  }
}

els.load.addEventListener('click', () => boot());
els.url.addEventListener('keydown', event => {
  if (event.key === 'Enter') boot();
});

boot();
