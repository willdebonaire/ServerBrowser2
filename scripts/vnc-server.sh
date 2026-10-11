#!/usr/bin/env bash
#
# vnc-server.sh — launch a HEADED, real (non-headless) Google Chrome instance
# on a virtual X display, expose it over VNC (x11vnc + noVNC via websockify),
# and expose a Chrome DevTools (CDP) port so Playwright can drive it live.
#
# Usage:
#   npm run vnc
#
# Env overrides / flags:
#   WEB_PORT      web / noVNC / websockify port      (default 6080)
#   RFB_PORT      x11vnc RFB port                    (default 5900)
#   CDP_PORT      Chrome remote-debugging port       (default 9222)
#   DISPLAY_NUM   Xvfb display number                (default 10)
#   SCREEN        Xvfb screen "WIDTHxHEIGHTxDEPTH"   (default 1280x800x24)
#   RESOLUTION    "WIDTHxHEIGHT" shortcut for SCREEN (default empty)
#   PROFILE       Chrome user-data-dir (persistent)  (default ./profile)
#   START_URL     first tab URL                      (default http://127.0.0.1:WEB_PORT/)
#   NOVNC_SRC     noVNC install dir                  (default /usr/share/novnc)
#
# Flags:
#   --resolution WxH   shortcut for SCREEN=WxHx24
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WEB_PORT="${WEB_PORT:-6080}"
RFB_PORT="${RFB_PORT:-5900}"
CDP_PORT="${CDP_PORT:-9222}"
DISPLAY_NUM="${DISPLAY_NUM:-10}"
SCREEN="${SCREEN:-1280x800x24}"
PROFILE="${PROFILE:-${ROOT}/profile}"
NOVNC_SRC="${NOVNC_SRC:-/usr/share/novnc}"
NOVNC_WEBROOT="${ROOT}/vnc-web"
DISPLAY=":${DISPLAY_NUM}"
RESOLUTION="${RESOLUTION:-}"
BROWSER="${BROWSER:-chrome}"
LOCAL_CHROME="${LOCAL_CHROME:-0}"
LOCAL_CHROME_PORT="${LOCAL_CHROME_PORT:-}"
START_URL="${START_URL:-}"
export DISPLAY

usage() {
  cat <<'USAGE'
Usage: npm run vnc [-- <flags>]

Flags:
  --resolution WxH        virtual screen + Chrome viewport/window size (default 1280x800)
  --browser NAME          chrome | chromium | firefox (default chrome)
  --local-chrome          attach to an already-running Chrome over CDP instead of launching one
  --local-chrome-port N   CDP port of that Chrome (default: auto-detect 9222-9224)
  --cdp-port N            CDP port for the launched Chrome (default 9222)
  --profile PATH          Chrome user-data-dir (default ./profile)
  --start-url URL         first tab URL (default http://127.0.0.1:WEB_PORT/)
  -h, --help              this help

Env: WEB_PORT RFB_PORT CDP_PORT DISPLAY_NUM SCREEN RESOLUTION PROFILE START_URL BROWSER
     LOCAL_CHROME LOCAL_CHROME_PORT NOVNC_SRC REMOTE_ADDR
USAGE
}

# Robust flag parsing: a `for arg in "$@"` loop with `shift` inside silently
# mis-parses multi-flag invocations, which is why the driver never received
# --resolution/--browser before.
while [ $# -gt 0 ]; do
  case "$1" in
    --resolution=*)      RESOLUTION="${1#--resolution=}" ;;
    --resolution)        RESOLUTION="${2:-}"; shift ;;
    --browser=*)         BROWSER="${1#--browser=}" ;;
    --browser)           BROWSER="${2:-}"; shift ;;
    --cdp-port=*)        CDP_PORT="${1#--cdp-port=}" ;;
    --cdp-port)          CDP_PORT="${2:-}"; shift ;;
    --profile=*)         PROFILE="${1#--profile=}" ;;
    --profile)           PROFILE="${2:-}"; shift ;;
    --start-url=*)       START_URL="${1#--start-url=}" ;;
    --start-url)         START_URL="${2:-}"; shift ;;
    --local-chrome)      LOCAL_CHROME=1 ;;
    --local-chrome-port=*) LOCAL_CHROME_PORT="${1#--local-chrome-port=}" ;;
    --local-chrome-port) LOCAL_CHROME_PORT="${2:-}"; shift ;;
    -h|--help)           usage; exit 0 ;;
    *) echo "[vnc] unknown flag: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -n "$RESOLUTION" ]; then
  if ! echo "$RESOLUTION" | grep -qE '^[0-9]+x[0-9]+$'; then
    echo "[vnc] invalid --resolution '$RESOLUTION' (expected WIDTHxHEIGHT, e.g. 1920x1080)" >&2
    exit 2
  fi
  SCREEN="$(echo "$RESOLUTION" | cut -d'x' -f1)x$(echo "$RESOLUTION" | cut -d'x' -f2)x24"
fi

