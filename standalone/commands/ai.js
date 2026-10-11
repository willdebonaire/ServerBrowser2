#!/usr/bin/env node
/**
 * standalone/commands/ai.js — AI calls through the provider abstraction.
 *
 * Subcommands:
 *   providers                     list providers + whether a key is available
 *   ping [provider]               cheap round-trip (uses `echo` by default)
 *   chat <provider> <prompt>      one-shot completion
 *        [--model M] [--system S] [--max-tokens N] [--temperature T]
 *
 * Keys come from the 0600 store or env — see standalone/providers/ai.js.
 */
const ai = require('../providers/ai.js');

/** Pull --flag value pairs out of the argument list. */
function splitFlags(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = args[i + 1] !== undefined && !String(args[i + 1]).startsWith('--') ? args[++i] : true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

module.exports = {
  providers: () => ({
    providers: ai.listProviders().map((name) => {
      const { key, source } = ai.resolveKey(name);
      return { provider: name, keyAvailable: !!key, keySource: source };
    }),
    store: ai.STORE_PATH,
  }),

  ping: async (provider) => {
    const target = provider || 'echo';
    const res = await ai.chat({ provider: target, prompt: 'ping' });
    return { ok: true, ...res };
  },

  chat: async (provider, prompt, ...rest) => {
    const { positional, flags } = splitFlags([prompt, ...rest].filter((a) => a !== undefined));
    const text = positional.join(' ').trim();
    if (!provider) throw new Error('usage: ai chat <provider> <prompt> [--model M] [--system S]');
    if (!text) throw new Error('ai chat requires a prompt');
    const res = await ai.chat({
      provider,
      prompt: text,
      model: flags.model,
      system: flags.system,
      maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : undefined,
      temperature: flags.temperature != null ? Number(flags.temperature) : undefined,
    });
    return res;
  },
};
