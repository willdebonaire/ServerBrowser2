# Library API

Every feature is exposed as a JavaScript function. The CLI is just a
thin wrapper over these.

```js
const {
  launch,           // async function: opens a stealth headless Chrome
  makeHumanizer,    // (advanced) build a humanizer for an arbitrary page
  search,           // async function: one-shot web search
  screenshot,       // (returned by launch; not exported standalone)
  formatResults,    // (re-exported from search.js) pretty-print results
  ENGINES,          // registry of search engines
  ENGINE_ALIASES,   // ['duckduckgo-html', 'ddg', 'brave', 'searxng']
  DEFAULT_ENGINE,   // 'duckduckgo-html'
  FALLBACK_CHAIN,   // ['duckduckgo-html', 'brave', 'searxng']
  REAL_UA,          // the User-Agent the browser presents
  DEFAULT_PROFILE,  // default profile dir (./profile)
} = require('./headless');
```

---

## `launch(opts)` → `Promise<LaunchResult>`

Launch a persistent stealth context. The returned object gives you
the page, the context, helpers, and a `close()` function.

### Signature

```js
const result = await launch({
  url:                  'https://example.com',   // optional: auto-navigate
  profileDir:           './profile',             // optional, default
  headless:             true,                    // default
  noHeadless:           false,                   // mutually exclusive
  keepOpen:             false,                   // don't auto-close
  viewport:             { width: 1920, height: 1080 },
  locale:               'en-US',
  timezoneId:           'America/New_York',
  geolocation:          { latitude: 40.7, longitude: -74.0 },
  userAgent:            REAL_UA,                 // override
  executablePath:       '/usr/bin/google-chrome',

  // Auto-screenshot (taken once, after the URL settles):
  screenshot:           false,
  screenshotPath:       './screenshots/foo.png',  // optional
  screenshotFullPage:   false,
  screenshotFormat:     'png',                    // 'png' | 'jpeg'
  screenshotQuality:    80,                       // jpeg only
  screenshotWaitUntil:  'networkidle',
  screenshotWait:       1500,
});

result = {
  context,                 // the BrowserContext (= the persistent profile)
  page,                    // the default Page
  browser,                 // same as context (alias)
  human,                   // { wait, pause, think, hover, click, type }
  close,                   // () => Promise<void>: shut down the browser
  screenshot,              // (filePath?, opts?) => Promise<string>: capture
  lastScreenshotPath,      // getter: most recent file written
};
```

### Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `url` | `string` | — | If set, the page auto-navigates to this URL on launch. |
| `profileDir` | `string` | `./profile/` | Path to the persistent Chrome user-data dir. Created if missing. |
| `headless` | `boolean` | `true` | `false` opens a real Chrome window. Mutually exclusive with `noHeadless`. |
| `noHeadless` | `boolean` | `false` | Convenience alias for `headless: false`. |
| `keepOpen` | `boolean` | `false` | If `true`, `launch()` resolves with the browser still running. You must call `close()` yourself. |
| `viewport` | `{width, height}` | `{1920, 1080}` | CSS pixel viewport. |
| `locale` | `string` | `'en-US'` | Locale for `Accept-Language`, `navigator.language`, etc. |
| `timezoneId` | `string` | `'America/New_York'` | IANA timezone id (e.g. `'Europe/London'`). |
| `geolocation` | `{latitude, longitude}` | — | If set, the browser reports this position. Also grant `geolocation` permission. |
| `userAgent` | `string` | `REAL_UA` | Override the User-Agent. Default is a real Chrome 140 UA matching the installed version. |
| `executablePath` | `string` | `/usr/bin/google-chrome` | Override the Chrome binary path. |

#### Screenshot options (auto-screenshot on launch)

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `screenshot` | `boolean` | `false` | Take a screenshot of the initial URL once it settles. |
| `screenshotPath` | `string` | auto-named | Absolute or relative output path. Format inferred from extension. |
| `screenshotFullPage` | `boolean` | `false` | Full scrollable page, not just viewport. |
| `screenshotFormat` | `'png' \| 'jpeg'` | `'png'` | Image format. |
| `screenshotQuality` | `number` | `80` | JPEG quality 0-100 (ignored for PNG). |
| `screenshotWaitUntil` | `string` | `'networkidle'` | Wait condition before capture: `load`, `domcontentloaded`, `networkidle`. |
| `screenshotWait` | `number` | `1500` | Extra ms to wait AFTER the wait condition resolves. Use to let lazy content settle. |

