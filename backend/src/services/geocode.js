// Geocoding with the REAL Nominatim service (OpenStreetMap). There is no offline/fake fallback:
// if Nominatim fails the request fails with a clear message. Cached + throttled to respect the
// public usage policy (max 1 req/s, identifying User-Agent, no autocomplete).
const config = require('../config');
const { AppError, TTLCache, createThrottle } = require('../utils');
const { log, warn } = require('../log');
const diagnostics = require('../diagnostics');

const cache = new TTLCache(config.geocodeCacheTtlMs);
const state = { throttle: createThrottle(config.externalMinIntervalMs) }; // exposed so tests can disable waits
const UNAVAILABLE = 'Location service unavailable. Please try again.';

async function fetchNominatim(query, limit) {
  const params = new URLSearchParams({ q: query, format: 'json', limit: String(limit) });
  if (config.geocodeCountryCodes) params.set('countrycodes', config.geocodeCountryCodes);
  if (config.geocodeEmail) params.set('email', config.geocodeEmail);
  await state.throttle();
  const res = await fetch(`${config.geocodeUrl}?${params}`, {
    headers: { 'User-Agent': config.geocodeUserAgent, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(config.externalTimeoutMs),
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  return res.json();
}

/** Looks a place name up. Returns { results:[{name,shortName,lat,lon,source}], cached, ms }. */
async function lookup(query, limit = 5) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 120) throw new AppError(400, 'Please enter a location (2-120 characters).', 'BAD_LOCATION');
  const key = `${q.toLowerCase()}|${limit}`;
  const hit = cache.get(key);
  if (hit) {
    log('GEOCODING', `Provider: Nominatim | Query: ${q} | served from cache (no request sent)`);
    diagnostics.record('nominatim', { cached: true });
    return { results: hit, cached: true, ms: 0 };
  }

  log('GEOCODING', `Provider: Nominatim | Query: ${q}`);
  const t0 = Date.now();
  let raw;
  try {
    raw = await fetchNominatim(q, limit);
  } catch (err) {
    const ms = Date.now() - t0;
    warn('GEOCODING', `Nominatim request failed: ${err.message}`);
    diagnostics.record('nominatim', { ok: false, ms, detail: err.message });
    throw new AppError(503, UNAVAILABLE, 'GEOCODE_UNAVAILABLE');
  }
  const ms = Date.now() - t0;
  diagnostics.record('nominatim', { ok: true, ms });
  const results = raw.map((r) => ({
    name: r.display_name, shortName: (r.display_name || '').split(',')[0],
    lat: Number(r.lat), lon: Number(r.lon), source: 'nominatim',
  })).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lon));
  if (results.length) log('GEOCODING', `Coordinates received successfully (${results.length} result${results.length > 1 ? 's' : ''}, ${ms} ms): ${results[0].shortName} ${results[0].lat}, ${results[0].lon}`);
  else log('GEOCODING', `No match for "${q}" (${ms} ms)`);
  cache.set(key, results);
  return { results, cached: false, ms };
}

const searchPlaces = async (query, limit = 5) => (await lookup(query, limit)).results;

/** Accepts a string ("Chennai") or an already-resolved place {name, lat, lon} from an earlier user search. */
async function resolvePlace(input, label) {
  if (input && typeof input === 'object' && Number.isFinite(Number(input.lat)) && Number.isFinite(Number(input.lon))) {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new AppError(400, `${label} coordinates are out of range.`, 'BAD_LOCATION');
    return {
      name: String(input.name || input.shortName || `${lat.toFixed(4)}, ${lon.toFixed(4)}`).slice(0, 200), lat, lon,
      lookup: { provider: 'client-supplied coordinates (picked from an earlier Nominatim search)', cached: false, ms: 0 },
    };
  }
  const query = typeof input === 'string' ? input : input?.name;
  if (!query || !String(query).trim()) throw new AppError(400, `Please enter an ${label.toLowerCase()}.`, 'BAD_LOCATION');
  const { results, cached, ms } = await lookup(query, 1);
  if (!results.length) throw new AppError(422, `We couldn't find "${String(query).slice(0, 60)}". Check the spelling or try a nearby city.`, 'LOCATION_NOT_FOUND');
  return { ...results[0], lookup: { provider: 'Nominatim', cached, ms } };
}

module.exports = { searchPlaces, resolvePlace, _cache: cache, _state: state };
