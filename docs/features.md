# Web Control Panel — Proposed Features

> **STATUS: PROPOSED.** Nothing in this document is implemented. It follows the
> same convention as the `PROPOSED` sections in
> [`COMMANDS.md`](COMMANDS.md): specified here so it is never mistaken for
> working code. The actionable work items live in
> [`../TODO.md`](../TODO.md).

The goal is a **local web interface** that operates the whole ServerBrowser
stack — live sessions, stored scripts, VNC, and browser instances — without
dropping to a terminal.

---

## 1. Goals and non-goals

### Goals

- One page to see every **live session** and act on it: start, restart, shut
  down, inspect health.
- Manage the **stored scripts** in `user-scripts/`: list, view, edit, create,
  delete, and run them against a chosen live session (reusing
  `scripts/live-run.js` semantics: attach over CDP, suppress `browser.close()`).
- **VNC controls**: open the noVNC viewer, embed it inline, change the VNC
  password, and adjust viewer/display settings (screen size, quality, scale).
- **Add and manage new browsers**: several concurrent headed instances, each
  with its own ports, profile, browser type and resolution — including
  attaching to an already-running Chrome (`--local-chrome` mode).
- A JSON **API** behind the UI so the same operations are scriptable/agentable,
  consistent with the project's JSON-in/JSON-out philosophy.

### Non-goals (v1)

- Remote multi-user access, accounts, or roles — the panel binds to
  `127.0.0.1` by default with an optional shared token (same idea as the
  password-gated tunnel in `scripts/tunnel-auth-proxy.js`).
- Replacing the CLI. `npm run vnc`, `npm run live`, `npm run live-run` keep
  working exactly as documented; the panel is another client of the same
  machinery.
- A frontend framework. Per repo convention the UI is static HTML + vanilla JS
  (same styling vocabulary as `vnc-web/index.html`), served by the panel.

---

## 2. Proposed architecture

New files (nothing existing is rewritten beyond the noted refactor):

```
control/
├── panel-server.js        # plain Node `http` server: static UI + JSON API + SSE
├── lib/
│   ├── session-manager.js # spawn/supervise vnc-server.sh, port allocation, health
│   ├── script-manager.js  # CRUD + run over user-scripts/, log capture
│   ├── browser-registry.js# browser definitions (name, type, profile, ports…)
│   ├── vnc-control.js     # x11vnc password store/restart, viewer link builder
│   └── state.js           # read/write datastore state files (0600)
└── public/                # static panel UI (index.html, app.js, style.css)

datastore/
├── sessions.json          # running/known sessions (name, ports, pids, config)
├── browsers.json          # saved browser definitions
└── vnc-passwd/<session>   # x11vnc password files, mode 0600
```

State files follow the existing `datastore/tunnel-state.json` precedent: JSON,
written with mode `0600`, safe to read from a different process minutes later.

**Why plain `http`:** the dependency set is `duckdb, marked, playwright,
puppeteer` — no Express. The panel uses Node built-ins only (plus `marked`,
already a dependency, to preview Markdown notes next to scripts).

### Session model

A session is one supervised run of the (refactored) VNC stack:

