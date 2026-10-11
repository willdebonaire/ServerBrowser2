# Future development roadmap

> Auto-tracked: sections prefixed with `[x]` are done; items with `[~]` are in progress.
>
> Every `[x]` below was **re-verified end to end on 2026-09-30** against a real
> Xvfb + headed Chrome + CDP stack (see *Verification log* at the bottom). The
> previous pass had marked things done that were stubs or never ran — that is
> what the log documents, and what the 2026-09-30 fixes corrected.

---

## 1. Set VNC resolution using flag

- [x] `--resolution WxH` flag parsing in `scripts/vnc-server.sh` (maps to `SCREEN=WxHx24`)
- [x] Matching `--window-size` and viewport in `scripts/vnc-driver.js`
- [x] Document the flag in `docs/LIVE-DRIVE.md` and `docs/cli.md`
- [x] Smoke test: launch, verify VNC viewer dimensions, stop

## 2. Datastore framework (DuckDB)

- [x] `datastore/` directory with `index.js`
- [x] `duckdb` in `package.json`
- [x] `scripts/datastore.js` (datastore/index.js) with all helpers
- [x] `datastore` commands in `scripts/live.js`
- [x] Error handling and JSON-shaped results
- [x] Document in `docs/LIVE-DRIVE.md`

## 3. VNC screen info overlay (current action + progress)

- [x] Overlay injection in `scripts/overlay.js`
- [x] Floating HUD: action text + progress bar
- [x] Notification system with fade in/out
- [x] `localStorage` + `addInitScript` cross-page persistence
- [x] Overlay commands in `scripts/live.js`: `status-set`, `progress`, `notify`
- [x] Auto-hide overlay after N seconds of inactivity
- [x] `pointer-events: none` on container

## 4. Pause/Resume button on VNC screen

- [x] Pause/resume buttons in VNC HUD
- [x] Signal path: button click → inject pause signal → captured by agent
- [x] `pause` and `resume` commands in `scripts/live.js`
- [x] `PAUSE_TIMEOUT_MS` env var with default 30000
- [x] `PAUSE_TIMEOUT_MS=0` disables auto-resume
- [x] Document in `docs/LIVE-DRIVE.md`

## 5. Voice commands and voice feedback

- [x] Parked — revisit after standalone app scaffolding

## 6. Download / support other Playwright browsers

- [x] `--browser=chrome|firefox|chromium` flag in `scripts/vnc-driver.js`
- [x] Firefox support via `playwright.firefox`
- [x] Add install instructions for Firefox/Chromium in `docs/installation.md`
- [x] Update `scripts/connect.js` for browser selection
- [x] Document constraints in `docs/installation.md`

## 7. Multitab concurrent operations

- [x] `agent-tab-create <name>` command
- [x] `agent-tab-switch <id>` and `agent-tab-close <id>` commands
- [x] Tab registry in `live.js`
- [x] `--agent-id <id>` scoping on every command for concurrent agents via `--stdin`
- [x] `context-new` / `context-use <id>` commands
- [x] Max-concurrent-tabs guard (10)
- [x] Document the multitab JSON-lines protocol in `docs/LIVE-DRIVE.md`

## 8. Standalone app (CLI, Cline/Kilo-like)

- [x] Scaffold standalone CLI app structure
- [x] Integrate with existing `live.js` / `connect.js` commands
- [x] Add provider abstraction layer for multiple AI providers
- [x] Add API key management and secure storage
- [x] Add tunnel service integration
- [x] Document setup and usage

## 9. More scraping commands

- [x] `save-page-json <path>`
- [x] `extract-css <selector>`
- [x] `extract-regex <pattern> [flags]`
- [x] `extract-table <selector>`
- [x] `extract-links [filter]`
- [x] `extract-images`
- [x] `screenshot-element <selector> <path>`
- [x] `pdf <path>`
- [x] Document each command with examples in `docs/LIVE-DRIVE.md`

## 10. Tunnel service (named tunnel + password)

