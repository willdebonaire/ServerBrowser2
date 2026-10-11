# Commands Reference

Complete inventory of every command ServerBrowser exposes, plus the commands
that the run scripts prove are needed but that do not exist yet.

> **Reading this doc.** Sections B–F document what works today. Section G
> documents commands that are **specified but not implemented** — they are
> marked `PROPOSED` throughout so they are never mistaken for working code.
> **39 commands** are proposed across G1–G7. G1.1 explains why `setvalue`
> needs more than one mode.

---

## A. Command surfaces

There are four independent command tables in the codebase. They are not the
same size, and they do not all support the same commands.

| Table | Entry point | Transport | Commands |
| ----- | ----------- | --------- | -------- |
| **A1** standalone CLI | `standalone/index.js` | forks a script per command | 66 |
| **A2** live verbs | `scripts/live.js` | CDP to the running Chrome | 59 |
| **A3** remote verbs | `scripts/connect.js` | CDP to a *remote* browser | 53 |
| **A4** tunnel verbs | `scripts/tunnel.js` | local, spawns provider | 5 |

A1 breaks down as `browser` 53, `tunnel` 5, `ai` 3, `api-keys` 5. A2's
six extras over A3 are the local `tunnel-*` verbs and `agent-tabs`.

### The three ways to invoke

```bash
# 1. Standalone CLI (grouped, most convenient)
node standalone/index.js browser goto https://example.com
npm run standalone -- browser goto https://example.com

# 2. Live verbs directly (no group prefix, skips one fork layer)
node scripts/live.js goto https://example.com

# 3. Remote verbs (browser on another machine)
CDP_URL=http://10.0.0.5:9222 node scripts/connect.js goto https://example.com
```

`standalone/index.js` dispatches `<group> <subcommand> [args...]` to
`standalone/commands/<group>.js`. Each group is a flat object of
one-argument-position functions; `browser.js` forks `scripts/live.js` per call.

### Output contract

Every command writes **one JSON object per line** to stdout, shaped:

```json
{ "cmd": "<name>", "ok": true,  "result": <any> }
{ "cmd": "<name>", "ok": false, "error": "<message>" }
```

`standalone/commands/browser.js` parses those lines and re-emits either the
single result or an array if a command produced several. So from the
standalone CLI you get the bare `result` value, **without** the `ok`/`cmd`
wrapper. `ok: false` becomes a non-zero exit and a message on stderr.

### Global flags

| Flag | Where | Effect |
| ---- | ----- | ------ |
| `--agent-id <id>` | A2, A3 | Routes to a named agent tab. Accepted **anywhere** in argv, in either order, and stripped before the command name is read (`live.js:611-620`). |
| `--stdin` | A2 | Batch mode — see below. |
| `--flag value` / `--flag=value` | A1 `ai` group only | Named options; see §F. |

### Batch mode (`--stdin`) — already implemented, previously undocumented

`live.js:637-651`. Feeds **newline-delimited JSON** into one long-lived
process that executes commands in order. This is the shortest path to running
a multi-step task: one process spawn instead of N.

