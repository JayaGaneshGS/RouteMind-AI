const bcrypt = require('bcryptjs');
const { User, PREFERENCES } = require('../models');
const { signToken } = require('../middleware/auth');
const { AppError } = require('../utils');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const publicUser = (u) => ({ id: String(u._id), name: u.name, email: u.email, preferences: u.preferences, createdAt: u.createdAt });
const str = (v) => (typeof v === 'string' ? v.trim() : '');

async function register(req, res) {
  const name = str(req.body?.name);
  const email = str(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (name.length < 2 || name.length > 80) throw new AppError(400, 'Please enter your name (2-80 characters).', 'VALIDATION');
  if (!EMAIL_RE.test(email)) throw new AppError(400, 'Please enter a valid email address.', 'VALIDATION');
  if (password.length < 8 || password.length > 72) throw new AppError(400, 'Password must be 8-72 characters long.', 'VALIDATION');
  if (await User.findOne({ email })) throw new AppError(409, 'That email is already registered.', 'DUPLICATE');
  const passwordHash = await bcrypt.hash(password, 10); // never store the plain password
  const user = await User.create({ name, email, passwordHash });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}

async function login(req, res) {
  const email = str(req.body?.email).toLowerCase();
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password) throw new AppError(400, 'Email and password are required.', 'VALIDATION');
  const user = await User.findOne({ email });
  // Same message for unknown email / wrong password (no account enumeration).
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw new AppError(401, 'Incorrect email or password.', 'BAD_CREDENTIALS');
  res.json({ token: signToken(user), user: publicUser(user) });
}

async function me(req, res) {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError(401, 'Account not found. Please log in again.', 'INVALID_TOKEN');
  res.json({ user: publicUser(user) });
}

async function updatePreferences(req, res) {
  const user = await User.findById(req.userId);
  if (!user) throw new AppError(401, 'Account not found.', 'INVALID_TOKEN');
  const { preferredMode, notes } = req.body || {};
  if (preferredMode !== undefined) {
    if (!PREFERENCES.includes(preferredMode)) throw new AppError(400, 'Invalid preferred mode.', 'VALIDATION');
    user.preferences.preferredMode = preferredMode;
  }
  if (notes !== undefined) {
    if (typeof notes !== 'string' || notes.length > 300) throw new AppError(400, 'Notes must be text up to 300 characters.', 'VALIDATION');
    user.preferences.notes = notes.trim();
  }
  await user.save();
  res.json({ user: publicUser(user) });
}

module.exports = { register, login, me, updatePreferences };
