#!/usr/bin/env node
/**
 * tunnel-auth-proxy.js — password gate in front of a local target.
 *
 * A quick tunnel (cloudflared/ngrok) has no auth of its own, so we never point
 * the tunnel straight at the VNC/CDP ports. Instead:
 *
 *     internet -> tunnel -> [this proxy :PORT] -> target (noVNC / CDP / app)
 *
 * Every request must prove knowledge of the password, either with HTTP Basic
 * auth (`curl -u any:PASSWORD`) or a `?pw=PASSWORD` query parameter (needed for
 * WebSocket upgrades such as noVNC, where browsers cannot set headers).
 *
 * Usage:
 *   node scripts/tunnel-auth-proxy.js --port 6199 --target http://127.0.0.1:6080 --password secret
 *
 * Env fallbacks: TUNNEL_PROXY_PORT, TUNNEL_TARGET, TUNNEL_PASSWORD
 *
 * Exits with code 0 on SIGTERM. Prints one JSON line on the port it binds, so
 * the parent process can wait for readiness.
 */
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const { URL } = require('url');

const getArg = (key) => {
  const i = process.argv.indexOf(key);
  return i >= 0 ? process.argv[i + 1] : null;
};

const PORT = Number(getArg('--port') || process.env.TUNNEL_PROXY_PORT || 6199);
const TARGET = new URL(getArg('--target') || process.env.TUNNEL_TARGET || 'http://127.0.0.1:6080');
const PASSWORD = getArg('--password') || process.env.TUNNEL_PASSWORD || '';
const TARGET_PORT = Number(TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80));

if (!PASSWORD) {
  process.stderr.write('[tunnel-proxy] refusing to start without a password\n');
  process.exit(2);
}

const timingSafeEqual = (a, b) => {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

function passwordFromRequest(req, parsed) {
  const header = req.headers['authorization'] || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) return decoded.slice(idx + 1);
  }
  if (parsed && parsed.searchParams.has('pw')) return parsed.searchParams.get('pw');
  const cookie = req.headers['cookie'] || '';
  const match = cookie.match(/(?:^|;\s*)sb_tunnel_pw=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

function authorized(req, parsed) {
  const supplied = passwordFromRequest(req, parsed);
  return supplied !== null && timingSafeEqual(supplied, PASSWORD);
}

function deny(res) {
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="ServerBrowser", charset="UTF-8"',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('401 Unauthorized — password required.\n');
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  if (!authorized(req, parsed)) return deny(res);

  // Remember the password so sub-resources (JS/CSS/WS of noVNC) authenticate.
  const headers = { ...req.headers, host: TARGET.host };
  const proxied = http.request(
    {
      host: TARGET.hostname,
      port: TARGET_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstream) => {
      const outHeaders = { ...upstream.headers };
      if (parsed.searchParams.has('pw')) {
        outHeaders['set-cookie'] = `sb_tunnel_pw=${encodeURIComponent(parsed.searchParams.get('pw'))}; Path=/; HttpOnly; SameSite=Lax`;
      }
      res.writeHead(upstream.statusCode || 502, outHeaders);
      upstream.pipe(res);
    }
  );
  proxied.on('error', (e) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('502 Bad Gateway — target unreachable: ' + e.message + '\n');
  });
  req.pipe(proxied);
});

// WebSocket / raw upgrade passthrough (noVNC's RFB connection).
server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  if (!authorized(req, parsed)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const upstream = net.connect(TARGET_PORT, TARGET.hostname, () => {
    const lines = [`GET ${req.url} HTTP/1.1`];
    const headers = { ...req.headers, host: TARGET.host };
    for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({
    proxy: 'listening',
    port: PORT,
    target: TARGET.origin,
    passwordProtected: true,
  }) + '\n');
});

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
