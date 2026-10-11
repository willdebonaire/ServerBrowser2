# CLI reference

The CLI entry point is `headless.js`. Run `node headless.js --help` for
the in-tool summary, or read the full reference below.

```
node headless.js [flags] [URL]                          # open URL
node headless.js --search "my query"                    # search the web
node headless.js --search "my query" --search-shot      # search + screenshot
node headless.js --check https://bot.sannysoft.com      # fingerprint check
```

---

## URL modes (mutually exclusive)

The CLI has three top-level modes. Whichever flag appears first in
the command line wins; the others are ignored for the same run.

| Mode        | Trigger                       | What it does                                |
| ----------- | ----------------------------- | ------------------------------------------- |
| Open URL    | `[URL]` on the command line   | Navigates to the URL, prints title.         |
| Search      | `--search "QUERY"`            | Web search via the engine fallback chain.   |
| Fingerprint | `--check URL`                 | Loads URL, runs detection probes, prints JSON. |

Examples:

```bash
# Open
node headless.js https://example.com

# Search
node headless.js --search "playwright tutorial"

# Fingerprint check
node headless.js --check https://bot.sannysoft.com
```

---

## Other entry points

`headless.js` is the one-shot tool. The live/VNC stack has its own commands —
see [LIVE-DRIVE.md](LIVE-DRIVE.md) for the full reference.

| Command | Does |
| ------- | ---- |
| `npm run vnc [-- --resolution WxH] [-- --browser chrome\|chromium\|firefox] [-- --local-chrome]` | Bring up Xvfb + headed Chrome + x11vnc + noVNC and stay in the foreground |
| `npm run live -- <command> [args]` | One live command against the running Chrome (JSON out). `--stdin` for JSON-lines; `--agent-id <id>` to scope to one agent tab |
| `npm run connect -- <command>` | Same idea against a **remote** CDP endpoint (`CDP_URL=…`) |
| `npm run local-chrome` | Start a normal Chrome with a DevTools port, for `vnc -- --local-chrome` |
| `npm run standalone -- <group> <subcommand>` | Scriptable CLI: `browser`, `tunnel`, `ai`, `api-keys` |
| `npm run tunnel -- tunnel-<command>` | Named tunnels with password-protected ingress |
| `npm run drive-doc` | Print LIVE-DRIVE.md |

```bash
npm run vnc -- --resolution 1920x1080     # 1080p desktop, viewport matches
npm run live -- dump                      # JSON description of the active tab
npm run live -- extract-links checkout    # scrape
npm run live -- db-select leads           # DuckDB, no browser needed
npm run standalone -- ai chat echo "hi"   # offline AI round trip
```

---

## Global flags

These work in every mode.

| Flag                        | Default       | Description |
| --------------------------- | ------------- | ----------- |
| `--help`, `-h`              |               | Print help and exit. |
| `--headed`, `--no-headless` |               | Open a real Chrome window instead of running headless. Useful for debugging detection or for solving a CAPTCHA manually. |
| `--headless`                | `true`        | Force headless mode (this is the default already). |
| `--profile=PATH`            | `./profile/`  | Persistent Chrome user-data directory. Cookies, sessions, localStorage, etc. are saved here. |
| `--viewport=WxH`            | `1920x1080`   | Viewport size in CSS pixels. |
| `--resolution=WxH`          | `1280x800`    | VNC display resolution (Xvfb screen size). Also sets viewport. Accepts the shorthand `WIDTHxHEIGHT` form. |
| `--keep-open`               | `false`       | After the URL finishes loading, don't auto-close. Useful for `--headed` debugging. |
| `--executablePath=PATH`     | `/usr/bin/google-chrome` | Override the Chrome binary location. |

Examples:

```bash
# Use a separate profile for "work" identity
node headless.js --profile=./profiles/work https://work-app.com

# Open in a smaller viewport
node headless.js --viewport=1280x800 https://example.com

# Set VNC display resolution
node headless.js --resolution=1920x1080 https://example.com

# Headed mode for debugging
node headless.js --headed https://example.com

# Force headless explicitly
node headless.js --headless https://example.com
```

---

## Screenshot flags

See [screenshots.md](screenshots.md) for the conceptual overview.
Here are the flags.

