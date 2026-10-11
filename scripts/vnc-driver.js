#!/usr/bin/env node
/**
 * vnc-driver.js — launch a HEADED, real Google Chrome (not Chromium) via
 * Playwright on the DISPLAY set by vnc-server.sh, with a persistent profile
 * and the Chrome DevTools Protocol (CDP) port exposed so that external
 * Playwright processes can attach with `chromium.connectOverCDP(...)` and
 * drive it live.
 *
 * This process stays alive (holding the browser open). It is killed by the
 * vnc-server.sh cleanup trap when the npm run vnc session ends.
 *
 * Args (also read from env):
 *   --cdp-port N   CDP port                 (CDP_PORT, default 9222)
 *   --profile P    user-data-dir            (PROFILE, default ../profile)
 *   --start-url U  first tab's URL          (START_URL)
 *   --resolution WxH  viewport/window size  (default 1280x800)
 *   --local-chrome  attach to existing Chrome instead of launching
 *   --local-chrome-port N  CDP port for local Chrome (defaults to CDP_PORT)
 */
const path = require('path');
const { chromium } = require('playwright');

// Full stealth layer (plugin array, window.chrome, WebGL, permissions, ...).
// Exported as a browser-side function by ../stealth.js and injected verbatim.
const STEALTH_INIT = require(path.resolve(__dirname, '..', 'stealth.js'));

