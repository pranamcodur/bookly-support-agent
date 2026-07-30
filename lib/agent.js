const tools = require('./tools');
const { isFrustrated } = require('./sentiment');
const ticketHelper = require('./ticketHelper');

// ---------------------------------------------------------------------------
// Small helpers for pulling structured info out of free text.
// This is a lightweight, rule-based stand-in for an NLU/LLM layer, good enough
// for the demo's scope. It's isolated here so it could be swapped for a real
// model call without touching the state machine below.
// ---------------------------------------------------------------------------

function normalizeOrderId(raw) {
  if (!raw) return null;
  const cleaned = raw.trim().toUpperCase();
  const withPrefix = cleaned.match(/\bBK-?\d{4,6}\b/);
  if (withPrefix) {
    return withPrefix[0].replace(/^BK(?!-)/, 'BK-');
  }
  const bareNumber = cleaned.match(/\b\d{4,6}\b/);
  if (bareNumber) return `BK-${bareNumber[0]}`;
  return null;
}

function isAffirmative(text) {
  return /^\s*(y|yes|yeah|yep|yup|sure|confirm|correct|go ahead|do it)\b/i.test(text);
}

function isNegative(text) {
  return /^\s*(n|no|nope|nah|cancel|stop|never ?mind)\b/i.test(text);
}

/**
 * Very small rule-based intent classifier. Order of checks matters: more
 * specific / action-oriented phrasings are checked before generic ones so
 * that, e.g., "I want a refund" doesn't get swallowed by the FAQ branch.
 */
function classifyIntent(text) {
  const t = text.toLowerCase();

  if (/\b(hi|hello|hey|good (morning|afternoon|evening))\b/.test(t) && t.length < 30) {
    return 'greeting';
  }

  if (/\b(human|real person|agent|representative)\b/.test(t)) {
    return 'human_handoff';
  }

  // Explicit intent to start a return/refund action.
  if (/\b(refund|return (this|it|my|the)|send.*back|money back|want.*return)\b/.test(t) && !/\bpolicy\b/.test(t)) {
    return 'return_refund';
  }

  // Asking *about* the return policy, rather than asking to return something.
  if (/\breturn policy\b|\bhow (do|does) returns? work\b|\brefund policy\b/.test(t)) {
    return 'faq_return_policy';
  }

  // Order status / tracking.
  if (/\bmy orders\b|\border history\b|\ball my orders\b|\blist my orders\b/.test(t)) {
    return 'my_orders';
  }

  if (/\btrack|order status|where.*(my )?order|shipment|has my order shipped|when will.*arrive|status of my order\b/.test(t)) {
    return 'order_status';
  }

  if (/\bpassword\b/.test(t)) {
    return 'faq_password';
  }

  if (/\bshipping (policy|cost|time|rate)|how long.*shipping|delivery time|free shipping\b/.test(t)) {
    return 'faq_shipping';
  }

  // Vague complaint about an order, without saying what they actually want done.
  // This is the deliberately ambiguous case the agent should ask about rather than guess.
  if (/(problem|issue|trouble|something.*wrong)/.test(t) && /order/.test(t)) {
    return 'ambiguous_order_issue';
  }

  return 'unknown';
}

const GREETING =
  "Hi, I'm the Bookly support assistant! I can help with order status, returns/refunds, shipping, " +
  'password resets, and other general questions. What can I help you with?';

const FALLBACK =
  "I'm not totally sure I caught that. I can help with order status, starting a return/refund, or " +
  'general questions about shipping, our return policy, or password resets — what would you like to do?';

const LOGIN_REQUIRED =
  "You'll need to be logged in for that — order status and returns are account-specific. Use the Log in " +
  'button at the top (or sign up if you\'re new), then ask me again. I can still help with general questions ' +
  "about shipping, our return policy, or password resets without logging in.";

class BooklyAgent {
  constructor({ username } = {}) {
    // 'state' drives the multi-turn flows; 'context' holds slots collected along the way.
    this.state = 'IDLE';
    this.context = {};
    // When set, the customer is logged in — lets us skip asking for an order
    // number in some flows (e.g. "my orders") and personalize the greeting.
    this.username = username || null;
    // Set when we've just asked "want me to open a support ticket?" — the
    // very next message is interpreted as an answer to that, independent of
    // whatever `state` is (kept separate from the main state machine so it
    // only ever triggers from IDLE, never colliding with an in-progress
    // multi-turn flow's own yes/no question).
    this.awaitingTicketOffer = false;
    // Recent turns, used to give a Zendesk ticket some conversational context.
    this.transcript = [];
  }

