#!/usr/bin/env bash
#
# smoke-test-vnc-resolution.sh — verify --resolution flag launches Chrome at
# the correct viewport/window-size dimensions.
#
# Prerequisites:
#   - google-chrome installed
#   - Xvfb installed
#   - node + npm deps installed
#
# Usage:
#   bash scripts/smoke-test-vnc-resolution.sh 1920 1080
#
set -euo pipefail

RES_W="${1:-1920}"
RES_H="${2:-1080}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DISPLAY_NUM="${DISPLAY_NUM:-99}"
SCREEN="${RES_W}x${RES_H}x24"
PROFILE="/tmp/smoke-test-chrome-profile-$$"
CLEANED_UP=0

cleanup() {
  if [ "${CLEANED_UP}" -eq 1 ]; then return; fi
  CLEANED_UP=1
  echo "[smoke] cleaning up..."
  pkill -f "Xvfb :${DISPLAY_NUM}" 2>/dev/null || true
  pkill -f "scripts/vnc-driver.js" 2>/dev/null || true
  pkill -f "websockify" 2>/dev/null || true
  pkill -f "x11vnc" 2>/dev/null || true
  rm -rf "${PROFILE}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[smoke] starting Xvfb on display :${DISPLAY_NUM} (${SCREEN})"
Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp &
sleep 1

echo "[smoke] launching vnc-driver.js --resolution ${RES_W}x${RES_H}"
DISPLAY=":${DISPLAY_NUM}" node "${ROOT}/scripts/vnc-driver.js" \
  --cdp-port 19622 \
  --profile "${PROFILE}" \
  --resolution "${RES_W}x${RES_H}" \
  --start-url "about:blank" &
sleep 5

echo "[smoke] probing CDP endpoint..."
if ! curl -sf "http://127.0.0.1:19622/json/version" >/dev/null 2>&1; then
  echo "[smoke] FAIL: CDP endpoint not reachable"
  exit 1
fi
echo "[smoke] CDP endpoint OK"

echo "[smoke] checking window size via page.evaluate..."
RESULT=$(curl -sf "http://127.0.0.1:19622/json/list" 2>/dev/null \
  | node -e "
    const ws = require('ws');
    const http = require('http');
    const targets = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const t = targets.find(x => x.url === 'about:blank');
    if (!t) { console.error('no about:blank tab'); process.exit(1); }
    console.log(JSON.stringify(t));
  " 2>/dev/null) || true

echo "[smoke] verifying viewport dimensions via CDP page.evaluate..."
VERIFY=$(curl -sf "http://127.0.0.1:19622/json/list" 2>/dev/null | node -e "
  const targets = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const t = targets.find(x => x.url === 'about:blank');
  if (!t) { console.error('no about:blank tab'); process.exit(1); }
  const { chromium } = require('playwright');
  (async () => {
    try {
      const browser = await chromium.connectOverCDP('http://127.0.0.1:19622');
      const ctx = browser.contexts()[0];
      const page = ctx.pages()[0];
      const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      console.log(JSON.stringify(vp));
      await browser.close();
    } catch (e) { console.error(e.message); process.exit(1); }
  })();
") || true

echo "[smoke] viewport result: ${VERIFY}"

PASS=1
echo "${VERIFY}" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const expectedW = process.env.RES_W || '${RES_W}';
  const expectedH = process.env.RES_H || '${RES_H}';
  if (d.w === Number(expectedW) && d.h === Number(expectedH)) {
    console.log('[smoke] PASS: viewport is ' + expectedW + 'x' + expectedH);
  } else {
    console.log('[smoke] FAIL: expected ' + expectedW + 'x' + expectedH + ', got ' + d.w + 'x' + d.h);
    process.exit(1);
  }
" || PASS=0

if [ "${PASS}" -eq 0 ]; then
  echo "[smoke] FAIL"
  exit 1
fi

echo "[smoke] PASS: viewport dimensions match --resolution ${RES_W}x${RES_H}"
