'use strict';
/**
 * panel-server.js — the control panel HTTP server (P0).
 * Plain Node `http` (no Express, per repo dependency set): static UI from
 * control/public/ + JSON API + SSE events. Binds 127.0.0.1 by default
 * (PANEL_ADDR/PANEL_PORT env). Auth/CSRF hardening lands in phase P6.
 *
 * API (all JSON, jobs return 202 + {job}):
 *   GET    /api/health
 *   GET    /api/sessions                     POST /api/sessions
 *   GET    /api/sessions/:name               DELETE /api/sessions/:name
 *   GET    /api/sessions/:name/status        POST /api/sessions/:name/restart
 *   GET    /api/sessions/:name/logs?tail=N   GET  /api/sessions/:name/viewer-url
 *   PUT    /api/sessions/:name/vnc-password  DELETE /api/sessions/:name/vnc-password
 *   PATCH  /api/sessions/:name/settings
 *   GET    /api/jobs/:id                     GET  /api/events  (SSE)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const manager = require('./lib/session-manager');
const scriptManager = require('./lib/script-manager');
const browserRegistry = require('./lib/browser-registry');
const { snapshot } = require('./lib/snapshot');
const { audit } = require('./lib/audit');
const state = require('./lib/state');

const PORT = parseInt(process.env.PANEL_PORT, 10) || 6180;

// Support --addr flag, then PANEL_ADDR env var, then default to 127.0.0.1
let ADDR = '127.0.0.1';
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--addr' && i + 1 < process.argv.length) {
    ADDR = process.argv[i + 1];
    break;
  }
}
if (!process.env.PANEL_ADDR) {
  ADDR = ADDR; // use flag or default
} else {
  ADDR = process.env.PANEL_ADDR;
}
const PUBLIC = path.join(__dirname, 'public');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

manager.init();
scriptManager.init();
browserRegistry.init();

/* ------------------------------------------------------------ auth (F9) */
/* Token: PANEL_TOKEN env, or generated once into datastore/panel-state.json
 * (0600). Auth pattern mirrors scripts/tunnel-auth-proxy.js: HTTP Basic
 * (any username, password = token) OR ?pw= (sets an HttpOnly cookie for the
 * browser/SSE). PANEL_NO_AUTH=1 disables auth for local development — but
 * then the panel refuses to bind anywhere but loopback. */
function resolveToken() {
  if (process.env.PANEL_NO_AUTH === '1') return null;
  if (process.env.PANEL_TOKEN) return String(process.env.PANEL_TOKEN);
  const st = state.load('panel-state', {});
  if (!st.token || typeof st.token !== 'string' || st.token.length < 16) {
    st.token = crypto.randomBytes(24).toString('hex');
    state.save('panel-state', st);
    console.log('[panel] generated panel token → datastore/panel-state.json (0600)');
  }
  return st.token;
}
const TOKEN = resolveToken();
const AUTH_ON = !!TOKEN;

if (!AUTH_ON && !['127.0.0.1', 'localhost', '::1', '0.0.0.0'].includes(ADDR)) {
  console.error(`[panel] refusing to bind ${ADDR} without a token — set PANEL_TOKEN (or drop PANEL_NO_AUTH).`);
  process.exit(1);
}

function cookieVal(req, key) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === key) return part.slice(i + 1).trim();
  }
  return null;
}

function authorized(req, url) {
  if (!AUTH_ON) return 'off';
  const h = req.headers.authorization;
  if (h && h.startsWith('Basic ')) {
    try {
      const up = Buffer.from(h.slice(6), 'base64').toString('utf8');
      const i = up.indexOf(':');
      if (i > 0 && up.slice(i + 1) === TOKEN) return 'basic';
    } catch (_) {}
  }
  const q = url.searchParams.get('pw');
  if (q && q === TOKEN) return 'query';
  if (cookieVal(req, 'sb_panel') === TOKEN) return 'cookie';
  return false;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;                    // curl / same-origin GETs without Origin
  try { return new URL(origin).host === req.headers.host; }
  catch (_) { return false; }
}

/* --------------------------------------------------------------- SSE (F8) */

const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}
manager.on('session', (d) => broadcast('session', d));
manager.on('job', (d) => broadcast('job', d));
manager.on('log', (d) => broadcast('log', d));
scriptManager.on('run', (d) => broadcast('run', d));
scriptManager.on('run-log', (d) => broadcast('run-log', d));

const heartbeat = setInterval(() => {
  for (const res of sseClients) { try { res.write(': ping\n\n'); } catch (_) { sseClients.delete(res); } }
}, 25000);
if (heartbeat.unref) heartbeat.unref();

