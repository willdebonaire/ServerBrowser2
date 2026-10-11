/**
 * standalone/ext/data.js — domain-neutral data commands.
 *
 * ADDITIVE. Nothing here touches the browser or the existing codebase;
 * these are pure functions over JSON that any script can call instead of
 * re-deriving host parsing, dedupe and filtering.
 *
 * Every vocabulary is a parameter. Nothing knows what a "junk host" or a
 * "region" is — the caller supplies the rules. See docs/COMMANDS.md §G7.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const L = require('./lib.js');

/** Accept an array, an object wrapping one, or reject clearly. */
function toRows(value, label) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['rows', 'results', 'items', 'data']) {
      if (Array.isArray(value[key])) return value[key];
    }
  }
  throw new Error(`${label}: expected a JSON array (or an object with a rows/results/items array)`);
}

/** Derive the key a record is compared/deduped by. */
function keyOf(row, field) {
  if (field === 'host') return L.hostOf(row, null);
  if (field && typeof row === 'object' && row !== null) return String(row[field]);
  return typeof row === 'string' ? row : JSON.stringify(row);
}

/** Minimal RFC-4180 serialiser, matching the parser scrapers/_demo.js needs. */
function toCsv(rows) {
  const cell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return rows.map((r) => (Array.isArray(r) ? r : Object.values(r)).map(cell).join(',')).join('\n');
}

/** Mask a secret unless explicitly revealed, matching api-keys.js. */
function mask(value) {
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}

