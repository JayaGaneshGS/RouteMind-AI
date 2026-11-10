// "Better Scenery": compares the candidate routes against REAL nature-related points of interest from OpenStreetMap
// (Overpass API), using the actual POI coordinates and the OSRM route geometry.
//
// What this is NOT: a measure of how beautiful a route is. It counts mapped nature-related features near the route.
// The wording everywhere is "more nature-related POIs near this route", never "officially scenic".
//
// Guards against misleading scores (all configurable, all in the README):
//  - Only a short whitelist of categories counts (beach, viewpoint, park/garden, nature reserve, lake/waterfall,
//    forest, tourist attraction). Shops, restaurants and other urban POIs are never queried.
//  - Parks, lakes, forests and attractions must have a name (unnamed scraps of green are ignored).
//  - The same real-world place mapped twice (node + polygon, multipart relations) is counted once.
//  - Only the best `maxPerCategory` POIs per category count, and the score saturates, so a dense cluster of the same
//    kind of POI cannot dominate.
//  - Proximity is measured to the route line: full weight within `nearM`, `ringWeight` out to `maxM`, nothing beyond.
//
// Overpass requests (the public servers are slow for big or long queries, so the work is split into small pieces):
//  Each route is cut into segments of about `segmentKm` (20 km). Every segment is ONE request for a thin corridor
//  (`maxM` = 1 km) around just that piece: the whitelisted POIs within range, with their tags and bounding boxes, and - in
//  the same request - the ids of the areas that are within `nearM` (Overpass tests the real outline of areas itself).
//  Point POIs are additionally measured exactly against the route line here. Segments are cached and de-duplicated one by
//  one; if some fail but every route still has enough of its length covered, the score is computed from what was
//  retrieved and flagged `incomplete`; otherwise scenery is "unavailable" - never a score of 0 for missing data.
const config = require('../config');
const overpass = require('./overpass');
const { distanceToPolylineM, haversineKm, simplifyLine, pointToSegmentM, polylineLengthM } = require('../utils');
const { log } = require('../log');

/* ---------- Categories (relevance weights are an editorial choice, documented in the README) ---------- */

const CATEGORIES = {
  beach: { label: 'beach' },
  viewpoint: { label: 'viewpoint' },
  park: { label: 'park or garden' },
  nature: { label: 'nature reserve or national park' },
  water: { label: 'lake or waterfall' },
  forest: { label: 'forest' },
  attraction: { label: 'tourist attraction' },
};
const CATEGORY_KEYS = Object.keys(CATEGORIES);

// One Overpass statement per row (statements are the cost driver on the public server). `cats` = categories served.
const STATEMENTS = [
  { q: '["natural"="beach"]', cats: ['beach'] },
  { q: '["tourism"~"^(viewpoint|attraction)$"]', cats: ['viewpoint', 'attraction'] },
  { q: '["leisure"~"^(park|garden|nature_reserve)$"]["name"]', cats: ['park', 'nature'] },
  { q: '["natural"~"^(water|wood)$"]["name"]', cats: ['water', 'forest'] },
  { q: '["landuse"="forest"]["name"]', cats: ['forest'] },
  { q: '["boundary"="national_park"]["name"]', cats: ['nature'] },
  { q: '["waterway"="waterfall"]', cats: ['water'] },
];

/** Maps OSM tags to { category, relevance } or null. Relevance is 0..1: how directly the feature is nature/view related. */
function classify(tags = {}) {
  const named = !!tags.name;
  if (tags.natural === 'beach') return { category: 'beach', relevance: 1 };
  if (tags.tourism === 'viewpoint') return { category: 'viewpoint', relevance: 1 };
  if (tags.leisure === 'nature_reserve' && named) return { category: 'nature', relevance: 0.9 };
  if (tags.boundary === 'national_park' && named) return { category: 'nature', relevance: 0.9 };
  if (tags.waterway === 'waterfall') return { category: 'water', relevance: 0.9 };
  if (tags.natural === 'water' && named && (!tags.water || ['lake', 'reservoir', 'lagoon'].includes(tags.water))) return { category: 'water', relevance: 0.8 };
  if (tags.leisure === 'park' && named) return { category: 'park', relevance: 0.6 };
  if (tags.leisure === 'garden' && named) return { category: 'park', relevance: 0.5 };
  if ((tags.landuse === 'forest' || tags.natural === 'wood') && named) return { category: 'forest', relevance: 0.6 };
  if (tags.tourism === 'attraction' && named) return { category: 'attraction', relevance: 0.3 }; // generic tag: low weight
  return null;
}

