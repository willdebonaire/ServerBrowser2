#!/usr/bin/env node
/**
 * standalone/commands/api-keys.js — API key management with secure storage.
 *
 * Keys live in ~/.config/serverbrowser/api-keys.json (directory 0700, file
 * 0600) so they are not world-readable and never end up in the repo. `get`
 * masks the key unless `--reveal` is passed, so printing a key is deliberate.
 *
 * Subcommands:
 *   set <provider> <key>      store a key
 *   get <provider> [--reveal] read it back (masked by default)
 *   list                      providers that have a key
 *   remove <provider>         delete a key
 *   path                      print the store location + permissions
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const STORE_PATH = path.resolve(os.homedir(), '.config', 'serverbrowser', 'api-keys.json');
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function ensureStore() {
  const dir = path.dirname(STORE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch (_) {}
  if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, JSON.stringify({}, null, 2), { mode: FILE_MODE });
  return STORE_PATH;
}

function readStore() {
  ensureStore();
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function writeStore(data) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: FILE_MODE });
  try { fs.chmodSync(STORE_PATH, FILE_MODE); } catch (_) {}
  return data;
}

function mask(key) {
  if (!key) return null;
  const s = String(key);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-4)} (${s.length} chars)`;
}

/** Programmatic accessor used by providers/ai.js and the commands. */
function getKey(provider) {
  const data = readStore();
  return data[provider] || null;
}

module.exports = {
  STORE_PATH,
  getKey,

  set: (provider, key) => {
    if (!provider) throw new Error('usage: api-keys set <provider> <key>');
    if (!key) throw new Error('refusing to store an empty key');
    const data = readStore();
    data[String(provider).toLowerCase()] = String(key);
    writeStore(data);
    return { provider: String(provider).toLowerCase(), set: true, stored: mask(key), file: STORE_PATH, mode: '0600' };
  },

  get: (provider, ...rest) => {
    if (!provider) throw new Error('usage: api-keys get <provider> [--reveal]');
    const reveal = rest.map(String).includes('--reveal');
    const key = getKey(String(provider).toLowerCase());
    if (!key) return { provider, key: null, present: false };
    return { provider, present: true, key: reveal ? key : mask(key), revealed: reveal };
  },

  list: () => {
    const data = readStore();
    return {
      store: STORE_PATH,
      providers: Object.keys(data).filter((k) => data[k]).map((k) => ({ provider: k, key: mask(data[k]) })),
    };
  },

  remove: (provider) => {
    if (!provider) throw new Error('usage: api-keys remove <provider>');
    const data = readStore();
    const existed = Boolean(data[provider]);
    delete data[provider];
    writeStore(data);
    return { provider, removed: existed };
  },

  path: () => {
    ensureStore();
    let mode = 'unknown';
    try { mode = (fs.statSync(STORE_PATH).mode & 0o777).toString(8).padStart(3, '0'); } catch (_) {}
    return { file: STORE_PATH, mode };
  },
};
