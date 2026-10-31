'use strict';
/**
 * session-manager.js — spawn/supervise VNC stack sessions (F1/F2) with:
 *   - per-session process groups (detached `vnc-server.sh --session NAME`)
 *   - port/display allocation and collision checks
 *   - state persisted to datastore/sessions.json (0600)
 *   - health probes (process/CDP/web/RFB) on a loop → running|degraded|stopped
 *   - adoption of stacks started outside the panel via datastore/pids/<name>/
 *   - jobs + events (session/job/log) that the panel streams over SSE
 *   - VNC password set/clear with x11vnc-only restart (F4)
 *   - settings patch (screen/browser/start-url/viewer opts) (F5)
 */
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const state = require('./state');
const health = require('./health');
const ports = require('./ports');

const execFileAsync = promisify(execFile);
const ROOT = state.ROOT;
const DATASTORE = state.DATASTORE;
const PID_ROOT = path.join(DATASTORE, 'pids');
const LOG_DIR = path.join(DATASTORE, 'session-logs');
const PASSWD_DIR = path.join(DATASTORE, 'vnc-passwd');
const SESSIONS_FILE = 'sessions';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const BROWSERS = ['chrome', 'chromium', 'firefox'];
const RING_MAX = 500;
const START_TIMEOUT_MS = 45000;
const STOP_GRACE_MS = 9000;
const DEFAULTS = { webPort: 6080, rfbPort: 5900, cdpPort: 9222, display: 10, screen: '1280x800x24', browser: 'chrome' };

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeScreen(input) {
  const s = String(input || '').trim();
  let m = s.match(/^(\d{3,4})x(\d{3,4})x(\d{1,2})$/);
  if (m) return `${+m[1]}x${+m[2]}x${+m[3]}`;
  m = s.match(/^(\d{3,4})x(\d{3,4})$/);
  if (m) {
    const w = +m[1], h = +m[2];
    if (w < 320 || h < 200 || w > 7680 || h > 4320) throw new HttpError(`resolution ${s} out of range (320x200 – 7680x4320)`);
    return `${w}x${h}x24`;
  }
  throw new HttpError(`invalid screen "${input}" (expected WIDTHxHEIGHT or WIDTHxHEIGHTxDEPTH)`);
}

function readPidFile(file) {
  try { const n = parseInt(fs.readFileSync(file, 'utf8').trim(), 10); return Number.isInteger(n) ? n : null; }
  catch (_) { return null; }
}

function readProcEnv(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const out = {};
    for (const entry of raw.split('\0')) {
      const i = entry.indexOf('=');
      if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
    }
    return out;
  } catch (_) { return {}; }
}

function defaultProfile(name) {
  return name === 'default' ? path.join(ROOT, 'profile') : path.join(ROOT, 'profile', name);
}

function resolveProfile(input) {
  const p = path.isAbsolute(String(input)) ? path.resolve(String(input)) : path.resolve(ROOT, String(input));
  const ok = p.startsWith(ROOT + path.sep) || p === ROOT || p.startsWith('/tmp/');
  if (!ok) throw new HttpError('profile must live under the project root or /tmp');
  return p;
}

function profileBusy(profile) {
  try {
    const target = fs.readlinkSync(path.join(profile, 'SingletonLock'));  // host-pid
    const pid = parseInt(target.split('-').pop(), 10);
    if (pid && health.isAlive(pid)) return true;
  } catch (_) { /* no lock / unreadable ⇒ not busy */ }
  return false;
}

/** Pids whose /proc cmdline contains `needle` (scoped matching, no pgrep -f
 *  self-matches). Used to find x11vnc instances we may not hold a pid for. */
