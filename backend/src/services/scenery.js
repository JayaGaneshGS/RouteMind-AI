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
// Two Overpass requests (the public server is slow for long polyline queries, so the work is split):
//  1. TILES: all whitelisted POIs inside the grid cells the routes pass through, with their bounding boxes.
//     Point POIs are then measured exactly against the route line here. Areas get a bounding-box distance, which can
//     only UNDER-estimate the true distance, so it is used to discard POIs that are certainly too far.
//  2. REFINE: for the few remaining areas, Overpass itself tests their real outline against the route (near / far).
//     If this second request fails the areas are kept but flagged `approximate` (bounding-box distance).
const config = require('../config');
const overpass = require('./overpass');
const { distanceToPolylineM, haversineKm, simplifyLine, pointToSegmentM } = require('../utils');
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

/* ---------- Overpass queries ---------- */

const CELL_SIZES = [0.1, 0.15, 0.2, 0.3, 0.45, 0.6, 0.9];

/**
 * Grid cells (degrees) that the routes pass through, widened by maxM so POIs just outside a cell edge are not missed.
 * The cell size grows until at most `maxCells` cells are needed; returns null if even the largest size is not enough.
 */
function tilesFor(lines) {
  const bufLat = config.scenery.maxM / 111320;
  for (const size of CELL_SIZES) {
    const cells = new Map();
    for (const line of lines) {
      for (let i = 0; i < line.length; i++) {
        // walk each segment in steps smaller than a cell so no cell is skipped
        const a = line[i]; const b = line[i + 1] || line[i];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / (size / 2)));
        for (let s = 0; s <= steps; s++) {
          const la = a[0] + ((b[0] - a[0]) * s) / steps; const lo = a[1] + ((b[1] - a[1]) * s) / steps;
          const bufLon = bufLat / Math.max(0.2, Math.cos((la * Math.PI) / 180));
          for (let r = Math.floor((la - bufLat) / size); r <= Math.floor((la + bufLat) / size); r++) {
            for (let c = Math.floor((lo - bufLon) / size); c <= Math.floor((lo + bufLon) / size); c++) cells.set(`${r},${c}`, [r, c]);
          }
        }
      }
      if (cells.size > config.scenery.maxCells) break;
    }
    if (cells.size <= config.scenery.maxCells) {
      return { size, cells: [...cells.values()].map(([r, c]) => ({ s: r * size, w: c * size, n: (r + 1) * size, e: (c + 1) * size })) };
    }
  }
  return null;
}

/** Step 1: every whitelisted POI inside the cells. Elements come back with tags and bounds (`bb`). */
function buildTileQuery(cells, categories) {
  const stmts = STATEMENTS.filter((st) => st.cats.some((c) => categories.includes(c)));
  const body = cells.flatMap((c) => stmts.map((st) => `nwr${st.q}(${fmt(c.s)},${fmt(c.w)},${fmt(c.n)},${fmt(c.e)});`));
  return `[out:json][timeout:${overpass.serverTimeoutSeconds()}];(${body.join('')});out tags bb;`;
}

/**
 * Step 2: for the area candidates (`refs` = ['way/1', 'relation/2']) ask Overpass which lie within maxM / nearM of each
 * route's fine line. Per route: `.fK` (far) ids, count, `.nK` (near) ids, count.
 */
function buildRefineQuery(refs, fineLines) {
  const { maxM, nearM } = config.scenery;
  const ids = (type) => refs.filter((r) => r.startsWith(`${type}/`)).map((r) => r.split('/')[1]);
  const w = ids('way'); const r = ids('relation');
  const out = [`[out:json][timeout:${overpass.serverTimeoutSeconds()}];(${w.length ? `way(id:${w.join(',')});` : ''}${r.length ? `relation(id:${r.join(',')});` : ''})->.a;`];
  fineLines.forEach((line, k) => {
    const p = polyArgs(line);
    out.push(`nwr.a(around:${maxM},${p})->.f${k};.f${k} out ids;.f${k} out count;`);
    out.push(`nwr.f${k}(around:${nearM},${p})->.n${k};.n${k} out ids;.n${k} out count;`);
  });
  return out.join('\n');
}

