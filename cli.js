#!/usr/bin/env node
try {
  require('dotenv').config();
} catch (err) {
  // dotenv is optional.
}

const readline = require('readline');
const { createAgent } = require('./lib/agentFactory');

const requestedEngine = process.env.AGENT_ENGINE || (process.argv.includes('--rules') ? 'rules' : (process.env.ANTHROPIC_API_KEY ? 'llm' : 'rules'));
const { agent, engine, note } = createAgent(requestedEngine);

console.log('==============================================');
console.log(' Bookly Customer Support — CLI demo');
console.log(` Engine: ${engine}${engine === 'llm' ? ` (model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'})` : ''}`);
console.log(' Type your message and press Enter. Type "exit" to quit.');
console.log(' (Run with --rules to force the rule-based engine, or set');
console.log('  ANTHROPIC_API_KEY / AGENT_ENGINE=llm to use Claude.)');
console.log('==============================================\n');
if (note) console.log(`Note: ${note}\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'You: ' });

console.log("Bookly: Hi, I'm the Bookly support assistant! How can I help today?\n");
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (/^(exit|quit)$/i.test(text)) {
    console.log('Bookly: Take care!');
    rl.close();
    return;
  }
  try {
    const { reply } = await agent.handleMessage(text);
    console.log(`Bookly: ${reply}\n`);
  } catch (err) {
    console.error('Bookly: (error)', err.message || err);
  }
  rl.prompt();
});

rl.on('close', () => process.exit(0));
