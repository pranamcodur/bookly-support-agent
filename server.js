try {
  require('dotenv').config();
} catch (err) {
  // dotenv is optional — env vars can also be set directly in the shell.
}

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createAgent } = require('./lib/agentFactory');
const auth = require('./lib/auth');
const orderStore = require('./lib/orderStore');
const openapiSpec = require('./lib/openapi');
const ticketHelper = require('./lib/ticketHelper');
const zendesk = require('./lib/zendesk');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// API docs: interactive Swagger UI at /api-docs, raw spec at /openapi.json
// (handy for Postman/Insomnia import or codegen). Degrades gracefully if
// swagger-ui-express isn't installed, same pattern as the dotenv/Anthropic
// SDK optional-dependency handling elsewhere in this file.
app.get('/openapi.json', (req, res) => res.json(openapiSpec));
try {
  const swaggerUi = require('swagger-ui-express');
  app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
    customSiteTitle: 'Bookly API docs',
  }));
} catch (err) {
  app.get('/api-docs', (req, res) => {
    res.status(501).send(
      "Swagger UI isn't installed. Run `npm install` (adds swagger-ui-express), then restart the server. " +
      'In the meantime, the raw spec is available at /openapi.json.'
    );
  });
}

const DEFAULT_ENGINE = process.env.AGENT_ENGINE || (process.env.ANTHROPIC_API_KEY ? 'llm' : 'rules');

// In-memory session store: sessionId -> { agent, engine, username }.
// Fine for a local demo; a real deployment would persist/expire these.
const sessions = new Map();

function usernameFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return auth.getUsernameForToken(token);
}

function getOrCreateSession(sessionId, requestedEngine, username) {
  const id = sessionId || crypto.randomUUID();
  const engine = (requestedEngine || DEFAULT_ENGINE).toLowerCase();
  const existing = sessions.get(id);

  if (existing && existing.engine === engine && existing.username === username) {
    return { id, session: existing, note: null };
  }

  // No session yet, engine switched, or the logged-in user changed: start fresh.
  const { agent, engine: actualEngine, note } = createAgent(engine, { username });
  const session = { agent, engine: actualEngine, username };
  sessions.set(id, session);
  return { id, session, note };
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.post('/api/chat', async (req, res) => {
  try {
    const { sessionId, message, engine } = req.body || {};
    const username = usernameFromRequest(req);
    const { id, session, note } = getOrCreateSession(sessionId, engine, username);
    const result = await session.agent.handleMessage(message);
    res.json({
      sessionId: id,
      engine: session.engine,
      username: session.username,
      reply: result.reply,
      meta: result.meta || null,
      note: note || result.note || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong handling that message.' });
  }
});

app.post('/api/reset', (req, res) => {
  const { sessionId, engine } = req.body || {};
  const username = usernameFromRequest(req);
  const id = sessionId || crypto.randomUUID();
  const { agent, engine: actualEngine, note } = createAgent(engine || DEFAULT_ENGINE, { username });
  sessions.set(id, { agent, engine: actualEngine, username });
  res.json({ sessionId: id, engine: actualEngine, username, note: note || null });
});

// ---------------------------------------------------------------------------
// Auth: register, login, logout, password reset
// ---------------------------------------------------------------------------

app.post('/api/auth/register', (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    const user = auth.register({ username, email, password });
    const { token, user: loggedInUser } = auth.login({ username, password });
    res.json({ user: loggedInUser, token });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    const { token, user } = auth.login({ username, password });
    res.json({ user, token });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) auth.logout(token);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const username = usernameFromRequest(req);
  if (!username) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ user: auth.getUser(username) });
});

app.post('/api/auth/request-password-reset', (req, res) => {
  try {
    const { usernameOrEmail } = req.body || {};
    const result = auth.requestPasswordReset({ usernameOrEmail });
    // devResetToken is a local-dev convenience since there's no real email
    // service wired up — a production app would email the link instead of
    // ever returning it to the client.
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
  }
});

app.post('/api/auth/reset-password', (req, res) => {
  try {
    const { token, newPassword } = req.body || {};
    const result = auth.resetPassword({ token, newPassword });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Reset failed.' });
  }
});

// ---------------------------------------------------------------------------
// Orders: sample-data creation/listing (dev/test utility, not customer-facing)
// ---------------------------------------------------------------------------

app.post('/api/orders', (req, res) => {
  try {
    const order = orderStore.createOrder(req.body || {});
    res.status(201).json({ order });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not create order.' });
  }
});

app.get('/api/orders', (req, res) => {
  const { username } = req.query;
  res.json({ orders: orderStore.listOrders({ username }) });
});

app.get('/api/orders/:id', (req, res) => {
  const order = orderStore.getOrder(req.params.id.toUpperCase());
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json({ order });
});

app.put('/api/orders/:id', (req, res) => {
  try {
    const order = orderStore.updateOrder(req.params.id.toUpperCase(), req.body || {});
    res.json({ order });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not update order.' });
  }
});

app.get('/api/order-statuses', (req, res) => {
  res.json({ statuses: orderStore.ORDER_STATUSES });
});

// ---------------------------------------------------------------------------
// Support tickets: manual test endpoint for the Zendesk integration (real or
// mocked), independent of the chat flow — handy for verifying credentials
// without going through a whole conversation first.
// ---------------------------------------------------------------------------

app.post('/api/support-tickets', async (req, res) => {
  try {
    const { username, summary, transcriptText } = req.body || {};
    const ticket = await ticketHelper.createSupportTicket({ username: username || null, summary, transcriptText });
    res.status(201).json({ ticket });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not create ticket.' });
  }
});

app.get('/api/support-tickets/config', (req, res) => {
  res.json({ zendeskConfigured: zendesk.isConfigured() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bookly support agent demo running at http://localhost:${PORT}`);
  console.log(`API docs: http://localhost:${PORT}/api-docs (raw spec: /openapi.json)`);
  console.log(`Default engine: ${DEFAULT_ENGINE}${DEFAULT_ENGINE === 'llm' ? ` (model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'})` : ''}`);
  console.log(`Zendesk: ${zendesk.isConfigured() ? 'real tickets (credentials found)' : 'MOCK mode (set ZENDESK_SUBDOMAIN/EMAIL/API_TOKEN for real tickets)'}`);
  console.log('Seeded demo account — username: demo / password: password123');
});