```bash
node scripts/live.js --stdin <<'EOF'
{"cmd":"goto","args":["https://example.com/login"]}
{"cmd":"waitfor","args":["#email"]}
{"cmd":"fill","args":["#email","me@example.com"]}
{"cmd":"click","args":["button[type=submit]"]}
{"cmd":"text"}
EOF
---

## B. `browser` — navigation

All of these go through A1 → A2. `goto`/`reload`/`back`/`forward` use
`waitUntil: 'domcontentloaded'` with a 60s timeout.

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `goto` | `<url>` | `{ url, title }` |
| `reload` | — | `{ url, title }` |
| `back` | — | `{ url, title }` |
| `forward` | — | `{ url, title }` |
| `wait` | `<ms>` | `{ waitedMs }` |
| `waitfor` | `<css> [timeoutMs]` | `{ selector, present: true }` — default timeout 15000 |

---

## C. `browser` — interaction

| Command | Arguments | Returns | Notes |
| ------- | --------- | ------- | ----- |
| `fill` | `<css> <text>` | `{ selector, text }` | Sets the value in one shot. **Does not work on React-controlled inputs** — see §G1. |
| `type` | `<css> <text> [delayMs]` | `{ selector, text }` | Key-by-key. `delayMs` defaults to 0. |
| `click` | `<css>` | `{ selector, url }` | DOM-level click. Does not open native menus or file choosers. |
| `press` | `<css> <key>` | `{ selector, key }` | Focuses the selector, then presses. |
| `keyboard` | `<key>` | `{ key }` | Presses without focusing a selector. |
| `clear` | `<css>` | `{ selector, cleared: true }` | Implemented as `fill(css, '')`. |

---

## D. `browser` — inspection & extraction

### Inspection

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `url` | — | current URL string |
| `title` | — | page title string |
| `text` | — | `document.body.innerText` |
| `html` | — | `page.content()` — full serialized DOM |
| `dump` | — | `{ url, title, inputs[≤50], buttons[≤40], links[≤40], text[4000] }` |
| `eval` | `<expression>` | the expression's value |
| `save-page-json` | `<file>` | writes a JSON snapshot of the page |

`dump` is the discovery command — it is how you find the selectors to pass to
everything else. Each `inputs` entry carries `tag`, `type`, `name`, `id`,
`placeholder`, `aria`, and `value` truncated to 120 chars.

`eval` wraps its argument as `new Function('return ((' + js + '))')`
(`live.js:344`), so it is **expression-only**: no statements, no `await`, and
no top-level `return`.

### Extraction

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `extract-css` | `<selector>` | text content of each match |
| `extract-regex` | `<pattern> [flags]` | regex matches over the page text |
| `extract-table` | `<selector>` | parsed rows |
| `extract-links` | `[filter]` | matching hrefs |
| `extract-images` | — | image srcs |

### Capture

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `screenshot` | `<file>` | `{ file }` — always `fullPage: true` |
| `screenshot-element` | `<selector> <file>` | `{ file }` |
| `pdf` | `<file>` | `{ file }` — Chromium only, i.e. not the live headed Chrome |

---
```

Each line is either JSON (`{"cmd":…,"args":[…],"agentId":…}`) or a bare
space-separated string (`goto https://example.com` — first token is the
command, rest are args). Commands execute as a serial promise chain, so
ordering is guaranteed. Failures are reported per-command and **do not** abort
the chain. This is the mechanism the proposed `run` command in §G4 would
formalise.
## E. `browser` — tabs, contexts, HUD, datastore

### Tabs & agent tabs

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `tabs` | — | `[{ i, url, title, closed }]` |
| `tab` | `<index>` | `{ active, url, title }` |
| `close-tab` | `[index\|selector]` | `{ remaining, active }` |
| `agent-tab-create` | `<name> [contextId]` | the new tab's id |
| `agent-tab-switch` | `<id>` | switches the active page |
| `agent-tab-close` | `<id>` | closes the agent tab |

`close-tab` refuses to close the last tab — the live browser must stay up.
With no argument it closes the active tab; with a non-numeric argument it
searches every open tab for a matching selector.

`agent-tabs` **exists in `live.js:579` but is not exposed** in
`standalone/commands/browser.js`, so it is unreachable from the standalone
CLI. Documented here as a real command, with that caveat.

### Browser contexts

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `context-new` | — | new context id |
| `context-use` | `<id>` | switches context |
| `contexts` | — | array of context ids |

### HUD overlay

These drive the on-screen overlay injected by `scripts/overlay.js`. They are
**silent no-ops when the HUD is not installed** — check `overlay-state` first.

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `status-set` | `<text>` | `{ text }` |
| `progress` | `<value>` | `{ progress }` |
| `notify` | `<text> [durationMs]` | `{ text, duration }` — default 4000 |
| `overlay-state` | — | whether the HUD is installed |
| `pause` | — | pauses the driver |
| `resume` | — | resumes it |

### Datastore (`db-*`)

