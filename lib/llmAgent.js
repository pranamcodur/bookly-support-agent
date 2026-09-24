// LLM-backed version of the Bookly support agent. Same "shape" as lib/agent.js
// (a class with an async handleMessage(text) -> { reply, meta }), but instead of
// a hand-written state machine, the dialogue, slot-filling, clarifying questions,
// and tool-call decisions are all made by Claude via the Anthropic Messages API
// with real tool use. lib/tools.js (the mocked backend) is unchanged and shared
// between both engines.
//
// Guardrails against hallucination, layered per Anthropic's own guidance
// (allow "I don't know", ground responses in tool output, verify claims
// before they reach the customer — see docs.claude.com "Reduce hallucinations")
// plus code-level enforcement that doesn't depend on the model behaving:
//   1. System prompt: explicit permission to say "I don't know" / ask again
//      instead of guessing; hard rule to only state order/policy specifics
//      that came from a tool result; scope + prompt-injection guard.
//   2. Enforced eligibility gate: process_refund is REJECTED in code (not
//      just discouraged in the prompt) unless check_return_eligibility
//      already returned eligible:true for that exact order this session.
//   3. Grounding check on the final reply: any order ID the reply mentions
//      must have actually appeared in a tool result this conversation, or
//      the reply is swapped for a safe fallback before the customer sees it.
//
// (A fourth layer — a low `temperature` for more consistent sampling — used
// to be here too, but current-generation Claude models reject the parameter
// outright ("`temperature` is deprecated for this model"), so it's now only
// sent if you explicitly set ANTHROPIC_TEMPERATURE, and even then the code
// automatically drops it and retries if the model rejects it. Anthropic's
// own guidance is to lean on prompt-level determinism instead — see layer 1.)

const tools = require('./tools');
const ticketHelper = require('./ticketHelper');
const { getSystemPrompt } = require('./systemPromptStore');

let Anthropic;
try {
  // Lazily required so the rule-based engine keeps working even if this
  // package hasn't been installed yet.
  Anthropic = require('@anthropic-ai/sdk');
} catch (err) {
  Anthropic = null;
}

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// Only set if the person explicitly opts in — many current models (Sonnet 5
// generation and newer) reject this parameter outright regardless of value.
const TEMPERATURE = process.env.ANTHROPIC_TEMPERATURE != null ? Number(process.env.ANTHROPIC_TEMPERATURE) : null;
const MAX_TOOL_ITERATIONS = 6;
const ORDER_ID_RE = /\bBK-\d{4,6}\b/g;

class MissingApiKeyError extends Error {}

const GENERAL_TOOLS = [
  {
    name: 'get_faq_answer',
    description: "Get Bookly's official answer for a general policy question.",
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          enum: ['shipping', 'return_policy', 'password_reset'],
          description: 'Which FAQ topic to fetch the official answer for.',
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'create_support_ticket',
    description:
      'Open a Zendesk support ticket so a human teammate can follow up. Available whether or not the customer ' +
      'is logged in. Only call this after the customer has explicitly confirmed they want a ticket opened — ' +
      'never open one just because they sound upset; ask first.',
    input_schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'One or two sentence summary of the issue, used for the ticket subject/description.',
        },
      },
      required: ['summary'],
    },
  },
];

// Only ever offered to the model when the customer is logged in (see the
// constructor) — this is the real enforcement, not just a prompt instruction.
// The Anthropic API can only call tools that were included in the request,
// so when logged out the model has no way to invoke these even if it tried.
const ACCOUNT_TOOLS = [
  {
    name: 'get_order_status',
    description:
      "Look up an order's current shipping/delivery status, items, and total by order ID. Use this whenever a customer asks about the status, tracking, or whereabouts of an order.",
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order number, e.g. "BK-10234"' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'check_return_eligibility',
    description:
      'Check whether an order is currently eligible for a return/refund (must be delivered and within the 30-day return window). Always call this before telling a customer their return is approved.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order number, e.g. "BK-10234"' },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'process_refund',
    description:
      "Actually process a refund for an order. Only call this after the customer has explicitly confirmed they want to proceed, and after check_return_eligibility has returned eligible: true for that order — the call is rejected server-side otherwise.",
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Order number, e.g. "BK-10234"' },
        reason: { type: 'string', description: 'The reason the customer gave for the return' },
      },
      required: ['order_id', 'reason'],
    },
  },
];

const LIST_MY_ORDERS_TOOL = {
  name: 'list_my_orders',
  description:
    "List the currently logged-in customer's own orders (order IDs, statuses, totals). Use this instead of asking for an order number when the customer refers to \"my order(s)\" and is logged in.",
  input_schema: { type: 'object', properties: {} },
};

