/* global document, fetch */
'use strict';

const els = {
  status: document.getElementById('status'),
  url: document.getElementById('snapshot-url'),
  load: document.getElementById('load-button'),
  performanceUrl: document.getElementById('performance-url'),
  loadPerformance: document.getElementById('load-performance-button'),
  performance: document.getElementById('performance'),
  performanceRecommendations: document.getElementById('performanceRecommendations'),
  metrics: document.getElementById('metrics'),
  players: document.getElementById('players'),
  commands: document.getElementById('commands'),
  tutorials: document.getElementById('tutorials'),
  quests: document.getElementById('quests'),
  journals: document.getElementById('journals'),
  encounters: document.getElementById('encounters'),
  questBoards: document.getElementById('questBoards'),
  items: document.getElementById('items'),
  shops: document.getElementById('shops'),
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

async function loadJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

function render(snapshot) {
  renderMetrics(snapshot);
  renderPlayers(snapshot.players?.items || []);
  renderCommands(snapshot.commands?.recent || []);
  renderTutorials(snapshot.tutorials?.items || []);
  renderQuests(snapshot.quests?.items || []);
  renderJournals(snapshot.journals?.recent || []);
  renderEncounters(snapshot.encounters?.recent || []);
  renderQuestBoards(snapshot.questBoards?.items || []);
  renderItems(snapshot.items?.recent || []);
  renderShops(snapshot.shops?.items || []);
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
    ['Quests', snapshot.quests?.total ?? 0],
    ['Journal', snapshot.journals?.total ?? 0],
    ['Encounters', snapshot.encounters?.total ?? 0],
    ['Board Items', snapshot.questBoards?.total ?? 0],
    ['Items', snapshot.items?.instances ?? 0],
    ['Shops', snapshot.shops?.total ?? 0],
    ['Cities', snapshot.cities?.length ?? 0],
    ['Organizations', snapshot.organizations?.length ?? 0],
    ['Civilizations', snapshot.civilizations?.length ?? 0],
    ['Tech Unlocked', snapshot.technology?.unlocked ?? 0],
    ['Conflicts', snapshot.conflicts?.total ?? 0],
    ['Processes', snapshot.processes?.total ?? 0],
  ];
  els.metrics.innerHTML = metrics.map(([label, value]) => `<article class="metric"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${escapeHtml(String(formatNumber(value)))}</div></article>`).join('');
}

function renderPerformance(report) {
  if (!report || typeof report !== 'object') {
    els.performance.innerHTML = '<p class="muted">No performance report loaded.</p>';
    els.performanceRecommendations.innerHTML = '<p class="muted">No recommendations.</p>';
    return;
  }
  const trend = report.trend?.trend ? report.trend : report.sampleCount !== undefined ? report : null;
  const pressure = report.pressure?.scenarios ? report.pressure : report.scenarios ? report : null;
  els.performance.innerHTML = [
    renderPerformanceTrend(trend),
    renderPerformancePressure(pressure),
    renderPerformanceTopSystems(trend?.topSystems || pressure?.highestRisk?.topSystems || []),
  ].join('');
  renderPerformanceRecommendations(report.recommendations || []);
}

function renderPerformanceTrend(trend) {
  if (!trend) return '<p class="muted">No trend data.</p>';
  const rows = [
    ['Samples', trend.sampleCount],
    ['Direction', trend.trend?.direction || 'unknown'],
    ['Average total load', trend.averageTotalLoad],
    ['Max total load', trend.maxTotalLoad],
    ['Average max system load', trend.averageMaxSystemLoad],
    ['Warnings', trend.warningCount],
    ['Violations', trend.violationCount],
  ];
  return `<h3>Trend</h3>${renderMiniTable(rows)}`;
}

function renderPerformancePressure(pressure) {
  if (!pressure) return '<p class="muted">No pressure data.</p>';
  const rows = (pressure.scenarios || []).map(item => [item.name, item.totalLoad, item.maxSystemLoad, item.warnings, item.violations, item.riskScore]);
  const body = rows.length ? rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(formatNumber(value))}</td>`).join('')}</tr>`).join('') : '<tr><td colspan="6">none</td></tr>';
  return `<h3>Pressure</h3><table class="data-table"><thead><tr><th>Scenario</th><th>Total</th><th>Max System</th><th>Warnings</th><th>Violations</th><th>Risk</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderPerformanceTopSystems(systems) {
  if (!systems.length) return '<p class="muted">No top system data.</p>';
  const rows = systems.map(system => [system.systemId, system.averageLoad ?? system.load, system.maxLoad ?? system.load, system.appearances ?? 1, system.budget]);
  const body = rows.map(row => `<tr>${row.map(value => `<td>${escapeHtml(formatNumber(value))}</td>`).join('')}</tr>`).join('');
  return `<h3>Top Systems</h3><table class="data-table"><thead><tr><th>System</th><th>Average</th><th>Max</th><th>Seen</th><th>Budget</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderPerformanceRecommendations(items) {
  els.performanceRecommendations.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.priority || 'info')}</strong><span>${escapeHtml(item.message || item.type || '')}</span>`);
}

function renderMiniTable(rows) {
  return `<table class="data-table"><tbody>${rows.map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(formatNumber(value))}</td></tr>`).join('')}</tbody></table>`;
}

