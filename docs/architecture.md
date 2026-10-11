# Architecture

How the four source files fit together.

## File map

```
                ┌─────────────────────────────────────────────┐
                │              headless.js                    │
                │  (CLI entry, launch(), search(), etc.)      │
                │                                             │
                │   ┌─────────────┐    ┌──────────────────┐  │
                │   │  stealth.js │    │    search.js      │  │
                │   │  (init      │    │  (engine          │  │
                │   │   script)   │    │   registry +      │  │
                │   │             │    │   extractors)     │  │
                │   └─────────────┘    └──────────────────┘  │
                │         │                      │           │
                └─────────┼──────────────────────┼───────────┘
                           ▼                      ▼
                   addInitScript()         search(context, ...)
                           │                      │
                           ▼                      ▼
               ┌─────────────────────────────────────────────┐
               │  Playwright (chromium.launchPersistentContext)│
               │  → real Google Chrome at /usr/bin/google-chrome│
               │  → persistent profile at ./profile/          │
               └─────────────────────────────────────────────┘
                                    │
                                    ▼
                           (a real browser)
```

## `headless.js` — the conductor

- **Entry point** for both the CLI and the library.
- Owns the `launchPersistentContext` call and the configuration of
  the browser (viewport, locale, UA, launch flags).
- **Injects `stealth.js`** as an init script before any page script
  runs.
- Returns a `LaunchResult` containing the page, the context, the
  `human` helper, the `screenshot` helper, and a `close()` function.
- Exposes a high-level `search()` that internally calls
  `launch()` + `SEARCH_MODULE.search()` + `close()`.
- Hosts the CLI argument parser and `--help` text.

It is **the only file that should be `require()`d by external
code**; everything else is implementation detail.

## `stealth.js` — the patches

- A single function: `STEALTH_INIT()`.
- When called inside a page, it patches `Navigator.prototype`,
  `Document.prototype`, `WebGLRenderingContext.prototype`,
  `WebGL2RenderingContext.prototype`, and a few globals
  (`window.chrome`, `navigator.plugins`, etc.).
- Loaded by `headless.js` via `browser.addInitScript(STEALTH_INIT)`,
  which means Playwright injects it as a CDP `Page.addScriptToEvaluateOnNewDocument`
  call. The script runs **before** any user-space JavaScript on every
  page load.
- The function is wrapped in a `try/catch` so a single bad patch
  can't break the whole page (and so it never throws during
  fingerprinting tests).

## `search.js` — the engine registry

- Each engine is a small object with five fields:
  - `name`: short string id.
  - `buildUrl(query, opts)`: returns the search URL.
  - `waitUntil`: Playwright `waitUntil` option.
  - `waitForSelector`: optional CSS selector to wait for.
  - `waitMs`: extra ms to wait after the selector appears.
  - `healthy(page)`: returns false if the page looks blocked.
  - `extract(page)`: returns `[{title, url, snippet}, ...]`.
- `search(context, query, opts)`:
  1. Iterate through the fallback chain.
  2. For each engine, open a new page in the context, navigate,
     wait, check `healthy()`, and `extract()`.
  3. If a non-empty result list comes back, return it.
  4. Otherwise, mark the engine as failed in `tried` and try the
     next one.
- `formatResults(r)`: pretty-printer.
- `ENGINES` and aliases are exported so external code can introspect
  or extend the registry.

## How the screenshot feature is wired

`headless.js` owns the `screenshot()` helper. It's a closure over
the `page` returned by `launch()`. The lifecycle:

```
launch()  ─►  page = ...                  // open
          ─►  lastScreenshotPath = null    // init
          ─►  define screenshot()          // closure
          ─►  if (opts.screenshot)         // auto-screenshot
                 screenshot(opts.screenshotPath, {...})
          ─►  return { ..., screenshot, lastScreenshotPath }
```

`lastScreenshotPath` is a closure variable, exposed via a **getter**
on the return object so the value is always live, even after
destructuring.

## How the humanization feature is wired

`makeHumanizer(page)` is a factory that returns an object with six
methods. Each one wraps a Playwright call with a delay:

| Method | Wraps | Adds |
| ------ | ----- | ---- |
| `wait` | `setTimeout` | random 50-250ms |
| `pause` | `setTimeout` | random 300-900ms |
| `think` | `setTimeout` | random 1.2-2.5s |
| `hover` | `page.mouse.move` | 8-18 sub-steps + 40-180ms dwell |
| `click` | `page.click` | hover + 60-220ms pre-click + 20-80ms click delay |
| `type` | `page.keyboard.type` | 35-140ms per char, 4% chance of 180-420ms between |

The distributions are intentionally **uniform** (not Gaussian) — a
cumulative distribution of uniform delays looks more like a real
human's variable attention than a centered Gaussian would, because
humans have asymmetric "I'll just check this quickly" tails.

## How the search CLI mode is wired

`headless.js`'s CLI parser detects `--search "QUERY"` early and
short-circuits to the search block:

```
argv has --search?  ─►  launch({ url: 'about:blank' })   // no nav
                     ─►  SEARCH_MODULE.search(ctx, query, opts)
                     ─►  console.log(formatResults(r))
                     ─►  if (--search-shot)  navigate + screenshot
                     ─►  close()
                     ─►  return  // skip the URL-opening branch
```

The auto-screenshot for the search mode (`--search-shot`) re-opens
the URL of the engine that succeeded so we can capture the results
page. This means the screenshot is taken **after** extraction
finishes, ensuring the page is fully rendered.

## Data flow for a typical session

```js
const { launch, search } = require('./headless');

await launch({ url, screenshot: true, profileDir: './p' });
//  │
//  │  ┌─ chromium.launchPersistentContext('./p', { ... })
//  │  │     │
//  │  │     ├─ launches /usr/bin/google-chrome with stealth flags
//  │  │     ├─ injects STEALTH_INIT as addInitScript
//  │  │     └─ returns BrowserContext + first Page
//  │  │
//  │  ├─ if (screenshot) { wait; capture; }
//  │  │
//  │  └─ return { page, human, screenshot, close, lastScreenshotPath }
//  │
//  └─► user code: human.type(...); human.click(...); etc.
//  └─► user code: search(ctx, 'query')  → { results, ... }
//  └─► user code: close()
```

## Why three files, not one

- **`stealth.js`** is logically separate because it runs **inside
  the page context** (via `addInitScript`) and is largely
  DOM-typed. Keeping it in its own file makes it easy to
  inspect/audit the patches without scrolling past 600 lines of
  Node.js code.
- **`search.js`** is separate because the engine registry is the
  most likely thing to change (engines come and go, scrapers
  break). Keeping it isolated means you can update just that file
  when an engine's HTML changes.
- **`headless.js`** is the orchestrator. It imports the other two
  and the Playwright API.

If you want to add a fourth engine, add it to `search.js` only.
If you want to add a sixth stealth patch, add it to `stealth.js`
only. If you want to add a new CLI flag, add it to `headless.js`
only.
