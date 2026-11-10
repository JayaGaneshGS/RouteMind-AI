// Client for the OpenStreetMap Overpass API (road tags and scenic POIs). Same rules as the other external services:
// identifying User-Agent, throttle, timeout, cache, and NO invented data - on any failure the caller gets an
// OverpassError and reports "data unavailable". Failures are remembered briefly (cool-down) so an overloaded public
// server is not hammered by repeated searches.
//
// The public Overpass servers are volunteer-run and each one is regularly overloaded (HTTP 502/504, timeouts), so a
// request is tried against an ordered LIST of endpoints (config.overpass.urls):
//  - A timeout, network error, HTTP 429, 5xx, or an HTTP 4xx other than 400 moves on to the next endpoint.
//    (400 = our query was rejected; every server would reject it, so it fails immediately.)
//  - A failing endpoint is skipped by later requests for a while ("circuit breaker": 30 s, doubling per consecutive
//    failure up to 5 min, or the server's Retry-After if longer). 429s therefore stop us from asking that server again.
//  - If every endpoint failed and some failed FAST (5xx / network error - not a timeout, not 429), one more pass over
//    just those is made after an exponential backoff (`retries` extra passes). A timeout is never retried in the same
//    request: it is the signature of an overloaded server and would also eat the time budget.
//  - Identical queries share one in-flight request and one cache entry (cache key = the query, NOT the endpoint:
//    the answer is the same wherever it came from).
//
// Usage policy: https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
const crypto = require('crypto');
const config = require('../config');
const { TTLCache, createThrottle } = require('../utils');
const { log, warn, safeUrl } = require('../log');
const diagnostics = require('../diagnostics');

class OverpassError extends Error {
  constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); } // kind: timeout | busy | http | parse | cooldown
}

const MIN_ATTEMPT_MS = 2000; // never start an HTTP attempt with less time than this left in the request budget
const cache = new TTLCache(config.overpass.cacheTtlMs, 100);
const failures = new TTLCache(config.overpass.failureCooldownMs, 100); // query-level: "this exact question failed a moment ago"
const health = new Map(); // endpoint url -> { failures, until, reason }   (endpoint-level circuit breaker)
const throttles = new Map(); // endpoint url -> throttle (the 1 request/sec courtesy applies per server)
const inflight = new Map(); // query key -> Promise (identical concurrent requests share one round trip)

const keyOf = (query) => crypto.createHash('sha1').update(query).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throttleFor = (url) => { if (!throttles.has(url)) throttles.set(url, createThrottle(config.overpass.minIntervalMs)); return throttles.get(url); };
const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

/** Retry-After header -> milliseconds (it is either a number of seconds or an HTTP date). */
function retryAfterMs(res) {
  const v = res.headers?.get?.('retry-after');
  if (!v) return 0;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/** One HTTP attempt against one endpoint. Resolves to the elements array or throws an OverpassError describing why not. */
async function attempt(url, query, timeoutMs) {
  await throttleFor(url)();
  let res; let text;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': config.overpass.userAgent, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new OverpassError('timeout', `timed out after ${Math.round(timeoutMs / 1000)} s`);
    throw new OverpassError('http', `network error (${err.cause?.code || err.message})`, { retryNext: true });
  }
  if (res.status === 429) throw new OverpassError('busy', 'HTTP 429 (rate limited)', { status: 429, retryAfterMs: retryAfterMs(res) });
  if (res.status >= 500) throw new OverpassError('busy', `HTTP ${res.status}`, { status: res.status, retryNext: true, retryAfterMs: retryAfterMs(res) });
  if (res.status === 400) throw new OverpassError('http', 'HTTP 400 (query rejected)', { status: 400, fatal: true });
  if (!res.ok) throw new OverpassError('http', `HTTP ${res.status}`, { status: res.status }); // e.g. 403/406: this server refuses us; others may not
  let body;
  try { body = JSON.parse(text); } catch { throw new OverpassError('busy', 'returned an error page instead of JSON', { retryNext: true }); }
  // Overpass answers 200 with a "remark" when it ran out of time/memory: the element list is then incomplete.
  if (body.remark && /error|timed out|out of memory/i.test(body.remark)) throw new OverpassError('timeout', `server-side limit: ${String(body.remark).slice(0, 120)}`);
  if (!Array.isArray(body.elements)) throw new OverpassError('parse', 'response had no elements array');
  return body.elements;
}

/* ---------- Endpoint health (circuit breaker) ---------- */