These match `/^(db-|tunnel-)/` and run **locally — no browser session
required** (`live.js:170`, `live.js:628`). They wrap a DuckDB datastore,
lazily connected; set `DATASTORE_PATH` or use `db-connect` to pick the file.

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `db-connect` | `<path>` | connects |
| `db-close` | — | closes |
| `db-status` | — | connection state |
| `db-query` | `<sql>` | result rows |
| `db-exec` | `<sql>` | statement result |
| `db-create-table` | `<table> <columns>` | — |
| `db-insert` | `<table> <json>` | — |
| `db-select` | `<table> <whereJson>` | rows |
| `db-update` | `<table> <setJson> <whereJson>` | — |
| `db-delete` | `<table> <whereJson>` | — |
| `db-tables` | — | table names |

---

## F. `tunnel`, `ai`, `api-keys`

### `tunnel` (A4)

Password-protected ingress to the VNC web view. Providers: `cloudflared`
(default), `ngrok`, `custom`.

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `create` | `<name> <password> [provider]` | provider + public URL |
| `route` | `<target> [provider]` | re-points an existing tunnel |
| `url` | `[provider]` | current public URL |
| `status` | `[provider]` | provider, pid, uptime |
| `stop` | `[provider]` | stopped |

`live.js` carries a **duplicate** set of `tunnel-*` verbs (`tunnel-create`,
`tunnel-route`, `tunnel-url`, `tunnel-status`, `tunnel-stop` at
`live.js:245-277`) alongside the same functionality in `scripts/tunnel.js`.
The standalone `tunnel` group targets `scripts/tunnel.js`; the `live.js`
copies are the local-only path. Both work; prefer the standalone group.

### `ai`

Backed by `standalone/providers/ai.js`, which normalises every provider to
`chat({ prompt, system, model, maxTokens, temperature }) → { text, usage }`.

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `providers` | — | `[{ provider, keyAvailable, keySource }]` + store path |
| `ping` | `[provider]` | `{ ok: true, … }` — cheap round-trip; defaults to `echo` |
| `chat` | `<provider> <prompt> [flags]` | `{ text, usage }` |

Flags are parsed by `splitFlags` (`standalone/commands/ai.js:16-33`) and accept
both `--flag value` and `--flag=value`:

```bash
node standalone/index.js ai chat openai "summarise this page" \
  --model gpt-4o-mini --system "be terse" --max-tokens 800 --temperature 0.2
```

Unflagged tokens are joined with spaces, so multi-word prompts need no quoting.

| Provider | Credentials | Base URL override |
| -------- | ----------- | ----------------- |
| `echo` | none — offline, deterministic | — |
| `openai` | `OPENAI_API_KEY` or the key store | `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` or the key store | `ANTHROPIC_BASE_URL` |
| `ollama` | none | `OLLAMA_URL` |

### `api-keys`

Keys live in `~/.config/serverbrowser/api-keys.json` — directory `0700`, file
`0600`, never written into the repo.

| Command | Arguments | Returns |
| ------- | --------- | ------- |
| `set` | `<provider> <key>` | `{ provider, set: true, stored: <masked>, file, mode: '0600' }` |
| `get` | `<provider> [--reveal]` | `{ provider, present, key, revealed }` |
| `list` | — | `{ store, providers: [{ provider, key: <masked> }] }` |
| `remove` | `<provider>` | `{ provider, removed }` |
| `path` | — | `{ file, mode }` |

`get` and `list` **mask** the value unless `--reveal` is passed, so printing a
key in full is always deliberate. `remove` does not lower-case the provider
name, unlike `set`/`get` — a casing mismatch silently fails to delete.

## G. Commands that do not exist yet

Every entry here was derived by mining the run scripts for operations they had
to reimplement by hand because no command covers them. The source line is
given as evidence. **None of these are implemented.**

### G1. Correctness gaps

