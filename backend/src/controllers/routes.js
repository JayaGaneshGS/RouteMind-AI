const planner = require('../services/planner');
const geocode = require('../services/geocode');
const ml = require('../services/mlClient');
const db = require('../services/db');
const config = require('../config');
const diagnostics = require('../diagnostics');
const { safeUrl } = require('../log');
const { AppError } = require('../utils');

async function searchRoutes(req, res) {
  const { origin, destination, date, time, preference, notes, weather } = req.body || {};
  const result = await planner.searchRoutes({ origin, destination, date, time, preference, notes, weather, userId: req.userId });
  res.json(result);
}

async function searchLocations(req, res) {
  const results = await geocode.searchPlaces(req.query.q, 5);
  res.json({ results });
}

/* ---------------- ML ---------------- */
async function mlPredict(req, res) { res.json(await ml.predictSingle(req.body || {})); }
async function mlInfo(_req, res) { res.json(await ml.modelInfo()); }

// Reflects REAL state: Mongo's live connection state and a real call to the (internal) ML service's /health.
// Nominatim/OSRM are only reported as "configured" - we never hit public servers just for a health check;
// see /api/diagnostics for their actual last-call results.
async function health(_req, res) {
  res.json({
    backend: 'ok',
    mongodb: db.isReady() ? 'connected' : 'disconnected',
    mlService: await ml.health(),
    routing: config.osrmUrl ? 'configured' : 'not-configured',
    geocoding: config.geocodeUrl ? 'configured' : 'not-configured',
  });
}

// Developer diagnostics: counters recorded by the code that actually calls each service. No credentials.
function diag(_req, res) {
  if (!config.diagnosticsEnabled) throw new AppError(404, 'Endpoint not found.', 'NOT_FOUND');
  res.json({
    ...diagnostics.snapshot(),
    configuration: {
      mongodb: { host: config.mongoUri ? redactedHost(config.mongoUri) : 'not set', database: config.mongoDbName, state: db.isReady() ? 'connected' : 'disconnected' },
      geocoding: { provider: 'Nominatim', url: safeUrl(config.geocodeUrl), userAgent: config.geocodeUserAgent },
      routing: { provider: 'OSRM', url: safeUrl(config.osrmUrl) },
      ml: { url: safeUrl(config.mlServiceUrl), fallback: config.mlFallback ? 'rule-of-thumb enabled (labelled)' : 'disabled' },
      ai: config.ai.apiKey ? 'LLM configured' : 'no AI_API_KEY: rule-based AI',
    },
  });
}

/** Cluster host only (no user, password or query). */
function redactedHost(uri) { try { return new URL(uri.replace(/^mongodb\+srv:/, 'https:').replace(/^mongodb:/, 'https:')).host; } catch { return 'unparseable'; } }

module.exports = { searchRoutes, searchLocations, mlPredict, mlInfo, health, diag };
