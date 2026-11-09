// Real call counters per external service. Everything here is recorded by the code that actually
// performs the call - nothing is hard-coded as "connected". Contains no credentials.
const stats = {};
const started = new Date().toISOString();

function record(service, { ok, ms, cached = false, detail = '' }) {
  const s = (stats[service] ||= { calls: 0, cacheHits: 0, successes: 0, failures: 0, lastOk: null, lastCallAt: null, lastMs: null, lastError: null });
  if (cached) { s.cacheHits++; return; }
  s.calls++; s.lastCallAt = new Date().toISOString(); s.lastMs = ms;
  if (ok) { s.successes++; s.lastOk = true; s.lastError = null; } else { s.failures++; s.lastOk = false; s.lastError = String(detail).slice(0, 200); }
}

const snapshot = () => ({ since: started, services: JSON.parse(JSON.stringify(stats)) });
const reset = () => { for (const k of Object.keys(stats)) delete stats[k]; };

module.exports = { record, snapshot, reset };
