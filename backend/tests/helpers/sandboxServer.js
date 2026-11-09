// ⚠ MOCK MODE - FOR OFFLINE UI CHECKS ONLY. NOT FOR THE COLLEGE DEMO. ⚠
// Starts the real API wired to local stand-ins for Nominatim/OSRM and an in-memory MongoDB stand-in.
// Everything it returns is fake. The normal app (`npm start` / docker compose) never uses any of this.
// The ML service is still the REAL FastAPI app (start it separately).
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'sandbox-only-secret';
process.env.EXTERNAL_MIN_INTERVAL_MS = '0';
process.env.OVERPASS_MIN_INTERVAL_MS = '0';
process.env.OVERPASS_BACKOFF_MS = '0';
const mock = require('./mockServices');
const fakeDb = require('./fakeDb');

(async () => {
  const svc = await mock.start();
  process.env.GEOCODE_URL = `${svc.base}/search`;
  process.env.OSRM_URL = svc.base;
  process.env.OVERPASS_URL = `${svc.base}/api/interpreter`;
  fakeDb.install();
  require('../../src/services/db').setReadyOverride(true);
  const config = require('../../src/config');
  require('../../src/app').createApp().listen(config.port, () => {
    console.warn('\n*** MOCK MODE: fake geocoding, fake routes, in-memory database. NOT REAL SERVICES. ***\n');
    console.log(`[sandbox] API on :${config.port}, mocks on ${svc.base}`);
  });
})();
