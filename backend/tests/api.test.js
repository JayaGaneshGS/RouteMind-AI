// API integration tests. External services are mocked locally; MongoDB is either a real server
// (set MONGO_TEST_URI, as CI does) or the in-memory stand-in with real Mongoose validation.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.EXTERNAL_MIN_INTERVAL_MS = '0';
process.env.OVERPASS_MIN_INTERVAL_MS = '0';
process.env.OVERPASS_BACKOFF_MS = '0';
process.env.OVERPASS_BUDGET_MS = '15000';
process.env.GEOCODE_USER_AGENT = 'RouteMindAI-Test/1.0';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mock = require('./helpers/mockServices');
const fakeDb = require('./helpers/fakeDb');

let app; let svc; let config; let db; let realMongo = false; let mongoose;

before(async () => {
  svc = await mock.start();
  process.env.GEOCODE_URL = `${svc.base}/search`;
  process.env.OSRM_URL = svc.base;
  process.env.OVERPASS_URL = `${svc.base}/api/interpreter`;
  process.env.ML_SERVICE_URL = process.env.ML_SERVICE_URL_TEST || svc.base;
  config = require('../src/config');
  db = require('../src/services/db');
  mongoose = require('mongoose');
  if (process.env.MONGO_TEST_URI) {
    // Safety: these tests DROP the database they connect to - never let that be Atlas or any remote DB.
    if (!/^mongodb:\/\/(localhost|127\.0\.0\.1|mongo)(:|\/)/.test(process.env.MONGO_TEST_URI)) {
      throw new Error('MONGO_TEST_URI must point to a LOCAL throw-away MongoDB (localhost / 127.0.0.1), never Atlas.');
    }
    await mongoose.connect(process.env.MONGO_TEST_URI);
    const { User, Trip } = require('../src/models');
    await Promise.all([User.init(), Trip.init()]); // make sure the unique-email index exists
    realMongo = true;
  } else {
    fakeDb.install();
    db.setReadyOverride(true);
  }
  app = require('../src/app').createApp();
});

after(async () => {
  await svc.stop();
  if (realMongo) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); }
});

beforeEach(async () => {
  Object.assign(svc.mode, { osrm: 'two', ml: 'up', llm: 'good', nominatim: 'up', overpass: 'up', roads: 'A_good', segmentFail: null });
  require('../src/services/geocode')._cache.clear();
  require('../src/services/routing')._cache.clear();
  require('../src/services/overpass')._reset();
  require('../src/diagnostics').reset();
  config.mlFallback = true;
  Object.assign(svc.calls, { nominatim: 0, osrm: 0, ml: 0, overpass: 0, overpassKinds: [], overpassQueries: [], lastNominatim: null, lastOsrm: null, lastOverpass: null });
  config.ai.apiKey = '';
  if (realMongo) { const { User, Trip } = require('../src/models'); await Promise.all([User.deleteMany({}), Trip.deleteMany({})]); } else fakeDb.reset();
});

const reg = (n = 'Asha Rao', e = 'asha@example.com', p = 'password123') => request(app).post('/api/auth/register').send({ name: n, email: e, password: p });
const search = (body, token) => { const r = request(app).post('/api/routes/search').send(body); return token ? r.set('Authorization', `Bearer ${token}`) : r; };
const demo = { origin: 'Chennai', destination: 'Pondicherry', date: '2026-10-09', time: '18:00', preference: 'LOW_TRAFFIC' };

describe('health', () => {
  it('reports real backend, mongodb and ml state', async () => {
    const r = await request(app).get('/api/health');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { backend: 'ok', mongodb: 'connected', mlService: 'connected', routing: 'configured', geocoding: 'configured' });
  });
  it('health reflects an ML outage and a DB outage (not hard-coded)', async () => {
    svc.mode.ml = 'down'; db.setReadyOverride(false);
    try {
      const r = await request(app).get('/api/health');
      assert.equal(r.body.mlService, 'unavailable');
      assert.equal(r.body.mongodb, 'disconnected');
    } finally { db.setReadyOverride(realMongo ? null : true); }
  });
  it('health does not call Nominatim or OSRM', async () => {
    await request(app).get('/api/health');
    assert.equal(svc.calls.nominatim, 0); assert.equal(svc.calls.osrm, 0);
  });
  it('unknown endpoint -> JSON 404', async () => {
    const r = await request(app).get('/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'NOT_FOUND');
  });
});