# The driver viewport must match the Xvfb screen, so derive it from SCREEN
# (covers the SCREEN=WxHx24 env form too).
RESOLUTION="$(echo "$SCREEN" | cut -d'x' -f1)x$(echo "$SCREEN" | cut -d'x' -f2)"

case "$BROWSER" in
  chrome|chromium|firefox) ;;
  *) echo "[vnc] unsupported --browser '$BROWSER' (chrome|chromium|firefox)" >&2; exit 2 ;;
esac

START_URL="${START_URL:-http://127.0.0.1:${WEB_PORT}/}"

# Detect the machine's reachable (remote) address — prefer a public/global IP
# over the Docker bridge / loopback, so the printed URLs work from your own
# browser. Override with: REMOTE_ADDR=1.2.3.4 npm run vnc
REMOTE_ADDR="${REMOTE_ADDR:-}"
if [ -z "$REMOTE_ADDR" ]; then
  REMOTE_ADDR="$(ip -4 addr show scope global 2>/dev/null \
    | grep -oP 'inet \K[\d.]+' \
    | grep -vE '^172\.(1[6-9]|2[0-9]|3[01])\.' \
    | grep -v '^127\.' \
    | head -1)"
fi
[ -z "$REMOTE_ADDR" ] && REMOTE_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$REMOTE_ADDR" ] && REMOTE_ADDR="localhost"

pids=()

cleanup() {
  echo
  echo "[vnc] shutting down (killing Xvfb, websockify, chrome, x11vnc)..."
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f "scripts/vnc-driver.js"         2>/dev/null || true
  pkill -f "x11vnc -display ${DISPLAY}"    2>/dev/null || true
  pkill -f "websockify ${WEB_PORT}"        2>/dev/null || true
  pkill -f "Xvfb ${DISPLAY} "              2>/dev/null || true
  sleep 0.5
}
trap cleanup EXIT INT TERM

# --- noVNC web root (served on WEB_PORT by websockify) ---
mkdir -p "${NOVNC_WEBROOT}"
if [ ! -e "${NOVNC_WEBROOT}/novnc" ]; then
  ln -s "${NOVNC_SRC}" "${NOVNC_WEBROOT}/novnc"
fi

# 1) Virtual display
echo "[vnc] Xvfb ${DISPLAY} (${SCREEN})"
Xvfb "${DISPLAY}" -screen 0 "${SCREEN}" -nolisten tcp &
pids+=($!)
sleep 1

# 2) Web + WebSocket server (serves instructions page + noVNC, proxies VNC)
#    Without -D so it stays a child of this script (reliable cleanup via pids).
echo "[vnc] websockify on :${WEB_PORT} -> vnc :${RFB_PORT} (web root: ${NOVNC_WEBROOT})"
websockify "${WEB_PORT}" --web="${NOVNC_WEBROOT}" 127.0.0.1:"${RFB_PORT}" >/dev/null 2>&1 &
pids+=($!)
sleep 1

# 3) Headed browser via Playwright (persistent profile + CDP), or attach to an
#    already-running Chrome with --local-chrome.
DRIVER_ARGS=(
  --cdp-port "${CDP_PORT}"
  --profile "${PROFILE}"
  --start-url "${START_URL}"
  --resolution "${RESOLUTION}"
  --browser "${BROWSER}"
)
if [ "${LOCAL_CHROME}" = "1" ]; then
  DRIVER_ARGS+=(--local-chrome)
  [ -n "${LOCAL_CHROME_PORT}" ] && DRIVER_ARGS+=(--local-chrome-port "${LOCAL_CHROME_PORT}")
  echo "[vnc] local-chrome mode: attaching over CDP (no browser launch)"
else
  echo "[vnc] launching headed ${BROWSER} ${RESOLUTION} (CDP :${CDP_PORT}, profile: ${PROFILE})"
fi
node "${ROOT}/scripts/vnc-driver.js" "${DRIVER_ARGS[@]}" &
pids+=($!)
sleep 4

# 4) VNC server on the display
echo "[vnc] x11vnc on :${RFB_PORT} for ${DISPLAY}"
x11vnc -display "${DISPLAY}" -rfbport "${RFB_PORT}" -nopw -forever -shared -quiet &
pids+=($!)

echo
echo "========================================================================"
echo "  VNC viewer   : http://${REMOTE_ADDR}:${WEB_PORT}/novnc/vnc_auto.html"
echo "  Instructions : http://${REMOTE_ADDR}:${WEB_PORT}/"
echo "  CDP endpoint : http://127.0.0.1:${CDP_PORT}/json/version  (localhost only)"
if [ "${LOCAL_CHROME}" = "1" ]; then
  echo "  Browser      : attached to local Chrome (auto-detect${LOCAL_CHROME_PORT:+ on :${LOCAL_CHROME_PORT}})"
else
  echo "  Browser      : ${BROWSER} ${RESOLUTION} on ${DISPLAY}   (profile: ${PROFILE})"
fi
echo "  Ctrl-C to stop this session (closes this Chrome)."
echo "========================================================================"
echo

wait