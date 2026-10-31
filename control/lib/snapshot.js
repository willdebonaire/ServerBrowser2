'use strict';
/**
 * snapshot.js — F7 (5.5): one-click "what's on screen" thumbnail.
 * Screenshot of the session's first page via a LONG-LIVED connectOverCDP
 * connection (one per session port, cached; we never call browser.close()
 * because over CDP that could terminate the user's browser — the connection
 * is simply kept and reused until the session dies).
 */
const { chromium } = require('playwright');

const conns = new Map(); // cdpPort → Promise<Browser>

async function connect(cdpPort) {
  if (conns.has(cdpPort)) {
    try { return await conns.get(cdpPort); } catch (_) { conns.delete(cdpPort); }
  }
  const p = chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5000 });
  conns.set(cdpPort, p);
  try {
    const b = await p;
    // If the session restarts, the socket dies — drop the cache on disconnect.
    b.on?.('disconnected', () => conns.delete(cdpPort));
    return b;
  } catch (e) {
    conns.delete(cdpPort);
    throw e;
  }
}

async function snapshot(cdpPort) {
  const browser = await connect(cdpPort);
  const ctx = (browser.contexts() || [])[0];
  if (!ctx) throw new Error('no browser context over CDP');
  const pages = (ctx.pages() || []).filter((p) => !p.isClosed());
  const page = pages[0];
  if (!page) throw new Error('no open page to capture');
  return await page.screenshot({ type: 'png' });
}

module.exports = { snapshot };