/* ---------- Geometry helpers ---------- */

const fmt = (n) => Number(n).toFixed(5);
const polyArgs = (line) => line.map(([la, lo]) => `${fmt(la)},${fmt(lo)}`).join(',');
const inBox = (p, b) => p[0] >= b.minlat && p[0] <= b.maxlat && p[1] >= b.minlon && p[1] <= b.maxlon;

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function segmentsIntersect(a, b, c, d) {
  const d1 = cross(c, d, a); const d2 = cross(c, d, b); const d3 = cross(a, b, c); const d4 = cross(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Metres from a polyline to a lat/lon rectangle (0 if the line enters or crosses it). Never larger than the distance to the shape inside it. */
function distanceToBoxM(line, b) {
  if (line.some((p) => inBox(p, b))) return 0;
  const c = [[b.minlat, b.minlon], [b.minlat, b.maxlon], [b.maxlat, b.maxlon], [b.maxlat, b.minlon]];
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    for (let k = 0; k < 4; k++) {
      const e1 = c[k]; const e2 = c[(k + 1) % 4];
      if (segmentsIntersect(line[i - 1], line[i], e1, e2)) return 0;
      best = Math.min(best, pointToSegmentM(e1, line[i - 1], line[i]), pointToSegmentM(e2, line[i - 1], line[i]), pointToSegmentM(line[i - 1], e1, e2), pointToSegmentM(line[i], e1, e2));
    }
  }
  return best;
}

/** The fine route line: sent to Overpass for the exact area test AND used locally, so both agree. */
const queryLine = (route) => simplifyLine(route.analysis?.line || route.geometry || [], config.scenery.simplifyTolM, config.scenery.maxPolyPoints);

/* ---------- Overpass queries: one small corridor request per route segment ---------- */

const SEGMENT_STRETCH = 2.5; // segments may grow to 2.5x `segmentKm` to stay within `maxRequests`; beyond that a route is "too long"

const lerp = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];

/** Cuts a polyline into `n` pieces of equal length (cut points are interpolated). Neighbouring pieces share their end point. */
function splitLine(line, n) {
  if (n <= 1 || line.length < 2) return [line];
  const total = polylineLengthM(line);
  const pieces = []; let cur = [line[0]]; let walked = 0;
  for (let i = 1; i < line.length; i++) {
    let from = line[i - 1]; const to = line[i];
    let d = polylineLengthM([from, to]);
    while (pieces.length < n - 1 && d > 0 && walked + d >= (total * (pieces.length + 1)) / n - 1e-6) {
      const need = Math.min(d, (total * (pieces.length + 1)) / n - walked);
      const p = lerp(from, to, need / d);
      cur.push(p); pieces.push(cur); cur = [p];
      walked += need; d -= need; from = p;
    }
    if (d > 0 || cur.length < 2) cur.push(to);
    walked += d;
  }
  pieces.push(cur);
  return pieces;
}

/**
 * Plans the requests. Instead of ONE bounding box over the whole route (which grows with the route and made every public
 * server time out), each route's fine line is cut into equal pieces of about `segmentKm`; every piece becomes one request
 * for a thin corridor (`maxM`) around just that piece. Total pieces <= `maxRequests`: the piece length is stretched (up to
 * 2.5x) for long routes, and null is returned if even that is not enough.
 * Returns [{ route, index, line, lengthM }] in route order, then along the route.
 */
function planSegments(lines) {
  const base = config.scenery.segmentKm * 1000;
  const lengths = lines.map(polylineLengthM);
  for (let target = base; target <= base * SEGMENT_STRETCH + 1; target *= 1.1) {
    const counts = lengths.map((len) => Math.max(1, Math.ceil(len / target - 1e-9)));
    if (counts.reduce((a, b) => a + b, 0) <= config.scenery.maxRequests) {
      return lines.flatMap((line, route) => splitLine(line, counts[route]).map((piece, index) => ({ route, index, line: piece, lengthM: polylineLengthM(piece) })));
    }
  }
  return null;
}

/**
 * ONE request for ONE segment: the whitelisted features within `maxM` of the segment (`around`, so only elements really
 * in range come back - areas are measured against their outline by Overpass itself), then, after a `count` delimiter,
 * the ids of the area candidates within `nearM`. This replaces the old "tiles" request AND the separate "refine" request.
 */