These are workarounds the scripts needed — real gaps in the current verbs.

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `setvalue` | `<css> <text> [mode]` | React-safe fill. `browser fill` uses Playwright's `fill`, which writes `.value` without going through the native setter, so React never sees the change and the field resets on submit. **`mode` selects between two strategies that are NOT interchangeable** — see G1.1 below. Hand-written at `scripts/gumroad-create.js:120` (`setInputValue`), `:211` (`setReactValue`), and again in `fill_helper.js` as `setVal` (which additionally handles `SELECT`). |
| `clickpoint` | `<css> [index] [offset]` | Trusted mouse events via `Input.dispatchMouseEvent`. A DOM `el.click()` will not open menus or file choosers. Hand-written at `scripts/gumroad-create.js:66-78` and `scripts/gumroad-upload.js:90-96`. |
| `upload` | `<css> <file>` | File attach. Must use the `backendNodeId` from the `Page.fileChooserOpened` event *while the chooser is open* — setting files on a node obtained from `DOM.querySelector` silently fails. `scripts/gumroad-upload.js:97-130` documents this in detail. |
| `errors` | — | Scan `[aria-invalid="true"]` and walk up the DOM for the message. This is the only way to learn *why* a form refused to submit; every failure path in `scripts/gumroad-create.js:100-118` needs it. |
| `nth` option | on every selector verb | 22 separate `wd*.js` files exist solely because each site needed a different hard-coded selector. A `::nth=2` or `\|nth` suffix on any verb would collapse that whole family. |

### G1.1 `setvalue` needs two modes, not one

The scripts contain **three** distinct implementations of "set a field", and
they are not interchangeable. A single `setvalue` would have to pick a mode, so
this is worth spelling out:

| Mode | Mechanism | Fails when |
| ---- | --------- | ---------- |
| `native` | `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set` + dispatch `input`/`change` | The component is a **fully controlled** form whose submit handler reads React state rather than the DOM. `gumroad-create.js:203-209` documents this precisely: the DOM value *and the cached React props both show the new text*, yet on submit React still sees the empty initial state. |
| `handler` | Find `Object.keys(el).find(k => k.startsWith('__reactProps'))` and call `el[k].onChange({target:{value}})` directly | The element isn't React, or the handler is under a different prop name. |
| `select` | Plain `el.value = v` — no setter, no events | Never, for `<select>`; `fill_helper.js` branches on tag name for exactly this reason. |

So `gumroad-create.js` needs `handler` for `/products/new` (`setReactValue`,
line 211) but is written defensively enough to keep `setInputValue` (line 120)
around for markup-readiness checks. `fill_helper.js` needs `native`/`select`
because those ATS forms are uncontrolled.

**Recommendation:** `setvalue <css> <text> --mode auto` should try `native`,
read back the value, and fall back to `handler` when `__reactProps` is
present — and should *warn* rather than silently succeed, since the `native`
failure mode is precisely a silent one.

### G2. Anti-detection & resilience

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `findtab` | `<urlRegex>` | 20+ root scripts open with the identical line `ctx.pages().find(p => p.url().includes('...'))`. Seen in `wd2.js`, `wd10-23.js`, `fill_mantu_final.js`, `mantu_*.js`, `jobsearch/step_job.js`. |
| `acceptdialogs` | `[on\|off]` | `pg.on('dialog', d => d.accept())` is copy-pasted into every Workday/Mantu script (`wd2.js`, `fill_mantu_final.js`, `mantu_onepass.js`, `mantu_submit2.js`, `mantu_submit3.js`). Once per session beats once per script. |
| `waitforclear` | `<titleRegex> [timeoutMs]` | Wait for a blocking interstitial to clear, given its title pattern. The corpus only ever handles one of these — Cloudflare's "Just a moment…" — with a hand-rolled 10×2s loop in `jobsearch/step_job.js:20-31`. Keeping the pattern as a **parameter** rather than hardcoding Cloudflare is the point: every SPA, bot-check, and cookie wall has its own marker, and this generalises. |
| `waitfortext` | `<regex> [timeoutMs]` | Text-based readiness. Selectors break across sites; prose does not. |

