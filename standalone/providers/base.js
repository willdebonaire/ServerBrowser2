#!/usr/bin/env node
/**
 * standalone/providers/base.js — provider registry for the standalone app.
 *
 * Two kinds of providers are exposed through one entry point:
 *   tunnel providers  — cloudflare | ngrok | custom  (scripts/tunnel.js)
 *   AI providers      — echo | openai | anthropic | ollama (./ai.js)
 *
 * (The original version pointed at `../scripts/tunnel.js`, which resolved to
 * standalone/scripts/... and threw MODULE_NOT_FOUND.)
 */
const path = require('path');

const TUNNEL_PROVIDERS = ['cloudflare', 'ngrok', 'custom'];

/** Load the tunnel module lazily so requiring this file never spawns anything. */
function tunnelModule() {
  return require(path.resolve(__dirname, '..', '..', 'scripts', 'tunnel.js'));
}

const ai = require('./ai.js');

module.exports = {
  createProvider: (name) => {
    if (!TUNNEL_PROVIDERS.includes(name)) {
      throw new Error('unknown tunnel provider: ' + name + '. Available: ' + TUNNEL_PROVIDERS.join(', '));
    }
    return tunnelModule().resolveProvider(name);
  },
  listProviders: () => [...TUNNEL_PROVIDERS],
  ai,
  createAiProvider: (name) => ai.resolveProvider(name),
  listAiProviders: () => ai.listProviders(),
};