function buildSegmentQuery(line, categories) {
  const { maxM, nearM } = config.scenery;
  const stmts = STATEMENTS.filter((st) => st.cats.some((c) => categories.includes(c)));
  const p = polyArgs(line);
  return `[out:json][timeout:${overpass.serverTimeoutSeconds()}];(${stmts.map((st) => `nwr${st.q}(around:${maxM},${p});`).join('')})->.c;`
    + `.c out tags bb;.c out count;(way.c;relation.c;)->.a;nwr.a(around:${nearM},${p})->.n;.n out ids;`;
}

/** Splits a segment response at its `count` delimiter: { candidates: [elements with tags/bounds], near: Set('type/id') }. */
function parseSegment(elements) {
  const i = elements.findIndex((e) => e.type === 'count');
  if (i < 0) throw new overpass.OverpassError('parse', 'Overpass response for a route segment had no delimiter');
  return { candidates: elements.slice(0, i), near: new Set(elements.slice(i + 1).map((e) => `${e.type}/${e.id}`)) };
}

/* ---------- Scoring ---------- */

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const round = (x, d = 1) => { const f = 10 ** d; return Math.round(x * f) / f; };
const km = (a, b) => haversineKm(a, b);
const boundsOf = (el) => (el.bounds ? { minlat: el.bounds.minlat, minlon: el.bounds.minlon, maxlat: el.bounds.maxlat, maxlon: el.bounds.maxlon } : null);
const where = (el) => {
  if (el.type === 'node') return { lat: el.lat, lon: el.lon };
  const b = boundsOf(el);
  return b ? { lat: (b.minlat + b.maxlat) / 2, lon: (b.minlon + b.maxlon) / 2 } : null;
};

/** Removes duplicate mappings of the same place: same category and (same name within 5 km, or any POI within 200 m). */
function dedupe(pois) {
  const kept = [];
  for (const p of [...pois].sort((a, b) => b.contribution - a.contribution || (b.name ? 1 : 0) - (a.name ? 1 : 0))) {
    const dup = kept.some((k) => k.category === p.category && ((p.nameKey && k.nameKey === p.nameKey && km(k, p) <= 5) || km(k, p) <= 0.2));
    if (!dup) kept.push(p);
  }
  return kept;
}

/**
 * Which areas are within range of this route, and how close: `exact` (Overpass tested the real outline - the normal case)
 * or, when no exact sets are passed (direct calls / tests only), the bounding-box distance. Nodes are always measured exactly here.
 * Returns { band, distanceM, proximity } or null if the POI is out of range.
 */
function proximityOf(el, line, exact) {
  const { nearM, maxM, simplifyTolM } = config.scenery;
  if (el.type === 'node') {
    const d = distanceToPolylineM([el.lat, el.lon], line);
    if (d > maxM + simplifyTolM) return null; // verified locally against the route geometry
    return { band: d <= nearM ? 'near' : 'ring', distanceM: Math.round(d), proximity: 'exact' };
  }
  const key = `${el.type}/${el.id}`;
  if (exact) return exact.far.has(key) ? { band: exact.near.has(key) ? 'near' : 'ring', distanceM: null, proximity: 'exact' } : null;
  const b = boundsOf(el);
  if (!b) return null;
  const d = distanceToBoxM(line, b);
  return d > maxM ? null : { band: d <= nearM ? 'near' : 'ring', distanceM: null, proximity: 'bounding-box' };
}

/**
 * Scores one route. `line` = the route polyline; `elements` = candidate OSM elements; `exact` = the far/near sets of the areas
 * Overpass tested for this route ({far, near}) or null; `wanted` limits counted categories (null = all). Pure function - unit tested with
 * synthetic geometry.
 */
