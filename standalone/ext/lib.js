/**
 * standalone/ext/lib.js — shared helpers for the `ext` command group.
 *
 * ADDITIVE: nothing in the existing codebase is modified or required to
 * change in order to use this. See docs/COMMANDS.md §G.
 *
 * Two design rules:
 *   1. Domain neutrality — no command hardcodes a site, region, or
 *      form-field vocabulary. Everything arrives as a parameter.
 *   2. Browser work delegates to scripts/live.js via its documented
 *      `eval` verb, so we inherit its CDP connection, stealth init
 *      script, active agent tab and context selection instead of
 *      opening a second session.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

const LIVE_JS = path.resolve(__dirname, '..', '..', 'scripts', 'live.js');
const STORE_DIR = path.resolve(
  process.env.SERVERBROWSER_STORE || path.join(os.homedir(), '.config', 'serverbrowser')
);
const STORE_FILE = path.join(STORE_DIR, 'ext.json');

/* ---------------------------- arguments ---------------------------- */

/**
 * Split args into positionals and --flags.
 * Supports `--flag value`, `--flag=value`, `--bool`, `--no-bool`, and a
 * bare `--` terminator. Mirrors the flag syntax ai.js already accepts.
 */
function parseArgs(args) {
  const positional = [];
  const flags = {};
  let i = 0;
  for (; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--') { i += 1; break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }

    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (body.startsWith('no-')) { flags[body.slice(3)] = false; continue; }

    const next = args[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) { flags[body] = String(next); i += 1; }
    else flags[body] = true;
  }
  for (; i < args.length; i += 1) positional.push(String(args[i]));
  return { positional, flags };
}

/** Accept inline JSON or `@path`/`path` pointing at a .json file. */
function readJsonArg(value, label) {
  if (value === undefined || value === null) throw new Error(`missing ${label}`);
  const raw = String(value).trim();
  if (raw.startsWith('@')) return readJsonFile(raw.slice(1), label);
  try { return JSON.parse(raw); }
  catch { return readJsonFile(raw, label); }
}

function readJsonFile(file, label) {
  const p = path.resolve(file);
  if (!fs.existsSync(p)) throw new Error(`${label}: file not found: ${p}`);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`${label}: invalid JSON in ${p}: ${e.message}`); }
}

/* ----------------------------- output ----------------------------- */

const out = (data) => {
  if (data === undefined) return;
  process.stdout.write((typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '\n');
};

/** Uniform success envelope for agents. */
const ok = (cmd, result) => ({ ok: true, cmd, ...(result === undefined ? {} : { result }) });

/** Build a tagged error so the dispatcher can echo the failing command. */
const fail = (cmd, message, extra) =>
  Object.assign(new Error(message), { cmd, extra });

/* ------------------------------ store ----------------------------- */

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

/** Mutate the store under a 0700 dir / 0600 file, matching api-keys.js. */
function writeStore(mutate) {
  const data = readStore();
  mutate(data);
  try { fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* best effort */ }
  return data;
}

const storePath = () => ({ file: STORE_FILE, dir: STORE_DIR });

/* --------------------------- URL / host --------------------------- */

/** Public suffixes needing three labels to identify a registrable domain. */
const MULTI_PART_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
  'co.nz', 'co.jp', 'co.kr', 'co.in', 'com.br', 'com.mx', 'com.sg',
  'com.tr', 'com.cn', 'com.hk', 'com.tw', 'com.ar', 'com.pl', 'com.ua',
]);

/**
 * Normalise a URL into comparable parts: strip a leading "www.",
 * lowercase the host, derive a registrable-ish domain. The corpus
 * rewrote this seven times across five files; this is the one copy.
 */
function host(url) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  let parsed;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch { throw new Error(`host: not a URL: ${raw || '(empty)'}`); }

  const full = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const labels = full.split('.').filter(Boolean);
  let registrable = full;
  if (labels.length >= 3) {
    const lastTwo = labels.slice(-2).join('.');
    registrable = MULTI_PART_SUFFIX.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
  }
  return {
    input: raw,
    host: full,
    registrable,
    scheme: parsed.protocol.replace(':', ''),
    path: (parsed.pathname || '/').replace(/\/+$/, '') || '/',
    origin: parsed.origin,
  };
}

/** Best-effort host extraction from a record or bare string. */
function hostOf(record, field) {
  const candidate = typeof record === 'string'
    ? record
    : String((record && field && record[field] !== undefined ? record[field]
      : (record && (record.url || record.host || record.href || record.link))) || '');
  try { return host(candidate).host; } catch { return candidate.toLowerCase(); }
}

