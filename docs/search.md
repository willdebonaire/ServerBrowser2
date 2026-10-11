# Web search

The `search()` helper runs a web search through one of three
**bot-friendly** engines, with a built-in **fallback chain** so a
single engine being down (or starting to block you) doesn't break
your workflow.

## Engines

| Engine name        | Endpoint                                       | Why it works |
| ------------------ | ---------------------------------------------- | ------------ |
| `duckduckgo-html`  | `https://html.duckduckgo.com/html/?q=…`        | The **primary** choice. This is DDG's purpose-built endpoint for bots and tools — it doesn't run JavaScript, doesn't throw a captcha, and returns clean HTML. Most `ddgr`-style CLI tools use it. |
| `brave`            | `https://search.brave.com/search?q=…`          | **Fallback 1.** Modern, no captcha for our fingerprint. |
| `searxng`          | `<instance>/search?q=…&format=html`            | **Fallback 2.** Open-source metasearch. You can run your own instance or use a public one. The default public instance is `https://paulgo.io` but you should swap this for a more reliable one (e.g. `https://searx.be`). |

Aliases:

- `ddg` is an alias for `duckduckgo-html`.

### Why not Google?

Google reliably throws a captcha on the first suspicious request and
on every subsequent request from the same fingerprint. Even with the
stealth layer, success rates are < 30% per request. Not worth
shipping.

### Why not Bing?

Bing *does* work for some users, but is also captcha-prone and the
DOM is heavy. We didn't pick it as a default.

### Why not Startpage?

Startpage is JS-heavy and has its own bot detection. The DOM
extractor we tried returned 0 results consistently. Excluded.

### Why not Yandex?

Yandex works but English-language results are inconsistent and the
captcha risk is non-trivial. Excluded.

## Default behavior

```js
const { search } = require('./headless');
const r = await search('node js tutorial');
```

- Tries `duckduckgo-html` first.
- If that returns zero results (or errors), tries `brave`.
- If that also fails, tries `searxng`.
- If all three fail, returns `{ query, engine: null, results: [], tried: [...] }`
  with diagnostic info in `tried`.
- The first engine to return at least one result wins.

You can override the chain:

```js
const r = await search('rust async', {
  engine:   'brave',                  // primary
  fallback: ['duckduckgo-html'],      // what to try if brave fails
});
```

## CLI quick reference

```bash
# Default (DDG, 10 results)
node headless.js --search "playwright tutorial"

# Limit to 5
node headless.js --search "playwright tutorial" --search-limit 5

# Use Brave explicitly
node headless.js --search "rust async" --search-engine=brave

# Use a custom SearXNG instance
node headless.js --search "privacy news" \
  --search-engine=searxng \
  --searxng-instance=https://searx.be

# JSON output (pipe into jq)
node headless.js --search "node streams" --search-json | jq '.results[].url'

# Screenshot of the results page
node headless.js --search "hello world" --search-shot
```

## Library quick reference

```js
const { search, launch, formatResults, ENGINES } = require('./headless');

// 1. One-shot (opens + closes a context for you)
const r = await search('node js tutorial', { limit: 5 });
console.log(formatResults(r));

// 2. With a long-lived context (share cookies across searches)
const { context, close } = await launch({ profileDir: './profiles/me' });
try {
  // Use the lower-level search() that takes a context:
  const { search: ctxSearch } = require('./search');
  const r1 = await ctxSearch(context, 'first query');
  const r2 = await ctxSearch(context, 'second query');
} finally {
  await close();
}
```

## Result shape

```ts
type SearchResult = {
  title:    string;      // result headline
  url:      string;      // canonical, un-rewritten URL
  snippet?: string;      // short description (may be empty)
  engine:   string;      // which engine returned this
  position: number;      // 1-based
};

type SearchResponse = {
  query:   string;
  engine:  string | null;            // which engine actually succeeded
  results: SearchResult[];
  tried:   Array<
    | string                           // engine name (success)
    | { engine: string; error: string }  // engine that failed
  >;
};
```

`formatResults(r)` pretty-prints this to a string for CLI use:

```
Search: node js tutorial  (engine: duckduckgo-html, 5 results)
  1. Tutorial | Node.js
     https://nodejs.org/en/learn/getting-started/introduction-to-nodejs
     ...
  2. ...
```

## How each engine is queried

For each engine the `search.js` module knows how to:

- **Build the URL** with the query.
- **Pick a wait condition** (`domcontentloaded` is enough for the
  HTML endpoint; `networkidle` for the JS-heavy ones).
- **Wait for a result-specific selector** so the parser doesn't run
  before the page has results.
- **Decide if the page looks blocked** (specific phrases like "Just
  a moment", Cloudflare challenge elements, or zero results).
- **Extract a `{title, url, snippet}` triple per result**, unwrapping
  redirects (e.g. DDG's `?uddg=` wrapping) and filtering out the
  engine's own UI links.

## Picking a SearXNG instance

SearXNG is open-source and anyone can run an instance. Public
instances are listed at <https://searx.space> (the tracker that tells
you which instances are alive and not blocked).

A few reliable public ones (check the tracker for current status):

- `https://searx.be`
- `https://search.bus-hit.me`
- `https://searx.tiekoetter.com`

You can also run your own — it's a single Docker container.

The CLI sets the default to `https://paulgo.io`, but you should
override with `--searxng-instance=...` for reliability.

## The `tried` field

`r.tried` is a diagnostic. If everything worked, it's just
`['duckduckgo-html']` (or whichever engine succeeded). If something
failed, the failed entries are objects with an `error` string:

```js
{
  tried: [
    { engine: 'duckduckgo-html', error: 'page looked blocked' },
    { engine: 'brave',           error: 'no results parsed' },
    'searxng',   // ← this one succeeded
  ]
}
```

Use this to debug "search returned nothing" cases. The error strings
are short and human-readable.

## When all engines fail

By default, the helper returns an empty `results` array and the
`tried` field tells you why each engine failed. If you'd rather get
an exception:

```js
const r = await search('query', { throwOnFail: true });
// throws: Error: All search engines failed for query "query": [...]
```

## Performance

A single search takes ~2-3 seconds (mostly waiting for the page
settle). The engines are tried **sequentially** in fallback order,
so a search that needs all three fallbacks takes ~6-9 seconds. If
you need to do many searches in parallel, launch multiple
`launch()` contexts.

## Limitations

- **English-language queries** work best on all three engines.
- **Non-Latin scripts** (Chinese, Arabic, etc.) work but the
  snippets are sometimes empty for the HTML endpoint.
- **Time-sensitive queries** ("weather today") may return slightly
  older results than the engine's web UI because we're hitting
  the simplified endpoints.
- **No image / video / news search**. Only the main web-result
  list. (Easy to extend if you need it; each engine's HTML output
  has separate tabs.)
