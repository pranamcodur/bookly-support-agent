// Zendesk ticket creation. Configure real credentials via env vars:
//   ZENDESK_SUBDOMAIN=yourcompany
//   ZENDESK_EMAIL=agent@yourcompany.com
//   ZENDESK_API_TOKEN=xxxxx
// (Zendesk API tokens are created under Admin Center > Apps and integrations >
// APIs > Zendesk API, and authenticate as Basic auth with "<email>/token" as
// the username and the token as the password.)
//
// Without those three set, createTicket() returns a realistic mock ticket
// instead of calling out to Zendesk — so the rest of the app, and this whole
// feature, can be built/tested/demoed with zero real Zendesk account. This is
// the plug-in point: set the three env vars and real tickets start flowing
// with no other code changes.

const SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const EMAIL = process.env.ZENDESK_EMAIL;
const API_TOKEN = process.env.ZENDESK_API_TOKEN;

function isConfigured() {
  return Boolean(SUBDOMAIN && EMAIL && API_TOKEN);
}

let mockSequence = 100000 + Math.floor(Math.random() * 900);

/**
 * Create a Zendesk ticket.
 * @param {object} input
 * @param {string} input.subject
 * @param {string} input.description
 * @param {string} [input.requesterName]
 * @param {string} [input.requesterEmail]
 * @param {string} [input.priority] - "low" | "normal" | "high" | "urgent"
 * @param {string[]} [input.tags]
 * @returns {Promise<{id: number, url: string, status: string, mock: boolean}>}
 */
async function createTicket({ subject, description, requesterName, requesterEmail, priority = 'normal', tags = [] }) {
  if (!isConfigured()) {
    mockSequence += 1;
    const ticket = {
      id: mockSequence,
      url: `https://your-subdomain.zendesk.com/agent/tickets/${mockSequence}`,
      subject,
      description,
      requesterName: requesterName || 'Guest',
      requesterEmail: requesterEmail || null,
      priority,
      tags,
      status: 'new',
      mock: true,
    };
    console.log(
      `[zendesk:MOCK] Created ticket #${ticket.id} — "${subject}" (requester: ${ticket.requesterName}). ` +
      'Set ZENDESK_SUBDOMAIN / ZENDESK_EMAIL / ZENDESK_API_TOKEN to create real tickets instead.'
    );
    return ticket;
  }

  const url = `https://${SUBDOMAIN}.zendesk.com/api/v2/tickets.json`;
  const auth = Buffer.from(`${EMAIL}/token:${API_TOKEN}`).toString('base64');
  const payload = {
    ticket: {
      subject,
      comment: { body: description },
      priority,
      tags,
      ...(requesterEmail ? { requester: { name: requesterName || requesterEmail, email: requesterEmail } } : {}),
    },
  };

  console.log(`[zendesk] Creating real ticket via ${url} ...`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Zendesk API error ${res.status}: ${bodyText || res.statusText}`);
  }

  const data = await res.json();
  return {
    id: data.ticket.id,
    url: `https://${SUBDOMAIN}.zendesk.com/agent/tickets/${data.ticket.id}`,
    status: data.ticket.status,
    mock: false,
  };
}

module.exports = { createTicket, isConfigured };
