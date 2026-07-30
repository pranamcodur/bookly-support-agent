// Order store backed by SQLite (see lib/db.js). Backs the sample-order
// REST API and order lookups. Every write here is immediately visible to
// lib/tools.js's queries too, since both go through the same database file.

require('./mockData'); // ensures the DB is seeded before first use
const db = require('./db');
const { ORDER_STATUSES } = require('./mockData');

const DELIVERED_LIKE_STATUSES = ['Delivered', 'Refunded']; // Refunded implies it was delivered first

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    items: JSON.parse(row.items),
    total: row.total,
    status: row.status,
    carrier: row.carrier,
    trackingNumber: row.trackingNumber,
    orderDate: row.orderDate,
    shippedDate: row.shippedDate,
    deliveredDate: row.deliveredDate,
    eta: row.eta,
    refundedDate: row.refundedDate,
  };
}

function nextOrderId() {
  const exists = db.prepare('SELECT 1 FROM orders WHERE id = ?');
  let id;
  do {
    const n = Math.floor(10000 + Math.random() * 90000);
    id = `BK-${n}`;
  } while (exists.get(id));
  return id;
}

function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/**
 * Create a sample order for testing/demo purposes.
 * Required: username, status (one of ORDER_STATUSES).
 * Optional: items (defaults to a single sample book), carrier, trackingNumber,
 * orderDate, shippedDate, deliveredDate, eta, refundedDate.
 * Throws { status: 400, message } style errors for invalid input.
 */
