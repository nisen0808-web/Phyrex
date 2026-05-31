'use strict';

const { ensureHistoryState, getEntityChronicle } = require('./history-engine');
const { scoreRelationship } = require('./relationship-engine');

const DEFAULT_SCORE_WEIGHTS = {
  lifeImportance: 1.0,
  majorEvents: 35,
  arcDiversity: 28,
  goalCompletions: 60,
  dreamCompletions: 220,
  relationshipNetwork: 8,
  hostilityNetwork: 6,
  causalityWeight: 1.4,
  factionInfluence: 18,
  survivalSpan: 0.15,
  deathBonus: 120,
};

const NOVEL_TIERS = [
  { id: 'none', minScore: 0, label: 'not selected', targetWords: 0 },
  { id: 'biography', minScore: 300, label: 'biography candidate', targetWords: 30000 },
  { id: 'short_novel', minScore: 900, label: 'short novel candidate', targetWords: 200000 },
  { id: 'long_novel', minScore: 2200, label: 'long novel candidate', targetWords: 1000000 },
  { id: 'epic', minScore: 6000, label: 'epic candidate', targetWords: 5000000 },
  { id: 'world_legend', minScore: 12000, label: 'world legend', targetWords: 10000000 },
];

function ensureNarrativeState(world) {
  if (!world.narrative) {
    world.narrative = {
      scoresByEntity: {},
      rankings: [],
      candidates: [],
      lastCalculatedTick: null,
    };
  }
  return world.narrative;
}

function calculateEntityNarrativeScore(world, entityId, options = {}) {
  ensureHistoryState(world);
  const weights = { ...DEFAULT_SCORE_WEIGHTS, ...(options.weights || {}) };
  const entity = world.entities[entityId];
  if (!entity) throw new Error(`Missing entity ${entityId}`);

  const chronicle = getEntityChronicle(world, entityId);
  const lifeEvents = chronicle.events || [];
  const arcs = chronicle.arcs || [];

  const lifeImportance = lifeEvents.reduce((sum, event) => sum + Number(event.importance || 0), 0);
  const majorEvents = lifeEvents.filter(event => Number(event.importance || 0) >= 80).length;
  const arcDiversity = new Set(arcs.map(arc => arc.key)).size;
  const goalCompletions = lifeEvents.filter(event => event.type === 'goal_completed').length;
  const dreamCompletions = lifeEvents.filter(event => event.type === 'goal_completed' && event.payload?.scope === 'dream').length;
  const deathEvents = lifeEvents.filter(event => event.type === 'death').length;
  const survivalSpan = estimateSurvivalSpan(lifeEvents, world.tick);

  const relationshipScore = calculateRelationshipNetworkScore(world, entityId);
  const causalityScore = calculateCausalityScore(world, entityId);
  const factionInfluence = calculateFactionInfluence(world, entity);

  const rawScore =
    lifeImportance * weights.lifeImportance +
    majorEvents * weights.majorEvents +
    arcDiversity * weights.arcDiversity +
    goalCompletions * weights.goalCompletions +
    dreamCompletions * weights.dreamCompletions +
    relationshipScore.cooperation * weights.relationshipNetwork +
    relationshipScore.hostility * weights.hostilityNetwork +
    causalityScore * weights.causalityWeight +
    factionInfluence * weights.factionInfluence +
    survivalSpan * weights.survivalSpan +
    deathEvents * weights.deathBonus;

  const tier = getNovelTier(rawScore);
  const score = {
    entityId,
    score: Math.round(rawScore),
    tier: tier.id,
    tierLabel: tier.label,
    targetWords: tier.targetWords,
    breakdown: {
      lifeImportance,
      majorEvents,
      arcDiversity,
      goalCompletions,
      dreamCompletions,
      relationshipNetwork: relationshipScore,
      causalityScore,
      factionInfluence,
      survivalSpan,
      deathEvents,
    },
    updatedAt: world.tick,
  };

  ensureNarrativeState(world).scoresByEntity[entityId] = score;
  return score;
}

function calculateAllNarrativeScores(world, options = {}) {
  const narrative = ensureNarrativeState(world);
  const scores = [];

  for (const entityId of Object.keys(world.entities)) {
    scores.push(calculateEntityNarrativeScore(world, entityId, options));
  }

  scores.sort((a, b) => b.score - a.score);
  narrative.rankings = scores.map((score, index) => ({
    rank: index + 1,
    entityId: score.entityId,
    score: score.score,
    tier: score.tier,
    targetWords: score.targetWords,
  }));

  narrative.candidates = scores
    .filter(score => score.tier !== 'none')
    .map((score, index) => ({
      rank: index + 1,
      entityId: score.entityId,
      score: score.score,
      tier: score.tier,
      targetWords: score.targetWords,
      status: world.entities[score.entityId]?.status || 'unknown',
    }));

  narrative.lastCalculatedTick = world.tick;
  return narrative;
}

