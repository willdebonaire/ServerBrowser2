/**
 * standalone/ext/page.js — browser commands, delegated to scripts/live.js.
 *
 * ADDITIVE: this module only CALLS live.js through its documented verbs
 * (`tabs`, `tab`, `eval`, `goto`, `text`, `title`, `wait`, `press`, …).
 * It never imports, patches or modifies live.js or anything else in the
 * existing codebase.
 *
 * Two constraints shape everything here:
 *
 *   1. `eval` is EXPRESSION-only — live.js wraps input as
 *      new Function('return ((' + js + '))'). Multi-statement bodies go
 *      through L.evalBody(), which sends an IIFE instead.
 *   2. DOM-only, by design. `upload` and `clickpoint` need raw CDP
 *      (DOM.setFileInputFiles / Input.dispatchMouseEvent) that live.js
 *      does not expose; both report `unsupported` explicitly rather than
 *      pretending to work. See docs/COMMANDS.md §G1.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const L = require('./lib.js');

/** Pull the trailing flags object off a spread-args list. */
function split(args) {
  const last = args[args.length - 1];
  const hasFlags = args.length && last && typeof last === 'object' && !Array.isArray(last);
  return {
    positional: hasFlags ? args.slice(0, -1).map(String) : args.map(String),
    flags: hasFlags ? last : {},
  };
}

/** Resolve --nth to an integer; default to the first match. */
const nthOf = (flags) => (flags.nth === undefined || flags.nth === true ? 0 : Number(flags.nth));

/** Flag as an optional string, treating a bare `--x` as absent. */
const optStr = (flags, name) => (flags[name] === undefined || flags[name] === true ? null : String(flags[name]));

