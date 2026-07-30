// Persistent storage for Bookly, backed by SQLite via Node's built-in
// node:sqlite module (DatabaseSync) — no external/native dependency to
// install. Requires Node 22.5+ (uses an experimental core module; you'll see
// a one-line "SQLite is an experimental feature" warning on startup, which
// is expected and harmless).
//
// The database file lives at data/bookly.db by default (created on first
// run) so orders, accounts, sessions, and reset tokens now survive a server
// restart. Override the location with the SQLITE_PATH env var (e.g. ":memory:"
// for a throwaway in-memory DB, handy for tests).

const path = require('path');
const fs = require('fs');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  console.error(
    '\nBookly needs the built-in node:sqlite module, which requires Node.js 22.5 or newer.\n' +
    `You're running ${process.version}. Please upgrade Node (e.g. via nvm: "nvm install 22 && nvm use 22") and try again.\n`
  );
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = process.env.SQLITE_PATH || path.join(DATA_DIR, 'bookly.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS orders (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL,
    items          TEXT NOT NULL,   -- JSON array of { title, qty, price }
    total          REAL NOT NULL,
    status         TEXT NOT NULL,
    carrier        TEXT,
    trackingNumber TEXT,
    orderDate      TEXT,
    shippedDate    TEXT,
    deliveredDate  TEXT,
    eta            TEXT,
    refundedDate   TEXT
  );

  CREATE TABLE IF NOT EXISTS faq (
    topic  TEXT PRIMARY KEY,
    answer TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    username  TEXT PRIMARY KEY,
    email     TEXT NOT NULL UNIQUE,
    salt      TEXT NOT NULL,
    hash      TEXT NOT NULL,
    createdAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token     TEXT PRIMARY KEY,
    username  TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reset_tokens (
    token     TEXT PRIMARY KEY,
    username  TEXT NOT NULL,
    expiresAt INTEGER NOT NULL
  );
`);

// Migration for DBs created before refundedDate existed (ALTER TABLE ADD
// COLUMN is safe/idempotent to guard like this — CREATE TABLE IF NOT EXISTS
// above doesn't retroactively add columns to an already-existing table).
const orderColumns = db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
if (!orderColumns.includes('refundedDate')) {
  db.exec('ALTER TABLE orders ADD COLUMN refundedDate TEXT');
}

module.exports = db;
