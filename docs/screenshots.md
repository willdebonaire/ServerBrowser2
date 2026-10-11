# Screenshots

There are two ways to take a screenshot:

1. **Auto-screenshot** — taken once, right after the page settles,
   when you pass `screenshot: true` (or `--shot`) to `launch()`.
2. **Ad-hoc screenshot** — taken at any time during the session via
   the `screenshot(filePath?, opts?)` helper returned by `launch()`.

Both paths write to disk and return the **absolute path** of the
file. Both paths update the `lastScreenshotPath` getter on the
launch result.

## Auto-screenshot (CLI)

```bash
# Auto-named under ./screenshots/screenshot-<timestamp>.png
node headless.js --shot https://example.com

# Explicit path
node headless.js --shot=foo.png https://example.com

# Full scrollable page, not just the viewport
node headless.js --shot --full-page https://example.com

# JPEG with quality 70
node headless.js --shot=pic.jpg --screenshot-format=jpeg --screenshot-quality=70 https://example.com

# Wait 3 seconds before snapping (so lazy content settles)
node headless.js --shot --screenshot-wait=3000 https://example.com
```

## Auto-screenshot (library)

```js
const { launch } = require('./headless');

const { lastScreenshotPath, close } = await launch({
  url: 'https://example.com',
  screenshot: true,                  // turn it on
  screenshotPath: 'home.png',        // optional
  screenshotFullPage: true,          // optional
  screenshotFormat: 'png',           // 'png' or 'jpeg'
  screenshotQuality: 80,             // jpeg only
  screenshotWait: 2000,              // extra settle time
  screenshotWaitUntil: 'networkidle',
});

console.log('saved to', lastScreenshotPath);
await close();
```

### Lifecycle

1. `launch()` navigates to `url` and resolves the context/page.
2. The helper waits for `screenshotWaitUntil` (default `networkidle`)
   with a 30s timeout. (If the page never settles, it falls through
   anyway — a half-loaded page is better than no screenshot.)
3. The helper waits an additional `screenshotWait` ms (default 1500).
4. The screenshot is captured and saved.
5. If anything fails, an error is logged to stderr but `launch()`
   still resolves with a working browser.

## Ad-hoc screenshot (library)

```js
const { launch } = require('./headless');
const { page, screenshot, close } = await launch({ url: 'https://example.com' });

// 1. Bare call — auto-name under ./screenshots/
const p1 = await screenshot();

// 2. Explicit path, infer format from extension
const p2 = await screenshot('foo.png');

// 3. Options object (full Playwright surface)
const p3 = await screenshot({ path: 'bar.jpg', type: 'jpeg', quality: 60, fullPage: true });

// 4. Path + overrides
const p4 = await screenshot('zoom.png', { clip: { x: 0, y: 0, width: 800, height: 200 } });

// 5. Element screenshot
const p5 = await screenshot('logo.png', { element: page.locator('header img') });

await close();
```

## All supported options

All [Playwright `page.screenshot` options](https://playwright.dev/docs/api/class-page#page-screenshot)
are passed through. The most useful:

| Option | Type | Default | Description |
| ------ | ---- | ------- | ----------- |
| `path` | `string` | auto | Absolute or relative output path. Created if missing. |
| `type` | `'png' \| 'jpeg'` | from extension | Image format. Stripped from the call if you also pass `path`'s extension. |
| `quality` | `number` | `80` | JPEG quality 0-100. **Automatically stripped for PNG** (Playwright throws). |
| `fullPage` | `boolean` | `false` | Capture the entire scrollable page, not just the viewport. |
| `clip` | `{x, y, width, height}` | — | Capture only a sub-region of the page. |
| `element` | `ElementHandle` | — | Screenshot just this element. |
| `omitBackground` | `boolean` | `false` | Make the background transparent. |
| `caret` | `'hide' \| 'initial'` | — | Show or hide the text caret. |
| `animations` | `'allow' \| 'disabled'` | `'allow'` | Whether to run CSS animations. |
| `mask` | `Locator[]` | — | Locators to mask out (draw black boxes). |

## File naming

If you don't pass a path, the helper builds one like:

```
./screenshots/screenshot-2026-07-20_15-00-30.png
./screenshots/screenshot-2026-07-20_15-00-30.jpg   (if format=jpeg)
```

The `./screenshots/` directory is created automatically the first
time you take a screenshot. The `screenshot-` prefix and timestamp
sort lexically, so a directory listing puts them in chronological
order.

## Where the file ends up

| You pass... | File ends up at... |
| ----------- | ------------------ |
| `screenshot('foo.png')` | `<cwd>/foo.png` (relative to where you ran the script) |
| `screenshot('/abs/foo.png')` | `/abs/foo.png` (absolute path honored) |
| `screenshot()` | `./screenshots/screenshot-<ts>.<ext>` |
| `screenshot({ path: 'foo.png' })` | `<cwd>/foo.png` |

The returned path is always absolute, regardless of how it was
specified.

## Returned value

The `screenshot()` helper always returns the **absolute path** of
the file written:

```js
const p = await screenshot('foo.png');
// p is something like '/opt/lampp/htdocs/ServerBrowser/foo.png'
console.log('wrote', p, fs.statSync(p).size, 'bytes');
```

It also updates the `lastScreenshotPath` getter on the launch
result:

```js
const { lastScreenshotPath } = await launch({ ... });
await screenshot('a.png');
await screenshot('b.png');
console.log(lastScreenshotPath);   // '.../b.png'
```

The getter means the value is always current, even after
destructuring, as long as you read it through the object (`r.lastScreenshotPath`)
rather than via a destructured local (`const { lastScreenshotPath } = r`).

## Errors

If a screenshot fails:

- The error is **logged** but doesn't throw.
- The `lastScreenshotPath` is **not** updated.
- The browser session continues normally.

This is intentional: in long-running scripts, a failed screenshot
shouldn't take down the whole process.
