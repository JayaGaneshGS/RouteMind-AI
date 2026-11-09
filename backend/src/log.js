// Tiny tagged logger + secret redaction. Logs show WHICH real service was used ("[ROUTING] Provider: OSRM")
// but never credentials: MONGO_URI, its password, JWT secret and the AI key are always masked.
const config = require('./config');

function secrets() {
  const list = [config.jwtSecret, config.ai.apiKey];
  if (config.mongoUri) {
    list.push(config.mongoUri);
    const m = config.mongoUri.match(/^[a-z+]+:\/\/[^:@/]+:([^@]+)@/i); // password part of the URI
    if (m) { list.push(m[1]); try { list.push(decodeURIComponent(m[1])); } catch { /* ignore */ } }
  }
  return list.filter((x) => x && x.length >= 4);
}

/** Mask any secret that may have slipped into a string (e.g. an error message). */
function redact(text) {
  let out = String(text);
  for (const s of secrets()) out = out.split(s).join('***');
  return out.replace(/(mongodb(?:\+srv)?:\/\/)[^\s'"]+/gi, '$1***'); // any other Mongo URI shape
}

/** URL without credentials/query, safe to print. */
function safeUrl(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname === '/' ? '' : x.pathname}`; } catch { return '(invalid URL)'; }
}

const quiet = () => process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TEST;
const log = (tag, msg) => { if (!quiet()) console.log(`[${tag}] ${redact(msg)}`); };
const warn = (tag, msg) => { if (!quiet()) console.warn(`[${tag}] ${redact(msg)}`); };
const error = (tag, msg) => { if (!quiet()) console.error(`[${tag}] ${redact(msg)}`); };

module.exports = { log, warn, error, redact, safeUrl };
