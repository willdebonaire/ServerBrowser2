# Stealth layer

The "stealth" patches hide the fact that the browser is automated.
This page explains what each patch does, why, and what it does NOT
do.

## What the bot-detection industry looks at

Anti-bot services (FingerprintJS, Cloudflare, DataDome, PerimeterX,
Kasada, CreepJS, ...) use a mix of techniques. The most common
**technical** tells for a vanilla headless Chromium are:

| Signal | What they do with it |
| ------ | -------------------- |
| `navigator.webdriver === true` | Trivially flags the page as automated. |
| `cdc_adoQpoasnfa76pfcZLmcfl_` global | Injected by Playwright/CDP into every page. |
| `__webdriver_evaluate` / `__webdriver_scriptFunction` etc. on Navigator/Document | Same — Playwright injection artifact. |
| Missing `window.chrome` | Headless Chromium doesn't expose it; real Chrome always does. |
| `navigator.plugins.length === 0` | Headless reports 0 plugins. Real Chrome has at least 5. |
| `navigator.mimeTypes.length === 0` | Same idea. |
| `WebGL UNMASKED_VENDOR_WEBGL === "Google Inc."` and `UNMASKED_RENDERER_WEBGL === "SwiftShader"` | Headless falls back to the SwiftShader software renderer. |
| `Permissions.query({name:'notifications'})` returning a non-`prompt` value when no decision has been made | Indicates headless. |
| `navigator.languages` empty or not matching the locale | Indicates a default browser install. |
| `User-Agent` contains `HeadlessChrome` | Direct flag. |
| Visible "Chrome is being controlled by automated test software" infobar | Direct flag. |

The `ServerBrowser/` stealth layer (in `stealth.js`, injected via
`addInitScript` so it runs **before** any page script) patches every
one of these. The full mapping is:

| Signal | Patch |
| ------ | ----- |
| `navigator.webdriver` | `Object.defineProperty` on `Navigator.prototype` to return `undefined`. |
| `cdc_*` / `__webdriver_*` / `__phantom*` / `__nightmare*` / `__driver_*` / `__selenium_*` globals | `delete` from `window`, `document`, `Navigator.prototype`, `Document.prototype`. |
| Missing `window.chrome` | Stub `window.chrome.app`, `chrome.csi()`, `chrome.loadTimes()`, `chrome.runtime`. |
| 0 `navigator.plugins` / `mimeTypes` | Replace with a 6-plugin PluginArray (PDF, Native Client, etc.) and a 4-mimeType MimeTypeArray, with `item()`/`namedItem()`/`refresh()` methods. |
| `WebGL vendor/renderer = SwiftShader` | Patch `WebGLRenderingContext.getParameter` to return `Intel Inc.` and `Intel Iris OpenGL Engine` for the unmasked vendor/renderer params. Also expose the `WEBGL_debug_renderer_info` extension. |
| `Permissions.query` for notifications | Forward `Notification.permission` directly instead of the default. |
| `navigator.languages` mismatch | Override to `['en-US', 'en']` to match the default locale. |
| UA contains "Headless" | Rewrite via `Navigator.prototype` getter (belt and suspenders; primary fix is the `userAgent` launch option). |
| Chrome infobar | `ignoreDefaultArgs: ['--enable-automation']` + `disable-blink-features=AutomationControlled` + `--no-first-run` + `--no-default-browser-check`. |
| Old headless mode | Uses the new headless implementation (Playwright >= 1.40 default, which is dramatically less bot-like). |
| Bundled Chromium not Chrome | `channel: 'chrome'` + `executablePath: '/usr/bin/google-chrome'`. |
| `navigator.connection` missing | Stub with `{ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }`. |

The result: a fresh `https://bot.sannysoft.com` run reports all
checks **passing**.

## Testing your own stealth

### 1. The built-in `--check` mode

```bash
node headless.js --check https://bot.sannysoft.com
```

Output is a JSON fingerprint. Look for:

- `webdriver` is **missing** (= `undefined`) — the number-one
  giveaway is gone.
- `userAgent` does NOT contain `Headless`.
- `plugins` is `6`, `mimeTypes` is `4` (not 0).
- `hasChrome`, `hasChromeRuntime`, `hasChromeCSI`, `hasChromeLoadTimes` are all `true`.
- `webglVendor` is `Intel Inc.`, not `Google Inc.`
- `webglRenderer` is `Intel Iris OpenGL Engine`, not `SwiftShader`.

### 2. Other public detection sites

These are all reachable through the stealth browser and will report
clean:

- `https://bot.sannysoft.com` — the gold-standard basic test.
- `https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html` — Intoli's test.
- `https://browserleaks.com` — IP / canvas / WebGL leaks.
- `https://fingerprintjs.github.io/fingerprintjs/` — FingerprintJS demo.

For the very-hardest suites (e.g. `https://abrahamjuliot.github.io/creepjs/`),
even the stealth layer is not enough — those use canvas/font
fingerprinting that no open-source patch can reliably defeat.

### 3. The library form

```js
const { launch } = require('./headless');
const { page, close } = await launch({ url: 'https://bot.sannysoft.com' });
const report = await page.evaluate(() => ({
  webdriver:        navigator.webdriver,
  hasWebDriverCdc:  typeof window.cdc_adoQpoasnfa76pfcZLmcfl_ !== 'undefined',
  hasChrome:        !!window.chrome,
  pluginsLength:    navigator.plugins.length,
}));
console.log(report);
await close();
```