function findPids(needle) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch (_) { return out; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${e}/cmdline`, 'utf8').split('\0').join(' ').trim();
      if (cmd.includes(needle)) out.push(parseInt(e, 10));
    } catch (_) {}
  }
  return out;
}

class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.records = new Map();      // name → record
    this.children = new Map();     // name → ChildProcess (panel-started only)
    this.rings = new Map();        // name → string[]
    this.jobs = new Map();         // id → job
    this.locks = new Set();        // names with an in-flight operation
    this.jobSeq = 0;
    this.timer = null;
    this.startedAt = Date.now();
  }

  /* ---------------------------------------------------------------- boot */

  init() {
    this.reconcile();
    this.adopt();
    this.timer = setInterval(() => this.healthTick().catch(() => {}), 4000);
    if (this.timer.unref) this.timer.unref();
  }

  /** Re-read persisted records: keep the ones whose process survived a panel restart. */
  reconcile() {
    const saved = state.load(SESSIONS_FILE, { sessions: [] });
    for (const rec of saved.sessions || []) {
      if (!rec || !NAME_RE.test(rec.name || '')) continue;
      const alive = health.isAlive(rec.pids && rec.pids.session);
      rec.state = alive ? 'running' : 'stopped';
      if (!alive) rec.stoppedAt = rec.stoppedAt || Date.now();
      rec.health = { process: alive, cdp: false, web: false, rfb: false };
      this.records.set(rec.name, rec);
    }
  }

  /**
   * Adopt stacks started outside the panel (e.g. `npm run vnc`): the refactored
   * vnc-server.sh always writes datastore/pids/<session>/*.pid, and the process
   * env (WEB_PORT, CDP_PORT, ...) is readable from /proc.
   */
  adopt() {
    let dirs = [];
    try { dirs = fs.readdirSync(PID_ROOT); } catch (_) { return; }
    let changed = false;
    for (const name of dirs) {
      if (!NAME_RE.test(name)) continue;
      const dir = path.join(PID_ROOT, name);
      const pid = readPidFile(path.join(dir, 'session.pid'));
      if (!pid || !health.isAlive(pid)) {
        if (!this.records.has(name)) {
          try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
        }
        continue;                                        // stale dir (or record owns it)
      }
      const existing = this.records.get(name);
      if (existing && existing.state !== 'stopped') continue;  // our own live session
      const env = readProcEnv(pid);
      const cfg = {
        webPort: parseInt(env.WEB_PORT, 10) || DEFAULTS.webPort,
        rfbPort: parseInt(env.RFB_PORT, 10) || DEFAULTS.rfbPort,
        cdpPort: parseInt(env.CDP_PORT, 10) || DEFAULTS.cdpPort,
        display: parseInt(env.DISPLAY_NUM, 10) || DEFAULTS.display,
        screen: env.SCREEN ? normalizeScreen(env.SCREEN) : DEFAULTS.screen,
        browser: BROWSERS.includes(env.BROWSER) ? env.BROWSER : DEFAULTS.browser,
        profile: env.PROFILE || defaultProfile(name),
        startUrl: env.START_URL || '',
        localChrome: env.LOCAL_CHROME === '1',
        localChromePort: parseInt(env.LOCAL_CHROME_PORT, 10) || null,
        viewer: {},
        vncPassword: fs.existsSync(path.join(PASSWD_DIR, name)),
      };
      this.records.set(name, {
        name,
        state: 'running',
        adopted: true,
        config: cfg,
        pids: {
          session: pid,
          xvfb: readPidFile(path.join(dir, 'xvfb.pid')),
          websockify: readPidFile(path.join(dir, 'websockify.pid')),
          driver: readPidFile(path.join(dir, 'driver.pid')),
          x11vnc: readPidFile(path.join(dir, 'x11vnc.pid')),
        },
        health: { process: true, cdp: false, web: false, rfb: false },
        startedAt: null, stoppedAt: null, lastError: null,
      });
      changed = true;
    }
    if (changed) this.persist();
  }

  /* ------------------------------------------------------------ plumbing */

  persist() {
    state.save(SESSIONS_FILE, { sessions: [...this.records.values()] });
  }

  viewerPath(cfg) {
    // Verified against the installed noVNC (/usr/share/novnc): vnc.html reads
    // query-string settings FIRST (ui.js initSetting → getConfigVar), and
    // supports resize=scale|remote|none + view_only. This build has NO
    // quality/compression settings, so those are intentionally not emitted.
    const q = [];
    const v = cfg.viewer || {};
    if (v.resize && v.resize !== 'off') q.push(`resize=${encodeURIComponent(v.resize)}`);
    if (v.viewOnly) q.push('view_only=1');
    return `/novnc/vnc.html${q.length ? '?' + q.join('&') : ''}`;
  }

  publicView(rec) {
    const cfg = { ...rec.config, passwordSet: !!rec.config.vncPassword };
    delete cfg.vncPassword;
    return {
      name: rec.name,
      state: rec.state,
      adopted: !!rec.adopted,
      config: cfg,
      viewerPath: this.viewerPath(rec.config),
      pids: rec.pids,
      health: rec.health,
      startedAt: rec.startedAt,
      stoppedAt: rec.stoppedAt,
      lastError: rec.lastError,
      uptimeMs: rec.state === 'running' && rec.startedAt ? Date.now() - rec.startedAt : null,
    };
  }

  emitSession(rec) {
    const view = this.publicView(rec);
    this.emit('session', view);
    return view;
  }

  list() {
    return [...this.records.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => this.publicView(r));
  }

  getRecord(name) {
    const rec = this.records.get(name);
    if (!rec) throw new HttpError(`no session "${name}"`, 404);
    return rec;
  }

  ring(name) {
    let r = this.rings.get(name);
    if (!r) {
      // First access in this process: hydrate from the persisted file tail so
      // logs survive a panel restart (appendLine keeps datastore/session-logs/).
      r = [];
      try {
        const raw = fs.readFileSync(path.join(LOG_DIR, `${name}.log`), 'utf8');
        let lines = raw.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        if (lines.length > RING_MAX) lines = lines.slice(-RING_MAX);
        for (const l of lines) r.push(l);
      } catch (_) { /* no file yet */ }
      this.rings.set(name, r);
    }
    return r;
  }

  appendLine(name, line) {
    const ring = this.ring(name);
    ring.push(line);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(LOG_DIR, `${name}.log`), line + '\n');
    } catch (_) {}
    this.emit('log', { name, line, ts: Date.now() });
  }

  attachLogs(name, child) {
    const leftovers = { stdout: '', stderr: '' };
    const onChunk = (stream) => (buf) => {
      const text = leftovers[stream] + buf.toString('utf8');
      const parts = text.split('\n');
      leftovers[stream] = parts.pop() || '';
      for (const line of parts) this.appendLine(name, line);
    };
    if (child.stdout) child.stdout.on('data', onChunk('stdout'));
    if (child.stderr) child.stderr.on('data', onChunk('stderr'));
  }

  tailError(name, n = 8) {
    const lines = (this.ring(name) || []).filter((l) => l.trim()).slice(-n);
    return lines.join('\n') || null;
  }

  /** Merge per-session pid files (written by vnc-server.sh) into the record. */
  refreshPids(rec) {
    const dir = path.join(PID_ROOT, rec.name);
    for (const k of ['xvfb', 'websockify', 'driver', 'x11vnc']) {
      const pid = readPidFile(path.join(dir, `${k}.pid`));
      if (pid) rec.pids[k] = pid;
    }
  }

  lock(name) {
    if (this.locks.has(name)) throw new HttpError(`session "${name}" already has an operation in progress`, 409);
    this.locks.add(name);
  }
  unlock(name) { this.locks.delete(name); }

  beginJob(type, name) {
    const job = {
      id: `job_${Date.now().toString(36)}_${++this.jobSeq}`,
      type, name, state: 'running',
      message: null, error: null, result: null,
      startedAt: Date.now(), endedAt: null,
    };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 200) {                       // keep the map bounded
      const oldest = [...this.jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.jobs.delete(oldest.id);
    }
    this.emit('job', job);
    return job;
  }

  async runJob(job, fn) {
    try {
      const result = await fn();
      job.state = 'done';
      job.result = result || null;
    } catch (e) {
      job.state = 'error';
      job.error = e && e.message ? e.message : String(e);
    }
    job.endedAt = Date.now();
    this.emit('job', job);
    return job;
  }

  job(id) { return this.jobs.get(id) || null; }

  /* ------------------------------------------------------- lifecycle (F1/F2) */

  /**
   * Validate a start request and resolve the full config (does fast bind
   * tests). Throws HttpError 400/409 for bad input.
   * Returns { name, config, existing }.
   */
  async prepareStart(body = {}) {
    const raw = body.name != null && String(body.name).trim() !== '' ? String(body.name).trim() : 'default';
    if (!NAME_RE.test(raw)) throw new HttpError('invalid session name (letters, digits, - or _; max 32 chars)');
    const name = raw;
    const existing = this.records.get(name);
    if (existing && existing.state !== 'stopped') {
      throw new HttpError(`session "${name}" is already ${existing.state}`, 409);
    }

    const base = existing ? existing.config : {};
    const cfg = {};

    cfg.screen = normalizeScreen(body.screen || body.resolution || base.screen || DEFAULTS.screen);
    cfg.browser = String(body.browser || base.browser || DEFAULTS.browser).toLowerCase();
    if (!BROWSERS.includes(cfg.browser)) throw new HttpError(`browser must be one of: ${BROWSERS.join(', ')}`);
    cfg.profile = body.profile ? resolveProfile(body.profile) : (base.profile || defaultProfile(name));
    cfg.startUrl = body.startUrl !== undefined && body.startUrl !== null
      ? String(body.startUrl) : (base.startUrl || '');
    cfg.localChrome = body.localChrome !== undefined ? !!body.localChrome : !!base.localChrome;
    cfg.localChromePort = body.localChromePort ? parseInt(body.localChromePort, 10) : (base.localChromePort || null);
    cfg.viewer = { ...(base.viewer || {}), ...(body.viewer || {}) };
    cfg.vncPassword = fs.existsSync(path.join(PASSWD_DIR, name));

    // Profile lock: refuse when another Chrome holds it (one Chrome per profile).
    const holders = [...this.records.values()].filter((r) =>
      r.name !== name && r.config.profile === cfg.profile &&
      ['starting', 'running', 'degraded', 'stopping'].includes(r.state));
    if (holders.length) throw new HttpError(`profile ${cfg.profile} is in use by session "${holders[0].name}"`, 409);
    if (profileBusy(cfg.profile)) throw new HttpError(`profile ${cfg.profile} is locked by a live Chrome (SingletonLock)`, 409);

    // Ports: explicit values are validated strictly; otherwise auto-allocate.
    const explicit = ['webPort', 'rfbPort', 'cdpPort', 'display'].filter(
      (k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
    if (explicit.length) {
      cfg.webPort = body.webPort !== undefined && body.webPort !== '' ? parseInt(body.webPort, 10) : (base.webPort || DEFAULTS.webPort);
      cfg.rfbPort = body.rfbPort !== undefined && body.rfbPort !== '' ? parseInt(body.rfbPort, 10) : (base.rfbPort || DEFAULTS.rfbPort);
      cfg.cdpPort = body.cdpPort !== undefined && body.cdpPort !== '' ? parseInt(body.cdpPort, 10) : (base.cdpPort || DEFAULTS.cdpPort);
      cfg.display = body.display !== undefined && body.display !== '' ? parseInt(body.display, 10) : (base.display || DEFAULTS.display);
      const errors = await ports.validate(cfg);
      if (errors.length) throw new HttpError(errors.join('; '), 409);
    } else {
      if (existing) {
        // Keep the stored ports if they're free right now; otherwise re-pick.
        const probe = { webPort: base.webPort, rfbPort: base.rfbPort, cdpPort: base.cdpPort, display: base.display };
        if ((await ports.validate(probe)).length === 0) Object.assign(cfg, probe);
      }
      if (cfg.webPort === undefined) {
        const taken = { ports: new Set(), displays: new Set() };
        for (const r of this.records.values()) {
          taken.ports.add(r.config.webPort); taken.ports.add(r.config.rfbPort); taken.ports.add(r.config.cdpPort);
          taken.displays.add(r.config.display);
        }
        Object.assign(cfg, await this.allocPorts(taken));
      }
    }
    return { name, config: cfg, existing: !!existing };
  }

  /** Find the first free 6080+i/5900+i/9222+i / :10+i cluster not used by our records. */
  async allocPorts(taken) {
    for (let i = 0; i < 500; i++) {
      const cand = { webPort: 6080 + i, rfbPort: 5900 + i, cdpPort: 9222 + i, display: 10 + i };
      if (taken.ports.has(cand.webPort) || taken.ports.has(cand.rfbPort) || taken.ports.has(cand.cdpPort)) continue;
      if (taken.displays.has(cand.display)) continue;
      if ((await ports.validate(cand)).length === 0) return cand;
    }
    throw new HttpError('no free port cluster available for a new session', 409);
  }

  /** Job body: spawn the stack and wait until CDP + web are answering. */
  async startJob(name, config) {
    const rec = this.records.get(name) || { name };
    rec.config = config;
    rec.adopted = false;
    rec.state = 'starting';
    rec.startedAt = Date.now();
    rec.stoppedAt = null;
    rec.lastError = null;
    rec.health = { process: true, cdp: false, web: false, rfb: false };
    rec.pids = {};
    this.records.set(name, rec);

    const passwdFile = path.join(PASSWD_DIR, name);
    const env = {
      ...process.env,
      WEB_PORT: String(config.webPort),
      RFB_PORT: String(config.rfbPort),
      CDP_PORT: String(config.cdpPort),
      DISPLAY_NUM: String(config.display),
      SCREEN: config.screen,
      PROFILE: config.profile,
      BROWSER: config.browser,
      VNC_SESSION: name,
      VNC_PASSWD_FILE: passwdFile,
    };
    if (config.startUrl) env.START_URL = config.startUrl;
    if (config.localChrome) {
      env.LOCAL_CHROME = '1';
      if (config.localChromePort) env.LOCAL_CHROME_PORT = String(config.localChromePort);
    }

    const child = spawn('bash', [path.join(ROOT, 'scripts', 'vnc-server.sh'), '--session', name], {
      cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(name, child);
    rec.pids.session = child.pid;
    this.persist();
    this.emitSession(rec);
    this.attachLogs(name, child);
    child.once('exit', (code, sig) => this.onSessionExit(name, child, code, sig));

    const outcome = await this.waitReady(rec, child);
    if (outcome === 'exited') throw new HttpError(this.tailError(name) || 'session process exited during startup', 500);
    return this.publicView(rec);
  }

  async waitReady(rec, child, deadlineMs = START_TIMEOUT_MS) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) return 'exited';
      this.refreshPids(rec);           // hydrate xvfb/websockify/driver/x11vnc pids
      const h = await health.probe(rec);
      rec.health = h;
      if (h.process && h.cdp && h.web) {
        rec.state = 'running';
        rec.lastError = null;
        this.persist();
        this.emitSession(rec);
        return 'ready';
      }
      await sleep(700);
    }
    // Still alive but not answering: degraded with a log tail for diagnosis.
    rec.state = health.isAlive(rec.pids.session) ? 'degraded' : 'stopped';
    rec.lastError = this.tailError(rec.name) || `session not ready within ${Math.round(deadlineMs / 1000)}s`;
    this.persist();
    this.emitSession(rec);
    return 'timeout';
  }

  onSessionExit(name, child, code, sig) {
    if (this.children.get(name) !== child) return;      // stale child from a restart
    this.children.delete(name);
    const rec = this.records.get(name);
    if (!rec || rec.state === 'stopping' || rec.state === 'stopped') return;
    rec.state = 'stopped';
    rec.stoppedAt = Date.now();
    rec.health = { process: false, cdp: false, web: false, rfb: false };
    rec.lastError = this.tailError(name) || `session process exited (code=${code}, sig=${sig})`;
    this.persist();
    this.emitSession(rec);
  }

  /** Stop the stack: SIGTERM the session process group (runs the cleanup trap),
   *  escalate to SIGKILL after a grace period, and take down any x11vnc the
   *  panel re-spawned (it lives in its own process group). */
  async _stop(rec) {
    const name = rec.name;
    rec.state = 'stopping';
    rec.stoppedAt = null;
    this.persist();
    this.emitSession(rec);

    const pid = rec.pids && rec.pids.session;
    const xvnc = rec.pids && rec.pids.x11vnc;
    if (pid && health.isAlive(pid)) { try { process.kill(-pid, 'SIGTERM'); } catch (_) {} }
    if (xvnc && xvnc !== pid && health.isAlive(xvnc)) { try { process.kill(xvnc, 'SIGTERM'); } catch (_) {} }
    // Any panel-respawned x11vnc lives in its own group — kill by scoped
    // cmdline too so nothing outlives the session.
    for (const p of findPids(`x11vnc -display :${rec.config.display} -rfbport ${rec.config.rfbPort}`)) {
      try { process.kill(p, 'SIGTERM'); } catch (_) {}
    }

    const deadline = Date.now() + STOP_GRACE_MS;
    while (Date.now() < deadline &&
           ((pid && health.isAlive(pid)) || (xvnc && health.isAlive(xvnc)))) {
      await sleep(250);
    }
    if (pid && health.isAlive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }
    if (xvnc && health.isAlive(xvnc)) { try { process.kill(xvnc, 'SIGKILL'); } catch (_) {} }
    await sleep(300);

    this.children.delete(name);
    try { fs.rmSync(path.join(PID_ROOT, name), { recursive: true, force: true }); } catch (_) {}

    rec.state = 'stopped';
    rec.stoppedAt = Date.now();
    rec.health = { process: false, cdp: false, web: false, rfb: false };
    rec.pids = {};
    this.persist();
    this.emitSession(rec);
    return rec;
  }

  async stop(name) {
    const rec = this.getRecord(name);
    if (rec.state === 'stopped') return this.publicView(rec);
    this.lock(name);
    try { await this._stop(rec); }
    finally { this.unlock(name); }
    return this.publicView(rec);
  }

  /** Restart with the SAME config (profile/ports/screen preserved). */
  async restart(name) {
    const rec = this.getRecord(name);
    if (!rec.config) throw new HttpError(`session "${name}" has no stored config to restart`, 409);
    this.lock(name);
    try {
      if (rec.state !== 'stopped') await this._stop(rec);
      return await this.startJob(name, rec.config);
    } finally {
      this.unlock(name);
    }
  }

  /* ------------------------------------------------------------ health loop */

  async healthTick() {
    for (const rec of this.records.values()) {
      if (!['running', 'degraded'].includes(rec.state)) continue;
      this.refreshPids(rec);
      const before = JSON.stringify({ s: rec.state, h: rec.health });
      const h = await health.probe(rec);
      rec.health = h;
      if (!h.process) {
        rec.state = 'stopped';
        rec.stoppedAt = Date.now();
        rec.lastError = rec.lastError || this.tailError(rec.name) || 'session process died';
        this.persist();
        this.emitSession(rec);
        continue;
      }
      const want = h.overall ? 'running' : 'degraded';
      if (want !== rec.state) {
        rec.state = want;
        if (want === 'degraded') rec.lastError = this.tailError(rec.name) || 'health probe failing';
        else rec.lastError = null;
        this.persist();
      }
      if (JSON.stringify({ s: rec.state, h: rec.health }) !== before) this.emitSession(rec);
    }
  }

  /* ---------------------------------------------------------- VNC password (F4) */

  passwdFile(name) { return path.join(PASSWD_DIR, name); }

  /** Re-spawn only the x11vnc child — Xvfb/Chrome/CDP stay untouched.
   *  Kills every x11vnc scoped to this session's display+port (the recorded
   *  pid may be missing or stale), waits for the RFB port to free, then
   *  spawns the replacement with -rfbauth or -nopw. */
  async restartX11vnc(rec, useAuth) {
    const victims = new Set();
    if (rec.pids && rec.pids.x11vnc && health.isAlive(rec.pids.x11vnc)) victims.add(rec.pids.x11vnc);
    for (const pid of findPids(`x11vnc -display :${rec.config.display} -rfbport ${rec.config.rfbPort}`)) {
      victims.add(pid);
    }
    for (const pid of victims) { try { process.kill(pid, 'SIGTERM'); } catch (_) {} }
    const termDeadline = Date.now() + 3000;
    while (Date.now() < termDeadline && [...victims].some((p) => health.isAlive(p))) await sleep(150);
    for (const pid of victims) {
      if (health.isAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    }
    // The old x11vnc must actually release the port before we rebind it.
    const portDeadline = Date.now() + 4000;
    while (Date.now() < portDeadline && !(await ports.portFree(rec.config.rfbPort))) await sleep(150);
    if (!(await ports.portFree(rec.config.rfbPort))) {
      throw new HttpError('the old x11vnc did not release the RFB port', 500);
    }
    const args = [
      '-display', `:${rec.config.display}`,
      '-rfbport', String(rec.config.rfbPort),
      ...(useAuth ? ['-rfbauth', this.passwdFile(rec.name)] : ['-nopw']),
      '-forever', '-shared', '-quiet',
    ];
    const child = spawn('x11vnc', args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.unref();
    rec.pids.x11vnc = child.pid;
    this.attachLogs(rec.name, child);
    try {
      fs.mkdirSync(path.join(PID_ROOT, rec.name), { recursive: true });
      fs.writeFileSync(path.join(PID_ROOT, rec.name, 'x11vnc.pid'), String(child.pid));
    } catch (_) {}
    // x11vnc must survive the respawn (give it a beat, then verify the port).
    await sleep(600);
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new HttpError(`new x11vnc exited with code ${child.exitCode} (see session logs)`, 500);
    }
    this.emitSession(rec);
  }

  async setVncPassword(name, password) {
    const rec = this.getRecord(name);
    if (typeof password !== 'string' || password.length < 1 || password.length > 64) {
      throw new HttpError('password must be 1–64 characters');
    }
    fs.mkdirSync(PASSWD_DIR, { recursive: true, mode: 0o700 });
    const file = this.passwdFile(name);
    try {
      await execFileAsync('x11vnc', ['-storepasswd', password, file]);
    } catch (e) {
      throw new HttpError(`x11vnc -storepasswd failed: ${e.message}`, 500);
    }
    try { fs.chmodSync(file, 0o600); } catch (_) {}
    rec.config.vncPassword = true;
    this.persist();
    if (rec.state === 'running' || rec.state === 'degraded') {
      try { await this.restartX11vnc(rec, true); }
      catch (e) { throw new HttpError(`password stored, but x11vnc restart failed: ${e.message} (it applies on the next session restart)`, 500); }
    }
    return this.publicView(rec);
  }

  async clearVncPassword(name) {
    const rec = this.getRecord(name);
    try { fs.rmSync(this.passwdFile(name), { force: true }); } catch (_) {}
    rec.config.vncPassword = false;
    this.persist();
    if (rec.state === 'running' || rec.state === 'degraded') {
      try { await this.restartX11vnc(rec, false); }
      catch (e) { throw new HttpError(`password cleared, but x11vnc restart failed: ${e.message} (it applies on the next session restart)`, 500); }
    }
    return this.publicView(rec);
  }

  /* ------------------------------------------------------- settings patch (F5) */

  async patchSettings(name, patch = {}) {
    const rec = this.getRecord(name);
    const cfg = rec.config;
    const before = { screen: cfg.screen, browser: cfg.browser, startUrl: cfg.startUrl };
    let restartRequired = false;

    if (patch.screen !== undefined || patch.resolution !== undefined) {
      cfg.screen = normalizeScreen(patch.screen !== undefined ? patch.screen : patch.resolution);
    }
    if (patch.browser !== undefined) {
      const b = String(patch.browser).toLowerCase();
      if (!BROWSERS.includes(b)) throw new HttpError(`browser must be one of: ${BROWSERS.join(', ')}`);
      cfg.browser = b;
    }
    if (patch.startUrl !== undefined) cfg.startUrl = String(patch.startUrl);
    if (patch.viewer !== undefined && patch.viewer !== null) {
      const v = patch.viewer;
      const clean = { ...(cfg.viewer || {}) };
      if (v.resize !== undefined) {
        const r = v.resize === '' || v.resize == null ? '' : String(v.resize);
        if (r && !['scale', 'remote', 'none', 'off'].includes(r)) {
          throw new HttpError('viewer.resize must be scale|remote|none|off (or "")');
        }
        clean.resize = r;
      }
      if (v.viewOnly !== undefined) clean.viewOnly = v.viewOnly === true || v.viewOnly === 'true' || v.viewOnly === '1';
      cfg.viewer = clean;
    }
    restartRequired = cfg.screen !== before.screen || cfg.browser !== before.browser || cfg.startUrl !== before.startUrl;
    this.persist();
    const view = this.emitSession(rec);
    return { session: view, restartRequired };
  }

  /* ------------------------------------------------------------------ logs */

  logs(name, tail = 200) {
    this.getRecord(name);
    const n = Math.max(1, Math.min(2000, parseInt(tail, 10) || 200));
    return this.ring(name).slice(-n);
  }
}

module.exports = new SessionManager();
module.exports.SessionManager = SessionManager;
module.exports.HttpError = HttpError;






