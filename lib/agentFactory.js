const { BooklyAgent } = require('./agent');
const { LLMBooklyAgent, MissingApiKeyError } = require('./llmAgent');

/**
 * Creates an agent for the requested engine ('llm' or 'rules').
 * `options.username`, when set, personalizes the agent for a logged-in user
 * (skips asking for order numbers on "my orders", etc.) in both engines.
 * Returns { agent, engine, note } where `engine` is what was actually used
 * (it may fall back to 'rules' if the LLM engine can't be constructed) and
 * `note` is an optional human-readable explanation of any fallback.
 */
function createAgent(requestedEngine, options = {}) {
  const engine = (requestedEngine || 'rules').toLowerCase();
  const { username } = options;

  if (engine === 'llm') {
    try {
      return { agent: new LLMBooklyAgent({ username }), engine: 'llm', note: null };
    } catch (err) {
      if (err instanceof MissingApiKeyError) {
        return {
          agent: new BooklyAgent({ username }),
          engine: 'rules',
          note: `Couldn't start the LLM engine (${err.message}) — falling back to the rule-based engine. Set ANTHROPIC_API_KEY to use Claude.`,
        };
      }
      throw err;
    }
  }

  return { agent: new BooklyAgent({ username }), engine: 'rules', note: null };
}

module.exports = { createAgent };