| Field | Meaning | Default |
| ----- | ------- | ------- |
| `name` | human id, unique | `default` |
| `webPort` | websockify / noVNC port | `6080` |
| `rfbPort` | x11vnc port | `5900` |
| `cdpPort` | Chrome DevTools port | `9222` |
| `display` | Xvfb display number | `:10` |
| `screen` | `WIDTHxHEIGHTxDEPTH` | `1280x800x24` |
| `browser` | `chrome \| chromium \| firefox` | `chrome` |
| `profile` | Chrome `user-data-dir` | `./profile` (session 1), `./profile/<name>` (others) |
| `startUrl` | first tab | `http://127.0.0.1:<webPort>/` |
| `localChrome` | attach instead of launch (port or auto) | off |
| `vncPassword` | set ⇒ x11vnc runs with `-rfbauth` | unset (`-nopw`, today's behaviour) |

Concurrency constraint: **one Chrome per profile dir** (Chrome takes a lock),
so every concurrent session gets its own profile directory unless it
explicitly opts into the shared `./profile`.

---

## 3. Features

### F1 — Live session management

- **Session list** with live status: `starting → running → degraded → stopped`,
  derived from process liveness + health probes (CDP `GET /json/version`, web
  port `GET /`).
- Per session: name, ports, display, resolution, browser type, profile path,
  uptime, current URL/title (from CDP), and a link to its viewer.
- **Start a new session** from the UI with a form for every model field, plus
  resolution presets (`1280x800`, `1920x1080`, `2560x1440`, custom).
- **Restart** = stop + start *the same session with the same config* (profile
  and therefore cookies/logins survive — same guarantee as today's relaunch).
- **Shut down** = terminate the session's process group so `vnc-server.sh`'s
  `cleanup` trap tears down Xvfb/websockify/x11vnc/Chrome in order.
- Port allocation: explicit ports as typed, otherwise pick free ports per
  session (`6080/5900/9222` + offset, verified with a bind test) and record
  them in `datastore/sessions.json`.
- Adopt sessions started outside the panel (detect `vnc-server.sh`, Xvfb/
  x11vnc/websockify/Chrome by process match + port probes) as `unmanaged`,
  shown read-only until adopted.

### F2 — Server lifecycle controls (start / restart / shut down)

- Buttons per session: **Start**, **Restart**, **Shut down**, with a
  confirmation step for destructive actions and disabled states while an
  operation is in flight.
- Global actions: **Start new session**, **Restart all**, **Shut down all**
  (double confirm).
- Operations are asynchronous with job status: the API returns `202` + a
  `jobId`; progress/events stream over SSE so the UI shows "restarting… ready"
  and the resulting URLs without polling.
- Crash handling: if a supervised child dies unexpectedly, mark the session
  `degraded`, surface a stderr tail from the log, and offer Restart.

### F3 — View VNC

- **Open viewer** button per session →
  `http://<host>:<webPort>/novnc/vnc.html` in a new tab (`REMOTE_ADDR`
  awareness as printed by `vnc-server.sh` today). `vnc.html` (not
  `vnc_auto.html`) because it accepts viewer settings via the query string.
- **Embed viewer** — inline iframe toggle on the session card so the panel is
  the single dashboard ("view only" available via noVNC query options where
  the installed build supports it).
- Copyable viewer URL, instructions URL (`<webPort>/`), and CDP endpoint
  (`127.0.0.1:<cdpPort>`) per session, mirroring the startup banner.
- Optional shareable link through the existing tunnel
  (`scripts/tunnel.js tunnel-create … custom` + `tunnel-route` to the web
  port), reusing the local password gate.

### F4 — Change VNC password

- Set / change / clear the VNC password for a session from the UI.
- Mechanism: `x11vnc -storepasswd <pw> <datastore/vnc-passwd/<session>>`
  (file mode `0600`), then run x11vnc with `-rfbauth <file>` instead of the
  current `-nopw`.
- **Changing the password on a running session restarts only the x11vnc
  child** — Xvfb, Chrome and the CDP session stay up; the viewer just
  reconnects. Clearing the password returns to `-nopw`.
- The password is write-only in the UI: never echoed back, never logged,
  never written to JSON state — only the passwd file path is stored.
- noVNC prompts for the password in the RFB handshake; the UI must not
  conflate this with the tunnel's `?pw=` HTTP gate.

### F5 — noVNC / display settings

Per session, in the UI:

- **Screen size**: presets + custom `WxH`, color depth (`16/24`). Changing it
  rewrites `SCREEN` and **restarts the session** — Xvfb fixes its screen
  geometry at startup; the Chrome window/viewport follow automatically because
  `vnc-server.sh` derives them from the screen (single-source behaviour kept).
- **Viewer link options** appended to the noVNC URL — **verified against the
  installed noVNC build** (`/usr/share/novnc`, symlinked at `vnc-web/novnc`):
  its `vnc.html` reads the query string first (`ui.js initSetting` →
  `getConfigVar`) and supports `resize=scale|remote|none` and `view_only=1`,
  surfaced in the UI as a "Resize mode" selector + "view only" checkbox.
  `quality`/`compression`/scale-factor were **dropped after verification**:
  this build exposes no such settings. The full `vnc.html` UI also offers its
  own toolbar (disconnect, ctrl-alt-del, etc.).
- **Start URL** edit (applied on next start; optionally "navigate now" via the
  existing `goto` live command).
- **Browser type** switch (`chrome | chromium | firefox`) — applied on restart.
- Saved as session defaults so a restart keeps them.

### F6 — Script management (`user-scripts/`)

- **List** scripts in `user-scripts/` (name, size, mtime) — the folder stays
  gitignored exactly as today; the panel only manages files on disk.
- **View / edit** in a textarea; README-style notes preview with the
  already-bundled `marked`.
- **Create / upload / rename / delete** (delete behind confirmation; deletion
  moves to `user-scripts/.trash/` instead of unlinking).
- **Run** a script against a chosen session: spawns
  `node scripts/live-run.js <script> [args]` with `CDP_URL` pointed at that
  session's CDP port, args parsed from a free-text field (same argv
  passthrough as `npm run live-run -- <script> <args>`).
- **Run history**: per run — script, args, session, start/end, exit code, and
  captured stdout/stderr, viewable while running (SSE) and after (tail stored
  under `datastore/run-logs/`).
- Concurrency guard per session (default: one script run at a time per
  session; queue or reject) while live commands remain available.
- Kill a running script — the browser survives by construction
  (`live-run.js` already suppresses `browser.close()`).

### F7 — Add / manage new browsers

A **browser definition** is a reusable template for a session:

- Fields: name, browser type, profile dir (create-new or existing), default
  resolution, start URL, port overrides, `localChrome` attach settings, VNC
  password on/off.
- **Add / edit / duplicate / delete** definitions from the UI; list them on a
  "Browsers" page.
- **"Launch"** a definition → creates a session from it (F1) in one click.
- **Local-Chrome attach mode**: start the VNC stack without launching a
  browser (`--local-chrome [--local-chrome-port N]`) against an external
  Chrome — the panel probes for an available CDP port and offers the detected
  instances.
- Port/profile collision checks before launch with a clear error
  ("profile in use by session `default`").
- Per-browser health: CDP reachable, process alive, and a one-click
  screenshot thumbnail (via the existing `screenshot` live command) as a
  "what's on screen" glance.

### F8 — Live status, logs, and events

- **SSE stream** (`/api/events`): session state transitions, operation job
  progress, script-run log lines, health probes.
- Per-session **log pane** (combined stdout/stderr of the supervised stack,
  ring-buffered, last N lines on connect).
- Headline metrics per session: uptime, current URL/title, open tabs count
  (CDP `/json/list`), viewer/CDP reachability badges.

### F9 — Security

- Panel binds `127.0.0.1` by default; `PANEL_ADDR=0.0.0.0` requires a token.
- Optional shared token (env `PANEL_TOKEN`, or generated into
  `datastore/panel-state.json` 0600) — same HTTP-Basic-or-`?pw=` pattern as
  `scripts/tunnel-auth-proxy.js`, since noVNC/WebSockets cannot send headers.
- CSRF protection: `Origin`/`Host` check + same-site cookie for state-changing
  `POST/PUT/DELETE`.
- Path-traversal hardening on every script file operation (resolve + prefix
  check against `user-scripts/`) and a filename allowlist.
- Destructive endpoints (shutdown, delete script, clear password) require an
  explicit confirmation payload; everything is audited to a local log.
- CDP stays loopback-only as today (`127.0.0.1:<cdpPort>`); the panel proxies
  only what it needs (URL/title/screenshot), never exposing raw CDP off-host.

---

## 4. Proposed API surface

All JSON. `202` + `{jobId}` for long-running operations; events on
`GET /api/events` (SSE).

| Method & path | Does | Feature |
| ------------- | ---- | ------- |
| `GET  /api/sessions` | list sessions + health | F1 |
| `POST /api/sessions` | start new session (model fields) | F1, F2 |
| `GET  /api/sessions/:name` | one session detail | F1 |
| `POST /api/sessions/:name/restart` | restart with same config | F2 |
| `DELETE /api/sessions/:name` | shut down (process group) | F2 |
| `GET  /api/sessions/:name/status` | probe: process + CDP + web | F1 |
| `GET  /api/sessions/:name/logs` | recent log lines (SSE or JSON) | F8 |
| `GET  /api/sessions/:name/viewer-url` | noVNC URL incl. options | F3, F5 |
| `PUT  /api/sessions/:name/vnc-password` | set/change password | F4 |
| `DELETE /api/sessions/:name/vnc-password` | clear → `-nopw` | F4 |
| `PATCH /api/sessions/:name/settings` | screen, viewer opts, start URL | F5 |
| `GET  /api/scripts` | list `user-scripts/` | F6 |
| `POST /api/scripts` | create script | F6 |
| `GET/PUT/DELETE /api/scripts/:name` | read / update / delete (trash) | F6 |
| `POST /api/scripts/:name/run` | run via `live-run.js` on a session | F6 |
| `GET  /api/runs` / `GET /api/runs/:id` | run history + logs | F6 |
| `DELETE /api/runs/:id` | kill a running script | F6 |
| `GET/POST /api/browsers` | list / add browser definitions | F7 |
| `PUT/DELETE /api/browsers/:id` | edit / delete definition | F7 |
| `POST /api/browsers/:id/launch` | create session from definition | F7 |
| `POST /api/browsers/attach-local` | start stack in `--local-chrome` mode | F7 |
| `GET  /api/jobs/:id` | job status | F2 |
| `GET  /api/events` | SSE: state, jobs, logs | F8 |

---

## 5. Constraints and honest limitations

These shape the design and must stay visible in the UI:

1. **Screen size changes require a session restart.** Xvfb fixes its screen at
   startup. Profile state survives restarts (cookies/logins), so a restart is
   cheap — but the viewer drops for a few seconds.
2. **Multi-session needs a `vnc-server.sh` refactor.** Its cleanup runs
   `pkill -f "scripts/vnc-driver.js"` with no display/port scoping, so stopping
   one session would kill *every* session's driver. Cleanup must become
   per-session (kill the tracked process group only) before concurrent sessions
   are safe. The `x11vnc`/`websockify`/`Xvfb` pkill patterns are already
   display/port-scoped and can stay as a fallback.
3. **One Chrome per profile dir.** Concurrent sessions need separate
   `user-data-dir`s; the shared `./profile` belongs to a single session.
4. **No Express.** Panel = Node `http` + static assets, consistent with the
   current dependency set.
5. **x11vnc runs `-nopw` today.** F4 introduces `-rfbauth`; until it ships,
   "change password" should be hidden rather than faked.
6. **VNC password ≠ tunnel password.** They are separate mechanisms (RFB auth
   vs. HTTP gate) and the UI must not conflate them.
7. **`user-scripts/` is intentionally uncommitted** — the panel manages local
   files only; nothing there is pushed to the remote.
8. **`local-chrome` sessions don't own their browser** — the panel can restart
   the VNC stack around them, but shutting down an attached Chrome is out of
   scope (it wasn't started by us).

---

## 6. Phasing (mirrors `../TODO.md`)

| Phase | Delivers | Features |
| ----- | -------- | -------- |
| **P0** | Panel skeleton: `http` server, static UI, state module, health probes | scaffolding |
| **P1** | Session manager: start/stop/restart, per-session cleanup refactor, port allocation, `sessions.json` | F1, F2 |
| **P2** | Sessions page + lifecycle buttons + SSE job/log events | F1, F2, F8 |
| **P3** | VNC controls: viewer links/embed, password set/change/clear, screen & viewer settings | F3, F4, F5 |
| **P4** | Script manager: CRUD, run via `live-run.js`, logs/history/kill | F6 |
| **P5** | Browser registry: definitions, launch, local-chrome attach, collisions | F7 |
| **P6** | Security hardening: token, bind rules, CSRF, traversal tests | F9 |
| **P7** | Docs (`docs/` page + README pointer), smoke tests, `build-docs.js` pass | docs |

Each phase ends with a verifiable outcome — the acceptance steps are listed in
[`../TODO.md`](../TODO.md).