/* ---------------------------------------------------------------- helpers */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function httpError(res, e) {
  const status = (e && e.status) || 500;
  sendJson(res, status, { error: (e && e.message) || 'internal error' });
}

function hostOf(req) {
  const h = req.headers.host || `${ADDR}:${PORT}`;
  return h.replace(/:\d+$/, '') || 'localhost';
}

/* ------------------------------------------------------------ API routing */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/health' && method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      auth: AUTH_ON,
      bind: `${ADDR}:${PORT}`,
      tokenHint: AUTH_ON ? `${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}` : null,
      panelUptimeMs: Date.now() - manager.startedAt,
      sessions: manager.records.size,
      sseClients: sseClients.size,
      pid: process.pid,
    });
  }

  if (p === '/api/events' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ sessions: manager.list() })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (p === '/api/sessions' && method === 'GET') {
    return sendJson(res, 200, { sessions: manager.list() });
  }

  if (p === '/api/sessions' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    let prep;
    try { prep = await manager.prepareStart(body); }
    catch (e) { return httpError(res, e); }
    if (manager.locks.has(prep.name)) {
      return sendJson(res, 409, { error: `session "${prep.name}" already has an operation in progress` });
    }
    const job = manager.beginJob('start', prep.name);
    manager.runJob(job, async () => {
      manager.lock(prep.name);
      try { return await manager.startJob(prep.name, prep.config); }
      finally { manager.unlock(prep.name); }
    });
    return sendJson(res, 202, { job });
  }

  if (p.startsWith('/api/jobs/') && method === 'GET') {
    const job = manager.job(p.slice('/api/jobs/'.length));
    if (!job) return sendJson(res, 404, { error: 'no such job' });
    return sendJson(res, 200, { job });
  }

  // NOTE: no catch-all 404 here — session subroutes are handled next.
  return false; // fall through to handleSessionRoute()
}