module.exports = {
  /* ------------------------------ host ---------------------------- */
  /** host <url>... --include — normalise one or more URLs. */
  host: (...args) => {
    // The dispatcher spreads positionals, so take the trailing flags
    // object (always last) and treat the rest as URLs.
    const flags = args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object'
      && !Array.isArray(args[args.length - 1]) ? args.pop() : {};
    const list = args.map(String);
    if (!list.length) throw new Error('host: usage: host <url>... [--include]');
    return L.ok('host', {
      urls: list.map((u) => L.host(u)),
      include: flags.include === true ? true : undefined,
    });
  },

  /* ---------------------------- dedupe ---------------------------- */
  /** dedupe <jsonArray> --by <field|host> — collapse duplicates. */
  dedupe: (input, flags) => {
    const rows = toRows(L.readJsonArg(input, 'json array'), 'dedupe');
    const by = flags.by === undefined || flags.by === true ? 'host' : String(flags.by);
    const res = L.applyDedupe(rows, by);
    return L.ok('dedupe', {
      by,
      uniqueCount: res.uniqueCount,
      duplicatesRemoved: res.duplicates.length,
      unique: res.unique,
    });
  },

  /* ---------------------------- filter ---------------------------- */
  /**
   * filter <jsonArray> [--drop-host re] [--keep-host re] [--has re]
   *                    [--drop-text re] [--min-len N] [--field f]
   * Reports per-reason counts so an agent can see WHY rows were dropped.
   */
  filter: (input, flags) => {
    const rows = toRows(L.readJsonArg(input, 'json array'), 'filter');
    const res = L.applyFilter(rows, flags);
    return L.ok('filter', {
      input: res.input,
      output: res.output,
      dropped: res.input - res.output,
      reasons: res.reasons,
      kept: res.kept,
    });
  },

  /* ------------------------------ map ----------------------------- */
  /**
   * map <jsonArray> --field <name> --from <expr> [--to <name>]
   * Project a field out of each row. `--from` is a JS expression
   * evaluated with the row bound as `r`, e.g. `--from r.url.split('/')[2]`.
   */
  map: (input, flags) => {
    const rows = toRows(L.readJsonArg(input, 'json array'), 'map');
    const to = flags.to === undefined || flags.to === true ? 'value' : String(flags.to);
    const from = flags.from === undefined || flags.from === true ? 'r' : String(flags.from);
    if (!flags.field || flags.field === true) throw new Error('map: --field <name> is required');

    let fn;
    try { fn = new Function('r', `return (${from});`); }
    catch (e) { throw new Error(`map: --from is not a valid expression: ${e.message}`); }

    const mapped = rows.map((r, i) => {
      let value;
      try { value = fn(r); }
      catch (e) { value = { error: String(e.message) }; }
      return { index: i, [to]: value };
    });
    return L.ok('map', { field: String(flags.field), to, count: mapped.length, mapped });
  },

  /* ----------------------------- diff ----------------------------- */
  /** diff <a> <b> --by <field|host> — what is new / missing between two sets. */
  diff: (a, b, flags) => {
    const before = toRows(L.readJsonArg(a, 'first set'), 'diff');
    const after = toRows(L.readJsonArg(b, 'second set'), 'diff');
    const by = flags.by === undefined || flags.by === true ? 'host' : String(flags.by);

    const beforeKeys = new Map(before.map((r) => [keyOf(r, by), r]));
    const afterKeys = new Map(after.map((r) => [keyOf(r, by), r]));

    const added = after.filter((r) => !beforeKeys.has(keyOf(r, by)));
    const removed = before.filter((r) => !afterKeys.has(keyOf(r, by)));
    const changed = after.filter((r) => {
      const prev = beforeKeys.get(keyOf(r, by));
      return prev !== undefined && JSON.stringify(prev) !== JSON.stringify(r);
    });

    return L.ok('diff', {
      by,
      before: before.length,
      after: after.length,
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      addedRows: added,
      removedRows: removed,
      changedRows: changed,
    });
  },

  /* ----------------------------- emit ----------------------------- */
  /**
   * emit <json> --format csv|json|ndjson --file <path> [--append]
   * A single sink for scraped output, so hand-rolled CSVs stop spreading.
   */
  emit: (input, flags) => {
    const data = L.readJsonArg(input, 'json');
    const format = flags.format === undefined || flags.format === true ? 'json' : String(flags.format);
    const rows = Array.isArray(data) ? data : toRows(data, 'emit');

    let text;
    if (format === 'csv') text = toCsv(rows);
    else if (format === 'ndjson') text = rows.map((r) => JSON.stringify(r)).join('\n');
    else if (format === 'json') text = JSON.stringify(rows, null, 2);
    else throw new Error(`emit: unsupported --format ${format} (csv|json|ndjson)`);

    if (!flags.file || flags.file === true) {
      return L.ok('emit', { format, rows: rows.length, content: text });
    }
    const file = path.resolve(String(flags.file));
    const append = flags.append === true || flags.append === 'true';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (append && fs.existsSync(file) ? '\n' : '') + text + '\n');
    return L.ok('emit', { format, rows: rows.length, file, appended: append, bytes: text.length });
  },

  /* ---------------------------- schema ---------------------------- */
  /**
   * schema list | schema <name> --define <json> | schema <name> --validate <json>
   * A named field contract so validation happens once instead of being
   * re-implemented per script. Schema shape:
   *   { "required": ["url"], "types": { "rows": "number" } }
   */
  schema: (name, flags) => {
    if (name === 'list' || flags.list === true) {
      return L.ok('schema', { schemas: Object.keys(L.readStore().schemas || {}) });
    }
    if (!name) throw new Error('schema: usage: schema list | schema <name> --define|--validate <json>');

    const key = String(name);
    const bucket = L.writeStore((s) => { if (!s.schemas) s.schemas = {}; }).schemas;

    if (flags.define !== undefined && flags.define !== true) {
      const definition = L.readJsonArg(flags.define, '--define');
      L.writeStore((s) => { s.schemas[key] = definition; });
      return L.ok('schema', { name: key, defined: true, definition });
    }
    if (flags.validate !== undefined && flags.validate !== true) {
      const rows = toRows(L.readJsonArg(flags.validate, '--validate'), 'schema --validate');
      const definition = bucket[key];
      if (!definition) throw new Error(`schema: no schema named "${key}" (define it first)`);

      const required = Array.isArray(definition.required) ? definition.required : [];
      const types = definition.types || {};
      const results = rows.map((row, i) => {
        const missing = required.filter((f) => row == null || row[f] === undefined || row[f] === '');
        const wrongType = Object.entries(types).filter(([f, t]) => {
          if (row == null || row[f] === undefined) return false;
          if (t === 'string') return typeof row[f] !== 'string';
          if (t === 'number') return typeof row[f] !== 'number';
          if (t === 'boolean') return typeof row[f] !== 'boolean';
          return false;
        }).map(([f, t]) => `${f} expected ${t} got ${typeof row[f]}`);

        const errors = [...missing.map((f) => `missing ${f}`), ...wrongType];
        return { index: i, valid: errors.length === 0, errors };
      });

      return L.ok('schema', {
        name: key,
        total: rows.length,
        valid: results.filter((r) => r.valid).length,
        invalid: results.filter((r) => !r.valid).length,
        results,
      });
    }
    const definition = bucket[key];
    if (!definition) throw new Error(`schema: no schema named "${key}"`);
    return L.ok('schema', { name: key, definition });
  },

  /* ---------------------------- classify -------------------------- */
  /**
   * classify <url...> --rules <json>
   * Match URLs against caller-supplied ordered rules:
   *   --rules '[{"label":"a","match":"regex"},{"label":"b","default":true}]'
   * Purely "route this value to a handler"; the corpus uses it for
   * regions, but nothing here assumes that.
   */
  classify: (...args) => {
    // The dispatcher spreads positionals, so collect urls then take the
    // trailing flags object (always last).
    const flags = args.length && args[args.length - 1] && typeof args[args.length - 1] === 'object'
      && !Array.isArray(args[args.length - 1]) ? args.pop() : {};
    const list = args.map(String);
    if (!list.length) throw new Error('classify: usage: classify <url...> --rules <json>');
    if (flags.rules === undefined || flags.rules === true) {
      throw new Error('classify: --rules <json> is required');
    }
    const rules = toRows(L.readJsonArg(flags.rules, '--rules'), 'classify --rules')
      .map((rule, i) => {
        // A rule marked `default` is the fallback and needs no match.
        if (rule.match === undefined && rule.default === true) {
          return { label: String(rule.label === undefined ? `rule${i}` : rule.label), re: null, def: true };
        }
        const re = L.toRegExp(rule.match, `rule ${i} match`);
        if (!re) throw new Error(`classify: rule ${i} needs a "match" regex`);
        return { label: String(rule.label === undefined ? `rule${i}` : rule.label), re, def: rule.default === true };
      });
    const fallback = L.toRegExp(flags['default-match'], '--default-match');
    const defRule = rules.find((r) => r.def);

    const classifyOne = (value) => {
      let h = null;
      try { h = L.host(value); } catch { /* not a URL */ }
      for (const rule of rules) {
        if (rule.re && h && rule.re.test(h.host)) return { input: value, label: rule.label, host: h.host };
      }
      if (fallback && h && fallback.test(h.host)) return { input: value, label: 'default', host: h.host };
      return { input: value, label: defRule ? defRule.label : null, host: h ? h.host : null, unmatched: true };
    };

    const classified = list.map(classifyOne);
    const counts = {};
    for (const c of classified) {
      const k = c.label === null ? '(unmatched)' : c.label;
      counts[k] = (counts[k] || 0) + 1;
    }
    return L.ok('classify', { rules: rules.length, counts, classified });
  },

  /* ---------------------------- profiles -------------------------- */
  /**
   * profiles list | set --name <n> --json <j> | show --name <n> [--reveal] | rm --name <n>
   * A named, 0600-backed store for value bundles (credentials, contact
   * details, locale) so values stop being pasted into scripts. `show`
   * masks by default and needs --reveal, matching api-keys.js.
   */
  profiles: (action, flags) => {
    const sub = action === undefined ? 'list' : String(action);

    if (sub === 'list') {
      return L.ok('profiles', {
        store: L.storePath(),
        profiles: Object.keys(L.readStore().profiles || {}),
      });
    }

    const name = flags.name === undefined || flags.name === true ? undefined : String(flags.name);
    if (!name) throw new Error(`profiles ${sub}: --name <name> is required`);
    const bucket = L.writeStore((s) => { if (!s.profiles) s.profiles = {}; }).profiles;

    if (sub === 'set') {
      if (flags.json === undefined || flags.json === true) throw new Error('profiles set: --json <json> is required');
      const values = L.readJsonArg(flags.json, '--json');
      L.writeStore((s) => { s.profiles[name] = values; });
      return L.ok('profiles', { name, stored: true, keys: Object.keys(values) });
    }
    if (sub === 'rm') {
      const existed = Boolean(bucket[name]);
      L.writeStore((s) => { delete s.profiles[name]; });
      return L.ok('profiles', { name, removed: existed });
    }
    if (sub === 'show') {
      const values = bucket[name];
      if (!values) throw new Error(`profiles: no profile named "${name}"`);
      const reveal = flags.reveal === true || flags.reveal === 'true';
      const masked = {};
      for (const [k, v] of Object.entries(values)) masked[k] = reveal ? v : mask(v);
      return L.ok('profiles', { name, revealed: reveal, values: masked });
    }
    throw new Error(`profiles: unknown action "${sub}" (list|set|show|rm)`);
  },

  /* --------------------------- state ------------------------------ */
  /**
   * state list | set --name <n> --json <j> | merge --name <n> --json <j>
   *       | get --name <n> | rm --name <n>
   * Resumable run state, replacing the four bespoke implementations the
   * corpus grew (gumroad-upload.js, indeed-post-all.js,
   * harvest_ai_platforms.js, jobsearch/harvest_jobs.js).
   */
  state: (action, flags) => {
    const sub = action === undefined ? 'list' : String(action);
    const bucket = L.writeStore((s) => { if (!s.state) s.state = {}; }).state;

    if (sub === 'list') return L.ok('state', { store: L.storePath(), keys: Object.keys(bucket) });

    const name = flags.name === undefined || flags.name === true ? undefined : String(flags.name);
    if (!name) throw new Error(`state ${sub}: --name <name> is required`);

    if (sub === 'set') {
      if (flags.json === undefined || flags.json === true) throw new Error('state set: --json <json> is required');
      const previous = bucket[name];
      const value = L.readJsonArg(flags.json, '--json');
      L.writeStore((s) => { s.state[name] = value; });
      return L.ok('state', { name, saved: true, previous: previous === undefined ? null : previous, value });
    }
    if (sub === 'merge') {
      if (flags.json === undefined || flags.json === true) throw new Error('state merge: --json <json> is required');
      const patch = L.readJsonArg(flags.json, '--json');
      const base = bucket[name] || {};
      // Arrays accumulate; objects shallow-merge. Never silently drop data.
      const merged = Array.isArray(base) || Array.isArray(patch)
        ? [...(Array.isArray(base) ? base : []), ...(Array.isArray(patch) ? patch : [])]
        : { ...base, ...patch };
      L.writeStore((s) => { s.state[name] = merged; });
      return L.ok('state', { name, merged: true, value: merged });
    }
    if (sub === 'get') {
      if (bucket[name] === undefined) return L.ok('state', { name, found: false, value: null });
      return L.ok('state', { name, found: true, value: bucket[name] });
    }
    if (sub === 'rm') {
      const existed = bucket[name] !== undefined;
      L.writeStore((s) => { delete s.state[name]; });
      return L.ok('state', { name, removed: existed });
    }
    throw new Error(`state: unknown action "${sub}" (list|set|merge|get|rm)`);
  },

  /* ----------------------------- path ----------------------------- */
  /** path — where the ext store lives and with what permissions. */
  path: () => {
    const p = L.storePath();
    let mode = 'not-created';
    try { mode = (fs.statSync(p.file).mode & 0o777).toString(8).padStart(3, '0'); }
    catch { /* not created yet */ }
    return L.ok('path', { ...p, mode, liveJs: L.LIVE_JS });
  },
};