function getTopNarrativeEntities(world, limit = 20, options = {}) {
  const narrative = ensureNarrativeState(world);
  if (!narrative.rankings.length || options.recalculate) calculateAllNarrativeScores(world, options);
  return narrative.rankings.slice(0, limit);
}

function getNovelCandidates(world, options = {}) {
  const narrative = ensureNarrativeState(world);
  if (!narrative.candidates.length || options.recalculate) calculateAllNarrativeScores(world, options);
  const minTier = options.minTier || 'biography';
  const minTierIndex = NOVEL_TIERS.findIndex(tier => tier.id === minTier);
  return narrative.candidates.filter(candidate => {
    const index = NOVEL_TIERS.findIndex(tier => tier.id === candidate.tier);
    return index >= minTierIndex;
  });
}

function calculateRelationshipNetworkScore(world, entityId) {
  let cooperation = 0;
  let hostility = 0;
  let meaningfulConnections = 0;

  for (const otherId of Object.keys(world.entities)) {
    if (otherId === entityId) continue;
    const score = scoreRelationship(world, entityId, otherId);
    const magnitude = Math.max(Math.abs(score.cooperation), Math.abs(score.hostility));
    if (magnitude < 5) continue;
    meaningfulConnections += 1;
    cooperation += Math.max(0, score.cooperation) / 20;
    hostility += Math.max(0, score.hostility) / 20;
  }

  return {
    cooperation: Math.round(cooperation + meaningfulConnections * 0.5),
    hostility: Math.round(hostility + meaningfulConnections * 0.35),
    meaningfulConnections,
  };
}

function calculateCausalityScore(world, entityId) {
  return (world.causality || []).reduce((sum, cause) => {
    if (cause.sourceId === entityId || cause.targetId === entityId) {
      return sum + Number(cause.weight || 1);
    }
    return sum;
  }, 0);
}

function calculateFactionInfluence(world, entity) {
  if (!entity.factionId) return 0;
  const members = world.indexes?.entitiesByFaction?.[entity.factionId] || [];
  const role = entity.meta?.role || '';
  const roleBonus = role === 'leader' ? 20 : role === 'elite' ? 8 : 2;
  return members.length + roleBonus;
}

function estimateSurvivalSpan(lifeEvents, currentTick) {
  if (!lifeEvents.length) return 0;
  const first = lifeEvents[0].tick || 0;
  const last = lifeEvents[lifeEvents.length - 1].tick || currentTick;
  return Math.max(0, last - first);
}

function getNovelTier(score) {
  let selected = NOVEL_TIERS[0];
  for (const tier of NOVEL_TIERS) {
    if (score >= tier.minScore) selected = tier;
  }
  return selected;
}

function explainNarrativeScore(world, entityId) {
  const narrative = ensureNarrativeState(world);
  const score = narrative.scoresByEntity[entityId] || calculateEntityNarrativeScore(world, entityId);
  const entity = world.entities[entityId];
  return {
    entityId,
    name: entity?.name || entityId,
    score: score.score,
    tier: score.tier,
    targetWords: score.targetWords,
    reasons: buildReasons(score.breakdown),
    breakdown: score.breakdown,
  };
}

function buildReasons(breakdown) {
  const reasons = [];
  if (breakdown.lifeImportance > 300) reasons.push('accumulated many important life events');
  if (breakdown.majorEvents >= 5) reasons.push('participated in multiple major events');
  if (breakdown.dreamCompletions > 0) reasons.push('completed a dream-level goal');
  if (breakdown.relationshipNetwork.meaningfulConnections >= 10) reasons.push('formed a wide relationship network');
  if (breakdown.relationshipNetwork.hostility >= 20) reasons.push('generated significant conflict pressure');
  if (breakdown.causalityScore > 100) reasons.push('appears frequently in causality chains');
  if (breakdown.factionInfluence > 20) reasons.push('has meaningful faction influence');
  if (breakdown.deathEvents > 0) reasons.push('life has reached an ending point');
  if (!reasons.length) reasons.push('not enough legendary material yet');
  return reasons;
}

module.exports = {
  DEFAULT_SCORE_WEIGHTS,
  NOVEL_TIERS,
  ensureNarrativeState,
  calculateEntityNarrativeScore,
  calculateAllNarrativeScores,
  getTopNarrativeEntities,
  getNovelCandidates,
  calculateRelationshipNetworkScore,
  calculateCausalityScore,
  calculateFactionInfluence,
  getNovelTier,
  explainNarrativeScore,
};
