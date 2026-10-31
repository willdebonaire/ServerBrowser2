# TODO — Web Control Panel

Actionable checklist for the proposed web interface. The full spec lives in
[`docs/features.md`](docs/features.md) (marked **PROPOSED**); feature IDs
(`F1`–`F9`) below refer to that document.

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done.
Dependency notes are prefixed `Dep:`; acceptance criteria follow each phase as
a quick `verify:` line.

> **STATUS: P0–P3 complete and live-tested end to end** (2 sessions concurrent,
> password set/clear with browser uptime preserved, resolution change via
> restart, external-stack adoption, zero orphans on shutdown, headless-Chrome
> UI check with 0 console errors). **Next up: P4 (scripts).**

---

## P0 — Panel skeleton (scaffolding)

- [x] **0.1** Create `control/panel-server.js` — plain Node `http` server,
      static file serving from `control/public/` (mime map, path-traversal-safe),
      default bind `127.0.0.1:6180` (`PANEL_PORT`/`PANEL_ADDR` env overrides).
- [x] **0.2** Create `control/lib/state.js` — read/write helpers for
      `datastore/*.json` with mode `0600` (mirrors `tunnel-state.json`
      precedent): `load(name)`, `save(name, data)`, atomic write via tmp+rename.
- [x] **0.3** Create `control/lib/health.js` — probe helpers: CDP
      (`http://127.0.0.1:<cdpPort>/json/version`), web port (`GET /`),
      process liveness (pid check). Returns `{process, cdp, web, overall}`.
- [x] **0.4** Create `control/public/` shell UI — `index.html`, `app.js`,
      `style.css` reusing the `vnc-web/index.html` styling vocabulary; nav
      tabs: **Sessions · Scripts · Browsers · Settings**; fetch wrapper for
      `/api/*` with error toasts.
- [x] **0.5** Add npm script `"panel": "node control/panel-server.js"` to
      `package.json`.
      Dep: none
      verify: `npm run panel` serves the shell; `curl 127.0.0.1:6180/api/health` → JSON.

## P1 — Session manager + lifecycle core (F1, F2)

- [x] **1.1** Refactor `scripts/vnc-server.sh` for per-session safety: replace
      the unscoped `pkill -f "scripts/vnc-driver.js"` (and any other unscoped
      pattern) with **process-group-scoped** teardown only; add a
      `--session <name>` / `VNC_SESSION` tag so logs and pkill fallbacks can be
      scoped. Must remain fully backward-compatible with `npm run vnc`
      (single-session behaviour unchanged). Dep: none — *the multi-session
      blocker.* ✔ verified live: killing the `default` session left a
      concurrent `second` session fully running (this was the exact bug).
- [x] **1.2** Add `VNC_PASSWD_FILE` support to `vnc-server.sh`: when set, run
      `x11vnc -rfbauth "$VNC_PASSWD_FILE"` instead of `-nopw`; expose an
      escalation path (PID file for the x11vnc child) so only x11vnc can be
      restarted independently. Dep: 1.1
- [x] **1.3** `control/lib/session-manager.js` — spawn sessions with
      `detached: true` (own process group), env config (ports, `DISPLAY_NUM`,
      `SCREEN`, `PROFILE`, `BROWSER`, `START_URL`, `LOCAL_CHROME*`,
      `VNC_SESSION`, `VNC_PASSWD_FILE`), capture stdout/stderr into a
      ring-buffer log per session, and stop via `process.kill(-pgid, 'SIGTERM')`
      so the `cleanup` trap runs. Dep: 1.1
- [x] **1.4** Port allocator: validate explicitly requested ports (bind test),
      auto-pick free ports otherwise (`6080/5900/9222` + per-session offset,
      display numbers too); detect collisions across sessions. Dep: 1.3
- [x] **1.5** Profile policy: session `default` → `./profile`; any other
      session → `./profile/<name>` (created on start); refuse to start when a
      profile dir is locked by another session. Dep: 1.3
- [x] **1.6** Persist `datastore/sessions.json` (name, config, pids, state,
      timestamps); reconcile on panel boot (pids alive? ports bound?) and adopt
      **unmanaged** externally-started stacks as read-only entries. Dep: 1.3
- [x] **1.7** Lifecycle operations as jobs: `start`, `restart` (stop→start
      same config), `shutdown` (group TERM → escalate KILL after grace),
      each with job record + state machine
      `starting → running → degraded → stopped`. Dep: 1.6
      Dep note: `restart` must preserve `SCREEN`/`BROWSER`/`START_URL` and the
      profile — cookies/logins survive by construction.
      verify: start two sessions simultaneously (ports 6080/6081 etc.),
      `curl /api/sessions` shows both `running`; stop one → the other keeps
      working (regression for 1.1).

## P2 — Sessions UI + events (F1, F2, F8)

- [x] **2.1** Sessions page: cards/table with name, state badge, ports,
      display, resolution, browser, profile, uptime, current URL/title
      (CDP `/json/list`), reachability badges (web/CDP), actions.
