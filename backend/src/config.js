// Central configuration. Every value comes from environment variables - no secrets in code.
const path = require('path');
const crypto = require('crypto');
// Tests inject their own environment and must never pick up real credentials from a developer's .env.
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true }); // repo-root .env
  require('dotenv').config({ quiet: true }); // backend/.env (optional override, e.g. `backend/.env`)
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';

let jwtSecret = env.JWT_SECRET;
if (!jwtSecret || /change_this/i.test(jwtSecret)) {
  if (isProd) throw new Error('JWT_SECRET must be set to a long random value in production (see .env.example)');
  // Dev convenience only: random per-process secret (tokens become invalid on restart).
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET missing or still the placeholder - using a temporary random secret (dev only).');
}

const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : d);

// Public Overpass instances that serve the whole planet (https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances).
// They are shared volunteer servers and each goes down now and then - that is why there is more than one.
const DEFAULT_OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
function overpassUrls() {
  const raw = env.OVERPASS_URLS || env.OVERPASS_URL || ''; // OVERPASS_URL = legacy single-endpoint setting
  const list = [...new Set(raw.split(/[,\s]+/).map((u) => u.replace(/\/$/, '')).filter((u) => /^https?:\/\//i.test(u)))];
  return list.length ? list : [...DEFAULT_OVERPASS_URLS];
}

module.exports = {
  isProd,
  port: num(env.PORT, 5000),
  // MongoDB Atlas connection string. Required; NEVER log it (see redact() in log.js).
  mongoUri: env.MONGO_URI || '',
  mongoDbName: env.MONGO_DB_NAME || 'routemind',
  jwtSecret,
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  corsOrigins: (env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()),
  mlServiceUrl: (env.ML_SERVICE_URL || 'http://localhost:8000').replace(/\/$/, ''),
  mlTimeoutMs: num(env.ML_TIMEOUT_MS, 5000),
  // If the ML service is down: 'on' = use a clearly labelled rule-of-thumb, 'off' = fail with an error.
  mlFallback: (env.ML_FALLBACK || 'on').toLowerCase() !== 'off',
  // Developer diagnostics endpoint (/api/diagnostics): call counters only, no credentials.
  diagnosticsEnabled: env.DIAGNOSTICS ? env.DIAGNOSTICS.toLowerCase() === 'on' : !isProd,

  // Real, free/open map services. Public servers: be polite (cache + throttle + User-Agent).
  geocodeUrl: (env.GEOCODE_URL || 'https://nominatim.openstreetmap.org/search').replace(/\/$/, ''), // full /search URL
  osrmUrl: (env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, ''),
  geocodeUserAgent: env.GEOCODE_USER_AGENT || 'RouteMindAI/1.0',
  geocodeEmail: env.GEOCODE_EMAIL || '', // optional contact e-mail, sent as Nominatim's `email` parameter
  geocodeCountryCodes: env.GEOCODE_COUNTRY_CODES || '',
  externalMinIntervalMs: num(env.EXTERNAL_MIN_INTERVAL_MS, 1100), // >= 1 request/sec to public servers
  externalTimeoutMs: num(env.EXTERNAL_TIMEOUT_MS, 8000),
  geocodeCacheTtlMs: num(env.GEOCODE_CACHE_TTL_MS, 24 * 3600 * 1000),
  routeCacheTtlMs: num(env.ROUTE_CACHE_TTL_MS, 10 * 60 * 1000),

  // OpenStreetMap Overpass API: road surface tags and scenic points of interest. Public servers: be polite
  // (identifying User-Agent, throttle, cache, timeouts, cool-down after failures). Used ONLY when the search
  // asks for road conditions or scenery.
  overpass: {
    // Ordered list of endpoints (priority order): a timeout, 429, 5xx or network error moves on to the next one.
    // OVERPASS_URLS = comma-separated list; OVERPASS_URL (single, legacy) still works; otherwise the defaults below.
    urls: overpassUrls(),
    userAgent: env.OVERPASS_USER_AGENT || env.GEOCODE_USER_AGENT || 'RouteMindAI/1.0',
    timeoutMs: num(env.OVERPASS_TIMEOUT_MS, 20000), // per HTTP attempt
    budgetMs: num(env.OVERPASS_BUDGET_MS, 45000), // whole road + scenery enrichment per search; after that: "unavailable"
    minIntervalMs: num(env.OVERPASS_MIN_INTERVAL_MS, 1100), // per endpoint
    cacheTtlMs: num(env.OVERPASS_CACHE_TTL_MS, 24 * 3600 * 1000), // map features change slowly
    failureCooldownMs: num(env.OVERPASS_COOLDOWN_MS, 30 * 1000), // do not ask the same failed question again for this long
    retries: num(env.OVERPASS_RETRIES, 1), // extra passes over the endpoints that failed with a 5xx / network error
    backoffMs: num(env.OVERPASS_BACKOFF_MS, 1000), // wait before the extra pass; doubles with every pass (plus jitter)
    endpointCooldownMs: num(env.OVERPASS_ENDPOINT_COOLDOWN_MS, 30 * 1000), // a failing endpoint is skipped for this long; doubles per consecutive failure
    endpointCooldownMaxMs: num(env.OVERPASS_ENDPOINT_COOLDOWN_MAX_MS, 5 * 60 * 1000),
  },
  // "Better Road Conditions": sampled OSM surface/smoothness tags (see services/roadQuality.js and the README).
  roadQuality: {
    enabled: (env.ROAD_QUALITY || 'on').toLowerCase() !== 'off',
    sampleSpacingM: num(env.ROAD_SAMPLE_SPACING_M, 2000), // one sample point per this many metres of route...
    maxSamples: num(env.ROAD_MAX_SAMPLES, 30), // ...but never more than this many per route (each costs the public server ~0.25 s)
    matchRadiusM: num(env.ROAD_MATCH_RADIUS_M, 25), // half-size of the search box around each sample point
    minCoverage: num(env.ROAD_MIN_COVERAGE, 0.2), // share of the route with documented surface/smoothness needed to rank on it
  },
  // "Better Scenery": relevant POIs near each route (see services/scenery.js and the README).
  scenery: {
    enabled: (env.SCENERY || 'on').toLowerCase() !== 'off',
    nearM: num(env.SCENERY_NEAR_M, 300), // POI within this distance of the route: full weight
    maxM: num(env.SCENERY_MAX_M, 1000), // POI within this distance but beyond nearM: ringWeight; beyond: ignored
    ringWeight: num(env.SCENERY_RING_WEIGHT, 0.5),
    maxPerCategory: num(env.SCENERY_MAX_PER_CATEGORY, 5), // diminishing returns: only the best N POIs per category count
    saturationK: num(env.SCENERY_SATURATION_K, 10), // score = 100 * (1 - exp(-points / K))
    unnamedFactor: num(env.SCENERY_UNNAMED_FACTOR, 0.5), // weight multiplier for viewpoints/beaches that have no name
    simplifyTolM: num(env.SCENERY_SIMPLIFY_TOL_M, 50), // fine route polyline (exact near/far test) deviates at most this much
    maxPolyPoints: num(env.SCENERY_MAX_POLY_POINTS, 250),
    maxCells: num(env.SCENERY_MAX_CELLS, 8), // POI lookup grid cells per search (each cell = 7 Overpass statements)
  },
  // "Not much longer" without a number in the user's notes means at most this much slower than the fastest route.
  defaultDetourPercent: num(env.DETOUR_DEFAULT_PERCENT, 15),
  // Safety net for the road/scenery preferences: with no limit from the traveller, a route more than this much slower than
  // the fastest one is never recommended on road or scenery grounds alone.
  maxDetourPercent: num(env.MAX_DETOUR_PERCENT, 50),

  // Optional LLM (any OpenAI-compatible chat-completions endpoint). App works without it.
  ai: {
    apiKey: env.AI_API_KEY || '',
    apiUrl: env.AI_API_URL || 'https://api.openai.com/v1/chat/completions',
    model: env.AI_MODEL || 'gpt-4o-mini',
    timeoutMs: num(env.AI_TIMEOUT_MS, 8000),
  },

  // Trip-cost model (rough estimate, configurable).
  cost: {
    perKm: num(env.COST_PER_KM, 7), // INR/km fuel for an average petrol car
    tollPerKm: num(env.TOLL_PER_KM, 1.2), // INR/km on highway-like stretches (rough)
    trafficFuelFactor: { LOW: 1.0, MEDIUM: 1.08, HIGH: 1.2 }, // stop-go traffic burns more fuel
  },
  // Used only when the ML service is down; mirrors the ML service defaults.
  trafficMultipliers: { LOW: 1.05, MEDIUM: 1.2, HIGH: 1.45 },
};
