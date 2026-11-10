// Overpass client: endpoint failover, timeouts, 429/502/504 handling, retries, caching and the honest
// "scenery unavailable" result. Uses REAL local HTTP servers (real fetch, real sockets) standing in for the public
// Overpass instances - the client itself is not mocked.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.OVERPASS_MIN_INTERVAL_MS = '0';
process.env.OVERPASS_BACKOFF_MS = '0';
process.env.GEOCODE_USER_AGENT = 'RouteMindAI-Test/1.0';

const http = require('http');
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const overpass = require('../src/services/overpass');
const scenery = require('../src/services/scenery');
const { polylineLengthM } = require('../src/utils');

const OK = { version: 0.6, elements: [{ type: 'node', id: 1, lat: 1, lon: 2, tags: { natural: 'beach' } }] };
let servers = [];
let n = 0;
const uniqueQuery = () => `[out:json];node(${++n});out;`; // every test gets its own cache key

/** Starts a local stand-in for one Overpass instance. `behave(req, res, hitNumber)` decides the response. */
async function startServer(behave) {
  const s = { hits: 0, headers: [], url: '' };
  s.server = http.createServer((req, res) => {
    s.hits++; s.headers.push(req.headers);
    req.resume();
    req.on('end', () => behave(req, res, s.hits));
  });
  await new Promise((r) => s.server.listen(0, '127.0.0.1', r));
  s.url = `http://127.0.0.1:${s.server.address().port}/api/interpreter`;
  servers.push(s);
  return s;
}
const sendJson = (res, body, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
const ok = () => startServer((q, res) => sendJson(res, OK));
const status = (code, headers = {}) => startServer((q, res) => { res.writeHead(code, { 'Content-Type': 'text/html', ...headers }); res.end(`<html>HTTP ${code}</html>`); });
const hang = () => startServer(() => { /* never answers -> the client's timeout fires */ });
const use = (...list) => { config.overpass.urls = list.map((s) => s.url); };

const keep = { ...config.overpass };
beforeEach(() => {
  overpass._reset();
  Object.assign(config.overpass, { timeoutMs: 400, retries: 1, backoffMs: 0, endpointCooldownMs: 30000, endpointCooldownMaxMs: 300000, failureCooldownMs: 30000, endpointFailureThreshold: 1, concurrency: 2, abortAfterFailures: 3 });
});
afterEach(async () => {
  for (const s of servers) { s.server.closeAllConnections(); await new Promise((r) => s.server.close(r)); }
  servers = [];
  Object.assign(config.overpass, keep);
});

describe('Overpass failover', () => {
  it('first endpoint answers: one request, elements returned, endpoint reported', async () => {
    const a = await ok(); const b = await ok(); use(a, b);
    const r = await overpass.run(uniqueQuery(), 'test');
    assert.equal(r.elements.length, 1);
    assert.equal(r.cached, false);
    assert.match(r.endpoint, /127\.0\.0\.1/);
    assert.deepEqual([a.hits, b.hits], [1, 0]);
  });

  it('HTTP 504 on the first endpoint -> the second one answers', async () => {
    const a = await status(504); const b = await ok(); use(a, b);
    const r = await overpass.run(uniqueQuery(), 'test');
    assert.equal(r.elements.length, 1);
    assert.equal(r.endpoint, `http://${new URL(b.url).host}/api/interpreter`);
    assert.equal(b.hits, 1);
  });

  it('HTTP 502 on the first endpoint -> the second one answers', async () => {
    const a = await status(502); const b = await ok(); use(a, b);
    assert.equal((await overpass.run(uniqueQuery(), 'test')).elements.length, 1);
    assert.deepEqual([a.hits, b.hits], [1, 1]);
  });

  it('HTTP 429 -> next endpoint, and the rate-limited server is left alone afterwards (no retry, cool-down)', async () => {
    const a = await status(429, { 'Retry-After': '120' }); const b = await ok(); use(a, b);
    await overpass.run(uniqueQuery(), 'test');
    assert.equal(a.hits, 1); // not retried within the request either
    await overpass.run(uniqueQuery(), 'test'); // a different question: still must not touch the 429 server
    assert.deepEqual([a.hits, b.hits], [1, 2]);
    const until = overpass._health.get(a.url).until - Date.now();
    assert.ok(until > 100000 && until <= 120000, `Retry-After (120 s) honoured, got ${until} ms`);
  });

  it('timeout on the first endpoint -> next endpoint, and a timeout is not retried in the same request', async () => {
    const a = await hang(); const b = await ok(); use(a, b);
    const t = Date.now();
    const r = await overpass.run(uniqueQuery(), 'test');
    assert.equal(r.elements.length, 1);
    assert.ok(Date.now() - t < 2000);
    assert.deepEqual([a.hits, b.hits], [1, 1]);
  });

  it('network error (connection refused) -> next endpoint', async () => {
    const dead = await ok(); const deadUrl = dead.url;
    dead.server.closeAllConnections(); await new Promise((r) => dead.server.close(r));
    const b = await ok();
    config.overpass.urls = [deadUrl, b.url];
    assert.equal((await overpass.run(uniqueQuery(), 'test')).elements.length, 1);
    assert.equal(b.hits, 1);
  });

  it('HTTP 406 (this server refuses us) -> next endpoint', async () => {
    const a = await status(406); const b = await ok(); use(a, b);
    assert.equal((await overpass.run(uniqueQuery(), 'test')).elements.length, 1);
    assert.deepEqual([a.hits, b.hits], [1, 1]);
  });

  it('HTML error page with HTTP 200, or a server-side "ran out of time" remark -> next endpoint', async () => {
    const html = await startServer((q, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>busy</html>'); });
    const remark = await startServer((q, res) => sendJson(res, { elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 26 seconds.' }));
    const good = await ok(); use(html, remark, good);
    assert.equal((await overpass.run(uniqueQuery(), 'test')).elements.length, 1);
    assert.deepEqual([html.hits, remark.hits, good.hits], [1, 1, 1]);
  });

  it('HTTP 400 (our query is invalid) fails at once - no point asking other servers', async () => {
    const a = await status(400); const b = await ok(); use(a, b);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'), (e) => e instanceof overpass.OverpassError && /400/.test(e.message));
    assert.deepEqual([a.hits, b.hits], [1, 0]);
  });

  it('sends the identifying User-Agent and a form-encoded query', async () => {
    const a = await ok(); use(a);
    await overpass.run(uniqueQuery(), 'test');
    assert.equal(a.headers[0]['user-agent'], config.overpass.userAgent);
    assert.equal(a.headers[0]['user-agent'], 'RouteMindAI-Test/1.0');
    assert.match(a.headers[0]['content-type'], /x-www-form-urlencoded/);
  });
});

describe('Overpass retries and backoff', () => {
  it('a 5xx on the only endpoint is retried once after the backoff and then succeeds', async () => {
    const flaky = await startServer((q, res, hit) => (hit === 1 ? (res.writeHead(504), res.end('x')) : sendJson(res, OK)));
    use(flaky);
    const r = await overpass.run(uniqueQuery(), 'test');
    assert.equal(r.elements.length, 1);
    assert.equal(flaky.hits, 2);
  });

  it('the extra pass only goes back to servers that failed fast: never to a timeout or a 429', async () => {
    const a = await status(502); const b = await status(504); const c = await hang(); const d = await status(429); use(a, b, c, d);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'), (e) => e instanceof overpass.OverpassError);
    assert.deepEqual([a.hits, b.hits, c.hits, d.hits], [2, 2, 1, 1]);
  });

  it('OVERPASS_RETRIES=0 means exactly one attempt per endpoint', async () => {
    config.overpass.retries = 0;
    const a = await status(502); const b = await status(504); use(a, b);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'));
    assert.deepEqual([a.hits, b.hits], [1, 1]);
  });

  it('the wait before an extra pass grows exponentially (with jitter) and is capped', () => {
    config.overpass.backoffMs = 1000;
    const within = (pass, lo, hi) => { for (let i = 0; i < 50; i++) { const w = overpass._backoff(pass); assert.ok(w >= lo && w <= hi, `pass ${pass}: ${w}`); } };
    within(0, 800, 1200); within(1, 1600, 2400); within(2, 3200, 4800); within(10, 6400, 9600);
  });

  it('an endpoint cool-down doubles per consecutive failure, up to a cap', async () => {
    config.overpass.endpointCooldownMs = 1000;
    const a = await status(500); use(a);
    const failOnce = async () => { overpass._failures.clear(); config.overpass.retries = 0; await assert.rejects(() => overpass.run(uniqueQuery(), 'test')); };
    await failOnce();
    const first = overpass._health.get(a.url);
    assert.equal(first.failures, 1); assert.ok(first.until - Date.now() <= 1000);
    first.until = 0; // cool-down over -> the endpoint is tried again
    await failOnce();
    const second = overpass._health.get(a.url);
    assert.equal(second.failures, 2); assert.ok(second.until - Date.now() > 1000 && second.until - Date.now() <= 2000);
    second.until = 0;
    config.overpass.endpointCooldownMaxMs = 3000; // capped
    for (let i = 0; i < 4; i++) { overpass._health.get(a.url).until = 0; await failOnce(); }
    assert.ok(overpass._health.get(a.url).until - Date.now() <= 3000);
  });

  it('a recovered endpoint is forgotten as failing', async () => {
    let healthy = false;
    const a = await startServer((q, res) => (healthy ? sendJson(res, OK) : (res.writeHead(503), res.end('x'))));
    use(a); config.overpass.retries = 0;
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'));
    assert.ok(overpass._health.has(a.url));
    overpass._health.get(a.url).until = 0; healthy = true;
    await overpass.run(uniqueQuery(), 'test');
    assert.equal(overpass._health.has(a.url), false);
  });
});

describe('Overpass: all endpoints failed', () => {
  it('throws an OverpassError that names every endpoint, with no data', async () => {
    const a = await status(502); const b = await status(504); const c = await hang(); use(a, b, c);
    const err = await overpass.run(uniqueQuery(), 'test').then(() => null, (e) => e);
    assert.ok(err instanceof overpass.OverpassError);
    assert.equal(err.elements, undefined);
    assert.ok(err.attempts.length >= 3);
    for (const s of [a, b, c]) assert.match(err.message, new RegExp(new URL(s.url).host.replace('.', '\\.')));
    assert.match(err.message, /HTTP 502/); assert.match(err.message, /HTTP 504/); assert.match(err.message, /timed out/);
  });

  it('the failure is remembered: the same question is not sent again, and endpoints in cool-down are not contacted', async () => {
    const a = await status(502); const b = await status(504); use(a, b);
    const q = uniqueQuery();
    await assert.rejects(() => overpass.run(q, 'test'));
    const hits = [a.hits, b.hits];
    await assert.rejects(() => overpass.run(q, 'test'), (e) => e.kind === 'cooldown'); // same query
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'), (e) => e.kind === 'cooldown' && /endpoint/.test(e.message)); // other query, all endpoints cooling
    assert.deepEqual([a.hits, b.hits], hits);
  });

  it('an exhausted time budget fails without sending anything', async () => {
    const a = await ok(); use(a);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test', { deadline: Date.now() + 100 }), (e) => e.kind === 'timeout');
    assert.equal(a.hits, 0);
  });
});

describe('Overpass cache and duplicate requests', () => {
  it('a successful answer is cached: the second identical query sends no request', async () => {
    const a = await ok(); use(a);
    const q = uniqueQuery();
    await overpass.run(q, 'test');
    const again = await overpass.run(q, 'test');
    assert.equal(again.cached, true);
    assert.equal(a.hits, 1);
  });

  it('the cache does not depend on the endpoint list: a cached answer survives re-ordering/changing endpoints', async () => {
    const a = await ok(); const b = await ok(); use(a);
    const q = uniqueQuery();
    await overpass.run(q, 'test');
    use(b, a);
    assert.equal((await overpass.run(q, 'test')).cached, true);
    assert.deepEqual([a.hits, b.hits], [1, 0]);
  });

  it('the cache keeps the existing 24 h lifetime by default', () => {
    assert.equal(keep.cacheTtlMs, 24 * 3600 * 1000);
    assert.equal(overpass._cache.ttl, 24 * 3600 * 1000);
  });

  it('identical concurrent queries share ONE request', async () => {
    const slow = await startServer((q, res) => setTimeout(() => sendJson(res, OK), 100));
    use(slow);
    const q = uniqueQuery();
    const [x, y, z] = await Promise.all([overpass.run(q, 'test'), overpass.run(q, 'test'), overpass.run(q, 'test')]);
    assert.equal(slow.hits, 1);
    assert.equal(x.elements.length + y.elements.length + z.elements.length, 3);
    assert.equal(overpass._inflight.size, 0);
  });

  it('concurrent identical queries all fail together without extra requests', async () => {
    const a = await status(504); use(a); config.overpass.retries = 0;
    const q = uniqueQuery();
    const results = await Promise.allSettled([overpass.run(q, 'test'), overpass.run(q, 'test')]);
    assert.ok(results.every((r) => r.status === 'rejected'));
    assert.equal(a.hits, 1);
  });
});

describe('Overpass configuration', () => {
  // Re-evaluates src/config.js with the given Overpass environment variables, then restores everything.
  const KEYS = ['OVERPASS_URL', 'OVERPASS_URLS', 'OVERPASS_USER_AGENT'];
  const load = (env) => {
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    KEYS.forEach((k) => delete process.env[k]);
    Object.assign(process.env, env);
    const id = require.resolve('../src/config');
    const cached = require.cache[id];
    delete require.cache[id];
    try { return require('../src/config').overpass; } finally {
      KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
      require.cache[id] = cached; // other modules keep using the original config object
    }
  };
  it('defaults to several public endpoints', () => {
    const o = load({});
    assert.ok(o.urls.length >= 3);
    assert.ok(o.urls.every((u) => u.startsWith('https://')));
  });
  it('OVERPASS_URLS is an ordered, de-duplicated, comma-separated list', () => {
    const o = load({ OVERPASS_URLS: 'https://a.example/api/interpreter/, https://b.example/api/interpreter,https://a.example/api/interpreter' });
    assert.deepEqual(o.urls, ['https://a.example/api/interpreter', 'https://b.example/api/interpreter']);
  });
  it('the legacy single OVERPASS_URL still works; OVERPASS_URLS wins when both are set', () => {
    assert.deepEqual(load({ OVERPASS_URL: 'https://own.example/api/interpreter' }).urls, ['https://own.example/api/interpreter']);
    assert.deepEqual(load({ OVERPASS_URL: 'https://own.example/x', OVERPASS_URLS: 'https://list.example/y' }).urls, ['https://list.example/y']);
  });
  it('an empty or invalid value falls back to the defaults', () => {
    assert.ok(load({ OVERPASS_URLS: 'not a url' }).urls.length >= 3);
    assert.ok(load({ OVERPASS_URLS: '' }).urls.length >= 3);
  });
  it('OVERPASS_USER_AGENT overrides the shared user agent', () => {
    assert.equal(load({ OVERPASS_USER_AGENT: 'MyApp/2 (me@example.org)' }).userAgent, 'MyApp/2 (me@example.org)');
    assert.equal(load({}).userAgent, 'RouteMindAI-Test/1.0');
  });
});

describe('Overpass circuit breaker with multi-request searches', () => {
  it('one failed request does not black out an endpoint (threshold 2); two in a row do; a success resets it', async () => {
    config.overpass.endpointFailureThreshold = 2; config.overpass.retries = 0;
    let healthy = false;
    const a = await startServer((q, res) => (healthy ? sendJson(res, OK) : (res.writeHead(503), res.end('x')))); use(a);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'));
    assert.equal(overpass._health.get(a.url).failures, 1);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'), (e) => e.kind === 'busy'); // still asked: not cooling after ONE failure
    assert.equal(a.hits, 2);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'), (e) => e.kind === 'cooldown'); // two in a row -> skipped
    assert.equal(a.hits, 2);
    overpass._health.get(a.url).until = 0; healthy = true;
    await overpass.run(uniqueQuery(), 'test');
    assert.equal(overpass._health.has(a.url), false);
  });

  it('a request that fails twice on the same endpoint (attempt + retry pass) still counts as ONE failure', async () => {
    config.overpass.endpointFailureThreshold = 2; // retries = 1: two attempts per request
    const a = await status(502); use(a);
    await assert.rejects(() => overpass.run(uniqueQuery(), 'test'));
    assert.equal(a.hits, 2);
    assert.equal(overpass._health.get(a.url).failures, 1);
    assert.equal(overpass._health.get(a.url).until, 0);
  });

  it('HTTP 429 opens the breaker at once even with a higher threshold', async () => {
    config.overpass.endpointFailureThreshold = 5;
    const a = await status(429, { 'Retry-After': '60' }); const b = await ok(); use(a, b);
    await overpass.run(uniqueQuery(), 'test');
    assert.ok(overpass._health.get(a.url).until > Date.now() + 50000);
  });
});

/** A server that sees the query text: behave(query, res, hitNumber). */
async function queryServer(behave) {
  const s = await startServer(() => {});
  s.server.removeAllListeners('request');
  s.server.on('request', (req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => { s.hits++; s.headers.push(req.headers); behave(new URLSearchParams(raw).get('data') || '', res, s.hits); });
  });
  s.hits = 0;
  return s;
}

describe('Overpass runMany (the pieces of one search)', () => {
  it('runs every query, keeps the order of the results, and each result is cached on its own', async () => {
    const a = await ok(); use(a);
    const qs = [uniqueQuery(), uniqueQuery(), uniqueQuery()];
    const r = await overpass.runMany(qs, 'test');
    assert.deepEqual(r.map((x) => x.ok), [true, true, true]);
    assert.equal(a.hits, 3);
    const again = await overpass.runMany(qs, 'test');
    assert.ok(again.every((x) => x.ok && x.cached));
    assert.equal(a.hits, 3);
  });

  it('one failing piece does not stop the others; a re-run only re-sends the failed piece', async () => {
    config.overpass.endpointFailureThreshold = 2; config.overpass.retries = 0;
    let failBad = true;
    const a = await queryServer((q, res) => (q.includes('BAD') && failBad ? (res.writeHead(504), res.end('x')) : sendJson(res, OK))); use(a);
    const qs = [uniqueQuery(), `${uniqueQuery()} BAD`, uniqueQuery()];
    const r = await overpass.runMany(qs, 'test');
    assert.deepEqual(r.map((x) => x.ok), [true, false, true]);
    assert.equal(r[1].error.kind, 'busy');
    const hits = a.hits;
    overpass._failures.clear(); failBad = false;
    const again = await overpass.runMany(qs, 'test');
    assert.ok(again.every((x) => x.ok));
    assert.deepEqual(again.map((x) => x.cached), [true, false, true]);
    assert.equal(a.hits, hits + 1);
  });

  it('stops sending the rest when the first requests all fail (does not hammer a dead server)', async () => {
    config.overpass.abortAfterFailures = 2; config.overpass.retries = 0; config.overpass.concurrency = 1;
    config.overpass.endpointFailureThreshold = 99; // keep the endpoint breaker out of the way: this is the search-level stop
    const a = await status(504); use(a);
    const r = await overpass.runMany(Array.from({ length: 8 }, uniqueQuery), 'test');
    assert.equal(a.hits, 2);
    assert.deepEqual(r.map((x) => x.error.kind), ['busy', 'busy', ...Array(6).fill('skipped')]);
  });

  it('does not stop early once something has succeeded', async () => {
    config.overpass.abortAfterFailures = 2; config.overpass.retries = 0; config.overpass.concurrency = 1; config.overpass.endpointFailureThreshold = 99;
    const a = await startServer((q, res, hit) => (hit % 2 ? sendJson(res, OK) : (res.writeHead(504), res.end('x')))); use(a);
    const r = await overpass.runMany(Array.from({ length: 6 }, uniqueQuery), 'test');
    assert.equal(a.hits, 6);
    assert.deepEqual(r.map((x) => x.ok), [true, false, true, false, true, false]);
  });

  it('never has more than OVERPASS_CONCURRENCY requests in flight', async () => {
    let now = 0; let peak = 0;
    const a = await startServer((q, res) => { now++; peak = Math.max(peak, now); setTimeout(() => { now--; sendJson(res, OK); }, 40); }); use(a);
    config.overpass.concurrency = 2;
    await overpass.runMany(Array.from({ length: 6 }, uniqueQuery), 'test');
    assert.equal(peak, 2);
  });
});

describe('Better Scenery: corridor segments', () => {
  // ~100 m north of the route, at its middle
  const beach = { type: 'node', id: 42, lat: 13.0009, lon: 80.3, tags: { natural: 'beach', name: 'Test Beach' } };
  const park = { type: 'way', id: 7, bounds: { minlat: 13.0005, minlon: 80.29, maxlat: 13.0015, maxlon: 80.31 }, tags: { leisure: 'park', name: 'Test Park' } };
  // a ~65 km west-east route -> 4 segments of ~16 km
  const long = { analysis: { line: Array.from({ length: 14 }, (_, i) => [13.0, 80.0 + i * 0.05]) } };
  const polyOf = (q) => {
    const n = /\(around:\d+,([^)]*)\)/.exec(q)[1].split(',').map(Number);
    const p = []; for (let i = 0; i < n.length; i += 2) p.push([n[i], n[i + 1]]);
    return p;
  };

  /** Overpass stand-in: answers a corridor request with the POIs inside its polyline's lon range; fail(points) -> HTTP 504. */
  const corridor = async (fail = () => false) => {
    const seen = [];
    const s = await queryServer((q, res) => {
      const pts = polyOf(q); seen.push({ q, pts });
      if (fail(pts)) { res.writeHead(504); return res.end('x'); }
      const lo = Math.min(...pts.map((p) => p[1])) - 0.01; const hi = Math.max(...pts.map((p) => p[1])) + 0.01;
      const inside = [beach, park].filter((e) => { const lon = e.lon ?? (e.bounds.minlon + e.bounds.maxlon) / 2; return lon >= lo && lon <= hi; });
      sendJson(res, { elements: [...inside, { type: 'count', id: 0 }, ...inside.filter((e) => e.type !== 'node').map((e) => ({ type: e.type, id: e.id }))] });
    });
    s.seen = seen;
    return s;
  };

  it('a long route becomes several SMALL corridor requests, not one big bounding box', async () => {
    const a = await corridor(); use(a);
    const r = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(r.available, true);
    assert.equal(a.hits, 4);
    assert.equal(r.meta.segments, 4);
    for (const { q, pts } of a.seen) {
      assert.match(q, /around:1000,/);
      assert.doesNotMatch(q, /nwr\[[^\]]*\](\[[^\]]*\])*\(-?\d/); // no bounding-box statements
      assert.ok(q.length < 3000, `query size ${q.length}`);
      assert.ok(polylineLengthM(pts) < 20000 * 1.2, `segment length ${polylineLengthM(pts)}`);
    }
    assert.deepEqual(r.perRoute[0].pois.map((p) => p.name).sort(), ['Test Beach', 'Test Park']);
    assert.equal(r.perRoute[0].incomplete, false);
    assert.equal(r.perRoute[0].coverage, 1);
    assert.equal(r.incomplete, undefined);
  });

  it('only the requested categories are queried (beach + park -> 2 data statements per segment)', async () => {
    const a = await corridor(); use(a);
    await scenery.assessScenery([long], ['beach', 'park']);
    for (const { q } of a.seen) {
      assert.equal((q.match(/nwr\[[^\n]*?\(around:1000/g) || []).length, 2);
      assert.doesNotMatch(q, /waterfall|national_park|forest/);
    }
  });

  it('total requests are capped: long routes get longer segments, absurd routes are reported as too long', async () => {
    const a = await corridor(); use(a);
    const line = (km) => ({ analysis: { line: Array.from({ length: 41 }, (_, i) => [13.0, 80.0 + (i * km) / 40 / 108.4]) } });
    const mid = await scenery.assessScenery([line(250)], ['beach']); // 250 km -> 13 pieces of ~19 km
    assert.ok(mid.available);
    assert.ok(a.hits <= config.scenery.maxRequests, `hits ${a.hits}`);
    const before = a.hits;
    const tooLong = await scenery.assessScenery([line(900)], ['beach']);
    assert.equal(tooLong.available, false);
    assert.match(tooLong.reason, /too long/);
    assert.equal(a.hits, before); // nothing was sent for the too-long route
  });

  it('two routes share the request budget', () => {
    const lines = [long, long].map(scenery.queryLine);
    const plan = scenery.planSegments(lines);
    assert.ok(plan.length <= config.scenery.maxRequests);
    assert.deepEqual([...new Set(plan.map((s) => s.route))], [0, 1]);
  });

  it('one segment fails: the score comes from the rest and is clearly flagged incomplete (not zero, not hidden)', async () => {
    config.overpass.endpointFailureThreshold = 2; // one failed request must not black out the other segments
    const a = await corridor((pts) => pts[0][1] < 80.05); use(a); // the FIRST segment (no POIs in it) fails
    const r = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(r.available, true);
    assert.equal(r.incomplete, true);
    const p = r.perRoute[0];
    assert.equal(p.incomplete, true);
    assert.ok(p.coverage > 0.7 && p.coverage < 1, `coverage ${p.coverage}`);
    assert.ok(p.score > 0);
    assert.match(p.summary, /Data incomplete/);
    assert.match(p.summary, new RegExp(`${Math.round(p.coverage * 100)} %`));
    assert.equal(r.meta.segmentsFailed, 1);
    assert.match(r.meta.note, /incomplete: 1 of 4/);
  });

  it('a segment that held the places fails: they are NOT invented, and the result says the data is incomplete', async () => {
    config.overpass.endpointFailureThreshold = 2;
    const a1 = await corridor(); use(a1);
    const full = await scenery.assessScenery([long], ['beach', 'park']);
    overpass._reset();
    const a2 = await corridor((pts) => Math.min(...pts.map((p) => p[1])) <= 80.3 && Math.max(...pts.map((p) => p[1])) >= 80.3); use(a2);
    const part = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(part.available, true);
    assert.equal(part.perRoute[0].incomplete, true);
    assert.ok(part.perRoute[0].totalPois < full.perRoute[0].totalPois);
    assert.ok(part.perRoute[0].pois.every((x) => ['Test Beach', 'Test Park'].includes(x.name)));
    assert.match(part.perRoute[0].summary, /Data incomplete/);
  });

  it('only the failed segment is requested again on the next search; the others come from the cache', async () => {
    config.overpass.endpointFailureThreshold = 2; config.overpass.retries = 0;
    let broken = true;
    const a = await corridor((pts) => broken && pts[0][1] < 80.05); use(a);
    await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(a.hits, 4);
    broken = false; overpass._failures.clear();
    const again = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(a.hits, 5); // exactly one more request
    assert.equal(again.perRoute[0].incomplete, false);
    assert.equal(again.incomplete, undefined);
  });

  it('too much missing: unavailable with the coverage in the reason - never a score of 0', async () => {
    config.overpass.endpointFailureThreshold = 99; config.overpass.retries = 0;
    const a = await corridor((pts) => pts[0][1] < 80.35); use(a); // the first half fails
    const r = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(r.available, false);
    assert.match(r.reason, /could only be retrieved for \d+ % of Route A/);
    assert.match(r.reason, /missing data is not counted as "no scenery"/);
    assert.equal(r.perRoute[0].score, null);
    assert.deepEqual(r.perRoute[0].pois, []);
    assert.match(r.perRoute[0].summary, /^Scenery information unavailable/);
  });

  it('every request fails -> "could not be reached", and the rest of the segments are not even sent', async () => {
    config.overpass.retries = 0; config.overpass.abortAfterFailures = 2; config.overpass.concurrency = 1; config.overpass.endpointFailureThreshold = 99;
    const a = await status(504); use(a);
    const r = await scenery.assessScenery([long, long], ['beach']); // 2 routes x 4 segments
    assert.equal(r.available, false);
    assert.match(r.reason, /could not be reached \(busy\)/);
    assert.equal(a.hits, 2); // two failures, then the other pieces are skipped
    for (const p of r.perRoute) { assert.equal(p.score, null); assert.deepEqual(p.pois, []); }
  });

  it('all endpoints fail on every segment -> honest unavailable result, nothing invented', async () => {
    const a = await status(502); const b = await status(504); const d = await hang(); use(a, b, d);
    const r = await scenery.assessScenery([{ analysis: { line: [[13.0, 80.0], [13.0, 80.1]] } }], ['beach']);
    assert.equal(r.available, false);
    assert.match(r.perRoute[0].summary, /^Scenery information unavailable/);
    assert.equal(r.perRoute[0].score, null);
  });

  it('failover works per segment: a 504 on the first endpoint, the second serves the POIs', async () => {
    const good = await corridor(); const bad = await status(504); use(bad, good);
    const r = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(r.available, true);
    assert.equal(r.perRoute[0].pois.length, 2);
  });

  it('the scoring is unchanged by the transport: the same POIs give the same score from any endpoint', async () => {
    const a1 = await corridor(); use(a1);
    const first = await scenery.assessScenery([long], ['beach', 'park']);
    overpass._reset();
    const bad = await status(503); const a2 = await corridor(); use(bad, a2);
    const second = await scenery.assessScenery([long], ['beach', 'park']);
    assert.equal(second.perRoute[0].score, first.perRoute[0].score);
    assert.deepEqual(second.perRoute[0].pois, first.perRoute[0].pois);
  });
});
