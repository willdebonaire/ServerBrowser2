# Live Chrome — Drive, Watch &amp; Automate in Real Time

This guide explains how to run a **headed, real Google Chrome** (not the bundled
Chromium) that you can **watch over VNC**, **drive live with Playwright**, and
**re-run existing stored scripts against — over and over — without the browser
ever closing on its own**.

Everything is driven by one npm command and documented here. A copy is also shown
**on screen** while the session runs (the instructions page loaded in Chrome and
served at the VNC web port).

---

## 1. The one command

```bash
npm run vnc
```

That single command brings up everything and keeps running (blocking):

| Piece | What it is | Default address |
| ----- | ---------- | --------------- |
| `Xvfb` | virtual display the browser renders onto | `:10` |
| **real Google Chrome** | headed, persistent profile, DevTools open | launched by Playwright |
| `x11vnc` + **noVNC** | the web view of the screen | `http://localhost:6080/novnc/vnc_auto.html` |
| Instructions page | how to control it, so it's on screen | `http://localhost:6080/` |
| **CDP** endpoint | where Playwright attaches to drive it live | `http://127.0.0.1:9222/json/version` |

While it's running it prints the viewer URL, the instructions URL and the CDP
endpoint. Press **Ctrl-C** to stop the session. Stopping the session closes this
Chrome (there is no other way it closes — scripts and live commands are
suppressed from closing it).

### Configuration
Every setting is overridable with environment variables:

```bash
WEB_PORT=6080 RFB_PORT=5900 CDP_PORT=9222 DISPLAY_NUM=10 SCREEN=1280x800x24 \
PROFILE=./profile START_URL=http://localhost:6080/ RESOLUTION=1920x1080 npm run vnc
```

Or use the shortcut flag directly:

```bash
npm run vnc -- --resolution 1920x1080
```

---

## 1a. VNC resolution

The VNC display size defaults to `1280x800`. Override it with the
`--resolution` flag or the `SCREEN` / `RESOLUTION` environment variables.

### Flag

```bash
npm run vnc -- --resolution 1920x1080
```

Both `--resolution=WxH` and `--resolution WxH` forms are accepted.

### Environment variables

| Variable | Effect | Default |
| -------- | ------ | ------- |
| `SCREEN` | Full Xvfb screen spec `WIDTHxHEIGHTxDEPTH` | `1280x800x24` |
| `RESOLUTION` | Shorthand `WIDTHxHEIGHT`; maps to `SCREEN=WxHx24` | (empty → `SCREEN` used) |

The flag wins if both are provided: `--resolution` sets `SCREEN` internally.

### Examples

```bash
# 1080p
SCREEN=1920x1080x24 npm run vnc

# 1440p (same as --resolution)
RESOLUTION=2560x1440 npm run vnc

# Full HD via flag
npm run vnc -- --resolution 2560x1440
```

The viewport and window size inside Chrome are aligned to the same resolution.
`scripts/vnc-server.sh` derives the Chrome window size from the Xvfb screen and
forwards it to the driver, so a single flag keeps the virtual screen, the Chrome
window and the page viewport in agreement:

```bash
# Verify end to end (Xvfb + Chrome + CDP, exits 0 on success)
bash scripts/smoke-test-vnc-resolution.sh 1440 900
```

### Browser selection and other `npm run vnc` flags

| Flag | Effect |
| ---- | ------ |
| `--resolution WxH` | Xvfb screen + Chrome window/viewport |
| `--browser chrome\|chromium\|firefox` | Which browser the driver launches (default `chrome`) |
| `--local-chrome [--local-chrome-port N]` | Attach to an already-running Chrome instead of launching one (§9) |
| `--cdp-port N`, `--profile PATH`, `--start-url URL` | Passed straight through to the driver |

Run `npm run vnc -- --help` for the full list. All of them also work as
environment variables (`BROWSER`, `LOCAL_CHROME`, `LOCAL_CHROME_PORT`, …).

---

## 2. Two ways to drive it live

The browser exposes Chrome DevTools Protocol on **port 9222**. Playwright 1.61.1
is already installed globally on this machine, so any Node process can attach.

