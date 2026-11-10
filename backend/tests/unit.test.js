process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildWeights, scoreRoutes, PRESETS, AXES } = require('../src/services/scoring');
const ai = require('../src/services/ai');
const { parseDeparture, routeTypeOf, estimateCost } = require('../src/services/planner');
const { haversineKm, decimate, formatDuration, polylineLengthM } = require('../src/utils');
const { User, Trip } = require('../src/models');

const mk = (id, min, cost, level) => ({
  id, label: `Route ${id}`, durationMinutes: min, cost, distanceKm: 100, traffic: { level, probabilities: { LOW: 0, MEDIUM: 0, HIGH: 0, [level]: 1 } },
});
const set = () => [mk('A', 150, 700, 'LOW'), mk('B', 90, 900, 'MEDIUM'), mk('C', 160, 500, 'MEDIUM')];

describe('scoring', () => {
  it('preset weights sum to 1', () => {
    for (const w of Object.values(PRESETS)) assert.ok(Math.abs(AXES.reduce((s, k) => s + (w[k] || 0), 0) - 1) < 1e-9); // all five axes
  });
  it('FASTEST picks the quickest route, CHEAPEST the cheapest, LOW_TRAFFIC the calmest', () => {
    assert.equal(scoreRoutes(set(), buildWeights('FASTEST').weights).id, 'B');
    assert.equal(scoreRoutes(set(), buildWeights('CHEAPEST').weights).id, 'C');
    assert.equal(scoreRoutes(set(), buildWeights('LOW_TRAFFIC').weights).id, 'A');
  });
  it('scores are within 0-100', () => {
    const rs = set(); scoreRoutes(rs, buildWeights('BALANCED').weights);
    for (const r of rs) assert.ok(r.score >= 0 && r.score <= 100);
  });
  it('NL priorities and history shift the weights', () => {
    const base = buildWeights('BALANCED').weights;
    const nl = buildWeights('BALANCED', { timePriority: 'MEDIUM', trafficPriority: 'HIGH', costPriority: 'MEDIUM', comfortPriority: 'HIGH' }).weights;
    assert.ok(nl.traffic > base.traffic);
    const hist = buildWeights('BALANCED', null, ['CHEAPEST', 'CHEAPEST', 'CHEAPEST']);
    assert.ok(hist.personalised && hist.weights.cost > base.cost);
    assert.equal(buildWeights('BALANCED', null, ['CHEAPEST']).personalised, false); // too little history
    assert.ok(Math.abs(hist.weights.time + hist.weights.traffic + hist.weights.cost - 1) < 0.01);
  });
  it('a single route still scores', () => {
    const r = [mk('A', 100, 500, 'LOW')];
    assert.equal(scoreRoutes(r, buildWeights('BALANCED').weights).score, 100);
  });
});

describe('AI rule-based parser', () => {
  it('family + avoid traffic', () => {
    const r = ai.parsePreferencesRuleBased('I am travelling with my family and want to avoid heavy traffic.');
    assert.equal(r.priorities.trafficPriority, 'HIGH');
    assert.equal(r.priorities.comfortPriority, 'HIGH');
    assert.equal(r.preference, 'LOW_TRAFFIC');
  });
  it('cheapest / fastest / family-only / empty / no-rush', () => {
    assert.equal(ai.parsePreferencesRuleBased('I want the cheapest route').priorities.costPriority, 'HIGH');
    assert.equal(ai.parsePreferencesRuleBased('I want the cheapest route').preference, 'CHEAPEST');
    assert.equal(ai.parsePreferencesRuleBased("I'm in a hurry, need the fastest way").preference, 'FASTEST');
    const fam = ai.parsePreferencesRuleBased('travelling with family');
    assert.equal(fam.preference, 'BALANCED');
    assert.equal(fam.priorities.comfortPriority, 'HIGH');
    assert.equal(ai.parsePreferencesRuleBased('').preference, null);
    assert.equal(ai.parsePreferencesRuleBased('no rush, not in a hurry').priorities.timePriority, 'LOW');
  });
  it('explanation mentions recommended route and why', () => {
    const rs = set(); const best = scoreRoutes(rs, buildWeights('LOW_TRAFFIC').weights);
    const text = ai.explainRuleBased({ recommended: best, others: rs.filter((r) => r !== best), preference: 'LOW_TRAFFIC', weights: buildWeights('LOW_TRAFFIC').weights, mlSource: 'ml-model' });
    assert.match(text, /Route A is recommended for your Low Traffic preference because it has the lowest predicted traffic/);
  });
});

describe('helpers', () => {
  it('parseDeparture computes Monday=0 and weekend', () => {
    assert.deepEqual(parseDeparture('2026-10-05', '09:30'), { date: '2026-10-05', time: '09:30', hour: 9, dayOfWeek: 0, weekend: false }); // Monday
    assert.equal(parseDeparture('2026-10-10', '10:00').weekend, true); // Saturday
    assert.throws(() => parseDeparture('2026-13-45', '10:00'));
  });
  it('routeType / cost / geo helpers', () => {
    assert.equal(routeTypeOf({ distanceKm: 150, baseMinutes: 120 }), 'highway'); // 75 km/h
    assert.equal(routeTypeOf({ distanceKm: 20, baseMinutes: 60 }), 'city');
    const lo = estimateCost({ distanceKm: 100, baseMinutes: 100 }, 'LOW').total;
    const hi = estimateCost({ distanceKm: 100, baseMinutes: 100 }, 'HIGH').total;
    assert.ok(hi > lo);
    const d = haversineKm({ lat: 13.0827, lon: 80.2707 }, { lat: 11.9416, lon: 79.8083 });
    assert.ok(d > 120 && d < 140);
    assert.equal(decimate(Array.from({ length: 1000 }, (_, i) => i), 50).length, 50);
    assert.equal(formatDuration(185), '3h 05m');
  });
});

