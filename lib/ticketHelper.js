// Shared by both engines: builds a Zendesk ticket payload from conversation
// context and creates it via lib/zendesk.js. Keeping this in one place means
// the rule-based and LLM engines produce consistent, comparable tickets.

const zendesk = require('./zendesk');
const auth = require('./auth');

/**
 * @param {object} input
 * @param {string|null} input.username - logged-in username, or null for guests
 * @param {string} [input.summary] - short summary of the issue (from the LLM, or omitted for rules)
 * @param {string} [input.transcriptText] - recent conversation, newline-separated
 */
async function createSupportTicket({ username, summary, transcriptText }) {
  const user = username ? auth.getUser(username) : null;

  const descriptionParts = [
    'Support ticket opened by the Bookly chat assistant on the customer\'s request.',
    summary ? `\nSummary: ${summary}` : null,
    transcriptText ? `\nRecent conversation:\n${transcriptText}` : null,
  ].filter(Boolean);

  const ticket = await zendesk.createTicket({
    subject: `Bookly support escalation${username ? ` — ${username}` : ' (guest)'}`,
    description: descriptionParts.join('\n'),
    requesterName: username || 'Guest',
    requesterEmail: user ? user.email : undefined,
    priority: 'normal',
    tags: ['chatbot-escalation'],
  });

  return ticket;
}

module.exports = { createSupportTicket };
