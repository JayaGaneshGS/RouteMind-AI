// Route scoring: weighted sum of sub-scores, each normalised to 0-100 so kilometres, minutes, rupees and POI
// points are never compared directly. Weights depend on the user's preference, optional AI-parsed priorities, and
// (lightly) trip history.
//
// Axes: time, traffic, cost (always available) and road, scenery (only when the search asks for them AND the
// OpenStreetMap data could be retrieved). The four original presets give road/scenery a weight of 0, so their scores
// are exactly what they were before these axes existed.

const PRESETS = {
  FASTEST:     { time: 0.55, traffic: 0.30, cost: 0.15 },
  CHEAPEST:    { time: 0.30, traffic: 0.15, cost: 0.55 },
  LOW_TRAFFIC: { time: 0.30, traffic: 0.55, cost: 0.15 },
  BALANCED:    { time: 1 / 3, traffic: 1 / 3, cost: 1 / 3 },
  // The requested attribute gets half of the weight; the other half keeps the route practical (time and traffic
  // 20 % / 15-20 % each, cost 10 %). These are design choices, not fitted values - see README "Route scoring".
  BETTER_ROADS:   { time: 0.20, traffic: 0.20, cost: 0.10, road: 0.50, scenery: 0 },
  BETTER_SCENERY: { time: 0.25, traffic: 0.15, cost: 0.10, road: 0, scenery: 0.50 },
};
const AXES = ['time', 'traffic', 'cost', 'road', 'scenery'];
const CORE = ['time', 'traffic', 'cost'];
const PRIORITY_MULT = { LOW: 0.6, MEDIUM: 1, HIGH: 1.6 };
const COMFORT_TRAFFIC_BOOST = 1.25;
const HISTORY_BLEND = 0.15; // how strongly past choices nudge the weights
const MIN_HISTORY = 2;
// Minimum final share given to road/scenery when the notes ask for them (NONE = not asked = no change).
const EXTRA_AXIS_FLOOR = { MEDIUM: 0.2, HIGH: 0.4 };
const MAX_EXTRA_SHARE = 0.8; // road + scenery can never take more than 80 % - time/traffic/cost always keep a say

const get = (preset, k) => preset[k] ?? 0;
const sum = (w) => AXES.reduce((s, k) => s + (w[k] || 0), 0);
const normalise = (w) => {
  const s = sum(w) || 1;
  return Object.fromEntries(AXES.map((k) => [k, (w[k] || 0) / s]));
};

/** Expected congestion 0..1 from the classifier's class probabilities. */
const trafficIndex = (p = {}) => (p.MEDIUM || 0) * 0.5 + (p.HIGH || 0) * 1;

function buildWeights(preference, priorities, historyPrefs = []) {
  const preset = PRESETS[preference] || PRESETS.BALANCED;
  const notes = [];

  // 1. time / traffic / cost part (exactly the original behaviour)
  let core = { time: preset.time, traffic: preset.traffic, cost: preset.cost };
  if (priorities) {
    core = {
      time: core.time * (PRIORITY_MULT[priorities.timePriority] ?? 1),
      traffic: core.traffic * (PRIORITY_MULT[priorities.trafficPriority] ?? 1) * (priorities.comfortPriority === 'HIGH' ? COMFORT_TRAFFIC_BOOST : 1),
      cost: core.cost * (PRIORITY_MULT[priorities.costPriority] ?? 1),
    };
    notes.push('natural-language priorities applied');
  }
  const coreSum = CORE.reduce((s, k) => s + core[k], 0);

  // 2. road / scenery shares: the preset's own share, raised to the floor if the notes ask for it
  let road = get(preset, 'road'); let scenery = get(preset, 'scenery');
  if (priorities) {
    road = Math.max(road, EXTRA_AXIS_FLOOR[priorities.roadPriority] || 0);
    scenery = Math.max(scenery, EXTRA_AXIS_FLOOR[priorities.sceneryPriority] || 0);
    if (road > get(preset, 'road') || scenery > get(preset, 'scenery')) notes.push('road/scenery priorities from your notes applied');
  }
  const extra = road + scenery;
  if (extra > MAX_EXTRA_SHARE) { road *= MAX_EXTRA_SHARE / extra; scenery *= MAX_EXTRA_SHARE / extra; }
  const room = 1 - road - scenery;
  let w = { time: (core.time / coreSum) * room, traffic: (core.traffic / coreSum) * room, cost: (core.cost / coreSum) * room, road, scenery };
  w = normalise(w);

  let personalised = false;
  const usable = historyPrefs.filter((p) => PRESETS[p]);
  if (usable.length >= MIN_HISTORY) {
    const avg = Object.fromEntries(AXES.map((k) => [k, 0]));
    for (const p of usable) for (const k of AXES) avg[k] += get(PRESETS[p], k) / usable.length;
    w = normalise(Object.fromEntries(AXES.map((k) => [k, (1 - HISTORY_BLEND) * w[k] + HISTORY_BLEND * avg[k]])));
    personalised = true;
    notes.push(`blended ${Math.round(HISTORY_BLEND * 100)}% with your last ${usable.length} trip preferences`);
  }
  return { weights: w, personalised, historyCount: usable.length, notes };
}

