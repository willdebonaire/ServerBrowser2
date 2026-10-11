#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

const TUNNEL_JS = path.resolve(__dirname, '..', '..', 'scripts', 'tunnel.js');

const invokeTunnel = (args) => {
  // `fork` needs strings; drop undefined options so they don't become arguments.
  const safeArgs = (args || []).filter((a) => a !== undefined && a !== null).map(String);
  const child = require('child_process').fork(TUNNEL_JS, safeArgs, { silent: true });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  return new Promise((resolve, reject) => {
    child.on('error', (e) => reject(e));
    child.on('close', (code) => {
      if (code !== 0) {
        const msg = stderr || stdout || 'exit code ' + code;
        return reject(new Error(msg));
      }
      const lines = stdout.split('\n').filter((l) => l.trim());
      const results = [];
      for (const l of lines) {
        try {
          results.push(JSON.parse(l));
        } catch {
          results.push({ raw: l });
        }
      }
      resolve(results.length === 1 ? results[0] : results);
    });
  });
};

module.exports = {
  create: (name, password, provider) => invokeTunnel(['tunnel-create', name, password, provider]),
  route: (target, provider) => invokeTunnel(['tunnel-route', target, provider]),
  url: (provider) => invokeTunnel(['tunnel-url', provider]),
  status: (provider) => invokeTunnel(['tunnel-status', provider]),
  stop: (provider) => invokeTunnel(['tunnel-stop', provider]),
};