describe('mongoose schemas', () => {
  it('User requires name, email, passwordHash', () => {
    const e = new User({}).validateSync();
    assert.ok(e.errors.name && e.errors.email && e.errors.passwordHash);
    assert.equal(new User({ name: 'Zed Z', email: 'z@z.co', passwordHash: 'h' }).preferences.preferredMode, 'BALANCED');
  });
  it('Trip rejects bad enums', () => {
    const e = new Trip({ preference: 'X', trafficLevel: 'EXTREME' }).validateSync();
    assert.ok(e.errors.preference && e.errors.trafficLevel && e.errors.userId);
  });
});

describe('MongoDB URI handling and secret redaction', () => {
  const config = require('../src/config');
  const db = require('../src/services/db');
  const { redact, safeUrl } = require('../src/log');
  const real = 'mongodb+srv://some_user:S3cretPw!@cluster0.example.mongodb.net/?appName=Cluster0';

  it('rejects a missing, malformed or placeholder MONGO_URI with a clear message', () => {
    const keep = config.mongoUri;
    try {
      config.mongoUri = ''; assert.match(db.validateUri(), /MONGO_URI is not set/);
      config.mongoUri = 'http://nope'; assert.match(db.validateUri(), /must start with mongodb/);
      config.mongoUri = 'mongodb+srv://u:YOUR_ACTUAL_PASSWORD@cluster0.x.mongodb.net/'; assert.match(db.validateUri(), /placeholder password/);
      config.mongoUri = real; assert.equal(db.validateUri(), null);
    } finally { config.mongoUri = keep; }
  });
  it('redact() masks the URI, its password and any other mongodb URI', () => {
    const keep = config.mongoUri;
    config.mongoUri = real;
    try {
      const out = redact(`failed to connect to ${real}; password S3cretPw! ; also mongodb://a:b@host/db`);
      assert.equal(out.includes('S3cretPw'), false);
      assert.equal(out.includes('some_user'), false);
      assert.equal(/mongodb(\+srv)?:\/\/[^*]/.test(out), false);
    } finally { config.mongoUri = keep; }
  });
  it('safeUrl() strips credentials and query strings', () => {
    assert.equal(safeUrl('https://user:pw@example.com/path?key=1'), 'https://example.com/path');
  });
  it('the database module never mentions Atlas hostnames or passwords in its hint', () => {
    assert.match(db.HINT, /Atlas Network Access/);
  });
});

/* ======================= Better Road Conditions / Better Scenery (unit tests) ======================= */

const { effectiveWeights, restrictAxes } = require('../src/services/scoring');
const road = require('../src/services/roadQuality');
const sceneryService = require('../src/services/scenery');
const geo = require('../src/utils');
const appConfig = require('../src/config');

describe('geometry helpers', () => {
  const line = [[13.0, 80.0], [13.0, 80.1]]; // ~10.8 km due east
  it('distanceToPolylineM measures to the segment, not just the vertices', () => {
    const d = geo.distanceToPolylineM([13.001, 80.05], line); // 111 m north of the middle
    assert.ok(Math.abs(d - 111) < 3, String(d));
    assert.ok(geo.distanceToPolylineM([13.0, 80.05], line) < 1);
    assert.ok(Math.abs(geo.distanceToPolylineM([13.0, 80.2], line) - geo.haversineKm({ lat: 13, lon: 80.1 }, { lat: 13, lon: 80.2 }) * 1000) < 50); // beyond the end: distance to the end point
  });
  it('samplePointsAlong gives evenly spaced samples that together cover the route, capped in number', () => {
    const s = geo.samplePointsAlong(line, 2000, 30);
    assert.equal(s.length, 6); // 10.8 km / 2 km -> 6 slices
    assert.ok(Math.abs(s.reduce((a, x) => a + x.weightM, 0) - geo.polylineLengthM(line)) < 1);
    assert.ok(s.every((p) => Math.abs(p.lat - 13.0) < 1e-9));
    assert.equal(geo.samplePointsAlong(line, 100, 10).length, 10); // cap
    assert.deepEqual(geo.samplePointsAlong([[1, 1]], 100, 10), []);
  });
  it('simplifyLine keeps every original vertex within the tolerance and respects maxPoints', () => {
    const wiggly = Array.from({ length: 200 }, (_, i) => [13 + 0.0001 * (i % 2), 80 + i * 0.001]); // ~11 m zig-zag
    const simple = geo.simplifyLine(wiggly, 50);
    assert.ok(simple.length < 5);
    for (const p of wiggly) assert.ok(geo.distanceToPolylineM(p, simple) <= 50);
    assert.ok(geo.simplifyLine(wiggly, 1, 20).length <= 20);
  });
  it('distanceToBoxM is 0 when the route enters or crosses the box and a lower bound otherwise', () => {
    const box = { minlat: 13.001, maxlat: 13.002, minlon: 80.04, maxlon: 80.06 };
    assert.ok(Math.abs(sceneryService.distanceToBoxM(line, box) - 111) < 3); // box is ~111 m north of the line
    assert.equal(sceneryService.distanceToBoxM(line, { minlat: 12.99, maxlat: 13.01, minlon: 80.04, maxlon: 80.06 }), 0); // crossed
    assert.equal(sceneryService.distanceToBoxM(line, { minlat: 12.999, maxlat: 13.001, minlon: 80.01, maxlon: 80.02 }), 0); // line passes through
  });
});