/**
 * Records that a whole request failed on this endpoint (called once per request and endpoint, not once per attempt).
 * The endpoint is skipped only after `endpointFailureThreshold` consecutive failed requests - or at once for HTTP 429 /
 * a Retry-After header - so one failed piece of a multi-request search cannot black out the other pieces. The skip time
 * is `endpointCooldownMs`, doubling per further consecutive failure, up to `endpointCooldownMaxMs`.
 */
function markFailure(url, err) {
  const h = health.get(url) || { failures: 0, until: 0, reason: '' };
  h.failures++;
  h.reason = err.message;
  const immediate = err.status === 429 || err.retryAfterMs > 0;
  if (h.failures >= config.overpass.endpointFailureThreshold || immediate) {
    const own = Math.min(config.overpass.endpointCooldownMaxMs, config.overpass.endpointCooldownMs * 2 ** Math.max(0, h.failures - config.overpass.endpointFailureThreshold));
    h.until = Date.now() + Math.max(own, Math.min(config.overpass.endpointCooldownMaxMs, err.retryAfterMs || 0));
  }
  health.set(url, h);
}
const markSuccess = (url) => health.delete(url);
const coolingDown = (url) => (health.get(url)?.until || 0) > Date.now();

/** Exponential backoff with jitter before extra pass number `pass` (0-based), capped at 8 s. */
const backoff = (pass) => Math.min(8000, config.overpass.backoffMs * 2 ** pass) * (0.8 + Math.random() * 0.4);

/**
 * Tries the endpoints in order until one answers. Resolves { elements, endpoint, tried }.
 * `tried` = [{ endpoint, outcome }] for every HTTP attempt made (also on failure, as err.attempts).
 */
async function execute(query, label, opts) {
  const left = () => (opts.deadline ? opts.deadline - Date.now() : Infinity);
  let pool = config.overpass.urls.filter((u) => !coolingDown(u));
  if (!pool.length) {
    const soon = Math.min(...config.overpass.urls.map((u) => health.get(u)?.until || 0));
    throw new OverpassError('cooldown', `All ${config.overpass.urls.length} Overpass endpoint(s) failed a moment ago; not asking again for ${Math.max(1, Math.round((soon - Date.now()) / 1000))} s.`);
  }
  const tried = [];
  const failedHere = new Map(); // endpoint -> last error in THIS request; recorded once, when the request is over
  const settle = () => failedHere.forEach((e, u) => markFailure(u, e));
  let lastErr = null;

  for (let pass = 0; pass <= config.overpass.retries; pass++) {
    const retryPool = [];
    for (const url of pool) {
      if (left() < MIN_ATTEMPT_MS) break;
      const t = Date.now();
      try {
        const elements = await attempt(url, query, Math.min(config.overpass.timeoutMs, left()));
        failedHere.delete(url);
        settle();
        markSuccess(url);
        tried.push({ endpoint: safeUrl(url), outcome: 'ok' });
        diagnostics.record(`overpass@${hostOf(url)}`, { ok: true, ms: Date.now() - t });
        return { elements, endpoint: safeUrl(url), tried };
      } catch (err) {
        const e = err instanceof OverpassError ? err : new OverpassError('http', `request failed: ${err.message}`);
        lastErr = e;
        tried.push({ endpoint: safeUrl(url), outcome: e.message });
        diagnostics.record(`overpass@${hostOf(url)}`, { ok: false, ms: Date.now() - t, detail: e.message });
        warn('OVERPASS', `${label}: ${hostOf(url)} - ${e.message}${pool.length > 1 || pass < config.overpass.retries ? '; trying the next option' : ''}`);
        if (e.fatal) { e.attempts = tried; throw e; }
        failedHere.set(url, e);
        if (e.retryNext) retryPool.push(url);
      }
    }
    // Extra pass: only endpoints that failed fast (5xx / network error), after an exponential backoff - never a timeout or 429.
    pool = retryPool;
    if (!pool.length || pass === config.overpass.retries) break;
    const wait = backoff(pass);
    if (left() < wait + MIN_ATTEMPT_MS * 2) break;
    warn('OVERPASS', `${label}: retrying ${pool.map(hostOf).join(', ')} in ${Math.round(wait)} ms`);
    await sleep(wait);
  }

  settle();
  const err = lastErr
    ? new OverpassError(lastErr.kind, `All ${tried.length} Overpass attempt(s) failed - ${tried.map((a) => `${hostOf(a.endpoint)}: ${a.outcome}`).join('; ')}`)
    : new OverpassError('timeout', 'no time left in the request budget');
  err.attempts = tried;
  throw err;
}

