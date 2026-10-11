#!/usr/bin/env node
/**
 * standalone/index.js — ServerBrowser's own CLI shell.
 *
 * Dispatches to command modules in standalone/commands/. Each module may export
 * either a single function (the whole group) or an object whose properties are
 * subcommands, e.g. `browser.goto(url)` backs `standalone browser goto <url>`.
 * Return values are printed as JSON so the shell stays scriptable.
 *
 * Usage: node standalone/index.js <command> [subcommand] [args...]
 */
const path = require('path');
const fs = require('fs');

const COMMANDS = {
  browser: path.resolve(__dirname, 'commands', 'browser.js'),
  tunnel: path.resolve(__dirname, 'commands', 'tunnel.js'),
  'api-keys': path.resolve(__dirname, 'commands', 'api-keys.js'),
  ai: path.resolve(__dirname, 'commands', 'ai.js'),
};

const out = (data) => {
  if (data === undefined) return;
  fs.writeSync(1, (typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '\n');
};

const usage = () => {
  out([
    'ServerBrowser standalone CLI',
    '',
    'Usage: node standalone/index.js <command> [subcommand] [args...]',
    '',
    'Commands:',
    '  browser <sub>   live-browser commands (goto, click, fill, dump, extract-*, db-*, ...)',
    '  ai <sub>        AI provider calls using stored/env API keys (chat, providers, ping)',
    '  tunnel <sub>    tunnels with password-protected ingress (create, route, url, status, stop)',
    '  api-keys <sub>  API key management (set, get, list, remove) — stored 0600 in ~/.config/serverbrowser/',
    '  help            this help (also: --help, -h)',
    '',
    'Examples:',
    '  node standalone/index.js browser url',
    '  node standalone/index.js browser extract-links checkout',
    '  node standalone/index.js ai chat openai "summarise this page"',
    '  node standalone/index.js tunnel create my-session s3cret custom',
    '  node standalone/index.js api-keys set openai sk-...',
    '',
  ].join('\n'));
};

const subcommandsOf = (mod) =>
  Object.keys(mod).filter((k) => k !== 'default' && typeof mod[k] === 'function');

async function run() {
  const args = process.argv.slice(2);
  const cmdName = args[0];

  if (!cmdName || cmdName === 'help' || cmdName === '--help' || cmdName === '-h') {
    usage();
    return 0;
  }

  const modPath = COMMANDS[cmdName];
  if (!modPath) {
    fs.writeSync(2, `unknown command: ${cmdName}. Available: ${Object.keys(COMMANDS).join(', ')}\n`);
    return 2;
  }

  const mod = require(modPath);
  const rest = args.slice(1);

  if (typeof mod === 'function') {
    out(await mod(rest));
    return 0;
  }

  const single = mod.default || mod.run || mod.main || mod.handler;
  if (typeof single === 'function') {
    out(await single(rest));
    return 0;
  }

  const available = subcommandsOf(mod);
  const [sub, ...subArgs] = rest;

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    out([`${cmdName} subcommands:`, ...available.map((s) => '  ' + s)].join('\n'));
    return 0;
  }

  const fn = mod[sub];
  if (typeof fn !== 'function') {
    throw new Error(`unknown subcommand '${sub}' for '${cmdName}'. Available: ${available.join(', ')}`);
  }

  const result = await fn(...subArgs);
  out(result);
  return 0;
}

run()
  .then((code) => process.exit(code))
  .catch((e) => {
    fs.writeSync(2, String((e && e.message) || e) + '\n');
    process.exit(1);
  });
