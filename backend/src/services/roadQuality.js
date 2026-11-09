// "Better Road Conditions": a transparent route-quality score built ONLY from documented OpenStreetMap tags.
//
// What is (and is not) known:
//  - OSRM returns road NAMES and refs per step. It does not return surface, smoothness or road class.
//  - OpenStreetMap ways MAY carry `surface=*` (asphalt, gravel, ...) and `smoothness=*` (excellent ... impassable).
//    Many roads have neither tag. A missing tag means "unknown", never "good" and never "bad".
//  - `highway=*` (motorway, primary, ...) is a road CLASSIFICATION (function/importance). It is shown for context but
//    is deliberately NOT part of the score: a motorway can be potholed and a residential street can be perfect.
//  - Pothole, crack or safety information is not available from these tags and is never claimed.
//
// Method: sample points along each OSRM route, ask Overpass for the highway ways in a small box around each sample,
// pick the way whose name/ref equals the road name OSRM says the route is on at that point, and read its tags.
// Roads whose name cannot be matched stay "unknown" (no guessing by proximity alone).
const config = require('../config');
const overpass = require('./overpass');
const { samplePointsAlong } = require('../utils');
const { log } = require('../log');

/* ---------- Documented tag -> credit tables (ordinal heuristics, NOT physical measurements) ---------- */

// smoothness=* (OSM wiki "Key:smoothness"). Used first when present: it describes the actual ride quality.
const SMOOTHNESS_CREDIT = { excellent: 1, good: 0.85, intermediate: 0.6, bad: 0.35, very_bad: 0.15, horrible: 0.05, very_horrible: 0, impassable: 0 };

// surface=* (OSM wiki "Key:surface"). Used only when smoothness is absent. A paved surface says nothing about
// potholes, so it is capped (0.75) below smoothness=good (0.85).
const PAVED_SMOOTH = ['asphalt', 'paved', 'chipseal', 'concrete', 'concrete:lanes', 'concrete:plates'];
const PAVED_ROUGH = ['paving_stones', 'sett', 'unhewn_cobblestone', 'cobblestone', 'bricks', 'grass_paver', 'metal', 'wood', 'tiles'];
const UNPAVED = ['unpaved', 'compacted', 'fine_gravel', 'gravel', 'shells', 'rock', 'pebblestone', 'ground', 'dirt', 'earth', 'grass', 'mud', 'sand', 'woodchips', 'snow', 'ice', 'salt'];
const SURFACE_CREDIT = { paved_smooth: 0.75, paved_rough: 0.5, unpaved: 0.15 };

const classOfSurface = (s) => (PAVED_SMOOTH.includes(s) ? 'paved_smooth' : PAVED_ROUGH.includes(s) ? 'paved_rough' : UNPAVED.includes(s) ? 'unpaved' : null);

// highway=* values that are not a road a car drives on today (not built yet, closed, or for walking/cycling only).
const NOT_DRIVABLE = 'construction|proposed|planned|abandoned|disused|razed|path|footway|cycleway|pedestrian|steps|bridleway|corridor|elevator|platform|bus_guideway|raceway';
const NOT_DRIVABLE_RE = new RegExp('^(' + NOT_DRIVABLE + ')$');

/**
 * Reads the quality-related tags of one way.
 * Returns { basis: 'smoothness'|'surface'|null, credit: 0..1|null, pavedClass: 'paved'|'unpaved'|'unknown' }.
 * Multi-value tags ("asphalt;gravel") use the worst recognised value. Unrecognised values count as unknown.
 */
function interpretTags(tags = {}) {
  const values = (v) => String(v || '').toLowerCase().split(';').map((x) => x.trim()).filter(Boolean);
  const surfaces = values(tags.surface).map(classOfSurface).filter(Boolean);
  const pavedClass = !surfaces.length ? 'unknown' : surfaces.every((c) => c !== 'unpaved') ? 'paved' : 'unpaved';
  const smooth = values(tags.smoothness).filter((v) => v in SMOOTHNESS_CREDIT).map((v) => SMOOTHNESS_CREDIT[v]);
  if (smooth.length) return { basis: 'smoothness', credit: Math.min(...smooth), pavedClass };
  if (surfaces.length) return { basis: 'surface', credit: Math.min(...surfaces.map((c) => SURFACE_CREDIT[c])), pavedClass };
  return { basis: null, credit: null, pavedClass: 'unknown' };
}

/* ---------- Matching OSM ways to OSRM's road names ---------- */

const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const compact = (s) => s.replace(/ /g, ''); // "NH 32" and "NH32" are the same ref
const refTokens = (s) => String(s || '').split(/[;,]/).map(norm).filter(Boolean).map(compact);

/** Names/refs an OSM way is known by. */
function wayNames(tags = {}) {
  const names = [tags.name, tags['name:en'], tags.alt_name, tags.official_name, tags.loc_name].flatMap((v) => String(v || '').split(';')).map(norm).filter(Boolean);
  return new Set([...names, ...names.map(compact), ...refTokens(tags.ref)]);
}