describe('authentication', () => {
  it('registers, hashes the password and returns a token', async () => {
    const r = await reg();
    assert.equal(r.status, 201);
    assert.ok(r.body.token);
    assert.equal(r.body.user.passwordHash, undefined);
    assert.equal(JSON.stringify(r.body).includes('password123'), false);
    const User = require('../src/models').User;
    const stored = await User.findOne({ email: 'asha@example.com' });
    assert.notEqual(stored.passwordHash, 'password123');
    assert.match(stored.passwordHash, /^\$2[aby]\$/); // bcrypt
  });
  it('rejects bad input and duplicates', async () => {
    assert.equal((await reg('A', 'x@y.com')).status, 400);
    assert.equal((await reg('Asha', 'not-an-email')).status, 400);
    assert.equal((await reg('Asha', 'a@b.com', 'short')).status, 400);
    assert.equal((await reg()).status, 201);
    assert.equal((await reg()).status, 409);
  });
  it('logs in, rejects wrong password, and /me needs a token', async () => {
    await reg();
    const ok = await request(app).post('/api/auth/login').send({ email: 'ASHA@example.com', password: 'password123' });
    assert.equal(ok.status, 200);
    const bad = await request(app).post('/api/auth/login').send({ email: 'asha@example.com', password: 'wrongpass1' });
    assert.equal(bad.status, 401);
    assert.equal((await request(app).get('/api/auth/me')).status, 401);
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${ok.body.token}`);
    assert.equal(me.body.user.email, 'asha@example.com');
    assert.equal((await request(app).get('/api/auth/me').set('Authorization', 'Bearer garbage')).status, 401);
  });
  it('updates preferences', async () => {
    const { body } = await reg();
    const r = await request(app).put('/api/auth/preferences').set('Authorization', `Bearer ${body.token}`).send({ preferredMode: 'LOW_TRAFFIC', notes: 'I travel with family' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.preferences.preferredMode, 'LOW_TRAFFIC');
    const bad = await request(app).put('/api/auth/preferences').set('Authorization', `Bearer ${body.token}`).send({ preferredMode: 'WARP' });
    assert.equal(bad.status, 400);
  });
});

describe('route search', () => {
  it('Chennai -> Pondicherry returns alternatives, scores and a recommendation', async () => {
    const r = await search(demo);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.routes.length, 2);
    assert.ok(r.body.origin.name.includes('Chennai'));
    for (const rt of r.body.routes) {
      assert.ok(rt.score >= 0 && rt.score <= 100);
      assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(rt.traffic.level));
      assert.ok(rt.geometry.length > 5);
      assert.ok(rt.cost > 0);
    }
    assert.equal(r.body.mlSource, 'ml-model');
    // mock ML says the 165 km route (B) is HIGH traffic -> low-traffic preference must pick A
    assert.equal(r.body.recommendedRoute.id, 'A');
    assert.match(r.body.reason, /Route A is recommended/);
    assert.equal(r.body.reasonSource, 'rule-based');
    assert.ok(r.body.disclaimer);
  });
  it('travel time = base x traffic multiplier', async () => {
    const r = await search(demo);
    const a = r.body.routes[0];
    assert.equal(a.durationMinutes, Math.round(a.baseMinutes * 1.05 * 10) / 10);
  });
  it('single OSRM route: shown as-is, NO fake alternatives', async () => {
    svc.mode.osrm = 'one';
    const r = await search(demo);
    assert.equal(r.status, 200);
    assert.equal(r.body.routes.length, 1);
    assert.equal(r.body.recommendedRoute.id, 'A');
    assert.ok(r.body.warnings.some((w) => /only one route/.test(w)));
    assert.equal(svc.calls.osrm, 1); // no extra via-point requests
  });
  it('OSRM down -> 503 "Routing service unavailable", and NO route data is invented', async () => {
    svc.mode.osrm = 'fail';
    const r = await search(demo);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'ROUTING_UNAVAILABLE');
    assert.equal(r.body.error.message, 'Routing service unavailable. Please try again.');
    assert.equal(r.body.routes, undefined);
    assert.equal(r.body.recommendedRoute, undefined);
  });
  it('OSRM NoRoute -> 422', async () => {
    svc.mode.osrm = 'noroute';
    const r = await search(demo);
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'NO_ROUTE');
  });
  it('sends correct requests to Nominatim and OSRM', async () => {
    const r = await search(demo);
    assert.equal(r.status, 200);
    const n = svc.calls.lastNominatim;
    assert.equal(n.query.format, 'json'); assert.equal(n.query.limit, '1');
    assert.equal(n.userAgent, 'RouteMindAI-Test/1.0');
    const o = svc.calls.lastOsrm;
    // OSRM wants longitude,latitude
    assert.ok(o.path.includes('/route/v1/driving/80.270186,13.083694;79.830600,11.934000'), o.path);
    assert.deepEqual({ ...o.query }, { alternatives: 'true', geometries: 'geojson', overview: 'full', steps: 'true' });
  });
  it('route data comes from OSRM: distance, duration, [lat,lon] geometry, via roads', async () => {
    const r = await search(demo);
    const a = r.body.routes[0];
    assert.equal(a.distanceKm, 150);
    assert.equal(a.baseMinutes, 175); // 10500 s from the OSRM response
    assert.ok(Math.abs(a.geometry[0][0] - 13.08) < 0.2 && Math.abs(a.geometry[0][1] - 80.27) < 0.2); // [lat, lon]
    assert.match(a.via, /East Coast Road/);
    assert.ok(r.body.routes.some((x) => x.id === r.body.recommendedRoute.id)); // recommended is one of the OSRM routes
    assert.equal(r.body.diagnostics.routing.provider, 'OSRM');
    assert.equal(r.body.diagnostics.routing.routesReceived, 2);
  });
  it('diagnostics endpoint counts real calls and exposes no secrets', async () => {
    await search(demo);
    const d = await request(app).get('/api/diagnostics');
    assert.equal(d.status, 200);
    assert.ok(d.body.services.nominatim.calls >= 2);
    assert.equal(d.body.services.osrm.calls, 1);
    assert.equal(d.body.services.ml.calls, 1);
    const text = JSON.stringify(d.body);
    assert.equal(text.includes('test-secret'), false);
    assert.equal(/mongodb(\+srv)?:\/\//.test(text), false);
  });
  it('Nominatim down -> 503 "Location service unavailable", no substitute coordinates', async () => {
    svc.mode.nominatim = 'down';
    const r = await search(demo);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'GEOCODE_UNAVAILABLE');
    assert.match(r.body.error.message, /Location service unavailable/);
    assert.equal(svc.calls.osrm, 0); // routing is never attempted with invented coordinates
  });
  it('ML service down -> labelled fallback, explicit warning', async () => {
    svc.mode.ml = 'down';
    const r = await search(demo);
    assert.equal(r.status, 200);
    assert.equal(r.body.mlSource, 'heuristic-fallback');
    assert.ok(r.body.routes.every((x) => x.traffic.source === 'heuristic-fallback'));
    assert.ok(r.body.warnings.includes('ML service unavailable — fallback prediction used.'));
    assert.match(r.body.reason, /ML service was unavailable/);
    assert.equal(r.body.routes.length, 2); // routes themselves are still the real OSRM routes
  });
  it('ML_FALLBACK=off -> 503 instead of any fallback', async () => {
    svc.mode.ml = 'down'; config.mlFallback = false;
    const r = await search(demo);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'ML_UNAVAILABLE');
  });
  it('invalid location -> 422 friendly message', async () => {
    const r = await search({ ...demo, destination: 'Zzzzzzville' });
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, 'LOCATION_NOT_FOUND');
  });
  it('validates input', async () => {
    assert.equal((await search({ ...demo, date: '09/10/2026' })).status, 400);
    assert.equal((await search({ ...demo, time: '25:99' })).status, 400);
    assert.equal((await search({ ...demo, preference: 'TELEPORT' })).status, 400);
    assert.equal((await search({ ...demo, origin: '' })).status, 400);
    assert.equal((await search({ ...demo, destination: 'Chennai' })).status, 400); // same place
    assert.equal((await search({ ...demo, notes: 'x'.repeat(301) })).status, 400);
  });
  it('accepts pre-resolved coordinates without geocoding', async () => {
    const before = svc.calls.nominatim;
    const r = await search({ ...demo, origin: { name: 'A', lat: 13.08, lon: 80.27 }, destination: { name: 'B', lat: 11.93, lon: 79.83 } });
    assert.equal(r.status, 200);
    assert.equal(svc.calls.nominatim, before);
  });
  it('caches geocoding and routing (public API politeness)', async () => {
    await search(demo);
    const n = svc.calls.nominatim; const o = svc.calls.osrm;
    await search(demo);
    assert.equal(svc.calls.nominatim, n);
    assert.equal(svc.calls.osrm, o);
  });
  it('natural-language notes (rule-based) change the weights', async () => {
    const r = await search({ ...demo, preference: 'BALANCED', notes: 'I am travelling with my family and want to avoid heavy traffic' });
    assert.equal(r.body.aiInterpretation.priorities.trafficPriority, 'HIGH');
    assert.equal(r.body.aiInterpretation.priorities.comfortPriority, 'HIGH');
    assert.ok(r.body.weights.traffic > r.body.weights.cost);
  });
  it('AUTO preference is derived from notes', async () => {
    const r = await search({ ...demo, preference: 'AUTO', notes: 'I want the cheapest route' });
    assert.equal(r.body.preference, 'CHEAPEST');
  });
  it('uses the LLM when a key is configured, and falls back on bad output', async () => {
    config.ai.apiKey = 'test-key'; config.ai.apiUrl = `${svc.base}/v1/chat/completions`;
    let r = await search({ ...demo, preference: 'AUTO', notes: 'whatever' });
    assert.equal(r.body.aiInterpretation.source, 'llm');
    assert.equal(r.body.preference, 'CHEAPEST');
    assert.equal(r.body.reasonSource, 'llm');
    svc.mode.llm = 'garbage';
    r = await search({ ...demo, preference: 'AUTO', notes: 'I need the cheapest route' });
    assert.equal(r.body.aiInterpretation.source, 'rule-based');
    assert.equal(r.body.preference, 'CHEAPEST');
    svc.mode.llm = 'error';
    r = await search(demo);
    assert.equal(r.status, 200);
    assert.equal(r.body.reasonSource, 'rule-based');
  });
  it('personalises weights from trip history for logged-in users', async () => {
    const { body } = await reg();
    const first = await search(demo, body.token);
    assert.equal(first.body.personalization.applied, false);
    for (let i = 0; i < 2; i++) {
      await request(app).post('/api/trips').set('Authorization', `Bearer ${body.token}`).send(tripBody(first.body));
    }
    const again = await search({ ...demo, preference: 'BALANCED' }, body.token);
    assert.equal(again.body.personalization.applied, true);
    assert.equal(again.body.personalization.basedOnTrips, 2);
    assert.ok(again.body.weights.traffic > again.body.weights.time); // nudged toward past LOW_TRAFFIC choices
  });
  it('still works for logged-in users when the DB is down', async () => {
    const { body } = await reg();
    db.setReadyOverride(false);
    try {
      const r = await search(demo, body.token);
      assert.equal(r.status, 200);
    } finally { db.setReadyOverride(realMongo ? null : true); }
  });
});

const tripBody = (s) => ({
  origin: s.origin, destination: s.destination, date: s.departure.date, time: s.departure.time,
  preference: s.preference, selectedRoute: s.recommendedRoute, explanation: s.reason,
});

describe('trips', () => {
  it('requires auth', async () => {
    assert.equal((await request(app).get('/api/trips')).status, 401);
    assert.equal((await request(app).post('/api/trips').send({})).status, 401);
  });
  it('create / list / get / delete, scoped to the owner', async () => {
    const u1 = (await reg()).body.token;
    const u2 = (await reg('Bob Rao', 'bob@example.com')).body.token;
    const s = (await search(demo)).body;
    const created = await request(app).post('/api/trips').set('Authorization', `Bearer ${u1}`).send(tripBody(s));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = String(created.body.trip._id);
    assert.equal(created.body.trip.trafficLevel, s.recommendedRoute.traffic.level);
    assert.equal(created.body.trip.routeScore, s.recommendedRoute.score);

    const list = await request(app).get('/api/trips').set('Authorization', `Bearer ${u1}`);
    assert.equal(list.body.trips.length, 1);
    assert.equal((await request(app).get('/api/trips').set('Authorization', `Bearer ${u2}`)).body.trips.length, 0);

    assert.equal((await request(app).get(`/api/trips/${id}`).set('Authorization', `Bearer ${u1}`)).status, 200);
    assert.equal((await request(app).get(`/api/trips/${id}`).set('Authorization', `Bearer ${u2}`)).status, 404); // not theirs
    assert.equal((await request(app).delete(`/api/trips/${id}`).set('Authorization', `Bearer ${u2}`)).status, 404);
    assert.equal((await request(app).delete(`/api/trips/${id}`).set('Authorization', `Bearer ${u1}`)).status, 200);
    assert.equal((await request(app).get('/api/trips').set('Authorization', `Bearer ${u1}`)).body.trips.length, 0);
  });
  it('validates payload and ids', async () => {
    const t = (await reg()).body.token;
    assert.equal((await request(app).post('/api/trips').set('Authorization', `Bearer ${t}`).send({ preference: 'FASTEST' })).status, 400);
    assert.equal((await request(app).get('/api/trips/not-an-id').set('Authorization', `Bearer ${t}`)).status, 400);
  });
  it('MongoDB unavailable -> 503 with friendly message', async () => {
    db.setReadyOverride(false);
    try {
      const r = await request(app).get('/api/trips').set('Authorization', 'Bearer x');
      assert.ok([401, 503].includes(r.status));
      const login = await request(app).post('/api/auth/login').send({ email: 'a@b.com', password: 'password123' });
      assert.equal(login.status, 503);
      assert.equal(login.body.error.code, 'DB_UNAVAILABLE');
    } finally { db.setReadyOverride(realMongo ? null : true); }
  });
});

describe('ml proxy', () => {
  it('POST /api/ml/predict forwards to the ML service', async () => {
    const r = await request(app).post('/api/ml/predict').send({ hour: 18, day_of_week: 4, weekend: false, distance: 150, rain: true });
    assert.equal(r.status, 200);
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(r.body.traffic_level));
  });
  it('ML down -> 503 friendly error', async () => {
    svc.mode.ml = 'down';
    const r = await request(app).post('/api/ml/predict').send({ hour: 1 });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'ML_UNAVAILABLE');
  });
});

describe('locations', () => {
  it('searches places', async () => {
    const r = await request(app).get('/api/locations/search').query({ q: 'Chennai' });
    assert.equal(r.status, 200);
    assert.equal(r.body.results[0].shortName, 'Chennai');
  });
  it('rejects tiny queries', async () => {
    assert.equal((await request(app).get('/api/locations/search').query({ q: 'a' })).status, 400);
  });
});

describe('error handling', () => {
  it('malformed JSON -> 400, no stack trace leaked', async () => {
    const r = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{bad');
    assert.equal(r.status, 400);
    assert.equal(JSON.stringify(r.body).includes('at '), false);
  });
});

/* ======================= Better Road Conditions / Better Scenery ======================= */

describe('existing preferences are untouched', () => {
  for (const preference of ['FASTEST', 'CHEAPEST', 'LOW_TRAFFIC', 'BALANCED']) {
    it(`${preference}: no road/scenery data requested, no Overpass call, weights unchanged`, async () => {
      const r = await search({ ...demo, preference });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(svc.calls.overpass, 0);
      assert.equal(r.body.weights.road, 0); assert.equal(r.body.weights.scenery, 0);
      assert.equal(r.body.roadQuality.requested, false); assert.equal(r.body.scenery.requested, false);
      assert.ok(r.body.routes.every((x) => x.roadQuality === undefined && x.scenery === undefined));
      assert.ok(Math.abs(r.body.weights.time + r.body.weights.traffic + r.body.weights.cost - 1) < 0.01);
    });
  }
  it('unknown preference is still rejected and the message lists the new options', async () => {
    const r = await search({ ...demo, preference: 'TELEPORT' });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /BETTER_ROADS/); assert.match(r.body.error.message, /BETTER_SCENERY/);
  });
  it('analysis-only fields never reach the browser', async () => {
    const r = await search({ ...demo, preference: 'BETTER_ROADS' });
    assert.ok(r.body.routes.every((x) => x.analysis === undefined));
  });
});

describe('Better Road Conditions', () => {
  const roads = { ...demo, preference: 'BETTER_ROADS' };

  it('uses documented OSM tags: the route whose roads are documented as paved wins, with its evidence', async () => {
    svc.mode.roads = 'B_good'; // NH32 (Route B, HIGH predicted traffic) is tagged surface=asphalt; East Coast Road (Route A) is untagged
    const r = await search(roads);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [a, b] = r.body.routes;
    assert.equal(a.roadQuality.available, true);
    assert.equal(b.roadQuality.coverage, 1);
    assert.equal(a.roadQuality.coverage, 0); // untagged != good
    assert.ok(b.roadQuality.score > a.roadQuality.score);
    assert.equal(b.roadQuality.pavedShare, 1);
    assert.equal(b.roadQuality.evidence[0].wayId, 222);
    assert.equal(b.roadQuality.evidence[0].surface, 'asphalt');
    assert.equal(r.body.recommendedRoute.id, 'B'); // despite the worse traffic prediction, because road data was asked for
    assert.ok(r.body.weights.road > 0.4);
    assert.match(b.roadQuality.source, /OpenStreetMap/);
    assert.match(b.roadQuality.summary, /Road classification \(not a quality measure\)/);
  });
  it('safety limit: with no limit from the user, a route far slower than the fastest is never recommended on road grounds', async () => {
    svc.mode.roads = 'B_good';
    const r = await search(roads);
    assert.deepEqual(r.body.constraints, { maxExtraPercent: config.maxDetourPercent, implicit: true });
    assert.equal(r.body.recommendedRoute.id, 'B'); // Route B is ~33% slower: inside the default 50% limit
    const keep = config.maxDetourPercent;
    config.maxDetourPercent = 10;
    try {
      const strict = await search(roads);
      assert.equal(strict.body.routes[1].withinTimeLimit, false);
      assert.equal(strict.body.recommendedRoute.id, 'A');
      assert.match(strict.body.reason, /never recommended for road or scenery preferences/);
    } finally { config.maxDetourPercent = keep; }
  });
  it('the crossing street (different name) is never used for the route', async () => {
    const r = await search(roads);
    const ev = r.body.routes[0].roadQuality.evidence;
    assert.ok(ev.every((e) => e.wayId !== 333));
    assert.equal(r.body.routes[0].roadQuality.unpavedShare, 0); // the dirt "Side Road" is not on the route
  });
  it('smoothness is preferred over surface and gives a higher score than surface alone', async () => {
    svc.mode.roads = 'A_good'; // ECR: asphalt + smoothness=good
    const r = await search(roads);
    assert.equal(r.body.recommendedRoute.id, 'A');
    assert.equal(r.body.routes[0].roadQuality.smoothnessKnownShare, 1);
    assert.equal(r.body.routes[0].roadQuality.score, 85);
  });
  it('documented unpaved surface is reported as unpaved, not hidden', async () => {
    svc.mode.roads = 'unpaved_A';
    const r = await search(roads);
    assert.equal(r.body.routes[0].roadQuality.unpavedShare, 1);
    assert.equal(r.body.routes[0].roadQuality.pavedShare, 0);
  });
  it('no surface tags at all -> "Road quality data unavailable", axis dropped, recommendation uses only what is known', async () => {
    svc.mode.roads = 'none';
    const r = await search(roads);
    assert.equal(r.status, 200);
    assert.equal(r.body.roadQuality.available, false);
    assert.ok(r.body.routes.every((x) => x.roadQuality.available === false && x.roadQuality.score === null));
    assert.match(r.body.routes[0].roadQuality.summary, /Road quality data unavailable/);
    assert.ok(r.body.warnings.some((w) => /Road quality data unavailable/.test(w) && /only on the attributes that are available/.test(w)));
    assert.deepEqual(r.body.weightsDroppedForMissingData, ['road']);
    assert.equal(r.body.weights.road, 0);
    assert.match(r.body.reason, /Road quality data was unavailable/);
    assert.equal(r.body.recommendedRoute.id, 'A'); // decided by time/traffic/cost
  });
  it('Overpass down / busy / garbage / runtime-error -> unavailable (never invented), search still succeeds', async () => {
    for (const m of ['down', 'busy', 'garbage', 'remark']) {
      require('../src/services/overpass')._reset();
      svc.mode.overpass = m;
      const r = await search(roads);
      assert.equal(r.status, 200, m);
      assert.equal(r.body.roadQuality.available, false, m);
      assert.ok(r.body.routes.every((x) => x.roadQuality.score === null && x.roadQuality.evidence.length === 0), m);
      assert.ok(r.body.warnings.some((w) => /Road quality data unavailable/.test(w)), m);
    }
  });
  it('a failure is remembered briefly: no hammering of the Overpass server', async () => {
    svc.mode.overpass = 'busy';
    await search(roads);
    const n = svc.calls.overpass;
    await search({ ...roads, time: '19:00' }); // same routes -> same query
    assert.equal(svc.calls.overpass, n);
  });
  it('a 504 followed by success is retried once', async () => {
    svc.mode.overpass = 'flaky';
    const r = await search(roads);
    assert.equal(r.body.roadQuality.available, true);
    const requests = Math.ceil(r.body.diagnostics.overpass.roadTags.samples / config.roadQuality.samplesPerRequest);
    assert.equal(svc.calls.overpass, requests + 1); // every chunk once, plus one retry of the chunk that got the 504
  });
  it('results are cached: the second identical search sends no Overpass request', async () => {
    await search(roads);
    const n = svc.calls.overpass;
    const again = await search(roads);
    assert.equal(again.body.roadQuality.available, true);
    assert.equal(svc.calls.overpass, n);
  });
  it('the Overpass requests are bounded: at most maxSamples statements per route, split into small requests', async () => {
    const r = await search(roads);
    const total = r.body.diagnostics.overpass.roadTags.samples;
    assert.ok(total <= 2 * config.roadQuality.maxSamples);
    assert.equal(svc.calls.overpass, Math.ceil(total / config.roadQuality.samplesPerRequest));
    assert.ok(svc.calls.overpass > 1, 'a long two-route search is split instead of sent as one big request');
    assert.ok(svc.calls.overpassKinds.every((k) => k === 'roads'));
    for (const q of svc.calls.overpassQueries) assert.ok((q.match(/out count;/g) || []).length <= config.roadQuality.samplesPerRequest);
    assert.equal(svc.calls.overpassQueries.reduce((n, q) => n + (q.match(/out count;/g) || []).length, 0), total); // every sample asked exactly once
  });
  it('one road request fails: the other samples still count, the lost ones are UNKNOWN (not bad), and the result says it is incomplete', async () => {
    config.overpass.endpointFailureThreshold = 2; config.overpass.retries = 0;
    svc.mode.overpass = 'second504'; // only the 2nd request of the search gets HTTP 504
    const r = await search(roads);
    config.overpass.endpointFailureThreshold = 2; // default config.overpass.retries = 1;
    assert.equal(r.status, 200);
    const rq = r.body.routes[0].roadQuality;
    assert.equal(r.body.roadQuality.available, true);
    assert.equal(rq.incomplete, true);
    assert.ok(rq.unretrievedShare > 0 && rq.unretrievedShare < 1);
    assert.match(rq.summary, /Data incomplete/);
    assert.ok(r.body.warnings.some((w) => /Road quality data is incomplete/.test(w)));
    assert.match(r.body.diagnostics.overpass.roadTags.note, /incomplete: 1 of/);
  });
  it('road-quality analysis switched off -> unavailable, no Overpass call', async () => {
    config.roadQuality.enabled = false;
    try {
      const r = await search(roads);
      assert.equal(r.body.roadQuality.available, false);
      assert.equal(svc.calls.overpass, 0);
    } finally { config.roadQuality.enabled = true; }
  });
});

describe('Better Scenery', () => {
  const scenery = { ...demo, preference: 'BETTER_SCENERY' };

  it('scores real POIs against each route: near beach + park for Route A, lake for Route B', async () => {
    const r = await search(scenery);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const [a, b] = r.body.routes;
    assert.equal(a.scenery.available, true);
    const names = a.scenery.pois.map((p) => p.name);
    assert.ok(names.includes('Test Beach') && names.includes('Test Park'));
    assert.equal(names.filter((n) => n === 'Test Park').length, 1); // way + relation of the same park counted once
    assert.ok(!names.includes('Faraway View')); // 5 km away: dropped by the local distance check
    assert.ok(!names.includes('Mega Mall')); // not a scenic category
    assert.deepEqual(b.scenery.pois.map((p) => p.name), ['Far Lake']);
    assert.ok(a.scenery.score > b.scenery.score && b.scenery.score > 0);
    const beach = a.scenery.pois.find((p) => p.name === 'Test Beach');
    assert.equal(beach.band, 'near');
    assert.ok(Math.abs(beach.distanceM - 150) < 20, String(beach.distanceM));
    assert.equal(a.scenery.pois.find((p) => !p.name).band, 'ring'); // the unnamed viewpoint ~780 m away
    assert.equal(r.body.recommendedRoute.id, 'A');
    assert.ok(r.body.weights.scenery > 0.4);
    assert.match(a.scenery.summary, /nature-related POI/);
    assert.ok(!/official/i.test(a.scenery.summary.replace(/not an official/i, '')));
    assert.match(a.scenery.source, /OpenStreetMap/);
  });
  it('scenery uses several SMALL corridor requests (no tiles, no separate refine) and every one is cached', async () => {
    const r = await search(scenery);
    const n = svc.calls.overpass;
    assert.ok(n > 1 && n <= config.scenery.maxRequests, 'requests: ' + n);
    assert.ok(svc.calls.overpassKinds.every((k) => k === 'segment'));
    assert.equal(r.body.diagnostics.overpass.scenery.segments, n);
    for (const q of svc.calls.overpassQueries) assert.ok(q.length < 4000 && /around:1000,/.test(q), 'query size ' + q.length);
    await search(scenery);
    assert.equal(svc.calls.overpass, n); // identical search: nothing sent at all
  });
  it('one corridor segment fails: scenery is still scored from the rest and flagged incomplete, with a warning', async () => {
    config.overpass.endpointFailureThreshold = 2;
    // fail the first segment of each route (both start at the origin; neither holds the beach, the park or the lake)
    svc.mode.segmentFail = (pts) => Math.abs(pts[0][0] - mock.geo.a[1]) < 1e-3 && Math.abs(pts[0][1] - mock.geo.a[0]) < 1e-3;
    const r = await search(scenery);
    config.overpass.endpointFailureThreshold = 2; // default
    assert.equal(r.status, 200);
    assert.equal(r.body.scenery.available, true);
    assert.equal(r.body.scenery.incomplete, true);
    const [a, b] = r.body.routes;
    assert.equal(a.scenery.incomplete, true);
    assert.ok(a.scenery.coverage >= 0.7 && a.scenery.coverage < 1 && b.scenery.coverage >= 0.7 && b.scenery.coverage < 1);
    assert.match(a.scenery.summary, /Data incomplete/);
    assert.equal(b.scenery.incomplete, true);
    assert.ok(a.scenery.score > 0 && a.scenery.pois.some((p) => p.name === 'Test Beach'));
    assert.ok(r.body.warnings.some((w) => /Scenery data is incomplete/.test(w)));
    assert.match(r.body.diagnostics.overpass.scenery.note, /incomplete/);
  });
  it('too few segments retrieved -> scenery unavailable (all-or-nothing across routes; never scored as 0)', async () => {
    config.overpass.endpointFailureThreshold = 99; config.overpass.retries = 0;
    const mid = mock.midPoint();
    svc.mode.segmentFail = (pts) => pts[0][0] < mid.lat; // the whole southern half of every route
    const r = await search(scenery);
    config.overpass.endpointFailureThreshold = 2; // default config.overpass.retries = 1;
    assert.equal(r.body.scenery.available, false);
    assert.match(r.body.scenery.reason, /could only be retrieved for \d+ % of Route A/);
    assert.ok(r.body.routes.every((x) => x.scenery.available === false && x.scenery.score === null && x.scenery.pois.length === 0));
    assert.deepEqual(r.body.weightsDroppedForMissingData, ['scenery']);
    assert.ok(r.body.warnings.some((w) => /Scenery information unavailable/.test(w)));
  });
  it('Overpass unavailable -> "Scenery information unavailable", no POIs, recommendation from time/traffic/cost', async () => {
    svc.mode.overpass = 'down';
    const r = await search(scenery);
    assert.equal(r.status, 200);
    assert.equal(r.body.scenery.available, false);
    assert.ok(r.body.routes.every((x) => x.scenery.available === false && x.scenery.score === null && x.scenery.pois.length === 0));
    assert.match(r.body.routes[0].scenery.summary, /Scenery information unavailable/);
    assert.ok(r.body.warnings.some((w) => /Scenery information unavailable/.test(w)));
    assert.deepEqual(r.body.weightsDroppedForMissingData, ['scenery']);
    assert.match(r.body.reason, /Scenery information was unavailable/);
    assert.equal(r.body.recommendedRoute.id, 'A');
  });
  it('requested categories restrict what counts ("beaches and parks")', async () => {
    const r = await search({ ...scenery, notes: 'I would like to pass near beaches and parks' });
    assert.deepEqual([...r.body.scenery.categories].sort(), ['beach', 'park']);
    const names = r.body.routes[0].scenery.pois.map((p) => p.name);
    assert.ok(names.includes('Test Beach') && names.includes('Test Park'));
    assert.ok(r.body.routes[0].scenery.pois.every((p) => ['beach', 'park'].includes(p.category)));
    assert.equal(r.body.routes[1].scenery.totalPois, 0); // Route B only has a lake: not requested
    assert.match(r.body.routes[1].scenery.summary, /No beach and park or garden points of interest/);
  });
});

describe('Let AI decide: road conditions, scenery, combined priorities', () => {
  const auto = (notes, extra = {}) => search({ ...demo, preference: 'AUTO', notes, ...extra });

  it('"I want better road conditions." -> BETTER_ROADS', async () => {
    const r = await auto('I want better road conditions.');
    assert.equal(r.body.preference, 'BETTER_ROADS');
    assert.equal(r.body.aiInterpretation.priorities.roadPriority, 'HIGH');
    assert.equal(r.body.roadQuality.requested, true);
  });
  it('"I want a scenic route." -> BETTER_SCENERY', async () => {
    const r = await auto('I want a scenic route.');
    assert.equal(r.body.preference, 'BETTER_SCENERY');
    assert.equal(r.body.scenery.requested, true);
    assert.equal(r.body.roadQuality.requested, false);
  });
  it('good roads AND scenery -> both axes are requested and weighted', async () => {
    const r = await auto('I want good road conditions and a scenic route');
    assert.equal(r.body.preference, 'BALANCED');
    assert.ok(r.body.weights.road >= 0.3 && r.body.weights.scenery >= 0.3);
    assert.equal(r.body.roadQuality.requested, true); assert.equal(r.body.scenery.requested, true);
    assert.ok(svc.calls.overpassKinds.includes('roads') && svc.calls.overpassKinds.includes('segment'));
  });
  it('"good road conditions and less traffic" -> road preference with a raised traffic weight', async () => {
    const plain = await search({ ...demo, preference: 'BETTER_ROADS' });
    const r = await auto('I want good road conditions and less traffic');
    assert.equal(r.body.preference, 'BETTER_ROADS');
    assert.equal(r.body.aiInterpretation.priorities.trafficPriority, 'HIGH');
    assert.ok(r.body.weights.traffic > plain.body.weights.traffic);
  });
  it('a stated time limit is combined with the road priority and can exclude a slower route', async () => {
    svc.mode.roads = 'B_good';
    const r = await auto('I want good road conditions but do not want to travel more than 10 minutes longer');
    assert.deepEqual(r.body.constraints, { maxExtraMinutes: 10 });
    const b = r.body.routes[1];
    assert.equal(b.withinTimeLimit, false); // Route B is ~60 minutes slower once HIGH traffic is applied
    assert.equal(r.body.recommendedRoute.id, 'A');
    assert.match(r.body.reason, /not eligible, as you asked/);
    // ...whereas without the limit Route B's documented road surface wins
    const free = await auto('I want good road conditions');
    assert.equal(free.body.recommendedRoute.id, 'B');
  });
  it("the vague \"don't want to travel much longer\" uses the configured default tolerance", async () => {
    const r = await auto("I want a scenic route but don't want to travel much longer");
    assert.equal(r.body.preference, 'BETTER_SCENERY');
    assert.equal(r.body.constraints.maxExtraPercent, config.defaultDetourPercent);
  });
  it('potholes cannot be assessed: the user is told, and only documented tags are used', async () => {
    const r = await auto('avoid potholes please');
    assert.equal(r.body.preference, 'BETTER_ROADS');
    assert.ok(r.body.warnings.some((w) => /potholes and pavement damage/.test(w) && /not available/.test(w)));
  });
  it('LLM output can add priorities but cannot supply routes, roads or POIs', async () => {
    config.ai.apiKey = 'test-key'; config.ai.apiUrl = `${svc.base}/v1/chat/completions`;
    const r = await auto('I want a scenic route'); // the mock LLM answers CHEAPEST without road/scenery fields; the rule-based hit is still honoured
    assert.equal(r.body.aiInterpretation.source, 'llm');
    assert.equal(r.body.aiInterpretation.priorities.sceneryPriority, 'HIGH');
    assert.equal(r.body.preference, 'BETTER_SCENERY');
    assert.ok(r.body.routes.every((x) => ['A', 'B'].includes(x.id))); // routes still come only from OSRM
  });
});

describe('saving and reloading routes with the new preferences', () => {
  it('stores a labelled snapshot of road/scenery facts and returns it with the trip; old trips stay readable', async () => {
    const { body } = await reg();
    const token = body.token;
    // an "old" trip saved before these features existed
    const old = (await search(demo)).body;
    const oldSaved = await request(app).post('/api/trips').set('Authorization', `Bearer ${token}`).send(tripBody(old));
    assert.equal(oldSaved.status, 201);
    assert.equal(oldSaved.body.trip.selectedRoute.roadQuality, undefined);

    const s = (await search({ ...demo, preference: 'AUTO', notes: 'good road conditions and a scenic route' }, token)).body;
    const created = await request(app).post('/api/trips').set('Authorization', `Bearer ${token}`).send(tripBody(s));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.trip.preference, s.preference);
    const list = await request(app).get('/api/trips').set('Authorization', `Bearer ${token}`);
    assert.equal(list.body.trips.length, 2);
    const saved = list.body.trips.find((t) => t.selectedRoute.roadQuality);
    assert.equal(saved.selectedRoute.roadQuality.available, true);
    assert.match(saved.selectedRoute.roadQuality.note, /not a measurement of current road condition/);
    assert.ok(saved.selectedRoute.roadQuality.snapshotAt);
    assert.equal(saved.selectedRoute.scenery.available, true);
    assert.match(saved.selectedRoute.scenery.note, /not an official scenic rating/);
    assert.ok(saved.selectedRoute.scenery.topPois.length >= 1);
    assert.equal(saved.selectedRoute.roadQuality.evidence, undefined); // way-level evidence is not persisted as a permanent fact
    const one = await request(app).get(`/api/trips/${saved._id}`).set('Authorization', `Bearer ${token}`);
    assert.equal(one.status, 200);
    assert.ok(list.body.trips.some((t) => !t.selectedRoute.roadQuality)); // the old one is still there and readable
  });
  it('saving an "unavailable" result records that it was unavailable, not a score', async () => {
    svc.mode.overpass = 'down';
    const token = (await reg()).body.token;
    const s = (await search({ ...demo, preference: 'BETTER_ROADS' }, token)).body;
    const created = await request(app).post('/api/trips').set('Authorization', `Bearer ${token}`).send(tripBody(s));
    assert.equal(created.status, 201);
    assert.equal(created.body.trip.selectedRoute.roadQuality.available, false);
    assert.equal(created.body.trip.selectedRoute.roadQuality.score, undefined);
  });
  it('crafted snapshot values are clamped and unknown fields ignored', async () => {
    const token = (await reg()).body.token;
    const s = (await search(demo)).body;
    const sel = { ...s.recommendedRoute, roadQuality: { available: true, score: 99999, coverage: 5, evil: 'x', note: 'forged' }, scenery: { available: true, score: -4, totalPois: 1e9, pois: [{ counted: true, name: 'N'.repeat(500), categoryLabel: 'c', osmUrl: 'u' }] } };
    const created = await request(app).post('/api/trips').set('Authorization', `Bearer ${token}`).send({ ...tripBody(s), selectedRoute: sel });
    const rq = created.body.trip.selectedRoute.roadQuality; const sc = created.body.trip.selectedRoute.scenery;
    assert.equal(rq.score, 100); assert.equal(rq.coverage, 1); assert.equal(rq.evil, undefined);
    assert.notEqual(rq.note, 'forged');
    assert.equal(sc.score, 0); assert.equal(sc.totalPois, 10000); assert.equal(sc.topPois[0].name.length, 120);
  });
  it('the new preferences are valid for user defaults', async () => {
    const { body } = await reg();
    const r = await request(app).put('/api/auth/preferences').set('Authorization', `Bearer ${body.token}`).send({ preferredMode: 'BETTER_SCENERY' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.preferences.preferredMode, 'BETTER_SCENERY');
  });
});