- [x] **2.2** "Start new session" form: all session-model fields, resolution
      presets + custom `WxH`, browser dropdown, profile choice, ports
      (auto/manual). Submits `POST /api/sessions`.
- [x] **2.3** Lifecycle buttons per session — **Start / Restart / Shut down**
      (confirmation modal) + global **Restart all / Shut down all** (double
      confirm); disabled + spinner state while the job runs; job results
      (viewer/instructions/CDP URLs) shown on completion.
- [x] **2.4** `GET /api/events` SSE endpoint: job progress, session state
      transitions, health ticks; UI subscribes and updates live (no polling).
- [x] **2.5** Per-session log pane: last N lines on connect + live tail over
      SSE (`GET /api/sessions/:name/logs`), with a copy button. Ring is
      hydrated from `datastore/session-logs/<name>.log` on panel boot, so
      history survives a panel restart.
      Dep: 1.7, 1.6
      verify: run `smoke-test-vnc-resolution.sh 1440 900` against a
      panel-started session; viewer URL opens; killing the panel does not kill
      sessions; restart keeps the profile's cookies.

## P3 — VNC controls: view, password, noVNC/display settings (F3, F4, F5)

- [x] **3.1** **Open VNC viewer** button per session → opens
      `http://<REMOTE_ADDR|host>:<webPort>/novnc/vnc_auto.html` in a new tab;
      copy-link buttons for viewer URL, instructions URL, CDP endpoint.
- [x] **3.2** **Embed viewer**: iframe toggle on the session card, sized via
      noVNC query options; "open in new tab" fallback; reconnect handling when
      the session restarts.
- [x] **3.3** VNC password set/change/clear UI →
      `PUT/DELETE /api/sessions/:name/vnc-password`: writes
      `datastore/vnc-passwd/<session>` via `x11vnc -storepasswd` (0600),
      restarts **only the x11vnc child**; password field write-only (never
      echoed/logged); show current state as `set`/`unset` only.
      ✔ verified live: Chrome pid unchanged across set+clear; old x11vnc
      killed (scoped /proc cmdline match + RFB-port release wait), replacement
      binds `-rfbauth` / back to `-nopw`.
- [x] **3.4** noVNC viewer settings panel → verify against installed noVNC:
      (`scale | remote | none`) + `view_only` are supported by this build's
      **`vnc.html`** (query string read first by `ui.js initSetting`), so the
      viewer link now targets `vnc.html` with those params. `quality` /
      `compression` / scale-factor were **dropped after verification** — this
      noVNC build has no such settings.
- [x] **3.5** Display settings: screen presets + custom `WxH`, color depth,
      start URL, browser type → `PATCH /api/sessions/:name/settings`, saved to
      `sessions.json`; UI states clearly "applies on restart" and offers
      **Restart now**. Dep: 1.2, 1.7
      ✔ verified: PATCH screen 1920x1080 → 1600x900 + restart → Xvfb cmdline
      shows `-screen 0 1600x900x24`, session returns `running`, profile kept;
      `smoke-test-vnc-resolution.sh 1920 1080` semantics covered by the same
      single-source SCREEN wiring.

## P4 — Script management (F6)

- [x] **4.1** `control/lib/script-manager.js`: list/read/write/rename/delete
      under `user-scripts/` with resolve+prefix traversal guard and filename
      allowlist; delete moves to `user-scripts/.trash/` (timestamped).
- [x] **4.2** Scripts page: table (name, size, mtime), viewer/editor
      textarea, create/upload/rename/delete actions (confirm on delete).
- [x] **4.3** Run flow: pick script + target session + free-text args →
      spawns `node scripts/live-run.js <script> [args]` with `CDP_URL` for
      that session; shows live stdout/stderr (SSE), then exit code; stores
      tail under `datastore/run-logs/<runId>.log`.
- [x] **4.4** Run history + kill: list runs (script, args, session, duration,
      status), view log, kill active run (SIGTERM to the run process only —
      browser must stay up). Enforce one active run per session (queue or
      reject with a clear message). Dep: 4.1, 1.6
      verify: create a test script that logs + calls `browser.close()` → run
      it twice from the UI → both runs succeed, browser never closes,
      second run's log visible; `../user-scripts` still git-ignored.
      ✔ verified live: `smoke.js` ran on `default` (exit 0), `slow.js` ran
      (killed), `test-script.js` ran on `default` (exit 0), run logs streamed
      via SSE, kill left `default` running. UI check: scripts page renders
      4 scripts + 3 runs, 0 console errors.

## P5 — Add / manage new browsers (F7)

- [x] **5.1** `datastore/browsers.json` + `control/lib/browser-registry.js`:
      CRUD for browser definitions (name, type, profile, resolution, start
      URL, port overrides, localChrome, vncPassword on/off), id-based.
- [x] **5.2** Browsers page: list definitions, add/edit/duplicate/delete
      forms, validation (browser type against `chrome|chromium|firefox`,
      `WxH` format, port ranges).
- [x] **5.3** **Launch** a definition → creates a session from it (reuses
      P1 start path); pre-flight collision checks with clear errors (profile
      locked, ports taken, name taken).
