# Quickstart (5-minute tour)

The fastest way to see what `ServerBrowser/` can do.

## 1. Open a URL

```bash
node headless.js https://example.com
```

Output:
```
Opened: https://example.com/
Title:  Example Domain
Profile dir: /opt/lampp/htdocs/ServerBrowser/profile
```

This launches real headless Chrome 140, navigates to the URL, prints
the title, and exits. The persistent profile under `./profile/` is
saved for next time.

## 2. Open + screenshot

```bash
node headless.js --shot https://example.com
```

Output:
```
[screenshot] saved 98953 bytes -> /opt/lampp/htdocs/ServerBrowser/screenshots/screenshot-2026-07-20_15-00-30.png
Opened: https://example.com/
Title:  Example Domain
Profile dir: /opt/lampp/htdocs/ServerBrowser/profile
Screenshot: /opt/lampp/htdocs/ServerBrowser/screenshots/screenshot-2026-07-20_15-00-30.png
```

The screenshot is auto-named under `./screenshots/` with a timestamp.

For a specific path:

```bash
node headless.js --shot=foo.png https://example.com
```

For the **full** scrollable page (not just the viewport):

```bash
node headless.js --shot --full-page https://example.com
```

See [screenshots.md](screenshots.md) for the full reference.

## 3. Search the web

```bash
node headless.js --search "playwright tutorial" --search-limit 5
```

Output:
```
Search: playwright tutorial  (engine: duckduckgo-html, 5 results)
  1. Playwright Python Tutorial | BrowserStack
     https://www.browserstack.com/guide/playwright-python
     ...
  2. Getting Started | Playwright Python
     https://playwright.dev/python/docs/intro
     ...
  ...
```

This uses the **DuckDuckGo HTML** endpoint under the hood (which is
purpose-built for bots and never throws a captcha). If that ever
fails, it automatically falls back to **Brave Search** and then to
**SearXNG**.

See [search.md](search.md) for the full reference.

## 4. Run a fingerprint check

```bash
node headless.js --check https://bot.sannysoft.com
```

Output (formatted as JSON):
```json
{
  "userAgent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0.0 Safari/537.36",
  "webdriver": undefined,
  "languages": ["en-US", "en"],
  "language": "en-US",
  "plugins": 6,
  "mimeTypes": 4,
  "hasChrome": true,
  "hasChromeRuntime": true,
  "hasChromeCSI": true,
  "hasChromeLoadTimes": true,
  "hardwareConcurrency": 4,
  "deviceMemory": 8,
  "webglVendor": "Intel Inc.",
  "webglRenderer": "Intel Iris OpenGL Engine",
  ...
}
```

The fact that `webdriver` is missing (== `undefined`) is the whole
point: the headless browser doesn't reveal that it's automated.

See [stealth.md](stealth.md) for the full breakdown of what the
stealth layer patches and how to test it.

## 5. Use it as a library

```js
const { launch, search, screenshot } = require('./headless');

(async () => {
  // 1. Launch a stealth headless Chrome
  const { page, human, close } = await launch({
    url: 'https://example.com/login',
    screenshot: true,                  // auto-screenshot the page on load
  });

  // 2. Type into a form like a human
  await human.type('input[name=email]',    'me@example.com');
  await human.think();
  await human.type('input[name=password]', 'hunter2');
  await human.click('button[type=submit]');
  await page.waitForLoadState('networkidle');

  // 3. Take a screenshot of the result
  await screenshot('logged-in.png', { fullPage: true });

  // 4. Run a web search in the same session (cookies / profile shared)
  const r = await search('node js', { limit: 3 });
  console.log(r.results);

  await close();
})();
```

## 6. Headed mode (visible window)

If you want to **see** the browser, for debugging or to solve a
CAPTCHA manually:

```bash
node headless.js --headed https://example.com
```

This opens a real Chrome window with the stealth patches still
applied. Cookies you log in with persist into the profile, so the
next headless run finds you logged in.

## 7. Custom profile per project

If you have several independent "identities" (e.g. one per account
you're managing), use a different profile per identity:

```bash
node headless.js --profile=./profiles/work    https://work-app.com
node headless.js --profile=./profiles/personal https://other-app.com
```

The profile dir is just a normal Chrome user-data directory, so you
can inspect it with `ls profile/Default/Cookies` (it's a SQLite DB).

---

## Next steps

- Full **CLI reference** — [cli.md](cli.md)
- Full **library API** — [api.md](api.md)
- **How the stealth layer works** — [stealth.md](stealth.md)
- **Web search** — [search.md](search.md)
- **Screenshots** — [screenshots.md](screenshots.md)
- **Persistence model** — [persistence.md](persistence.md)
