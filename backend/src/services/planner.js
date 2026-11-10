// Orchestrates one route search: geocode -> OSRM routes -> ML traffic -> travel time -> cost -> score -> explain.
const config = require('../config');
const { AppError, formatDuration } = require('../utils');
const geocode = require('./geocode');
const routing = require('./routing');
const ml = require('./mlClient');
const ai = require('./ai');
const { warn } = require('../log');
const db = require('./db');
const roadQuality = require('./roadQuality');
const scenery = require('./scenery');
const { buildWeights, scoreRoutes, effectiveWeights, restrictAxes } = require('./scoring');
const { User, Trip, PREFERENCES } = require('../models');

const round3 = (x) => Math.round(x * 1000) / 1000;
const pad = (n) => String(n).padStart(2, '0');

function parseDeparture(date, time) {
  const now = new Date();
  const d = date || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const t = time || `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) throw new AppError(400, 'Please provide a valid date (YYYY-MM-DD).', 'BAD_DATE');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new AppError(400, 'Please provide a valid time (HH:MM, 24-hour).', 'BAD_TIME');
  const jsDow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const dayOfWeek = (jsDow + 6) % 7; // 0 = Monday (matches the ML dataset)
  return { date: d, time: t, hour: Number(t.slice(0, 2)), dayOfWeek, weekend: dayOfWeek >= 5 };
}

/** Rough road class from average free-flow speed (highways are faster than city streets). */
const routeTypeOf = (r) => {
  const speed = r.distanceKm / (r.baseMinutes / 60);
  return speed >= 65 ? 'highway' : speed >= 45 ? 'mixed' : 'city';
};

/** Cost estimate in INR: fuel (scaled by congestion) + rough toll on highway-like share. Configurable. */
function estimateCost(r, level) {
  const { perKm, tollPerKm, trafficFuelFactor } = config.cost;
  const speed = r.distanceKm / (r.baseMinutes / 60);
  const highwayShare = Math.max(0, Math.min(1, (speed - 45) / 30));
  const fuel = r.distanceKm * perKm * trafficFuelFactor[level];
  const toll = r.distanceKm * tollPerKm * highwayShare;
  return { total: Math.round(fuel + toll), fuel: Math.round(fuel), toll: Math.round(toll) };
}

async function loadPersonalisation(userId, warnings) {
  if (!userId || !db.isReady()) return { history: [], preferredMode: null };
  try {
    const [user, trips] = await Promise.all([
      User.findById(userId).lean(),
      Trip.find({ userId }).sort({ createdAt: -1 }).limit(10).lean(),
    ]);
    return { history: trips.map((t) => t.preference), preferredMode: user?.preferences?.preferredMode || null, notes: user?.preferences?.notes || '' };
  } catch (err) {
    warn('DATABASE', `personalisation skipped: ${err.message}`);
    warnings.push('Personalisation is unavailable right now.');
    return { history: [], preferredMode: null };
  }
}

/** Resolves with `fallback()` if `promise` has not settled within `ms` - a slow public server must not block the search. */
function withBudget(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback()), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const asked = (level) => level === 'MEDIUM' || level === 'HIGH';

/** The most the traveller accepts being slower than the fastest route, from their notes ("not much longer", "no more than 20 minutes"). */
function constraintsOf(priorities) {
  const d = priorities?.detour;
  if (!d) return null;
  const c = {};
  if (Number.isFinite(d.maxExtraPercent)) c.maxExtraPercent = d.maxExtraPercent;
  if (Number.isFinite(d.maxExtraMinutes)) c.maxExtraMinutes = d.maxExtraMinutes;
  return Object.keys(c).length ? c : null;
}

const describeConstraint = (c) => {
  const parts = [];
  if (c.maxExtraPercent !== undefined) parts.push(`${c.maxExtraPercent}%`);
  if (c.maxExtraMinutes !== undefined) parts.push(`${c.maxExtraMinutes} min`);
  return c.implicit
    ? `Routes more than ${parts.join(' or ')} slower than the fastest route are never recommended for road or scenery preferences (safety limit).`
    : `Routes more than ${parts.join(' or ')} slower than the fastest route were not eligible, as you asked.`;
};

async function searchRoutes({ origin, destination, date, time, preference, notes, weather, userId }) {
  if (preference && preference !== 'AUTO' && !PREFERENCES.includes(preference)) throw new AppError(400, `Unknown preference. Use ${PREFERENCES.join(', ')} or AUTO.`, 'BAD_PREFERENCE');
  if (weather && !['clear', 'cloudy', 'rain', 'fog'].includes(weather)) throw new AppError(400, 'Unknown weather value.', 'BAD_WEATHER');
  if (notes && String(notes).length > 300) throw new AppError(400, 'Preference notes must be 300 characters or fewer.', 'BAD_NOTES');

  const departure = parseDeparture(date, time);
  const warnings = [];

  const from = await geocode.resolvePlace(origin, 'Origin');
  const to = await geocode.resolvePlace(destination, 'Destination');
  if (Math.abs(from.lat - to.lat) < 1e-4 && Math.abs(from.lon - to.lon) < 1e-4) throw new AppError(400, 'Origin and destination are the same place.', 'SAME_PLACE');

  const personal = await loadPersonalisation(userId, warnings);
  const noteText = notes || '';
  const interpretation = await ai.parsePreferences(noteText);
  const chosen = preference && preference !== 'AUTO' ? preference : (interpretation.preference || personal.preferredMode || 'BALANCED');

  const routing_ = await routing.getRoutes(from, to); // throws (503/422) if OSRM fails - no fake routes
  warnings.push(...routing_.warnings);
  const wx = weather || 'clear';

  // --- ML: traffic level per route ---
  const items = routing_.routes.map((r) => ({
    hour: departure.hour, day_of_week: departure.dayOfWeek, weekend: departure.weekend,
    distance: Math.max(0.1, Math.round(r.distanceKm * 10) / 10), rain: wx === 'rain', weather: wx, route_type: routeTypeOf(r),
  }));
  const { results: traffic, mlAvailable, meta: mlMeta } = await ml.predictTrafficBatch(items);
  if (!mlAvailable) warnings.push('ML service unavailable — fallback prediction used.');
  const tt = await ml.predictTravelTimes(routing_.routes.map((r) => r.baseMinutes), traffic.map((t) => t.traffic_level), mlAvailable);
  if (mlAvailable && tt.source !== 'ml-service') warnings.push('Travel-time endpoint unavailable — configured traffic multipliers were applied locally.');

  const routes = routing_.routes.map((r, i) => {
    const level = traffic[i].traffic_level;
    const durationMinutes = tt.minutes[i];
    const cost = estimateCost(r, level);
    return {
      id: String.fromCharCode(65 + i), label: `Route ${String.fromCharCode(65 + i)}`,
      distanceKm: Math.round(r.distanceKm * 10) / 10,
      baseMinutes: Math.round(r.baseMinutes * 10) / 10, durationMinutes, durationText: formatDuration(durationMinutes),
      routeType: items[i].route_type,
      traffic: { level, confidence: traffic[i].confidence, probabilities: traffic[i].probabilities, source: traffic[i].source },
      cost: cost.total, costBreakdown: { fuel: cost.fuel, toll: cost.toll },
      via: r.via, geometry: r.geometry,
    };
  });

  // --- Optional OpenStreetMap enrichment: only when this search asks for road conditions or scenery ---
  const priorities = noteText ? interpretation.priorities : null;
  const personalHistory = [...personal.history, ...(personal.preferredMode && personal.preferredMode !== 'BALANCED' ? [personal.preferredMode] : [])]; // a non-default saved mode counts as one extra vote
  const wantRoad = chosen === 'BETTER_ROADS' || asked(priorities?.roadPriority);
  const wantScenery = chosen === 'BETTER_SCENERY' || asked(priorities?.sceneryPriority);
  const budget = config.overpass.budgetMs;
  const opts = { deadline: Date.now() + budget };
  const [roadRes, sceneryRes] = await Promise.all([
    wantRoad ? withBudget(roadQuality.assessRoads(routing_.routes, opts), budget + 1500, () => roadQuality.unavailableFor(routes.length, 'the OpenStreetMap service took too long to answer.')) : null,
    wantScenery ? withBudget(scenery.assessScenery(routing_.routes, priorities?.sceneryCategories, opts), budget + 1500, () => scenery.unavailableFor(routes.length, 'the OpenStreetMap service took too long to answer.')) : null,
  ]);
  routes.forEach((r, i) => {
    if (roadRes) r.roadQuality = roadRes.perRoute[i];
    if (sceneryRes) r.scenery = sceneryRes.perRoute[i];
  });
  if (roadRes && !roadRes.available) warnings.push(`Road quality data unavailable: ${roadRes.reason} The recommendation is based only on the attributes that are available (time, traffic, cost).`);
  if (sceneryRes && !sceneryRes.available) warnings.push(`Scenery information unavailable: ${sceneryRes.reason} The recommendation is based only on the attributes that are available (time, traffic, cost).`);
  if (roadRes?.available && roadRes.meta?.note) warnings.push(`Road quality data is incomplete: ${roadRes.meta.note.replace(/^incomplete: /, '')}.`);
  if (sceneryRes?.available && sceneryRes.incomplete) warnings.push(`Scenery data is incomplete: ${sceneryRes.meta.note.replace(/^incomplete: /, '')}. Scores count only the places that could be retrieved and may understate a route's scenery, so the scenery comparison is less reliable.`);
  if (wantRoad && priorities?.unsupported?.length) warnings.push(`Your notes mention ${priorities.unsupported.join(' and ')}. That information is not available from the data sources used, so road ranking uses only documented surface and smoothness tags.`);

  // --- Scoring (+ light personalisation from preferences and trip history) ---
  const w = buildWeights(chosen, priorities, personalHistory);
  const requestedWeights = restrictAxes(w.weights, { road: wantRoad, scenery: wantScenery });
  const eff = effectiveWeights(routes, requestedWeights); // an axis with no data at all is dropped and the rest renormalised
  const explicit = constraintsOf(priorities);
  const usesExtraAxis = eff.weights.road > 0 || eff.weights.scenery > 0;
  const constraints = explicit || (usesExtraAxis ? { maxExtraPercent: config.maxDetourPercent, implicit: true } : null);
  const best = scoreRoutes(routes, eff.weights, { constraints });
  const excluded = routes.some((r) => !r.withinTimeLimit);
  const constraintText = constraints && routes.length > 1 && (excluded || !constraints.implicit) ? describeConstraint(constraints) : null;
  if (explicit && routes.length > 1 && !excluded) warnings.push('Your limit on extra travel time did not exclude any route.');

  const mlSource = mlAvailable ? 'ml-model' : 'heuristic-fallback';
  const others = routes.filter((r) => r !== best);
  const explanation = await ai.explain({ recommended: best, others, preference: chosen, weights: eff.weights, mlSource, unavailable: eff.dropped, constraint: constraintText });

  return {
    origin: from, destination: to, departure, preference: chosen, weather: wx,
    weights: { time: round3(eff.weights.time), traffic: round3(eff.weights.traffic), cost: round3(eff.weights.cost), road: round3(eff.weights.road), scenery: round3(eff.weights.scenery) },
    ...(eff.dropped.length ? { weightsDroppedForMissingData: eff.dropped } : {}),
    roadQuality: roadRes ? { requested: true, available: roadRes.available, reason: roadRes.reason } : { requested: false },
    scenery: sceneryRes ? { requested: true, available: sceneryRes.available, reason: sceneryRes.reason, ...(sceneryRes.incomplete ? { incomplete: true } : {}), categories: priorities?.sceneryCategories?.length ? priorities.sceneryCategories : null } : { requested: false },
    constraints,
    personalization: { applied: w.personalised, basedOnTrips: w.historyCount, notes: w.notes },
    aiInterpretation: noteText ? { text: noteText, ...interpretation } : null,
    routes, recommendedRoute: best, reason: explanation.text, reasonSource: explanation.source,
    mlSource,
    disclaimer: 'Traffic prediction is based on the academic/demo training dataset and is not live traffic data. OSRM provides road routing, not live traffic. Costs are rough estimates.',
    warnings,
    // What actually ran for this search (developer diagnostics; no credentials).
    diagnostics: {
      geocoding: { origin: from.lookup, destination: to.lookup },
      routing: routing_.meta,
      ml: { ...mlMeta, source: mlSource, travelTime: tt.source },
      ai: { preferenceParsing: noteText ? interpretation.source : 'not requested', explanation: explanation.source },
      database: { personalisationUsed: w.personalised, tripsConsidered: w.historyCount },
      overpass: { roadTags: roadRes ? roadRes.meta : 'not requested', scenery: sceneryRes ? sceneryRes.meta : 'not requested' },
    },
  };
}

module.exports = { searchRoutes, parseDeparture, routeTypeOf, estimateCost };
