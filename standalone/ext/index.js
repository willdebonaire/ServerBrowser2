#!/usr/bin/env node
/**
 * standalone/ext/index.js — the `ext` command group (docs/COMMANDS.md §G).
 *
 * ADDITIVE BY CONSTRUCTION: this is a separate CLI. It does not register
 * itself into standalone/index.js's COMMANDS map, and it imports nothing
 * from the existing codebase except scripts/live.js, which it drives
 * through its documented `eval` verb. Deleting this directory removes the
 * whole feature and changes no existing behaviour.
 *
 *   data commands — pure JSON transforms; no browser required.
 *   page commands — browser interaction, delegated to scripts/live.js.
 *
 * Usage:
 *   node standalone/ext/index.js <command> [args...] [--flag value]
 *   node standalone/ext/index.js help
 *   node standalone/ext/index.js commands
 *
 * Output is one JSON object per call: { ok, cmd, result } on success,
 * { ok: false, cmd, error } on failure, plus a non-zero exit code.
 */
'use strict';

const L = require('./lib.js');
const data = require('./data.js');
let page = {};
try { page = require('./page.js'); } catch { page = {}; } // optional

const COMMANDS = { ...data, ...page };

/** Commands that need a live browser session. */
const PAGE_COMMANDS = [
  'findtab', 'waitforclear', 'waitfortext', 'settle', 'setvalue', 'clicktext',
  'clickpoint', 'click', 'fillmap', 'toggle', 'upload', 'errors', 'scrollto',
  'dismiss', 'find', 'localstorage', 'inject', 'sniff', 'assert', 'guard',
  'retry', 'paginate', 'run', 'runext',
];

/** One-line usage per command, shown by `help`. */
const USAGE = {
  host: '<url>... [--include]',
  dedupe: '<jsonArray|@file> [--by <field|host>]',
  filter: '<jsonArray|@file> [--drop-host re] [--keep-host re] [--has re] [--drop-text re] [--min-len N] [--field f]',
  map: '<jsonArray|@file> --field <name> --from <expr> [--to <name>]',
  diff: '<a> <b> [--by <field|host>]',
  emit: '<json> [--format csv|json|ndjson] [--file <path>] [--append]',
  schema: 'list | <name> --define <json> | <name> --validate <json>',
  classify: '<url...> --rules <json>',
  profiles: 'list | set|show|rm --name <n> [--json <j>] [--reveal]',
  state: 'list | set|merge|get|rm --name <n> [--json <j>]',
  path: '',

  findtab: '<urlRegex> [--switch] [--agent-id <id>]',
  waitforclear: '<titleRegex> [--timeout ms] [--poll ms]',
  waitfortext: '<textRegex> [--timeout ms] [--poll ms]',
  settle: '[<selector>] [--quiet ms]',
  setvalue: '<css> <text> [--mode auto|native|handler|select] [--nth N]',
  clicktext: '<textRegex> [--nth N] [--exact]',
  clickpoint: '<css> [--nth N] [--offset X,Y]',
  click: '<css> [--nth N]',
  fillmap: '<json> --rules <json>',
  toggle: '<css> [state] [--nth N]',
  upload: '<css> <file>',
  errors: '[--css <sel>]',
  scrollto: '<css> [--offset N] [--block start|center|end]',
  dismiss: '[--text <re>] [--nth N] [--all]',
  find: '<selector|textRegex> [--text] [--nth N]',
  localstorage: '[key] [value]',
  inject: '<file>',
  sniff: '[--text N]',
  assert: '[--css <sel>] [--absent <sel>] [--url-matches re] [--text-matches re]',
  guard: '--name <n> --requires <cmd>... --runs <cmd>... [--then <cmd>...]',
  retry: '--cmd <c> [--arg <v>]... [--times N] [--on re] [--reset <cmd>]',
  paginate: '<nextSelector> [--max N] [--until-empty] [--scroll]',
  run: '<jsonArray> [--stop-on-error]',
  runext: '<script.js> [args...]',
  commands: '',
};

function usage() {
  const names = Object.keys(COMMANDS).sort();
  const width = Math.max(...names.map((n) => n.length)) + 2;
  const row = (n) => '  ' + n.padEnd(width) + (USAGE[n] || '');
  const isPage = (n) => PAGE_COMMANDS.includes(n);

  return [
    'ServerBrowser ext — agent-facing add-on commands (docs/COMMANDS.md §G)',
    '',
    'Usage: node standalone/ext/index.js <command> [args...] [--flag value]',
    '',
    'Data commands (no browser required):',
    ...names.filter((n) => !isPage(n)).map(row),
    '',
    'Page commands (drive scripts/live.js; needs a live browser session):',
    ...names.filter(isPage).map(row),
    '',
    'Examples:',
    '  node standalone/ext/index.js host https://www.example.co.uk/a/',
    '  node standalone/ext/index.js dedupe results.json --by host',
    '  node standalone/ext/index.js filter results.json --drop-host "spam|ads"',
    '  node standalone/ext/index.js setvalue "#email" "a@b.c" --mode auto',
    '  node standalone/ext/index.js run \'[{"goto":"https://x.com"},{"title"}]\'',
    '',
    'Every command prints one JSON object. No flag hardcodes a site, region or',
    'form-field vocabulary — those are passed in via --rules / --json.',
  ].join('\n');
}

async function main() {
  const { positional, flags } = L.parseArgs(process.argv.slice(2));
  const name = positional[0];

  if (!name || name === 'help' || name === '--help' || name === '-h' || flags.help === true) {
    L.out(usage());
    return 0;
  }
  if (name === 'commands') return L.out(L.ok('commands', Object.keys(COMMANDS).sort()));

  const fn = COMMANDS[name];
  if (typeof fn !== 'function') {
    L.out({ ok: false, cmd: name, error: `unknown command "${name}"`, available: Object.keys(COMMANDS).sort() });
    return 2;
  }

  try {
    const result = await fn(...positional.slice(1), flags);
    L.out(result);
    // A command may report failure without throwing (assert, guard).
    return result && result.ok === false ? 1 : 0;
  } catch (e) {
    L.out({
      ok: false,
      cmd: e && e.cmd ? e.cmd : name,
      error: String((e && e.message) || e),
      ...(e && e.extra ? { extra: e.extra } : {}),
    });
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String((e && e.message) || e) }) + '\n');
    process.exit(1);
  });