async function handleSessionRoute(req, res, url) {
  const m = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/[^/]*)?$/);
  if (!m) return false;
  const name = decodeURIComponent(m[1]);
  const sub = m[2] || '';
  const method = req.method;
  if (!NAME_RE.test(name)) return sendJson(res, 400, { error: 'invalid session name' });

  if (sub === '' && method === 'GET') {
    try { return sendJson(res, 200, { session: manager.publicView(manager.getRecord(name)) }); }
    catch (e) { return httpError(res, e); }
  }
  if (sub === '' && method === 'DELETE') {
    let rec;
    try { rec = manager.getRecord(name); } catch (e) { return httpError(res, e); }
    if (url.searchParams.get('purge') === '1') {
      // Forget a stopped session entirely (profile on disk is kept).
      if (rec.state !== 'stopped') return sendJson(res, 409, { error: 'shut the session down before removing it' });
      manager.records.delete(name);
      manager.persist();
      audit('session-remove', { name });
      return sendJson(res, 200, { removed: name });
    }
    if (rec.state === 'stopped') return sendJson(res, 200, { session: manager.publicView(rec) });
    if (manager.locks.has(name)) return sendJson(res, 409, { error: 'operation in progress' });
    const job = manager.beginJob('shutdown', name);
    audit('session-shutdown', { name });
    manager.runJob(job, () => manager.stop(name));
    return sendJson(res, 202, { job });
  }
  if (sub === '/status' && method === 'GET') {
    try {
      const rec = manager.getRecord(name);
      return sendJson(res, 200, { name, state: rec.state, health: rec.health });
    } catch (e) { return httpError(res, e); }
  }
  if (sub === '/restart' && method === 'POST') {
    let rec;
    try { rec = manager.getRecord(name); } catch (e) { return httpError(res, e); }
    if (!rec.config) return sendJson(res, 409, { error: 'session has no stored config to restart' });
    if (manager.locks.has(name)) return sendJson(res, 409, { error: 'operation in progress' });
    const job = manager.beginJob('restart', name);
    manager.runJob(job, () => manager.restart(name));
    return sendJson(res, 202, { job });
  }
  if (sub === '/logs' && method === 'GET') {
    try { return sendJson(res, 200, { name, lines: manager.logs(name, url.searchParams.get('tail') || 200) }); }
    catch (e) { return httpError(res, e); }
  }
  if (sub === '/viewer-url' && method === 'GET') {
    try {
      const rec = manager.getRecord(name);
      const host = hostOf(req);
      const viewerUrl = `http://${host}:${rec.config.webPort}${manager.viewerPath(rec.config)}?pw=${TOKEN}`;
      return sendJson(res, 200, {
        viewerUrl,
        instructionsUrl: `http://${host}:${rec.config.webPort}/?pw=${TOKEN}`,
        cdpUrl: `http://127.0.0.1:${rec.config.cdpPort}/json/version`,
      });
    } catch (e) { return httpError(res, e); }
  }
  if (sub === '/vnc-password' && method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    try {
      const out = { session: await manager.setVncPassword(name, body.password) };
      audit('vnc-password-set', { name });
      return sendJson(res, 200, out);
    } catch (e) { return httpError(res, e); }
  }
  if (sub === '/vnc-password' && method === 'DELETE') {
    try {
      const out = { session: await manager.clearVncPassword(name) };
      audit('vnc-password-clear', { name });
      return sendJson(res, 200, out);
    } catch (e) { return httpError(res, e); }
  }
  if (sub === '/screenshot' && method === 'GET') {
    try {
      const rec = manager.getRecord(name);
      if (!['running', 'degraded'].includes(rec.state)) {
        return sendJson(res, 409, { error: `session "${name}" is ${rec.state}` });
      }
      const png = await snapshot(rec.config.cdpPort);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': png.length });
      return res.end(png);
    } catch (e) { return httpError(res, e); }
  }
  if (sub === '/settings' && method === 'PATCH') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    try { return sendJson(res, 200, await manager.patchSettings(name, body)); }
    catch (e) { return httpError(res, e); }
  }
  return sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` });
}

/* ------------------------------------------------------------ static files */

function serveStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: `not found: ${url.pathname}` });
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------- scripts + runs (F6) */

async function handleScriptRoutes(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/scripts' && method === 'GET') {
    return sendJson(res, 200, { scripts: scriptManager.list() });
  }
  if (p === '/api/scripts' && method === 'POST') {
    let body;
    try { body = await readBody(req, 2.5 * 1024 * 1024); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    try { return sendJson(res, 201, { script: scriptManager.create(body.name, body.content || '') }); }
    catch (e) { return httpError(res, e); }
  }
  if (p === '/api/runs' && method === 'GET') {
    return sendJson(res, 200, { runs: scriptManager.runsList(url.searchParams.get('session') || undefined) });
  }

  const mr = p.match(/^\/api\/runs\/([^/]+)(\/[^/]*)?$/);
  if (mr) {
    const id = decodeURIComponent(mr[1]);
    const sub = mr[2] || '';
    if (sub === '' && method === 'GET') {
      try { return sendJson(res, 200, { run: scriptManager.view(scriptManager.getRun(id)) }); }
      catch (e) { return httpError(res, e); }
    }
    if (sub === '/logs' && method === 'GET') {
      try { return sendJson(res, 200, { id, lines: scriptManager.runLog(id, url.searchParams.get('tail') || 300) }); }
      catch (e) { return httpError(res, e); }
    }
    if (sub === '' && method === 'DELETE') {
      try {
        const run = scriptManager.kill(id);
        audit('run-kill', { id, script: run.script, session: run.session });
        return sendJson(res, 200, { run });
      } catch (e) { return httpError(res, e); }
    }
  }

  const ms = p.match(/^\/api\/scripts\/([^/]+)(\/[^/]*)?$/);
  if (ms) {
    const name = decodeURIComponent(ms[1]);
    const sub = ms[2] || '';
    if (sub === '' && method === 'GET') {
      try { return sendJson(res, 200, { script: scriptManager.read(name) }); }
      catch (e) { return httpError(res, e); }
    }
    if (sub === '' && method === 'PUT') {
      let body;
      try { body = await readBody(req, 2.5 * 1024 * 1024); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      try { return sendJson(res, 200, { script: scriptManager.update(name, body.content) }); }
      catch (e) { return httpError(res, e); }
    }
    if (sub === '' && method === 'DELETE') {
      try {
        const r = scriptManager.remove(name);
        audit('script-delete', { name, trashed: r.trashed });
        return sendJson(res, 200, r);
      } catch (e) { return httpError(res, e); }
    }
    if (sub === '/rename' && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      try { return sendJson(res, 200, { script: scriptManager.rename(name, body.to) }); }
      catch (e) { return httpError(res, e); }
    }
    if (sub === '/run' && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      try {
        const run = await scriptManager.startRun(body.session, name, body.args || []);
        return sendJson(res, 201, { run });
      } catch (e) { return httpError(res, e); }
    }
  }
  return false;
}

/* -------------------------------------------------- browsers registry (F7) */

async function handleBrowserRoutes(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/browsers' && method === 'GET') {
    return sendJson(res, 200, { browsers: browserRegistry.list() });
  }
  if (p === '/api/browsers' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    try { return sendJson(res, 201, { browser: browserRegistry.create(body) }); }
    catch (e) { return httpError(res, e); }
  }
  if (p === '/api/browsers/local-chrome' && method === 'GET') {
    return sendJson(res, 200, { candidates: await browserRegistry.localChromeCandidates() });
  }
  if (p === '/api/browsers/attach-local' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    const name = body.name && String(body.name).trim() ? String(body.name).trim() : 'local-chrome';
    let prep;
    try {
      prep = await manager.prepareStart({
        name, localChrome: true,
        localChromePort: body.cdpPort ? parseInt(body.cdpPort, 10) : undefined,
      });
    } catch (e) { return httpError(res, e); }
    if (manager.locks.has(prep.name)) return sendJson(res, 409, { error: 'operation in progress' });
    const job = manager.beginJob('attach-local', prep.name);
    manager.runJob(job, async () => {
      manager.lock(prep.name);
      try { return await manager.startJob(prep.name, prep.config); }
      finally { manager.unlock(prep.name); }
    });
    return sendJson(res, 202, { job });
  }

  const m = p.match(/^\/api\/browsers\/([^/]+)(\/[^/]*)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    const sub = m[2] || '';
    if (sub === '' && method === 'PUT') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      try { return sendJson(res, 200, { browser: browserRegistry.update(id, body) }); }
      catch (e) { return httpError(res, e); }
    }
    if (sub === '' && method === 'DELETE') {
      try {
        const r = browserRegistry.remove(id);
        audit('browser-delete', r);
        return sendJson(res, 200, r);
      } catch (e) { return httpError(res, e); }
    }
    if (sub === '/launch' && method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
      let def;
      try { def = browserRegistry.get(id); } catch (e) { return httpError(res, e); }
      if (def.vncPassword && !(body.password && String(body.password).length)) {
        return sendJson(res, 400, { error: 'this definition expects a VNC password — provide "password" at launch' });
      }
      let prep;
      try { prep = await manager.prepareStart(browserRegistry.toStartBody(def, body)); }
      catch (e) { return httpError(res, e); }
      if (manager.locks.has(prep.name)) return sendJson(res, 409, { error: 'operation in progress' });
      const job = manager.beginJob('launch', prep.name);
      const password = body.password ? String(body.password) : null;
      manager.runJob(job, async () => {
        manager.lock(prep.name);
        try {
          const view = await manager.startJob(prep.name, prep.config);
          if (password) {
            await manager.setVncPassword(prep.name, password);
            audit('vnc-password-set', { name: prep.name, via: 'launch' });
          }
          return view;
        } finally { manager.unlock(prep.name); }
      });
      const rec = manager.getRecord(prep.name);
      const host = hostOf(req);
      const viewerUrl = `http://${host}:${rec.config.webPort}${manager.viewerPath(rec.config)}?pw=${TOKEN}`;
      return sendJson(res, 202, { job, session: prep.name, viewerUrl });
    }
  }
  return false;
}

