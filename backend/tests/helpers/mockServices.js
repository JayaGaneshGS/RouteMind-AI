// Local stand-ins for Nominatim, OSRM, the Python ML service and an OpenAI-style LLM, so tests are
// deterministic and never touch public servers.
const http = require('http');
const { distanceToPolylineM } = require('../../src/utils');

const PLACES = {
  chennai: { display_name: 'Chennai, Tamil Nadu, India', lat: '13.0836939', lon: '80.270186' },
  pondicherry: { display_name: 'Puducherry, India', lat: '11.9340', lon: '79.8306' },
  bengaluru: { display_name: 'Bengaluru, Karnataka, India', lat: '12.9767936', lon: '77.590082' },
};

// overpass: up | down (connection dropped) | busy (HTTP 504) | flaky (first request 504, then fine) | second504 (only the 2nd request gets 504) | garbage (HTML) | remark (200 + runtime-error remark)
// roads:    A_good (Route A's East Coast Road is tagged asphalt+good; NH32 untagged) | B_good (NH32 tagged asphalt; ECR untagged) | none (no surface tags) | unpaved_A
// segmentFail: null | (points) => boolean - a scenery corridor-segment request whose polyline satisfies this gets HTTP 504 (others are fine)
const mode = { osrm: 'two', ml: 'up', llm: 'good', nominatim: 'up', overpass: 'up', roads: 'A_good', segmentFail: null };
const calls = { nominatim: 0, osrm: 0, ml: 0, overpass: 0, overpassKinds: [], overpassQueries: [], lastNominatim: null, lastOsrm: null, lastOverpass: null };
const geo = { a: [80.2702, 13.0837], b: [79.8306, 11.934] }; // [lon, lat] of the last OSRM request (for placing mock POIs)
const midPoint = () => ({ lat: (geo.a[1] + geo.b[1]) / 2, lon: (geo.a[0] + geo.b[0]) / 2 });

function line(a, b, bend = 0) {
  const pts = [];
  for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push([a[0] + (b[0] - a[0]) * t + bend * Math.sin(Math.PI * t), a[1] + (b[1] - a[1]) * t]); }
  return pts.map(([lon, lat]) => [lon, lat]);
}

