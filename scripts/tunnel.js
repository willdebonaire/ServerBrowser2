#!/usr/bin/env node
/**
 * tunnel.js — named tunnel management with password-protected ingress.
 *
 * Provider abstraction (cloudflare | ngrok | custom) that fronts a *local
 * password gate* (scripts/tunnel-auth-proxy.js) instead of exposing the raw
 * VNC/CDP port:
 *
 *     internet -> [provider tunnel] -> [auth proxy] -> target
 *
 * Because the CLI is one process per invocation, live state (pids, URL, target)
 * is persisted to datastore/tunnel-state.json so `tunnel-url`, `tunnel-route`
 * and `tunnel-stop` work in later invocations.
 *
 * Usage: node scripts/tunnel.js <command> [args...]
 *   tunnel-create <name> [password] [provider]   start proxy + tunnel
 *   tunnel-route  <target> [provider]            repoint the proxy
 *   tunnel-url    [provider]                     print the shareable URL
 *   tunnel-stop   [provider]                     stop both processes
 *   tunnel-status [provider]                     current state (JSON)
 *
 * Env:
 *   TUNNEL_PASSWORD        default password when none is passed
 *   TUNNEL_TARGET          default target (default http://127.0.0.1:6080)
 *   TUNNEL_PROXY_PORT      local auth-proxy port (default 6199)
 *   TUNNEL_CUSTOM_URL      public URL for the `custom` provider
 *   TUNNEL_URL_TIMEOUT_MS  how long to wait for a public URL (default 30000)
 *   CLOUDFLARED_BIN/NGROK_BIN  override binary paths
 *
 * Binaries are NOT bundled. If cloudflared/ngrok is missing the command fails
 * with install instructions — it never invents a URL.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STATE_PATH = path.resolve(ROOT, 'datastore', 'tunnel-state.json');
const PROXY_JS = path.resolve(__dirname, 'tunnel-auth-proxy.js');

const DEFAULT_TARGET = process.env.TUNNEL_TARGET || 'http://127.0.0.1:6080';
const DEFAULT_PROXY_PORT = Number(process.env.TUNNEL_PROXY_PORT || 6199);
const URL_TIMEOUT_MS = Number(process.env.TUNNEL_URL_TIMEOUT_MS || 30000);

const BINARIES = {
  cloudflare: {
    bin: process.env.CLOUDFLARED_BIN || 'cloudflared',
    install: 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  },
  ngrok: {
    bin: process.env.NGROK_BIN || 'ngrok',
    install: 'https://ngrok.com/download',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  // The state file carries the gate password, so keep it owner-only.
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_PATH, 0o600); } catch (_) {}
}

function clearProviderState(provider) {
  const state = readState();
  if (provider) delete state[provider];
  else Object.keys(state).forEach((k) => delete state[k]);
  writeState(state);
  return state;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function binaryExists(bin) {
  if (bin.includes('/')) return fs.existsSync(bin);
  return (process.env.PATH || '').split(':').some((d) => d && fs.existsSync(path.join(d, bin)));
}

function killPid(pid, signal) {
  if (!isAlive(pid)) return false;
  try {
    process.kill(pid, signal || 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/** Start (or reuse) the local password gate in front of `target`. */
async function ensureProxy({ target, password, port }) {
  if (!password) throw new Error('refusing to run the auth gate without a password');
  const current = readState().proxy;
  if (
    current &&
    isAlive(current.pid) &&
    current.target === target &&
    current.password === password &&
    current.port === port
  ) {
    return { ...current, created: false };
  }
  if (current && isAlive(current.pid)) {
    killPid(current.pid, 'SIGTERM');
    await sleep(300);
  }

  const child = spawn(process.execPath, [
    PROXY_JS,
    '--port', String(port),
    '--target', target,
    '--password', password,
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

  // Opt-in: append the gate's own stdout/stderr to a file. The default stdio is
  // a pipe to this process, which is closed as soon as this CLI exits.
  const debugLog = process.env.TUNNEL_DEBUG_LOG;
  if (debugLog) {
    const { createWriteStream } = require('fs');
    const sink = createWriteStream(debugLog, { flags: 'a' });
    child.stdout.pipe(sink);
    child.stderr.pipe(sink);
    child.on('exit', (code, signal) => sink.write(`\n[gate] exited code=${code} signal=${signal}\n`));
  }

  const ready = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error('auth proxy did not start within 5s ' + err.trim())), 5000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      const line = out.split('\n').filter(Boolean).pop();
      if (out.includes('"proxy":"listening"')) {
        clearTimeout(timer);
        try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error('auth proxy exited early (code ' + code + ') ' + err.trim())); });
  });

  child.unref();
  const record = {
    pid: child.pid,
    port: ready.port,
    target,
    password,
    url: 'http://127.0.0.1:' + ready.port,
    startedAt: new Date().toISOString(),
  };
  writeState({ ...readState(), proxy: record });
  return { ...record, created: true };
}