function scoreRoute(line, elements, exact = null, wanted = null) {
  const { ringWeight, maxPerCategory, saturationK, unnamedFactor } = config.scenery;
  const candidates = [];
  for (const el of elements) {
    const c = classify(el.tags); const pos = where(el);
    if (!c || !pos || (wanted && !wanted.includes(c.category))) continue;
    const prox = proximityOf(el, line, exact);
    if (!prox) continue;
    candidates.push({
      key: `${el.type}/${el.id}`, osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      name: el.tags?.name || '', nameKey: norm(el.tags?.name), category: c.category, categoryLabel: CATEGORIES[c.category].label,
      relevance: c.relevance, ...prox, lat: pos.lat, lon: pos.lon,
      // an unnamed viewpoint/beach node is harder to verify (and in cities often just a bench): reduced weight
      contribution: c.relevance * (el.tags?.name ? 1 : unnamedFactor) * (prox.band === 'near' ? 1 : ringWeight),
    });
  }
  const unique = dedupe(candidates);
  const byCat = {};
  for (const p of unique) (byCat[p.category] ||= []).push(p);
  let points = 0;
  const counts = {};
  for (const [cat, list] of Object.entries(byCat)) {
    list.sort((a, b) => b.contribution - a.contribution);
    list.forEach((p, i) => { p.counted = i < maxPerCategory; if (p.counted) points += p.contribution; });
    counts[cat] = list.length;
  }
  const pois = unique.sort((a, b) => (b.counted - a.counted) || (b.contribution - a.contribution));
  return {
    score: round(100 * (1 - Math.exp(-points / saturationK))),
    points: round(points, 2),
    counts,
    totalPois: unique.length,
    nearCount: unique.filter((p) => p.band === 'near').length,
    duplicatesRemoved: candidates.length - unique.length,
    approximate: unique.some((p) => p.proximity === 'bounding-box'),
    pois,
  };
}

