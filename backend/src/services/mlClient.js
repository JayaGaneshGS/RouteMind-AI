// Client for the Python FastAPI ML service (RandomForest traffic classifier).
// If the service is down a clearly-labelled rule-of-thumb is used (ML_FALLBACK=off disables it and
// the search fails instead). The response always says which engine produced the traffic level
// (`source`), so a fallback can never pass for the trained model.
const config = require('../config');
const { AppError } = require('../utils');
const { log, warn, safeUrl } = require('../log');
const diagnostics = require('../diagnostics');

async function call(path, body) {
  const res = await fetch(`${config.mlServiceUrl}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(config.mlTimeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`ML service HTTP ${res.status} ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** items: [{hour, day_of_week, weekend, distance, rain, weather, route_type}] */
async function predictTrafficBatch(items) {
  log('ML', `Calling Python ML service (${safeUrl(config.mlServiceUrl)}) | Model: RandomForest | routes: ${items.length}`);
  const t0 = Date.now();
  try {
    const { results } = await call('/predict-traffic/batch', { items });
    const ms = Date.now() - t0;
    diagnostics.record('ml', { ok: true, ms });
    log('ML', `Traffic: ${results.map((r) => `${r.traffic_level} (${Math.round(r.confidence * 100)}%)`).join(', ')} (${ms} ms)`);
    return { results: results.map((r) => ({ ...r, source: 'ml-model' })), mlAvailable: true, meta: { provider: 'Python FastAPI ML service', model: 'RandomForest', ms } };
  } catch (err) {
    const ms = Date.now() - t0;
    diagnostics.record('ml', { ok: false, ms, detail: err.message });
    warn('ML', `ML service call failed: ${err.message}`);
    if (!config.mlFallback) throw new AppError(503, 'ML service unavailable. Please try again.', 'ML_UNAVAILABLE');
    warn('ML', 'Using labelled rule-of-thumb fallback (NOT the RandomForest model)');
    return { results: items.map(heuristicTraffic), mlAvailable: false, meta: { provider: 'rule-of-thumb fallback', model: 'none', ms } };
  }
}

/** Rough rule-of-thumb used ONLY when the ML service is unreachable. Labelled `heuristic-fallback`. */
function heuristicTraffic(i) {
  const peak = (i.hour >= 8 && i.hour <= 10) || (i.hour >= 17 && i.hour <= 20);
  const s = (peak && !i.weekend ? 1 : 0) + (i.rain ? 0.5 : 0) + (i.route_type === 'city' ? 0.7 : i.route_type === 'mixed' ? 0.3 : 0);
  const level = s >= 1.4 ? 'HIGH' : s >= 0.7 ? 'MEDIUM' : 'LOW';
  return { traffic_level: level, confidence: 0.5, probabilities: { LOW: 0.1, MEDIUM: 0.1, HIGH: 0.1, [level]: 0.8 }, source: 'heuristic-fallback' };
}

/** Adjusted travel time for each route. Returns { minutes:[...], source:'ml-service'|'local-multipliers' }. */
async function predictTravelTimes(bases, levels, mlAvailable) {
  const local = () => bases.map((b, i) => Math.round(b * config.trafficMultipliers[levels[i]] * 10) / 10);
  if (!mlAvailable) return { minutes: local(), source: 'local-multipliers' };
  try {
    const out = await Promise.all(bases.map((b, i) => call('/predict-travel-time', { base_minutes: b, traffic_level: levels[i] })));
    return { minutes: out.map((o) => o.predicted_minutes), source: 'ml-service' };
  } catch (err) {
    warn('ML', `travel-time endpoint failed, using local multipliers: ${err.message}`);
    return { minutes: local(), source: 'local-multipliers' };
  }
}

/** Proxy for POST /api/ml/predict */
async function predictSingle(payload) {
  try { return await call('/predict-traffic', payload); }
  catch (err) {
    if (err.status === 422) throw new AppError(400, 'Invalid prediction input (check hour 0-23, day 0-6, distance > 0).', 'BAD_INPUT');
    throw new AppError(503, 'ML service unavailable. Please try again.', 'ML_UNAVAILABLE');
  }
}

async function modelInfo() {
  try { return await call('/model-info'); }
  catch { throw new AppError(503, 'ML service unavailable. Please try again.', 'ML_UNAVAILABLE'); }
}

/** Real call to the ML service's own /health (internal service, cheap). */
async function health() {
  try { return (await call('/health')).model_loaded ? 'connected' : 'model-missing'; } catch { return 'unavailable'; }
}

module.exports = { predictTrafficBatch, predictTravelTimes, predictSingle, modelInfo, health, heuristicTraffic };