function createOrder(input = {}) {
  const { username, status } = input;

  if (!username || typeof username !== 'string' || !username.trim()) {
    const err = new Error('username is required');
    err.status = 400;
    throw err;
  }
  if (!status || !ORDER_STATUSES.includes(status)) {
    const err = new Error(`status must be one of: ${ORDER_STATUSES.join(', ')}`);
    err.status = 400;
    throw err;
  }

  let items = input.items;
  if (!Array.isArray(items) || items.length === 0) {
    items = [{ title: 'Sample Book', qty: 1, price: 12.99 }];
  }
  for (const item of items) {
    if (!item.title || typeof item.qty !== 'number' || typeof item.price !== 'number') {
      const err = new Error('each item needs a title (string), qty (number), and price (number)');
      err.status = 400;
      throw err;
    }
  }

  for (const dateField of ['orderDate', 'shippedDate', 'deliveredDate', 'eta', 'refundedDate']) {
    if (input[dateField] != null && !isValidDateStr(input[dateField])) {
      const err = new Error(`${dateField} must be an ISO date string like "2026-07-29"`);
      err.status = 400;
      throw err;
    }
  }

  const total = items.reduce((sum, item) => sum + item.qty * item.price, 0);
  const today = new Date().toISOString().slice(0, 10);
  const deliveredLike = DELIVERED_LIKE_STATUSES.includes(status);

  const order = {
    id: nextOrderId(),
    username: username.trim(),
    items,
    total: Math.round(total * 100) / 100,
    status,
    carrier: input.carrier ?? (status === 'Processing' ? null : 'UPS'),
    trackingNumber: input.trackingNumber ?? (status === 'Processing' ? null : `TRK${Math.floor(1e11 + Math.random() * 8e11)}`),
    orderDate: input.orderDate ?? today,
    shippedDate: input.shippedDate ?? (status === 'Processing' ? null : today),
    deliveredDate: input.deliveredDate ?? (deliveredLike ? today : null),
    eta: input.eta ?? (deliveredLike ? null : today),
    refundedDate: input.refundedDate ?? (status === 'Refunded' ? today : null),
  };

  db.prepare(`
    INSERT INTO orders (id, username, items, total, status, carrier, trackingNumber, orderDate, shippedDate, deliveredDate, eta, refundedDate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id, order.username, JSON.stringify(order.items), order.total, order.status,
    order.carrier, order.trackingNumber, order.orderDate, order.shippedDate, order.deliveredDate,
    order.eta, order.refundedDate
  );

  return order;
}

function listOrders({ username } = {}) {
  const rows = username
    ? db.prepare('SELECT * FROM orders WHERE username = ?').all(username)
    : db.prepare('SELECT * FROM orders').all();
  return rows.map(rowToOrder);
}

function getOrder(id) {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  return rowToOrder(row);
}

/**
 * Mark an order as refunded: flips status -> 'Refunded', clears any pending
 * eta (nothing left to ship/arrive), and records when the refund happened.
 * This is the piece that was previously missing — processRefund used to
 * generate a refund receipt without ever updating the order's actual status.
 */
function markRefunded(orderId, refundedDate) {
  db.prepare("UPDATE orders SET status = 'Refunded', eta = NULL, refundedDate = ? WHERE id = ?").run(refundedDate, orderId);
  return getOrder(orderId);
}

const UPDATABLE_FIELDS = [
  'username', 'items', 'status', 'carrier', 'trackingNumber',
  'orderDate', 'shippedDate', 'deliveredDate', 'eta', 'refundedDate',
];

/**
 * Update an existing order. Partial update — only fields present in
 * `updates` are changed; anything omitted keeps its current value. Same
 * validation rules as createOrder for whichever fields are supplied.
 * Throws { status: 404 } if the order doesn't exist, { status: 400 } for
 * invalid field values.
 */
function updateOrder(id, updates = {}) {
  const existing = getOrder(id);
  if (!existing) {
    const err = new Error(`No order with id "${id}".`);
    err.status = 404;
    throw err;
  }

  const unknownFields = Object.keys(updates).filter((k) => !UPDATABLE_FIELDS.includes(k));
  if (unknownFields.length > 0) {
    const err = new Error(`Unknown field(s): ${unknownFields.join(', ')}. Updatable fields: ${UPDATABLE_FIELDS.join(', ')}.`);
    err.status = 400;
    throw err;
  }

  for (const requiredField of ['username', 'status', 'items']) {
    if (requiredField in updates && updates[requiredField] === null) {
      const err = new Error(`${requiredField} can't be cleared (set to null) — it's required.`);
      err.status = 400;
      throw err;
    }
  }

  if (updates.username != null && (typeof updates.username !== 'string' || !updates.username.trim())) {
    const err = new Error('username must be a non-empty string');
    err.status = 400;
    throw err;
  }
  if (updates.username) updates.username = updates.username.trim();
  if (updates.status != null && !ORDER_STATUSES.includes(updates.status)) {
    const err = new Error(`status must be one of: ${ORDER_STATUSES.join(', ')}`);
    err.status = 400;
    throw err;
  }
  if (updates.items != null) {
    if (!Array.isArray(updates.items) || updates.items.length === 0) {
      const err = new Error('items must be a non-empty array');
      err.status = 400;
      throw err;
    }
    for (const item of updates.items) {
      if (!item.title || typeof item.qty !== 'number' || typeof item.price !== 'number') {
        const err = new Error('each item needs a title (string), qty (number), and price (number)');
        err.status = 400;
        throw err;
      }
    }
  }
  for (const dateField of ['orderDate', 'shippedDate', 'deliveredDate', 'eta', 'refundedDate']) {
    if (updates[dateField] != null && !isValidDateStr(updates[dateField])) {
      const err = new Error(`${dateField} must be an ISO date string like "2026-07-29", or null to clear it`);
      err.status = 400;
      throw err;
    }
  }

  const merged = { ...existing, ...updates };
  if (updates.items) {
    merged.total = Math.round(updates.items.reduce((sum, item) => sum + item.qty * item.price, 0) * 100) / 100;
  }
  // Convenience default: flipping status to Refunded without also setting a
  // refundedDate fills in today's date, mirroring createOrder's behavior.
  if (updates.status === 'Refunded' && updates.refundedDate === undefined && !existing.refundedDate) {
    merged.refundedDate = new Date().toISOString().slice(0, 10);
  }

  db.prepare(`
    UPDATE orders SET
      username = ?, items = ?, total = ?, status = ?, carrier = ?, trackingNumber = ?,
      orderDate = ?, shippedDate = ?, deliveredDate = ?, eta = ?, refundedDate = ?
    WHERE id = ?
  `).run(
    merged.username, JSON.stringify(merged.items), merged.total, merged.status, merged.carrier, merged.trackingNumber,
    merged.orderDate, merged.shippedDate, merged.deliveredDate, merged.eta, merged.refundedDate, id
  );

  return getOrder(id);
}

module.exports = { createOrder, listOrders, getOrder, updateOrder, markRefunded, ORDER_STATUSES };
