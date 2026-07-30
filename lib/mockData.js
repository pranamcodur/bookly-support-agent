// Seed data for a fresh database: a handful of demo orders + FAQ answers.
// This only runs once — seed() is a no-op if the tables already have rows,
// so it won't stomp on real data you've since created via the app/API.

const db = require('./db');

const ORDER_STATUSES = ['Processing', 'In Transit', 'Delivered', 'Refunded'];

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
    orderDate: '2026-07-24',
    shippedDate: '2026-07-25',
    deliveredDate: null,
    eta: '2026-07-31',
  },
  {
    id: 'BK-10500',
    username: 'demo',
    items: [{ title: 'Dune', qty: 1, price: 12.99 }],
    total: 12.99,
    status: 'Delivered',
    carrier: 'USPS',
    trackingNumber: '9400111899561234567890',
    orderDate: '2026-07-09',
    shippedDate: '2026-07-10',
    deliveredDate: '2026-07-14',
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
    orderDate: '2026-07-28',
    shippedDate: null,
    deliveredDate: null,
    eta: '2026-08-02',
  },
  {
    id: 'BK-20001',
    username: 'alice',
    items: [{ title: 'Circe', qty: 1, price: 10.99 }],
    total: 10.99,
    status: 'Delivered',
    carrier: 'UPS',
    trackingNumber: '1Z999AA10199988877',
    orderDate: '2026-07-15',
    shippedDate: '2026-07-16',
    deliveredDate: '2026-07-20',
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
    orderDate: '2026-05-20',
    shippedDate: '2026-05-21',
    deliveredDate: '2026-05-25',
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
    orderDate: '2026-07-26',
    shippedDate: '2026-07-27',
    deliveredDate: null,
    eta: '2026-08-01',
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