  /**
   * Main entry point. Always returns a Promise<{ reply: string, meta?: object }>.
   * meta is extra structured info (mainly useful for logging/demo purposes).
   */
  async handleMessage(rawText) {
    const text = (rawText || '').trim();
    if (!text) {
      return { reply: "Sorry, I didn't catch a message — could you try again?" };
    }
    this.transcript.push({ role: 'user', text });

    // Global escape hatch available from any state.
    if (/^(cancel|start over|reset|nevermind)$/i.test(text) && this.state !== 'IDLE') {
      this.state = 'IDLE';
      this.context = {};
      const result = { reply: 'No problem, I\'ve cancelled that. What else can I help with?' };
      this.transcript.push({ role: 'bot', text: result.reply });
      return result;
    }

    // If we just asked "want a support ticket?", the next message answers
    // that — unless it's a decline, in which case we fall through and let
    // this same message get handled normally below.
    if (this.awaitingTicketOffer) {
      const ticketResult = await this._handleAwaitingTicketOffer(text);
      if (ticketResult) {
        this.transcript.push({ role: 'bot', text: ticketResult.reply });
        return ticketResult;
      }
    }

    let result;
    switch (this.state) {
      case 'AWAITING_ORDER_FOR_STATUS':
        result = await this._handleAwaitingOrderForStatus(text);
        break;
      case 'AWAITING_ORDER_FOR_RETURN':
        result = await this._handleAwaitingOrderForReturn(text);
        break;
      case 'RETURN_AWAITING_REASON':
        result = await this._handleReturnReason(text);
        break;
      case 'RETURN_AWAITING_CONFIRM':
        result = await this._handleReturnConfirm(text);
        break;
      case 'AWAITING_CLARIFICATION':
        result = await this._handleClarification(text);
        break;
      default:
        result = await this._handleIdle(text);
    }

    // Offer a ticket if the customer sounds frustrated — but only once we're
    // back at a clean IDLE state, so this never collides with an in-progress
    // multi-turn flow's own yes/no question (e.g. a refund confirmation).
    if (!this.awaitingTicketOffer && this.state === 'IDLE' && isFrustrated(text)) {
      result = {
        ...result,
        reply: `${result.reply}\n\nBy the way, I'm sorry this has been frustrating. Would you like me to open a support ticket so a human teammate can follow up? (yes/no)`,
      };
      this.awaitingTicketOffer = true;
    }

    this.transcript.push({ role: 'bot', text: result.reply });
    return result;
  }

  // -- Support ticket escalation --------------------------------------------
  async _handleAwaitingTicketOffer(text) {
    if (isAffirmative(text)) {
      this.awaitingTicketOffer = false;
      return this._createSupportTicket();
    }
    if (isNegative(text)) {
      this.awaitingTicketOffer = false;
      return null; // let the caller re-process this same message normally
    }
    return {
      reply: 'Just to confirm \u2014 would you like me to open a support ticket so a human teammate can follow up? (yes/no)',
    };
  }

  async _createSupportTicket() {
    try {
      const transcriptText = this.transcript
        .slice(-10)
        .map((t) => `${t.role === 'user' ? 'Customer' : 'Assistant'}: ${t.text}`)
        .join('\n');
      const ticket = await ticketHelper.createSupportTicket({ username: this.username, transcriptText });
      const modeNote = ticket.mock ? ' (demo mode \u2014 no real Zendesk connected yet)' : '';
      return {
        reply:
          `Done \u2014 I've opened ticket #${ticket.id}${modeNote}. A human teammate will follow up` +
          `${ticket.requesterEmail ? ` at ${ticket.requesterEmail}` : ''} as soon as possible.`,
        meta: { tool: 'Zendesk ticket created' },
      };
    } catch (err) {
      return {
        reply: "Sorry, I ran into a problem opening that ticket just now \u2014 please try again in a moment.",
      };
    }
  }

