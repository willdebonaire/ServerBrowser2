'use strict';
/**
 * browser-registry.js — F7: saved browser definitions (reusable launch
 * templates): type, profile, screen, start URL, port overrides, local-chrome
 * attach, VNC-password intent. Persisted to datastore/browsers.json (0600).
 * Launch itself is delegated to the session manager (one code path).
 */
const fs = require('fs');
const path = require('path');
const state = require('./state');
const health = require('./health');
const { HttpError } = require('./session-manager');

const BROWSERS = ['chrome', 'chromium', 'firefox'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i;
const FILE = 'browsers';

function normalizeScreenLike(input) {
  const s = String(input || '').trim();
  if (/^\d{3,4}x\d{3,4}(x\d{1,2})?$/.test(s)) return s.includes('x') && s.split('x').length === 3 ? s : `${s}x24`;
  throw new HttpError(`invalid screen "${input}" (WxH or WxHxD)`);
}

class BrowserRegistry {
  constructor() { this.defs = new Map(); }

  init() {
    const saved = state.load(FILE, { browsers: [] });
    for (const d of saved.browsers || []) if (d && ID_RE.test(d.id || '')) this.defs.set(d.id, d);
  }

  persist() { state.save(FILE, { browsers: [...this.defs.values()] }); }

  list() {
    return [...this.defs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    const d = this.defs.get(id);
    if (!d) throw new HttpError(`no browser definition "${id}"`, 404);
    return d;
  }

  validate(body = {}, existingId = null) {
    const id = String(body.id || '').trim();
    if (!ID_RE.test(id)) throw new HttpError('id must be a valid name (letters, digits, - or _; max 32)');
    if (id !== existingId && this.defs.has(id)) throw new HttpError(`browser "${id}" already exists`, 409);
    const def = {
      id,
      label: String(body.label || id).slice(0, 64),
      browser: String(body.browser || 'chrome').toLowerCase(),
      screen: normalizeScreenLike(body.screen || '1920x1080'),
      profile: body.profile ? String(body.profile) : '',           // '' = default rule
      startUrl: body.startUrl !== undefined ? String(body.startUrl) : '',
      webPort: body.webPort ? parseInt(body.webPort, 10) : null,   // null = auto
      rfbPort: body.rfbPort ? parseInt(body.rfbPort, 10) : null,
      cdpPort: body.cdpPort ? parseInt(body.cdpPort, 10) : null,
      display: body.display !== undefined && body.display !== null && body.display !== '' ? parseInt(body.display, 10) : null,
      localChrome: !!body.localChrome,
      localChromePort: body.localChromePort ? parseInt(body.localChromePort, 10) : null,
      vncPassword: !!body.vncPassword,   // prompt for a password at launch time
    };
    if (!BROWSERS.includes(def.browser)) throw new HttpError(`browser must be one of: ${BROWSERS.join(', ')}`);
    for (const k of ['webPort', 'rfbPort', 'cdpPort']) {
      if (def[k] != null && (!Number.isInteger(def[k]) || def[k] < 1024 || def[k] > 65535)) {
        throw new HttpError(`${k} must be 1024–65535`);
      }
    }
    if (def.display != null && (!Number.isInteger(def.display) || def.display < 1 || def.display > 599)) {
      throw new HttpError('display must be 1–599');
    }
    if (def.localChromePort != null && (!Number.isInteger(def.localChromePort) || def.localChromePort < 1024)) {
      throw new HttpError('localChromePort must be a valid port');
    }
    return def;
  }

  create(body) {
    const def = this.validate(body);
    this.defs.set(def.id, def);
    this.persist();
    return def;
  }

  update(id, body) {
    const cur = this.get(id);
    const def = this.validate({ ...cur, ...body, id }, id);
    this.defs.set(id, def);
    this.persist();
    return def;
  }

  remove(id) {
    this.get(id);
    this.defs.delete(id);
    this.persist();
    return { removed: id };
  }

  /** Map a definition to a session-manager prepareStart() body. */
  toStartBody(def, extra = {}) {
    const body = {
      name: extra.sessionName || def.id,
      browser: def.browser,
      screen: def.screen,
      startUrl: def.startUrl,
      localChrome: def.localChrome,
    };
    if (def.profile) body.profile = def.profile;
    if (def.localChromePort) body.localChromePort = def.localChromePort;
    if (extra.cdpPort) body.localChromePort = extra.cdpPort;   // attach target override
    if (def.webPort != null) body.webPort = def.webPort;
    if (def.rfbPort != null) body.rfbPort = def.rfbPort;
    if (def.cdpPort != null) body.cdpPort = def.cdpPort;
    if (def.display != null) body.display = def.display;
    return body;
  }

  /** Probe the CLI's auto-detect CDP range for external Chromes to attach to.
   *  Ports owned by our own running sessions are excluded — attaching a second
   *  stack to them would be redundant. */
  async localChromeCandidates() {
    const sessionManager = require('./session-manager');
    const owned = new Set();
    for (const rec of sessionManager.records.values()) {
      if (['starting', 'running', 'degraded'].includes(rec.state)) owned.add(rec.config.cdpPort);
    }
    const out = [];
    for (let port = 9222; port <= 9224; port++) {
      if (owned.has(port)) continue;
      const ok = await health.probeCdp(port);
      if (!ok) continue;
      let browser = 'unknown';
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
        const j = await res.json();
        browser = j.Browser || 'unknown';
      } catch (_) {}
      out.push({ port, browser });
    }
    return out;
  }
}

module.exports = new BrowserRegistry();