### 2a. Raw Playwright (best for your AI model / custom scripts)

```js
const { chromium } = require('playwright');

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = browser.contexts()[0].pages()[0];   // the visible tab

await page.goto('https://example.com');

// Read data
const text  = await page.evaluate(() => document.body.innerText);
const html  = await page.content();
const title = await page.title();

// Act (all visible live in the VNC view)
await page.click('a[href="/login"]');
await page.fill('input[name="email"]', 'me@x.com');
await page.fill('input[name="password"]', 'hunter2');
await page.click('button[type="submit"]');
await page.waitForSelector('.dashboard');
console.log(await page.evaluate(() => document.body.innerText));

await page.screenshot({ path: '/tmp/dash.png', fullPage: true });
// NOTE: never call browser.close() unless you want to end the session.
```

Because `connectOverCDP` attaches to the *already-running* Chrome, your logins,
cookies and the visible window all persist. An AI model can read the page

### 2b. One-liner CLI: `npm run live`

For quick commands from a shell or an AI, there is a CLI that attaches, acts
and prints results as JSON.

```bash
npm run live -- goto https://example.com
npm run live -- dump                     # structured inputs/buttons/text
npm run live -- text                     # visible text
npm run live -- click 'a[href="/login"]'
npm run live -- fill 'input[name=email]' you@x.com
npm run live -- screenshot /tmp/shot.png
npm run live -- eval "document.querySelectorAll('a').length"
```

#### Command reference
| Command | Args | Does |
| ------- | ---- | ---- |
| `goto` | `<url>` | navigate active tab |
| `reload` / `back` / `forward` | — | navigate |
| `wait` | `<ms>` | sleep |
| `waitfor` | `<css>` `[ms]` | wait for an element |
| `fill` | `<css>` `<text>` | set an input value |
| `type` | `<css>` `<text>` `[delayMs]` | type into an element |
| `click` | `<css>` | click an element |
| `press` | `<css>` `<key>` | press a key in an element (`Enter`, `Tab`, …) |
| `keyboard` | `<key>` | global key press on the page |
| `clear` | `<css>` | empty an input |
| `url` | — | print current URL |
| `title` | — | print page title |
| `text` | — | **read**: page visible text |
| `html` | — | **read**: full page HTML |
| `dump` | — | **read**: inputs, buttons, links, text in one shot |
| `eval` | `<js>` | **read/run**: execute JS in the page, return result |
| `screenshot` | `<file.png>` | save a screenshot |
| `tabs` | — | list all open tabs |
| `tab` | `<index>` | switch the "active" tab |
| `close-tab` | `[index or css]` | close a tab (refuses to close the last one) |
| `db-connect` | `[path]` | connect to DuckDB datastore |
| `db-query` | `<sql>` | run SELECT and return rows |
| `db-exec` | `<sql>` | run INSERT/UPDATE/CREATE etc. |
| `db-tables` | — | list tables |
| `db-select` | `<table> [whereJson]` | query table with optional where |
| `db-insert` | `<table> <json>` | insert row into table |
| `db-create-table` | `<table> <cols>` | create table if not exists |
| `db-status` | — | show datastore status |
| `db-close` | — | close datastore connection |
| `status-set` | `<text>` | set current action text on VNC overlay |
| `progress` | `<0-100>` | set progress bar on VNC overlay |
| `notify` | `<text>` | show notification popup on VNC overlay |
| `pause` | — | pause agent execution (VNC overlay button) |
| `resume` | — | resume agent execution |

#### 2d. Multitab JSON-lines protocol

`npm run live -- --stdin` accepts one JSON object per line (or a space-separated
command) and processes them sequentially, emitting one JSON result per line.

```bash
printf '%s\n' \
  '{"cmd":"goto","args":["https://example.com/login"]}' \
  '{"cmd":"dump"}' \
  '{"cmd":"fill","args":["input[name=email]","me@x.com"]}' \
  '{"cmd":"click","args":["button[type=submit]"]}' |
npm run live -- --stdin
```