### G3. Selection & navigation sugar

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `clicktext` | `<text> [index]` | Match by visible label. `browselive.js:24-31` and `jobsearch/click_apply.js` both hand-roll it; `click_apply.js:8-11` explains why — the control is a `<button>` whose target lives in an *attribute*, not an `<a>`. |
| `radio` | `<name> <value\|index>` | `click_radios.js`, `click_radios2.js`, `fill_ashby_radios.js`, `fill_helper.js` (which also force-checks sponsorship and LinkedIn radios). |
| `scrollto` | `<css> [offset]` | Scroll into view and centre before clicking. `scripts/gumroad-upload.js:142-168` (`scrollToAndCentre`, `centreOf`, `parkAndCentre`) exists purely for this. |
| `dismiss` | — | Cookie/consent banner dismissal. Hand-written at `scripts/gumroad-create.js:84-99` and `scripts/gumroad-upload.js:406`. `wd2.js` grows its own cookie-banner block around the same idea. |
| `sniff` | — | URL + title + inputs + buttons + text in **one** spawn. Today that is five commands and five Node cold starts. `browselive.js` and `live.js:329` (`dump`) each implement a partial version. |
| `fillmap` | `<json> --rules <json>` | Fill many fields in one pass, **where the rules are data, not code.** `fill_helper.js`'s `FILL_JS` hardcodes a job-application schema — it regex-matches `name`/`id`/`placeholder` against email/phone/linkedin/location/name/employer and force-checks sponsorship radios. That logic is the valuable part, but baking the ATS vocabulary into a command would make it useless off that domain. Specifying the field patterns as a passed-in rules map keeps the mechanism generic: the same command fills an ATS form, a checkout, or a settings page. |
### G4. Run state

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `state save` | `<name> <json>` | Four scripts each grew their own resumable-state implementation: `scripts/gumroad-upload.js:456-466`, `scripts/indeed-post-all.js:21-27`, `harvest_ai_platforms.js:137-148`, `jobsearch/harvest_jobs.js`. |
| `state load` | `<name>` | ditto |
| `run` | `<jsonArray>` | Formalise §A `--stdin` into one CLI verb: `browser run '[{"goto":"…"},{"fill":["#e","a@b.c"]}]'`. One fork, N commands, single JSON array back. Needs a `stopOnError` flag and a per-step index in the response, or mid-batch failures become hard to debug. |

### G5. Cross-cutting

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `run-script` | `<file> [args]` | `scripts/live-run.js` already does this: it intercepts `chromium.launch` in a stored script and redirects it to `connectOverCDP`, and suppresses every `close()` so the live browser survives. It is not reachable from the standalone CLI. |
| `tunnel-*` dedupe | — | `live.js:245-277` and `scripts/tunnel.js` implement the same five operations twice. Worth collapsing so there is one code path and one set of semantics. |

### G6. Second pass — found after the first draft

These were missed initially and surfaced on a deeper sweep.

> **Domain-neutrality rule.** No proposed command may hardcode a vocabulary.
> Region names, phone numbers, field labels, and site markers belong in a
> passed-in rules file, never in the command's logic. Where a corpus example
> is job-specific below, that is evidence the *mechanism* is needed — not a
> licence to bake the domain in.

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `retry` | `<cmd> [args] --times N --on <regex>` | The corpus contains **37 hand-rolled `for (let i = 0; i < …)` retry loops** with no shared helper. `scripts/gumroad-create.js:195` is the clearest case: 3 attempts, each re-navigating to a *fresh* page because a partially-filled controlled form poisons the retry (`gumroad-create.js:177-178`). A generic `retry` needs a **reset hook** per attempt, which is why this cannot be a trivial wrapper. |
| `settle` | `[selector]` | The universal `waitForTimeout(2500)` / `(3500)` appears **42 times**. These are site-tuned magic numbers, not readiness checks. `waitfor` covers elements; nothing covers "the SPA finished re-rendering". |
| `classify` | `<url> --rules <json>` | Map a URL to a label via caller-supplied regex rules. The generic mechanism is **"route this URL to a handler"** — region is just what the corpus happens to bucket by. `bulk1.js:7-12` and `apply_all_tabs.js:13-18` hold a byte-identical (md5-verified) region classifier; `bulk2.js:7-13` holds a third that **actively contradicts them**, classifying `meltwater` and `pandora` as `ASIA` where the other two say `UK`. Since the result selects the phone and address, the same employer gets different PII depending on which script runs — a live data-corruption bug. With rules as a parameter the same command serves tax-form selection, locale routing, or per-tenant config. |
| `localstorage` | `[key] [value]` | 12 direct `localStorage` accesses across the corpus. Note `live.js:100` writes `__sb_agent_id` via `addInitScript` **and** `stampAgentMarker` so an agent tab can be rediscovered after its creating process exits — that persistence contract has no command. |
| `inject` | `<file>` | `stealth.js` and `overlay.js` are only ever installed through `context.addInitScript` at startup (`vnc-driver.js:118-119, 149-150`). There is no way to inject a script into the **already-running** live browser, which is what you need when iterating on a new init script. |
| `toggle` | `<css> [state]` | Radio/toggle state is read inline everywhere via `aria-checked` / `:checked` queries (`gumroad-create.js:226-234` toggles a `button[aria-checked]` by calling its `__reactProps.onClick`). Reading *and* setting toggle state is a distinct operation from `click`. |
| `poll` | `<expr> --until <json> --times N` | `gumroad-create.js:239-243` documents a genuine race: reading `select.value` in the same tick as `onChange()` still reports the old value because React has not re-rendered. The fix was "change it, then poll for the new value" — a general capability, not a one-off. |
| `profiles` | `list \| set <name> <json> \| show <name>` | A named, persisted set of substitution values (credentials, contact details, locale). The corpus expresses this as inline object literals — `{ loc: 'Thailand', phone: '+66XXXXXXXXX' }` in `bulk1.js:19-21` — repeated per script per region. The generic need is "store a bundle of values once, load it by name, and never paste PII into a script again"; the job-application contents are one instance of it. |