### Return value

```ts
type LaunchResult = {
  context: import('playwright').BrowserContext;
  page:    import('playwright').Page;
  browser: import('playwright').BrowserContext;  // alias
  human:   {
    wait:  (ms?: number) => Promise<void>;
    pause: () => Promise<void>;
    think: () => Promise<void>;
    hover: (selector: string) => Promise<void>;
    click: (selector: string, opts?: object) => Promise<void>;
    type:  (selector: string, text: string) => Promise<void>;
  };
  close:                  () => Promise<void>;
  screenshot:             (target?: string | object, overrides?: object) => Promise<string>;
  lastScreenshotPath:     string | null;  // live getter
};
```

### Example

```js
const { launch } = require('./headless');

const { page, human, screenshot, close } = await launch({
  url: 'https://example.com/login',
  profileDir: './profiles/me',
  viewport: { width: 1280, height: 800 },
  timezoneId: 'Europe/London',
  geolocation: { latitude: 51.5, longitude: -0.12 },
});

await human.type('input[name=email]',    'me@example.com');
await human.think();
await human.type('input[name=password]', 'hunter2');
await human.pause();
await human.click('button[type=submit]');
await page.waitForLoadState('networkidle');

const out = await screenshot('logged-in.png', { fullPage: true });
console.log('Saved screenshot to', out);

await close();
```

---

## `screenshot(filePath?, opts?)` → `Promise<string>`

Ad-hoc screenshot. Bound to a specific page by the `launch()` result.

### Signatures

```js
// 1. Auto-name under ./screenshots/, defaults
const p1 = await screenshot();

// 2. Explicit path; format inferred from extension
const p2 = await screenshot('foo.png');
const p3 = await screenshot('bar.jpg');

// 3. Options object (any Playwright screenshot options)
const p4 = await screenshot({ path: 'baz.png', fullPage: true, type: 'png' });
const p5 = await screenshot({ path: 'ele.png', element: page.locator('header img') });

// 4. Path + overrides
const p6 = await screenshot('zoom.png', { clip: { x: 0, y: 0, width: 800, height: 200 } });
```

### Options