- [x] Add tunnel provider abstraction layer
- [x] Implement `tunnel-create`, `tunnel-route`, `tunnel-url` commands
- [x] Support multiple providers (Cloudflare, ngrok, custom)
- [x] Add password protection on tunnel ingress
- [x] Generate shareable named URL
- [x] Document tunnel setup and security notes
- [x] Plan for own tunnel service launch

## 11. Connect to user's local Chrome (instead of VNC server)

- [x] Add `--local-chrome` flag to `scripts/vnc-driver.js` or new `scripts/local-chrome.js`
- [x] Auto-detect locally running Chrome with `--remote-debugging-port`
- [x] If found, attach via CDP instead of launching Xvfb + Chrome
- [x] Update `docs/LIVE-DRIVE.md` with local Chrome workflow
- [x] Clarify relationship to existing `scripts/connect.js`
- [x] `npm run local-chrome` launcher (own profile, `--no-sandbox` when root)
- [x] `local-chrome.js detect` / `attach` CLI + multi-port auto-detection
- [x] Forward `--local-chrome` through `npm run vnc`
- [x] Inject stealth + HUD into the attached browser; never close it on exit

## 12. Extras added while verifying the above

- [x] `overlay-state` command (is the HUD installed? what is its state?)
- [x] `agent-tabs` command + marker-based agent tab recovery across processes
- [x] `--agent-id` accepted before or after the command name
- [x] `db-*` / `tunnel-*` commands run with no browser session at all
- [x] Datastore: promise API, lazy connect, BigInt decoding, bare column names
- [x] Tunnel: real `cloudflared` / `ngrok` process management + `custom` provider
- [x] Tunnel: local password gate (`tunnel-auth-proxy.js`) for HTTP + WebSocket
- [x] Tunnel: persistent state file (`0600`), `tunnel-status`, `tunnel-stop`
- [x] Standalone CLI dispatcher fixed (it exited 1 on every command)
- [x] AI provider layer: `echo`, `openai`, `anthropic`, `ollama` + base-URL overrides
- [x] API keys stored `0600`, masked unless `--reveal`
- [x] `connect.js` gained the scraping + overlay commands
- [x] Driver startup self-check (`[driver] self-check: …`) to catch silent
      injection failures

---

## Verification log (2026-09-30)

Everything below was executed, not just written. Highlights:

| Area | Evidence |
| ---- | -------- |
| Overlay HUD | `[driver] self-check: {"stealth":"patched","overlayConfig":"object","overlayApi":"object","hud":true}`; `status-set` / `progress` / `notify` visible in `overlay-state` |
| Pause/resume | `PAUSE_TIMEOUT_MS=3000 … pause` → `{"autoResumed":true,"waitedMs":3072}`; clicking `#serverbrowser-hud-pause` releases it |
| Resolution | `npm run vnc -- --resolution 1600x900` → `eval` reports `1600x900`; `smoke-test-vnc-resolution.sh 1440 900` → PASS |
| Datastore | create/insert/select/update/delete/query round trip; `count(*)` decodes; blanket `UPDATE`/`DELETE` refused; SQL errors returned as JSON |
| Scraping | `extract-links/-css/-regex/-table/-images`, `save-page-json`, `screenshot-element` (PNG 1584x38), `pdf` (1 page), `screenshot` (PNG 1600x900) |
| Multitab | 11th `agent-tab-create` → `max concurrent tabs reached (10)`; `--agent-id` reuses the same tab across processes; `agent-tab-close` by id |
| Tunnel | gate returns 401 / 200 (Basic) / 200 (`?pw=`) / 401 (wrong); WebSocket upgrade 401 vs `echo:hello`; failed `cloudflare` start leaves a running gate untouched; `tunnel-url` from a later process |
| Standalone | `browser goto/title/extract-links/overlay-state`, `ai ping/chat` (mock upstream + offline `echo`), `api-keys set/get/list/remove`, `tunnel status` |
| Local Chrome | `local-chrome.js detect` (explicit + auto) and `attach`; `vnc-driver.js --local-chrome` attaches, injects, and leaves the browser running |