/* ---------------------------- utilities --------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a RegExp from user input; reports bad patterns clearly. */
function toRegExp(pattern, label) {
  if (pattern === undefined || pattern === null || pattern === true) return null;
  try { return new RegExp(String(pattern), 'i'); }
  catch (e) { throw new Error(`${label || 'pattern'}: invalid regular expression: ${e.message}`); }
}

/** Declarative filter over records; every criterion is a caller regex. */
function applyFilter(rows, flags) {
  const dropHost = toRegExp(flags['drop-host'], '--drop-host');
  const keepHost = toRegExp(flags['keep-host'], '--keep-host');
  const has = toRegExp(flags.has, '--has');
  const dropText = toRegExp(flags['drop-text'], '--drop-text');
  const minLen = flags['min-len'] === undefined ? null : Number(flags['min-len']);
  const field = flags.field ? String(flags.field) : null;

  const kept = [];
  const dropped = [];
  const reasons = { host: 0, has: 0, text: 0, length: 0 };

  for (const row of rows) {
    let reason = null;
    const text = JSON.stringify(row);
    if (!reason && dropHost && dropHost.test(hostOf(row, field))) reason = 'host';
    if (!reason && keepHost && !keepHost.test(hostOf(row, field))) reason = 'host';
    if (!reason && has && !has.test(text)) reason = 'has';
    if (!reason && dropText && dropText.test(text)) reason = 'text';
    if (!reason && minLen !== null && text.length < minLen) reason = 'length';

    if (reason) { reasons[reason] += 1; dropped.push(row); }
    else kept.push(row);
  }
  return { kept, dropped, reasons, input: rows.length, output: kept.length };
}

/** De-duplicate records by a field, by normalised host, or wholesale. */
function applyDedupe(rows, by) {
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    let key;
    if (by === 'host') key = hostOf(row, null);
    else if (by) key = String((row && row[by] !== undefined ? row[by] : ''));
    else key = JSON.stringify(row);
    if (seen.has(key)) duplicates.push(row);
    else seen.set(key, row);
  }
  return { unique: Array.from(seen.values()), duplicates, uniqueCount: seen.size };
}

/* ------------------------- browser bridge ------------------------- */

/**
 * Invoke one scripts/live.js verb and return its unwrapped `result`.
 * live.js prints { cmd, ok, result|error } per line; read the first
 * line, unwrap it, and throw on ok:false so callers can use try/catch.
 *
 * Delegating rather than opening our own CDP connection is what keeps
 * this add-on compatible: the ext commands inherit live.js's stealth
 * init script, active agent tab, context selection and local db- and
 * tunnel- prefixed path without any change to it.
 */
function live(args) {
  const safeArgs = (args || []).filter((a) => a !== undefined && a !== null).map(String);
  return new Promise((resolve, reject) => {
    const child = fork(LIVE_JS, safeArgs, { silent: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean)[0];
      let parsed = null;
      if (line) { try { parsed = JSON.parse(line); } catch { parsed = null; } }

      if (parsed && parsed.ok === false) {
        reject(new Error(parsed.error || `live.js ${safeArgs[0] || ''} failed`));
        return;
      }
      if (parsed) { resolve(parsed.result); return; }
      reject(new Error((stderr || stdout || '').trim() || `live.js exited ${code}`));
    });
  });
}

/**
 * Evaluate a page expression and return its value. live.js wraps input
 * as `new Function('return ((' + js + '))')`, so this is EXPRESSION
 * only — no statements, no top-level await.
 */
const evalInPage = (expression) => live(['eval', expression]);

/**
 * Run a function body in the page and return the value of its final
 * `return`. Works around the expression-only constraint by building an
 * IIFE expression. An optional JSON-serialisable arg is passed as the
 * single parameter.
 */
async function evalBody(fn, arg) {
  const iife = `(${fn.toString()})()`;
  return evalInPage(arg === undefined ? iife : `${iife}(${JSON.stringify(arg)})`);
}

module.exports = {
  parseArgs, readJsonArg, readJsonFile,
  out, ok, fail,
  readStore, writeStore, storePath,
  host, hostOf, MULTI_PART_SUFFIX,
  live, evalInPage, evalBody,
  sleep, toRegExp, applyFilter, applyDedupe,
  LIVE_JS, STORE_DIR, STORE_FILE,
};