function proxyInfo() {
  const proxy = readState().proxy;
  if (!proxy || !isAlive(proxy.pid)) return null;
  return proxy;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function parseCloudflareUrl(text) {
  const m = String(text).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

function waitForUrl({ label, timeoutMs, produce }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      try {
        const url = await produce();
        if (url) return resolve(url);
      } catch (_) {}
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`${label}: timed out after ${timeoutMs}ms waiting for a public URL`));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

/**
 * Fail fast when a provider's binary is missing.
 *
 * Called *before* the shared password gate is touched: a missing cloudflared
 * must not re-point (or kill) a gate that another provider is still using.
 */
function assertProviderAvailable(provider) {
  const meta = BINARIES[provider];
  if (!meta) return;
  if (!binaryExists(meta.bin)) {
    throw new Error(
      `${meta.bin} not found (looked for "${meta.bin}" on PATH). Install it: ${meta.install}` +
      ' — or run with provider `custom` and set TUNNEL_CUSTOM_URL.'
    );
  }
}

async function startCloudflare({ proxyPort }) {
  assertProviderAvailable('cloudflare');
  const bin = BINARIES.cloudflare.bin;
  const child = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${proxyPort}`, '--no-autoupdate'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  let found = null;
  const capture = (d) => {
    buffer += d.toString();
    if (!found) found = parseCloudflareUrl(buffer);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise((_, reject) => {
    child.on('exit', (code) => reject(new Error('cloudflared exited with code ' + code + ': ' + buffer.slice(-300))));
  });
  try {
    const url = await Promise.race([
      waitForUrl({ label: 'cloudflared', timeoutMs: URL_TIMEOUT_MS, produce: async () => found }),
      exited,
    ]);
    child.unref();
    return { tunnelPid: child.pid, url, log: buffer.slice(-500) };
  } catch (e) {
    killPid(child.pid, 'SIGKILL');
    throw e;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function startNgrok({ proxyPort }) {
  assertProviderAvailable('ngrok');
  const bin = BINARIES.ngrok.bin;
  const apiPort = Number(process.env.NGROK_API_PORT || 4040);
  const child = spawn(bin, ['http', String(proxyPort), '--log', 'stdout'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buffer = '';
  const capture = (d) => { buffer += d.toString(); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const exited = new Promise((_, reject) => {
    child.on('exit', (code) => reject(new Error('ngrok exited with code ' + code + ': ' + buffer.slice(-300))));
  });
  try {
    const url = await Promise.race([
      waitForUrl({
        label: 'ngrok',
        timeoutMs: URL_TIMEOUT_MS,
        produce: async () => {
          const data = await fetchJson(`http://127.0.0.1:${apiPort}/api/tunnels`);
          const https = (data.tunnels || []).find((t) => String(t.public_url || '').startsWith('https://'));
          return https ? https.public_url : null;
        },
      }),
      exited,
    ]);
    child.unref();
    return { tunnelPid: child.pid, url, log: buffer.slice(-500) };
  } catch (e) {
    killPid(child.pid, 'SIGKILL');
    throw e;
  }
}

async function startCustom() {
  const url = process.env.TUNNEL_CUSTOM_URL || null;
  return {
    tunnelPid: null,
    url,
    log: url
      ? 'custom provider: using TUNNEL_CUSTOM_URL'
      : 'custom provider: no TUNNEL_CUSTOM_URL set — the password gate is running locally, but there is no public URL yet (point your own tunnel/reverse proxy at the proxy port).',
  };
}


// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function normalizeProvider(name) {
  const key = String(name || 'cloudflare').toLowerCase();
  if (!['cloudflare', 'ngrok', 'custom'].includes(key)) {
    throw new Error('unsupported tunnel provider: ' + key + '. Available: cloudflare, ngrok, custom');
  }
  return key;
}

