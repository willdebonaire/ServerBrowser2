#!/usr/bin/env bash
#
# local-chrome.sh — start a *normal* Chrome with a DevTools port so that
# `npm run vnc -- --local-chrome` can attach to it over CDP instead of
# launching its own browser.
#
# Uses its own profile directory by default so it does not touch the Chrome
# profile you are already logged into, and so it can run alongside it.
#
# Env:
#   CDP_PORT             remote-debugging port (default 9222)
#   LOCAL_CHROME_PROFILE user-data-dir (default $HOME/.serverbrowser-local-chrome)
#   CHROME_BIN           chrome binary (default /usr/bin/google-chrome)
#   HEADLESS=1           add --headless=new when no DISPLAY is available
#
set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
LOCAL_CHROME_PROFILE="${LOCAL_CHROME_PROFILE:-$HOME/.serverbrowser-local-chrome}"
CHROME_BIN="${CHROME_BIN:-/usr/bin/google-chrome}"

if [ -x "$CHROME_BIN" ]; then
  :
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME_BIN="$(command -v google-chrome)"
elif command -v chromium >/dev/null 2>&1; then
  CHROME_BIN="$(command -v chromium)"
else
  echo "[local-chrome] no Chrome/Chromium binary found (set CHROME_BIN)" >&2
  exit 1
fi

ARGS=(
  "--remote-debugging-port=${CDP_PORT}"
  "--remote-debugging-address=127.0.0.1"
  "--user-data-dir=${LOCAL_CHROME_PROFILE}"
  --no-first-run
  --no-default-browser-check
  --disable-blink-features=AutomationControlled
)

# Chrome refuses to start as root without these (containers, CI, this box).
# scripts/vnc-driver.js already passes them for the launched browser.
if [ "$(id -u)" = "0" ]; then
  ARGS+=(--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage)
  echo "[local-chrome] running as root: adding --no-sandbox"
fi

if [ -z "${DISPLAY:-}" ] && [ "${HEADLESS:-0}" != "0" ]; then
  ARGS+=(--headless=new)
fi

mkdir -p "$LOCAL_CHROME_PROFILE"
echo "[local-chrome] launching ${CHROME_BIN} (CDP :${CDP_PORT}, profile: ${LOCAL_CHROME_PROFILE})"
echo "[local-chrome] attach with: npm run vnc -- --local-chrome --local-chrome-port ${CDP_PORT}"
echo "[local-chrome] or directly: node scripts/local-chrome.js attach ${CDP_PORT}"

exec "$CHROME_BIN" "${ARGS[@]}"
