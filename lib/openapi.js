// OpenAPI 3.0 spec for the Bookly demo's REST API, served via swagger-ui-express
// at /api-docs (interactive UI) and /openapi.json (raw spec, e.g. for Postman
// import or codegen). Kept as a plain JS object rather than a YAML file so
// there's no extra parser dependency — just require() it.

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Bookly Support Agent API',
    version: '1.0.0',
    description:
      'REST API behind the Bookly demo: the chat endpoint used by the web UI/CLI, ' +
      'account auth (register/login/logout/password reset), and a sample-order ' +
      'creation/listing API for seeding test data. Bookly is a fictional bookstore ' +
      '— this is a local demo, not a production API.',
  },
  servers: [{ url: '/', description: 'This running server' }],
  tags: [
    { name: 'Chat', description: 'Talk to the support agent' },
    { name: 'Auth', description: 'Register, log in, log out, and reset passwords' },
    { name: 'Orders', description: 'Create and list orders (dev/test data utility)' },
    { name: 'Tickets', description: 'Zendesk support ticket escalation (real or mocked)' },
    { name: 'Admin', description: 'Agent Admin page: edit the system prompt, inspect tools, view live insights' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'opaque token',
        description:
          'Session token returned by /api/auth/login or /api/auth/register. Optional on ' +
          'most endpoints (anonymous use is allowed) but scopes results/actions to that ' +
          'account when present — e.g. order lookups are restricted to orders you own.',
      },
    },
    schemas: {
      OrderItem: {
        type: 'object',
        required: ['title', 'qty', 'price'],
        properties: {
          title: { type: 'string', example: 'The Hobbit' },
          qty: { type: 'integer', example: 1 },
          price: { type: 'number', format: 'float', example: 9.99 },
        },
      },
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'BK-10234' },
          username: { type: 'string', example: 'demo' },
          items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' } },
          total: { type: 'number', format: 'float', example: 23.98 },
          status: { type: 'string', enum: ['Processing', 'In Transit', 'Delivered', 'Refunded'] },
          carrier: { type: 'string', nullable: true, example: 'UPS' },
          trackingNumber: { type: 'string', nullable: true },
          orderDate: { type: 'string', format: 'date', nullable: true, example: '2026-07-24' },
          shippedDate: { type: 'string', format: 'date', nullable: true },
          deliveredDate: { type: 'string', format: 'date', nullable: true },
          eta: { type: 'string', format: 'date', nullable: true },
          refundedDate: { type: 'string', format: 'date', nullable: true, description: 'Set once a return/refund has been processed for this order.' },
        },
      },
      User: {
        type: 'object',
        properties: {
          username: { type: 'string', example: 'demo' },
          email: { type: 'string', format: 'email', example: 'demo@bookly.example' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Ticket: {
        type: 'object',
        properties: {
          id: { type: 'integer', example: 100234 },
          url: { type: 'string', example: 'https://your-subdomain.zendesk.com/agent/tickets/100234' },
          subject: { type: 'string' },
          description: { type: 'string' },
          requesterName: { type: 'string' },
          requesterEmail: { type: 'string', nullable: true },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          status: { type: 'string' },
          mock: { type: 'boolean', description: 'true when no real Zendesk credentials are configured (a realistic mock ticket was returned instead of calling Zendesk).' },
        },
      },
      Error: {
        type: 'object',
        properties: { error: { type: 'string', example: 'Something went wrong.' } },
      },
    },
  },
  paths: {
    '/api/chat': {
      post: {
        tags: ['Chat'],
        summary: 'Send a message to the support agent',
        security: [{}, { bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  sessionId: {
                    type: 'string',
                    description: 'Omit on the first call; echo back the value the server returns after that.',
                  },
                  message: { type: 'string', example: 'Where is my order BK-10234?' },
                  engine: { type: 'string', enum: ['llm', 'rules'], description: 'Which agent engine to use.' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Agent reply',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessionId: { type: 'string' },
                    engine: { type: 'string', enum: ['llm', 'rules'] },
                    username: { type: 'string', nullable: true },
                    reply: { type: 'string' },
                    meta: { type: 'object', nullable: true, properties: { tool: { type: 'string' } } },
                    note: { type: 'string', nullable: true, description: 'Fallback/guardrail explanation, if any.' },
                  },
                },
              },
            },
          },
          500: { description: 'Server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/reset': {
      post: {
        tags: ['Chat'],
        summary: 'Reset the conversation (or switch engines) for a session',
        security: [{}, { bearerAuth: [] }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  sessionId: { type: 'string' },
                  engine: { type: 'string', enum: ['llm', 'rules'] },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'New session state',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessionId: { type: 'string' },
                    engine: { type: 'string', enum: ['llm', 'rules'] },
                    username: { type: 'string', nullable: true },
                    note: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/api/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account (auto-logs-in on success)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'email', 'password'],
                properties: {
                  username: { type: 'string', example: 'jane_doe', description: '3-20 chars: letters, numbers, underscore.' },
                  email: { type: 'string', format: 'email', example: 'jane@example.com' },
                  password: { type: 'string', format: 'password', minLength: 8, example: 'correcthorsebattery' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Account created and logged in',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, token: { type: 'string' } } },
              },
            },
          },
          400: { description: 'Validation error (bad username/email/password, or already taken)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Log in with username + password',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'password'],
                properties: {
                  username: { type: 'string', example: 'demo' },
                  password: { type: 'string', format: 'password', example: 'password123' },
                },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Logged in',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, token: { type: 'string' } } },
              },
            },
          },
          401: { description: 'Incorrect username or password', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Invalidate the current session token',
        security: [{ bearerAuth: [] }],
        responses: { 200: { description: 'Always succeeds (idempotent)', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'Get the currently logged-in user',
        security: [{ bearerAuth: [] }],
        responses: {
          200: { description: 'Current user', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } } } } },
          401: { description: 'Not logged in', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/request-password-reset': {
      post: {
        tags: ['Auth'],
        summary: 'Request a password reset',
        description:
          'Always returns ok:true, whether or not the account exists (prevents user enumeration). ' +
          'Since this demo has no email service, devResetToken carries the reset token directly when ' +
          'the account exists — a production app would only ever email this, never return it.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', required: ['usernameOrEmail'], properties: { usernameOrEmail: { type: 'string', example: 'demo' } } },
            },
          },
        },
        responses: {
          200: {
            description: 'Request accepted',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { ok: { type: 'boolean' }, devResetToken: { type: 'string', nullable: true } } },
              },
            },
          },
        },
      },
    },
    '/api/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Complete a password reset with a valid token',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['token', 'newPassword'],
                properties: {
                  token: { type: 'string' },
                  newPassword: { type: 'string', format: 'password', minLength: 8 },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Password updated', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } },
          400: { description: 'Invalid/expired token or weak password', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/orders': {
      post: {
        tags: ['Orders'],
        summary: 'Create a sample order (dev/test data utility)',
        description: "Not customer-facing and not callable by the chat agent — this seeds test data you can then ask the chat about.",
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['username', 'status'],
                properties: {
                  username: { type: 'string', example: 'demo' },
                  status: { type: 'string', enum: ['Processing', 'In Transit', 'Delivered', 'Refunded'] },
                  items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' }, description: 'Defaults to one sample book if omitted.' },
                  carrier: { type: 'string', nullable: true },
                  trackingNumber: { type: 'string', nullable: true },
                  orderDate: { type: 'string', format: 'date' },
                  shippedDate: { type: 'string', format: 'date' },
                  deliveredDate: { type: 'string', format: 'date' },
                  eta: { type: 'string', format: 'date' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Order created', content: { 'application/json': { schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } } } } },
          400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Orders'],
        summary: 'List orders',
        parameters: [{ name: 'username', in: 'query', schema: { type: 'string' }, description: 'Filter to one customer.' }],
        responses: {
          200: { description: 'Matching orders', content: { 'application/json': { schema: { type: 'object', properties: { orders: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } } },
        },
      },
    },
    '/api/orders/{id}': {
      get: {
        tags: ['Orders'],
        summary: 'Get one order by ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'BK-10234' }],
        responses: {
          200: { description: 'The order', content: { 'application/json': { schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      put: {
        tags: ['Orders'],
        summary: 'Update an existing order (partial update)',
        description:
          'Only the fields you include are changed — anything omitted keeps its current value. ' +
          'Same validation as order creation for whichever fields are supplied. Setting status to ' +
          '"Refunded" without also setting refundedDate fills in today\'s date automatically. ' +
          "username, status, and items can't be cleared to null (they're required); other date/" +
          'string fields can be set to null to clear them.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, example: 'BK-10234' }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                description: 'All fields optional — include only what you want to change.',
                properties: {
                  username: { type: 'string' },
                  status: { type: 'string', enum: ['Processing', 'In Transit', 'Delivered', 'Refunded'] },
                  items: { type: 'array', items: { $ref: '#/components/schemas/OrderItem' }, description: 'Replaces the item list; total is recalculated from it.' },
                  carrier: { type: 'string', nullable: true },
                  trackingNumber: { type: 'string', nullable: true },
                  orderDate: { type: 'string', format: 'date', nullable: true },
                  shippedDate: { type: 'string', format: 'date', nullable: true },
                  deliveredDate: { type: 'string', format: 'date', nullable: true },
                  eta: { type: 'string', format: 'date', nullable: true },
                  refundedDate: { type: 'string', format: 'date', nullable: true },
                },
              },
              examples: {
                markShipped: { summary: 'Mark an order as shipped', value: { status: 'In Transit', carrier: 'UPS', shippedDate: '2026-07-29', eta: '2026-08-03' } },
                fixTypo: { summary: 'Fix an item title', value: { items: [{ title: 'The Hobbit', qty: 1, price: 9.99 }] } },
                reassignOwner: { summary: 'Reassign to a different customer', value: { username: 'alice' } },
              },
            },
          },
        },
        responses: {
          200: { description: 'Updated order', content: { 'application/json': { schema: { type: 'object', properties: { order: { $ref: '#/components/schemas/Order' } } } } } },
          400: { description: 'Validation error (bad status/date/items, unknown field, or tried to null a required field)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          404: { description: 'No order with that ID', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/order-statuses': {
      get: {
        tags: ['Orders'],
        summary: 'List the valid order status values',
        responses: {
          200: { description: 'Allowed statuses', content: { 'application/json': { schema: { type: 'object', properties: { statuses: { type: 'array', items: { type: 'string' } } } } } } },
        },
      },
    },
    '/api/support-tickets': {
      post: {
        tags: ['Tickets'],
        summary: 'Create a Zendesk support ticket (test/manual utility)',
        description:
          'Creates a ticket via the same helper the chat agent uses when a customer asks to escalate. ' +
          'Useful for testing the Zendesk integration directly, without a whole conversation. Returns a ' +
          'realistic mock ticket (mock: true) unless ZENDESK_SUBDOMAIN / ZENDESK_EMAIL / ZENDESK_API_TOKEN ' +
          'are all set, in which case it creates a real ticket in your Zendesk account.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  username: { type: 'string', nullable: true, description: 'Attributes the ticket to this account (and its email) if provided; omit for a guest ticket.' },
                  summary: { type: 'string', example: 'Order arrived damaged and customer is frustrated.' },
                  transcriptText: { type: 'string', description: 'Optional recent-conversation context to include in the ticket description.' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Ticket created', content: { 'application/json': { schema: { type: 'object', properties: { ticket: { $ref: '#/components/schemas/Ticket' } } } } } },
          500: { description: 'Zendesk API error (only possible in real, non-mock mode)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/support-tickets/config': {
      get: {
        tags: ['Tickets'],
        summary: 'Check whether real Zendesk credentials are configured',
        responses: {
          200: {
            description: 'Configuration status',
            content: { 'application/json': { schema: { type: 'object', properties: { zendeskConfigured: { type: 'boolean' } } } } },
          },
        },
      },
    },
    '/api/admin/system-prompt': {
      get: {
        tags: ['Admin'],
        summary: "Get the LLM engine's current system prompt",
        responses: {
          200: {
            description: 'Current prompt',
            content: { 'application/json': { schema: { type: 'object', properties: { prompt: { type: 'string' }, isCustomized: { type: 'boolean' }, default: { type: 'string' } } } } },
          },
        },
      },
      post: {
        tags: ['Admin'],
        summary: 'Save a new system prompt',
        description: "Persists to data/system-prompt.txt. Takes effect for the next new or reset session — not for conversations already in progress.",
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } },
        },
        responses: {
          200: { description: 'Saved', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, prompt: { type: 'string' } } } } } },
          400: { description: 'Empty prompt', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/admin/system-prompt/reset': {
      post: {
        tags: ['Admin'],
        summary: 'Delete the customized prompt and revert to the built-in default',
        responses: {
          200: { description: 'Reset', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, prompt: { type: 'string' } } } } } },
        },
      },
    },
    '/api/admin/tools': {
      get: {
        tags: ['Admin'],
        summary: 'List every tool registered with the LLM engine',
        description: 'Each tool is annotated with requiresLogin — tools requiring login are omitted from the API request entirely for logged-out sessions.',
        responses: {
          200: { description: 'Tool definitions', content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { type: 'object' } } } } } } },
        },
      },
    },
    '/api/admin/insights': {
      get: {
        tags: ['Admin'],
        summary: "Live snapshot of this server process's in-memory state",
        responses: {
          200: { description: 'Current stats', content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
    '/api/admin/test': {
      post: {
        tags: ['Admin'],
        summary: 'Send a message to an isolated sandbox conversation, optionally overriding the system prompt',
        description: 'Separate from real customer sessions. Multi-turn via testSessionId. Useful for iterating on a candidate prompt before saving it.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['message'],
                properties: {
                  testSessionId: { type: 'string', description: 'Omit on the first call to start a new sandbox conversation.' },
                  message: { type: 'string' },
                  prompt: { type: 'string', description: 'Raw system prompt override for this test session (e.g. unsaved textarea content).' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Reply', content: { 'application/json': { schema: { type: 'object', properties: { testSessionId: { type: 'string' }, reply: { type: 'string' } } } } } },
          400: { description: 'LLM engine unavailable, or empty message', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
  },
};
