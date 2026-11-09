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
  Object.assign(config.overpass, { timeoutMs: 400, retries: 1, backoffMs: 0, endpointCooldownMs: 30000, endpointCooldownMaxMs: 300000, failureCooldownMs: 30000 });
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

describe('Better Scenery on top of the failover client', () => {
  // Route A: a straight line at lat 13.0; a real-looking beach node 100 m north of it.
  const route = { analysis: { line: [[13.0, 80.0], [13.0, 80.05], [13.0, 80.1]] } };
  const beach = { type: 'node', id: 42, lat: 13.0009, lon: 80.05, tags: { natural: 'beach', name: 'Test Beach' } };
  const tiles = (q, res) => sendJson(res, { version: 0.6, elements: [beach] });

  it('first endpoint 504, second endpoint serves the POIs -> a real score from the real POI', async () => {
    const a = await status(504); const b = await startServer(tiles); use(a, b);
    const r = await scenery.assessScenery([route], ['beach']);
    assert.equal(r.available, true);
    assert.equal(r.perRoute[0].pois.length, 1);
    assert.equal(r.perRoute[0].pois[0].name, 'Test Beach');
    assert.ok(r.perRoute[0].score > 0);
    assert.deepEqual([a.hits, b.hits], [1, 1]);
  });

  it('all endpoints fail -> the honest "Scenery information unavailable" result: no POIs, no score', async () => {
    const a = await status(502); const b = await status(504); const c = await hang(); use(a, b, c);
    const r = await scenery.assessScenery([route, route], ['beach']);
    assert.equal(r.available, false);
    assert.match(r.reason, /could not be reached/);
    assert.equal(r.perRoute.length, 2);
    for (const p of r.perRoute) {
      assert.equal(p.available, false);
      assert.equal(p.score, null);
      assert.deepEqual(p.pois, []);
      assert.match(p.summary, /^Scenery information unavailable/);
    }
  });

  it('the scoring is unchanged by the transport: same POI, same score from any endpoint', async () => {
    const a = await startServer(tiles); use(a);
    const first = await scenery.assessScenery([route], ['beach']);
    overpass._reset();
    const b = await status(503); const c = await startServer(tiles); use(b, c);
    const second = await scenery.assessScenery([route], ['beach']);
    assert.equal(second.perRoute[0].score, first.perRoute[0].score);
    assert.deepEqual(second.perRoute[0].pois, first.perRoute[0].pois);
  });
});