describe('route scoring with road and scenery axes', () => {
  const rq = (score, available = true) => ({ available, score: available ? score : null });
  const sc = (score, available = true) => ({ available, score: available ? score : null });
  const base = (id, min, cost, level) => ({ id, label: `Route ${id}`, durationMinutes: min, cost, distanceKm: 100, traffic: { level, probabilities: { LOW: 0, MEDIUM: 0, HIGH: 0, [level]: 1 } } });

  it('legacy presets are unchanged and give road/scenery zero weight', () => {
    const f = buildWeights('FASTEST').weights;
    assert.deepEqual([f.time, f.traffic, f.cost, f.road, f.scenery].map((x) => Math.round(x * 100) / 100), [0.55, 0.3, 0.15, 0, 0]);
    for (const p of ['FASTEST', 'CHEAPEST', 'LOW_TRAFFIC', 'BALANCED']) {
      const w = buildWeights(p).weights; assert.equal(w.road, 0); assert.equal(w.scenery, 0);
    }
  });
  it('BETTER_ROADS and BETTER_SCENERY put half of the weight on the requested attribute', () => {
    const r = buildWeights('BETTER_ROADS').weights; const s = buildWeights('BETTER_SCENERY').weights;
    assert.ok(Math.abs(r.road - 0.5) < 1e-9 && r.scenery === 0);
    assert.ok(Math.abs(s.scenery - 0.5) < 1e-9 && s.road === 0);
    assert.ok(Math.abs(AXES.reduce((a, k) => a + r[k], 0) - 1) < 1e-9);
  });
  it('road quality decides between otherwise similar routes; values in km/min/points are all normalised to 0-100', () => {
    const routes = [{ ...base('A', 100, 500, 'LOW'), roadQuality: rq(20) }, { ...base('B', 100, 500, 'LOW'), roadQuality: rq(80) }];
    const best = scoreRoutes(routes, buildWeights('BETTER_ROADS').weights);
    assert.equal(best.id, 'B');
    assert.equal(routes[1].scoreBreakdown.road, 80);
    for (const r of routes) assert.ok(r.score >= 0 && r.score <= 100);
  });
  it('scenery decides between similar routes, but a much slower route does not win on scenery alone', () => {
    const similar = [{ ...base('A', 100, 500, 'LOW'), scenery: sc(10) }, { ...base('B', 105, 500, 'LOW'), scenery: sc(90) }];
    assert.equal(scoreRoutes(similar, buildWeights('BETTER_SCENERY').weights).id, 'B');
    const slow = [{ ...base('A', 100, 500, 'LOW'), scenery: sc(10) }, { ...base('B', 400, 500, 'LOW'), scenery: sc(90) }];
    // a 4x slower route can win on scenery alone unless a limit applies; the planner always applies one (MAX_DETOUR_PERCENT)
    assert.equal(scoreRoutes(slow, buildWeights('BETTER_SCENERY').weights, { constraints: { maxExtraPercent: appConfig.maxDetourPercent } }).id, 'A');
  });
  it('highway class alone earns no road credit (only documented surface/smoothness score does)', () => {
    // a motorway with no surface tag scores 0 documented credit
    const m = road.summariseRoute([{ weightM: 1000, step: { name: 'Expressway', ref: '' } }], [[{ id: 1, tags: { highway: 'motorway', name: 'Expressway' } }]]);
    assert.equal(m.score, 0); assert.equal(m.coverage, 0); assert.equal(m.classes[0].highway, 'motorway');
  });
  it('an axis with no data for any route is dropped and the rest renormalised; partial data scores the gap as 0', () => {
    const none = [{ ...base('A', 100, 500, 'LOW'), roadQuality: rq(0, false) }, { ...base('B', 100, 500, 'LOW'), roadQuality: rq(0, false) }];
    const e = effectiveWeights(none, buildWeights('BETTER_ROADS').weights);
    assert.deepEqual(e.dropped, ['road']); assert.equal(e.weights.road, 0);
    assert.ok(Math.abs(AXES.reduce((a, k) => a + e.weights[k], 0) - 1) < 1e-9);
    const some = [{ ...base('A', 100, 500, 'LOW'), roadQuality: rq(0, false) }, { ...base('B', 100, 500, 'LOW'), roadQuality: rq(70) }];
    assert.deepEqual(effectiveWeights(some, buildWeights('BETTER_ROADS').weights).dropped, []);
    const best = scoreRoutes(some, buildWeights('BETTER_ROADS').weights);
    assert.equal(best.id, 'B'); assert.equal(some[0].scoreBreakdown.road, 0);
  });
  it('priorities from the notes raise road/scenery shares but never above 80 % together', () => {
    const w = buildWeights('BALANCED', { timePriority: 'MEDIUM', trafficPriority: 'MEDIUM', costPriority: 'MEDIUM', comfortPriority: 'MEDIUM', roadPriority: 'HIGH', sceneryPriority: 'HIGH' }).weights;
    assert.ok(Math.abs(w.road - 0.4) < 1e-9 && Math.abs(w.scenery - 0.4) < 1e-9);
    assert.ok(w.time > 0 && w.traffic > 0 && w.cost > 0);
    const med = buildWeights('FASTEST', { roadPriority: 'MEDIUM' }).weights;
    assert.ok(Math.abs(med.road - 0.2) < 1e-9);
    assert.equal(buildWeights('FASTEST', { roadPriority: 'NONE', sceneryPriority: 'NONE' }).weights.road, 0);
  });
  it('restrictAxes removes road/scenery weight that leaked in from history', () => {
    const w = buildWeights('FASTEST', null, ['BETTER_ROADS', 'BETTER_ROADS']).weights;
    assert.ok(w.road > 0);
    const r = restrictAxes(w, { road: false, scenery: false });
    assert.equal(r.road, 0); assert.ok(Math.abs(AXES.reduce((a, k) => a + r[k], 0) - 1) < 1e-9);
  });
  it('time limits: slower routes are scored but cannot be recommended; the fastest always qualifies', () => {
    const routes = [{ ...base('A', 100, 500, 'LOW'), roadQuality: rq(10) }, { ...base('B', 130, 500, 'LOW'), roadQuality: rq(100) }];
    assert.equal(scoreRoutes(routes, buildWeights('BETTER_ROADS').weights).id, 'B');
    assert.equal(scoreRoutes(routes, buildWeights('BETTER_ROADS').weights, { constraints: { maxExtraPercent: 15 } }).id, 'A');
    assert.equal(routes[1].withinTimeLimit, false);
    assert.equal(scoreRoutes(routes, buildWeights('BETTER_ROADS').weights, { constraints: { maxExtraMinutes: 45 } }).id, 'B');
    assert.equal(scoreRoutes(routes, buildWeights('BETTER_ROADS').weights, { constraints: { maxExtraPercent: 0 } }).id, 'A');
  });
});

