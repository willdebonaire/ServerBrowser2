#!/usr/bin/env node
/**
 * live.js - drive the RUNNING live Chrome (started by `npm run vnc`) over CDP
 * and read data back. Attaches via connectOverCDP; never launches or closes the
 * browser, so the VNC view and logins persist.
 * Usage: node scripts/live.js <cmd> [args...] | --stdin (JSON-lines)
 * Env: CDP_URL (default http://127.0.0.1:9222)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const datastore = require(path.join(__dirname, '..', 'datastore', 'index.js'));
const tunnel = require(path.join(__dirname, 'tunnel.js'));

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:' + (process.env.CDP_PORT || 9222);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let livePages = [];
let activeIdx = 0;

const pagesOf = (b) => (b && b.contexts ? b.contexts() : []).flatMap((c) => c.pages());

let contextRegistry = {};
let agentTabRegistry = {};
let activeContextId = null;
let nextContextId = 1;
let nextAgentTabId = 1;
const MAX_TABS = 10;

function activePage() {
  livePages = livePages.filter((p) => !p.isClosed());
  if (!livePages.length) throw new Error('no open tabs');
  if (activeIdx >= livePages.length) activeIdx = 0;
  return livePages[activeIdx];
}

function getContext(contextId) {
  if (!contextId) return browser.contexts()[0];
  return contextRegistry[contextId] || null;
}

function createContextId() {
  return 'ctx-' + (nextContextId++);
}

function createAgentTabId() {
  return 'agent-' + (nextAgentTabId++);
}

async function resolveAgentId(agentId) {
  if (!agentId) return;
  const entry = agentTabRegistry[agentId];
  if (entry) {
    if (entry.page.isClosed()) throw new Error('agent tab ' + agentId + ' is closed');
    await switchAgentTab(agentId);
    return;
  }
  // Each CLI invocation is a new process, so the in-memory registry is empty
  // even though the tab is still open in the live browser. Rediscover it via
  // the marker we stamp into the page (`window.__sb_agent_id`).
  const recovered = await findAgentTabByMarker(agentId);
  if (recovered) {
    agentTabRegistry[agentId] = recovered;
    await switchAgentTab(agentId);
    await stampAgentMarker(recovered.page, agentId); // keep it discoverable
    return;
  }
  // Fresh tab for this agent — and make it the active page, otherwise the
  // command that triggered the creation would run against some other tab.
  const created = await createAgentTab(agentId, '', agentId);
  await switchAgentTab(created.id);
}

/** Locate an existing agent tab by its page marker (cross-process). */
async function findAgentTabByMarker(agentId) {
  const open = (await pagesOf(browser)).filter((p) => !p.isClosed());
  for (const page of open) {
    try {
      const marker = await page.evaluate(() => {
        if (window.__sb_agent_id) return window.__sb_agent_id;
        // init scripts registered by an earlier (now exited) process can be gone,
        // but the marker also lives in this tab's localStorage.
        try { return localStorage.getItem('__sb_agent_id'); } catch { return null; }
      });
      if (marker === agentId) return { contextId: undefined, page, name: agentId };
    } catch (_) {
      // Page without a readable context (crashed/blank) — skip it.
    }
  }
  return null;
}

/** (Re)stamp the agent marker in window + localStorage for the current document. */
async function stampAgentMarker(page, agentId) {
  if (!agentId) return;
  try {
    await page.evaluate(({ marker }) => {
      window.__sb_agent_id = marker;
      try { localStorage.setItem('__sb_agent_id', marker); } catch (_) {}
    }, { marker: agentId });
  } catch (_) {}
}

