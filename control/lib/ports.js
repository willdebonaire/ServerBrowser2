'use strict';
/**
 * ports.js — port/display allocation for sessions.
 * Bind tests are done on 0.0.0.0 (conservative: catches listeners bound to
 * 127.0.0.1 too). Display numbers are checked via the X lock file, with a
 * stale-lock guard (dead pid ⇒ free).
 */
const net = require('net');
const fs = require('fs');
const health = require('./health');

function portFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function displayFree(n) {
  const lock = `/tmp/.X${n}-lock`;
  if (fs.existsSync(lock)) {
    try {
      const lines = fs.readFileSync(lock, 'utf8').trim().split('\n');
      const pid = parseInt(lines[lines.length - 1], 10);
      if (pid && health.isAlive(pid)) return false;   // live X server on :n
      // stale lock (dead pid) ⇒ free; Xvfb replaces stale locks/sockets itself
    } catch (_) { return false; }                     // unreadable ⇒ be safe
  }
  return true;
}

async function pickPort(preferred, attempts = 300) {
  for (let p = preferred; p < preferred + attempts && p < 65500; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port found near ${preferred}`);
}

function pickDisplay(preferred, attempts = 300) {
  for (let d = preferred; d < preferred + attempts && d < 600; d++) {
    if (displayFree(d)) return d;
  }
  throw new Error(`no free X display found near :${preferred}`);
}

/** Strict validation for explicitly requested values. Returns error strings. */
async function validate({ webPort, rfbPort, cdpPort, display }) {
  const errors = [];
  const nums = { webPort, rfbPort, cdpPort };
  for (const [k, v] of Object.entries(nums)) {
    if (!Number.isInteger(v) || v < 1024 || v > 65535) errors.push(`${k} must be 1024–65535`);
  }
  if (!Number.isInteger(display) || display < 1 || display > 599) errors.push('display must be 1–599');
  const used = new Set();
  for (const [k, v] of Object.entries(nums)) {
    if (used.has(v)) errors.push(`${k} ${v} conflicts with another port of this session`);
    used.add(v);
  }
  if (errors.length) return errors;
  if (!(await portFree(webPort))) errors.push(`webPort ${webPort} is already in use`);
  if (!(await portFree(rfbPort))) errors.push(`rfbPort ${rfbPort} is already in use`);
  if (!(await portFree(cdpPort))) errors.push(`cdpPort ${cdpPort} is already in use`);
  if (!displayFree(display)) errors.push(`display :${display} is already in use`);
  return errors;
}

module.exports = { portFree, displayFree, pickPort, pickDisplay, validate };