### Agent tab commands

| Command | Args | Does |
| ------- | ---- | ---- |
| `agent-tab-create` | `<name> [contextId]` | Create a new agent tab (max 10 concurrent). Returns `{id, url, title, contextId}`. |
| `agent-tab-switch` | `<id>` | Make the named agent tab active. |
| `agent-tab-close` | `<id>` | Close the named agent tab. |
| `agent-tabs` | — | List every open tab with the agent id it is bound to. |

### Context commands

| Command | Args | Does |
| ------- | ---- | ---- |
| `context-new` | — | Create a new isolated browser context. Returns `{contextId}`. |
| `context-use` | `<id>` | Switch to an existing context by ID. |
| `contexts` | — | List all registered context IDs. |

### Max tabs guard

No more than **10 concurrent agent tabs** can exist at any time. Attempting to
create an 11th tab returns an error:

```json
{"cmd":"agent-tab-create","ok":false,"error":"max concurrent tabs reached (10)"}
```

### `--agent-id <id>` scoping

`--agent-id` scopes a command (or a whole `--stdin` session) to one agent's tab.
The flag may appear before or after the command name:

```bash
npm run live -- --agent-id scraper-1 goto https://example.com
npm run live -- goto https://example.com --agent-id scraper-1
```

Because each CLI invocation is a **separate process**, the in-memory tab registry
is empty every time. Tabs are therefore stamped with a marker
(`window.__sb_agent_id`, mirrored into the tab's `localStorage`), and a later
process rediscovers the tab by that marker before creating a duplicate. Inspect
the wiring with `agent-tabs`.

Contexts (`context-new` / `context-use`) are per-process by nature — create and
use them inside a single `--stdin` session.

### Examples

```bash
# Create and switch between two agent tabs
printf '%s\n' \
  '{"cmd":"agent-tab-create","args":["tab-a"]}' \
  '{"cmd":"goto","args":["https://a.example.com"]}' \
  '{"cmd":"agent-tab-create","args":["tab-b"]}' \
  '{"cmd":"agent-tab-switch","args":["agent-1"]}' \
  '{"cmd":"title"}' |
npm run live -- --stdin

# New context for isolated cookies
printf '%s\n' \
  '{"cmd":"context-new"}' \
  '{"cmd":"goto","args":["https://example.com"]}' \
  '{"cmd":"context-use","args":["ctx-1"]}' |
npm run live -- --stdin
```

> **JSON-lines mode** is ideal for an AI to issue many steps and read every answer:
> ```bash
> printf '%s\n' \
>   '{"cmd":"goto","args":["https://example.com/login"]}' \
>   '{"cmd":"dump"}' \
>   '{"cmd":"fill","args":["input[name=email]","me@x.com"]}' \
>   '{"cmd":"click","args":["button[type=submit]"]}' |
> npm run live -- --stdin
> ```

#### 2c. Datastore commands

`npm run live` exposes a DuckDB-backed datastore directly from the CLI.
No separate server is needed — the database is a local `.duckdb` file.

**No browser required.** `db-*` and `tunnel-*` commands are local, so they run
even when no live Chrome session is up (the CDP connection is skipped entirely):

```bash
npm run live -- db-status        # works with nothing else running
```

### Environment variable

| Variable | Effect | Default |
| -------- | ------ | ------- |
| `DATASTORE_PATH` | Path to the DuckDB file | `datastore/browser.duckdb` |

### Command reference

| Command | Args | Does |
| ------- | ---- | ---- |
| `db-connect` | `[path]` | Open (or create) the DuckDB file. Uses `DATASTORE_PATH` if `path` omitted. |
| `db-status` | `[path]` | Show the database path and table list. |
| `db-close` | — | Close the connection. |
| `db-tables` | — | List all tables in the database. |
| `db-query` | `<sql>` | Run a SELECT and return matching rows. |
| `db-exec` | `<sql>` | Run any non-SELECT SQL (INSERT, UPDATE, CREATE TABLE, etc.). |
| `db-create-table` | `<table> <cols>` | Create a table if it does not exist. Columns may be typed (`id INTEGER, name TEXT`) or bare (`id, name`), in which case `TEXT` is assumed. |
| `db-select` | `<table> [whereJson]` | Query a table; `whereJson` is `{"col":"val"}`. |
| `db-insert` | `<table> <json>` | Insert a row; `json` is `{"col":"val",...}`. |
| `db-update` | `<table> <setJson> <whereJson>` | Update rows matching `whereJson`. Refuses an empty where clause. |
| `db-delete` | `<table> <whereJson>` | Delete rows matching `whereJson`. Refuses an empty where clause. |

Every command answers with a single JSON line: `{"cmd":…,"ok":true,"result":…}`
or `{"cmd":…,"ok":false,"error":"…"}` — SQL errors are returned, never thrown.

### Examples

```bash
# Open (creates file if absent)
npm run live -- db-connect

# Create a table
npm run live -- db-create-table products "id INTEGER, name TEXT, price REAL"

# Insert a row
npm run live -- db-insert products '{"id":1,"name":"Widget","price":9.99}'

# Select all rows
npm run live -- db-select products

# Select with a where clause
npm run live -- db-select products '{"id":1}'

# Update
npm run live -- db-update products '{"price":8.99}' '{"id":1}'

# Raw SQL
npm run live -- db-query "SELECT * FROM products WHERE price > 5"

# List tables
npm run live -- db-tables

# Close when done
npm run live -- db-close
```

---

## 3. Run your EXISTING stored scripts — over and over, never closing

Your stored scripts (e.g. `batch.js`, `dataforthai.js`, `harvest_ai_platforms.js`)
normally call `chromium.launch()` themselves, spinning up throwaway browsers and
closing them. To run them **on the live, visible instance** instead — repeatedly,
keeping logins intact — use:

```bash
npm run live-run -- batch.js codes.csv
npm run live-run -- dataforthai.js some-arg
npm run live-run -- <any-stored-script.js> [script args...]
```

What `live-run` does:
1. It **intercepts** the stored script's `chromium.launch()` / `launchPersistentContext()`
   and redirects the call to attach to the running browser via `connectOverCDP`.
2. It **suppresses** every `browser.close()` / `context.close()` (with a log line),
   so the same instance — and its cookies, logins and visible window — survives
   every run.
3. It passes through the script's own argv unchanged, so the script sees exactly
   the arguments it expects (`node dataforthai.js some-arg`).
4. Run it as many times as you like; each run acts on the same live Chrome while
   you watch on VNC, and nothing is torn down.

> **Logins during a run:** because the browser is headed and on VNC, you (or the
> AI) can complete a CAPTCHA/login by hand in the VNC viewer mid-run — the script
> keeps using the same profile, so the login sticks.

---

## 4. Scraping commands

`npm run live` exposes page-level scraping commands that run entirely in the
browser via `page.evaluate(...)`.

| Command | Args | Does |
| ------- | ---- | ---- |
| `save-page-json` | `[path]` | Save structured page data (url, title, html, text, links, images, inputs) to a JSON file. Returns data even without a path. |
| `extract-css` | `<selector>` | Return matching elements: `{tag, text, html, href, src}` for each. |
| `extract-regex` | `<pattern> [flags]` | Run a regex against `document.body.innerText`. Returns `{pattern, flags, matches}`. |
| `extract-table` | `<selector>` | Parse `<table>` elements into `{headers, rows}` arrays. Defaults to `table`. |
| `extract-links` | `[filter]` | Return all links, optionally filtered by substring match on `href` or `text`. |
| `extract-images` | — | Return all `<img>` elements with `{src, alt, width, height}`. |
| `screenshot-element` | `<selector> <path>` | Screenshot a single element to a PNG file. |
| `pdf` | `<path>` | Print the current page to a PDF file. |

### Examples

```bash
# Structured page dump, saved to file
npm run live -- save-page-json /tmp/page.json

# All links matching a filter
npm run live -- extract-links example.com

# Table as JSON arrays
npm run live -- extract-table '.results-table'

# Images with dimensions
npm run live -- extract-images

# Regex: all email addresses on the page
npm run live -- extract-regex '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}' 'g'

# Element screenshot
npm run live -- screenshot-element '.hero' /tmp/hero.png

# PDF
npm run live -- pdf /tmp/page.pdf
```

## 5. Reading data

- **`npm run live -- dump`** returns a JSON object with `url`, `title`, `inputs`,
  `buttons`, `links` and the first ~4000 chars of visible `text` — the fastest way
  for an AI to understand a page.
- **`npm run live -- text`** returns the raw visible text.
- **`npm run live -- html`** returns full page HTML.
- **`npm run live -- eval '<expression>'`** runs arbitrary JS in the page and
  returns the value — e.g. collect a table, an array of product links, JSON from a
  global variable, etc.
- Each `live` result is printed as one JSON line, easy for an AI to parse.

## 6. Pause / resume

The VNC overlay shows **Pause** and **Resume** buttons. An automation agent
(or a live command) can trigger the same behaviour programmatically.

### Commands

| Command | Does |
| ------- | ---- |
| `pause` | Raise the paused flag (the HUD button flips to **Resume**) and block until `resume` is issued or the timeout fires. |
| `resume` | Release a paused agent. |
| `overlay-state` | Report whether the HUD is installed plus its live state (text, progress, paused). |

The flag lives in the page's `localStorage`, so it survives navigation and is
visible to every tab. A human releases the agent by clicking **Resume** on the
VNC screen; another process can release it with `npm run live -- resume`.

### Environment variable

| Variable | Effect | Default |
| -------- | ------ | ------- |
| `PAUSE_TIMEOUT_MS` | Maximum time to wait before auto-resuming (0 = disabled) | `30000` |

### Examples

```bash
# Pause (blocks until resume or timeout)
npm run live -- pause

# Resume from another shell or agent
npm run live -- resume

# Disable auto-resume entirely
PAUSE_TIMEOUT_MS=0 npm run live -- pause

# Agent-initiated pause that self-releases after 3s
PAUSE_TIMEOUT_MS=3000 npm run live -- pause
# → {"cmd":"pause","ok":true,"result":{"paused":true,"autoResumed":true,"waitedMs":3072,"timeoutMs":3000}}

# What does the HUD think?
npm run live -- overlay-state
```

> The HUD auto-hides after `OVERLAY_AUTO_HIDE_SECONDS` of inactivity (default 10,
> `0` disables). Set it when launching: `OVERLAY_AUTO_HIDE_SECONDS=0 npm run vnc`.

---

## 7. Watching / interacting on VNC

- Open **`http://localhost:6080/novnc/vnc_auto.html`** to see the live screen.
- Use the **`http://localhost:6080/`** instructions page as a landing/reference.
- Click and type directly in the VNC viewer to operate the browser by hand
  (logins, CAPTCHAs, approvals) while automation continues.

---

## 8. Security notes &amp; tips

- Everything binds to **localhost** by default — safe over an SSH tunnel
  (e.g. `ssh -L 6080:localhost:6080 -L 9222:localhost:9222 user@host`).
- The VNC/websockify path has **no password** (`-nopw`). Only expose it publicly
  if you add TLS/`-password` and bind beyond loopback deliberately.
- Chrome runs with `--no-sandbox` because the process is `root` (VPS context).
- The persistent profile is **`profile/`** — this is where cookies/logins live
  between sessions.
- **Anti-bot detection:** The VNC Chrome includes `--disable-blink-features=AutomationControlled`
  and an `addInitScript` stealth layer to suppress `navigator.webdriver` and other
  automation tells. When automating, add 2–5s delays between actions. If Cloudflare
  throws a CAPTCHA, pause and solve it manually via VNC — see
  [stealth.md](stealth.md) § "Cloudflare Turnstile / CAPTCHA handling".

---

## 9. Connect to your local Chrome (instead of VNC server)

If you already have a real Google Chrome running locally with remote debugging
enabled, you can skip VNC entirely and attach directly over CDP.

### Auto-detect local Chrome

Chrome exposes CDP on common ports: **9222, 9223, 9224**.

```bash
# Start Chrome manually once (or check it is already running):
google-chrome --remote-debugging-port=9222

# Verify it is listening:
curl http://127.0.0.1:9222/json/version
```

### Attach from scripts

Use `scripts/connect.js` exactly like `live.js`, but point it at your running
Chrome:

```bash
CDP_URL=http://127.0.0.1:9222 node scripts/connect.js dump
node scripts/connect.js goto https://example.com
```

This is the same connection path as `connect.js` (remote Chrome over CDP).
`connect.js` never launches a browser — it only attaches to an existing CDP
endpoint.

### Programmatic attach (local Chrome module)

`scripts/local-chrome.js` provides a small helper that auto-detects a running
Chrome and returns a Playwright browser handle:

```js
const { connectLocalChrome } = require('./scripts/local-chrome.js');

const { browser } = await connectLocalChrome(9222);
const page = browser.contexts()[0].pages()[0];

await page.goto('https://example.com');
console.log(await page.evaluate(() => document.body.innerText));
```

`connectLocalChrome(port)` probes `http://127.0.0.1:<port>/json/version`,
throws a helpful error if nothing is listening, and returns
`{ browser, port, url, info }`.

### Relationship to scripts/connect.js

- `connect.js` is a full CLI for any remote CDP endpoint: navigation, forms,
  `dump`, the scraping commands (§4) and the overlay commands (§6).
- `scripts/local-chrome.js` is a lower-level attach helper with auto-detect,
  a CLI (`detect` / `attach`) and clearer errors for local Chrome.
- Both use `chromium.connectOverCDP()` under the hood. Neither launches or
  closes the browser.

### Launching a local Chrome for this workflow

```bash
# Start a normal Chrome with a DevTools port (own profile, runs alongside yours)
npm run local-chrome                     # CDP on 9222
CDP_PORT=9444 npm run local-chrome       # or a different port

# Is one already running?
node scripts/local-chrome.js detect      # auto-detects 9222-9224 (or LOCAL_CHROME_PORTS)
node scripts/local-chrome.js attach 9222

# Drive it through the VNC stack (Xvfb + x11vnc + noVNC, but no browser launch)
npm run vnc -- --local-chrome --local-chrome-port 9222
```

The driver injects the stealth layer and the HUD into the attached browser
(best-effort: pages that are already open keep whatever they had), prints
`[driver] attached to local Chrome …`, and **never closes your browser** on exit.

---

## 10. Tunnel service (named tunnel + password)

A tunnel exposes a local port (noVNC at 6080, the app you are testing, …) as a
shareable URL, with **password protection enforced locally** rather than by the
tunnel provider.

### How it works

```
internet → provider tunnel → [password gate :6199] → your local target
```

`scripts/tunnel.js` starts `scripts/tunnel-auth-proxy.js`, a small HTTP/WebSocket
proxy that rejects anything without the password, and points the provider tunnel
at **that** proxy — never at the raw VNC/CDP port.

### Commands

| Command | Args | Does |
| ------- | ---- | ---- |
| `tunnel-create <name> [password] [provider]` | start the gate + tunnel | provider defaults to `cloudflare` |
| `tunnel-route <target> [provider]` | repoint the gate at a new local target | |
| `tunnel-url [provider]` | print the shareable URL and auth requirements | |
| `tunnel-status [provider]` | show running state as JSON (pids, target, url) | |
| `tunnel-stop [provider]` | stop the tunnel, and the gate when nothing is left running | |

All five are also available through `npm run live -- tunnel-*` and
`node standalone/index.js tunnel …`. They are local commands: **no browser
session required.** State lives in `datastore/tunnel-state.json` (mode `0600`),
so `tunnel-url` works from a different process minutes later.

### Providers

| Provider | Needs | Notes |
| -------- | ----- | ----- |
| `cloudflare` | `cloudflared` on PATH | Real quick tunnel; the URL is read from the process output |
| `ngrok` | `ngrok` on PATH | URL is read from the local ngrok API (`:4040`) |
| `custom` | nothing | Bring your own tunnel: set `TUNNEL_CUSTOM_URL` |

If the binary is missing you get an explicit error with install instructions —
**no URL is ever invented**:

```json
{"cmd":"tunnel-create","ok":false,"error":"cloudflared not found (looked for \"cloudflared\" on PATH). Install it: …"}
```

### Password protection

A password is required at creation. Every request to the gate must prove it:

```bash
curl -u any:SECRET http://127.0.0.1:6199/            # HTTP Basic
curl 'http://127.0.0.1:6199/?pw=SECRET'              # query form (noVNC/WebSockets)
```

- HTTP Basic or `?pw=` (browsers cannot set headers on a WebSocket handshake).
- A successful `?pw=` request sets an `HttpOnly` cookie so noVNC's JS/CSS and
  the RFB socket keep authenticating.
- Unauthenticated or wrong-password requests get `401` +
  `WWW-Authenticate: Basic realm="ServerBrowser"`; WebSocket upgrades are refused.
- The password is never printed back — `tunnel-url` reports `passwordProtected`
  and `passwordSet` only.

### Environment variables

| Variable | Effect | Default |
| -------- | ------ | ------- |
| `TUNNEL_PASSWORD` | Default password when none is passed | (none — required) |
| `TUNNEL_TARGET` | Default local target | `http://127.0.0.1:6080` |
| `TUNNEL_PROXY_PORT` | Port of the local password gate | `6199` |
| `TUNNEL_CUSTOM_URL` | Public URL for the `custom` provider | (none) |
| `TUNNEL_URL_TIMEOUT_MS` | How long to wait for a provider URL | `30000` |
| `TUNNEL_DEBUG_LOG` | Append the gate's stdout/stderr to this file | (off) |

### Examples

```bash
# Password-gated tunnel in front of the noVNC page (custom = bring your own)
node scripts/tunnel.js tunnel-create my-session s3cret custom
node scripts/tunnel.js tunnel-route http://127.0.0.1:6080 custom
node scripts/tunnel.js tunnel-url custom
node scripts/tunnel.js tunnel-status custom
node scripts/tunnel.js tunnel-stop custom

# Cloudflare quick tunnel (needs cloudflared installed)
node scripts/tunnel.js tunnel-create my-session s3cret cloudflare
```

### Security notes

- Always set a password; the gate refuses to start without one.
- The provider is validated **before** the shared gate is touched, so a failed
  `cloudflare` start can never disturb a running `custom` tunnel.
- Do not expose the raw CDP port (9222) or the gate's own port directly.
- `datastore/tunnel-state.json` holds the gate password and is written `0600`.

### Plan for own tunnel service launch

`tunnel.js` already isolates the provider behind `resolveProvider(name)`. A
future phase can add a `tunnel-service/` module (multi-client session
management, timeouts, a control plane for lifecycle) without touching the
commands above.

---

## 11. Standalone app

`standalone/` is a thin, scriptable CLI in front of the same engines: the browser
group delegates to `scripts/live.js`, the tunnel group to `scripts/tunnel.js`,
and the AI group to the provider layer in `standalone/providers/`.

### Setup

```bash
node standalone/index.js --help      # or: npm run standalone -- --help
node standalone/index.js browser     # list that group's subcommands
```

### Groups

| Group | Subcommands |
| ----- | ----------- |
| `browser` | `goto`, `click`, `fill`, `dump`, `screenshot`, `pdf`, `extract-*`, `save-page-json`, `screenshot-element`, `status-set`, `progress`, `notify`, `overlay-state`, `pause`, `resume`, `agent-tab-*`, `context-*`, `db-*` |
| `tunnel` | `create`, `route`, `url`, `status`, `stop` |
| `ai` | `providers`, `ping`, `chat` |
| `api-keys` | `set`, `get`, `list`, `remove`, `path` |

### Commands

```bash
# Browser automation (delegates to scripts/live.js)
node standalone/index.js browser goto https://example.com
node standalone/index.js browser click "button#submit"
node standalone/index.js browser extract-links checkout
node standalone/index.js browser db-select products '{"id":1}'

# Tunnels with password-protected ingress
node standalone/index.js tunnel create my-session s3cret custom
node standalone/index.js tunnel status custom
node standalone/index.js tunnel stop custom

# API keys — stored 0600 in ~/.config/serverbrowser/api-keys.json
node standalone/index.js api-keys set anthropic sk-ant-abc123
node standalone/index.js api-keys get anthropic            # masked
node standalone/index.js api-keys get anthropic --reveal   # raw, on purpose
node standalone/index.js api-keys list
node standalone/index.js api-keys remove anthropic

# AI calls through the provider layer
node standalone/index.js ai providers                      # which keys are available
node standalone/index.js ai ping                           # offline round trip
node standalone/index.js ai chat echo "summarise this"     # no credentials needed
node standalone/index.js ai chat openai "summarise this" --model gpt-4o-mini
```

### API key storage

Keys live in `~/.config/serverbrowser/api-keys.json` with the directory at `0700`
and the file at `0600`; they are never written into the repository. `get`/`list`
mask the value unless you pass `--reveal`.

### AI provider abstraction

`standalone/providers/ai.js` gives every provider the same call shape
(`chat({ prompt, system, model, maxTokens, temperature })` → `{ text, usage }`):

| Provider | Credentials | Base URL override |
| -------- | ----------- | ----------------- |
| `echo` | none (offline, deterministic) | — |
| `openai` | `OPENAI_API_KEY` or the key store | `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` or the key store | `ANTHROPIC_BASE_URL` |
| `ollama` | none | `OLLAMA_URL` |

A missing key fails immediately with an actionable message instead of a 401 deep
inside `fetch`. Adding a provider means adding one object with `name`,
`requiresKey` and `chat()` to `PROVIDERS`.

### Integrating with live.js

The standalone browser group forks `scripts/live.js` per command, so results are
the same JSON lines and every `live.js` command is available — including the
scraping, overlay and datastore commands.

## 12. Troubleshooting

- **Ports in use:** override them, e.g. `CDP_PORT=9223 WEB_PORT=6081 npm run vnc`,
  and pass the matching `CDP_URL` to `live`/`live-run`.
- **"Profile is in use"** when starting: another Chrome is holding `profile/`.
  Close it, or point to a fresh one with `PROFILE=/tmp/chrome-alt npm run vnc`.
- **Can't attach:** confirm `curl http://127.0.0.1:9222/json/version` responds
  while `npm run vnc` is running.
- **Stored script still closes the browser:** only `browser.close()` is
  suppressed. If a script calls it via a different name/path, run it through
  `live-run` (which patches the shared Playwright singleton that the script
  imports) rather than requiring it directly.
- **Local Chrome not detected:** start Chrome with `--remote-debugging-port=9222`
  and verify with `curl http://127.0.0.1:9222/json/version`. If another
  process uses that port, try 9223 or 9224, or point at it explicitly with
  `npm run local-chrome -- 9444` / `node scripts/local-chrome.js detect 9444`.
- **No HUD on the VNC screen:** the driver logs a self-check line —
  `[driver] self-check: {"stealth":…,"overlayConfig":…,"overlayApi":…,"hud":…}`.
  If `hud` is `false`, the injected script failed to parse; `overlay-state`
  reports the same thing from the agent side.
- **`status-set` / `progress` / `notify` return `ok` but nothing appears:** they
  are no-ops when the HUD is not installed. Check `overlay-state` first, and
  reload the page (`goto`) so the init script runs.
- **Tunnel answers 401:** every request needs the password — `curl -u any:PW …`
  or `…?pw=PW`. For noVNC, open the viewer with `?pw=…` in the URL; the cookie
  is then set for the page's own assets.
- **`tunnel-create` says `cloudflared not found`:** install the provider binary
  (the error links to the download) or use `--provider custom` with
  `TUNNEL_CUSTOM_URL` set.
- **`db-*` says nothing is connected:** the datastore connects lazily; pass
  `DATASTORE_PATH` or use `db-connect <path>` to choose a file.