async function createAgentTab(name, contextId, fixedId) {
  if (Object.keys(agentTabRegistry).length >= MAX_TABS) {
    throw new Error(`max concurrent tabs reached (${MAX_TABS})`);
  }
  const ctx = getContext(contextId) || (browser.contexts()[0] || (await browser.newContext()));
  const page = await ctx.newPage();
  const id = fixedId || createAgentTabId();
  // Stamp a durable marker (window + localStorage) so this tab can be
  // rediscovered by id from a later process. addInitScript keeps the window
  // marker across navigations while this process is alive; the localStorage copy
  // survives even after the process that created it has exited.
  try {
    await page.addInitScript(({ marker }) => {
      window.__sb_agent_id = marker;
      try { localStorage.setItem('__sb_agent_id', marker); } catch (_) {}
    }, { marker: id });
  } catch (_) {}
  await stampAgentMarker(page, id);
  agentTabRegistry[id] = { contextId: contextId || activeContextId, page, name: name || id };
  if (!contextId && !activeContextId) {
    activeContextId = ctx._guid || id;
  }
  return { id, url: page.url(), title: await page.title(), contextId: contextId || activeContextId };
}

async function switchAgentTab(id) {
  const entry = agentTabRegistry[id];
  if (!entry) throw new Error('no agent tab with id ' + id);
  const page = entry.page;
  if (page.isClosed()) throw new Error('agent tab ' + id + ' is closed');
  livePages = await pagesOf(browser);
  activeIdx = livePages.indexOf(page);
  if (activeIdx < 0) {
    livePages.push(page);
    activeIdx = livePages.length - 1;
  }
  activeContextId = entry.contextId;
  return { active: id, url: page.url(), title: await page.title() };
}

async function closeAgentTab(id) {
  const entry = agentTabRegistry[id] || (await findAgentTabByMarker(id));
  if (!entry) throw new Error('no agent tab with id ' + id);
  const page = entry.page;
  if (!page.isClosed()) await page.close();
  delete agentTabRegistry[id];
  livePages = livePages.filter((p) => !p.isClosed());
  if (activeIdx >= livePages.length) activeIdx = livePages.length - 1;
  return { remaining: livePages.length, active: activeIdx };
}

async function ensureContext(contextId) {
  let ctx = getContext(contextId);
  if (!ctx) {
    ctx = await browser.newContext();
    contextRegistry[contextId || createContextId()] = ctx;
  }
  return ctx;
}

function result(name, data) { fs.writeSync(1, JSON.stringify({ cmd: name, ok: true, result: data }) + '\n'); }
function error(name, e) {
  fs.writeSync(1, JSON.stringify({ cmd: name, ok: false, error: String((e && e.message) || e) }) + '\n');
}

const LOCAL_COMMANDS = /^(db-|tunnel-)/;

/**
 * Local-only commands: the DuckDB datastore and tunnel management. They do not
 * touch the browser, so they work without a live session (main() skips the CDP
 * connect for them).
 */
