// MongoDB Atlas connection (via Mongoose). The credentials come ONLY from MONGO_URI and are never logged.
// There is NO silent in-memory fallback: if Atlas is unreachable, DB routes answer 503 "Database unavailable".
const mongoose = require('mongoose');
const config = require('../config');
const { log, error, redact } = require('../log');

const RETRY_MS = 10000;
const HINT = 'Unable to connect to MongoDB Atlas. Check MONGO_URI and Atlas Network Access settings.';
let readyOverride = null; // tests can force a state
let retryTimer = null;

const isReady = () => (readyOverride !== null ? readyOverride : mongoose.connection.readyState === 1);

/** Returns an error string if MONGO_URI is unusable, else null. Never includes the URI itself. */
function validateUri() {
  const uri = config.mongoUri;
  if (!uri) return 'MONGO_URI is not set. Copy .env.example to .env and put your MongoDB Atlas connection string in it.';
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) return 'MONGO_URI must start with mongodb:// or mongodb+srv://.';
  if (/YOUR_ACTUAL_PASSWORD|<password>|<db_password>/i.test(uri)) return 'MONGO_URI still contains the placeholder password. Put your real Atlas database-user password into your local .env file.';
  return null;
}

async function connect() {
  const problem = validateUri();
  if (problem) { error('DATABASE', problem); return false; } // no retry loop: configuration must be fixed first
  try {
    await mongoose.connect(config.mongoUri, { dbName: config.mongoDbName, serverSelectionTimeoutMS: 10000 });
    log('DATABASE', 'MongoDB connected successfully');
    return true;
  } catch (err) {
    // err.message is redacted: it must not leak the URI or password.
    error('DATABASE', `${HINT} (${err.name}: ${redact(err.message).split('\n')[0].slice(0, 160)}) - retrying in ${RETRY_MS / 1000}s`);
    retryTimer = setTimeout(connect, RETRY_MS);
    retryTimer.unref();
    return false;
  }
}

mongoose.connection.on('disconnected', () => error('DATABASE', 'MongoDB disconnected'));
mongoose.connection.on('reconnected', () => log('DATABASE', 'MongoDB reconnected'));

module.exports = { connect, isReady, validateUri, HINT, setReadyOverride: (v) => { readyOverride = v; } };
