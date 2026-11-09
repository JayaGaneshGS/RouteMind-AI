// Small shared helpers: errors, TTL cache, request throttle, geo maths.

class AppError extends Error {
  constructor(status, message, code = 'ERROR') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true; // safe to show message to client
  }
}

class TTLCache {
  constructor(ttlMs, max = 500) { this.ttl = ttlMs; this.max = max; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) { this.map.delete(key); return undefined; }
    return hit.value;
  }
  set(key, value) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + this.ttl });
  }
  clear() { this.map.clear(); }
}

/** Serialises calls to a public service and enforces a minimum gap between them. */
function createThrottle(minIntervalMs) {
  let last = 0;
  let chain = Promise.resolve();
  return function throttle() {
    chain = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
    });
    return chain;
  };
}

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/** Keep at most `max` points (always keeps first/last) so responses stay small. */
function decimate(points, max = 400) {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

/* ---------- Polyline geometry (points are [lat, lon]; distances in metres) ---------- */

const EARTH_M = 6371008.8;

/** Equirectangular metres of `p` relative to `origin` - accurate to well under 1 % over a few km. */
function toXY(p, origin) {
  return [toRad(p[1] - origin[1]) * Math.cos(toRad(origin[0])) * EARTH_M, toRad(p[0] - origin[0]) * EARTH_M];
}

/** Metres from point `p` to the segment a-b. */
function pointToSegmentM(p, a, b) {
  const A = toXY(a, p); const B = toXY(b, p); // p becomes the origin (0,0)
  const dx = B[0] - A[0]; const dy = B[1] - A[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(A[0] * dx + A[1] * dy) / len2));
  return Math.hypot(A[0] + t * dx, A[1] + t * dy);
}

/** Metres from `p` to the nearest part of a polyline (Infinity for an empty line). */
function distanceToPolylineM(p, line) {
  if (!line || !line.length) return Infinity;
  if (line.length === 1) return haversineKm({ lat: p[0], lon: p[1] }, { lat: line[0][0], lon: line[0][1] }) * 1000;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, pointToSegmentM(p, line[i - 1], line[i]));
  return best;
}

const segM = (a, b) => haversineKm({ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }) * 1000;

/** Total length of a polyline in metres. */
function polylineLengthM(line) {
  let sum = 0;
  for (let i = 1; i < line.length; i++) sum += segM(line[i - 1], line[i]);
  return sum;
}

/**
 * Up to `maxSamples` points spaced evenly along the line (at least `spacingM` apart; the spacing grows for long
 * routes so the count stays bounded). Each sample covers `weightM` metres of the route (its share of the length).
 * Returns [{ lat, lon, atM, weightM }].
 */
function samplePointsAlong(line, spacingM, maxSamples) {
  const total = polylineLengthM(line);
  if (line.length < 2 || total <= 0) return [];
  const n = Math.max(1, Math.min(maxSamples, Math.ceil(total / spacingM)));
  const step = total / n;
  const out = [];
  let seg = 1; let segStart = 0; let segLen = segM(line[0], line[1]);
  for (let k = 0; k < n; k++) {
    const target = (k + 0.5) * step; // middle of each equal-length slice
    while (target > segStart + segLen && seg < line.length - 1) { segStart += segLen; seg++; segLen = segM(line[seg - 1], line[seg]); }
    const f = segLen > 0 ? Math.max(0, Math.min(1, (target - segStart) / segLen)) : 0;
    const a = line[seg - 1]; const b = line[seg];
    out.push({ lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, atM: target, weightM: step });
  }
  return out;
}

/**
 * Douglas-Peucker simplification: no vertex of the original line is farther than `tolM` from the result.
 * If the result still has more than `maxPoints`, the tolerance is doubled until it fits.
 */
function simplifyLine(line, tolM, maxPoints = Infinity) {
  if (line.length <= 2) return line.slice();
  let tol = tolM;
  for (let attempt = 0; attempt < 12; attempt++) {
    const keep = new Uint8Array(line.length);
    keep[0] = 1; keep[line.length - 1] = 1;
    const stack = [[0, line.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop();
      let maxD = 0; let idx = -1;
      for (let i = s + 1; i < e; i++) { const d = pointToSegmentM(line[i], line[s], line[e]); if (d > maxD) { maxD = d; idx = i; } }
      if (idx >= 0 && maxD > tol) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    const out = line.filter((_, i) => keep[i]);
    if (out.length <= maxPoints) return out;
    tol *= 2;
  }
  return decimate(line, maxPoints);
}

module.exports = {
  AppError, TTLCache, createThrottle, haversineKm, decimate, formatDuration,
  distanceToPolylineM, pointToSegmentM, polylineLengthM, samplePointsAlong, simplifyLine,
};