async function runLocal(name, args) {
  const [a0, a1, a2] = args;
  switch (name) {
  case 'db-connect': {
    const dbPath = a0 || process.env.DATASTORE_PATH;
    const resolved = await datastore.connect(dbPath);
    return result(name, { path: resolved });
  }
  case 'db-close':
    datastore.close();
    return result(name, { closed: true });
  case 'db-status': {
    // Connect first so the table list is real (each CLI run is a new process).
    await datastore.connect(a0 || process.env.DATASTORE_PATH);
    return result(name, await datastore.status());
  }
  case 'db-query': {
    const sql = a0;
    if (!sql) throw new Error('usage: db-query <sql>');
    const rows = await datastore.query(sql);
    return result(name, { rows });
  }
  case 'db-exec': {
    const sql = a0;
    if (!sql) throw new Error('usage: db-exec <sql>');
    await datastore.exec(sql);
    return result(name, { ok: true });
  }
  case 'db-create-table': {
    const table = a0;
    const cols = (a1 || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!table || !cols.length) throw new Error('usage: db-create-table <table> <col1,col2,...>');
    await datastore.createTable(table, cols);
    return result(name, { table, columns: cols });
  }
  case 'db-insert': {
    const table = a0;
    const rowJson = a1;
    if (!table || !rowJson) throw new Error('usage: db-insert <table> <json>');
    const row = JSON.parse(rowJson);
    await datastore.insert(table, row);
    return result(name, { table, inserted: row });
  }
  case 'db-select': {
    const table = a0;
    const whereJson = a1;
    if (!table) throw new Error('usage: db-select <table> [whereJson]');
    const where = whereJson ? JSON.parse(whereJson) : undefined;
    const rows = await datastore.select(table, where);
    return result(name, { table, count: rows.length, rows });
  }
  case 'db-update': {
    const table = a0;
    const setJson = a1;
    const whereJson = a2;
    if (!table || !setJson || !whereJson) throw new Error('usage: db-update <table> <setJson> <whereJson>');
    await datastore.update(table, JSON.parse(setJson), JSON.parse(whereJson));
    return result(name, { table, ok: true });
  }
  case 'db-delete': {
    const table = a0;
    const whereJson = a1;
    if (!table || !whereJson) throw new Error('usage: db-delete <table> <whereJson>');
    await datastore.remove(table, JSON.parse(whereJson));
    return result(name, { table, ok: true });
  }
  case 'db-tables':
    return result(name, { tables: await datastore.listTables() });
  case 'tunnel-create': {
    // NOTE: the local variable must not be called `name` — that shadows the
    // command name used by result(name, ...).
    const tunnelName = a0 || '';
    const password = a1 || '';
    const provider = tunnel.resolveProvider(a2);
    const created = await provider.start({ name: tunnelName, password });
    return result(name, created);
  }
  case 'tunnel-route': {
    const target = a0 || '';
    const provider = tunnel.resolveProvider(a1);
    const routed = await provider.route({ target });
    return result(name, routed);
  }
  case 'tunnel-url': {
    const provider = tunnel.resolveProvider(a0);
    const info = await provider.url();
    return result(name, info);
  }
  case 'tunnel-status': {
    const provider = tunnel.resolveProvider(a0);
    const info = await provider.status();
    return result(name, info);
  }
  case 'tunnel-stop': {
    const provider = tunnel.resolveProvider(a0);
    const stopped = await provider.stop();
    return result(name, stopped);
  }
    default:
      throw new Error('unknown command: ' + name);
  }
}

