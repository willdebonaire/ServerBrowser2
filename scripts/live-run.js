#!/usr/bin/env node
/**
 * live-run.js — run an EXISTING stored script against the LIVE Chrome instance
 * (the one started by `npm run vnc`), over and over again, WITHOUT ever closing
 * the browser.
 *
 * It intercepts the `playwright.chromium.launch(...)` / `launchPersistentContext(...)`
 * calls that stored scripts make and redirects them to attach to the running
 * browser via `chromium.connectOverCDP`. Any `browser.close()` / `context.close()`
 * call is suppressed (logged) so the live instance — and your VNC view + logins —
 * stay intact across runs.
 *
 * Usage:
 *   npm run live-run -- <script.js> [script args...]
 *   node scripts/live-run.js <script.js> [script args...]
 *
 * Example:
 *   npm run live-run -- dataforthai.js some-arg
 *   npm run live-run -- batch.js codes.csv
 *
 * Env: CDP_URL (default http://127.0.0.1:9222)
 */
const path = require('path');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || `http://127.0.0.1:${process.env.CDP_PORT || 9222}`;
const noop = async (what) => { console.log(`[live-run] suppressed ${what || 'close'} (browser stays open)`); };

if (!process.argv[2]) {
  console.error('usage: node scripts/live-run.js <script.js> [script args...]');
  process.exit(2);
}
const scriptPath = path.resolve(process.argv[2]);
const scriptArgs = process.argv.slice(3);

let exitScheduled = false;
function scheduleExit() {
  if (exitScheduled) return;
  exitScheduled = true;
  // Let the script's final log lines flush, then detach this CDP client and
  // exit — the REAL browser stays open (OS closing our socket doesn't touch it).
  setTimeout(() => { console.log('[live-run] done — live browser stays open'); process.exit(0); }, 800);
}

async function patchBrowser() {
  const real = await chromium.connectOverCDP(CDP_URL);
  const ctx = (real.contexts() || [])[0] || (await real.newContext());

  const bridge = {
    async newPage(opts) { return ctx.newPage(opts); },
    async newContext(opts) {
      if (opts && opts.viewport) { try { await ctx.setViewportSize(opts.viewport); } catch (_) {} }
      if (opts && opts.userAgent) { try { await ctx.setExtraHTTPHeaders({}); } catch (_) {} }
      return ctx;
    },
    async newPages() { return ctx.pages(); },
    close: async () => { noop('browser.close'); scheduleExit(); },
  };
  // Make the single shared context ignore close() too.
  ctx.close = async () => { noop('context.close'); scheduleExit(); };

  return new Proxy(real, {
    get(t, prop) {
      if (prop in bridge) return bridge[prop];
      const v = Reflect.get(t, prop);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

(async () => {
  const liveBrowser = await patchBrowser();
  const pw = require('playwright');            // the shared singleton the script will import
  pw.chromium.launch = async () => liveBrowser;
  pw.chromium.launchPersistentContext = async () => liveBrowser;

  // Hand our script the same argv it would see when run directly:
  //   node <script> [script args...]
  process.argv = [process.argv[0], scriptPath, ...scriptArgs];

  console.log(`[live-run] ===> running ${scriptPath} on the live Chrome (${CDP_URL})`);
  const started = Date.now();
  try {
    require(scriptPath);
  } catch (e) {
    console.error('[live-run] script threw:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
  console.log(`[live-run] started ${scriptPath}; browser stays open (browser.close suppressed)`);
})().catch((e) => {
  console.error('[live-run] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});