// Maps a tool call to the friendly label shown as a "receipt" in the web UI,
// for the tool calls that represent a real action/lookup worth surfacing.
const RECEIPT_LABELS = {
  get_order_status: 'Order lookup',
  process_refund: 'Refund processed',
  list_my_orders: 'Order lookup',
  create_support_ticket: 'Zendesk ticket created',
};

const FALLBACK_REPLY =
  "Sorry, I want to double-check that before saying anything more specific — could you re-send the order number?";

class LLMBooklyAgent {
  // Shared across all instances/conversations in this process — once we learn
  // the configured model rejects `temperature`, there's no reason to keep
  // trying it on every subsequent call.
  static _temperatureSupported = true;

  constructor({ username } = {}) {
    if (!Anthropic) {
      throw new MissingApiKeyError(
        "The '@anthropic-ai/sdk' package isn't installed. Run `npm install` and try again."
      );
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new MissingApiKeyError('No ANTHROPIC_API_KEY found in the environment.');
    }
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.username = username || null;
    // Full running transcript sent to the API each turn (the API is stateless).
    this.history = [];

    // Guardrail state, scoped to this conversation:
    // - orderIdsSeen: every order ID that has actually come back from a tool
    //   this session. The final reply is checked against this before it's sent.
    // - eligibleOrderIds: order IDs check_return_eligibility has confirmed
    //   eligible:true for. process_refund is refused for anything not in here.
    this.orderIdsSeen = new Set();
    this.eligibleOrderIds = new Set();

    this.tools = this.username ? [...GENERAL_TOOLS, ...ACCOUNT_TOOLS, LIST_MY_ORDERS_TOOL] : GENERAL_TOOLS;
    // Read fresh (not cached at module load) so an edit saved via the Agent
    // Admin page takes effect for the next new/reset session immediately,
    // without needing a server restart. Matches how a login/engine change
    // already requires a fresh agent rather than mutating a live one.
    const basePrompt = getSystemPrompt();
    this.system = this.username
      ? `${basePrompt}\n\nThe customer is currently logged in as "${this.username}". You may call list_my_orders (no arguments needed) instead of asking for an order number when they refer to "my order(s)". You only ever have access to this customer's own orders — order-lookup tools are automatically scoped to their account.`
      : `${basePrompt}\n\nThe customer is NOT logged in. You only have get_faq_answer and create_support_ticket available right now — no order-lookup, return, or refund tools. For anything about a specific order, "my orders", a return, or a refund, tell them they need to log in or create an account first; you're not able to look up or act on any order until they do. You can still open a support ticket for them if needed, even while logged out.`;
  }

  _rememberOrderIds(result) {
    if (!result) return;
    if (result.order && result.order.id) this.orderIdsSeen.add(result.order.id);
    if (Array.isArray(result.orders)) {
      for (const o of result.orders) if (o && o.id) this.orderIdsSeen.add(o.id);
    }
    if (result.orderId) this.orderIdsSeen.add(result.orderId);
  }