async function tunnelStart(kind, opts) {
  const provider = normalizeProvider(kind);
  const password = opts.password || process.env.TUNNEL_PASSWORD || '';
  if (!password) {
    throw new Error('a tunnel password is required (pass it as the 2nd argument or set TUNNEL_PASSWORD)');
  }
  const target = opts.target || DEFAULT_TARGET;
  const port = Number(opts.port || DEFAULT_PROXY_PORT);

  // Validate the provider before the shared gate is re-pointed.
  assertProviderAvailable(provider);

  const proxy = await ensureProxy({ target, password, port });
  let started;
  try {
    if (provider === 'cloudflare') started = await startCloudflare({ proxyPort: port });
    else if (provider === 'ngrok') started = await startNgrok({ proxyPort: port });
    else started = await startCustom();
  } catch (e) {
    // Only tear the gate down if this attempt brought it up. It is shared, so a
    // failed cloudflare/ngrok start must not kill a running `custom` tunnel.
    if (proxy.created) {
      killPid(proxy.pid, 'SIGTERM');
      clearProviderState('proxy');
    }
    throw e;
  }

  const record = {
    provider,
    name: opts.name || '',
    passwordProtected: true,
    password,
    url: started.url,
    localUrl: proxy.url,
    target,
    proxyPort: proxy.port,
    proxyPid: proxy.pid,
    tunnelPid: started.tunnelPid,
    startedAt: new Date().toISOString(),
    note: started.url ? null : started.log,
  };
  writeState({ ...readState(), [provider]: record });
  return record;
}

async function tunnelStop(kind) {
  const provider = kind ? normalizeProvider(kind) : null;
  const state = readState();
  const targets = provider ? [provider] : Object.keys(state).filter((k) => k !== 'proxy');
  const stopped = [];
  for (const key of targets) {
    const rec = state[key];
    if (!rec) continue;
    killPid(rec.tunnelPid, 'SIGTERM');
    stopped.push({ provider: key, tunnelPid: rec.tunnelPid, killed: true });
  }
  const next = readState();
  if (provider) delete next[provider];
  else Object.keys(next).forEach((k) => delete next[k]);

  // The password gate is shared: only stop it when no tunnel is left running.
  const remainingTunnels = Object.keys(next).filter((k) => k !== 'proxy' && isAlive((next[k] || {}).tunnelPid));
  if (next.proxy && !remainingTunnels.length) {
    killPid(next.proxy.pid, 'SIGTERM');
    stopped.push({ provider: 'proxy', proxyPid: next.proxy.pid, killed: true });
    delete next.proxy;
  }
  writeState(next);
  return { stopped };
}

async function tunnelRoute(kind, target) {
  const provider = normalizeProvider(kind);
  const state = readState();
  const rec = state[provider];
  if (!rec || !isAlive(rec.proxyPid)) throw new Error(provider + ' tunnel is not running. Run tunnel-create first.');
  if (!target) throw new Error('tunnel-route requires a target URL, e.g. http://127.0.0.1:6080');
  // The gate's password lives in the proxy record (the provider record keeps a
  // copy too). Passing `undefined` here would spawn the gate with the literal
  // string "undefined" as its password and silently break every request.
  const password = rec.password || (state.proxy && state.proxy.password) || '';
  if (!password) throw new Error('no password on record for ' + provider + ' — run tunnel-create again');
  const proxy = await ensureProxy({ target, password, port: rec.proxyPort });
  const updated = { ...rec, password, target, proxyPid: proxy.pid, localUrl: proxy.url, routedAt: new Date().toISOString() };
  writeState({ ...readState(), [provider]: updated });
  return { provider, target, url: updated.url, localUrl: updated.localUrl, passwordProtected: true };
}

function tunnelUrl(kind) {
  const provider = normalizeProvider(kind);
  const rec = readState()[provider];
  if (!rec) throw new Error(provider + ' tunnel is not running. Run tunnel-create first.');
  return {
    provider,
    url: rec.url,
    localUrl: rec.localUrl,
    target: rec.target,
    passwordProtected: true,
    running: isAlive(rec.proxyPid),
    note: rec.note || null,
  };
}

function tunnelStatus(kind) {
  const provider = kind ? normalizeProvider(kind) : null;
  const state = readState();
  const keys = provider ? [provider] : Object.keys(state).filter((k) => k !== 'proxy');
  const proxy = state.proxy;
  return {
    proxy: proxy
      ? { port: proxy.port, pid: proxy.pid, target: proxy.target, running: isAlive(proxy.pid) }
      : null,
    providers: keys.map((key) => {
      const rec = state[key];
      if (!rec) return { provider: key, running: false };
      return {
        provider: key,
        running: isAlive(rec.proxyPid) && (rec.tunnelPid ? isAlive(rec.tunnelPid) : true),
        url: rec.url,
        localUrl: rec.localUrl,
        target: rec.target,
        proxyPort: rec.proxyPort,
        passwordProtected: true,
        tunnelPid: rec.tunnelPid,
        proxyPid: rec.proxyPid,
      };
    }),
  };
}