  // -- IDLE: classify a fresh message and route it -------------------------
  async _handleIdle(text) {
    const intent = classifyIntent(text);

    switch (intent) {
      case 'greeting':
        return { reply: GREETING };

      case 'human_handoff':
        this.awaitingTicketOffer = true;
        return {
          reply:
            'I can open a support ticket so a human teammate can follow up on this \u2014 want me to go ahead? (yes/no)',
        };

      case 'my_orders':
        return this._listMyOrders();

      case 'order_status': {
        if (!this.username) return { reply: LOGIN_REQUIRED };
        const orderId = normalizeOrderId(text);
        if (orderId) return this._lookupOrderStatus(orderId);
        const onlyOrderId = await this._soleOrderIdForLoggedInUser();
        if (onlyOrderId) return this._lookupOrderStatus(onlyOrderId);
        this.state = 'AWAITING_ORDER_FOR_STATUS';
        return { reply: 'Sure, I can check that. What\'s your order number? (e.g., BK-10234)' };
      }

      case 'return_refund': {
        if (!this.username) return { reply: LOGIN_REQUIRED };
        const orderId = normalizeOrderId(text);
        if (orderId) return this._startReturnFlow(orderId);
        const onlyOrderId = await this._soleOrderIdForLoggedInUser();
        if (onlyOrderId) return this._startReturnFlow(onlyOrderId);
        this.state = 'AWAITING_ORDER_FOR_RETURN';
        return { reply: "I can help start that. What's the order number for the item you'd like to return?" };
      }

      case 'faq_return_policy':
        return { reply: tools.getFaqAnswer('return_policy') };

      case 'faq_shipping':
        return { reply: tools.getFaqAnswer('shipping') };

      case 'faq_password':
        return { reply: tools.getFaqAnswer('password_reset') };

      case 'ambiguous_order_issue':
        if (!this.username) return { reply: LOGIN_REQUIRED };
        // Deliberately don't guess here — ask a clarifying question first.
        this.state = 'AWAITING_CLARIFICATION';
        this.context.clarifyFor = 'order_issue';
        return {
          reply:
            "Sorry to hear that! Just so I help with the right thing — would you like to (1) check your " +
            "order's shipping status, or (2) start a return/refund for it?",
        };

      default:
        return { reply: FALLBACK };
    }
  }

  // -- Order status sub-flow ------------------------------------------------
  async _listMyOrders() {
    if (!this.username) {
      return { reply: LOGIN_REQUIRED };
    }
    const { orders } = await tools.getOrdersByUsername(this.username);
    if (orders.length === 0) {
      return { reply: `I don't see any orders on your account (${this.username}) yet.` };
    }
    const lines = orders.map((o) => `${o.id} — ${o.status}, $${o.total.toFixed(2)}`).join('\n');
    return {
      reply: `Here's what's on your account:\n${lines}\n\nWant details on any of these? Just give me the order number.`,
      meta: { tool: 'Order lookup' },
    };
  }

  /** If logged in with exactly one order, use it without asking for a number. */
  async _soleOrderIdForLoggedInUser() {
    if (!this.username) return null;
    const { orders } = await tools.getOrdersByUsername(this.username);
    return orders.length === 1 ? orders[0].id : null;
  }

  async _lookupOrderStatus(orderId) {
    if (!this.username) {
      this.state = 'IDLE';
      return { reply: LOGIN_REQUIRED };
    }
    const { found, order } = await tools.getOrderStatus(orderId, this.username);
    this.state = 'IDLE';
    if (!found) {
      return {
        reply:
          `I couldn't find an order with number ${orderId} on your account. Could you double check it? It ` +
          'should look like "BK-10234".',
      };
    }

    const itemList = order.items.map((i) => `${i.qty}x ${i.title}`).join(', ');
    let statusLine;
    if (order.status === 'Refunded') {
      statusLine = `it was refunded on ${order.refundedDate} — that return is complete, nothing further needed.`;
    } else if (order.status === 'Delivered') {
      statusLine = `it was delivered on ${order.deliveredDate} via ${order.carrier}.`;
    } else if (order.status === 'In Transit') {
      statusLine = `it's in transit via ${order.carrier} (tracking ${order.trackingNumber}), expected by ${order.eta}.`;
    } else {
      statusLine = `it's still being processed, with an estimated ship date leading to delivery around ${order.eta}.`;
    }

    return {
      reply: `Order ${order.id} (${itemList}, total $${order.total.toFixed(2)}): ${statusLine}`,
      meta: { tool: 'Order lookup', order },
    };
  }

  async _handleAwaitingOrderForStatus(text) {
    if (!this.username) {
      this.state = 'IDLE';
      return { reply: LOGIN_REQUIRED };
    }
    if (/\bmy orders\b|\border history\b/i.test(text)) {
      this.state = 'IDLE';
      return this._listMyOrders();
    }
    const orderId = normalizeOrderId(text);
    if (!orderId) {
      return { reply: 'Hmm, that doesn\'t look like an order number — it should look like "BK-10234". Could you send that again?' };
    }
    return this._lookupOrderStatus(orderId);
  }

