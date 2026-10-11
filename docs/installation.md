# Installation

## Prerequisites

You need three things on the machine where you'll run `ServerBrowser/`:

| Requirement | Minimum version | How to check |
| ----------- | --------------- | ------------ |
| Node.js     | 18.x            | `node --version` |
| Google Chrome | 120+          | `google-chrome --version` (or `google-chrome-stable --version`) |
| Playwright  | 1.40+           | `playwright --version` |

This project uses Playwright but does **not** depend on the Playwright
browser bundles (Chromium / Firefox / WebKit). It always launches the
**system Google Chrome**, so you do not need to run
`playwright install`.

## 1. Install Node.js

If `node --version` is older than 18, install a current LTS:

```bash
# Debian / Ubuntu
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or via nvm (any Linux/macOS)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install --lts
```

## 2. Install Google Chrome

The project assumes `/usr/bin/google-chrome` exists. Install:

```bash
# Debian / Ubuntu
wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
  | sudo apt-key add - \
  && echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" \
  | sudo tee /etc/apt/sources.list.d/google-chrome.list \
  && sudo apt-get update \
  && sudo apt-get install -y google-chrome-stable

# macOS
brew install --cask google-chrome

# Or download the .deb / .dmg directly from
# https://www.google.com/chrome/
```

If Chrome lives somewhere other than `/usr/bin/google-chrome`, pass
`--executablePath=...` to `launch()` (library) or set
`executablePath` in the launch options.

## 3. Install Playwright

The `ServerBrowser/` folder already has a `node_modules/` with `playwright`
and `chalk` (it shares the parent `htdocs` folder's `node_modules`).
If you need to install fresh:

```bash
# In the parent folder (htdocs):
cd /opt/lampp/htdocs
npm install playwright chalk

# Or globally if you don't want a per-project install:
npm install -g playwright
```

The global install is sufficient because `require('playwright')` will
find the global module if no local one is present.

## 4. Install Firefox and Chromium (optional)

The default browser is the **system Google Chrome** (launched via
`--browser=chrome`). To use Playwright-managed Firefox or Chromium
instead — for example if you don't have system Chrome installed, or
need an isolated profile without a persistent user-data-dir — install
them with:

```bash
# Install the Firefox bundle
npx playwright install firefox

# Install the Chromium bundle
npx playwright install chromium
```

Both commands download the browser binaries into `~/.cache/ms-playwright/`
(overridable with `PLAYWRIGHT_BROWSERS_PATH`).

### When to use each

| Browser | Use case |
| ------- | -------- |
| `chrome` (default) | System Google Chrome; best anti-detection (stealth layer tuned for Chrome). |
| `firefox` | Isolated profile; different fingerprint; useful for cross-browser tests. |
| `chromium` | Playwright-managed Chromium; smallest install; good for CI. |

Select at launch time with:

```bash
# Firefox
npm run vnc -- --browser=firefox

# Chromium
npm run vnc -- --browser=chromium
```

Or via env:

```bash
BROWSER=firefox npm run vnc
```

## 5. Browser constraints

### Firefox CDP limitations in Playwright

Playwright's Firefox channel **does not support Chrome DevTools Protocol (CDP)**
as a first-class target. The `--browser=firefox` path in `vnc-driver.js` launches
Firefox and attaches via Playwright's own protocol (not CDP). This means:

- **`connectOverCDP` is unavailable** for Firefox. Automation that depends on raw
  CDP (stealth plugins, session manipulation) works only with `chrome` / `chromium`.
- Firefox's anti-detection fingerprint differs from Chrome. The stealth layer is
  tuned for Blink/Chrome; running with Firefox may surface `navigator.webdriver`
  differently or lack Chrome-specific `window.chrome` properties.
- Session/cookie APIs behave differently in Gecko. Stored scripts that call
  `chromium.launch()` and rely on Chrome-specific `context` or `page` behaviours
  should be tested against the intended target before production use.

### `chrome` vs `chromium` vs `firefox`

| Dimension | `chrome` | `chromium` | `firefox` |
| --------- | -------- | ---------- | --------- |
| CDP support | Full (primary target) | Full | None (Playwright protocol only) |
| Stealth layer | Full (blink-specific) | Full (blink-specific) | Partial (gecko-specific stubs) |
| `window.chrome` | Present | Present | Absent |
| `navigator.webdriver` | Suppressed | Suppressed | May differ by version |
| Profile persistence | user-data-dir | temp dir | temp dir |
| Anti-bot fingerprint | Chrome 120+ | Current snapshot | Firefox ESR |
| Install | System Chrome only | `npx playwright install chromium` | `npx playwright install firefox` |

**Recommendation:** use `chrome` (system Google Chrome) for production automation.
Use `chromium` for CI where anti-bot fingerprint is less critical.
Use `firefox` only for cross-browser validation or when Chrome is unavailable.

## 6. Optional: tunnel provider binaries

The tunnel commands run a local password gate (pure Node, always available). To
publish a public URL you also need one of these:

```bash
# Cloudflare quick tunnels
curl -fsSL https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ | sh

# or ngrok
curl -fsSL https://ngrok.com/install | sh   # needs an account/token
```

Neither is required for `tunnel-*` with the `custom` provider, which is handy
for testing and for pointing your own reverse proxy at the gate.

---

## 7. Optional: Xvfb / x11vnc / noVNC (the VNC stack)

To watch the browser over VNC you need the display and web-view pieces:

```bash
# Debian / Ubuntu
sudo apt-get install -y xvfb x11vnc novnc websockify

# Fedora
sudo dnf install -y xorg-x11-server-Xvfb x11vnc novnc python3-websockify
```

Verify the whole stack, including the resolution wiring:

```bash
npm run vnc -- --resolution 1280x720        # prints viewer/CDP URLs, stays up
bash scripts/smoke-test-vnc-resolution.sh 1440 900   # headless check, exits 0
```

## 8. Verify the install

```bash
cd /opt/lampp/htdocs/ServerBrowser
node -e "const m = require('./headless'); console.log('OK:', Object.keys(m).join(', '));"
```

You should see the exported API keys:

Expected output (something like):

```
OK: launch, makeHumanizer, search, formatResults, ENGINES, ENGINE_ALIASES, DEFAULT_ENGINE, FALLBACK_CHAIN, REAL_UA, DEFAULT_PROFILE
```

If you see `Cannot find module 'playwright'`, see
[troubleshooting.md](troubleshooting.md).

## 9. Smoke test

```bash
# This will open a URL, print its title, and exit.
node headless.js https://example.com
```

Expected output:

```
Opened: https://example.com/
Title:  Example Domain
Profile dir: /opt/lampp/htdocs/ServerBrowser/profile
```

If you get a "Failed to launch Google Chrome" error, double-check
that `/usr/bin/google-chrome` exists and is executable:

```bash
ls -la /usr/bin/google-chrome
google-chrome --version
```
