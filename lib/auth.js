// Auth backed by SQLite (see lib/db.js): registration, login/sessions, and
// password reset. Passwords are salted+hashed with scrypt; sessions and
// reset tokens are opaque random tokens stored as rows so they survive a
// server restart. A real app would still want to expire/rotate sessions and
// send actual reset emails instead of returning the token to the client.

const crypto = require('crypto');
const db = require('./db');

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const candidate = hashPassword(password, salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(row) {
  return { username: row.username, email: row.email, createdAt: row.createdAt };
}

// Usernames/emails are matched case-insensitively but stored as typed.
function findUserByUsernameCI(username) {
  return db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username || '');
}
function findUserByEmailCI(email) {
  return db.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').get(email || '');
}

function register({ username, email, password }) {
  username = (username || '').trim();
  email = (email || '').trim();

  if (!USERNAME_RE.test(username)) {
    throw badRequest('Username must be 3-20 characters: letters, numbers, or underscores.');
  }
  if (!EMAIL_RE.test(email)) {
    throw badRequest('Please enter a valid email address.');
  }
  if (!password || password.length < 8) {
    throw badRequest('Password must be at least 8 characters.');
  }
  if (findUserByUsernameCI(username)) {
    throw badRequest('That username is already taken.');
  }
  if (findUserByEmailCI(email)) {
    throw badRequest('An account with that email already exists.');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const createdAt = new Date().toISOString();

  db.prepare('INSERT INTO users (username, email, salt, hash, createdAt) VALUES (?, ?, ?, ?, ?)').run(
    username, email, salt, hash, createdAt
  );

  return { username, email, createdAt };
}

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, createdAt) VALUES (?, ?, ?)').run(token, username, Date.now());
  return token;
}

function login({ username, password }) {
  const user = findUserByUsernameCI((username || '').trim());
  if (!user || !verifyPassword(password || '', user.salt, user.hash)) {
    const err = new Error('Incorrect username or password.');
    err.status = 401;
    throw err;
  }
  const token = createSession(user.username);
  return { token, user: publicUser(user) };
}

function logout(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** Returns the username for a valid session token, or null. */
function getUsernameForToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT username FROM sessions WHERE token = ?').get(token);
  return row ? row.username : null;
}

function getUser(username) {
  const user = findUserByUsernameCI(username);
  return user ? publicUser(user) : null;
}

/**
 * Kicks off a password reset. Always returns a generic { ok: true } shape so
 * callers can't use this to enumerate which emails/usernames have accounts.
 * In a real app the reset link would be emailed; here (no email service) we
 * return it directly in `devResetToken` when the account exists, clearly
 * marked as a local-dev convenience — never do this in production.
 */
function requestPasswordReset({ usernameOrEmail }) {
  const key = (usernameOrEmail || '').trim();
  const user = findUserByUsernameCI(key) || findUserByEmailCI(key);

  if (!user) {
    return { ok: true, devResetToken: null };
  }

  const token = crypto.randomBytes(20).toString('hex');
  db.prepare('INSERT INTO reset_tokens (token, username, expiresAt) VALUES (?, ?, ?)').run(
    token, user.username, Date.now() + RESET_TOKEN_TTL_MS
  );
  console.log(`[auth] password reset requested for "${user.username}" — dev token: ${token}`);

  return { ok: true, devResetToken: token };
}

function resetPassword({ token, newPassword }) {
  const entry = db.prepare('SELECT * FROM reset_tokens WHERE token = ?').get(token);
  if (!entry || entry.expiresAt < Date.now()) {
    throw badRequest('That reset link is invalid or has expired. Please request a new one.');
  }
  if (!newPassword || newPassword.length < 8) {
    throw badRequest('Password must be at least 8 characters.');
  }

  const user = findUserByUsernameCI(entry.username);
  if (!user) throw badRequest('Account no longer exists.');

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  db.prepare('UPDATE users SET salt = ?, hash = ? WHERE username = ?').run(salt, hash, user.username);
  db.prepare('DELETE FROM reset_tokens WHERE token = ?').run(token);

  return { ok: true };
}

// Seed demo accounts so the chat/order examples work out of the box.
// No-op if they already exist (e.g. on every subsequent server start).
// Passwords are here in plaintext only because these are throwaway demo
// accounts seeded into a local SQLite file — never do this for real accounts.
const SEED_ACCOUNTS = [
  { username: 'demo', email: 'demo@bookly.example', password: 'password123' },   // owns BK-10234, BK-10500
  { username: 'alice', email: 'alice@bookly.example', password: 'alicepass123' }, // owns BK-10777, BK-20001
  { username: 'bob', email: 'bob@bookly.example', password: 'bobpass123' },       // owns BK-10042, BK-20002
];
for (const account of SEED_ACCOUNTS) {
  if (!findUserByUsernameCI(account.username)) {
    try {
      register(account);
    } catch (err) {
      // race/already exists — ignore.
    }
  }
}

module.exports = {
  register,
  login,
  logout,
  getUsernameForToken,
  getUser,
  requestPasswordReset,
  resetPassword,
};
