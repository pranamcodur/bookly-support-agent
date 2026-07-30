// These functions simulate calls to real backend services (order DB, payments API, etc).
// Each one logs its invocation to the server console so it's visible that the agent is
// "taking an action" rather than just generating text, and each returns a Promise with a
// small artificial delay to mimic a real network/service call. Data now comes from SQLite
// (lib/db.js) via lib/orderStore.js, so anything created/changed there is what these see.
//
// Access control lives here, at the shared tool layer, not just in each agent's
// dialogue logic — every order-specific function takes the requesting customer's
// username and refuses to return/act on an order that isn't theirs. This way both
// engines (rule-based and LLM) get the same enforcement for free, and a bug in one
// engine's gating logic can't leak another customer's order.

require('./mockData'); // ensures the DB is seeded before first use
const db = require('./db');
const orderStore = require('./orderStore');

const TODAY = new Date('2026-07-29T00:00:00Z');
const DELAY_MS = 350;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysBetween(dateStr, reference = TODAY) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return Math.round((reference.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function log(toolName, input) {
  console.log(`[tool call] ${toolName}(${JSON.stringify(input)})`);
}

/** True if this order exists and belongs to requestingUsername. */
function isOwnedBy(order, requestingUsername) {
  return !!order && !!requestingUsername && order.username === requestingUsername;
}

/**
 * Look up an order by id, scoped to the requesting customer. Returns
 * found: false both when the order doesn't exist AND when it belongs to
 * someone else — deliberately indistinguishable, so a logged-in customer
 * can't use this to probe which order numbers exist on other accounts.
 */
async function getOrderStatus(orderId, requestingUsername) {
  log('getOrderStatus', { orderId, requestingUsername });
  await delay(DELAY_MS);
  const order = orderStore.getOrder(orderId);
  if (!isOwnedBy(order, requestingUsername)) return { found: false };
  return { found: true, order };
}

/**
 * Decide whether an order is eligible for a return/refund right now, and why/why not.
 * Business rule (mocked): must belong to the requesting customer, be delivered, and
 * be within 30 days of delivery.
 */
async function checkReturnEligibility(orderId, requestingUsername) {
  log('checkReturnEligibility', { orderId, requestingUsername });
  await delay(DELAY_MS);
  const order = orderStore.getOrder(orderId);
  if (!isOwnedBy(order, requestingUsername)) return { eligible: false, reason: 'not_found' };

  if (order.status === 'Refunded') {
    return { eligible: false, reason: 'already_refunded', order };
  }

  if (order.status !== 'Delivered') {
    return { eligible: false, reason: 'not_delivered', order };
  }

  const daysSinceDelivery = daysBetween(order.deliveredDate);
  if (daysSinceDelivery > 30) {
    return { eligible: false, reason: 'window_expired', order, daysSinceDelivery };
  }

  return { eligible: true, order, daysSinceDelivery };
}

/**
 * Actually process a refund (mocked). Refuses (returns { error }) if the
 * order doesn't belong to the requesting customer — defense in depth on top
 * of each engine's own "must check eligibility first" gate. On success, this
 * flips the order's status to 'Refunded' (previously it generated a refund
 * receipt without ever updating the order — asking for the order's status
 * afterward would still show "Delivered").
 */
async function processRefund(orderId, reason, requestingUsername) {
  log('processRefund', { orderId, reason, requestingUsername });
  await delay(DELAY_MS);
  const order = orderStore.getOrder(orderId);
  if (!isOwnedBy(order, requestingUsername)) {
    return { error: 'not_authorized' };
  }
  if (order.status === 'Refunded') {
    return { error: 'already_refunded' };
  }
  const refundId = `RF-${Math.floor(100000 + Math.random() * 900000)}`;
  const refundedDate = TODAY.toISOString().slice(0, 10);
  const updatedOrder = orderStore.markRefunded(orderId, refundedDate);
  return {
    refundId,
    amount: order.total,
    orderId,
    reason,
    etaBusinessDays: '3-5',
    order: updatedOrder,
  };
}

/** List all orders belonging to a given username. */
async function getOrdersByUsername(username) {
  log('getOrdersByUsername', { username });
  await delay(DELAY_MS);
  const orders = username ? orderStore.listOrders({ username }) : [];
  return { orders };
}

function getFaqAnswer(topic) {
  log('getFaqAnswer', { topic });
  const row = db.prepare('SELECT answer FROM faq WHERE topic = ?').get(topic);
  return row ? row.answer : null;
}

module.exports = {
  getOrderStatus,
  checkReturnEligibility,
  processRefund,
  getOrdersByUsername,
  getFaqAnswer,
};
