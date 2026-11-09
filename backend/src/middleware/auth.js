const jwt = require('jsonwebtoken');
const config = require('../config');
const { AppError } = require('../utils');

const signToken = (user) => jwt.sign({ sub: String(user._id || user.id) }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

function readToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

/** Requires a valid JWT; sets req.userId. */
function requireAuth(req, _res, next) {
  const token = readToken(req);
  if (!token) throw new AppError(401, 'Please log in to continue.', 'UNAUTHENTICATED');
  try {
    req.userId = jwt.verify(token, config.jwtSecret).sub;
    next();
  } catch {
    throw new AppError(401, 'Your session has expired. Please log in again.', 'INVALID_TOKEN');
  }
}

/** Sets req.userId if a valid token is present, otherwise continues anonymously. */
function optionalAuth(req, _res, next) {
  const token = readToken(req);
  if (token) {
    try { req.userId = jwt.verify(token, config.jwtSecret).sub; } catch { /* ignore bad token */ }
  }
  next();
}

module.exports = { signToken, requireAuth, optionalAuth };
