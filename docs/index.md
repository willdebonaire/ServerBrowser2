# ServerBrowser — Stealth Headless Google Chrome (via Playwright)

A persistent, real-Chrome, hard-to-detect browsing and web-search toolkit
for Node.js, built on top of [Playwright](https://playwright.dev/).

- Uses **real Google Chrome 140** (`/usr/bin/google-chrome`), not bundled
  Chromium, so it doesn't carry the "this is a headless Chromium"
  fingerprint that anti-bot services look for.
- **Persistent profile** (`./profile/`) — cookies, localStorage, sessions,
  service workers, IndexedDB all survive between runs.
- **Stealth init script** patches the most common bot-detection signals
  (`navigator.webdriver`, missing `window.chrome`, SwiftShader WebGL,
  etc.) before any page script runs.
- **Screenshot capture** — automatic on launch, or ad-hoc at any time.
- **Web search** via bot-friendly engines with a built-in **fallback
  chain** (DuckDuckGo HTML → Brave → SearXNG).

> **Use responsibly.** This toolkit is designed to remove the *technical*
> tells of automation (so you stop being flagged just for being a
> headless browser). It does not bypass CAPTCHAs or login walls, and
> does not help you violate any site's ToS.

---

## Quick start

```bash
# 1. Open a URL, print the page title
node headless.js https://example.com

# 2. Open a URL and save a screenshot
node headless.js --shot https://example.com

# 3. Search the web
node headless.js --search "playwright tutorial"

# 4. Run a fingerprint check to see how undetectable you are
node headless.js --check https://bot.sannysoft.com
```

Programmatic use:

```js
const { launch, search, screenshot } = require('./headless');

(async () => {
  const { page, human, screenshot, close } = await launch({
    url:        'https://example.com',
    screenshot: true,                  // auto-screenshot on load
    screenshotPath: 'home.png',
  });

  // Type into a search box like a human
  await human.type('input[name=q]', 'playwright');
  await human.click('button[type=submit]');
  await page.waitForLoadState('networkidle');

  // Take another screenshot after the search
  await screenshot('results.png');

  // Or use the high-level search helper
  const r = await search('node.js streams', { limit: 5 });
  console.log(r.results);

  await close();
})();
```

---

## Documentation map

| Page | What it covers |
| --- | --- |
| [installation.md](installation.md) | Prerequisites, install, verify the install works. |
| [quickstart.md](quickstart.md) | 5-minute tour of the most useful CLI invocations. |
| [cli.md](cli.md) | Full reference for every CLI flag, with examples. |
| [COMMANDS.md](COMMANDS.md) | Every command across all four command tables, plus the `PROPOSED` commands the run scripts still need. |
| [LIVE-DRIVE.md](LIVE-DRIVE.md) | The live VNC session: `npm run vnc`, watching and driving real Chrome over CDP. |
| [api.md](api.md) | Library API: `launch()`, `search()`, `screenshot()`, `human`, `close`. |
| [stealth.md](stealth.md) | What the stealth layer does, what it doesn't, Cloudflare Turnstile handling, and how to test it. |
| [screenshots.md](screenshots.md) | All the ways to take a screenshot. |
| [search.md](search.md) | Search engines, fallback chain, output, options. |
| [persistence.md](persistence.md) | How the persistent profile works, when to reset it. |
| [architecture.md](architecture.md) | How the four source files fit together. |
| [troubleshooting.md](troubleshooting.md) | Common problems and their fixes. |

---

## File map (this folder)

```
ServerBrowser/
├── headless.js          # Main entry point. CLI + library API.   (~640 lines)
├── search.js            # Web search via 3 engines + fallback.   (~330 lines)
├── stealth.js           # Init script that hides bot tells.      (~230 lines)
├── example.js           # Drop-in usage example.                 (~30 lines)
├── README.md            # Short overview (this kind of doc).     (~280 lines)
├── docs/                # You are here.
│   ├── index.md         # ← this file
│   ├── installation.md
│   ├── quickstart.md
│   ├── cli.md
│   ├── COMMANDS.md
│   ├── LIVE-DRIVE.md
│   ├── api.md
│   ├── stealth.md
│   ├── screenshots.md
│   ├── search.md
│   ├── persistence.md
│   ├── architecture.md
│   └── troubleshooting.md
├── profile/             # Persistent Chrome user-data dir (auto-created).
└── screenshots/         # Default output dir for ad-hoc screenshots.
```

---

## Requirements

- **Node.js 18+** (the project uses native `URL`, `fs.promises`, etc.)
- **Google Chrome 120+** installed at `/usr/bin/google-chrome`
  (or anywhere on `$PATH`).
- **Playwright** 1.40+ installed globally
  (`npm install -g playwright` is enough — the project uses the global
  module by virtue of running from a folder that has `playwright` in
  its `node_modules`).

See [installation.md](installation.md) for the exact commands.