/** Per route: { far: Set('type/id'), near: Set('type/id') }. */
function parseRefine(elements, routeCount) {
  const blocks = []; let cur = [];
  for (const el of elements) { if (el.type === 'count') { blocks.push(cur); cur = []; } else cur.push(`${el.type}/${el.id}`); }
  if (blocks.length !== routeCount * 2) throw new overpass.OverpassError('parse', `Expected ${routeCount * 2} result blocks from Overpass, got ${blocks.length}`);
  return Array.from({ length: routeCount }, (_, k) => ({ far: new Set(blocks[2 * k]), near: new Set(blocks[2 * k + 1]) }));
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
 * Which areas are within range of this route, and how close: `exact` (Overpass tested the real outline) or, when the
 * refine step was not available, the bounding-box distance. Nodes are always measured exactly here.
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
 * Scores one route. `line` = the route polyline; `elements` = candidate OSM elements; `exact` = the refine result for this
 * route ({far, near} sets) or null; `wanted` limits counted categories (null = all). Pure function - unit tested with
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

/**
 * routes: planner routes carrying `analysis`. categories: optional subset of CATEGORY_KEYS the traveller asked for.
 * Never throws: a failure becomes `{ available:false, reason }` and the UI says scenery information is unavailable.
 */
async function assessScenery(routes, categories = null, opts = {}) {
  if (!config.scenery.enabled) return unavailable(routes.length, 'scenery analysis is switched off (SCENERY=off).');
  const wanted = categories && categories.length ? categories.filter((c) => CATEGORY_KEYS.includes(c)) : null;
  const queryCats = wanted && wanted.length ? wanted : CATEGORY_KEYS;
  const lines = routes.map(queryLine);
  if (lines.some((l) => l.length < 2)) return unavailable(routes.length, 'the routes had no geometry to analyse.');
  const tiles = tilesFor(lines);
  if (!tiles) return unavailable(routes.length, 'the route is too long to look up scenery without overloading the public OpenStreetMap server.');

  let step1;
  try { step1 = await overpass.run(buildTileQuery(tiles.cells, queryCats), 'scenery-pois', opts); } catch (err) {
    return unavailable(routes.length, `the OpenStreetMap Overpass service could not be reached (${err.kind || 'error'}).`);
  }
  const elements = step1.elements.filter((e) => (e.type === 'node' ? Number.isFinite(e.lat) : !!e.bounds));

  // Areas that could possibly be in range (bounding-box distance is a lower bound): ask Overpass for the exact test.
  const areaRefs = new Set();
  elements.forEach((el) => {
    if (el.type === 'node' || !classify(el.tags) || (wanted && !wanted.includes(classify(el.tags).category))) return;
    if (lines.some((l) => distanceToBoxM(l, boundsOf(el)) <= config.scenery.maxM)) areaRefs.add(`${el.type}/${el.id}`);
  });
  let exact = null; let refineNote = null;
  if (areaRefs.size && opts.deadline && opts.deadline - Date.now() < 6000) {
    refineNote = 'exact outline test skipped (request time budget nearly used up); areas use bounding-box distance';
  } else if (areaRefs.size) {
    try {
      const step2 = await overpass.run(buildRefineQuery([...areaRefs], lines), 'scenery-areas', opts);
      exact = parseRefine(step2.elements, routes.length);
    } catch (err) { refineNote = `exact outline test unavailable (${err.kind || 'error'}); areas use bounding-box distance`; }
  }

  const label = wanted && wanted.length ? list(wanted.map((c) => CATEGORIES[c].label)) : null;
  const perRoute = lines.map((line, i) => {
    const s = scoreRoute(line, elements, exact ? exact[i] : null, wanted && wanted.length ? wanted : null);
    return {
      available: true, ...s, summary: describe(s, label), source: 'OpenStreetMap POIs via Overpass API',
      thresholds: { nearM: config.scenery.nearM, maxM: config.scenery.maxM, maxPerCategory: config.scenery.maxPerCategory }, categoriesCounted: wanted && wanted.length ? wanted : CATEGORY_KEYS,
      pois: s.pois.slice(0, 12),
    };
  });
  log('SCENERY', `POI scores: ${perRoute.map((p) => `${p.score} (${p.totalPois} POIs)`).join(' / ')}${refineNote ? ` | ${refineNote}` : ''}`);
  return {
    available: true, perRoute,
    meta: { provider: 'Overpass', requested: true, cached: step1.cached, ms: step1.ms, categories: queryCats, tiles: tiles.cells.length, candidates: elements.length, ...(refineNote ? { note: refineNote } : {}) },
  };
}

module.exports = {
  assessScenery, unavailableFor: unavailable, scoreRoute, classify, dedupe, tilesFor, buildTileQuery, buildRefineQuery, parseRefine,
  distanceToBoxM, queryLine, CATEGORIES, CATEGORY_KEYS,
};