function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const body = () => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s ? JSON.parse(s) : {})); });

  if (url.pathname === '/search') {
    calls.nominatim++;
    calls.lastNominatim = { query: Object.fromEntries(url.searchParams), userAgent: req.headers['user-agent'] };
    if (mode.nominatim === 'down') return req.destroy();
    const p = PLACES[(url.searchParams.get('q') || '').toLowerCase()];
    return json(200, p ? [p] : []);
  }
  if (url.pathname.startsWith('/route/v1/driving/')) {
    calls.osrm++;
    calls.lastOsrm = { path: url.pathname, query: Object.fromEntries(url.searchParams) };
    if (mode.osrm === 'fail') return json(500, { code: 'Error' });
    if (mode.osrm === 'noroute') return json(200, { code: 'NoRoute', message: 'Impossible route' });
    const coords = url.pathname.split('/').pop().split(';').map((c) => c.split(',').map(Number));
    const a = coords[0]; const b = coords[coords.length - 1];
    geo.a = a; geo.b = b;
    const leg = (summary, n) => [{ summary, steps: Array.from({ length: n }, () => ({ name: summary.split(',')[0], ref: summary.startsWith('NH32') ? 'NH32' : '', distance: 1000 })) }];
    const routes = [{ distance: 150000, duration: 10500, geometry: { coordinates: line(a, b, 0.0) }, legs: leg('East Coast Road, Chennai-Puducherry Road', 6) }];
    if (mode.osrm === 'two') routes.push({ distance: 165000, duration: 10100, geometry: { coordinates: line(a, b, 0.1) }, legs: leg('NH32, GST Road', 8) });
    return json(200, { code: 'Ok', routes });
  }
  if (url.pathname === '/health') { calls.ml++; return mode.ml === 'down' ? req.destroy() : json(200, { status: 'ok', model_loaded: true }); }
  if (url.pathname.startsWith('/predict-') || url.pathname === '/model-info') {
    calls.ml++;
    if (mode.ml === 'down') return req.destroy();
    return body().then((b) => {
      if (url.pathname === '/model-info') return json(200, { accuracy: 0.8 });
      if (url.pathname === '/predict-travel-time') {
        const m = { LOW: 1.05, MEDIUM: 1.2, HIGH: 1.45 }[b.traffic_level];
        return json(200, { base_minutes: b.base_minutes, multiplier: m, predicted_minutes: Math.round(b.base_minutes * m * 10) / 10, traffic_level: b.traffic_level });
      }
      // deterministic fake classifier: longer/slower routes -> HIGH, others LOW
      const one = (i) => (i.distance > 160 ? { traffic_level: 'HIGH', confidence: 0.8, probabilities: { LOW: 0.1, MEDIUM: 0.1, HIGH: 0.8 } } : { traffic_level: 'LOW', confidence: 0.9, probabilities: { LOW: 0.9, MEDIUM: 0.07, HIGH: 0.03 } });
      if (url.pathname === '/predict-traffic/batch') return json(200, { results: b.items.map(one) });
      return json(200, one(b));
    });
  }
  if (url.pathname === '/api/interpreter') return overpass(req, res, json);
  if (url.pathname === '/v1/chat/completions') {
    return body().then((b) => {
      if (mode.llm === 'error') return json(500, {});
      const sys = b.messages[0].content;
      const content = sys.includes('JSON ONLY')
        ? (mode.llm === 'good' ? '{"preference":"CHEAPEST","timePriority":"LOW","trafficPriority":"MEDIUM","costPriority":"HIGH","comfortPriority":"MEDIUM"}' : 'not json at all')
        : 'LLM says: Route A is a good pick for your preference.';
      return json(200, { choices: [{ message: { content } }] });
    });
  }
  json(404, {});
}

/* ---------- Overpass stand-in ---------- */

const way = (id, tags) => ({ type: 'way', id, tags });
const count = () => ({ type: 'count', id: 0, tags: { total: '0' } });
const mid = () => ({ lat: (geo.a[1] + geo.b[1]) / 2, lon: (geo.a[0] + geo.b[0]) / 2 }); // Route A is the straight line a-b; Route B bends 0.1 deg east of it
// A point `meters` away from Route A's midpoint, measured perpendicular to the route (so the distance to the route is exact).
function offsetFromA(meters) {
  const m = mid(); const k = Math.cos((m.lat * Math.PI) / 180);
  const dy = (geo.b[1] - geo.a[1]) * 111320; const dx = (geo.b[0] - geo.a[0]) * 111320 * k; const len = Math.hypot(dx, dy);
  const nx = -dy / len; const ny = dx / len; // unit normal (east, north)
  return { lat: m.lat + (ny * meters) / 111320, lon: m.lon + (nx * meters) / (111320 * k) };
}
const box = (lat, lon, d = 0.002) => ({ minlat: lat - d, minlon: lon - d, maxlat: lat + d, maxlon: lon + d });

function roadWays(k) {
  const A = mode.roads === 'A_good' ? { surface: 'asphalt', smoothness: 'good' } : mode.roads === 'unpaved_A' ? { surface: 'gravel' } : {};
  const B = mode.roads === 'B_good' ? { surface: 'asphalt' } : {};
  const main = k === 0 ? way(111, { highway: 'primary', name: 'East Coast Road', ...A }) : way(222, { highway: 'trunk', name: 'NH32', ref: 'NH32', ...B });
  return [main, way(333, { highway: 'residential', name: 'Side Road', surface: 'dirt' })]; // a crossing street that must not be used
}

