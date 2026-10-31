'use strict';
/**
 * script-manager.js — F6: manage `user-scripts/` (local-only, gitignored)
 * and run scripts against a live session via `scripts/live-run.js`
 * (CDP attach; browser.close suppressed — the browser always survives).
 *
 *   - CRUD with traversal guard + filename allowlist; delete = move to
 *     `user-scripts/.trash/` (timestamped), never unlink
 *   - runs: one active run per session (409 otherwise), stdout/stderr captured
 *     to `datastore/run-logs/<runId>.log` + ring, state persisted to
 *     `datastore/runs.json` (0600) so history survives a panel restart
 *   - events: 'run' (state changes), 'run-log' {id, line} for SSE
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const state = require('./state');
const manager = require('./session-manager');
const { HttpError } = manager;

const ROOT = state.ROOT;
const SCRIPTS_DIR = path.join(ROOT, 'user-scripts');
const TRASH_DIR = path.join(SCRIPTS_DIR, '.trash');
const RUN_LOG_DIR = path.join(state.DATASTORE, 'run-logs');
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_CONTENT = 2 * 1024 * 1024;          // 2 MB per script
const RING_MAX = 500;
const RUNS_FILE = 'runs';
const MAX_RUNS = 200;

class ScriptManager extends EventEmitter {
  constructor() {
    super();
    this.runs = new Map();            // id → run record
    this.children = new Map();        // id → ChildProcess (this panel's runs)
    this.rings = new Map();           // id → string[]
    this.activeBySession = new Map(); // session → runId
    this.seq = 0;
  }

  init() {
    const saved = state.load(RUNS_FILE, { runs: [] });
    for (const r of saved.runs || []) {
      if (!r || !r.id) continue;
      // A run marked running before a panel restart lost its child handle:
      // the pid may live, but we can no longer stream or kill it cleanly.
      if (r.state === 'running') {
        r.state = 'interrupted';
        r.endedAt = r.endedAt || Date.now();
        r.error = r.error || 'panel restarted during run';
      }
      this.runs.set(r.id, r);
    }
    // keep the map bounded on load
    if (this.runs.size > MAX_RUNS) {
      const all = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
      for (const r of all.slice(0, this.runs.size - MAX_RUNS)) this.runs.delete(r.id);
    }
  }

  persist() {
    state.save(RUNS_FILE, { runs: [...this.runs.values()] });
  }

  /* ------------------------------------------------------------ script FS */

  resolve(name) {
    if (!NAME_RE.test(String(name || ''))) {
      throw new HttpError('invalid script name (letters, digits, . _ -; must start with a letter/digit)');
    }
    const p = path.join(SCRIPTS_DIR, name);
    if (!p.startsWith(SCRIPTS_DIR + path.sep)) throw new HttpError('invalid script path'); // belt & braces
    return p;
  }

  list() {
    let entries = [];
    try { entries = fs.readdirSync(SCRIPTS_DIR); } catch (_) { return []; }
    const out = [];
    for (const name of entries) {
      if (name === '.trash' || !NAME_RE.test(name)) continue;
      const p = path.join(SCRIPTS_DIR, name);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        out.push({ name, size: st.size, mtime: st.mtimeMs });
      } catch (_) {}
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  read(name) {
    const p = this.resolve(name);
    let st;
    try { st = fs.statSync(p); } catch (_) { throw new HttpError(`no script "${name}"`, 404); }
    if (st.size > MAX_CONTENT) throw new HttpError('script too large to edit in the panel (2 MB max)');
    return { name, content: fs.readFileSync(p, 'utf8'), size: st.size, mtime: st.mtimeMs };
  }

  create(name, content = '') {
    const p = this.resolve(name);
    if (fs.existsSync(p)) throw new HttpError(`script "${name}" already exists`, 409);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_CONTENT) {
      throw new HttpError('content must be a string up to 2 MB');
    }
    fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
    fs.writeFileSync(p, content, { mode: 0o600 });
    return this.read(name);
  }

  update(name, content) {
    const p = this.resolve(name);
    if (!fs.existsSync(p)) throw new HttpError(`no script "${name}"`, 404);
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_CONTENT) {
      throw new HttpError('content must be a string up to 2 MB');
    }
    fs.writeFileSync(p, content, { mode: 0o600 });
    return this.read(name);
  }

  rename(name, to) {
    const from = this.resolve(name);
    const dest = this.resolve(to);
    if (!fs.existsSync(from)) throw new HttpError(`no script "${name}"`, 404);
    if (fs.existsSync(dest)) throw new HttpError(`"${to}" already exists`, 409);
    fs.renameSync(from, dest);
    return this.read(to);
  }

  remove(name) {
    const p = this.resolve(name);
    if (!fs.existsSync(p)) throw new HttpError(`no script "${name}"`, 404);
    fs.mkdirSync(TRASH_DIR, { recursive: true });
    const dest = path.join(TRASH_DIR, `${name}.${Date.now()}`);
    fs.renameSync(p, dest);
    return { name, trashed: path.relative(ROOT, dest) };
  }

  /* ---------------------------------------------------------------- runs */

  view(r) {
    const { pid, ...rest } = r;      // pid kept server-side only
    return { ...rest, live: r.state === 'running' };
  }

  runsList(sessionFilter) {
    let all = [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    if (sessionFilter) all = all.filter((r) => r.session === sessionFilter);
    return all.slice(0, 100).map((r) => this.view(r));
  }

  getRun(id) {
    const r = this.runs.get(id);
    if (!r) throw new HttpError(`no run "${id}"`, 404);
    return r;
  }

  runLog(id, tail = 300) {
    this.getRun(id);
    const n = Math.max(1, Math.min(2000, parseInt(tail, 10) || 300));
    let ring = this.rings.get(id);
    if (!ring) {
      ring = [];
      try {
        let lines = fs.readFileSync(path.join(RUN_LOG_DIR, `${id}.log`), 'utf8').split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        if (lines.length > RING_MAX) lines = lines.slice(-RING_MAX);
        ring = lines;
      } catch (_) {}
      this.rings.set(id, ring);
    }
    return ring.slice(-n);
  }

  pushLine(id, line) {
    let ring = this.rings.get(id);
    if (!ring) { ring = []; this.rings.set(id, ring); }
    ring.push(line);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    try {
      fs.mkdirSync(RUN_LOG_DIR, { recursive: true });
      fs.appendFileSync(path.join(RUN_LOG_DIR, `${id}.log`), line + '\n');
    } catch (_) {}
    this.emit('run-log', { id, line, ts: Date.now() });
  }

  /** Start `user-scripts/<script>` on a live session via live-run.js. */
  async startRun(sessionName, scriptName, args = []) {
    const session = manager.getRecord(sessionName);
    if (!['running', 'degraded'].includes(session.state)) {
      throw new HttpError(`session "${sessionName}" is not running (${session.state})`, 409);
    }
    const scriptPath = this.resolve(scriptName);
    if (!fs.existsSync(scriptPath)) throw new HttpError(`no script "${scriptName}"`, 404);
    if (!Array.isArray(args) || args.length > 32) throw new HttpError('args must be an array of at most 32 items');
    const cleanArgs = args.map((a) => String(a));
    if (cleanArgs.reduce((n, a) => n + Buffer.byteLength(a), 0) > 4096) throw new HttpError('args too long (4 KB max)');
    const active = this.activeBySession.get(sessionName);
    if (active && this.runs.get(active) && this.runs.get(active).state === 'running') {
      throw new HttpError(`session "${sessionName}" already has run ${active} in progress`, 409);
    }

    const id = `run_${Date.now().toString(36)}_${++this.seq}`;
    const rec = {
      id, script: scriptName, args: cleanArgs, session: sessionName,
      pid: null, state: 'running', exitCode: null,
      startedAt: Date.now(), endedAt: null, error: null,
    };
    this.runs.set(id, rec);
    this.rings.set(id, []);
    if (this.runs.size > MAX_RUNS) {
      const oldest = [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
      if (oldest) this.runs.delete(oldest.id);
    }
    this.persist();
    this.emit('run', this.view(rec));

    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'live-run.js'), scriptPath, ...cleanArgs], {
      cwd: ROOT,
      env: { ...process.env, CDP_URL: `http://127.0.0.1:${session.config.cdpPort}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(id, child);
    rec.pid = child.pid;
    this.activeBySession.set(sessionName, id);
    this.persist();

    this.pushLine(id, `[run] ${id} → ${scriptName} ${cleanArgs.join(' ')} (session ${sessionName}, CDP :${session.config.cdpPort})`);
    const leftovers = { o: '', e: '' };
    const onChunk = (key, prefix) => (buf) => {
      const text = leftovers[key] + buf.toString('utf8');
      const parts = text.split('\n');
      leftovers[key] = parts.pop() || '';
      for (const l of parts) this.pushLine(id, prefix ? `[err] ${l}` : l);
    };
    child.stdout.on('data', onChunk('o', false));
    child.stderr.on('data', onChunk('e', true));

    child.once('error', (e) => {
      rec.state = 'error';
      rec.error = e.message;
      rec.endedAt = Date.now();
      this.finishRun(id, sessionName);
    });
    child.once('exit', (code, sig) => {
      if (rec.state === 'running') {
        if (sig) { rec.state = 'killed'; rec.error = `killed (${sig})`; }
        else if (code === 0) rec.state = 'done';
        else { rec.state = 'error'; rec.error = `exit code ${code}`; }
      }
      rec.exitCode = code;
      rec.endedAt = Date.now();
      this.pushLine(id, `[run] ${rec.state} (code=${code}${sig ? `, sig=${sig}` : ''})`);
      this.finishRun(id, sessionName);
    });
    return this.view(rec);
  }

  finishRun(id, sessionName) {
    this.children.delete(id);
    if (this.activeBySession.get(sessionName) === id) this.activeBySession.delete(sessionName);
    this.persist();
    const rec = this.runs.get(id);
    if (rec) this.emit('run', this.view(rec));
  }

  /** SIGTERM the run's process only — the live browser is never touched
   *  (live-run.js suppresses browser.close; killing it only drops CDP sockets). */
  kill(id) {
    const rec = this.getRun(id);
    if (rec.state !== 'running') throw new HttpError(`run ${id} is ${rec.state}, nothing to kill`, 409);
    const child = this.children.get(id);
    rec.state = 'killed';
    rec.error = 'killed by user';
    try {
      if (child) child.kill('SIGTERM');
      else if (rec.pid) process.kill(rec.pid, 'SIGTERM');
    } catch (_) {}
    this.emit('run', this.view(rec));
    return this.view(rec);
  }
}

module.exports = new ScriptManager();