/** True if the way carries the road name or ref OSRM reports for this step. */
function matchesStep(tags, step) {
  const wanted = [norm(step.name), compact(norm(step.name)), ...refTokens(step.ref)].filter(Boolean);
  if (!wanted.length) return false; // unnamed road: we do not guess by proximity alone
  const have = wayNames(tags);
  return wanted.some((w) => have.has(w));
}

/* ---------- Sampling ---------- */

/** Sample points of one route, each tagged with the OSRM step (road name) the route is on there. */
function sampleRoute(route) {
  const line = route.analysis?.line || route.geometry || [];
  const samples = samplePointsAlong(line, config.roadQuality.sampleSpacingM, config.roadQuality.maxSamples);
  const steps = route.analysis?.steps || [];
  const stepTotal = steps.reduce((s, st) => s + st.distanceM, 0);
  const lineTotal = samples.length ? samples[samples.length - 1].atM + samples[0].atM : 0; // ≈ route length (samples sit mid-slice)
  const scale = stepTotal > 0 && lineTotal > 0 ? stepTotal / lineTotal : 1;
  return samples.map((s) => {
    let acc = 0; let step = null;
    for (const st of steps) { acc += st.distanceM; if (s.atM * scale <= acc) { step = st; break; } }
    return { ...s, step: step || steps[steps.length - 1] || { name: '', ref: '' } };
  });
}

const fmt = (n) => Number(n).toFixed(6);

/**
 * One Overpass request for all samples of all routes. A small bounding box (± matchRadiusM) around each sample is used
 * instead of an `around` filter: it answers about twice as fast on the public server. Each sample's ways are followed
 * by a `count` element that acts as a delimiter.
 */
function buildQuery(sampleSets) {
  const r = config.roadQuality.matchRadiusM;
  const dLat = r / 111320;
  const lines = [`[out:json][timeout:${overpass.serverTimeoutSeconds()}];`];
  sampleSets.forEach((set, k) => set.forEach((s, i) => {
    const id = `r${k}s${i}`;
    const dLon = dLat / Math.max(0.2, Math.cos((s.lat * Math.PI) / 180));
    lines.push(`way(${fmt(s.lat - dLat)},${fmt(s.lon - dLon)},${fmt(s.lat + dLat)},${fmt(s.lon + dLon)})["highway"]["highway"!~"^(${NOT_DRIVABLE})$"]->.${id};.${id} out tags;.${id} out count;`);
  }));
  return lines.join('\n');
}

/** Splits the flat element list into one array of ways per sample using the `count` elements as delimiters. */
function splitBySample(elements, expected) {
  const groups = []; let cur = [];
  for (const el of elements) { if (el.type === 'count') { groups.push(cur); cur = []; } else if (el.type === 'way') cur.push(el); }
  if (groups.length !== expected) throw new overpass.OverpassError('parse', `Expected ${expected} result groups from Overpass, got ${groups.length}`);
  return groups;
}

/* ---------- Scoring ---------- */

const HIGHWAY_LABEL = {
  motorway: 'motorway', trunk: 'trunk road', primary: 'primary road', secondary: 'secondary road', tertiary: 'tertiary road',
  unclassified: 'minor road', residential: 'residential street', service: 'service road', living_street: 'living street', track: 'track', road: 'unknown-type road',
};
const highwayLabel = (h) => HIGHWAY_LABEL[String(h).replace(/_link$/, '')] || String(h).replace(/_/g, ' ');
const round = (x, d = 3) => { const f = 10 ** d; return Math.round(x * f) / f; };

const UNAVAILABLE_TEXT = 'Road quality data unavailable';

/**
 * Pure scoring step: `samples` = [{ weightM, step }], `groups` = ways found near each sample (same order).
 * Returns the per-route roadQuality object (without the cross-route availability decision).
 *   credit(sample) = smoothness credit, else surface credit, else 0 (undocumented earns nothing)
 *   score          = 100 x  sum(weight x credit) / sum(weight)       <- "documented quality points per route length"
 *   coverage       = share of route length whose way has a recognised surface or smoothness tag
 */
