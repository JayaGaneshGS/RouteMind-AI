// Road routing with the REAL OSRM service (OpenStreetMap road data). No fake routes: every route returned
// here (distance, duration, geometry) comes straight from an OSRM response. If OSRM fails, the search
// fails with a clear message - we never invent straight-line routes or extra "alternatives".
//
// NOTE: OSRM provides road routing only, NOT live traffic. `baseMinutes` is OSRM's free-flow duration.
const config = require('../config');
const { AppError, TTLCache, createThrottle, decimate, simplifyLine } = require('../utils');
const { log, warn, safeUrl } = require('../log');
const diagnostics = require('../diagnostics');

const cache = new TTLCache(config.routeCacheTtlMs, 200);
const state = { throttle: createThrottle(config.externalMinIntervalMs) };
const UNAVAILABLE = 'Routing service unavailable. Please try again.';

// OSRM wants longitude,latitude order.
const coord = (p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;

/** Main road names of a route: OSRM's own leg summaries, else the longest-driven named roads from the steps. */
function describeVia(route) {
  const fromSummary = (route.legs || []).map((l) => l.summary).filter(Boolean).join(', ');
  if (fromSummary) return fromSummary.split(', ').slice(0, 3).join(', ');
  const byName = new Map();
  for (const leg of route.legs || []) for (const st of leg.steps || []) if (st.name) byName.set(st.name, (byName.get(st.name) || 0) + st.distance);
  return [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(', ');
}

/** Per-step road name / ref and length, in driving order: [{ name, ref, distanceM }]. */
function stepsOf(route) {
  const out = [];
  for (const leg of route.legs || []) {
    for (const st of leg.steps || []) {
      if (!(st.distance > 0)) continue;
      out.push({ name: String(st.name || ''), ref: String(st.ref || ''), distanceM: st.distance });
    }
  }
  return out;
}

async function fetchOsrm(origin, destination) {
  const params = new URLSearchParams({ alternatives: 'true', geometries: 'geojson', overview: 'full', steps: 'true' });
  await state.throttle();
  const res = await fetch(`${config.osrmUrl}/route/v1/driving/${coord(origin)};${coord(destination)}?${params}`, {
    headers: { 'User-Agent': config.geocodeUserAgent },
    signal: AbortSignal.timeout(config.externalTimeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  return { res, body };
}

/**
 * Returns { routes:[{distanceKm, baseMinutes, geometry:[[lat,lon]...], via, stepCount}], meta, warnings }.
 * Throws AppError 503 if OSRM is unavailable, 422 if there is no drivable route.
 */
async function getRoutes(origin, destination) {
  const key = [origin, destination].map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join('>');
  const hit = cache.get(key);
  if (hit) {
    log('ROUTING', `Provider: OSRM | served from cache (no request sent) | Routes: ${hit.routes.length}`);
    diagnostics.record('osrm', { cached: true });
    return { ...hit, meta: { ...hit.meta, cached: true, ms: 0 } };
  }

  log('ROUTING', `Provider: OSRM (${safeUrl(config.osrmUrl)})`);
  const t0 = Date.now();
  let out;
  try { out = await fetchOsrm(origin, destination); } catch (err) {
    warn('ROUTING', `OSRM request failed: ${err.message}`);
    diagnostics.record('osrm', { ok: false, ms: Date.now() - t0, detail: err.message });
    throw new AppError(503, UNAVAILABLE, 'ROUTING_UNAVAILABLE');
  }
  const ms = Date.now() - t0;
  const { res, body } = out;
  if (body?.code === 'NoRoute') {
    diagnostics.record('osrm', { ok: true, ms });
    throw new AppError(422, 'No driving route was found between these two locations.', 'NO_ROUTE');
  }
  if (!res.ok || body?.code !== 'Ok' || !body.routes?.length) {
    warn('ROUTING', `OSRM returned HTTP ${res.status}, code ${body?.code}`);
    diagnostics.record('osrm', { ok: false, ms, detail: `HTTP ${res.status} ${body?.code || ''}` });
    throw new AppError(503, UNAVAILABLE, 'ROUTING_UNAVAILABLE');
  }
  diagnostics.record('osrm', { ok: true, ms });

  const routes = body.routes.map((r) => {
    const line = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]); // GeoJSON [lon,lat] -> Leaflet [lat,lon]
    return {
      distanceKm: r.distance / 1000, // OSRM: metres
      baseMinutes: r.duration / 60, // OSRM: seconds, free-flow (no live traffic)
      geometry: decimate(line),
      via: describeVia(r),
      stepCount: (r.legs || []).reduce((n, l) => n + (l.steps?.length || 0), 0),
      // Server-side only (never sent to the browser): a finer line and OSRM's per-step road names, used to sample
      // the OpenStreetMap tags of the roads actually driven. OSRM gives names/refs here, not surface or condition.
      analysis: { line: simplifyLine(line, 10, 4000), steps: stepsOf(r) },
    };
  });
  log('ROUTING', `Routes received: ${routes.length} (${ms} ms) | ${routes.map((r) => `${r.distanceKm.toFixed(1)} km / ${r.baseMinutes.toFixed(0)} min`).join(' ; ')}`);

  const warnings = routes.length < 2 ? ['OSRM returned only one route for these locations, so there are no alternatives to compare.'] : [];
  const result = { routes, warnings, meta: { provider: 'OSRM', routesReceived: routes.length, cached: false, ms } };
  cache.set(key, result);
  return result;
}

module.exports = { getRoutes, describeVia, _cache: cache, _state: state };
