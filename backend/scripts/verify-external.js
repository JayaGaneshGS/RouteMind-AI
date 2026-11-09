// MANUAL EXTERNAL SERVICE TEST - talks to the REAL services configured in your .env:
//   MongoDB Atlas, Nominatim, OSRM and the Python ML service. No mocks. Run:  npm run verify:external
// Prints PASS/FAIL per service and never prints credentials (MONGO_URI, passwords, keys).
// Needs: internet access, a valid MONGO_URI with your IP allowed in Atlas Network Access, and the ML service running.
const mongoose = require('mongoose');
const config = require('../src/config');
const db = require('../src/services/db');
const geocode = require('../src/services/geocode');
const routing = require('../src/services/routing');
const roadQuality = require('../src/services/roadQuality');
const scenery = require('../src/services/scenery');
const ml = require('../src/services/mlClient');
const { redact, safeUrl } = require('../src/log');

process.env.LOG_IN_TEST = ''; // keep app logs on; they are redacted
const results = [];
const check = async (name, fn) => {
  try { const detail = await fn(); results.push({ name, ok: true }); console.log(`PASS  ${name}${detail ? ` - ${detail}` : ''}`); }
  catch (err) { results.push({ name, ok: false }); console.log(`FAIL  ${name} - ${redact(err.message).split('\n')[0]}`); }
};

(async () => {
  console.log('RouteMind AI - real external service check\n');
  let from; let to;

  await check('MongoDB Atlas', async () => {
    const problem = db.validateUri();
    if (problem) throw new Error(problem);
    try { await mongoose.connect(config.mongoUri, { dbName: config.mongoDbName, serverSelectionTimeoutMS: 10000 }); }
    catch { throw new Error(db.HINT); }
    await mongoose.connection.db.admin().ping();
    const [users, trips] = await Promise.all(['users', 'trips'].map((c) => mongoose.connection.db.collection(c).countDocuments()));
    return `connected (database "${config.mongoDbName}": ${users} users, ${trips} trips)`;
  });

  await check(`Nominatim (${safeUrl(config.geocodeUrl)})`, async () => {
    from = await geocode.resolvePlace('Chennai', 'Origin');
    to = await geocode.resolvePlace('Pondicherry', 'Destination');
    return `Chennai -> ${from.lat.toFixed(4)}, ${from.lon.toFixed(4)}; Pondicherry -> ${to.lat.toFixed(4)}, ${to.lon.toFixed(4)}`;
  });

  await check(`OSRM (${safeUrl(config.osrmUrl)})`, async () => {
    if (!from || !to) throw new Error('skipped: no coordinates from Nominatim');
    const { routes } = await routing.getRoutes(from, to);
    return `${routes.length} route(s): ` + routes.map((r) => `${r.distanceKm.toFixed(1)} km / ${Math.round(r.baseMinutes)} min / ${r.geometry.length} pts / via ${r.via || 'n/a'}`).join(' | ');
  });

  let routeSet = [];
  await check(`OSRM routes for the Overpass checks`, async () => {
    if (!from || !to) throw new Error('skipped: no coordinates from Nominatim');
    routeSet = (await routing.getRoutes(from, to)).routes;
    return `${routeSet.length} route(s)`;
  });

  await check(`Overpass road tags (${config.overpass.urls.length} endpoint(s), first ${safeUrl(config.overpass.urls[0])})`, async () => {
    if (!routeSet.length) throw new Error('skipped: no routes');
    const r = await roadQuality.assessRoads(routeSet);
    if (!r.perRoute[0].coverage && !r.available && /could not be (reached|interpreted)/.test(r.reason || '')) throw new Error(r.reason);
    return r.perRoute.map((q, i) => `Route ${String.fromCharCode(65 + i)}: documented surface/smoothness on ${Math.round((q.coverage || 0) * 100)}% of sampled length${q.available ? `, road data score ${q.score}` : ' (not enough to rank on)'}`).join(' | ');
  });

  await check(`Overpass scenery POIs (${config.overpass.urls.length} endpoint(s), first ${safeUrl(config.overpass.urls[0])})`, async () => {
    if (!routeSet.length) throw new Error('skipped: no routes');
    const r = await scenery.assessScenery(routeSet);
    if (!r.available) throw new Error(r.reason);
    return r.perRoute.map((p, i) => `Route ${String.fromCharCode(65 + i)}: ${p.totalPois} nature-related POIs, score ${p.score}${p.approximate ? ' (approximate areas)' : ''}`).join(' | ');
  });

  await check(`Python ML service (${safeUrl(config.mlServiceUrl)})`, async () => {
    const h = await ml.health();
    if (h !== 'connected') throw new Error(`health = ${h} (is the ML service running and the model trained?)`);
    const p = await ml.predictSingle({ hour: 18, day_of_week: 4, weekend: false, distance: 150, rain: true });
    return `RandomForest says ${p.traffic_level} (confidence ${p.confidence})`;
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} services verified.`);
  if (failed.length) console.log('Not verified: ' + failed.map((f) => f.name).join('; '));
  await mongoose.disconnect().catch(() => {});
  process.exit(failed.length ? 1 : 0);
})();
