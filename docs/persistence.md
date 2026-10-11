# Persistence

`launch()` uses `chromium.launchPersistentContext()`, which writes a
**real Chrome user-data directory** to disk. Everything Chrome would
normally persist for a regular user profile persists across runs.

## What survives between runs

| Data | Persisted? | Where in the profile |
| ---- | ---------- | -------------------- |
| Cookies | ✅ | `Default/Cookies` (SQLite) |
| `localStorage` | ✅ | `Default/Local Storage/leveldb/` |
| `sessionStorage` | ❌ (per-session only) | — |
| `IndexedDB` | ✅ | `Default/IndexedDB/` |
| Service workers | ✅ | `Default/Service Worker/` |
| Cache | ✅ | `Default/Code Cache/`, `Default/Cache/` |
| Logins / autofill | ❌ (we explicitly turn this off) | — |
| Browsing history | ✅ (Chrome's default) | `Default/History` |
| Extensions | ❌ (we launch with `--disable-extensions`) | — |
| Permissions / grant decisions | ✅ | `Default/Preferences` |

The reason logins and autofill are disabled: they're stored in
detectable formats that a fresh, clean browser profile wouldn't have,
and they leak into the fingerprint.

## Default location

The default profile is:

```
<this folder>/profile/
```

Concretely, after one run you'll see:

```
profile/
├── Default/
│   ├── Cookies                ← SQLite, real Chrome format
│   ├── Cookies-journal
│   ├── Preferences            ← JSON, includes permission grants
│   ├── Local Storage/         ← leveldb for localStorage
│   ├── IndexedDB/             ← IndexedDB
│   ├── Code Cache/
│   ├── Cache/
│   ├── History
│   ├── ... many more
├── Local State                ← top-level Chrome state
├── Last Version
├── GrShaderCache/
├── GraphiteDawnCache/
└── ...
```

## Using multiple profiles

Pass `--profile=PATH` (CLI) or `profileDir: PATH` (library) to use a
different profile:

```bash
# Different profile per identity
node headless.js --profile=./profiles/work    https://work-app.com
node headless.js --profile=./profiles/personal https://other-app.com
```

```js
const { launch } = require('./headless');
const { page, close } = await launch({
  profileDir: './profiles/work',
  url: 'https://work-app.com',
});
```

Two runs with different `profileDir`s are completely isolated — they
share no cookies, no localStorage, no anything. Treat them as
separate Chrome installs.

## When to reset a profile

You generally **don't** need to — the profile is self-healing. But
you may want to reset in these cases:

- **Cookies got out of sync** (e.g. you changed your password
  upstream). Delete `profile/Default/Cookies`.
- **A site's state is corrupted** (e.g. a half-completed onboarding
  flow is making the next run loop). Delete the whole profile dir.
- **You want a clean stealth run** for a one-off check. Pass
  `--profile=./profiles/clean`.
- **The profile grew too large** (it's been months of heavy use).
  Delete it; Chrome will rebuild it on next run.

To reset fully:

```bash
rm -rf /opt/lampp/htdocs/ServerBrowser/profile/
```

## Inspecting the profile

The profile is a normal Chrome user-data dir, so you can poke at it
with standard tools:

```bash
# See the cookies
sqlite3 profile/Default/Cookies "SELECT host_key, name, value FROM cookies LIMIT 10;"

# See the permissions
cat profile/Default/Preferences | python3 -m json.tool | less
```

## Why a persistent profile is also good for stealth

Anti-bot systems often check the *consistency* of a profile: does
this user have a history? Have they visited these sites before?
Are their cookies consistent with their claimed identity?

A fresh, empty profile on every run is **its own** tell — real users
almost never have an empty profile. By keeping the profile
persistent, you:

- Build up a (small) browsing history over time.
- Accumulate realistic cookies.
- Get realistic cache hits.
- Make the browser look like a real returning visitor, not a
  one-shot automated script.

## Security notes

The profile dir contains cookies — anyone with read access to the
filesystem can impersonate you on every site you've logged into. On
shared systems:

- Don't run `ServerBrowser/` as root for personal accounts (you're
  currently running as root in this XAMPP setup, which is fine for
  dev but treat the profile as sensitive).
- Set `chmod 700` on the profile dir.
- Consider encrypting the filesystem if the box is multi-user.

## What does NOT persist

- **In-memory JavaScript state** — the JS heap is per-process.
- **The current page** — the browser always starts at
  `about:blank` (or whatever URL you pass to `launch()`).
- **The active download list** — downloads are per-session.
- **Open DevTools** — but the stealth patches make this moot
  anyway, since there's nothing suspicious to find.
- **Geolocation permission grants** beyond the first run** —
  actually, these do persist. If you `grantPermissions` something
  in one run, it's there next time.
