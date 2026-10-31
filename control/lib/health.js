'use strict';
/**
 * health.js — probes for one session:
 *   process liveness (pid), CDP (/json/version), web port (websockify), RFB (tcp).
 * All probes are short-timeout so a dead stack answers fast.
 */
const http = require('http');
const net = require('net');

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function get(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({ ok: true, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 8192) }));
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false }); });
    req.on('error', () => finish({ ok: false }));
  });
}

async function probeCdp(port) {
  const r = await get(`http://127.0.0.1:${port}/json/version`);
  if (!r.ok || r.status !== 200) return false;
  try { const j = JSON.parse(r.body); return !!(j.Browser || j.webSocketDebuggerUrl); }
  catch (_) { return false; }
}

async function probeWeb(port) {
  const r = await get(`http://127.0.0.1:${port}/`);
  return r.ok && r.status < 500;
}

function probeTcp(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.once('connect', () => done(true));
    s.setTimeout(timeoutMs, () => done(false));
    s.once('error', () => resolve(false));
  });
}

async function probe(rec) {
  const cfg = rec.config || {};
  const alive = isAlive(rec.pids && rec.pids.session);
  const [cdp, web, rfb] = await Promise.all([
    probeCdp(cfg.cdpPort),
    probeWeb(cfg.webPort),
    probeTcp(cfg.rfbPort),
  ]);
  return { process: alive, cdp, web, rfb, overall: alive && cdp && web };
}

module.exports = { isAlive, probeCdp, probeWeb, probeTcp, probe };