// VNC HUD overlay injected on every new document for status/progress/notifications.
// The overlay is a *page* script, so its runtime configuration is passed as a
// JSON preamble (a page script cannot read process.env). The CLI shebang must be
// stripped: `#!` is only legal on line 1, and the preamble now occupies that slot
// — leaving it in place makes the whole injected script a SyntaxError.
const OVERLAY_SRC = require('fs').readFileSync(path.resolve(__dirname, '..', 'scripts', 'overlay.js'), 'utf8')
  .replace(/^#![^\n]*\n/, '');
const OVERLAY_CONFIG = {
  autoHideSeconds: Number(process.env.OVERLAY_AUTO_HIDE_SECONDS || 10),
  pauseTimeoutMs: Number(process.env.PAUSE_TIMEOUT_MS || 30000),
};
const OVERLAY_INIT = `window.__serverbrowser_overlay_config = ${JSON.stringify(OVERLAY_CONFIG)};\n${OVERLAY_SRC}`;

const getArg = (key) => {
  const i = process.argv.indexOf(key);
  return i >= 0 ? process.argv[i + 1] : null;
};

const CDP_PORT = getArg('--cdp-port') || process.env.CDP_PORT || '9222';
const PROFILE = getArg('--profile') || process.env.PROFILE || path.resolve(__dirname, '..', 'profile');
const START_URL = getArg('--start-url') || process.env.START_URL || 'http://127.0.0.1:6080/';
const RESOLUTION = getArg('--resolution') || process.env.RESOLUTION || '1280x800';
const BROWSER = getArg('--browser') || process.env.BROWSER || 'chrome';
const LOCAL_CHROME = process.argv.includes('--local-chrome');

const parseResolution = (res) => {
  const match = String(res).match(/^(\d+)x(\d+)$/);
  if (!match) throw new Error(`Invalid resolution: ${res}. Expected WIDTHxHEIGHT, e.g. 1920x1080`);
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
};

const VIEWPORT = parseResolution(RESOLUTION);
const WINDOW_SIZE = `${VIEWPORT.width},${VIEWPORT.height}`;

const getBrowserLauncher = (browserName) => {
  const name = String(browserName).toLowerCase();
  if (name === 'firefox') {
    try {
      return { launcher: require('playwright').firefox, name: 'firefox' };
    } catch {
      throw new Error('Firefox is not installed. Run: npx playwright install firefox');
    }
  }
  if (name === 'chromium') {
    return { launcher: chromium, name: 'chromium' };
  }
  return { launcher: chromium, name: 'chrome' };
};

const { launcher: browserLauncher, name: browserName } = getBrowserLauncher(BROWSER);

const commonArgs = [
  `--remote-debugging-port=${CDP_PORT}`,
  '--remote-debugging-address=127.0.0.1',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--disable-default-apps',
  '--window-size=' + WINDOW_SIZE,
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--no-default-browser-check',
];

const launchOptions = {
  headless: false,
  viewport: VIEWPORT,
  args: commonArgs,
};

if (browserName === 'chrome') {
  launchOptions.channel = 'chrome';
  launchOptions.executablePath = '/usr/bin/google-chrome';
} else if (browserName === 'firefox') {
  launchOptions.channel = 'firefox';
  launchOptions.executablePath = undefined;
}

(async () => {
  if (LOCAL_CHROME) {
    try {
      const localChrome = require(path.resolve(__dirname, 'local-chrome.js'));
      // No explicit port => auto-detect across the common CDP ports.
      const port = getArg('--local-chrome-port') || process.env.LOCAL_CHROME_PORT || null;
      const { browser, port: detectedPort } = await localChrome.connectLocalChrome(port);
      console.log(`[driver] attached to local Chrome on CDP http://127.0.0.1:${detectedPort}/json/version`);

      // Best-effort: install the stealth layer + HUD on contexts we can still
      // configure. Existing pages in the user's browser are left untouched.
      try {
        await browser.contexts()[0].addInitScript(STEALTH_INIT);
        await browser.contexts()[0].addInitScript(OVERLAY_INIT);
        console.log('[driver] stealth + HUD injected into the default context');
      } catch (e) {
        console.log(`[driver] could not inject stealth/HUD (${e.message}) — continuing`);
      }

      const shutdown = async () => {
        // Do NOT call browser.close() here: on a CDP connection it can terminate
        // the user's own browser. Exiting drops the socket, which detaches us.
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      process.on('SIGHUP', shutdown);
      process.stdin.resume();
    } catch (e) {
      console.error('[driver] local-chrome failed:', e && e.message ? e.message : e);
      process.exit(1);
    }
    return;
  }

  const context = await browserLauncher.launchPersistentContext(PROFILE, launchOptions);

  // Inject the full anti-detection script on every new document.
  // Previously this only stubbed navigator.plugins with `[1,2,3,4,5]` — an
  // Array of integers, not a PluginArray of Plugin objects. Cloudflare's
  // Turnstile fingerprints exactly that and refused to render its widget
  // (0x0) as a result. stealth.js provides a realistic PluginArray /
  // MimeTypeArray plus window.chrome, WebGL vendor, permissions, languages.
  await context.addInitScript(STEALTH_INIT);
  await context.addInitScript(OVERLAY_INIT);

  const page = context.pages()[0] || (await context.newPage());
  try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  } catch (e) {
    console.log(`[driver] could not load start url (${e.message})`);
  }

  console.log(`[driver] ${browserName} running → CDP http://127.0.0.1:${CDP_PORT}/json/version`);
  console.log(`[driver] attach with:  chromium.connectOverCDP('http://127.0.0.1:${CDP_PORT}')`);

  // Startup self-check: proves the stealth layer + HUD init scripts actually
  // reached the document (they are easy to break silently — e.g. a page-side
  // reference to a Node global makes the whole injected script throw).
  try {
    const check = await page.evaluate(() => ({
      stealth: typeof navigator.webdriver === 'undefined' ? 'patched' : 'unpatched',
      overlayConfig: typeof window.__serverbrowser_overlay_config,
      overlayApi: typeof window.__serverbrowser_overlay,
      hud: !!document.getElementById('serverbrowser-hud'),
    }));
    console.log('[driver] self-check:', JSON.stringify(check));
  } catch (e) {
    console.log('[driver] self-check failed:', e.message);
  }

  const shutdown = async () => {
    try { await context.close(); } catch (_) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.stdin.resume();
})().catch((e) => {
  console.error('[driver] fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});