async function run(name, args) {
  if (LOCAL_COMMANDS.test(name)) return runLocal(name, args);
  const page = activePage();
  const [a0, a1, a2] = args;
  switch (name) {
    case 'goto':
      await page.goto(a0, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return result(name, { url: page.url(), title: await page.title() });
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      return result(name, { url: page.url(), title: await page.title() });
    case 'back':
      await page.goBack({ waitUntil: 'domcontentloaded' });
      return result(name, { url: page.url(), title: await page.title() });
    case 'forward':
      await page.goForward({ waitUntil: 'domcontentloaded' });
      return result(name, { url: page.url(), title: await page.title() });
    case 'wait':
      await sleep(Number(a0) || 0);
      return result(name, { waitedMs: Number(a0) || 0 });
    case 'waitfor':
      await page.waitForSelector(a0, { timeout: Number(a1) || 15000 });
      return result(name, { selector: a0, present: true });
    case 'fill':
      await page.fill(a0, a1);
      return result(name, { selector: a0, text: a1 });
    case 'type':
      await page.type(a0, a1, { delay: Number(a2) || 0 });
      return result(name, { selector: a0, text: a1 });
    case 'click':
      await page.click(a0);
      return result(name, { selector: a0, url: page.url() });
    case 'press':
      await page.press(a0, a1);
      return result(name, { selector: a0, key: a1 });
    case 'keyboard':
      await page.keyboard.press(a0);
      return result(name, { key: a0 });
    case 'clear':
      await page.fill(a0, '');
      return result(name, { selector: a0, cleared: true });
    case 'url':
      return result(name, page.url());
    case 'title':
      return result(name, await page.title());
    case 'text':
      return result(name, await page.evaluate(() => (document.body ? document.body.innerText : '')));
    case 'html':
      return result(name, await page.content());
    case 'dump':
      return result(name, await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        inputs: [...document.querySelectorAll('input:not([type=hidden]),textarea,select')].map((el) => ({
          tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
          placeholder: el.placeholder || '', aria: el.getAttribute('aria-label') || '',
          value: (el.value || '').slice(0, 120),
        })).slice(0, 50),
        buttons: [...document.querySelectorAll('a,button,input[type=submit],input[type=button]')]
          .map((e) => (e.innerText || e.value || '').trim()).filter(Boolean).slice(0, 40),
        links: [...document.querySelectorAll('a[href]')].map((a) => a.href).slice(0, 40),
        text: (document.body.innerText || '').replace(/\n+/g, ' | ').slice(0, 4000),
      })));
    case 'eval': {
      const value = await page.evaluate(new Function('return ((' + a0 + '))'));
      return result(name, value);
    }
    case 'screenshot':
      await page.screenshot({ path: a0, fullPage: true });
      return result(name, { file: a0 });
    case 'tabs':
      livePages = await pagesOf(browser);
      return result(name, livePages.map((p, i) => ({ i, url: p.url(), title: p.isClosed() ? '' : '', closed: p.isClosed() })));
    case 'tab': {
      const idx = Number(a0);
      livePages = await pagesOf(browser);
      if (idx < 0 || idx >= livePages.length || livePages[idx].isClosed()) throw new Error('no open tab index ' + a0);
      activeIdx = idx;
      return result(name, { active: idx, url: livePages[idx].url(), title: await livePages[idx].title() });
    }
    case 'close-tab': {
      livePages = await pagesOf(browser);
      const open = livePages.filter((p) => !p.isClosed());
      if (open.length <= 1) return error(name, 'refusing to close the last tab (live browser must stay open)');
      let target;
      if (a0 !== undefined && !/^\d+$/.test(String(a0))) {
        for (const p of open) { try { if (await p.$(a0)) { target = p; break; } } catch (_) {} }
        if (!target) throw new Error('no tab with selector ' + a0);
      } else {
        const ci = a0 === undefined ? activeIdx : Number(a0);
        if (ci >= livePages.length || livePages[ci].isClosed()) throw new Error('no open tab index ' + ci);
        target = livePages[ci];
      }
      await target.close();
      livePages = livePages.filter((p) => !p.isClosed());
      if (activeIdx >= livePages.length) activeIdx = livePages.length - 1;
      return result(name, { remaining: livePages.length, active: activeIdx });
    }
    case 'status-set': {
      const text = a0 || '';
      await page.evaluate((t) => {
        if (window.__serverbrowser_overlay) window.__serverbrowser_overlay.setText(t);
      }, text);
      return result(name, { text });
    }
    case 'progress': {
      const value = Number(a0);
      await page.evaluate((v) => {
        if (window.__serverbrowser_overlay) window.__serverbrowser_overlay.setProgress(v);
      }, value);
      return result(name, { progress: value });
    }
    case 'notify': {
      const text = a0 || '';
      const duration = Number(a1) || 4000;
      // Playwright's evaluate takes a single argument — pass an object.
      await page.evaluate(({ t, d }) => {
        if (window.__serverbrowser_overlay) window.__serverbrowser_overlay.notify(t, d);
      }, { t: text, d: duration });
      return result(name, { text, duration });
    }
    case 'pause': {
      // Docs (docs/LIVE-DRIVE.md § pause/resume): "Pause the agent. Returns when
      // `resume` is issued or the timeout fires." The agent raises the flag
      // itself, the HUD then shows Resume, and the human clicks it to release.
      const timeoutMs = Number(process.env.PAUSE_TIMEOUT_MS || 30000);
      const startedAt = Date.now();
      await page.evaluate(() => {
        if (window.__serverbrowser_overlay) window.__serverbrowser_overlay.pause();
      });
      while (true) {
        await page.waitForTimeout(500);
        const paused = await page.evaluate(() => (window.__serverbrowser_overlay ? window.__serverbrowser_overlay.isPaused() : false));
        if (!paused) break;
        if (timeoutMs > 0 && Date.now() - startedAt > timeoutMs) {
          await page.evaluate(() => {
            if (window.__serverbrowser_overlay) window.__serverbrowser_overlay.resume();
          });
          return result(name, { paused: true, autoResumed: true, waitedMs: Date.now() - startedAt, timeoutMs });
        }
      }
      return result(name, { paused: true, resumed: true, waitedMs: Date.now() - startedAt });
    }
    case 'resume':
      await page.evaluate(() => {
        if (window.__serverbrowser_overlay) {
          window.__serverbrowser_overlay.resume();
          return;
        }
        // Fallback for pages loaded before the HUD existed.
        const state = (() => {
          try {
            const raw = localStorage.getItem('serverbrowser_overlay_state');
            return raw ? JSON.parse(raw) : {};
          } catch {
            return {};
          }
        })();
        if (state.paused) {
          state.paused = false;
          localStorage.setItem('serverbrowser_overlay_state', JSON.stringify(state));
          window.dispatchEvent(new StorageEvent('storage', { key: 'serverbrowser_overlay_state', newValue: JSON.stringify(state) }));
        }
      });
      return result(name, { resumed: true });
    case 'overlay-state':
      return result(name, await page.evaluate(() => ({
        installed: !!window.__serverbrowser_overlay,
        hud: !!document.getElementById('serverbrowser-hud'),
        state: window.__serverbrowser_overlay ? window.__serverbrowser_overlay.getState() : null,
      })));
    case 'save-page-json': {
      const path = a0 || '';
      const data = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        html: document.documentElement.outerHTML,
        text: document.body ? document.body.innerText : '',
        links: [...document.querySelectorAll('a[href]')].map((a) => ({ href: a.href, text: (a.innerText || '').trim() })),
        images: [...document.querySelectorAll('img')].map((img) => ({ src: img.src, alt: img.alt || '' })),
        inputs: [...document.querySelectorAll('input,textarea,select')].map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', value: (el.value || '').slice(0, 200) })),
      }));
      if (path) {
        require('fs').writeFileSync(path, JSON.stringify(data, null, 2));
      }
      return result(name, data);
    }
    case 'extract-css': {
      const selector = a0 || '';
      const items = await page.evaluate((sel) => {
        const results = [];
        for (const el of document.querySelectorAll(sel)) {
          results.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || '').trim().slice(0, 500),
            html: el.innerHTML.slice(0, 500),
            href: el.href || '',
            src: el.src || '',
          });
        }
        return results;
      }, selector);
      return result(name, { selector, count: items.length, items });
    }
    case 'extract-regex': {
      const pattern = a0 || '';
      const flags = a1 || '';
      const matches = await page.evaluate(({ pat, flg }) => {
        try {
          const re = new RegExp(pat, flg);
          const text = document.body ? document.body.innerText : '';
          const results = [];
          let m;
          while ((m = re.exec(text)) !== null) {
            results.push(m[0]);
            if (!re.global) break;
          }
          return results;
        } catch (e) {
          return { error: e.message };
        }
      }, { pat: pattern, flg: flags });
      return result(name, { pattern, flags, matches });
    }
    case 'extract-table': {
      const selector = a0 || 'table';
      const tables = await page.evaluate((sel) => {
        const results = [];
        for (const table of document.querySelectorAll(sel)) {
          const headers = [...table.querySelectorAll('thead th')].map((th) => (th.innerText || '').trim());
          const rows = [...table.querySelectorAll('tbody tr')].map((tr) => {
            const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim());
            const row = {};
            headers.forEach((h, i) => { row[h || i] = cells[i] || ''; });
            return row;
          });
          results.push({ headers, rows });
        }
        return results;
      }, selector);
      return result(name, { selector, tables });
    }
    case 'extract-links': {
      const filter = a0 || '';
      const links = await page.evaluate((f) => {
        const results = [];
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.href;
          const text = (a.innerText || '').trim();
          if (!f || href.includes(f) || text.toLowerCase().includes(f.toLowerCase())) {
            results.push({ href, text: text.slice(0, 200) });
          }
        }
        return results;
      }, filter);
      return result(name, { filter, count: links.length, links });
    }
    case 'extract-images': {
      const images = await page.evaluate(() => {
        const results = [];
        for (const img of document.querySelectorAll('img')) {
          results.push({ src: img.src, alt: img.alt || '', width: img.width, height: img.height });
        }
        return results;
      });
      return result(name, { count: images.length, images });
    }
    case 'screenshot-element': {
      const selector = a0;
      const filePath = a1;
      if (!selector || !filePath) throw new Error('usage: screenshot-element <selector> <path>');
      const el = await page.locator(selector);
      await el.screenshot({ path: filePath });
      return result(name, { selector, file: filePath });
    }
    case 'pdf': {
      const filePath = a0;
      if (!filePath) throw new Error('usage: pdf <path>');
      await page.pdf({ path: filePath });
      return result(name, { file: filePath });
    }
    case 'agent-tab-create': {
      const name = a0 || '';
      const ctxId = a1 || '';
      const created = await createAgentTab(name, ctxId || undefined);
      return result(name, created);
    }
    case 'agent-tab-switch': {
      const id = a0;
      if (!id) throw new Error('usage: agent-tab-switch <id>');
      const switched = await switchAgentTab(id);
      return result(name, switched);
    }
    case 'agent-tab-close': {
      const id = a0;
      if (!id) throw new Error('usage: agent-tab-close <id>');
      const closed = await closeAgentTab(id);
      return result(name, closed);
    }
    case 'agent-tabs': {
      const open = (await pagesOf(browser)).filter((p) => !p.isClosed());
      const listing = [];
      for (let i = 0; i < open.length; i += 1) {
        let agentId = null;
        try { agentId = await open[i].evaluate(() => window.__sb_agent_id || null); } catch (_) {}
        listing.push({ index: i, agentId, url: open[i].url() });
      }
      return result(name, { count: listing.length, tabs: listing });
    }
    case 'context-new': {
      const ctx = await browser.newContext();
      const ctxId = createContextId();
      contextRegistry[ctxId] = ctx;
      activeContextId = ctxId;
      return result(name, { contextId: ctxId });
    }
    case 'context-use': {
      const ctxId = a0;
      if (!ctxId) throw new Error('usage: context-use <id>');
      const ctx = getContext(ctxId);
      if (!ctx) throw new Error('no context with id ' + ctxId);
      activeContextId = ctxId;
      return result(name, { contextId: ctxId });
    }
    case 'contexts':
      return result(name, Object.keys(contextRegistry));
    default:
      throw new Error('unknown command: ' + name);
  }
}