  // Pulls plain text out of the last few turns of the Messages API history
  // (which also contains tool_use/tool_result blocks we don't want in a
  // ticket) to give a Zendesk ticket some conversational context.
  _recentTranscriptText(limit = 10) {
    const lines = [];
    for (const msg of this.history.slice(-limit)) {
      const content = msg.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      }
      if (text) lines.push(`${msg.role === 'user' ? 'Customer' : 'Assistant'}: ${text}`);
    }
    return lines.join('\n');
  }

  // Code-level guardrail: this is the actual gatekeeper for refunds, not just
  // a prompt instruction. Even if the model tries to call process_refund
  // straight away, it gets an error back instead of a processed refund.
  async _executeTool(name, input) {
    switch (name) {
      case 'get_order_status': {
        const result = await tools.getOrderStatus(input.order_id, this.username);
        this._rememberOrderIds(result);
        return result;
      }
      case 'check_return_eligibility': {
        const result = await tools.checkReturnEligibility(input.order_id, this.username);
        this._rememberOrderIds(result);
        if (result.eligible) this.eligibleOrderIds.add(input.order_id);
        return result;
      }
      case 'process_refund': {
        if (!this.eligibleOrderIds.has(input.order_id)) {
          console.log(`[guardrail] blocked process_refund for ${input.order_id} — no confirmed eligibility check`);
          return {
            error:
              'Refund rejected: check_return_eligibility must be called for this order_id and return eligible:true before process_refund can run.',
          };
        }
        const result = await tools.processRefund(input.order_id, input.reason, this.username);
        // Whether it succeeded or was refused, this order shouldn't be treated as
        // still "confirmed eligible" for a subsequent attempt without rechecking —
        // otherwise a stale eligibility check from earlier in the conversation
        // could let a second process_refund call slip through after the order's
        // already been refunded.
        this.eligibleOrderIds.delete(input.order_id);
        if (result.error) {
          console.log(`[guardrail] process_refund for ${input.order_id} refused: ${result.error}`);
          return {
            error:
              result.error === 'already_refunded'
                ? 'Refund rejected: this order has already been refunded.'
                : 'Refund rejected: this order does not belong to the logged-in customer.',
          };
        }
        this._rememberOrderIds(result);
        return result;
      }
      case 'list_my_orders': {
        const result = await tools.getOrdersByUsername(this.username);
        this._rememberOrderIds(result);
        return result;
      }
      case 'get_faq_answer':
        return { answer: tools.getFaqAnswer(input.topic) };
      case 'create_support_ticket': {
        try {
          const ticket = await ticketHelper.createSupportTicket({
            username: this.username,
            summary: input.summary,
            transcriptText: this._recentTranscriptText(),
          });
          return { ticketId: ticket.id, url: ticket.url, mock: ticket.mock, requesterEmail: ticket.requesterEmail };
        } catch (err) {
          return { error: `Could not create the ticket: ${err.message || err}` };
        }
      }
      default:
        return { error: `Unknown tool: ${name}` };
    }
  }

  // Last line of defense: if the reply mentions an order ID that never came
  // back from a real tool call this conversation, it's fabricated — swap in
  // a safe fallback rather than let it reach the customer.
  _checkGrounding(reply) {
    const mentioned = reply.match(ORDER_ID_RE) || [];
    const ungrounded = mentioned.filter((id) => !this.orderIdsSeen.has(id));
    if (ungrounded.length === 0) return { reply, guardrailTriggered: false };

    console.log(`[guardrail] blocked ungrounded order id(s) in reply: ${[...new Set(ungrounded)].join(', ')}`);
    return { reply: FALLBACK_REPLY, guardrailTriggered: true };
  }

  // Wraps the actual API call so a rejected `temperature` param (some current
  // model generations return a 400 for it regardless of value) doesn't take
  // the whole conversation down — detect it once, drop the field, retry, and
  // remember not to send it again for the rest of the process.
  async _createMessage(params) {
    const withTemperature = TEMPERATURE != null && LLMBooklyAgent._temperatureSupported;
    try {
      return await this.client.messages.create(
        withTemperature ? { ...params, temperature: TEMPERATURE } : params
      );
    } catch (err) {
      const message = (err && err.message) || '';
      if (withTemperature && /temperature/i.test(message) && /deprecat/i.test(message)) {
        console.warn(
          '[llmAgent] This model rejects the `temperature` parameter — dropping it and retrying ' +
          '(ANTHROPIC_TEMPERATURE will be ignored for the rest of this process).'
        );
        LLMBooklyAgent._temperatureSupported = false;
        return this.client.messages.create(params);
      }
      throw err;
    }
  }

  async handleMessage(rawText) {
    const text = (rawText || '').trim();
    if (!text) {
      return { reply: "Sorry, I didn't catch a message — could you try again?" };
    }

    this.history.push({ role: 'user', content: text });

    let lastReceiptTool = null;

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await this._createMessage({
        model: MODEL,
        max_tokens: 1024,
        system: this.system,
        tools: this.tools,
        messages: this.history,
      });

      this.history.push({ role: 'assistant', content: response.content });

      if (response.stop_reason !== 'tool_use') {
        const rawReply = response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
          .trim();

        if (!rawReply) {
          return { reply: "Sorry, I'm not sure how to respond to that — could you rephrase?" };
        }

        const { reply, guardrailTriggered } = this._checkGrounding(rawReply);
        return {
          reply,
          meta: lastReceiptTool ? { tool: RECEIPT_LABELS[lastReceiptTool] } : null,
          note: guardrailTriggered
            ? 'A guardrail intervened here: the draft reply referenced an order number that was never confirmed by a tool call this conversation, so it was replaced with this safer response.'
            : null,
        };
      }

      // Execute every tool_use block the model requested, then feed results back.
      const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
      const toolResults = [];
      for (const block of toolUseBlocks) {
        if (RECEIPT_LABELS[block.name]) lastReceiptTool = block.name;
        let result;
        try {
          result = await this._executeTool(block.name, block.input);
        } catch (err) {
          result = { error: err.message || String(err) };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
      this.history.push({ role: 'user', content: toolResults });
    }

    return {
      reply: "Sorry, that took more steps than expected — could you try rephrasing your request?",
    };
  }
}

// Exposed for the Agent Admin "Tools" panel — a read-only view of exactly
// what's registered, annotated with whether each requires being logged in.
const ALL_TOOLS = [
  ...GENERAL_TOOLS.map((t) => ({ ...t, requiresLogin: false })),
  ...ACCOUNT_TOOLS.map((t) => ({ ...t, requiresLogin: true })),
  { ...LIST_MY_ORDERS_TOOL, requiresLogin: true },
];

module.exports = { LLMBooklyAgent, MissingApiKeyError, ALL_TOOLS };
