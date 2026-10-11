# `ext` — agent-facing add-on commands

Implements the 35 commands specified in [`../../docs/COMMANDS.md`](../../docs/COMMANDS.md)
§G, the set the run scripts had to reimplement by hand.

## Add-on by construction

Nothing in the existing codebase was modified, imported, or patched:

- This is a **separate CLI**. It does not register itself into
  `standalone/index.js`'s `COMMANDS` map.
- It **calls** `scripts/live.js` through its documented verbs (`tabs`,
  `tab`, `eval`, `goto`, `text`, `title`, `wait`, …) and nothing else.
- It reads `search.js` and `live-run.js` by path only, at call time.
- `rm -rf standalone/ext` removes the entire feature and changes no
  existing behaviour.

## Usage

```bash
node standalone/ext/index.js help          # full command list
node standalone/ext/index.js commands      # JSON list
node standalone/ext/index.js <cmd> --help  # usage for one command
```

Every call prints exactly one JSON object:

```json
{ "ok": true,  "cmd": "dedupe", "result": { … } }
{ "ok": false, "cmd": "filter", "error": "…" }
```

with a non-zero exit code on failure, so it composes in shell `&&` chains.

## Flags

`--flag value`, `--flag=value`, `--bool`, `--no-bool`, and a bare `--`
terminator — the same syntax `ai chat` already accepted. Arrays accept
inline JSON or `@path`/`path` to a `.json` file.

## Domain neutrality

**No command hardcodes a site, region, or form-field vocabulary.** Region
names, field labels, cookie-banner wording and junk-host lists are all
passed in as `--rules` / `--json`. The corpus's job-application schema
becomes a rules file; its region classifier becomes `classify --rules`.
That is what keeps these commands usable off the domain that motivated them.

## Two families

**Data commands** (11) are pure JSON and need no browser: `host`,
`dedupe`, `filter`, `map`, `diff`, `emit`, `schema`, `classify`,
`profiles`, `state`, `path`.

**Page commands** (24) drive the live browser through `live.js`:
`findtab`, `waitforclear`, `waitfortext`, `settle`, `setvalue`,
`fillmap`, `clicktext`, `click`, `clickpoint`, `errors`, `scrollto`,
`find`, `localstorage`, `inject`, `toggle`, `dismiss`, `sniff`,
`assert`, `guard`, `retry`, `paginate`, `run`, `runext`, `upload`.

## Two known limitations, reported honestly

`clickpoint` and `upload` **return `ok:false` with `unsupported: true`**
rather than pretending to work. Both need raw CDP —
`Input.dispatchMouseEvent` and `DOM.setFileInputFiles` respectively —
which `live.js` does not expose. Silently degrading to `el.click()` would
be worse than failing, because a DOM click does not open native menus or
file choosers, and the failure looks like success.

## Storage

`~/.config/serverbrowser/ext.json` — directory `0700`, file `0600`,
matching `api-keys.json`. Override with `SERVERBROWSER_STORE`. `profiles`
values are **masked unless `--reveal`** is passed, again matching
`api-keys.js`.

## `setvalue` needs three modes

`browser fill` writes `.value` without the native setter, so React never
observes the change and the field resets on submit. Three mechanisms exist
and they are **not** interchangeable (see COMMANDS.md §G1.1):

| `--mode` | Mechanism | Fails when |
| -------- | --------- | ---------- |
| `native` | prototype setter + `input`/`change` events | fully controlled form: DOM and cached React props look right, but React still submits empty state — a **silent** failure |
| `handler` | call `onChange` via `__reactProps` | element is not React |
| `select` | plain assignment | never, for `<select>` |

`--mode auto` (default) inspects the element, picks a strategy, then
**verifies** the read-back and reports it, because the `native` failure
mode is precisely the silent one.