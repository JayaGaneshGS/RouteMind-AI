const mongoose = require('mongoose');
const { PREFERENCES } = require('./constants');
const { Schema } = mongoose;

const userSchema = new Schema({
  name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
  passwordHash: { type: String, required: true }, // bcrypt hash - never the plain password
  preferences: {
    preferredMode: { type: String, enum: PREFERENCES, default: 'BALANCED' },
    notes: { type: String, maxlength: 300, default: '' }, // free-text travel preferences
  },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