/* ---------------------------------------------------------------- server */

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch (_) { return sendJson(res, 400, { error: 'bad request' }); }

  try {
    // Auth first (everything, including static UI), then CSRF origin check.
    const auth = authorized(req, url);
    if (auth === false) {
      res.setHeader('WWW-Authenticate', 'Basic realm="ServerBrowser Control Panel", charset="UTF-8"');
      return sendJson(res, 401, { error: 'unauthorized — HTTP Basic (any user / panel token), ?pw=<token>, or open the UI once with ?pw=' });
    }
    if (auth === 'query') {
      res.setHeader('Set-Cookie', `sb_panel=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
    }
    if (MUTATING.has(req.method) && !originOk(req)) {
      return sendJson(res, 403, { error: 'origin mismatch (CSRF guard)' });
    }

    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (handled !== false) return;
      const handledSession = await handleSessionRoute(req, res, url);
      if (handledSession !== false) return;
      const handledScript = await handleScriptRoutes(req, res, url);
      if (handledScript !== false) return;
      const handledBrowser = await handleBrowserRoutes(req, res, url);
      if (handledBrowser !== false) return;
      return sendJson(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, url);
  } catch (e) {
    return httpError(res, e);
  }
});

server.listen(PORT, ADDR, () => {
  console.log(`[panel] ServerBrowser control panel → http://${ADDR}:${PORT}/`);
  console.log(`[panel] auth: ${AUTH_ON ? 'token (Basic any-user / ?pw= / cookie; token in datastore/panel-state.json)' : 'DISABLED (PANEL_NO_AUTH)'}`);
  console.log(`[panel] sessions: ${manager.records.size} known (reconciled/adopted on boot)`);
});

// Ctrl-C / SIGTERM stops ONLY the panel. Sessions are detached and keep
// running (they are supervised via datastore/pids/, adopted on next boot).
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[panel] ${sig} — stopping panel (sessions stay up)`);
    for (const c of sseClients) { try { c.end(); } catch (_) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}


