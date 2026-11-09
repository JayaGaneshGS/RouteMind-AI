const mongoose = require('mongoose');
const { Trip, PREFERENCES } = require('../models');
const { AppError, decimate } = require('../utils');

const placeOf = (p, label) => {
  if (!p || typeof p.name !== 'string' || !Number.isFinite(Number(p.lat)) || !Number.isFinite(Number(p.lon))) throw new AppError(400, `Invalid ${label}.`, 'VALIDATION');
  return { name: p.name.slice(0, 200), lat: Number(p.lat), lon: Number(p.lon) };
};

// Numbers are clamped to the range the app itself can produce, so a crafted request cannot store absurd values.
const rnd = (x, d = 3, lo = 0, hi = 1) => (Number.isFinite(Number(x)) ? Math.round(Math.min(hi, Math.max(lo, Number(x))) * 10 ** d) / 10 ** d : null);
const shortText = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');

/**
 * Optional OpenStreetMap-derived facts saved with a trip. They are stored as a labelled SNAPSHOT (source + retrieval
 * time), never as permanent facts about the road: map tags change and these are not measurements of road condition.
 * Only the fields the app itself produced are kept; anything else in the request is ignored.
 */
function roadSnapshot(q, now) {
  if (!q || typeof q !== 'object') return undefined;
  if (q.available !== true) return { available: false, snapshotAt: now, note: 'Road quality data was unavailable when this trip was saved.' };
  return {
    available: true, score: rnd(q.score, 1, 0, 100), coverage: rnd(q.coverage), pavedShare: rnd(q.pavedShare), unpavedShare: rnd(q.unpavedShare), unknownShare: rnd(q.unknownShare),
    source: shortText(q.source, 80), snapshotAt: now,
    note: 'Snapshot of documented OpenStreetMap surface/smoothness tags when saved - not a measurement of current road condition.',
  };
}
function scenerySnapshot(sc, now) {
  if (!sc || typeof sc !== 'object') return undefined;
  if (sc.available !== true) return { available: false, snapshotAt: now, note: 'Scenery information was unavailable when this trip was saved.' };
  return {
    available: true, score: rnd(sc.score, 1, 0, 100), totalPois: rnd(sc.totalPois, 0, 0, 10000),
    topPois: (Array.isArray(sc.pois) ? sc.pois.filter((p) => p && p.counted).slice(0, 5) : []).map((p) => ({ name: shortText(p.name, 120), categoryLabel: shortText(p.categoryLabel, 60), osmUrl: shortText(p.osmUrl, 120) })),
    source: shortText(sc.source, 80), snapshotAt: now,
    note: 'Snapshot of nature-related POIs mapped in OpenStreetMap when saved - not an official scenic rating.',
  };
}

async function createTrip(req, res) {
  const b = req.body || {};
  const r = b.selectedRoute;
  if (!r || !Number.isFinite(Number(r.distanceKm)) || !Number.isFinite(Number(r.durationMinutes)) || !['LOW', 'MEDIUM', 'HIGH'].includes(r.traffic?.level) || !Number.isFinite(Number(r.score)))
    throw new AppError(400, 'A valid selected route is required.', 'VALIDATION');
  if (!PREFERENCES.includes(b.preference)) throw new AppError(400, 'Invalid preference.', 'VALIDATION');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) throw new AppError(400, 'Invalid date.', 'VALIDATION');
  const now = new Date().toISOString();
  const road = roadSnapshot(r.roadQuality, now);
  const scenery = scenerySnapshot(r.scenery, now);
  const trip = await Trip.create({
    userId: req.userId, origin: placeOf(b.origin, 'origin'), destination: placeOf(b.destination, 'destination'),
    date: b.date, time: typeof b.time === 'string' ? b.time.slice(0, 5) : '', preference: b.preference,
    selectedRoute: {
      label: String(r.label || '').slice(0, 20), cost: Number(r.cost) || 0, routeType: r.routeType,
      traffic: { level: r.traffic.level, confidence: Number(r.traffic.confidence) || 0 },
      geometry: Array.isArray(r.geometry) ? decimate(r.geometry, 200) : [],
      via: typeof r.via === 'string' ? r.via.slice(0, 200) : '',
      ...(road ? { roadQuality: road } : {}),
      ...(scenery ? { scenery } : {}),
    },
    distance: Number(r.distanceKm), estimatedTime: Number(r.durationMinutes), trafficLevel: r.traffic.level,
    routeScore: Number(r.score), explanation: typeof b.explanation === 'string' ? b.explanation.slice(0, 2000) : '',
  });
  res.status(201).json({ trip });
}

async function listTrips(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
  const trips = await Trip.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(limit).lean();
  res.json({ trips });
}

const checkId = (id) => { if (!mongoose.isValidObjectId(id)) throw new AppError(400, 'Invalid trip id.', 'BAD_ID'); };

async function getTrip(req, res) {
  checkId(req.params.id);
  const trip = await Trip.findOne({ _id: req.params.id, userId: req.userId }).lean(); // scoped to owner
  if (!trip) throw new AppError(404, 'Trip not found.', 'NOT_FOUND');
  res.json({ trip });
}

async function deleteTrip(req, res) {
  checkId(req.params.id);
  const r = await Trip.deleteOne({ _id: req.params.id, userId: req.userId });
  if (!r.deletedCount) throw new AppError(404, 'Trip not found.', 'NOT_FOUND');
  res.json({ ok: true });
}

module.exports = { createTrip, listTrips, getTrip, deleteTrip };
