#!/usr/bin/env node
/**
 * connect-run.js — run an EXISTING stored script against a REMOTE Chrome
 * instance over CDP, WITHOUT starting VNC or any local browser.
 *
 * It intercepts the `playwright.chromium.launch(...)` / `launchPersistentContext(...)`
 * calls that stored scripts make and redirects them to attach to the remote
 * browser via `chromium.connectOverCDP`. Any `browser.close()` / `context.close()`
 * call is suppressed (logged) so the remote instance stays intact.
 *
 * Usage:
 *   CDP_URL=http://192.168.1.100:9222 node scripts/connect-run.js <script.js> [script args...]
 *
 * Example:
 *   CDP_URL=http://192.168.1.100:9222 npm run connect-run -- dataforthai.js some-arg
 *   CDP_URL=http://192.168.1.100:9222 npm run connect-run -- batch.js codes.csv
 *
 * Required env:
 *   CDP_URL  — full URL of the remote Chrome DevTools endpoint
 *              e.g. http://192.168.1.100:9222
 */
const path = require('path');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL;
if (!CDP_URL) {
  console.error('CDP_URL env is required. Example: CDP_URL=http://192.168.1.100:9222 npm run connect-run -- <script.js>');
  process.exit(1);
}

const noop = async (what) => { console.log('[connect-run] suppressed ' + (what || 'close') + ' (remote browser stays open)'); };

if (!process.argv[2]) {
  console.error('usage: CDP_URL=http://IP:PORT node scripts/connect-run.js <script.js> [script args...]');
  process.exit(2);
}
const scriptPath = path.resolve(process.argv[2]);
const scriptArgs = process.argv.slice(3);

let exitScheduled = false;
function scheduleExit() {
  if (exitScheduled) return;
  exitScheduled = true;
  setTimeout(() => { console.log('[connect-run] done — remote browser stays open'); process.exit(0); }, 800);
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
  console.log('[connect-run] connecting to remote Chrome at ' + CDP_URL + ' ...');
  const remoteBrowser = await patchBrowser();
  const pw = require('playwright');
  pw.chromium.launch = async () => remoteBrowser;
  pw.chromium.launchPersistentContext = async () => remoteBrowser;

  process.argv = [process.argv[0], scriptPath, ...scriptArgs];

  console.log('[connect-run] ===> running ' + scriptPath + ' on remote Chrome (' + CDP_URL + ')');
  const started = Date.now();
  try {
    require(scriptPath);
  } catch (e) {
    console.error('[connect-run] script threw:', e && e.stack ? e.stack : e);
    process.exit(1);
  }
  console.log('[connect-run] started ' + scriptPath + '; remote browser stays open (browser.close suppressed)');
})().catch((e) => {
  console.error('[connect-run] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
