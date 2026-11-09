// In-memory stand-in for the two Mongoose models. Used by tests (and scripts/dev-memory-db.js) when no
// MongoDB server is available. Documents still go through REAL Mongoose schema validation.
// In CI a real MongoDB service container is used instead (see .github/workflows/ci.yml).
const mongoose = require('mongoose');
const { User, Trip } = require('../../src/models');

const store = { users: [], trips: [] };

function query(getValue) {
  const q = {
    _sort: null, _limit: null,
    sort(s) { q._sort = s; return q; }, limit(n) { q._limit = n; return q; }, select() { return q; },
    lean() { q._lean = true; return q; },
    then(res, rej) {
      let v = getValue();
      if (Array.isArray(v)) {
        if (q._sort) { const [k, d] = Object.entries(q._sort)[0]; v = [...v].sort((a, b) => (a[k] > b[k] ? d : -d)); }
        if (q._limit) v = v.slice(0, q._limit);
      }
      return Promise.resolve(q._lean ? plain(v) : hydrate(v)).then(res, rej);
    },
  };
  return q;
}
const plain = (v) => (Array.isArray(v) ? v.map((x) => ({ ...x })) : v ? { ...v } : null);

function hydrate(v) {
  if (Array.isArray(v)) return v.map(hydrate);
  if (!v) return null;
  const isUser = 'passwordHash' in v;
  const doc = (isUser ? User : Trip).hydrate({ ...v });
  if (isUser) doc.save = async () => { await doc.validate(); const i = store.users.findIndex((u) => String(u._id) === String(doc._id)); store.users[i] = doc.toObject(); return doc; };
  return doc;
}

const matches = (obj, filter) => Object.entries(filter).every(([k, v]) => String(obj[k]) === String(v));

function install() {
  User.findOne = (f) => query(() => store.users.find((u) => matches(u, f)) || null);
  User.findById = (id) => query(() => store.users.find((u) => String(u._id) === String(id)) || null);
  User.create = async (data) => {
    const doc = new User(data); await doc.validate();
    if (store.users.some((u) => u.email === doc.email)) { const e = new Error('dup'); e.code = 11000; throw e; }
    store.users.push(doc.toObject()); return hydrate(doc.toObject());
  };
  Trip.create = async (data) => { const doc = new Trip(data); await doc.validate(); store.trips.push(doc.toObject()); return doc.toObject(); };
  Trip.find = (f) => query(() => store.trips.filter((t) => matches(t, f)));
  Trip.findOne = (f) => query(() => store.trips.find((t) => matches(t, f)) || null);
  Trip.deleteOne = async (f) => { const i = store.trips.findIndex((t) => matches(t, f)); if (i >= 0) store.trips.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; };
}
const reset = () => { store.users.length = 0; store.trips.length = 0; };

module.exports = { install, reset, store, mongoose };