All [Playwright `page.screenshot` options](https://playwright.dev/docs/api/class-page#page-screenshot)
are supported (`path`, `type`, `quality`, `fullPage`, `clip`,
`element`, `omitBackground`, `caret`, `animations`, `mask`, etc.).
The helper:

- Resolves the path to an absolute path under `./screenshots/` if no
  path is given.
- Creates parent directories as needed.
- Infers `type` from the file extension if you don't specify it.
- Strips `quality` for PNG (Playwright throws on PNG+quality).
- Returns the **absolute path** of the file written.
- Updates the `lastScreenshotPath` getter on the launch result.

See [screenshots.md](screenshots.md) for the conceptual overview.

---

## `human.*` — humanization helpers

Returned by `launch()` as `result.human`. All methods add realistic
delays and mouse movement so a watching site can't tell that the
actions came from a script.

| Method | Purpose | Delay pattern |
| ------ | ------- | ------------- |
| `human.wait(ms?)` | Sleep. If `ms` is omitted, random 50-250ms. | uniform |
| `human.pause()` | Like reading text. | 300-900ms uniform |
| `human.think()` | Like thinking. | 1.2-2.5s uniform |
| `human.hover(sel)` | Move mouse to selector with 8-18 sub-steps. | 40-180ms hover dwell |
| `human.click(sel, opts?)` | Hover, dwell, then click. | 60-220ms prepre-click + 20-80ms click delay |
| `human.type(sel, text)` | Focus, then type each char. | 35-140ms per char, 4% chance of 180-420ms pause between chars |

### Example

```js
const { launch } = require('./headless');
const { human, page } = await launch({ url: 'https://example.com/login' });

await human.wait(1500);
await human.type('input[name=email]',    'me@example.com');
await human.think();
await human.type('input[name=password]', 'hunter2');
await human.pause();
await human.click('button[type=submit]');
await page.waitForLoadState('networkidle');
```

See [architecture.md](architecture.md) for the rationale behind the
delay distributions.

---

## `search(query, opts?)` → `Promise<SearchResponse>`

The one-shot search helper. Opens a context, runs the query through
the fallback chain, and closes the context.

### Signature

```js
const { search, formatResults } = require('./headless');

const r = await search('node js tutorial', {
  engine:           'duckduckgo-html',  // primary
  fallback:         ['brave', 'searxng'],  // chain (default = all 3)
  limit:            10,
  searxngInstance:  'https://searx.be',
  throwOnFail:      false,
});

r = {
  query:   'node js tutorial',
  engine:  'duckduckgo-html',  // which engine actually returned
  results: [
    { title, url, snippet, position, engine },  // 0..limit-1
    ...
  ],
  tried: [
    'duckduckgo-html',  // OR { engine: 'brave', error: 'page looked blocked' }
    ...
  ],
}
```

### Options

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `engine` | `string` | `'duckduckgo-html'` | Which engine to try first. One of the keys in `ENGINES` (or `ENGINE_ALIASES`). |
| `fallback` | `string[]` | `['duckduckgo-html', 'brave', 'searxng']` | Engines to try in order, after the primary. |
| `limit` | `number` | `10` | Maximum results to return. |
| `searxngInstance` | `string` | `https://paulgo.io` | Override the SearXNG instance. |
| `throwOnFail` | `boolean` | `false` | If `true`, throw an `Error` when all engines fail. Otherwise return an empty `results` array. |
| `profileDir` | `string` | default | Profile to use for the one-shot context. |

### Result shape

```ts
type SearchResult = {
  title:    string;
  url:      string;
  snippet?: string;
  engine:   string;    // which engine returned this
  position: number;    // 1-based
};

type SearchResponse = {
  query:   string;
  engine:  string | null;     // which engine actually returned
  results: SearchResult[];
  tried:   Array<string | { engine: string; error: string }>;
};
```

### Examples

```js
// Quick one-shot
const r = await search('playwright tutorial', { limit: 5 });
console.log(r.results.map(x => x.title));

// Pretty-print
console.log(formatResults(r));

// Force a specific engine
const brave = await search('rust async', { engine: 'brave' });

// Manual context (so you can chain searches sharing cookies)
const { launch } = require('./headless');
const { context, close } = await launch({ profileDir: './profiles/me' });
try {
  const r1 = await contextSearch(context, 'first query');
  const r2 = await contextSearch(context, 'second query');
} finally {
  await close();
}

// (Where `contextSearch` is just `require('./search').search`)
```

See [search.md](search.md) for the full per-engine details.

---

## `formatResults(r, opts?)` → `string`

Pretty-print a `SearchResponse` to a string. Useful for CLI output
and logging.

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `showUrl` | `boolean` | `true` | Include the URL of each result. |
| `showSnippet` | `boolean` | `true` | Include the snippet of each result. |

Example output:

```
Search: playwright tutorial  (engine: duckduckgo-html, 5 results)
  1. Playwright Python Tutorial
     https://www.browserstack.com/guide/playwright-python
     Learn how to use Playwright with Python...
  2. ...
```

---

## `makeHumanizer(page)` → `Humanizer`

For advanced use only: if you have a `Page` from some other source
(e.g. you've opened a second page in the same context), you can build
a humanizer for it directly:

```js
const { launch, makeHumanizer } = require('./headless');
const { context, close } = await launch();
const page = await context.newPage();
const human = makeHumanizer(page);
await human.type('input[name=q]', 'playwright');
await page.close();
await close();
```

---

## Constants

| Export | Value | Description |
| ------ | ----- | ----------- |
| `REAL_UA` | `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0.0 Safari/537.36` | The User-Agent the browser presents. Update `CHROME_VERSION` in `headless.js` when you upgrade Chrome. |
| `DEFAULT_PROFILE` | `<this folder>/profile` | The default `profileDir` for `launch()` and `search()`. |
| `DEFAULT_ENGINE` | `'duckduckgo-html'` | Default primary search engine. |
| `FALLBACK_CHAIN` | `['duckduckgo-html', 'brave', 'searxng']` | Default search fallback order. |
| `ENGINES` | `{ 'duckduckgo-html': {...}, 'brave': {...}, 'searxng': {...} }` | Registry of search engines. Each has `name`, `buildUrl()`, `extract()`, `healthy()`, `waitUntil`, `waitForSelector`, `waitMs`. |
| `ENGINE_ALIASES` | `['duckduckgo-html', 'ddg', 'brave', 'searxng']` | Valid engine names for `opts.engine`. |
