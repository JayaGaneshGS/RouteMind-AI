const config = require('./config');
const { createApp } = require('./app');
const db = require('./services/db');
const { log, error, safeUrl } = require('./log');

// Fail fast on unusable configuration (missing/placeholder MONGO_URI) - no silent in-memory fallback.
const problem = db.validateUri();
if (problem) { error('DATABASE', problem); process.exit(1); }

const app = createApp();
db.connect(); // non-blocking: on a network failure it keeps retrying; DB routes answer 503 meanwhile
const server = app.listen(config.port, () => {
  log('SERVER', `RouteMind API listening on :${config.port}`);
  log('CONFIG', `Geocoding: Nominatim ${safeUrl(config.geocodeUrl)} (User-Agent: ${config.geocodeUserAgent}) | Routing: OSRM ${safeUrl(config.osrmUrl)}`);
  log('CONFIG', `ML service: ${safeUrl(config.mlServiceUrl)} | AI: ${config.ai.apiKey ? 'LLM configured' : 'rule-based (no AI_API_KEY)'} | MongoDB database: ${config.mongoDbName}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
