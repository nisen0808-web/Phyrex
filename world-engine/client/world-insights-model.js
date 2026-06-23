'use strict';

(function exposeWorldInsightsModel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MudWorldInsights = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  function buildInsightView(snapshot = {}, options = {}) {
    const world = snapshot.world || {};
    const population = snapshot.population || {};
    const players = snapshot.players || {};
    const quests = snapshot.quests || {};
    const commands = snapshot.commands || {};
    const offline = snapshot.offlineCommands || {};
    const items = snapshot.items || {};
    const shops = snapshot.shops || {};

    return {
      world: {
        id: world.id || null,
        tick: numberOr(world.tick, 0),
        calendar: world.calendar ? { ...world.calendar } : null,
      },
      metrics: {
        population: numberOr(population.total, 0),
        alive: numberOr(population.alive, 0),
        dead: numberOr(population.dead, 0),
        averagePower: numberOr(population.averagePower, 0),
        averageHappiness: numberOr(population.averageHappiness, 0),
        players: numberOr(players.total, 0),
        quests: numberOr(quests.total, 0),
        activeQuests: numberOr(quests.active, 0),
        commands: numberOr(commands.total, 0),
        offlineCommands: numberOr(offline.total, 0),
        items: numberOr(items.instances, 0),
        shops: numberOr(shops.total, 0),
      },
      locations: rankCountMap(population.byLocation, options.locationLimit || 20),
      species: rankCountMap(population.bySpecies, options.speciesLimit || 12),
      rankings: {
        entities: normalizeEntityRankings(snapshot.narrative?.topEntities || [], options.rankingLimit || 10),
        cities: normalizeCityRankings(snapshot.cities || [], options.rankingLimit || 10),
        organizations: normalizeOrganizationRankings(snapshot.organizations || [], options.rankingLimit || 10),
        civilizations: normalizeCivilizationRankings(snapshot.civilizations || [], options.rankingLimit || 10),
      },
      activity: mergeActivity(snapshot, options.activityLimit || 30),
      diagnostics: buildDiagnostics(snapshot),
    };
  }

  function rankCountMap(input, limit = 20) {
    const entries = Object.entries(input || {})
      .map(([id, value]) => ({ id, name: id, value: numberOr(value, 0) }))
      .sort((left, right) => right.value - left.value || left.id.localeCompare(right.id));
    const total = entries.reduce((sum, entry) => sum + entry.value, 0);
    return entries.slice(0, Math.max(1, Number(limit || 20))).map(entry => ({
      ...entry,
      share: total > 0 ? entry.value / total : 0,
    }));
  }

  function normalizeEntityRankings(items, limit) {
    return (items || []).map((item, index) => ({
      id: item.entityId || item.id || `entity_${index + 1}`,
      name: item.name || item.entityName || item.entityId || item.id || `Entity ${index + 1}`,
      score: numberOr(item.totalScore ?? item.score ?? item.power, 0),
      subtitle: [item.species, item.locationId].filter(Boolean).join(' · '),
      raw: { ...item },
    })).sort(compareRank).slice(0, limit);
  }

  function normalizeCityRankings(items, limit) {
    return (items || []).map((item, index) => ({
      id: item.id || `city_${index + 1}`,
      name: item.name || item.id || `City ${index + 1}`,
      score: numberOr(item.population, 0) + numberOr(item.wealth, 0) + numberOr(item.security, 0),
      subtitle: `人口 ${numberOr(item.population, 0)} · 财富 ${numberOr(item.wealth, 0)} · 治安 ${numberOr(item.security, 0)}`,
      raw: { ...item },
    })).sort(compareRank).slice(0, limit);
  }

  function normalizeOrganizationRankings(items, limit) {
    return (items || []).map((item, index) => ({
      id: item.id || `organization_${index + 1}`,
      name: item.name || item.id || `Organization ${index + 1}`,
      score: numberOr(item.members, 0) + numberOr(item.authority, 0) + numberOr(item.reputation, 0) + numberOr(item.wealth, 0) * 0.02,
      subtitle: `成员 ${numberOr(item.members, 0)} · 权威 ${numberOr(item.authority, 0)} · 声望 ${numberOr(item.reputation, 0)}`,
      raw: { ...item },
    })).sort(compareRank).slice(0, limit);
  }

  function normalizeCivilizationRankings(items, limit) {
    return (items || []).map((item, index) => ({
      id: item.id || `civilization_${index + 1}`,
      name: item.name || item.id || `Civilization ${index + 1}`,
      score: numberOr(item.score, 0),
      subtitle: `等级 ${item.level ?? '-'} · 城市 ${numberOr(item.cities, 0)} · 组织 ${numberOr(item.organizations, 0)}`,
      raw: { ...item },
    })).sort(compareRank).slice(0, limit);
  }

  function mergeActivity(snapshot, limit = 30) {
    const activity = [];
    pushActivity(activity, snapshot.journals?.recent, 'journal', entry => ({
      id: entry.id,
      tick: entry.tick,
      title: entry.title || entry.type || '日志',
      summary: entry.summary || '',
      category: entry.type || 'journal',
    }));
    pushActivity(activity, snapshot.encounters?.recent, 'encounter', entry => ({
      id: entry.id,
      tick: entry.tick ?? entry.resolvedAt ?? entry.createdAt,
      title: entry.title || entry.type || '遭遇',
      summary: entry.summary || entry.status || '',
      category: entry.type || 'encounter',
    }));
    pushActivity(activity, snapshot.commands?.recent, 'command', entry => ({
      id: entry.id,
      tick: entry.tick ?? entry.updatedAt ?? entry.createdAt,
      title: entry.type || '命令',
      summary: entry.status || entry.result?.reason || '',
      category: entry.status || 'command',
    }));
    pushActivity(activity, snapshot.recentReports, 'report', entry => ({
      id: entry.id,
      tick: entry.tick ?? entry.createdAt,
      title: entry.title || entry.type || '世界报告',
      summary: entry.summary || entry.message || '',
      category: entry.type || 'report',
    }));

    return activity
      .sort((left, right) => sortableTime(right.tick) - sortableTime(left.tick))
      .slice(0, Math.max(1, Number(limit || 30)));
  }

  function pushActivity(target, items, source, mapper) {
    for (const [index, item] of (items || []).entries()) {
      const mapped = mapper(item || {});
      target.push({
        id: mapped.id || `${source}_${index + 1}`,
        source,
        tick: mapped.tick ?? null,
        title: mapped.title || source,
        summary: mapped.summary || '',
        category: mapped.category || source,
      });
    }
  }

  function filterActivity(items, query = '', source = '') {
    const text = normalizeText(query);
    return (items || []).filter(item => {
      if (source && source !== 'all' && item.source !== source) return false;
      if (!text) return true;
      return normalizeText([item.title, item.summary, item.category, item.source].join(' ')).includes(text);
    });
  }

  function buildDiagnostics(snapshot) {
    const limits = snapshot.limits || {};
    const counters = snapshot.counters || {};
    const governance = snapshot.governance || {};
    const conflicts = snapshot.conflicts || {};
    const infrastructure = snapshot.infrastructure || {};
    return {
      limits: { ...limits },
      counters: { ...counters },
      governance: { ...governance },
      conflicts: { ...conflicts },
      infrastructure: { ...infrastructure },
      processes: { ...(snapshot.processes || {}) },
      emergence: { ...(snapshot.emergence || {}) },
      technology: { ...(snapshot.technology || {}) },
    };
  }

  function createTextSummary(view) {
    const topLocation = view.locations?.[0];
    const topEntity = view.rankings?.entities?.[0];
    const topOrganization = view.rankings?.organizations?.[0];
    return [
      `World ${view.world.id || '-'} tick ${view.world.tick ?? '-'}`,
      `Population ${view.metrics.alive}/${view.metrics.population} alive`,
      `Players ${view.metrics.players} · quests ${view.metrics.activeQuests}/${view.metrics.quests} active`,
      topLocation ? `Largest location ${topLocation.name}: ${topLocation.value}` : null,
      topEntity ? `Top entity ${topEntity.name}: ${round(topEntity.score)}` : null,
      topOrganization ? `Top organization ${topOrganization.name}: ${round(topOrganization.score)}` : null,
    ].filter(Boolean).join('\n');
  }

  function compareRank(left, right) {
    return right.score - left.score || left.name.localeCompare(right.name);
  }

  function sortableTime(value) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    const parsed = Date.parse(value || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function normalizeText(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().trim();
  }

  function numberOr(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function round(value) {
    return Math.round(numberOr(value, 0) * 100) / 100;
  }

  return {
    buildInsightView,
    rankCountMap,
    normalizeEntityRankings,
    normalizeCityRankings,
    normalizeOrganizationRankings,
    normalizeCivilizationRankings,
    mergeActivity,
    filterActivity,
    buildDiagnostics,
    createTextSummary,
  };
}));
