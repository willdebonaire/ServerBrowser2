#!/usr/bin/env node

const http = require('http');
const fs = require('fs');

const DEFAULT_PORTS = [9222, 9223, 9224];

/** Ports to probe, in order: explicit CLI flag, LOCAL_CHROME_PORTS, CDP_PORT, defaults. */
function portsToTry(port) {
  if (port) return [Number(port)];
  const envPorts = (process.env.LOCAL_CHROME_PORTS || '')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter(Boolean);
  const extra = process.env.CDP_PORT ? [Number(process.env.CDP_PORT)] : [];
  return [...new Set([...envPorts, ...extra, ...DEFAULT_PORTS])];
}

function resolvePort(port) {
  return portsToTry(port)[0];
}

async function probeCDP(url) {
  const target = typeof url === 'string' ? url : 'http://127.0.0.1:' + url + '/json/version';
  return new Promise((resolve) => {
    const req = http.request(target, { method: 'GET', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function detectLocalChrome(ports) {
  const candidates = ports && ports.length ? ports : portsToTry();
  for (const p of candidates) {
    const info = await probeCDP(p);
    if (info && info.Browser) {
      return { port: p, url: 'http://127.0.0.1:' + p, info };
    }
  }
  return null;
}

/**
 * Attach to an already-running Chrome over CDP.
 *
 * With no `port`, every candidate (LOCAL_CHROME_PORTS / CDP_PORT / 9222-9224)
 * is probed and the first live endpoint wins. The user's browser is never
 * launched or closed — we only disconnect on shutdown.
 */
async function connectLocalChrome(port) {
  const { chromium } = require('playwright');
  const candidates = portsToTry(port);
  const found = await detectLocalChrome(candidates);
  if (!found) {
    throw new Error(
      'no Chrome CDP endpoint found. Tried: ' + candidates.join(', ') +
      '. Start Chrome with --remote-debugging-port=9222 (e.g. `npm run local-chrome`, or ' +
      '`google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-profile`).'
    );
  }
  const browser = await chromium.connectOverCDP(found.url);
  return { browser, port: found.port, url: found.url, info: found.info };
}

function out(data) { process.stdout.write(JSON.stringify(data) + '\n'); }

async function cli(argv) {
  const cmd = argv[0];
  const port = argv[1] ? Number(argv[1]) : null;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write([
      'local-chrome.js — attach to an already-running Chrome instead of launching one',
      '',
      'Usage:',
      '  node scripts/local-chrome.js detect [port]    probe for a live CDP endpoint',
      '  node scripts/local-chrome.js attach [port]    connect over CDP and report the browser',
      '',
      'With no port, LOCAL_CHROME_PORTS, CDP_PORT and 9222-9224 are probed in order.',
      '',
    ].join('\n'));
    return 0;
  }

  if (cmd === 'detect') {
    const found = await detectLocalChrome(portsToTry(port));
    out(found ? { found: true, port: found.port, url: found.url, browser: found.info.Browser } : { found: false, tried: portsToTry(port) });
    return found ? 0 : 1;
  }

  if (cmd === 'attach') {
    const { browser, port: usedPort, info } = await connectLocalChrome(port);
    const pages = (browser.contexts() || []).flatMap((c) => c.pages());
    out({ attached: true, port: usedPort, browser: info.Browser, tabs: pages.length, urls: pages.map((p) => p.url()).slice(0, 10) });
    // Deliberately not calling browser.close(): on a CDP connection that can shut
    // down the *user's* browser. Exiting drops the websocket, which is enough.
    return 0;
  }

  process.stderr.write('unknown command: ' + cmd + '\n');
  return 2;
}

module.exports = {
  DEFAULT_PORTS,
  portsToTry,
  probeCDP,
  detectLocalChrome,
  connectLocalChrome,
  resolvePort,
};

if (require.main === module) {
  cli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => { process.stderr.write(String((e && e.message) || e) + '\n'); process.exit(1); });
}