const hasRoad = (r) => r.roadQuality?.available === true && Number.isFinite(r.roadQuality.score);
const hasScenery = (r) => r.scenery?.available === true && Number.isFinite(r.scenery.score);

/**
 * Drops an axis whose data is unavailable for EVERY route (OpenStreetMap could not be read) and renormalises the rest,
 * so the recommendation is based only on what is actually known. Returns { weights, dropped: ['road'|'scenery'...] }.
 */
function effectiveWeights(routes, weights) {
  const w = { ...weights };
  const dropped = [];
  if (w.road > 0 && !routes.some(hasRoad)) { w.road = 0; dropped.push('road'); }
  if (w.scenery > 0 && !routes.some(hasScenery)) { w.scenery = 0; dropped.push('scenery'); }
  if (!dropped.length) return { weights: w, dropped };
  // Nothing left but the dropped axes? Fall back to equal time/traffic/cost rather than dividing by zero.
  if (CORE.every((k) => !w[k]) && !w.road && !w.scenery) CORE.forEach((k) => { w[k] = 1 / 3; });
  return { weights: normalise(w), dropped };
}

/** Zeroes road/scenery when the search did not ask for them (e.g. weight leaking in from trip history) and renormalises. */
function restrictAxes(weights, { road, scenery }) {
  return normalise({ ...weights, road: road ? weights.road : 0, scenery: scenery ? weights.scenery : 0 });
}

/**
 * routes: [{durationMinutes, cost, traffic:{probabilities}, roadQuality?, scenery?}]
 * Adds `score` (0-100) and `scoreBreakdown` (each 0-100, higher is better). Returns the best route.
 *  - time sub-score    = 100 x fastest / this route
 *  - cost sub-score    = 100 x cheapest / this route
 *  - traffic sub-score = 100 x (1 - expected congestion)
 *  - road sub-score    = roadQuality.score  (documented-surface points per route length, see roadQuality.js)
 *  - scenery sub-score = scenery.score      (saturating relevance-weighted POI points, see scenery.js)
 * options.constraints = { maxExtraPercent, maxExtraMinutes }: routes slower than the fastest by more than that are
 * still scored but cannot be the recommendation (the fastest route always qualifies).
 */
function scoreRoutes(routes, weights, options = {}) {
  const minTime = Math.min(...routes.map((r) => r.durationMinutes));
  const minCost = Math.min(...routes.map((r) => r.cost));
  const c = options.constraints || {};
  const maxMinutes = Math.min(
    Number.isFinite(c.maxExtraPercent) ? minTime * (1 + c.maxExtraPercent / 100) : Infinity,
    Number.isFinite(c.maxExtraMinutes) ? minTime + c.maxExtraMinutes : Infinity,
  );
  for (const r of routes) {
    const b = {
      time: (100 * minTime) / r.durationMinutes,
      traffic: 100 * (1 - trafficIndex(r.traffic.probabilities)),
      cost: (100 * minCost) / r.cost,
    };
    const breakdown = { time: round1(b.time), traffic: round1(b.traffic), cost: round1(b.cost) };
    let total = weights.time * b.time + weights.traffic * b.traffic + weights.cost * b.cost;
    if (weights.road > 0) { b.road = hasRoad(r) ? r.roadQuality.score : 0; total += weights.road * b.road; breakdown.road = round1(b.road); }
    if (weights.scenery > 0) { b.scenery = hasScenery(r) ? r.scenery.score : 0; total += weights.scenery * b.scenery; breakdown.scenery = round1(b.scenery); }
    r.scoreBreakdown = breakdown;
    r.score = round1(Math.max(0, Math.min(100, total)));
    r.withinTimeLimit = r.durationMinutes <= maxMinutes + 1e-9;
  }
  const eligible = routes.filter((r) => r.withinTimeLimit);
  return eligible.reduce((best, r) => (r.score > best.score || (r.score === best.score && r.durationMinutes < best.durationMinutes) ? r : best));
}

const round1 = (x) => Math.round(x * 10) / 10;

module.exports = { PRESETS, AXES, buildWeights, scoreRoutes, effectiveWeights, restrictAxes, trafficIndex };