const list = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`);

function describe(s, wantedLabel) {
  const { nearM, maxM } = config.scenery;
  const what = wantedLabel || 'nature-related';
  if (!s.totalPois) return `No ${what} points of interest were found within ${maxM / 1000} km of this route in OpenStreetMap (this does not mean the route is unattractive - it only reflects mapped data).`;
  const counted = s.pois.filter((p) => p.counted).slice(0, 4).map((p) => (p.name ? `${p.name} (${p.categoryLabel})` : `an unnamed ${p.categoryLabel}`));
  const approx = s.approximate ? ' Distances to large areas are approximate.' : '';
  return `${s.totalPois} ${what} POI${s.totalPois > 1 ? 's' : ''} near this route (${s.nearCount} within ${nearM} m, the rest within ${maxM / 1000} km): ${list(counted)}. Score counts each place once, at most ${config.scenery.maxPerCategory} per category, weighted by relevance and distance.${approx}`;
}

const unavailable = (n, reason) => ({
  available: false, reason,
  perRoute: Array.from({ length: n }, () => ({ available: false, score: null, reason, summary: `Scenery information unavailable: ${reason}`, pois: [], source: 'OpenStreetMap POIs via Overpass API' })),
  meta: { provider: 'Overpass', requested: false },
});

const pct = (x) => `${Math.round(x * 100)} %`;
const routeName = (k) => `Route ${String.fromCharCode(65 + k)}`;

/** Merges the successful segments of one route: candidates (de-duplicated), the exact far/near sets, and how much of the route was covered. */
function collectRoute(segments) {
  const total = segments.reduce((s, x) => s + x.lengthM, 0) || 1;
  const done = segments.filter((s) => s.ok);
  const byKey = new Map(); const near = new Set();
  for (const s of done) {
    for (const el of s.candidates) byKey.set(`${el.type}/${el.id}`, el);
    s.near.forEach((k) => near.add(k));
  }
  const elements = [...byKey.values()].filter((e) => (e.type === 'node' ? Number.isFinite(e.lat) : !!e.bounds));
  // Every area that came back is within maxM of this route (Overpass tested its outline); `near` is the subset within nearM.
  const far = new Set(elements.filter((e) => e.type !== 'node').map((e) => `${e.type}/${e.id}`));
  return {
    elements, exact: { far, near },
    coverage: done.reduce((s, x) => s + x.lengthM, 0) / total,
    segments: segments.length, failed: segments.length - done.length,
  };
}

const INCOMPLETE_NOTE = (coverage) => ` Data incomplete: nature-related places could only be retrieved for ${pct(coverage)} of this route, so the score covers that part only and may understate its scenery.`;

/**
 * routes: planner routes carrying `analysis`. categories: optional subset of CATEGORY_KEYS the traveller asked for.
 * Never throws: a failure becomes `{ available:false, reason }` and the UI says scenery information is unavailable.
 *
 * Each route is cut into segments, one small Overpass request each (cached / de-duplicated / failed-over individually).
 *  - Every segment retrieved   -> normal result.
 *  - Some segments failed but every route still has >= SCENERY_MIN_COVERAGE of its length retrieved -> a score from what
 *    WAS retrieved, flagged `incomplete` (with the covered share) on the result, on each route and in its summary.
 *  - Otherwise -> unavailable. Missing data is never counted as "no scenery" (score 0) and never invented.
 */
async function assessScenery(routes, categories = null, opts = {}) {
  if (!config.scenery.enabled) return unavailable(routes.length, 'scenery analysis is switched off (SCENERY=off).');
  const wanted = categories && categories.length ? categories.filter((c) => CATEGORY_KEYS.includes(c)) : null;
  const queryCats = wanted && wanted.length ? wanted : CATEGORY_KEYS;
  const lines = routes.map(queryLine);
  if (lines.some((l) => l.length < 2)) return unavailable(routes.length, 'the routes had no geometry to analyse.');
  const plan = planSegments(lines);
  if (!plan) return unavailable(routes.length, 'the route is too long to look up scenery without overloading the public OpenStreetMap server.');

  const t0 = Date.now();
  const results = await overpass.runMany(plan.map((s) => buildSegmentQuery(s.line, queryCats)), 'scenery-pois', opts);
  const segments = plan.map((s, i) => {
    const r = results[i];
    if (!r.ok) return { ...s, ok: false, error: r.error };
    try { return { ...s, ok: true, cached: r.cached, ...parseSegment(r.elements) }; } catch (error) { return { ...s, ok: false, error }; }
  });
  const failed = segments.filter((s) => !s.ok);
  if (failed.length === segments.length) {
    const why = failed.find((s) => s.error.kind !== 'skipped')?.error.kind || 'error';
    return unavailable(routes.length, `the OpenStreetMap Overpass service could not be reached (${why}).`);
  }

  const data = lines.map((_, k) => collectRoute(segments.filter((s) => s.route === k)));
  const short = data.map((d, k) => ({ d, k })).filter(({ d }) => d.coverage < config.scenery.minCoverage);
  if (short.length) {
    return unavailable(routes.length, `scenery data could only be retrieved for ${short.map(({ d, k }) => `${pct(d.coverage)} of ${routeName(k)}`).join(' and ')}; at least ${pct(config.scenery.minCoverage)} of every route is needed to give a score (missing data is not counted as "no scenery").`);
  }

  const incomplete = data.some((d) => d.failed > 0);
  const label = wanted && wanted.length ? list(wanted.map((c) => CATEGORIES[c].label)) : null;
  const perRoute = lines.map((line, i) => {
    const s = scoreRoute(line, data[i].elements, data[i].exact, wanted && wanted.length ? wanted : null);
    const partial = data[i].failed > 0;
    return {
      available: true, ...s, summary: describe(s, label) + (partial ? INCOMPLETE_NOTE(data[i].coverage) : ''), source: 'OpenStreetMap POIs via Overpass API',
      thresholds: { nearM: config.scenery.nearM, maxM: config.scenery.maxM, maxPerCategory: config.scenery.maxPerCategory }, categoriesCounted: wanted && wanted.length ? wanted : CATEGORY_KEYS,
      incomplete: partial, coverage: Math.round(data[i].coverage * 100) / 100,
      pois: s.pois.slice(0, 12),
    };
  });
  const note = incomplete
    ? `incomplete: ${failed.length} of ${segments.length} corridor segments could not be retrieved (${[...new Set(failed.map((s) => s.error.kind))].join(', ')}); coverage ${data.map((d, k) => `${routeName(k)} ${pct(d.coverage)}`).join(', ')}`
    : null;
  log('SCENERY', `POI scores: ${perRoute.map((p) => `${p.score} (${p.totalPois} POIs)`).join(' / ')} | ${segments.length - failed.length}/${segments.length} segments${note ? ` | ${note}` : ''}`);
  return {
    available: true, perRoute, ...(incomplete ? { incomplete: true } : {}),
    meta: {
      provider: 'Overpass', requested: true, cached: segments.every((s) => !s.ok || s.cached), ms: Date.now() - t0, categories: queryCats,
      tiles: segments.length, segments: segments.length, segmentsFailed: failed.length, candidates: data.reduce((n, d) => n + d.elements.length, 0), ...(note ? { note } : {}),
    },
  };
}

module.exports = {
  assessScenery, unavailableFor: unavailable, scoreRoute, classify, dedupe, planSegments, splitLine, buildSegmentQuery, parseSegment, collectRoute,
  distanceToBoxM, queryLine, CATEGORIES, CATEGORY_KEYS,
};
