// URL -> controller wiring.
const express = require('express');
const rateLimit = require('express-rate-limit');
const c = require('../controllers');
const { requireAuth, optionalAuth, requireDb } = require('../middleware');

const limiter = (windowMs, max) => rateLimit({
  windowMs, limit: max, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Please slow down.' } },
});
const passThrough = (_q, _s, n) => n();

function createRouter() {
  const isTest = process.env.NODE_ENV === 'test';
  const authLimiter = isTest ? passThrough : limiter(15 * 60 * 1000, 50);
  const searchLimiter = isTest ? passThrough : limiter(60 * 1000, 20);
  const r = express.Router();

  r.get('/health', c.health);
  r.get('/diagnostics', c.diag);

  r.post('/auth/register', authLimiter, requireDb, c.register);
  r.post('/auth/login', authLimiter, requireDb, c.login);
  r.get('/auth/me', requireAuth, requireDb, c.me);
  r.put('/auth/preferences', requireAuth, requireDb, c.updatePreferences);

  // Route search works without a DB (anonymous); with a login it is personalised.
  r.post('/routes/search', searchLimiter, optionalAuth, c.searchRoutes);
  r.get('/locations/search', searchLimiter, c.searchLocations);

  r.post('/ml/predict', searchLimiter, c.mlPredict);
  r.get('/ml/info', c.mlInfo);

  r.post('/trips', requireAuth, requireDb, c.createTrip);
  r.get('/trips', requireAuth, requireDb, c.listTrips);
  r.get('/trips/:id', requireAuth, requireDb, c.getTrip);
  r.delete('/trips/:id', requireAuth, requireDb, c.deleteTrip);
  return r;
}

module.exports = { createRouter };