async function main() {
  // Parse `--agent-id <id>` from anywhere in argv (both orders are common) and
  // remove it so it never gets mistaken for the command name.
  const argv = process.argv.slice(2);
  const agentIdIdx = argv.indexOf('--agent-id');
  let cliAgentId = null;
  if (agentIdIdx >= 0) {
    cliAgentId = argv[agentIdIdx + 1] || null;
    argv.splice(agentIdIdx, 2);
  }

  const exec = async (name, args, agentId) => {
    if (agentId) await resolveAgentId(agentId);
    try { await run(name, args); } catch (e) { error(name, e); }
  };

  // Datastore + tunnel commands are local: no browser session required.
  if (argv[0] && LOCAL_COMMANDS.test(argv[0])) {
    await exec(argv[0], argv.slice(1), null);
    process.exit(0);
  }

  browser = await chromium.connectOverCDP(CDP_URL);
  livePages = await pagesOf(browser);
  if (!livePages.length) livePages = [await browser.contexts()[0].newPage()];

  if (argv.includes('--stdin')) {
    const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let q;
      try { q = JSON.parse(line); } catch { q = { cmd: line.split(' ')[0], args: line.split(' ').slice(1) }; }
      const cmd = String(q.cmd);
      const args = (q.args || []).map(String).filter((s) => s !== '');
      const id = String(q.agentId || cliAgentId || '');
      chain = chain.then(() => exec(cmd, args, id));
    });
    rl.on('close', () => chain.then(() => process.exit(0)));
    return;
  }

  const name = argv[0];
  if (!name) {
    fs.writeSync(1, JSON.stringify({ error: 'usage: node scripts/live.js <command> [args...] [--agent-id <id>]' }) + '\n');
    process.exit(2);
  }
  await exec(name, argv.slice(1), cliAgentId);
  process.exit(0);
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });
