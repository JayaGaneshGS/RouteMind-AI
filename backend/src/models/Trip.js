const mongoose = require('mongoose');
const { PREFERENCES } = require('./constants');
const { Schema } = mongoose;

const placeSchema = new Schema({ name: String, lat: Number, lon: Number }, { _id: false });

const tripSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  origin: { type: placeSchema, required: true },
  destination: { type: placeSchema, required: true },
  date: { type: String, required: true }, // travel date YYYY-MM-DD
  time: { type: String, default: '' },
  preference: { type: String, enum: PREFERENCES, required: true },
  selectedRoute: { type: Schema.Types.Mixed, required: true }, // label, geometry (simplified), cost, etc.
  distance: { type: Number, required: true }, // km
  estimatedTime: { type: Number, required: true }, // minutes
  trafficLevel: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], required: true },
  routeScore: { type: Number, required: true },
  explanation: { type: String, default: '', maxlength: 2000 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Trip || mongoose.model('Trip', tripSchema);