  // -- Return / refund sub-flow (multi-turn) --------------------------------
  async _startReturnFlow(orderId) {
    if (!this.username) {
      this.state = 'IDLE';
      return { reply: LOGIN_REQUIRED };
    }
    const result = await tools.checkReturnEligibility(orderId, this.username);

    if (!result.eligible) {
      this.state = 'IDLE';
      this.context = {};
      if (result.reason === 'not_found') {
        return { reply: `I couldn't find an order with number ${orderId} on your account. Could you double check it?` };
      }
      if (result.reason === 'already_refunded') {
        return {
          reply: `Order ${orderId} was already refunded on ${result.order.refundedDate} — that return is already ` +
            "complete, so there's nothing further to process. Let me know if something about that refund still " +
            'needs attention.',
        };
      }
      if (result.reason === 'not_delivered') {
        return {
          reply:
            `Order ${orderId} hasn't been delivered yet (current status: ${result.order.status}), so it's not ` +
            "eligible for a return just yet. If you'd like, I can help with something else, like checking its " +
            'shipping status.',
        };
      }
      if (result.reason === 'window_expired') {
        return {
          reply:
            `Order ${orderId} was delivered on ${result.order.deliveredDate}, which is ${result.daysSinceDelivery} ` +
            "days ago — outside our 30-day return window, so I'm not able to process an automatic refund. I can " +
            'connect you with a human teammate to review it if you think there\'s an exception here.',
        };
      }
      return { reply: `Sorry, order ${orderId} isn't eligible for a return right now.` };
    }

    this.state = 'RETURN_AWAITING_REASON';
    this.context.orderId = orderId;
    this.context.order = result.order;
    return {
      reply:
        `Got it — order ${orderId} is eligible for a return (delivered ${result.order.deliveredDate}). ` +
        "What's the reason for the return? (e.g., arrived damaged, wrong item, changed my mind)",
    };
  }

  async _handleAwaitingOrderForReturn(text) {
    if (!this.username) {
      this.state = 'IDLE';
      return { reply: LOGIN_REQUIRED };
    }
    const orderId = normalizeOrderId(text);
    if (!orderId) {
      return { reply: 'That doesn\'t look like an order number — it should look like "BK-10234". Could you resend it?' };
    }
    return this._startReturnFlow(orderId);
  }

  async _handleReturnReason(text) {
    this.context.reason = text;
    this.state = 'RETURN_AWAITING_CONFIRM';
    const { orderId, order } = this.context;
    return {
      reply:
        `To confirm: you'd like to return order ${orderId} (reason: "${text}") and receive a refund of ` +
        `$${order.total.toFixed(2)} to your original payment method. Should I go ahead? (yes/no)`,
    };
  }

  async _handleReturnConfirm(text) {
    if (isAffirmative(text)) {
      if (!this.username) {
        this.state = 'IDLE';
        this.context = {};
        return { reply: LOGIN_REQUIRED };
      }
      const { orderId, reason } = this.context;
      const result = await tools.processRefund(orderId, reason, this.username);
      this.state = 'IDLE';
      this.context = {};
      if (result.error === 'already_refunded') {
        return { reply: `Looks like order ${orderId} was already refunded — nothing further to process there.` };
      }
      if (result.error) {
        return { reply: "Sorry, I couldn't process that refund — please try again or ask for a human teammate." };
      }
      return {
        reply:
          `All set! I've processed refund ${result.refundId} for $${result.amount.toFixed(2)} on order ` +
          `${orderId}. You'll see it back on your original payment method in ${result.etaBusinessDays} business ` +
          "days, and we've emailed you a prepaid return label.",
        meta: { tool: 'Refund processed', result },
      };
    }
    if (isNegative(text)) {
      this.state = 'IDLE';
      this.context = {};
      return { reply: "No problem, I won't process that. Anything else I can help with?" };
    }
    return { reply: 'Sorry, just to confirm — should I go ahead with the return and refund? (yes/no)' };
  }

  // -- Clarification sub-flow -------------------------------------------------
  async _handleClarification(text) {
    if (!this.username) {
      this.state = 'IDLE';
      return { reply: LOGIN_REQUIRED };
    }
    const t = text.toLowerCase();
    const wantsStatus = /\b1\b|status|track|shipping/.test(t);
    const wantsReturn = /\b2\b|return|refund/.test(t);

    if (wantsStatus && !wantsReturn) {
      this.state = 'AWAITING_ORDER_FOR_STATUS';
      this.context = {};
      return { reply: "Sure — what's the order number? (e.g., BK-10234)" };
    }
    if (wantsReturn && !wantsStatus) {
      this.state = 'AWAITING_ORDER_FOR_RETURN';
      this.context = {};
      return { reply: "Sure — what's the order number for the item you'd like to return?" };
    }
    return {
      reply:
        'Sorry, just to be clear — do you want to (1) check your order\'s shipping status, or (2) start a ' +
        'return/refund? You can reply with 1 or 2.',
    };
  }
}

module.exports = { BooklyAgent, classifyIntent, normalizeOrderId };