Expected output:

```js
{
  webdriver: undefined,         // ← properly hidden
  hasWebDriverCdc: false,       // ← no Playwright injection marker
  hasChrome: true,
  pluginsLength: 6,
}
```

## What the stealth layer does NOT do

Be aware of the limits:

1. **No canvas/font/audio fingerprint randomization.** The pixel-level
   noise in canvas rendering is slightly different per browser
   configuration. Sophisticated fingerprinters (CreepJS, FPStalker)
   can still distinguish you from a "real" user if you visit the
   same site many times — the noise is stable, just unique.
2. **No proxy integration.** If the IP you come from is on a spam
   list, no amount of browser-level stealth helps. Configure a
   residential proxy outside of this project.
3. **No behavioral defense.** If you make 100 requests in 5 seconds,
   you'll get rate-limited. The `human.*` helpers add per-action
   delays, but for high-volume use you need to add your own
   backoff.
4. **Not 100% against the hardest suites.** The very best
   fingerprinting tools combine IP, canvas, audio, font,
   `navigator.*`, and CDP-level signals. The stealth layer makes you
   **inconclusive** rather than definitively real — most sites will
   let you through, but the most paranoid ones may still flag you.
5. **No CAPTCHA solving.** If a site shows a CAPTCHA, the script
   cannot solve it. Use `--headed` to solve it manually; the
   successful login persists in the profile.
6. **No ToS enforcement.** This is a technical tool. Don't use it
   to violate a site's terms of service.

## Cloudflare Turnstile / CAPTCHA handling (VNC headed session)

When driving the **live VNC Chrome** (`npm run vnc`), the stealth layer in
`stealth.js` is **not automatically applied** — `stealth.js` is only used
by `headless.js`. The VNC Chrome is launched by `scripts/vnc-driver.js`,
which has its own anti-detection setup. Here is the full technique for
keeping Cloudflare happy in a headed VNC session.

### The problem — what Cloudflare Turnstile checks

| Signal | Why it matters |
| ------ | -------------- |
| `navigator.webdriver === true` | The **#1** giveaway. Chrome sets this when launched via CDP/Playwright. |
| `window.cdc_*` / `__webdriver_*` globals | Injection artifacts from Playwright/CDP. |
| Rapid page navigation | 5+ URLs in < 30 seconds looks like a scraper, not a human. |
| Missing human interaction delays | Humans take 2–5 seconds between clicks; bots take milliseconds. |
| IP reputation | Repeated automated requests from one IP degrade its reputation. |

### The fix — three layers of defense

**Layer 1: Chrome launch flags** (`scripts/vnc-driver.js`):

```js
args: [
  '--disable-blink-features=AutomationControlled',  // removes navigator.webdriver
  '--disable-infobars',                              // removes "controlled by automation" banner
  '--no-default-browser-check',                      // avoids first-run prompts
]
```

The critical flag is **`--disable-blink-features=AutomationControlled`**.
Without it, Chrome sets `navigator.webdriver = true` when launched via CDP.

**Layer 2: `addInitScript` stealth injection** (runs before any page script):

```js
// In scripts/vnc-driver.js:
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(Navigator.prototype, 'plugins', { get: () => [1,2,3,4,5] });
  Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US','en'] });
});
```

**Layer 3: Human-like pacing in automation scripts**:

```js
const humanDelay = () => sleep(2000 + Math.random() * 3000);   // 2-5 seconds
const jobDelay   = () => sleep(10000 + Math.random() * 10000); // 10-20 seconds

// After every page.goto() and before every form submission:
await humanDelay();
// Between distinct operations (e.g. posting different jobs):
await jobDelay();
```

### CAPTCHA detection & pause-for-manual-solve

Even with all the above, Cloudflare may still throw a CAPTCHA. The
recommended pattern is to **detect** it and **pause** for manual
resolution via VNC:

```js
async function waitForCaptcha(page, timeoutSec = 120) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText || '');
    if (title.includes('moment') || title.includes('Verification') ||
        text.includes('Verify you are human')) {
      console.log('CAPTCHA detected! Solve via VNC viewer.');
      await sleep(5000);
      continue;
    }
    return true;
  }
  return false;
}
```

Call this after every `page.goto()`. While waiting, open the VNC viewer
and click the Cloudflare checkbox by hand. The script detects the page
change and resumes automatically.

### When Cloudflare blocks you anyway

1. **Wait 10–15 minutes** — the block is partially time-based.
2. **Clear cookies**: `rm -rf ./profile/Default/Cookies*` then restart VNC.
3. **Fresh profile**: `PROFILE=/tmp/fresh-profile npm run vnc`
4. **Residential proxy** — if the IP is flagged, no browser-level stealth helps.
5. **Reduce frequency** — post 5 jobs, wait 30 minutes, post 5 more.

---

## Tuning the stealth layer

The patches live in `stealth.js`. Each one is in a small section
labeled `// ---- N. <signal> ----`. To disable a patch (for testing),
wrap it in `if (false) { ... }` and re-run. To add a new patch, add
it to the same file and it will be picked up automatically (no
re-import needed — it's loaded once on launch).

If you upgrade Chrome, update the `CHROME_VERSION` constant at the
top of `headless.js` so the synthetic User-Agent matches the real
one. Otherwise some sites will see a Chrome-140 UA on a Chrome-150
binary and flag the mismatch.
