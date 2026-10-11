# Troubleshooting

Common problems and their fixes.

---

## "Failed to launch Google Chrome"

```
Error: Failed to launch Google Chrome. Is it installed at /usr/bin/google-chrome?
Original error: browserType.launchPersistentContext: ...
```

**Cause:** Either Google Chrome isn't at `/usr/bin/google-chrome`, or
the executable can't be launched in your environment.

**Fixes:**

1. Check that Chrome exists and is executable:
   ```bash
   ls -la /usr/bin/google-chrome
   google-chrome --version
   ```
2. If it's at a different path, pass it explicitly:
   ```bash
   node headless.js --executablePath=/path/to/chrome https://example.com
   ```
   Or in code:
   ```js
   await launch({ executablePath: '/snap/bin/chromium', ... });
   ```
3. On a headless server (no display), you may need:
   ```bash
   sudo apt-get install -y xvfb
   # Then run with xvfb-run:
   xvfb-run node headless.js https://example.com
   ```
4. As root inside a container, you may also need `--no-sandbox` (it's
   already in the default args, but if you've customized).

---

## "Cannot find module 'playwright'"

**Cause:** The `node_modules/` folder doesn't have Playwright.

**Fixes:**

```bash
# Option 1: install globally
npm install -g playwright

# Option 2: install in the project parent
cd /opt/lampp/htdocs
npm install playwright

# Option 3: install in this folder
cd /opt/lampp/htdocs/ServerBrowser
npm install playwright
```

If you've installed globally and `require('playwright')` still fails,
your NODE_PATH is wrong:

```bash
NODE_PATH=$(npm root -g) node headless.js https://example.com
```

---

## "ECONNREFUSED 127.0.0.1:9222" or "DevTools port not available"

**Cause:** A previous Chrome process didn't clean up its DevTools
port, OR two `headless.js` instances are racing on the same profile.

**Fix:**

```bash
# Find and kill orphaned Chrome processes
pkill -f "google-chrome.*--remote-debugging"

# Or be more targeted:
ps aux | grep -i chrome | grep -v grep
kill <pid>
```

Don't run two `headless.js` instances against the same profile at
the same time. Use different `--profile` paths if you need to
parallelize.

---

## Screenshot is "missing" / "blank" / a half-loaded page

**Cause:** The page didn't have time to render before the screenshot.

**Fixes:**

1. Increase the settle time:
   ```bash
   node headless.js --shot --screenshot-wait=5000 URL
   ```
2. Use a stricter wait condition (the default `networkidle` is the
   safest):
   ```bash
   node headless.js --shot --screenshot-wait-until=networkidle URL
   ```
3. If the page is a single-page app that never reaches
   `networkidle`, use `domcontentloaded` and a long wait:
   ```bash
   node headless.js --shot --screenshot-wait-until=domcontentloaded \
     --screenshot-wait=8000 URL
   ```

---

## Site still flags me as a bot

The stealth layer is best-effort. If a site still flags you:

1. **Check `--check` first** — see [stealth.md](stealth.md) for what
   to look at.
2. **Try `--headed`** — solve a CAPTCHA once; the cookies persist.
3. **Switch profiles** — you may have been rate-limited on this IP
   for this fingerprint combination. A fresh profile starts
   without history.
4. **Add a residential proxy** — outside the scope of this

---

## Cloudflare Turnstile keeps throwing CAPTCHAs (VNC session)

**Cause:** Cloudflare Turnstile detects automation signals even in headed
mode. The most common triggers are `navigator.webdriver = true`,
rapid navigation patterns, or IP reputation.

**Fixes — read the full guide in [stealth.md](stealth.md) § "Cloudflare
Turnstile / CAPTCHA handling".** Quick version:

1. **Verify `navigator.webdriver` is `false`** — this is the #1 signal.
   The `--disable-blink-features=AutomationControlled` Chrome flag
   and the `addInitScript` override in `vnc-driver.js` should handle it.
2. **Slow down** — add 2–5 second delays between actions, 10–20 seconds
   between jobs. Cloudflare tracks navigation frequency.
3. **Implement CAPTCHA detection** — detect "Just a moment..." / "Verify
   you are human" in the page title/text and pause the script for manual
   VNC solve.
4. **Wait 10–15 minutes** — Cloudflare blocks are partially time-based.
5. **Clear cookies and restart**: `rm -rf ./profile/Default/Cookies*`
6. **Fresh profile**: `PROFILE=/tmp/fresh-profile npm run vnc`
7. **Use a residential proxy** if the IP is flagged. project,
   but no browser-level stealth can fix a blacklisted IP.
5. **Slow down** — add longer delays between actions. The `human.*`
   helpers' defaults are reasonable for a single user, but if
   you're making 50 requests/minute, real users don't do that.

---

## Search returns 0 results

**Diagnosis:**

```bash
node headless.js --search "your query" --search-json | jq '.tried'
```

You'll see something like:

```json
[
  { "engine": "duckduckgo-html", "error": "no results parsed" },
  { "engine": "brave",           "error": "no results parsed" },
  { "engine": "searxng",         "error": "page looked blocked" }
]
```

**Common causes and fixes:**

1. **All engines parsed 0 results** — your query is very unusual or
   non-Latin. Try a simpler query first to confirm the engines are
   reachable, then debug your specific query.
2. **SearXNG instance is dead** — public SearXNG instances come and
   go. Use `--searxng-instance=https://searx.be` (or another
   from <https://searx.space>).
3. **The CAPTCHA loop on DuckDuckGo** — if your IP has been hitting
   DDG aggressively, you may be seeing a captcha (which our
   `healthy()` check correctly flags as "page looked blocked").
   Wait a few hours or switch to `--search-engine=brave`.
4. **Network restriction** — your firewall or container is
   blocking one or more of the engine hosts. Check with:
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://html.duckduckgo.com/html/?q=test
   curl -s -o /dev/null -w "%{http_code}\n" https://search.brave.com/search?q=test
   ```

---

## Persistent profile is huge (>1 GB)

**Cause:** Chrome accumulates cache, history, and other state
indefinitely. Over months of heavy use, the profile can grow.

**Fixes:**

1. Just delete the profile and start over. You lose all logged-in
   sessions, but everything rebuilds on next run.
   ```bash
   rm -rf /opt/lampp/htdocs/ServerBrowser/profile/
   ```
2. Use separate profiles per project so each one stays small:
   ```bash
   node headless.js --profile=./profiles/work URL
   ```
3. Use a cron job to clean caches while keeping cookies:
   ```bash
   find /opt/lampp/htdocs/ServerBrowser/profile/Default/Cache -type f -delete
   find /opt/lampp/htdocs/ServerBrowser/profile/Default/Code\ Cache -type f -delete
   ```
   (Don't touch `Cookies`, `Local Storage`, `IndexedDB`, or
   `Preferences` — those are your session.)

---

## "Cannot read property of undefined" inside the stealth script

**Cause:** One of the stealth patches is failing on a page that
shapes its globals unusually.

**Fixes:**

1. The patches are wrapped in a top-level `try/catch` so a failure
   shouldn't crash anything. If you see this error from *outside*
   the stealth script, it's not us.
2. To debug, comment out patches one at a time in `stealth.js` (the
   sections are clearly numbered `// ---- N. <signal> ----`) and
   see which one is the offender.
3. Report the failure to the project with the URL of the offending
   page and the stack trace.

---

## Process won't exit after the script "finishes"

**Cause:** A timer, a CDP session, or a long-running `human.*`
promise is still alive.

**Fixes:**

1. Make sure you call `close()` at the end of your script:
   ```js
   const { close } = await launch(...);
   // ... do stuff ...
   await close();
   ```
2. If you've been using `--keep-open` and exited with Ctrl+C in
   the middle, the Chrome process may be orphaned. Kill it:
   ```bash
   pkill -f "google-chrome"
   ```
3. As a last resort, force exit at the end of your script:
   ```js
   await close();
   process.exit(0);
   ```

---

## Screenshot says "saved 0 bytes"

**Cause:** Playwright tried to write a screenshot but the page
crashed or the buffer is empty.

**Fixes:**

1. Open the page first and check for console errors:
   ```js
   const { page, close } = await launch({ url });
   page.on('pageerror', e => console.error('Page error:', e));
   await page.waitForTimeout(2000);
   await screenshot('foo.png');
   await close();
   ```
2. Try a different `waitUntil`:
   ```bash
   --screenshot-wait-until=load
   ```
3. The page may have a long-running request that never resolves;
   try `--screenshot-wait=100` (a tiny manual wait) to capture
   whatever is on screen.

---

## "permission denied" when launching Chrome

**Cause:** Running as a non-root user that can't write to the
profile dir, or the profile is owned by another user.

**Fixes:**

```bash
# Take ownership
sudo chown -R $(whoami) /opt/lampp/htdocs/ServerBrowser/profile/

# Or pick a profile you can write to
node headless.js --profile=$HOME/.browser-profile-me URL
```

---

## Page says "Please enable JavaScript"

**Cause:** Either JavaScript is disabled (it isn't, by default) or
the site's bot detection thinks the user-agent is wrong.

**Fixes:**

1. Check the UA:
   ```bash
   node headless.js --check https://example.com | grep userAgent
   ```
   It should be a real Chrome 140 UA. If it's something like
   `HeadlessChrome/140...`, your stealth init script isn't loading.
2. Confirm `addInitScript` is being called (it is, in `headless.js`
   line ~135) and that the `stealth.js` module loads without
   throwing.

---

## Search engine returns the same captcha page every time

**Cause:** Your IP is on a captcha list for that engine. The
fallback chain is supposed to handle this, but if ALL three engines
captcha you, you need to:

1. Wait a few hours and try again.
2. Use a different network (mobile hotspot, residential proxy, VPN).
3. Use a different machine.

This is a network-level block; the stealth layer can't help here.

---

## Still stuck?

1. Run with `--headed` and watch what the browser does.
2. Use Chrome DevTools (right-click → Inspect) while the page is
   open to see the JS console.
3. Look at `PLAYWRIGHT--script.log` (in the parent `/opt/lampp/htdocs`
   folder — your other Playwright scripts write there).
4. Check the `tried` field in a search response — it tells you
   exactly which engines failed and why.