function scenicPois() {
  const m = mid();
  const bm = { lat: m.lat, lon: m.lon + 0.1 };
  return [
    { type: 'node', id: 1, ...offsetFromA(150), tags: { natural: 'beach', name: 'Test Beach' } }, // 150 m from Route A
    { type: 'node', id: 2, ...offsetFromA(700), tags: { tourism: 'viewpoint' } }, // 700 m from Route A, unnamed
    { type: 'node', id: 3, ...offsetFromA(5000), tags: { tourism: 'viewpoint', name: 'Faraway View' } }, // 5 km: must be dropped locally
    { type: 'way', id: 10, bounds: box(offsetFromA(100).lat, offsetFromA(100).lon), tags: { leisure: 'park', name: 'Test Park' } },
    { type: 'relation', id: 20, bounds: box(offsetFromA(100).lat, offsetFromA(100).lon), tags: { leisure: 'park', name: 'Test Park' } }, // same park mapped again
    { type: 'way', id: 11, bounds: box(bm.lat + 600 / 111320, bm.lon), tags: { natural: 'water', water: 'lake', name: 'Far Lake' } }, // ~600 m from Route B only
    { type: 'node', id: 4, ...offsetFromA(50), tags: { shop: 'mall', name: 'Mega Mall' } }, // not a scenic category
  ];
}

/**
 * What real Overpass answers for one scenery corridor request: the mock POIs within the `around` radius of the segment's polyline
 * (nodes by exact distance, areas by the distance of their centre - the mock areas are tiny), then a `count` delimiter, then the ids
 * of the areas within the "near" radius. `mode.segmentFail(points)` makes chosen segments fail with HTTP 504.
 */
function segmentElements(q, req, res) {
  const [, maxM, coords] = /\(around:(\d+),([^)]*)\)/.exec(q);
  const nearM = Number(/nwr\.a\(around:(\d+),/.exec(q)[1]);
  const n = coords.split(',').map(Number);
  const pts = []; for (let i = 0; i < n.length; i += 2) pts.push([n[i], n[i + 1]]);
  if (mode.segmentFail && mode.segmentFail(pts)) { res.writeHead(504); res.end('<html>busy</html>'); return null; }
  const dist = (el) => (el.type === 'node' ? distanceToPolylineM([el.lat, el.lon], pts)
    : distanceToPolylineM([(el.bounds.minlat + el.bounds.maxlat) / 2, (el.bounds.minlon + el.bounds.maxlon) / 2], pts));
  const inRange = scenicPois().filter((el) => dist(el) <= Number(maxM));
  const near = inRange.filter((el) => el.type !== 'node' && dist(el) <= nearM);
  return [...inRange, count(), ...near.map((el) => ({ type: el.type, id: el.id }))];
}

function overpass(req, res, json) {
  calls.overpass++;
  return new Promise((resolve) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => resolve(s)); }).then((raw) => {
    const q = new URLSearchParams(raw).get('data') || '';
    calls.lastOverpass = q;
    calls.overpassQueries.push(q);
    const kind = q.includes('out count') && q.includes('["highway"]') ? 'roads' : q.includes('around:') && q.includes('out tags bb') ? 'segment' : 'other';
    calls.overpassKinds.push(kind);
    if (mode.overpass === 'down') return req.socket.destroy();
    if (mode.overpass === 'busy' || (mode.overpass === 'flaky' && calls.overpass === 1) || (mode.overpass === 'second504' && calls.overpass === 2)) { res.writeHead(504); return res.end('<html>busy</html>'); }
    if (mode.overpass === 'garbage') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>not json</html>'); }
    if (mode.overpass === 'remark') return json(200, { version: 0.6, remark: 'runtime error: Query timed out in "query" at line 3 after 26 seconds.', elements: [] });
    if (kind === 'roads') {
      const elements = [];
      for (const m of q.matchAll(/->\.r(\d+)s(\d+);/g)) elements.push(...roadWays(Number(m[1])), count());
      return json(200, { version: 0.6, elements });
    }
    if (kind === 'segment') { const els = segmentElements(q, req, res); return els && json(200, { version: 0.6, elements: els }); }
    return json(400, {});
  });
}

async function start() {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, mode, calls, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

module.exports = { start, midPoint, geo };