### G7. Site-agnostic primitives

Everything in G1–G6 above was still derived from the scripts that happened to
need it, so some of it carries domain assumptions. The commands below are
deliberately **domain-neutral** — they make no assumption about what is being
scraped, filled, or searched. Several replace duplicated logic that has already
silently diverged between copies.

| PROPOSED | Args | Why it is needed |
| -------- | ---- | ---------------- |
| `host` | `<url>` | URL → `{ host, registrable, scheme, path }`, normalised by stripping `www.` and lowercasing. Written out **7 times across 5 files** — `harvest_ai_platforms.js:190`, `mine_list_pages.js:111,116`, `search_ai_platforms.js:70`, `search_job_sites.js:109`, `search_remote_jobs.js:96`, and once more in `bulk1.js`'s classifier. The one primitive every scraper needs first, and nobody has extracted. |
| `dedupe` | `<jsonArray> --by <field\|host>` | Host-level dedupe for result sets. `harvest_ai_platforms.js` keys `state.platforms` by normalised host and reports "Total unique domains"; `mine_list_pages.js:111` does the same inline. Both exist only to collapse `www.`/trailing-slash duplicates that search engines return. |
| `filter` | `<jsonArray> --drop-host <re> --keep-host <re> --min-len N --has <re>` | A declarative junk filter over scraped rows. **Three** copies of the same idea exist, and they disagree: `search_job_sites.js` skips 32 hosts, `search_remote_jobs.js` skips 30, `harvest_ai_platforms.js` skips 28 — and only 19 of the third list appear in the first. `tiktok` is skipped remotely but kept by `job_sites`; `snagajob`/`thenextweb`/`venturebeat` are the reverse; `ai_platforms` additionally drops `upwork`, `github`, `amazon`. Same intent, three different answers to "what is junk", so two runs over the same query yield different datasets. |
| `search` | `<query> --limit N --engine <e> --timeout ms` | `search.js` exists as a library and is called by 6 scripts, but has **no command**. Every caller re-implements the same surrounding loop: `harvest_ai_platforms.js:171-179` wraps it in `Promise.race` with a 45s timeout, tries all queries in a loop, logs progress, and persists after each one. A first-class `search` command plus `state` (§G4) would collapse that loop entirely. |
| `emit` | `<json> --format csv\|json\|ndjson --file <f> --append` | Result sink. 11 scripts write output with `writeFileSync`, and `applications.csv` / `_triage.csv` / `jobs.json` are all hand-rolled CSVs — `scrapers/_demo.js:10-27` even reimplements an RFC-4180 parser to read them back. Structured output belongs in one place, with a matching reader. |
| `map` | `<jsonArray> --field <f> --expr <js>` | Batch field projection. Nearly every script follows the shape `for (const res of results) { … pick fields … push row }` (`harvest_ai_platforms.js:186+`, `research_shortlist.js`, `triage_sites.js`). A declarative projection removes the loop without removing the control. |
| `paginate` | `<nextSelector> --max N --until-empty` | Repeated traversal. `mine_list_pages.js` pages a listing by walking hosts per page; `jobsearch/scroll_list.js` does the same with scrolling. Both hand-roll "click next, collect, stop when nothing new". |
| `assert` | `<css>` \| `--url-matches <re>` \| `--text-matches <re>` | Pre/post condition. Scripts repeatedly open with "is the right tab open?" and close with "did it actually work?" — `jobsearch/click_apply.js` errors out with "no Indeed search-results tab open", `jobsearch/step_job.js` exits 3 on a Cloudflare challenge, `scripts/indeed-post-all.js:335` marks a job failed unless "Not verified" is false. |
| `guard` | `<name> --requires <cmd> --runs <cmd>` | Precondition + action + postcondition in one call, so a failed step returns a structured result instead of a raw stack trace. The recurring shape across the fill/submit scripts. |
| `schema` | `<name> --define <json>` \| `--validate <json>` | Field validation before writing rows. `research_shortlist.js` and `triage_sites.js` both validate harvested records before persisting; a shared schema store would make the contract explicit and reusable across the CSV/JSON outputs. |
| `diff` | `<a> <b> --by <field\|host>` | Compare two scrapes — how many new hosts appeared since the last run. This is the natural companion to `state` + `dedupe` for incremental harvesting, and no script has it. |

