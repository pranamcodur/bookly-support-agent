try {
  require('dotenv').config();
} catch (err) {
  // dotenv is optional — env vars can also be set directly in the shell.
}

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { createAgent } = require('./lib/agentFactory');
const { LLMBooklyAgent, MissingApiKeyError, ALL_TOOLS } = require('./lib/llmAgent');
const systemPromptStore = require('./lib/systemPromptStore');
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

// Agent Admin page — clean URL (matches the /api-docs pattern) rather than
// relying on the static middleware serving it at /agent-admin.html.
app.get('/agent-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agent-admin.html'));
});

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

// ---------------------------------------------------------------------------
// Agent Admin: view/edit the LLM engine's system prompt (persisted to
// data/system-prompt.txt), inspect the registered tools, see live
// operational insights, and run isolated test conversations against a
// candidate prompt before saving it. This bypasses agentFactory/sessions
// deliberately — it's a dev tool for iterating on the prompt, not part of
// the customer-facing chat path.
// ---------------------------------------------------------------------------

app.get('/api/admin/system-prompt', (req, res) => {
  res.json({
    prompt: systemPromptStore.getSystemPrompt(),
    isCustomized: systemPromptStore.isCustomized(),
    default: systemPromptStore.DEFAULT_SYSTEM_PROMPT,
  });
});

app.post('/api/admin/system-prompt', (req, res) => {
  try {
    const { prompt } = req.body || {};
    const saved = systemPromptStore.saveSystemPrompt(prompt);
    res.json({ ok: true, prompt: saved });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Could not save prompt.' });
  }
});

app.post('/api/admin/system-prompt/reset', (req, res) => {
  const prompt = systemPromptStore.resetSystemPrompt();
  res.json({ ok: true, prompt });
});

app.get('/api/admin/tools', (req, res) => {
  res.json({ tools: ALL_TOOLS });
});

app.get('/api/admin/insights', (req, res) => {
  const sessionList = [...sessions.values()];
  const sessionsByEngine = sessionList.reduce((acc, s) => {
    acc[s.engine] = (acc[s.engine] || 0) + 1;
    return acc;
  }, {});
  const orders = orderStore.listOrders();
  const ordersByStatus = orders.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});

  res.json({
    activeSessions: sessionList.length,
    sessionsByEngine,
    loggedInSessions: sessionList.filter((s) => s.username).length,
    guestSessions: sessionList.filter((s) => !s.username).length,
    totalOrders: orders.length,
    ordersByStatus,
    zendeskConfigured: zendesk.isConfigured(),
    systemPromptCustomized: systemPromptStore.isCustomized(),
    defaultEngine: DEFAULT_ENGINE,
  });
});

// One agent per admin browser tab's test conversation, keyed by a
// client-generated testSessionId — separate from the real `sessions` map so
// experimenting here can never collide with an actual customer session.
const testSessions = new Map();

app.post('/api/admin/test', async (req, res) => {
  try {
    const { testSessionId, message, prompt } = req.body || {};
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'message is required.' });
    }
    const id = testSessionId || crypto.randomUUID();
    let agent = testSessions.get(id);
    if (!agent) {
      agent = new LLMBooklyAgent({ username: null });
      testSessions.set(id, agent);
    }
    // Override with whatever's currently in the admin textarea (saved or
    // not) — this is what lets you test a draft before committing to it.
    // Raw override: no login-state suffix, so what you see in the box is
    // exactly what gets sent as the system prompt.
    if (typeof prompt === 'string' && prompt.trim()) {
      agent.system = prompt;
    }
    const result = await agent.handleMessage(message);
    res.json({ testSessionId: id, ...result });
  } catch (err) {
    if (err instanceof MissingApiKeyError) {
      return res.status(400).json({ error: `LLM engine unavailable: ${err.message}` });
    }
    console.error(err);
    res.status(500).json({ error: 'Test failed.' });
  }
});

app.post('/api/admin/test/reset', (req, res) => {
  const { testSessionId } = req.body || {};
  if (testSessionId) testSessions.delete(testSessionId);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bookly support agent demo running at http://localhost:${PORT}`);
  console.log(`Agent Admin: http://localhost:${PORT}/agent-admin`);
  console.log(`API docs: http://localhost:${PORT}/api-docs (raw spec: /openapi.json)`);
  console.log(`Default engine: ${DEFAULT_ENGINE}${DEFAULT_ENGINE === 'llm' ? ` (model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'})` : ''}`);
  console.log(`Zendesk: ${zendesk.isConfigured() ? 'real tickets (credentials found)' : 'MOCK mode (set ZENDESK_SUBDOMAIN/EMAIL/API_TOKEN for real tickets)'}`);
  console.log('Seeded demo account — username: demo / password: password123');
});