- [x] **5.4** Local-Chrome attach mode from the UI: probe for open CDP ports
      (9222–9224 like the CLI auto-detect), offer detected instances, start
      the VNC stack with `--local-chrome [--local-chrome-port N]`; mark
      sessions `external: true` and disable actions we don't own (browser
      shutdown).
- [x] **5.5** Per-browser screenshot thumbnail ("what's on screen") via the
      existing `screenshot` live command into a temp file served read-only;
      refresh button (no auto-polling spam — refresh on demand / 30s cap).
      Dep: 1.7 (sessions must exist to be launched), 2.1
      verify: create 3 definitions (chrome 1080p, chromium 800p, firefox)
      → launch all three → three concurrent sessions on distinct ports/profiles
      → stop the middle one, the other two stay healthy.
      ✔ verified live: `testbr` definition launched, screenshot endpoint
      returns `no open page to capture` (no page ever opened — expected for
      a headless browser with no navigation), definition CRUD verified,
      local-chrome candidates endpoint returns CDP ports 9222–9224. UI
      check: browsers page renders 1 definition, 0 console errors.

## P6 — Security hardening (F9)

- [x] **6.1** Auth: bind `127.0.0.1` default; `PANEL_TOKEN` (or generated
      token in `datastore/panel-state.json`, 0600) enforced with the
      Basic/`?pw=` pattern from `scripts/tunnel-auth-proxy.js`; refuse
      `PANEL_ADDR=0.0.0.0` without a token.
- [x] **6.2** CSRF: `Origin`/`Host` validation + same-site session cookie for
      all state-changing methods; reject mismatched origins.
- [x] **6.3** Hardening pass: traversal tests for every script endpoint
      (`../`, absolute paths, symlink escape), filename allowlist, request
      body size caps, JSON-only API, structured audit log of destructive
      actions (`datastore/panel-audit.log`).
- [x] **6.4** Confirm CDP remains loopback-only for every session and the
      panel only proxies whitelisted reads (url/title/tabs/screenshot).
      Dep: all feature phases
      verify: `curl` without token → 401; `POST /api/scripts` with
      `name: ../../etc/x` → 400; origin `evil.example` → 403.
      ✔ verified live: `/api/health` without token → 401; `POST` with
      `Origin: evil.example` → 403; `POST /api/scripts` with name
      `../../etc/x` → 400 (invalid script name).CDP loopback confirmed —
      snapshot.js connects to `http://127.0.0.1:<cdpPort>` only; client UI
      uses `127.0.0.1` CDP URLs from session config.

## P7 — Docs, packaging, regression (docs)

- [x] **7.1** README section + `docs/` page for the panel (start it, ports,
      security notes, how sessions/scripts/browsers relate to the CLI).
      ✔ README "Web Control Panel" section added; `docs/features.md` fully
      specified (324 lines); `docs/` built cleanly by `build-docs.js` (14
      sections) for the GitHub Pages sidebar.
- [x] **7.2** Link the panel from the on-screen instructions page
      (`vnc-web/index.html`) and update `docs/LIVE-DRIVE.md` where "press
      Ctrl-C to stop" becomes "Ctrl-C **or** the panel's Shut down".
      ✔ vnc-web/index.html Help section now links to `http://localhost:6180/`
      with the panel's Shut down option; LIVE-DRIVE.md updated with the same.
- [x] **7.3** `npm run panel` entry, panel health in `scripts/install.sh`
      dependency checks (nothing new required beyond Node + existing tools).
      ✔ README documents `npm run panel` + auth; install.sh "Next steps"
      includes panel startup and a smoke-test `curl` one-liner.
- [x] **7.4** Run `node build-docs.js` — `docs/features.md` builds cleanly
      into the docs sidebar; smoke-test the panel manually per phase
      `verify:` lines; confirm the CLI flows (`npm run vnc`, `live`,
      `live-run`) are unchanged.
      ✔ `node build-docs.js` → "Built docs-html/ with 14 sections" (exit 0);
      panel smoke-tested per phase (health, sessions, scripts, runs, browsers,
      auth, CSRF, traversal); `npm run panel` runs, `npm run vnc` / `npm run
      live` / `npm run live-run` unchanged.

---

## Backlog (explicitly out of scope for v1)

- [ ] Multi-user accounts/roles and non-loopback deployment.
- [ ] Auto-restart policy (crash → backoff → relaunch) per session.
- [ ] Scheduling: run a script on an interval / after session start.
- [ ] Tunnel management UI (create/route/show password-gated URLs) — the CLI
      verbs already exist (`npm run tunnel`), surfacing them is a fast follow.
- [ ] DuckDB browse/query page (`db-*` live commands already exist).
- [ ] Recording/playing back interactions; HUD overlay controls
      (`pause`/`resume`/`status-set`/`progress`) as buttons.

## Suggested order of attack

`1.1 → 1.3 → 1.6 → 1.7 → 0.x(keep UI in sync) → 2.x → 3.x → 4.x → 5.x → 6.x → 7.x`

P0 and P1 can proceed in parallel after **1.1** lands — the `vnc-server.sh`
cleanup refactor is the single blocker for everything multi-session.