---

## H. Corpus census

A tally of Playwright calls across the 94 root scripts, 13 `scripts/*.js`,
`scrapers/`, and `jobsearch/` — this is the frequency data the priorities in
§G were ranked by.

| Call | Uses |
| ---- | ---- |
| `page.evaluate` | 98 |
| `page.waitForTimeout` | 42 |
| `page.locator` | 34 |
| `page.goto` | 29 |
| `page.url` | 26 |
| `page.title` | 18 |
| `page.fill` | 12 |
| `page.on` | 10 |
| `page.click` | 10 |
| `page.screenshot` | 8 |
| `page.waitForSelector` | 4 |
| `page.getByRole` | 4 |
| `page.content` | 4 |
| `page.setInputFiles` | 3 |
| `page.reload` / `goBack` / `goForward` / `type` / `press` / `pdf` | 2–3 each |
| `page.waitForURL` / `route` / `mainFrame` / `getByText` / `evaluateHandle` / `addInitScript` | 1 each |

**70 of the ~110 scripts open with `chromium.connectOverCDP(...)`.** Two
idioms dominate to the point of being systemic rather than incidental:

- The hard-coded `connectOverCDP` + `pages().find(url.includes(...))` preamble
  → collapsed by `findtab` + `acceptdialogs`.
- `page.evaluate` outnumbers every native Playwright call combined
  (98 vs ~52) → the scripts reimplement DOM work that belongs in commands.

`headless.js` in the repo root is a 16-line stub that launches a bare
Puppeteer browser and discards `url`, `waitUntil` and `timeout`. It is **not**
the toolkit described in `docs/api.md`, which documents a Playwright-based
`launch()` returning `{ context, page, human, close, screenshot }`. Treat
`docs/api.md` as aspirational relative to the current file.

---

## I. Cross-references

| Doc | Covers |
| --- | ------ |
| [`LIVE-DRIVE.md`](LIVE-DRIVE.md) | the live VNC session, `npm run vnc`, resolution flags, standalone CLI usage, troubleshooting |
| [`api.md`](api.md) | the library API (`launch()`, `human`, `screenshot`) |
| [`cli.md`](cli.md) | `scripts/live.js` CLI reference |
| [`search.md`](search.md) | the `search()` multi-engine web search |
| [`stealth.md`](stealth.md) | bot-detection patching in `stealth.js` |
| [`troubleshooting.md`](troubleshooting.md) | failure modes |

Build the HTML docs with `node build-docs.js`.