function createProvider(name) {
  const kind = normalizeProvider(name);
  return {
    name: kind,
    create: () => createProvider(kind),
    start: async (opts) => tunnelStart(kind, {
      name: (opts && opts.name) || '',
      password: (opts && opts.password) || '',
      target: opts && opts.target,
      port: opts && opts.port,
    }),
    stop: async () => ({ stopped: true, ...(await tunnelStop(kind)) }),
    route: async (opts) => tunnelRoute(kind, opts && opts.target),
    url: async () => tunnelUrl(kind),
    status: async () => tunnelStatus(kind),
  };
}

function resolveProvider(name) {
  return createProvider(name);
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function result(name, data) { fs.writeSync(1, JSON.stringify({ cmd: name, ok: true, result: data }) + '\n'); }
function error(name, e) { fs.writeSync(1, JSON.stringify({ cmd: name, ok: false, error: String((e && e.message) || e) }) + '\n'); }

/** Never print the gate password: it is stored in the state file (0600) only. */
function redact(record) {
  if (!record || typeof record !== 'object') return record;
  const { password, ...rest } = record;
  return { ...rest, passwordSet: Boolean(password) };
}

async function run(name, args) {
  const [a0, a1, a2] = args;
  switch (name) {
    case 'tunnel-create':
      return result(name, redact(await tunnelStart(a2 || 'cloudflare', {
        name: a0 || '',
        password: a1 || '',
        target: process.env.TUNNEL_TARGET,
        port: process.env.TUNNEL_PROXY_PORT,
      })));
    case 'tunnel-route':
      return result(name, redact(await tunnelRoute(a1 || 'cloudflare', a0)));
    case 'tunnel-url':
      return result(name, redact(tunnelUrl(a0 || 'cloudflare')));
    case 'tunnel-status':
      return result(name, redact(tunnelStatus(a0)));
    case 'tunnel-stop':
      return result(name, await tunnelStop(a0));
    default:
      throw new Error('unknown tunnel command: ' + name);
  }
}

function showHelp() {
  fs.writeSync(1, [
    'tunnel.js — named tunnels with password-protected ingress',
    '',
    'Usage: node scripts/tunnel.js <command> [args...]',
    '',
    'Commands:',
    '  tunnel-create <name> [password] [provider]   start auth proxy + tunnel (provider defaults to cloudflare)',
    '  tunnel-route <target> [provider]             repoint the password gate at a new local target',
    '  tunnel-url [provider]                        print the shareable URL + auth requirements',
    '  tunnel-status [provider]                     show running state (JSON)',
    '  tunnel-stop [provider]                       stop the tunnel (and the proxy when idle)',
    '',
    'Providers:',
    '  cloudflare   cloudflared quick tunnel   (needs the cloudflared binary)',
    '  ngrok        ngrok http                 (needs the ngrok binary)',
    '  custom       bring your own tunnel      (set TUNNEL_CUSTOM_URL)',
    '',
    'Env: TUNNEL_PASSWORD, TUNNEL_TARGET, TUNNEL_PROXY_PORT, TUNNEL_CUSTOM_URL, TUNNEL_URL_TIMEOUT_MS',
    '',
    'Examples:',
    '  node scripts/tunnel.js tunnel-create my-session s3cret custom',
    '  node scripts/tunnel.js tunnel-route http://127.0.0.1:6080 custom',
    '  node scripts/tunnel.js tunnel-url custom',
    '  node scripts/tunnel.js tunnel-stop custom',
    '',
    'Every request must carry the password (HTTP Basic, or ?pw=PASSWORD for noVNC/WebSockets).',
    '',
  ].join('\n') + '\n');
}

async function exec(name, args) {
  try { await run(name, args); } catch (e) { error(name, e); }
}

if (require.main === module) {
  const cmd = process.argv[2];
  const args = process.argv.slice(3).filter((a) => a !== '--stdin');

  if (!cmd || cmd === '--help' || cmd === '-h') {
    showHelp();
    process.exit(0);
  }

  if (process.argv.includes('--stdin')) {
    const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let q;
      try { q = JSON.parse(line); } catch { q = { cmd: line.split(' ')[0], args: line.split(' ').slice(1) }; }
      const c = String(q.cmd);
      const a = (q.args || []).map(String).filter((s) => s !== '');
      chain = chain.then(() => exec(c, a));
    });
    rl.on('close', () => chain.then(() => process.exit(0)));
  } else {
    exec(cmd, args).then(() => process.exit(0)).catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
  }
}

module.exports = {
  STATE_PATH,
  run,
  resolveProvider,
  createProvider,
  tunnelStart,
  tunnelStop,
  tunnelRoute,
  tunnelUrl,
  tunnelStatus,
  ensureProxy,
};

