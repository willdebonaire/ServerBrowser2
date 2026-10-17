# ServerBrowser - Stealth Headless Google Chrome (via Playwright)

Persistent, real-Chrome, interactive browsing + web search toolkit
for Node.js.

> **Full documentation:** see [`docs/`](docs/index.md).

## What's here

| File                          | Purpose                                                |
| ----------------------------- | ------------------------------------------------------ |
| `headless.js`                 | Main entry point. CLI + library API.                   |
| `search.js`                   | Web search via 3 engines + fallback chain.             |
| `stealth.js`                  | Init script that patches bot-detection signals.        |
| `example.js`                  | Drop-in usage example.                                 |
| `profile/`                    | Persistent Chrome user-data (cookies, sessions, etc.). |
| `docs/`                       | Full documentation.                                    |
| `datastore/`                  | DuckDB datastore for agent storage.                    |

## TL;DR

```bash
# Open a URL
node headless.js https://example.com

# Open + screenshot
node headless.js --shot https://example.com

# Search the web
node headless.js --search "playwright tutorial"

# Check how undetectable you are
node headless.js --check https://bot.sannysoft.com
```

```js
const { launch, search } = require('./headless');

const { page, human, screenshot, close } = await launch({
  url: 'https://example.com/login',
  screenshot: true,                  // auto-screenshot on load
});

await human.type('input[name=email]',    'me@example.com');
await human.think();
await human.type('input[name=password]', 'hunter2');
await human.pause();
await human.click('button[type=submit]');
await page.waitForLoadState('networkidle');
await screenshot('logged-in.png', { fullPage: true });

const r = await search('node streams', { limit: 3 });

await close();
```

## Features

- **Real Google Chrome 140**, not bundled Chromium (`channel: 'chrome'`
  + `executablePath: /usr/bin/google-chrome`).
- **Persistent profile** — cookies, localStorage, sessions, IndexedDB,
  all survive between runs.
- **Stealth init script** patches `navigator.webdriver`, missing
  `window.chrome`, SwiftShader WebGL, etc. — all the standard
  headless tells.
- **Screenshots** — auto on load, or ad-hoc at any time. PNG or JPEG,
  full page or viewport, element or region.
- **Web search** via DuckDuckGo HTML (primary), Brave, SearXNG
  (fallbacks) with a transparent fallback chain.
- **Humanization helpers** — `human.type/click/hover/wait/think/pause`
  with realistic variable delays and mouse-move steps.
- **dataforthai.com scraper** (`scrapers/dataforthai.js`) — scrapes
  the Thai business directory, one company per CSV line. Run with
  `node scrapers/dataforthai.js --code=01111`. See
  [SCRAPER-README.md](SCRAPER-README.md).

## Why this looks less like a bot than raw Playwright

| Signal                                  | Handled by                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `navigator.webdriver === true`          | Hidden via `Object.defineProperty` on the prototype.       |
| `cdc_*` / `__webdriver_*` globals       | Deleted.                                                  |
| Missing `window.chrome`                 | Stubbed with `csi`, `loadTimes`, `runtime`, `app`.        |
| 0 `navigator.plugins` / `mimeTypes`     | Stubbed with 6 realistic plugins + 4 mime types.          |
| `WebGL vendor: "SwiftShader"`           | Patched to `Intel Inc.` / `Intel Iris OpenGL Engine`.     |
| `Permissions.query` inconsistency       | Forwarded to `Notification.permission`.                   |
| `UA` contains "Headless"                | Rewritten at launch + belt-and-suspenders override.       |
| Real Chrome "controlled by automated"   | `ignoreDefaultArgs: ['--enable-automation']` etc.         |
| Old `chromium` headless mode            | Uses the new headless (Playwright >= 1.40 default).       |
| Bundled Chromium not Chrome             | `channel: 'chrome'` + `executablePath: /usr/bin/google-chrome`. |

## Documentation

Start here: **[docs/index.md](docs/index.md)**

- [docs/installation.md](docs/installation.md) — prerequisites, install, verify.
- [docs/quickstart.md](docs/quickstart.md) — 5-minute tour of the CLI.
- [docs/LIVE-DRIVE.md](docs/LIVE-DRIVE.md) — **the live/VNC stack**: watch it over
  noVNC, drive it command by command, HUD + pause/resume, multitab, DuckDB
  datastore, password-gated tunnels, the standalone CLI.
- [docs/cli.md](docs/cli.md) — full CLI reference (every flag, every example).
- [docs/api.md](docs/api.md) — library API: `launch()`, `search()`, `screenshot()`, `human`.
- [docs/stealth.md](docs/stealth.md) — what the stealth layer does, and what it doesn't.
- [docs/screenshots.md](docs/screenshots.md) — all the screenshot modes.
- [docs/search.md](docs/search.md) — search engines, fallback chain, options.
- [docs/persistence.md](docs/persistence.md) — how the profile works, when to reset.
- [docs/architecture.md](docs/architecture.md) — how the four source files fit together.
- [docs/troubleshooting.md](docs/troubleshooting.md) — common problems and their fixes.

## Live mode at a glance

`headless.js` is the one-shot tool above. For a browser you can **watch and
steer** (VNC + noVNC + CDP), use the live stack:

```bash
npm run vnc -- --resolution 1920x1080   # Xvfb + headed Chrome + x11vnc + noVNC
npm run live -- dump                    # one command, JSON answer
npm run live -- --stdin                 # JSON-lines loop for agents
npm run live -- extract-links checkout  # scraping
npm run live -- pause                   # stop and hand over to a human
npm run live -- db-select leads         # DuckDB, works with no browser running
npm run standalone -- ai chat echo "hi" # scriptable CLI (browser/tunnel/ai/api-keys)
```

Everything is documented in [docs/LIVE-DRIVE.md](docs/LIVE-DRIVE.md).


## Notes / limitations

- **No real Chrome GUI is opened unless you pass `--headed`.** This is
  intentional: headless mode is faster and runs on servers without a
  display. If a site still flags you, try `--headed` once to solve a
  CAPTCHA and let the cookies persist.
- **The stealth layer is best-effort.** No open-source patch is
  undetectable against the most aggressive (CreepJS-grade) fingerprint
  suites. It comfortably clears the common ones (Sannysoft, Intoli,
  most Cloudflare/DataDome public pages).
- **Don't use this to violate any site's ToS.** It just removes the
  obvious "this is a bot" tells.