function renderPlayers(items) { els.players.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name || item.id)}</strong><span>${escapeHtml(item.status || 'unknown')} · ${escapeHtml(item.controlMode || 'unknown')}</span><span>entity ${escapeHtml(item.activeEntityName || item.activeEntityId || 'none')} · location ${escapeHtml(item.locationId || 'unknown')}</span><span>controlled entities ${formatNumber(item.controlledEntities || 0)}</span>`); }
function renderCommands(items) { els.commands.innerHTML = renderList(items.slice().reverse(), item => `<strong>${escapeHtml(item.type || 'command')} · ${escapeHtml(item.status || 'unknown')}</strong><span>player ${escapeHtml(item.playerId || 'unknown')} · tick ${formatNumber(item.updatedAt ?? item.createdAt ?? 0)}</span><span>${item.result?.ok ? 'ok' : 'not ok'}${item.result?.reason ? ` · ${escapeHtml(item.result.reason)}` : ''}${item.result?.actionType ? ` · action ${escapeHtml(item.result.actionType)}` : ''}</span>`); }
function renderTutorials(items) { els.tutorials.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.playerId)}</strong><span>${escapeHtml(item.status || 'unknown')} · active quest ${escapeHtml(item.activeQuestId || 'none')}</span><span>completed ${formatNumber(item.completedQuests || 0)} · claimed ${formatNumber(item.claimedQuests || 0)}</span>`); }
function renderQuests(items) { els.quests.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.title || item.id)}</strong><span>${escapeHtml(item.status || 'unknown')} · player ${escapeHtml(item.playerId || 'unknown')} · progress ${formatNumber(item.progress || 0)}%</span><span>objectives ${formatNumber(item.completedObjectives || 0)}/${formatNumber(item.objectives || 0)} · tags ${(item.tags || []).map(escapeHtml).join(', ') || 'none'}</span>`); }
function renderJournals(items) { els.journals.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.title || item.type)}</strong><span>tick ${formatNumber(item.tick || 0)} · ${escapeHtml(item.type || 'journal')} · ${escapeHtml(item.locationId || 'unknown')}</span><span>${escapeHtml(item.summary || '')}</span>`); }
function renderEncounters(items) { els.encounters.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.title || item.type)}</strong><span>${escapeHtml(item.type || 'encounter')} · ${escapeHtml(item.status || 'unknown')} · ${escapeHtml(item.locationId || 'unknown')}</span><span>${escapeHtml(item.summary || '')}</span>`); }
function renderQuestBoards(items) { els.questBoards.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.title || item.id)}</strong><span>${escapeHtml(item.status || 'unknown')} · ${escapeHtml(item.type || 'board')} · ${escapeHtml(item.locationId || 'world')}</span><span>${escapeHtml(item.summary || '')}</span>`); }
function renderItems(items) { els.items.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name || item.definitionId)}</strong><span>${escapeHtml(item.type || 'item')} · ${escapeHtml(item.rarity || 'common')} · qty ${formatNumber(item.quantity || 0)}</span><span>owner ${escapeHtml(item.ownerType || 'none')}:${escapeHtml(item.ownerId || 'none')}${item.equipped ? ' · equipped' : ''}</span>`); }
function renderShops(items) { els.shops.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name || item.id)}</strong><span>${escapeHtml(item.type || 'shop')} · ${escapeHtml(item.locationId || 'world')} · stock ${(item.stock || []).length}</span><span>currency ${formatNumber(item.currency || 0)}</span>`); }
function renderCivilizations(items) { els.civilizations.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.level)} · score ${formatNumber(item.score)} · ${escapeHtml(item.dominantSpecies || 'unknown')}</span><div class="badge-row">${(item.values || []).slice(0, 5).map(value => `<span class="badge">${escapeHtml(value)}</span>`).join('')}</div>`); }
function renderCities(items) { els.cities.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.type || 'city')} · pop ${formatNumber(item.population)} · wealth ${formatNumber(item.wealth)}</span><span>security ${formatNumber(item.security)} · culture ${formatNumber(item.culture)} · infrastructure ${formatNumber(item.infrastructure)}</span>`); }
function renderOrganizations(items) { els.organizations.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.type)} · ${escapeHtml(item.status)} · members ${formatNumber(item.members)}</span><span>wealth ${formatNumber(item.wealth)} · authority ${formatNumber(item.authority)} · reputation ${formatNumber(item.reputation)}</span>`); }
function renderEntities(items) { els.entities.innerHTML = renderList(items, item => `<strong>${escapeHtml(item.name || item.entityId)}</strong><span>${escapeHtml(item.entityId)} · ${escapeHtml(item.status || 'unknown')}</span><span>score ${formatNumber(item.score)}</span>`); }

function renderSystems(snapshot) {
  const rows = [
    ['Players', `${snapshot.players?.active || 0}/${snapshot.players?.total || 0} active · commands ${snapshot.commands?.total || 0}`],
    ['Quests', `${snapshot.quests?.active || 0}/${snapshot.quests?.total || 0} active · claimed ${snapshot.quests?.claimed || 0}`],
    ['Tutorials', `${snapshot.tutorials?.active || 0}/${snapshot.tutorials?.total || 0} active · completed ${snapshot.tutorials?.completed || 0}`],
    ['Journal', `${snapshot.journals?.total || 0} entries · ${snapshot.journals?.players || 0} players`],
    ['Encounters', `${snapshot.encounters?.total || 0} total`],
    ['Quest Boards', `${snapshot.questBoards?.open || 0}/${snapshot.questBoards?.total || 0} open`],
    ['Items', `${snapshot.items?.instances || 0} instances · ${snapshot.items?.equipped || 0} equipped`],
    ['Shops', `${snapshot.shops?.total || 0} shops`],
    ['Infrastructure', `${snapshot.infrastructure?.active || 0}/${snapshot.infrastructure?.total || 0} active`],
    ['Governance', `${snapshot.governance?.active || 0}/${snapshot.governance?.total || 0} active · unrest ${formatNumber(snapshot.governance?.averageUnrest || 0)}`],
    ['Conflicts', `${snapshot.conflicts?.active || 0} active · casualties ${formatNumber(snapshot.conflicts?.casualties || 0)}`],
    ['Emergence', `${snapshot.emergence?.active || 0}/${snapshot.emergence?.total || 0} active`],
    ['Information', `${snapshot.information?.total || 0} items · ${snapshot.information?.knownOwners || 0} owners`],
    ['Memories', `${snapshot.memories?.total || 0} memories · ${snapshot.memories?.owners || 0} owners`],
  ];
  els.systems.innerHTML = renderList(rows, ([name, value]) => `<strong>${escapeHtml(name)}</strong><span>${escapeHtml(value)}</span>`);
}

function renderLimits(limits) { const rows = Object.entries(limits).map(([key, value]) => [key, value.current, value.limit]); els.limits.innerHTML = renderList(rows, ([key, current, limit]) => { const ratio = limit ? current / limit : 0; const label = ratio >= 0.9 ? 'near cap' : ratio >= 0.7 ? 'watch' : 'ok'; return `<strong>${escapeHtml(key)}</strong><span>${formatNumber(current)} / ${formatNumber(limit)} · ${label}</span>`; }); }
function renderReports(reports) { els.reports.innerHTML = renderList(reports.slice().reverse(), report => `<strong>tick ${formatNumber(report.tickAfter ?? report.tickBefore ?? 0)}</strong><span>births ${report.births || 0} · deaths ${report.deaths || 0} · actions ${report.completedActions || 0} · events ${report.processedEvents || 0}</span><span>players ${report.playersChanged || 0} · cities ${report.cityProcessed ? 'yes' : 'no'} · economy ${report.economyProcessed ? 'yes' : 'no'} · conflicts ${report.conflictsCreated || 0}</span>`); }
function renderList(items, renderer) { if (!items.length) return '<p class="muted">No data.</p>'; return `<div class="list">${items.map(item => `<div class="item">${renderer(item)}</div>`).join('')}</div>`; }
function setStatus(message) { els.status.textContent = message; }
function formatNumber(value) { const num = Number(value || 0); if (!Number.isFinite(num)) return value; return Math.round(num * 100) / 100; }
function escapeHtml(value) { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
async function boot() { try { const snapshot = await loadSnapshot(els.url.value); render(snapshot); await bootPerformance(false); } catch (error) { setStatus(error.message); } }
async function bootPerformance(showError = true) { try { const report = await loadJson(els.performanceUrl.value); renderPerformance(report); } catch (error) { renderPerformance(null); if (showError) setStatus(error.message); } }
els.load.addEventListener('click', () => boot());
els.loadPerformance.addEventListener('click', () => bootPerformance(true));
els.url.addEventListener('keydown', event => { if (event.key === 'Enter') boot(); });
els.performanceUrl.addEventListener('keydown', event => { if (event.key === 'Enter') bootPerformance(true); });
boot();
