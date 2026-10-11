#!/usr/bin/env node
/**
 * connect.js — drive a REMOTE Chrome instance (running on another machine)
 * over CDP, without starting VNC or any local browser.
 *
 * Works exactly like live.js (same commands) but connects to a remote
 * Chrome DevTools Protocol endpoint.
 *
 * Usage: node scripts/connect.js <cmd> [args...] | --stdin (JSON-lines)
 *
 * Required env:
 *   CDP_URL  — full URL of the remote Chrome DevTools endpoint
 *              e.g. http://192.168.1.100:9222
 *              (no default — you MUST set this)
 */
const { chromium } = require('playwright');
const fs = require('fs');

const BROWSER_FLAG_IDX = process.argv.indexOf('--browser');
const SELECTED_BROWSER = (BROWSER_FLAG_IDX >= 0 ? process.argv[BROWSER_FLAG_IDX + 1] : process.env.BROWSER) || 'chromium';

const browserMap = { chromium, firefox: require('playwright').firefox };
const selectedBrowser = browserMap[SELECTED_BROWSER] || chromium;

if (!selectedBrowser) {
  fs.writeSync(2, JSON.stringify({ error: 'unsupported browser: ' + SELECTED_BROWSER + ' (choose chromium or firefox)' }) + '\n');
  process.exit(1);
}

const CDP_URL = process.env.CDP_URL;
if (!CDP_URL) {
  fs.writeSync(2, JSON.stringify({
    error: 'CDP_URL env is required. Example: CDP_URL=http://192.168.1.100:9222 node scripts/connect.js <cmd>'
  }) + '\n');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser = null;
let livePages = [];
let activeIdx = 0;

const pagesOf = (b) => (b && b.contexts ? b.contexts() : []).flatMap((c) => c.pages());

function activePage() {
  livePages = livePages.filter((p) => !p.isClosed());
  if (!livePages.length) throw new Error('no open tabs');
  if (activeIdx >= livePages.length) activeIdx = 0;
  return livePages[activeIdx];
}

function result(name, data) { fs.writeSync(1, JSON.stringify({ cmd: name, ok: true, result: data }) + '\n'); }
function error(name, e) {
  fs.writeSync(1, JSON.stringify({ cmd: name, ok: false, error: String((e && e.message) || e) }) + '\n');
}

async function run(name, args) {
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
          tag: el.tagName.toLowerCase(), type: el.type,
          name: el.name || '', id: el.id || '', placeholder: el.placeholder || '',
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
    case 'pause':
      return error(name, 'pause is a live-mode command (it blocks on the local HUD)');
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
    case 'overlay-state':
      return result(name, await page.evaluate(() => ({
        installed: !!window.__serverbrowser_overlay,
        hud: !!document.getElementById('serverbrowser-hud'),
        state: window.__serverbrowser_overlay ? window.__serverbrowser_overlay.getState() : null,
      })));
    case 'db-connect': {
      console.error('[connect] datastore commands are only available in live mode');
      throw new Error('db-connect is not supported in connect mode');
    }
    case 'db-close':
    case 'db-status':
    case 'db-query':
    case 'db-exec':
    case 'db-create-table':
    case 'db-insert':
    case 'db-select':
    case 'db-update':
    case 'db-delete':
    case 'db-tables':
    case 'pause':
    case 'resume':
    case 'agent-tab-create':
    case 'agent-tab-switch':
    case 'agent-tab-close':
    case 'context-new':
    case 'context-use':
    case 'contexts':
      console.error('[connect] multitab/overlay commands are only available in live mode');
      throw new Error(name + ' is not supported in connect mode');
    default:
      throw new Error('unknown command: ' + name);
  }
}

async function main() {
  fs.writeSync(2, '[connect] connecting to remote Chrome at ' + CDP_URL + ' ...\n');
  browser = await selectedBrowser.connectOverCDP(CDP_URL);
  fs.writeSync(2, '[connect] attached — ' + pagesOf(browser).length + ' tab(s) found\n');
  livePages = await pagesOf(browser);
  if (!livePages.length) livePages = [await browser.contexts()[0].newPage()];

  const exec = async (name, args) => { try { await run(name, args); } catch (e) { error(name, e); } };

  if (process.argv.includes('--stdin')) {
    const rl = require('readline').createInterface({ input: process.stdin, terminal: false });
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let q;
      try { q = JSON.parse(line); } catch { q = { cmd: line.split(' ')[0], args: line.split(' ').slice(1) }; }
      const cmd = String(q.cmd);
      const args = (q.args || []).map(String).filter((s) => s !== '');
      chain = chain.then(() => exec(cmd, args));
    });
    rl.on('close', () => chain.then(() => process.exit(0)));
    return;
  }

  const name = process.argv[2];
  if (!name) {
    fs.writeSync(1, JSON.stringify({ error: 'usage: CDP_URL=http://IP:PORT node scripts/connect.js <command> [args...]' }) + '\n');
    process.exit(2);
  }
  await exec(name, process.argv.slice(3));
  process.exit(0);
}

main().catch((e) => { console.error(String((e && e.stack) || e)); process.exit(1); });