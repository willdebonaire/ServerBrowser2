#!/usr/bin/env node
/**
 * providers/ai.js — provider abstraction for LLM calls in the standalone app.
 *
 * Every provider implements the same shape:
 *   chat({ prompt, system, model, maxTokens, temperature }) -> { provider, model, text, usage }
 *
 * API keys come from (in order) the secure key store
 * (~/.config/serverbrowser/api-keys.json, 0600) or the provider's env var.
 * Base URLs are overridable with *_BASE_URL so the same code can target a
 * gateway, a self-hosted model, or a test double.
 *
 * `echo` is an offline provider: no network, no key, deterministic reply — it
 * exists so the CLI and its tests work without credentials.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_PATH = path.resolve(os.homedir(), '.config', 'serverbrowser', 'api-keys.json');

function envKeyFor(provider) {
  return ({
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    ollama: 'OLLAMA_API_KEY',
  })[provider];
}

/** Read a key from the 0600 key store, then the environment. */
function resolveKey(provider) {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (data && data[provider]) return { key: data[provider], source: 'store' };
  } catch (_) {}
  const envName = envKeyFor(provider);
  if (envName && process.env[envName]) return { key: process.env[envName], source: 'env:' + envName };
  return { key: null, source: null };
}

async function postJson(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const detail = (json && ((json.error && (json.error.message || json.error)) || json.message)) || text.slice(0, 300);
    throw new Error(`${url} -> HTTP ${res.status}: ${detail}`);
  }
  return json;
}

const echoProvider = {
  name: 'echo',
  requiresKey: false,
  defaultModel: 'echo-1',
  async chat({ prompt, model, system }) {
    const text = `echo: ${system ? '[' + system + '] ' : ''}${prompt}`;
    return { provider: 'echo', model: model || this.defaultModel, text, usage: { inputTokens: prompt.length, outputTokens: text.length } };
  },
};

const openaiProvider = {
  name: 'openai',
  requiresKey: true,
  defaultModel: 'gpt-4o-mini',
  async chat({ prompt, model, system, maxTokens, temperature }) {
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    const body = {
      model: model || this.defaultModel,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      ...(temperature != null ? { temperature } : {}),
    };
    const data = await postJson(base + '/chat/completions', body, { Authorization: 'Bearer ' + this._key });
    const choice = (data.choices || [])[0] || {};
    return {
      provider: 'openai',
      model: data.model || body.model,
      text: (choice.message && choice.message.content) || '',
      usage: data.usage || null,
    };
  },
};

const anthropicProvider = {
  name: 'anthropic',
  requiresKey: true,
  defaultModel: 'claude-3-5-haiku-latest',
  async chat({ prompt, model, system, maxTokens, temperature }) {
    const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const body = {
      model: model || this.defaultModel,
      max_tokens: maxTokens || 1024,
      messages: [{ role: 'user', content: prompt }],
      ...(system ? { system } : {}),
      ...(temperature != null ? { temperature } : {}),
    };
    const data = await postJson(base + '/v1/messages', body, {
      'x-api-key': this._key,
      'anthropic-version': '2023-06-01',
    });
    const block = (data.content || []).find((b) => b.type === 'text') || {};
    return {
      provider: 'anthropic',
      model: data.model || body.model,
      text: block.text || '',
      usage: data.usage || null,
    };
  },
};

const ollamaProvider = {
  name: 'ollama',
  requiresKey: false,
  defaultModel: process.env.OLLAMA_MODEL || 'llama3.1',
  async chat({ prompt, model, system, temperature }) {
    const base = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const body = {
      model: model || this.defaultModel,
      stream: false,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt },
      ],
      ...(temperature != null ? { options: { temperature } } : {}),
    };
    const data = await postJson(base + '/api/chat', body, {});
    return {
      provider: 'ollama',
      model: data.model || body.model,
      text: (data.message && data.message.content) || '',
      usage: data.eval_count ? { outputTokens: data.eval_count, inputTokens: data.prompt_eval_count } : null,
    };
  },
};

const PROVIDERS = {
  echo: echoProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  ollama: ollamaProvider,
};

function listProviders() {
  return Object.keys(PROVIDERS);
}

/**
 * Resolve a provider and make sure its credentials are present.
 * Throws an actionable error instead of failing deep inside fetch.
 */
function resolveProvider(name) {
  const key = String(name || 'openai').toLowerCase();
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`unknown AI provider: ${key}. Available: ${listProviders().join(', ')}`);
  }
  const { key: apiKey, source } = resolveKey(key);
  if (provider.requiresKey && !apiKey) {
    const envName = envKeyFor(key);
    throw new Error(
      `no API key for ${key}. Set one with \`node standalone/index.js api-keys set ${key} <key>\`` +
      (envName ? ` or export ${envName}=...` : '')
    );
  }
  return { ...provider, _key: apiKey, keySource: source };
}

async function chat({ provider, prompt, ...rest }) {
  if (!prompt) throw new Error('chat requires a prompt');
  const p = resolveProvider(provider);
  const res = await p.chat({ prompt, ...rest });
  return { ...res, keySource: p.keySource };
}

module.exports = {
  STORE_PATH,
  PROVIDERS,
  listProviders,
  resolveProvider,
  resolveKey,
  chat,
};