| Flag                                   | Default                  | Description |
| -------------------------------------- | ------------------------ | ----------- |
| `--shot`, `--screenshot`               | `false`                  | Take a screenshot of the loaded page. |
| `--shot=PATH`, `--screenshot=PATH`     | `./screenshots/screenshot-<ts>.png` | Save to this path. Format is inferred from extension (`.png`/`.jpg`). |
| `--full-page`, `--fullpage`            | `false`                  | Capture the entire scrollable page, not just the viewport. |
| `--screenshot-format=png\|jpeg`        | `png`                    | Image format. |
| `--screenshot-quality=N`               | `80`                     | JPEG quality 0-100 (ignored for PNG). |
| `--screenshot-wait=MS`                 | `1500`                   | Extra ms to wait AFTER the page settles, before snapping. Use to give lazy content time to render. |
| `--screenshot-wait-until=load\|domcontentloaded\|networkidle` | `networkidle` | Wait condition before the extra `screenshot-wait`. |

Examples:

```bash
# Auto-named under ./screenshots/
node headless.js --shot https://example.com

# Explicit path
node headless.js --shot=foo.png https://example.com

# Full scrollable page
node headless.js --shot --full-page https://example.com

# JPEG with quality
node headless.js --shot=pic.jpg --screenshot-format=jpeg --screenshot-quality=70 https://example.com

# Wait 3 seconds for lazy content
node headless.js --shot --screenshot-wait=3000 https://example.com
```

---

## Search flags

See [search.md](search.md) for the conceptual overview. Here are the flags.

| Flag                              | Default            | Description |
| --------------------------------- | ------------------ | ----------- |
| `--search "QUERY"`                |                    | Search query. Accepts the next arg if it doesn't look like a flag. |
| `--search=QUERY`, `--search-query=QUERY` |             | Same, with `=` syntax. |
| `--search-engine=ENGINE`          | `duckduckgo-html`  | `duckduckgo-html` \| `brave` \| `searxng`. Aliases: `ddg`. |
| `--search-engine ENGINE`          |                    | Space-separated form of the above. |
| `--search-limit=N`                | `10`               | Max results to return. |
| `--search-limit N`                |                    | Space-separated form. |
| `--search-json`                   | `false`            | Output raw JSON instead of formatted text. Useful for piping to `jq`. |
| `--search-shot`, `--search-screenshot` | `false`        | Also save a screenshot of the results page. Filename: `search-<engine>.png`. |
| `--searxng-instance=URL`          | `https://paulgo.io` | Custom SearXNG instance URL (only used if engine is `searxng`). |

Examples:

```bash
# Default (DuckDuckGo HTML, 10 results, pretty-printed)
node headless.js --search "playwright tutorial"

# Limit to 5 results
node headless.js --search "playwright tutorial" --search-limit 5

# Use Brave explicitly
node headless.js --search "rust async" --search-engine=brave

# Use a custom SearXNG instance
node headless.js --search "privacy news" \
                 --search-engine=searxng \
                 --searxng-instance=https://searx.be

# JSON for piping
node headless.js --search "node streams" --search-json | jq '.results[].url'

# Search + screenshot
node headless.js --search "hello world" --search-shot
```

---

## Fingerprint-check flags

The `--check URL` mode loads a page and runs a battery of
fingerprint probes. There are no extra flags; the URL is the page
to probe (a known detection site like `https://bot.sannysoft.com` or
`https://browserleaks.com`).

```bash
node headless.js --check https://bot.sannysoft.com
```

Output is a single JSON object. See [stealth.md](stealth.md) for what
each field means and what the "passing" values look like.

---

## Putting it all together

```bash
# Realistic scenarios:

# 1. Log in, screenshot the result, search for something
node headless.js --profile=./profiles/me --shot=home.png \
  --search "weather today" --search-engine=duckduckgo-html \
  https://my-app.com

# 2. Stealth run with custom viewport and JPEG screenshot
node headless.js --viewport=1280x800 \
  --shot=full.jpg --screenshot-format=jpeg --screenshot-quality=60 \
  --full-page https://example.com

# 3. Run a search via SearXNG, output JSON
node headless.js --search "node streams" \
  --search-engine=searxng --searxng-instance=https://searx.be \
  --search-json | jq '.results[] | {title, url}'
```

See the per-feature pages ([screenshots.md](screenshots.md),
[search.md](search.md), [stealth.md](stealth.md),
[persistence.md](persistence.md)) for the conceptual details behind
each flag.