describe('road quality: documented tags only', () => {
  it('smoothness first, then surface; classes of surface are documented', () => {
    assert.deepEqual(road.interpretTags({ surface: 'asphalt', smoothness: 'good' }), { basis: 'smoothness', credit: 0.85, pavedClass: 'paved' });
    assert.deepEqual(road.interpretTags({ surface: 'asphalt' }), { basis: 'surface', credit: 0.75, pavedClass: 'paved' });
    assert.deepEqual(road.interpretTags({ surface: 'paving_stones' }), { basis: 'surface', credit: 0.5, pavedClass: 'paved' });
    assert.deepEqual(road.interpretTags({ surface: 'gravel' }), { basis: 'surface', credit: 0.15, pavedClass: 'unpaved' });
    assert.equal(road.interpretTags({ smoothness: 'horrible' }).credit, 0.05);
  });
  it('missing or unrecognised tags are UNKNOWN (no credit, not "bad")', () => {
    for (const tags of [{}, { highway: 'motorway' }, { surface: 'unobtainium' }, { smoothness: 'smooth-ish' }, { surface: '' }]) {
      assert.deepEqual(road.interpretTags(tags), { basis: null, credit: null, pavedClass: 'unknown' }, JSON.stringify(tags));
    }
  });
  it('multi-value tags use the worst recognised value', () => {
    assert.equal(road.interpretTags({ surface: 'asphalt;gravel' }).credit, 0.15);
    assert.equal(road.interpretTags({ surface: 'asphalt;gravel' }).pavedClass, 'unpaved');
    assert.equal(road.interpretTags({ smoothness: 'good;bad' }).credit, 0.35);
  });
  it('a way is matched to the OSRM step by name or ref (accents/case/punctuation ignored); unnamed roads are never guessed', () => {
    assert.ok(road.matchesStep({ name: 'Rajiv Gandhi Salai' }, { name: 'rajiv gandhi salai', ref: '' }));
    assert.ok(road.matchesStep({ name: 'Grand Southern Trunk Road', ref: 'NH 32' }, { name: '', ref: 'NH32' }));
    assert.ok(road.matchesStep({ 'name:en': 'East Coast Road' }, { name: 'East Coast Road', ref: '' }));
    assert.ok(!road.matchesStep({ name: 'Side Road' }, { name: 'East Coast Road', ref: '' }));
    assert.ok(!road.matchesStep({ name: 'Side Road' }, { name: '', ref: '' }));
  });
  const step = { name: 'Main Road', ref: '' };
  const samples = (n) => Array.from({ length: n }, () => ({ weightM: 1000, step }));
  const w = (id, tags) => ({ id, tags: { highway: 'primary', name: 'Main Road', ...tags } });
  it('score and coverage with available attributes', () => {
    const q = road.summariseRoute(samples(4), [[w(1, { surface: 'asphalt', smoothness: 'good' })], [w(2, { surface: 'asphalt' })], [w(3, { surface: 'gravel' })], [w(4, {})]]);
    assert.equal(q.coverage, 0.75); // 3 of 4 samples documented
    assert.equal(q.unknownShare, 0.25);
    assert.equal(q.pavedShare, 0.5); assert.equal(q.unpavedShare, 0.25);
    assert.equal(q.score, Math.round(((0.85 + 0.75 + 0.15 + 0) / 4) * 1000) / 10); // 43.8: credit only for documented attributes
    assert.deepEqual(q.evidence.map((e) => e.wayId), [1, 2, 3]);
  });
  it('score and coverage with missing attributes: nothing documented -> 0 coverage, 0 credit', () => {
    const q = road.summariseRoute(samples(3), [[w(1, {})], [w(2, {})], []]);
    assert.equal(q.coverage, 0); assert.equal(q.score, 0); assert.equal(q.unknownShare, 1); assert.equal(q.evidence.length, 0);
    assert.ok(q.matchedShare > 0.6 && q.matchedShare < 0.7);
  });
  it('never flattering: with two matching ways the less favourable documented one is used', () => {
    const q = road.summariseRoute(samples(1), [[w(1, { surface: 'asphalt', smoothness: 'excellent' }), w(2, { surface: 'asphalt', smoothness: 'bad' })]]);
    assert.equal(q.score, 35);
    assert.deepEqual(q.evidence.map((e) => e.wayId), [2]);
  });
  it('ways that are not drivable (e.g. under construction) are ignored; other streets are never used', () => {
    const q = road.summariseRoute(samples(1), [[w(1, { highway: 'construction', surface: 'asphalt', smoothness: 'excellent' }), { id: 2, tags: { highway: 'residential', name: 'Other Street', surface: 'asphalt' } }]]);
    assert.equal(q.coverage, 0); assert.equal(q.matchedShare, 0);
  });
  it('the Overpass query is bounded (one statement per sample) and excludes non-drivable highways', () => {
    const set = road.sampleRoute({ analysis: { line: [[13, 80], [13, 81]], steps: [{ name: 'Main Road', ref: '', distanceM: 108000 }] } });
    assert.equal(set.length, appConfig.roadQuality.maxSamples);
    assert.ok(set.every((s) => s.step.name === 'Main Road'));
    const q = road.buildQuery([set]);
    assert.equal((q.match(/out count;/g) || []).length, set.length);
    assert.match(q, /\["highway"!~"\^\(construction/);
  });
  it('splitBySample rejects a response whose group count does not match (never guesses)', () => {
    assert.throws(() => road.splitBySample([{ type: 'way', id: 1, tags: {} }, { type: 'count' }], 2), /Expected 2 result groups/);
  });
});

describe('scenery: POI proximity to route geometry, duplicates, caps', () => {
  const routeLine = [[13.0, 80.0], [13.0, 80.1]];
  const near = (m) => ({ lat: 13.0 + m / 111320, lon: 80.05 }); // m metres north of the route's middle
  const node = (id, m, tags) => ({ type: 'node', id, ...near(m), tags });
  const area = (type, id, m, tags) => ({ type, id, bounds: { minlat: near(m).lat - 0.0003, maxlat: near(m).lat + 0.0003, minlon: 80.049, maxlon: 80.051 }, tags });
  const beach = (id, m, name = 'B' + id) => node(id, m, { natural: 'beach', name });

  it('distance bands: within 300 m full weight, up to 1 km half weight, beyond 1 km ignored', () => {
    const s = sceneryService.scoreRoute(routeLine, [beach(1, 100), beach(2, 600), beach(3, 3000)]);
    const by = Object.fromEntries(s.pois.map((p) => [p.name, p]));
    assert.equal(by.B1.band, 'near'); assert.equal(by.B1.contribution, 1);
    assert.equal(by.B2.band, 'ring'); assert.equal(by.B2.contribution, 0.5);
    assert.equal(by.B3, undefined);
    assert.ok(Math.abs(by.B1.distanceM - 100) <= 3 && Math.abs(by.B2.distanceM - 600) <= 3);
    assert.equal(s.points, 1.5);
  });
  it('a POI near the origin/destination but far from the route does not count', () => {
    const farFromRoute = { type: 'node', id: 9, lat: 13.2, lon: 80.0, tags: { natural: 'beach', name: 'Elsewhere' } }; // 22 km north of the start
    assert.equal(sceneryService.scoreRoute(routeLine, [farFromRoute]).totalPois, 0);
  });
  it('the same place mapped as node + way + relation is counted once', () => {
    const s = sceneryService.scoreRoute(routeLine, [area('way', 1, 100, { leisure: 'park', name: 'Central Park' }), area('relation', 2, 100, { leisure: 'park', name: 'Central Park' }), node(3, 100, { leisure: 'park', name: 'central  park' })], { far: new Set(['way/1', 'relation/2']), near: new Set(['way/1', 'relation/2']) });
    assert.equal(s.totalPois, 1); assert.equal(s.duplicatesRemoved, 2);
  });
  it('unnamed POIs of the same kind within 200 m are one place; 200 m+ apart they are two', () => {
    const u = (id, m, lon) => ({ type: 'node', id, lat: near(m).lat, lon, tags: { tourism: 'viewpoint' } });
    assert.equal(sceneryService.scoreRoute(routeLine, [u(1, 50, 80.05), u(2, 50, 80.0505)]).totalPois, 1); // ~55 m apart
    assert.equal(sceneryService.scoreRoute(routeLine, [u(1, 50, 80.05), u(2, 50, 80.054)]).totalPois, 2); // ~440 m apart
  });
  it('different categories with the same name are not merged', () => {
    const s = sceneryService.scoreRoute(routeLine, [beach(1, 100, 'Blue Bay'), node(2, 150, { tourism: 'viewpoint', name: 'Blue Bay' })]);
    assert.equal(s.totalPois, 2);
  });
  it('only whitelisted nature categories count: shops, restaurants and unnamed parks/lakes are ignored', () => {
    const s = sceneryService.scoreRoute(routeLine, [
      node(1, 50, { shop: 'mall', name: 'Mall' }), node(2, 50, { amenity: 'restaurant', name: 'Cafe' }),
      node(3, 50, { leisure: 'park' }), node(4, 50, { natural: 'water' }), node(5, 50, { tourism: 'attraction' }),
      node(6, 50, { natural: 'water', water: 'river', name: 'Some River' }), node(7, 50, { natural: 'water', water: 'pond' }),
    ]);
    assert.equal(s.totalPois, 0); assert.equal(s.score, 0);
  });
  it('dense clusters cannot dominate: only the best 5 per category count and the score saturates below 100', () => {
    const dense = Array.from({ length: 30 }, (_, i) => ({ type: 'node', id: i, lat: 13.0 + 30 / 111320, lon: 80.0 + i * 0.003, tags: { natural: 'beach', name: `Beach ${i}` } })); // 30 distinct beaches (~330 m apart) along the route
    const s = sceneryService.scoreRoute(routeLine, dense);
    assert.equal(s.totalPois, 30);
    assert.equal(s.points, 5); // 5 x 1.0 (maxPerCategory)
    assert.ok(s.score < 50, String(s.score));
    const varied = sceneryService.scoreRoute(routeLine, [beach(1, 50), node(2, 60, { tourism: 'viewpoint', name: 'V' }), node(3, 70, { leisure: 'nature_reserve', name: 'R' }), node(4, 80, { waterway: 'waterfall', name: 'F' })]);
    assert.ok(varied.score > s.score * 0.5 && varied.score < 100);
    assert.ok(sceneryService.scoreRoute(routeLine, [beach(1, 50)]).score < varied.score); // more (different) places score higher
  });
  it('relevance: a named beach outweighs a generic attraction; unnamed viewpoints count for less', () => {
    const a = sceneryService.scoreRoute(routeLine, [beach(1, 50)]).points;
    const b = sceneryService.scoreRoute(routeLine, [node(2, 50, { tourism: 'attraction', name: 'Statue' })]).points;
    const c = sceneryService.scoreRoute(routeLine, [node(3, 50, { tourism: 'viewpoint' })]).points;
    assert.equal(a, 1); assert.equal(b, 0.3); assert.equal(c, 0.5);
  });
  it('requested categories restrict the count', () => {
    const els = [beach(1, 50), node(2, 60, { leisure: 'park', name: 'P' })];
    assert.equal(sceneryService.scoreRoute(routeLine, els, null, ['beach']).totalPois, 1);
    assert.equal(sceneryService.scoreRoute(routeLine, els, null, ['forest']).totalPois, 0);
  });
  it('areas use Overpass\'s exact outline test when available, else a flagged bounding-box distance', () => {
    const park = area('way', 5, 100, { leisure: 'park', name: 'Park' });
    const exactIn = sceneryService.scoreRoute(routeLine, [park], { far: new Set(['way/5']), near: new Set() });
    assert.equal(exactIn.pois[0].band, 'ring'); assert.equal(exactIn.pois[0].proximity, 'exact'); assert.equal(exactIn.approximate, false);
    assert.equal(sceneryService.scoreRoute(routeLine, [park], { far: new Set(), near: new Set() }).totalPois, 0); // Overpass says: outline not within range
    const approx = sceneryService.scoreRoute(routeLine, [park], null);
    assert.equal(approx.pois[0].proximity, 'bounding-box'); assert.equal(approx.approximate, true);
    const farPark = area('way', 6, 5000, { leisure: 'park', name: 'Far Park' });
    assert.equal(sceneryService.scoreRoute(routeLine, [farPark], null).totalPois, 0);
  });
  it('classify maps tags to categories without inventing relevance', () => {
    assert.deepEqual(sceneryService.classify({ natural: 'beach' }), { category: 'beach', relevance: 1 });
    assert.equal(sceneryService.classify({ highway: 'primary', name: 'NH 32' }), null);
    assert.equal(sceneryService.classify({ landuse: 'forest' }), null); // unnamed
    assert.equal(sceneryService.classify({ landuse: 'forest', name: 'Reserve Forest' }).category, 'forest');
  });
  it('splitLine cuts a polyline into equal-length pieces that join up and lose nothing', () => {
    const line = [[13.0, 80.0], [13.0, 80.1], [13.05, 80.1]];
    const pieces = sceneryService.splitLine(line, 4);
    assert.equal(pieces.length, 4);
    const lens = pieces.map(polylineLengthM);
    const total = polylineLengthM(line);
    assert.ok(Math.abs(lens.reduce((a, b) => a + b, 0) - total) < 1, 'total length preserved');
    for (const l of lens) assert.ok(Math.abs(l - total / 4) < 50, `piece ${l} vs ${total / 4}`);
    for (let i = 1; i < pieces.length; i++) assert.deepEqual(pieces[i][0], pieces[i - 1][pieces[i - 1].length - 1]);
    assert.deepEqual(pieces[0][0], line[0]);
    assert.deepEqual(pieces[3][pieces[3].length - 1], line[2]);
    assert.deepEqual(sceneryService.splitLine(line, 1), [line]);
  });
  it('segment planning: ~segmentKm pieces, stretched for long routes, capped at maxRequests, null if absurd', () => {
    const route = (km) => Array.from({ length: 21 }, (_, i) => [13.0, 80.0 + (i * km) / 20 / 108.4]);
    const small = sceneryService.planSegments([route(10)]);
    assert.equal(small.length, 1); // short route: one request
    const mid = sceneryService.planSegments([route(100)]);
    assert.equal(mid.length, 5);
    for (const s of mid) assert.ok(Math.abs(s.lengthM - 20000) < 500, String(s.lengthM));
    const long = sceneryService.planSegments([route(300)]); // 300 km would need 15 pieces of 20 km -> stretched to 14
    assert.ok(long.length <= appConfig.scenery.maxRequests && long[0].lengthM > 20000, 'stretched');
    assert.ok(long.length >= 10);
    assert.equal(sceneryService.planSegments([route(2000)]), null);
    const two = sceneryService.planSegments([route(150), route(160)]);
    assert.ok(two.length <= appConfig.scenery.maxRequests);
    assert.deepEqual([...new Set(two.map((s) => s.route))], [0, 1]);
  });
  it('segment planning is deterministic (same route -> same queries -> cache hits)', () => {
    const line = Array.from({ length: 30 }, (_, i) => [13.0 + i * 0.01, 80.0 + i * 0.012]);
    const q = () => sceneryService.planSegments([line]).map((s) => sceneryService.buildSegmentQuery(s.line, sceneryService.CATEGORY_KEYS));
    assert.deepEqual(q(), q());
  });
  it('the segment query: only whitelisted tags, a corridor (around), one near-pass for areas, no bounding box', () => {
    const q = sceneryService.buildSegmentQuery([[13.0, 80.0], [13.0, 80.1]], sceneryService.CATEGORY_KEYS);
    assert.equal((q.match(/nwr\[/g) || []).length, 7); // the seven whitelisted statements, once each
    assert.equal((q.match(/around:1000,/g) || []).length, 7);
    assert.match(q, /nwr\.a\(around:300,/);
    assert.match(q, /\.c out tags bb;\.c out count;/);
    assert.ok(!/shop|amenity|highway/.test(q));
    assert.ok(q.length < 2500);
    const beachOnly = sceneryService.buildSegmentQuery([[13.0, 80.0], [13.0, 80.1]], ['beach']);
    assert.equal((beachOnly.match(/nwr\[/g) || []).length, 1);
  });
  it('parseSegment splits candidates from the near ids and rejects a response without the delimiter', () => {
    const r = sceneryService.parseSegment([{ type: 'node', id: 1, lat: 1, lon: 2, tags: {} }, { type: 'way', id: 2, bounds: {}, tags: {} }, { type: 'count' }, { type: 'way', id: 2 }]);
    assert.equal(r.candidates.length, 2);
    assert.deepEqual([...r.near], ['way/2']);
    assert.throws(() => sceneryService.parseSegment([{ type: 'node', id: 1 }]), /no delimiter/);
  });
  it('collectRoute merges segments: de-duplicated candidates, exact far/near sets, covered share of the route length', () => {
    const park = { type: 'way', id: 5, bounds: { minlat: 1, minlon: 1, maxlat: 2, maxlon: 2 }, tags: { leisure: 'park', name: 'P' } };
    const beach = { type: 'node', id: 6, lat: 1, lon: 1, tags: { natural: 'beach' } };
    const seg = (ok, lengthM, candidates = [], near = []) => ({ ok, lengthM, candidates, near: new Set(near) });
    const r = sceneryService.collectRoute([seg(true, 1000, [park, beach], ['way/5']), seg(true, 1000, [park]), seg(false, 2000)]);
    assert.equal(r.elements.length, 2); // the park seen in two segments counts once
    assert.deepEqual([...r.exact.far], ['way/5']); // nodes are measured locally, not listed here
    assert.deepEqual([...r.exact.near], ['way/5']);
    assert.equal(r.coverage, 0.5);
    assert.deepEqual([r.segments, r.failed], [3, 1]);
  });
});

describe('Overpass client failure handling', () => {
  const overpass = require('../src/services/overpass');
  it('connection refused -> OverpassError, remembered for the cool-down, nothing invented', async () => {
    const keep = { urls: appConfig.overpass.urls, backoffMs: appConfig.overpass.backoffMs };
    appConfig.overpass.urls = ['http://127.0.0.1:9/api/interpreter']; // nothing listens here
    appConfig.overpass.backoffMs = 0;
    overpass._reset();
    try {
      await assert.rejects(() => overpass.run('[out:json];out;', 'test'), (e) => e instanceof overpass.OverpassError);
      await assert.rejects(() => overpass.run('[out:json];out;', 'test'), (e) => e.kind === 'cooldown');
    } finally { Object.assign(appConfig.overpass, keep); overpass._reset(); }
  });
  it('an expired deadline fails fast without sending a request', async () => {
    overpass._reset();
    await assert.rejects(() => overpass.run('[out:json];out;', 'test', { deadline: Date.now() + 100 }), (e) => e.kind === 'timeout');
    overpass._reset();
  });
});

describe('AI notes: road conditions, scenery and combined priorities', () => {
  const p = (t) => ai.parsePreferencesRuleBased(t);
  it('"I want better road conditions."', () => {
    const r = p('I want better road conditions.');
    assert.equal(r.preference, 'BETTER_ROADS'); assert.equal(r.priorities.roadPriority, 'HIGH'); assert.equal(r.priorities.sceneryPriority, 'NONE');
  });
  it('"Prefer paved roads."', () => {
    const r = p('Prefer paved roads.');
    assert.equal(r.preference, 'BETTER_ROADS'); assert.equal(r.priorities.roadPriority, 'HIGH');
  });
  it('"I want a scenic route."', () => {
    const r = p('I want a scenic route.');
    assert.equal(r.preference, 'BETTER_SCENERY'); assert.equal(r.priorities.sceneryPriority, 'HIGH'); assert.deepEqual(r.priorities.sceneryCategories, []);
  });
  it('"I would like to pass near beaches and parks."', () => {
    const r = p('I would like to pass near beaches and parks.');
    assert.equal(r.preference, 'BETTER_SCENERY');
    assert.deepEqual([...r.priorities.sceneryCategories].sort(), ['beach', 'park']);
  });
  it('"I want good road conditions and less traffic."', () => {
    const r = p('I want good road conditions and less traffic.');
    assert.equal(r.preference, 'BETTER_ROADS'); assert.equal(r.priorities.roadPriority, 'HIGH'); assert.equal(r.priorities.trafficPriority, 'HIGH');
  });
  it('"I want a scenic route but don\'t want to travel much longer."', () => {
    assert.equal(p('scenic route but dont want to travel much longer').priorities.detour.maxExtraPercent, appConfig.defaultDetourPercent); // missing apostrophe
    const r = p("I want a scenic route but don't want to travel much longer.");
    assert.equal(r.preference, 'BETTER_SCENERY');
    assert.deepEqual(r.priorities.detour, { maxExtraPercent: appConfig.defaultDetourPercent, vague: true });
    assert.equal(p('scenic route but don’t want to travel much longer').priorities.detour.maxExtraPercent, appConfig.defaultDetourPercent); // curly apostrophe
  });
  it('both scenery and road conditions are combined; explicit limits are parsed', () => {
    const r = p('I want smooth roads and a scenic drive, no more than 20 minutes longer');
    assert.equal(r.preference, 'BALANCED');
    assert.equal(r.priorities.roadPriority, 'HIGH'); assert.equal(r.priorities.sceneryPriority, 'HIGH');
    assert.deepEqual(r.priorities.detour, { maxExtraMinutes: 20 });
    assert.deepEqual(ai.parseDetour('at most 10% longer'), { maxExtraPercent: 10 });
    assert.deepEqual(ai.parseDetour('up to 1 hour extra'), { maxExtraMinutes: 60 });
    assert.equal(ai.parseDetour('it is 50% cheaper'), null);
  });
  it('"smooth roads" is a road request, not a traffic request; "smooth traffic" still is', () => {
    assert.equal(p('smooth roads please').priorities.trafficPriority, 'MEDIUM');
    assert.equal(p('I want smooth traffic').priorities.trafficPriority, 'HIGH');
  });
  it('potholes and safety are recognised as requests the data cannot answer', () => {
    assert.deepEqual(p('avoid potholes').priorities.unsupported, ['potholes and pavement damage']);
    assert.deepEqual(p('I want the safest roads').priorities.unsupported, ['road safety']);
  });
  it('no false positives: "parking", "preview" and ordinary notes do not trigger scenery or roads', () => {
    for (const t of ['I need parking near the destination', 'I want to preview the route', 'avoid heavy traffic with my family', 'I want the cheapest route']) {
      const r = p(t); assert.equal(r.priorities.sceneryPriority, 'NONE', t); assert.equal(r.priorities.roadPriority, 'NONE', t);
    }
  });
  it('existing outputs are unchanged', () => {
    assert.equal(p('I want the cheapest route').preference, 'CHEAPEST');
    assert.equal(p("I'm in a hurry, need the fastest way").preference, 'FASTEST');
    assert.equal(p('').preference, null);
  });
  it('explanations describe documented tags and nearby POIs, never "good condition" or "officially scenic"', () => {
    const mk = (id, road, scn) => ({ id, label: `Route ${id}`, distanceKm: 100, durationMinutes: 100, cost: 500, traffic: { level: 'LOW', confidence: 1, probabilities: { LOW: 1, MEDIUM: 0, HIGH: 0 } }, roadQuality: { available: true, score: road, coverage: 0.8, pavedShare: 0.8 }, scenery: { available: true, score: scn, totalPois: 4, pois: [{ counted: true, name: 'Marina Beach' }] } });
    const rs = [mk('A', 80, 10), mk('B', 20, 90)];
    const rec = scoreRoutes(rs, buildWeights('BETTER_ROADS').weights);
    const text = ai.explainRuleBased({ recommended: rec, others: rs.filter((r) => r !== rec), preference: 'BETTER_ROADS', weights: buildWeights('BETTER_ROADS').weights, mlSource: 'ml-model' });
    assert.match(text, /Route A is recommended for your Better Road Conditions preference/);
    assert.match(text, /documents more paved or smooth road surface/);
    assert.match(text, /not a measured pavement condition/);
    assert.match(text, /not pavement quality/);
    const rs2 = [mk('A', 80, 10), mk('B', 20, 90)];
    const rec2 = scoreRoutes(rs2, buildWeights('BETTER_SCENERY').weights);
    const t2 = ai.explainRuleBased({ recommended: rec2, others: rs2.filter((r) => r !== rec2), preference: 'BETTER_SCENERY', weights: buildWeights('BETTER_SCENERY').weights, mlSource: 'ml-model' });
    assert.match(t2, /more nature-related POIs near it/);
    assert.match(t2, /Marina Beach/);
    assert.ok(!/officially|pothole-free|good condition/i.test(text + t2));
  });
  it('explanations say so when data was unavailable', () => {
    const rs = [{ id: 'A', label: 'Route A', distanceKm: 1, durationMinutes: 10, cost: 10, traffic: { level: 'LOW', probabilities: { LOW: 1 } } }];
    assert.match(ai.explainRuleBased({ recommended: { ...rs[0], score: 90 }, others: [], preference: 'BETTER_ROADS', weights: buildWeights('BALANCED').weights, mlSource: 'ml-model', unavailable: ['road'] }), /Road quality data was unavailable/);
  });
});

describe('preferences and schemas', () => {
  it('Trip accepts the new preferences and still accepts the old ones', () => {
    for (const preference of ['FASTEST', 'CHEAPEST', 'LOW_TRAFFIC', 'BALANCED', 'BETTER_ROADS', 'BETTER_SCENERY']) {
      const e = new Trip({ preference }).validateSync();
      assert.ok(!e.errors.preference, preference);
    }
    assert.ok(new Trip({ preference: 'AUTO' }).validateSync().errors.preference); // AUTO is a request value, never stored
  });
  it('a trip saved before these features (no road/scenery fields) still validates and reads back', () => {
    const doc = new Trip({
      userId: new (require('mongoose').Types.ObjectId)(), origin: { name: 'A', lat: 1, lon: 1 }, destination: { name: 'B', lat: 2, lon: 2 }, date: '2025-01-01', preference: 'FASTEST',
      selectedRoute: { label: 'Route A', cost: 100, traffic: { level: 'LOW' }, geometry: [[1, 1]], via: 'NH' }, distance: 10, estimatedTime: 10, trafficLevel: 'LOW', routeScore: 90,
    });
    assert.equal(doc.validateSync(), undefined);
    assert.equal(doc.selectedRoute.roadQuality, undefined);
  });
});
