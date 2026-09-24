// Seed data for a fresh database: a handful of demo orders + FAQ answers.
// This only runs once — seed() is a no-op if the tables already have rows,
// so it won't stomp on real data you've since created via the app/API.

const db = require('./db');

const ORDER_STATUSES = ['Processing', 'In Transit', 'Delivered', 'Refunded'];

// Dates below are relative to tools.js's TODAY constant (2026-09-18) — the
// app's internal "today" for all 30-day-return-window math. When that
// constant was last updated, every existing date here was shifted by the
// same +51 days so previously-true facts (which orders are eligible,
// expired, in transit, etc.) stayed true rather than silently changing.
const SEED_ORDERS = [
  {
    id: 'BK-10234',
    username: 'demo',
    items: [
      { title: 'The Midnight Library', qty: 1, price: 14.99 },
      { title: 'Atomic Habits', qty: 1, price: 8.99 },
    ],
    total: 23.98,
    status: 'In Transit',
    carrier: 'UPS',
    trackingNumber: '1Z999AA10123456784',
    orderDate: '2026-09-13',
    shippedDate: '2026-09-14',
    deliveredDate: null,
    eta: '2026-09-20',
  },
  {
    id: 'BK-10500',
    username: 'demo',
    items: [{ title: 'Dune', qty: 1, price: 12.99 }],
    total: 12.99,
    status: 'Delivered',
    carrier: 'USPS',
    trackingNumber: '9400111899561234567890',
    orderDate: '2026-08-29',
    shippedDate: '2026-08-30',
    deliveredDate: '2026-09-03',
    eta: null,
  },
  {
    id: 'BK-10777',
    username: 'alice',
    items: [{ title: 'Project Hail Mary', qty: 2, price: 11.5 }],
    total: 23.0,
    status: 'Processing',
    carrier: null,
    trackingNumber: null,
    orderDate: '2026-09-17',
    shippedDate: null,
    deliveredDate: null,
    eta: '2026-09-22',
  },
  {
    id: 'BK-20001',
    username: 'alice',
    items: [{ title: 'Circe', qty: 1, price: 10.99 }],
    total: 10.99,
    status: 'Delivered',
    carrier: 'UPS',
    trackingNumber: '1Z999AA10199988877',
    orderDate: '2026-09-04',
    shippedDate: '2026-09-05',
    deliveredDate: '2026-09-09',
    eta: null,
  },
  // New: delivered 10 days ago — clearly within the 30-day return window.
  {
    id: 'BK-30003',
    username: 'alice',
    items: [{ title: 'Born a Crime', qty: 1, price: 12.99 }],
    total: 12.99,
    status: 'Delivered',
    carrier: 'UPS',
    trackingNumber: '1Z999AA10123409981',
    orderDate: '2026-09-06',
    shippedDate: '2026-09-07',
    deliveredDate: '2026-09-08',
    eta: null,
  },
  // New: delivered 24 days ago — still within the window, closer to the edge.
  {
    id: 'BK-30004',
    username: 'alice',
    items: [{ title: 'The Silent Patient', qty: 1, price: 10.99 }],
    total: 10.99,
    status: 'Delivered',
    carrier: 'FedEx',
    trackingNumber: '778812340099',
    orderDate: '2026-08-22',
    shippedDate: '2026-08-23',
    deliveredDate: '2026-08-25',
    eta: null,
  },
  {
    id: 'BK-10042',
    username: 'bob',
    items: [{ title: 'Sapiens', qty: 1, price: 17.5 }],
    total: 17.5,
    status: 'Delivered',
    carrier: 'FedEx',
    trackingNumber: '771234567890',
    orderDate: '2026-07-10',
    shippedDate: '2026-07-11',
    deliveredDate: '2026-07-15',
    eta: null,
  },
  {
    id: 'BK-20002',
    username: 'bob',
    items: [{ title: 'The Way of Kings', qty: 1, price: 15.99 }],
    total: 15.99,
    status: 'In Transit',
    carrier: 'USPS',
    trackingNumber: '9400111899561239988',
    orderDate: '2026-09-15',
    shippedDate: '2026-09-16',
    deliveredDate: null,
    eta: '2026-09-21',
  },
  // New: delivered 13 days ago — clearly within the 30-day return window.
  {
    id: 'BK-30001',
    username: 'bob',
    items: [{ title: 'Educated', qty: 1, price: 13.99 }],
    total: 13.99,
    status: 'Delivered',
    carrier: 'UPS',
    trackingNumber: '1Z999AA10123412233',
    orderDate: '2026-09-03',
    shippedDate: '2026-09-04',
    deliveredDate: '2026-09-05',
    eta: null,
  },
  // New: delivered 21 days ago — still within the window, closer to the edge.
  {
    id: 'BK-30002',
    username: 'bob',
    items: [{ title: 'The Song of Achilles', qty: 1, price: 11.99 }],
    total: 11.99,
    status: 'Delivered',
    carrier: 'USPS',
    trackingNumber: '9400111899561245566',
    orderDate: '2026-08-25',
    shippedDate: '2026-08-26',
    deliveredDate: '2026-08-28',
    eta: null,
  },
];

const SEED_FAQ = {
  shipping:
    "Standard shipping takes 3-5 business days within the US, and expedited shipping takes 1-2 business days. " +
    "Orders over $35 ship free; expedited and international orders have a flat fee shown at checkout.",
  return_policy:
    "You can return most items within 30 days of delivery for a full refund, as long as they're in their original " +
    "condition. Digital/e-book purchases and gift cards aren't eligible for return. Once we receive the item, " +
    "refunds are issued to your original payment method within 3-5 business days.",
  password_reset:
    'To reset your password: go to bookly.example/login, click "Forgot password?", and enter the email on your ' +
    "account. You'll get a reset link by email that's valid for 30 minutes. If it doesn't arrive, check your spam " +
    "folder or ask me to resend it.",
};

function seed() {
  const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  if (orderCount === 0) {
    const insert = db.prepare(`
      INSERT INTO orders (id, username, items, total, status, carrier, trackingNumber, orderDate, shippedDate, deliveredDate, eta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const o of SEED_ORDERS) {
      insert.run(
        o.id, o.username, JSON.stringify(o.items), o.total, o.status,
        o.carrier, o.trackingNumber, o.orderDate, o.shippedDate, o.deliveredDate, o.eta
      );
    }
  }

  const faqCount = db.prepare('SELECT COUNT(*) AS n FROM faq').get().n;
  if (faqCount === 0) {
    const insert = db.prepare('INSERT INTO faq (topic, answer) VALUES (?, ?)');
    for (const [topic, answer] of Object.entries(SEED_FAQ)) {
      insert.run(topic, answer);
    }
  }
}

seed();

module.exports = { ORDER_STATUSES, SEED_ORDERS, SEED_FAQ };