/**
 * Runs an Overpass QL query (must request [out:json]). Returns { elements, cached, ms, endpoint }.
 * Throws OverpassError - callers must turn that into "data unavailable", never into substitute data.
 * `label` is only used in logs ("road-tags" / "scenery"). `opts.deadline` (epoch ms) caps the total time spent here:
 * attempts get only the time that is left, and no retry is started that could not finish.
 */
async function run(query, label, opts = {}) {
  const key = keyOf(query);
  const hit = cache.get(key);
  if (hit) {
    log('OVERPASS', `${label}: served from cache (no request sent)`);
    diagnostics.record('overpass', { cached: true });
    return { elements: hit, cached: true, ms: 0 };
  }
  const recent = failures.get(key);
  if (recent) throw new OverpassError('cooldown', `Overpass failed a moment ago (${recent}); not retrying for ${Math.round(config.overpass.failureCooldownMs / 1000)} s.`);

  const shared = inflight.get(key);
  if (shared) {
    log('OVERPASS', `${label}: identical request already in flight - sharing its result (no extra request sent)`);
    return { ...(await shared), deduped: true };
  }

  log('OVERPASS', `${label}: querying ${config.overpass.urls.length} endpoint(s), first ${safeUrl(config.overpass.urls[0])} (${Math.round(query.length / 1024)} KB query)`);
  const t0 = Date.now();
  const promise = execute(query, label, opts).then((r) => {
    const ms = Date.now() - t0;
    diagnostics.record('overpass', { ok: true, ms });
    log('OVERPASS', `${label}: ${r.elements.length} elements from ${r.endpoint} (${ms} ms, ${r.tried.length} attempt(s))`);
    cache.set(key, r.elements);
    return { elements: r.elements, cached: false, ms, endpoint: r.endpoint };
  }, (err) => {
    diagnostics.record('overpass', { ok: false, ms: Date.now() - t0, detail: err.message });
    warn('OVERPASS', `${label}: failed - ${err.message}`);
    if (err.attempts?.length) failures.set(key, err.kind); // only if a server was really asked; "no time left" is not the server's fault
    throw err;
  });
  inflight.set(key, promise);
  try { return await promise; } finally { inflight.delete(key); }
}

/**
 * Runs several INDEPENDENT queries (e.g. the corridor segments of one search) with limited concurrency, so one slow or
 * failed piece does not sink the others. Every query goes through run(), so each keeps its own cache entry, in-flight
 * de-duplication, endpoint failover and cool-downs. Never throws; resolves to one entry per query, in order:
 *   { ok: true, elements, cached, ms, endpoint }   or   { ok: false, error: OverpassError }
 * If `abortAfterFailures` requests fail before ANY has succeeded, the remaining ones are not sent (error kind 'skipped'):
 * a dead network must not be hammered with the rest of a long route.
 */
async function runMany(queries, label, opts = {}) {
  const results = new Array(queries.length);
  const stopAt = config.overpass.abortAfterFailures;
  let next = 0; let failures = 0; let successes = 0;
  const worker = async () => {
    while (next < queries.length) {
      const i = next++;
      if (stopAt > 0 && !successes && failures >= stopAt) {
        results[i] = { ok: false, error: new OverpassError('skipped', `not sent: ${failures} requests in a row failed, Overpass looks unavailable`) };
        continue;
      }
      try { results[i] = { ok: true, ...(await run(queries[i], `${label} ${i + 1}/${queries.length}`, opts)) }; successes++; } catch (err) {
        results[i] = { ok: false, error: err instanceof OverpassError ? err : new OverpassError('http', err.message) };
        failures++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.overpass.concurrency, queries.length)) }, worker));
  return results;
}

/** Overpass `[timeout:N]` header value (seconds) kept just under our own HTTP timeout. */
const serverTimeoutSeconds = () => Math.max(5, Math.floor(config.overpass.timeoutMs / 1000) - 3);

/** Test helper: forget all cached results, failures and endpoint health. */
const _reset = () => { cache.clear(); failures.clear(); health.clear(); throttles.clear(); inflight.clear(); };

module.exports = { run, runMany, OverpassError, serverTimeoutSeconds, _cache: cache, _failures: failures, _health: health, _inflight: inflight, _reset, _backoff: backoff };
