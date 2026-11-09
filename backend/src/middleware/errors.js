const db = require('../services/db');
const { AppError } = require('../utils');
const { error: logError } = require('../log');

function requireDb(_req, _res, next) {
  if (!db.isReady()) throw new AppError(503, 'Database unavailable. Please try again shortly.', 'DB_UNAVAILABLE');
  next();
}

function notFound(_req, _res, next) { next(new AppError(404, 'Endpoint not found.', 'NOT_FOUND')); }

// Central error handler: friendly messages, never leaks stack traces or secrets.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, _req, res, _next) {
  if (err.type === 'entity.parse.failed') err = new AppError(400, 'Invalid JSON body.', 'BAD_JSON');
  if (err.type === 'entity.too.large') err = new AppError(413, 'Request body too large.', 'TOO_LARGE');
  if (err.name === 'ValidationError') err = new AppError(400, 'Invalid input: ' + Object.values(err.errors).map((e) => e.message).join('; '), 'VALIDATION');
  if (err.name === 'CastError') err = new AppError(400, 'Invalid identifier.', 'BAD_ID');
  if (err.code === 11000) err = new AppError(409, 'That email is already registered.', 'DUPLICATE');
  const status = err.expose ? err.status : 500;
  if (!err.expose) logError('ERROR', err.stack || String(err)); // unexpected errors only; redacted by the logger
  res.status(status).json({
    error: { code: err.expose ? err.code : 'INTERNAL', message: err.expose ? err.message : 'Something went wrong on our side. Please try again.' },
  });
}

module.exports = { requireDb, notFound, errorHandler };