function summariseRoute(samples, groups) {
  const total = samples.reduce((s, x) => s + x.weightM, 0) || 1;
  const acc = { credit: 0, known: 0, matched: 0, paved: 0, unpaved: 0, smoothKnown: 0 };
  const classes = new Map(); const evidence = new Map();
  samples.forEach((s, i) => {
    const matches = (groups[i] || []).filter((w) => !NOT_DRIVABLE_RE.test(w.tags?.highway) && matchesStep(w.tags, s.step));
    if (!matches.length) return;
    // Several candidate ways (e.g. both carriageways): use the least favourable documented one - never the most flattering.
    const read = matches.map((w) => ({ w, t: interpretTags(w.tags) }));
    const documented = read.filter((x) => x.t.credit !== null);
    const pick = (documented.length ? documented : read).sort((a, b) => (a.t.credit ?? 2) - (b.t.credit ?? 2))[0];
    acc.matched += s.weightM;
    classes.set(pick.w.tags.highway, (classes.get(pick.w.tags.highway) || 0) + s.weightM);
    if (pick.t.credit !== null) {
      acc.known += s.weightM; acc.credit += s.weightM * pick.t.credit;
      if (pick.t.pavedClass === 'paved') acc.paved += s.weightM; else if (pick.t.pavedClass === 'unpaved') acc.unpaved += s.weightM;
      if (pick.t.basis === 'smoothness') acc.smoothKnown += s.weightM;
      if (!evidence.has(pick.w.id)) evidence.set(pick.w.id, { wayId: pick.w.id, name: pick.w.tags.name || pick.w.tags.ref || '', highway: pick.w.tags.highway, surface: pick.w.tags.surface || null, smoothness: pick.w.tags.smoothness || null });
    }
  });
  return {
    score: round((100 * acc.credit) / total, 1),
    coverage: round(acc.known / total),
    matchedShare: round(acc.matched / total),
    pavedShare: round(acc.paved / total),
    unpavedShare: round(acc.unpaved / total),
    unknownShare: round(1 - acc.known / total),
    smoothnessKnownShare: round(acc.smoothKnown / total),
    classes: [...classes.entries()].sort((a, b) => b[1] - a[1]).map(([h, m]) => ({ highway: h, label: highwayLabel(h), share: round(m / total) })),
    evidence: [...evidence.values()].slice(0, 6),
    sampleCount: samples.length,
  };
}

const pct = (x) => `${Math.round(x * 100)}%`;

function describe(q) {
  const cls = q.classes.slice(0, 3).map((c) => `${c.label} ${pct(c.share)}`).join(', ');
  const classText = cls ? ` Road classification (not a quality measure): ${cls}.` : '';
  if (!q.available) {
    return `${UNAVAILABLE_TEXT}: surface or smoothness is documented for only ${pct(q.coverage)} of the sampled route.${classText}`;
  }
  return `Surface or smoothness is documented for ${pct(q.coverage)} of the sampled route (${pct(q.pavedShare)} paved, ${pct(q.unpavedShare)} unpaved); the remaining ${pct(q.unknownShare)} is unknown, not assumed good or bad.${classText}`;
}

const unavailable = (n, reason) => ({
  available: false,
  reason,
  perRoute: Array.from({ length: n }, () => ({ available: false, score: null, coverage: null, reason, summary: `${UNAVAILABLE_TEXT}: ${reason}`, classes: [], evidence: [], source: 'OpenStreetMap tags via Overpass API' })),
  meta: { provider: 'Overpass', requested: false },
});

/**
 * routes: planner routes carrying `analysis`. Never throws: a failure becomes `{ available:false, reason }`.
 * Returns { available, reason?, perRoute:[roadQuality], meta }. `available` means at least one route has enough
 * documented data (coverage >= ROAD_MIN_COVERAGE) to be ranked on road quality.
 */
async function assessRoads(routes, opts = {}) {
  if (!config.roadQuality.enabled) return unavailable(routes.length, 'road-quality analysis is switched off (ROAD_QUALITY=off).');
  const sampleSets = routes.map(sampleRoute);
  const total = sampleSets.reduce((n, s) => n + s.length, 0);
  if (!total) return unavailable(routes.length, 'the routes had no geometry to analyse.');

  let result;
  try { result = await overpass.run(buildQuery(sampleSets), 'road-tags', opts); } catch (err) {
    return unavailable(routes.length, `the OpenStreetMap Overpass service could not be reached (${err.kind || 'error'}).`);
  }
  let groups;
  try { groups = splitBySample(result.elements, total); } catch {
    return unavailable(routes.length, 'the OpenStreetMap response could not be interpreted.');
  }

  let offset = 0;
  const perRoute = sampleSets.map((samples) => {
    const q = summariseRoute(samples, groups.slice(offset, offset + samples.length));
    offset += samples.length;
    return { ...q, available: false, source: 'OpenStreetMap tags via Overpass API', method: `sampled ${samples.length} points along the route` };
  });
  const usable = perRoute.some((q) => q.coverage >= config.roadQuality.minCoverage);
  for (const q of perRoute) {
    q.available = usable;
    if (!usable) { q.reason = `fewer than ${pct(config.roadQuality.minCoverage)} of any route has a documented surface or smoothness tag in OpenStreetMap.`; q.score = null; }
    q.summary = describe({ ...q, available: usable });
  }
  log('ROADS', `Sampled ${total} points | coverage ${perRoute.map((q) => pct(q.coverage)).join(' / ')} | usable for ranking: ${usable}`);
  return {
    available: usable,
    reason: usable ? undefined : perRoute[0].reason,
    perRoute,
    meta: { provider: 'Overpass', requested: true, cached: result.cached, ms: result.ms, samples: total },
  };
}

module.exports = { assessRoads, unavailableFor: unavailable, summariseRoute, interpretTags, matchesStep, sampleRoute, buildQuery, splitBySample, UNAVAILABLE_TEXT, SMOOTHNESS_CREDIT, SURFACE_CREDIT };