module.exports = {
  /* ---------------------------- tabs ------------------------------ */
  /**
   * findtab <urlRegex> [--switch]
   * Attach to an existing tab by URL pattern. The corpus opens nearly
   * every script with the same hand-written pages().find(url.includes());
   * this is that line, parameterised and reusable.
   */
  findtab: async (pattern, flags = {}) => {
    if (!pattern) throw new Error('findtab: usage: findtab <urlRegex> [--switch]');
    const re = L.toRegExp(pattern, 'urlRegex');
    const pages = await L.live(['tabs']);
    const matches = (pages || []).filter((p) => re.test(p.url || ''));

    const shouldSwitch = flags.switch === true || flags.switch === 'true';
    if (shouldSwitch && matches.length) {
      const chosen = matches[0];
      const switched = await L.live(['tab', String(chosen.i)]);
      return L.ok('findtab', { matched: true, switched: true, index: chosen.i, tab: switched });
    }
    return L.ok('findtab', {
      matched: matches.length > 0,
      switched: false,
      matchCount: matches.length,
      matches,
      allTabs: pages,
    });
  },

  /* ---------------------------- waiting --------------------------- */
  /**
   * waitforclear <titleRegex> [--timeout ms] [--poll ms]
   * Wait out a blocking interstitial (bot check, cookie wall, splash).
   * The title pattern is a PARAMETER on purpose: the corpus hardcoded a
   * single vendor's marker, which does not generalise to the others.
   */
  waitforclear: async (pattern, flags = {}) => {
    if (!pattern) throw new Error('waitforclear: usage: waitforclear <titleRegex> [--timeout ms]');
    const re = L.toRegExp(pattern, 'titleRegex');
    const timeout = flags.timeout === undefined ? 30000 : Number(flags.timeout);
    const poll = flags.poll === undefined ? 500 : Number(flags.poll);
    const start = Date.now();
    const deadline = start + timeout;
    const attempts = [];

    for (;;) {
      const title = String(await L.live(['title']) || '');
      if (!re.test(title)) {
        return L.ok('waitforclear', { cleared: true, title, waitedMs: Date.now() - start });
      }
      attempts.push(title);
      if (Date.now() >= deadline) {
        return {
          ok: false, cmd: 'waitforclear',
          error: `still matching ${pattern} after ${timeout}ms`,
          result: { cleared: false, title, attempts },
        };
      }
      await L.sleep(poll);
    }
  },
/**
   * waitfortext <textRegex> [--timeout ms] [--poll ms] [--selector <css>]
   * Text-based readiness. Selectors break across sites; prose does not.
   */
  waitfortext: async (pattern, flags = {}) => {
    if (!pattern) throw new Error('waitfortext: usage: waitfortext <textRegex> [--timeout ms]');
    const re = L.toRegExp(pattern, 'textRegex');
    const timeout = flags.timeout === undefined ? 15000 : Number(flags.timeout);
    const poll = flags.poll === undefined ? 400 : Number(flags.poll);
    const selector = optStr(flags, 'selector');
    const start = Date.now();
    const deadline = start + timeout;

    const readText = selector
      ? () => L.evalBody(function (sel) {
        var el = document.querySelector(sel);
        return el ? (el.innerText || el.textContent || '') : '';
      }, selector)
      : async () => String(await L.live(['text']) || '');

    for (;;) {
      const text = await readText();
      const match = text.match(re);
      if (match) {
        return L.ok('waitfortext', { found: true, match: match[0], waitedMs: Date.now() - start });
      }
      if (Date.now() >= deadline) {
        return {
          ok: false, cmd: 'waitfortext',
          error: `text ${pattern} not found within ${timeout}ms`,
          result: { found: false, excerpt: text.slice(0, 300) },
        };
      }
      await L.sleep(poll);
    }
  },

  /**
   * settle [<selector>] [--timeout ms] [--quiet ms]
   * Wait until the DOM stops changing instead of sleeping a fixed guess.
   * The corpus hardcodes waitForTimeout(2500/3500) in 42 places; those
   * are tuned magic numbers, not readiness checks.
   */
  settle: async (selector, flags = {}) => {
    const timeout = flags.timeout === undefined ? 10000 : Number(flags.timeout);
    const quiet = flags.quiet === undefined ? 600 : Number(flags.quiet);
    const sel = selector === undefined || selector === true ? null : String(selector);
    const start = Date.now();
    const deadline = start + timeout;

    const snapshot = () => (sel
      ? L.evalBody(function (s) {
        var el = document.querySelector(s);
        if (!el) return null;
        return (el.innerText || '').length + ':' + el.children.length;
      }, sel)
      : L.evalBody(function () {
        return document.querySelectorAll('*').length + ':' + (document.body ? document.body.innerText.length : 0);
      }));

    let last = await snapshot();
    let stableSince = Date.now();
    for (;;) {
      await L.sleep(quiet);
      const now = await snapshot();
      if (now !== last) { last = now; stableSince = Date.now(); }
      else if (Date.now() - stableSince >= quiet) {
        return L.ok('settle', { settled: true, snapshot: now, waitedMs: Date.now() - start });
      }
      if (Date.now() >= deadline) {
        return {
          ok: false, cmd: 'settle',
          error: `DOM still changing after ${timeout}ms`,
          result: { settled: false, snapshot: now, selector: sel },
        };
      }
    }
  },

  /* ------------------------- field setting ------------------------ */
  /**
   * setvalue <css> <text> [--mode auto|native|handler|select] [--nth N]
   *
   * React-safe field setting. `browser fill` writes .value without the
   * native setter, so React never observes the change and the field
   * resets on submit. Three mechanisms exist and they are NOT
   * interchangeable (docs/COMMANDS.md §G1.1):
   *
   *   native  — prototype value setter + input/change events.
   *   handler — call React's own onChange via __reactProps. Required for
   *             fully controlled forms, where `native` leaves the DOM and
   *             the cached props looking correct while React still
   *             submits empty state. That failure is SILENT, so `auto`
   *             picks by inspecting the element and then VERIFIES.
   *   select  — plain assignment, for <select>.
   */
  setvalue: async (css, text, flags = {}) => {
    if (!css) throw new Error('setvalue: usage: setvalue <css> <text> [--mode auto|native|handler|select]');
    const mode = flags.mode === undefined || flags.mode === true ? 'auto' : String(flags.mode);
    const value = text === undefined ? '' : String(text);

    const applied = await L.evalBody(function (spec) {
      var sel = spec.sel, val = spec.val, mode = spec.mode, nth = spec.nth;
      var els = Array.prototype.slice.call(document.querySelectorAll(sel));
      var el = els[nth];
      if (!el) return { ok: false, reason: 'no-match', matches: els.length };

      var before = el.value;
      var hasReactProps = Object.keys(el).some(function (k) { return k.indexOf('__reactProps') === 0; });
      var strategy = mode;
      if (mode === 'auto') {
        strategy = el.tagName === 'SELECT' ? 'select' : (hasReactProps ? 'handler' : 'native');
      }

      try {
        if (strategy === 'select') {
          el.value = val;
        } else if (strategy === 'handler') {
          var key = Object.keys(el).find(function (x) { return x.indexOf('__reactProps') === 0; });
          if (!key) return { ok: false, reason: 'no-react-props', strategy };
          el[key].onChange({ target: { value: val } });
        } else {
          var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {
        return { ok: false, reason: 'threw', strategy, error: String((e && e.message) || e) };
      }

      return {
        ok: true, strategy, before: before, after: el.value,
        matches: els.length, tag: el.tagName.toLowerCase(),
        verified: el.value === val,
      };
    }, { sel: css, val: value, mode, nth: nthOf(flags) });

    if (!applied || applied.ok !== true) {
      return {
        ok: false, cmd: 'setvalue',
        error: `setvalue failed: ${(applied && applied.reason) || 'unknown'}`,
        result: { selector: css, requestedMode: mode, detail: applied },
      };
    }
    return L.ok('setvalue', { selector: css, requestedMode: mode, ...applied });
  },

  /**
   * fillmap <valuesJson> --rules <json> [--dry-run]
   * Fill many fields in one pass where the rules are DATA, not code. The
   * corpus ships a job-application schema hardcoded in a helper; the
   * mechanism is the valuable part, so the vocabulary is a parameter.
   *
   *   values: {"email":"a@b.c"}
   *   rules:  [{"match":"email","valueFrom":"email","mode":"auto"}]
   *
   * A rule with "css" targets a selector directly; otherwise fields are
   * matched by regex over name/id/placeholder/aria-label/type.
   */
  fillmap: async (valuesJson, flags = {}) => {
    if (!valuesJson) throw new Error('fillmap: usage: fillmap <valuesJson> --rules <json>');
    const values = L.readJsonArg(valuesJson, 'values json');
    if (flags.rules === undefined || flags.rules === true) throw new Error('fillmap: --rules <json> is required');
    const rules = L.readJsonArg(flags.rules, '--rules');
    if (!Array.isArray(rules)) throw new Error('fillmap: --rules must be a JSON array');

    const applied = await L.evalBody(function (spec) {
      var values = spec.values, rules = spec.rules;
      var done = [];

      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        var val = values[rule.valueFrom];
        if (val === undefined || val === '') { done.push({ rule: i, filled: false, reason: 'no-value' }); continue; }

        var el = null;
        if (rule.css) {
          el = document.querySelector(rule.css);
        } else if (rule.match) {
          var re = new RegExp(rule.match, 'i');
          var all = Array.prototype.slice.call(
            document.querySelectorAll('input:not([type=hidden]),textarea,select'));
          el = all.find(function (c) {
            var key = [c.name, c.id, c.placeholder, c.getAttribute('aria-label'), c.type]
              .filter(Boolean).join(' ').toLowerCase();
            return re.test(key);
          }) || null;
        }
        if (!el) { done.push({ rule: i, filled: false, reason: 'no-match' }); continue; }

        var hasReactProps = Object.keys(el).some(function (k) { return k.indexOf('__reactProps') === 0; });
        var mode = rule.mode || 'auto';
        if (mode === 'auto') mode = el.tagName === 'SELECT' ? 'select' : (hasReactProps ? 'handler' : 'native');

        try {
          if (mode === 'select') {
            el.value = val;
          } else if (mode === 'handler') {
            var key = Object.keys(el).find(function (x) { return x.indexOf('__reactProps') === 0; });
            if (!key) { done.push({ rule: i, filled: false, reason: 'no-react-props' }); continue; }
            el[key].onChange({ target: { value: val } });
          } else {
            var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
          done.push({ rule: i, filled: true, tag: el.tagName.toLowerCase(), mode: mode, verified: el.value === val });
        } catch (e) {
          done.push({ rule: i, filled: false, reason: 'threw', error: String((e && e.message) || e) });
        }
      }
      return done;
    }, { values, rules });

    const filled = applied.filter((d) => d.filled).length;
    return L.ok('fillmap', {
      filled,
      skipped: applied.length - filled,
      dryRun: flags['dry-run'] === true,
      results: applied,
    });
  },

  /* --------------------------- clicking --------------------------- */
  /**
   * clicktext <textRegex> [--nth N] [--exact]
   * Click by visible label. Some sites put the target in a <button>
   * attribute rather than an <a href>, so selector matching cannot find
   * it — matching on text can.
   */
  clicktext: async (pattern, flags = {}) => {
    if (!pattern) throw new Error('clicktext: usage: clicktext <textRegex> [--nth N] [--exact]');
    const re = L.toRegExp(pattern, 'textRegex');
    const exact = flags.exact === true || flags.exact === 'true';

    const res = await L.evalBody(function (spec) {
      var re = new RegExp(spec.source, spec.f);
      var els = Array.prototype.slice.call(
        document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button]'));
      var hits = els.filter(function (e) {
        var t = (e.innerText || e.value || '').trim();
        if (!t) return false;
        return spec.exact ? t === spec.text : re.test(t);
      });
      var el = hits[spec.nth];
      if (!el) return { clicked: false, candidates: hits.length };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { clicked: true, candidates: hits.length, text: (el.innerText || el.value || '').trim().slice(0, 80) };
    }, { source: re.source, f: re.flags.replace(/g/g, ''), text: String(pattern), exact, nth: nthOf(flags) });

    return L.ok('clicktext', { pattern, ...res });
  },

  /**
   * click <css> [--nth N]
   * A `browser click` that can target the Nth match and reports how many
   * matched, so an agent can tell "not found" from "clicked the wrong one".
   */
  click: async (css, flags = {}) => {
    if (!css) throw new Error('click: usage: click <css> [--nth N]');
    const res = await L.evalBody(function (spec) {
      var els = Array.prototype.slice.call(document.querySelectorAll(spec.sel));
      var el = els[spec.nth];
      if (!el) return { clicked: false, matches: els.length };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return {
        clicked: true, matches: els.length,
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || '').trim().slice(0, 80),
      };
    }, { sel: css, nth: nthOf(flags) });
    return L.ok('click', { selector: css, ...res });
  },

  /**
   * clickpoint <css> [--nth N] [--offset X,Y]
   * UNSUPPORTED via live.js: a trusted mouse event needs CDP
   * Input.dispatchMouseEvent, which live.js does not expose. Reported
   * honestly rather than silently falling back to el.click(), which will
   * not open native menus or file choosers.
   */
  clickpoint: async (css) => ({
    ok: false, cmd: 'clickpoint',
    error: 'clickpoint needs raw CDP (Input.dispatchMouseEvent), which scripts/live.js does not expose',
    result: {
      unsupported: true,
      selector: css,
      workaround: 'use `click` for DOM clicks, or dispatch Input.dispatchMouseEvent from a script attached to the same CDP endpoint',
    },
  }),

  /* -------------------------- inspection -------------------------- */
  /**
   * errors [--css <sel>] [--limit N]
   * Why did the form refuse to submit? Scans for invalid fields and
   * walks up each one looking for a nearby message. Without this, a
   * failed submit is indistinguishable from a slow network.
   */
  errors: async (flags = {}) => {
    const limit = flags.limit === undefined ? 40 : Number(flags.limit);
    const selector = optStr(flags, 'css');
    const found = await L.evalBody(function (spec) {
      var sel = spec.sel || '[aria-invalid="true"], .error, .invalid, [data-error], [role=alert]';
      var els = Array.prototype.slice.call(document.querySelectorAll(sel)).slice(0, spec.limit);
      return els.map(function (el) {
        var msg = '';
        var p = el.closest('div, fieldset, form') || el.parentElement;
        for (var i = 0; p && i < 4; i += 1, p = p.parentElement) {
          var t = (p.textContent || '').trim();
          if (t && t.length < 160) { msg = t; break; }
        }
        return {
          field: el.id || el.name || el.tagName.toLowerCase(),
          ariaInvalid: el.getAttribute('aria-invalid'),
          message: msg.slice(0, 160),
        };
      });
    }, { sel: selector, limit });
    return L.ok('errors', { count: found.length, selector: selector || 'default', errors: found });
  },

  /**
   * scrollto <css> [--offset N] [--block start|center|end]
   * Scroll an element into view before interacting. Off-screen clicks
   * land on whatever is actually under the coordinates.
   */
  scrollto: async (css, flags = {}) => {
    if (!css) throw new Error('scrollto: usage: scrollto <css> [--offset N]');
    const block = flags.block === undefined || flags.block === true ? 'center' : String(flags.block);
    const offset = flags.offset === undefined ? 0 : Number(flags.offset);
    const res = await L.evalBody(function (spec) {
      var el = document.querySelector(spec.sel);
      if (!el) return { scrolled: false, reason: 'no-match' };
      el.scrollIntoView({ block: spec.block, behavior: 'smooth' });
      var r = el.getBoundingClientRect();
      return {
        scrolled: true, top: Math.round(r.top), left: Math.round(r.left),
        width: Math.round(r.width), height: Math.round(r.height), offset: spec.offset,
      };
    }, { sel: css, block, offset });
    return L.ok('scrollto', { selector: css, block, ...res });
  },

  /**
   * find <selector|textRegex> [--text] [--nth N] [--limit N]
   * Discover selectors and labels without dumping the whole page. This is
   * the cheap first move before any interaction, and replaces the habit
   * of dumping 4000 characters of text to find one id.
   */
  find: async (pattern, flags = {}) => {
    if (!pattern) throw new Error('find: usage: find <selector|textRegex> [--text] [--nth N]');
    const byText = flags.text === true || flags.text === 'true';
    const limit = flags.limit === undefined ? 30 : Number(flags.limit);

    if (byText) {
      const re = L.toRegExp(pattern, 'textRegex');
      const hits = await L.evalBody(function (spec) {
        var re = new RegExp(spec.source, spec.f);
        return Array.prototype.slice.call(
          document.querySelectorAll('a,button,input,[role=button],label,h1,h2,h3'))
          .map(function (e) { return { el: e, text: (e.innerText || e.value || '').trim() }; })
          .filter(function (x) { return x.text && re.test(x.text); })
          .slice(0, spec.limit)
          .map(function (x) {
            return {
              tag: x.el.tagName.toLowerCase(),
              text: x.text.slice(0, 100),
              id: x.el.id || null,
              name: x.el.name || null,
              selector: x.el.id ? '#' + CSS.escape(x.el.id) : null,
            };
          });
      }, { source: re.source, f: re.flags.replace(/g/g, ''), limit });
      return L.ok('find', { pattern, by: 'text', count: hits.length, matches: hits });
    }

    const hits = await L.evalBody(function (spec) {
      return Array.prototype.slice.call(document.querySelectorAll(spec.sel))
        .slice(0, spec.limit)
        .map(function (el) {
          var r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || null,
            name: el.name || null,
            type: el.type || null,
            placeholder: el.placeholder || null,
            text: (el.innerText || el.value || '').trim().slice(0, 80),
            visible: r.width > 0 && r.height > 0,
          };
        });
    }, { sel: pattern, limit });
    return L.ok('find', { pattern, by: 'selector', count: hits.length, matches: hits });
  },

  /**
   * localstorage [key] [value]
   * Read or write page storage. The agent-tab marker contract
   * (__sb_agent_id) is persisted this way so a tab can be rediscovered
   * after the process that created it exits.
   */
  localstorage: async (key, value) => {
    if (key === undefined || key === true) {
      const all = await L.evalBody(function () {
        var out = {};
        try {
          for (var i = 0; i < localStorage.length; i += 1) {
            var k = localStorage.key(i);
            out[k] = localStorage.getItem(k);
          }
        } catch (e) { return { error: String(e.message) }; }
        return out;
      });
      return L.ok('localstorage', { all });
    }
    if (value === undefined || value === true) {
      const got = await L.evalBody(function (k) {
        try { return { key: k, value: localStorage.getItem(k), present: localStorage.getItem(k) !== null }; }
        catch (e) { return { key: k, error: String(e.message) }; }
      }, String(key));
      return L.ok('localstorage', got);
    }
    const set = await L.evalBody(function (spec) {
      try {
        localStorage.setItem(spec.key, spec.value);
        return { key: spec.key, stored: true, readback: localStorage.getItem(spec.key) };
      } catch (e) { return { key: spec.key, stored: false, error: String(e.message) }; }
    }, { key: String(key), value: String(value) });
    return L.ok('localstorage', set);
  },

  /**
   * inject <file>
   * Run a script in the current page and remember it. stealth.js and
   * overlay.js are only ever installed at context creation, so there was
   * no way to iterate on one against an already-running browser.
   */
  inject: async (file) => {
    if (!file) throw new Error('inject: usage: inject <file.js>');
    const p = path.resolve(String(file));
    if (!fs.existsSync(p)) throw new Error(`inject: file not found: ${p}`);
    const source = fs.readFileSync(p, 'utf8');

    const applied = await L.evalInPage(`(function(){${source};return true;})()`);
    L.writeStore((s) => {
      if (!s.injected) s.injected = {};
      s.injected[p] = source;
    });
    return L.ok('inject', {
      file: p, bytes: source.length, applied: applied !== false,
      note: 'also stored under the ext store so it can be re-applied after navigation',
    });
  },

  /* -------------------------- control flow ------------------------ */
  /**
   * toggle <css> [state] [--nth N]
   * Read or set a toggle/radio/checkbox state. Distinct from `click`:
   * this reports the state and can set it idempotently, and for React
   * widgets it calls the component's own handler.
   */
  toggle: async (css, state, flags = {}) => {
    if (!css) throw new Error('toggle: usage: toggle <css> [true|false] [--nth N]');
    const want = state === undefined || state === true
      ? null
      : /^(0|false|off|no)$/i.test(String(state)) ? false : true;

    const res = await L.evalBody(function (spec) {
      var els = Array.prototype.slice.call(document.querySelectorAll(spec.sel));
      var el = els[spec.nth];
      if (!el) return { found: false, matches: els.length };

      var read = function () {
        if (el.getAttribute) {
          var ac = el.getAttribute('aria-checked');
          if (ac !== null) return ac === 'true';
        }
        return !!(el.checked !== undefined ? el.checked : el.getAttribute('selected') === 'true');
      };

      var before = read();
      if (spec.want === null || before === spec.want) return { found: true, before: before, after: before, changed: false };

      var hasReactProps = Object.keys(el).some(function (k) { return k.indexOf('__reactProps') === 0; });
      if (hasReactProps) {
        var key = Object.keys(el).find(function (x) { return x.indexOf('__reactProps') === 0; });
        var props = el[key];
        if (props.onClick) props.onClick({});
        else if (props.onChange) props.onChange({ target: { checked: spec.want } });
      } else {
        el.click();
      }
      return { found: true, before: before, after: read(), changed: read() !== before, wanted: spec.want };
    }, { sel: css, nth: nthOf(flags), want });

    return L.ok('toggle', { selector: css, ...res });
  },

  /**
   * assert [--css <sel>] [--absent <sel>] [--url-matches re] [--text-matches re]
   * Check a precondition or postcondition and get a structured verdict
   * instead of a stack trace. Returns ok:false (exit 1) on failure, so it
   * composes in a shell `&&` chain.
   */
  assert: async (flags = {}) => {
    const css = optStr(flags, 'css');
    const absent = optStr(flags, 'absent');
    const urlRe = optStr(flags, 'url-matches');
    const textRe = optStr(flags, 'text-matches');
    if (!css && !absent && !urlRe && !textRe) {
      throw new Error('assert: need at least one of --css, --absent, --url-matches, --text-matches');
    }

    const checks = {};
    if (css) checks.css = await L.evalBody(function (s) { return document.querySelectorAll(s).length; }, css);
    if (absent) checks.absent = await L.evalBody(function (s) { return document.querySelectorAll(s).length; }, absent);
    if (urlRe) checks.url = String(await L.live(['url']) || '');
    if (textRe) checks.text = String(await L.live(['text']) || '').slice(0, 4000);

    const failures = [];
    if (css && !(checks.css > 0)) failures.push(`no element matches ${css}`);
    if (absent && checks.absent > 0) failures.push(`${absent} is present (${checks.absent} matches)`);
    if (urlRe && !new RegExp(urlRe, 'i').test(checks.url)) failures.push(`url ${checks.url} does not match ${urlRe}`);
    if (textRe && !new RegExp(textRe, 'i').test(checks.text)) failures.push(`text does not match ${textRe}`);

    return failures.length
      ? { ok: false, cmd: 'assert', error: failures.join('; '), result: { passed: false, failures, checks } }
      : L.ok('assert', { passed: true, failures: [], checks });
  },

  /**
   * guard --name <n> --requires <cmd>... --runs <cmd>... [--then <cmd>...]
   * Precondition, action and postcondition in one call. Each step is a
   * live.js verb written "cmd:arg1,arg2", so a failure reports WHICH step
   * broke rather than an opaque stack trace.
   */
  guard: async (flags = {}) => {
    const name = optStr(flags, 'name') || 'guard';
    const asList = (v) => (v === undefined ? []
      : [].concat(v).flatMap((x) => String(x).split(',')).map((s) => s.trim()).filter(Boolean));
    const requires = asList(flags.requires);
    const runs = asList(flags.runs);
    const then = asList(flags.then);
    if (!requires.length && !runs.length) {
      throw new Error('guard: need --requires and/or --runs (comma-separated live.js verbs like "goto:https://x")');
    }

    const steps = [];
    const runStep = async (spec) => {
      const [cmd, ...rest] = String(spec).split(':');
      try {
        const value = await L.live([cmd, ...rest]);
        steps.push({ step: spec, ok: true, value });
        return { ok: true };
      } catch (e) {
        steps.push({ step: spec, ok: false, error: String(e.message) });
        return { ok: false };
      }
    };

    for (const phase of [['requires', requires], ['runs', runs], ['then', then]]) {
      for (const step of phase[1]) {
        const r = await runStep(step);
        if (!r.ok) {
          return {
            ok: false, cmd: 'guard',
            error: `${name}: ${phase[0]} step failed at "${step}"`,
            result: { name, phase: phase[0], steps },
          };
        }
      }
    }
    return L.ok('guard', { name, passed: true, steps: steps.length, results: steps });
  },

  /**
   * retry --cmd <liveVerb> [--arg <v>]... [--times N] [--on <regex>]
   *        [--reset <liveVerb>] [--wait ms]
   * Retry a live.js verb. The corpus has 37 hand-rolled retry loops; the
   * important part is --reset, because a failed controlled-form attempt
   * poisons the next one unless the page is re-navigated first.
   */
  retry: async (flags = {}) => {
    const cmd = optStr(flags, 'cmd');
    if (!cmd) throw new Error('retry: --cmd <liveVerb> is required');
    const times = flags.times === undefined ? 3 : Number(flags.times);
    const wait = flags.wait === undefined ? 1000 : Number(flags.wait);
    const onRe = optStr(flags, 'on');
    const reset = optStr(flags, 'reset');
    const args = [].concat(flags.arg === undefined ? [] : flags.arg).map(String);

    const attempts = [];
    for (let i = 1; i <= times; i += 1) {
      if (i > 1 && reset) {
        try { await L.live([reset]); }
        catch (e) { attempts.push({ attempt: i, resetError: String(e.message) }); }
      }
      try {
        const value = await L.live([cmd, ...args]);
        attempts.push({ attempt: i, ok: true });
        return L.ok('retry', { cmd, attempts: i, succeeded: true, history: attempts, value });
      } catch (e) {
        const message = String(e.message);
        attempts.push({ attempt: i, ok: false, error: message });
        // With --on, retry ONLY matching errors. Without it every failure
        // is retryable, which risks looping on a typo.
        if (onRe && !new RegExp(onRe, 'i').test(message)) {
          return {
            ok: false, cmd: 'retry',
            error: `non-retryable error (does not match ${onRe}): ${message}`,
            result: { cmd, attempts: i, succeeded: false, history: attempts },
          };
        }
        if (i < times) await L.sleep(wait);
      }
    }
    return {
      ok: false, cmd: 'retry',
      error: `${cmd} failed after ${times} attempts`,
      result: { cmd, attempts: times, succeeded: false, history: attempts },
    };
  },

  /**
   * paginate <nextSelector> [--max N] [--until-empty] [--collect <sel>] [--wait ms]
   * Repeat "click next, collect, stop when nothing new". Both listing
   * scrapers in the corpus hand-roll this, differently.
   */
  paginate: async (nextSelector, flags = {}) => {
    if (!nextSelector) throw new Error('paginate: usage: paginate <nextSelector> [--max N] [--until-empty]');
    const max = flags.max === undefined ? 10 : Number(flags.max);
    const untilEmpty = flags['until-empty'] === true || flags['until-empty'] === 'true';
    const collect = optStr(flags, 'collect');
    const wait = flags.wait === undefined ? 1200 : Number(flags.wait);
    const pages = [];

    for (let i = 0; i < max; i += 1) {
      const page = await L.evalBody(function (spec) {
        var rows = [];
        if (spec.collect) {
          rows = Array.prototype.slice.call(document.querySelectorAll(spec.collect))
            .map(function (e) { return (e.innerText || '').trim().slice(0, 200); })
            .filter(Boolean);
        }
        var next = document.querySelector(spec.next);
        return {
          rows: rows,
          rowCount: rows.length,
          hasNext: !!next && !next.disabled && next.getAttribute('aria-disabled') !== 'true',
        };
      }, { collect, next: nextSelector });

      pages.push({ page: i + 1, rowCount: page.rowCount, hasNext: page.hasNext, rows: page.rows });
      if (!page.hasNext) break;
      if (untilEmpty && page.rowCount === 0) break;

      await L.evalBody(function (sel) {
        var next = document.querySelector(sel);
        if (!next) return false;
        next.scrollIntoView({ block: 'center' });
        next.click();
        return true;
      }, nextSelector);
      await L.sleep(wait);
    }
    return L.ok('paginate', { pages: pages.length, collect, results: pages });
  },

  /**
   * run <jsonArray> [--stop-on-error]
   * Execute a list of live.js verbs in ONE process instead of N spawns.
   * This formalises live.js's existing --stdin mode as a single verb.
   * Steps are {"cmd":"goto","args":["https://…"]}; every result carries
   * its index so a mid-batch failure is locatable.
   */
  run: async (stepsJson, flags = {}) => {
    if (!stepsJson) throw new Error('run: usage: run <jsonArray> [--stop-on-error]');
    const parsed = L.readJsonArg(stepsJson, 'steps json');
    const steps = Array.isArray(parsed) ? parsed : [parsed];
    const stopOnError = flags['stop-on-error'] === true || flags['stop-on-error'] === 'true';

    const results = [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i] || {};
      const cmd = String(step.cmd || '');
      const args = [].concat(step.args || [])
        .filter((a) => a !== undefined && a !== null).map(String);
      try {
        const value = await L.live([cmd, ...args]);
        results.push({ index: i, cmd, ok: true, value });
      } catch (e) {
        results.push({ index: i, cmd, ok: false, error: String(e.message) });
        if (stopOnError) {
          return {
            ok: false, cmd: 'run',
            error: `step ${i} (${cmd}) failed: ${e.message}`,
            result: { total: steps.length, ran: results.length, stoppedAt: i, results },
          };
        }
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    return L.ok('run', {
      total: steps.length, ran: results.length,
      succeeded: results.length - failed, failed, results,
    });
  },

  /**
   * runext <script.js> [args...]
   * Run a stored script against the LIVE browser via scripts/live-run.js,
   * which redirects its chromium.launch to connectOverCDP and suppresses
   * close() so the session survives. Exposed here so an agent never has
   * to shell out to the runner itself.
   */
  runext: async (...args) => {
    const { positional } = split(args);
    if (!positional.length) throw new Error('runext: usage: runext <script.js> [args...]');
    const script = path.resolve(positional[0]);
    if (!fs.existsSync(script)) throw new Error(`runext: script not found: ${script}`);

    const runner = path.resolve(__dirname, '..', '..', 'scripts', 'live-run.js');
    const { spawn } = require('child_process');
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [runner, script, ...positional.slice(1)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });

    if (output.code !== 0) {
      return {
        ok: false, cmd: 'runext',
        error: output.stderr.trim() || `script exited ${output.code}`,
        result: { script, exitCode: output.code, stdout: output.stdout.slice(-4000) },
      };
    }
    return L.ok('runext', { script, exitCode: 0, stdout: output.stdout.slice(-4000) });
  },


  /**
   * dismiss [--text <re>] [--nth N] [--all] [--scope <css>]
   * Remove a consent/banner obstruction. The text pattern is a PARAMETER
   * — the corpus hardcoded one vendor's cookie banner and every other
   * site needed its own copy-pasted block.
   */
  dismiss: async (flags = {}) => {
    const pattern = optStr(flags, 'text');
    const scope = optStr(flags, 'scope');
    const all = flags.all === true || flags.all === 'true';

    const res = await L.evalBody(function (spec) {
      var re = spec.text ? new RegExp(spec.text, 'i') : null;
      var root = spec.scope ? document.querySelector(spec.scope) : document;
      if (!root) return { dismissed: 0, reason: 'bad-scope' };

      var els = Array.prototype.slice.call(
        root.querySelectorAll('button,a,[role=button],input[type=button],input[type=submit]'));
      var hits = els.filter(function (e) {
        var t = (e.innerText || e.value || '').trim();
        return t && (re ? re.test(t) : /^(accept|agree|accept all|allow all|i agree|got it|ok|close|dismiss)/i.test(t));
      });

      var targets = spec.all ? hits : hits.slice(0, 1);
      targets.forEach(function (e) { try { e.click(); } catch (err) { /* ignore */ } });
      return {
        dismissed: targets.length,
        candidates: hits.length,
        texts: hits.slice(0, 5).map(function (e) { return (e.innerText || e.value || '').trim().slice(0, 40); }),
      };
    }, { text: pattern, scope, all });

    return L.ok('dismiss', { pattern: pattern || 'default-consent-verbs', ...res });
  },

  /**
   * sniff [--text N]
   * url + title + inputs + buttons + text in ONE spawn. Today that is
   * five separate commands and five Node cold starts.
   */
  sniff: async (flags = {}) => {
    const textLimit = flags.text === undefined || flags.text === true ? 4000 : Number(flags.text);
    const data = await L.live(['dump']);
    const text = String(await L.live(['text']) || '').replace(/\n+/g, ' | ').slice(0, textLimit);
    return L.ok('sniff', {
      url: data && data.url,
      title: data && data.title,
      inputs: (data && data.inputs) || [],
      buttons: (data && data.buttons) || [],
      links: (data && data.links) || [],
      text,
    });
  },

  /**
   * upload <css> <file>
   * UNSUPPORTED via live.js: a file may only be attached with CDP
   * DOM.setFileInputFiles against the backendNodeId reported by
   * Page.fileChooserOpened, and only while the chooser is open — setting
   * it on a node from DOM.querySelector silently fails.
   */
  upload: async (css, file) => ({
    ok: false, cmd: 'upload',
    error: 'upload needs raw CDP (DOM.setFileInputFiles on the fileChooserOpened backendNodeId), which scripts/live.js does not expose',
    result: {
      unsupported: true,
      selector: css,
      file: file || null,
      fileExists: file ? fs.existsSync(path.resolve(String(file))) : null,
      workaround: 'see acceptNextChooser in scripts/gumroad-upload.js for a working CDP implementation',
    },
  }),
};
