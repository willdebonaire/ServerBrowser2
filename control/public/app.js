'use strict';
/* ServerBrowser control panel UI — vanilla JS, gitpage design language. */

/* ------------------------------------------------------------- helpers */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(kind, msg, title) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${title ? `<div class="t-title">${esc(title)}</div>` : ''}${esc(msg)}`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 450); }, kind === 'err' ? 9000 : 5500);
}

function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    const modal = $('#modal');
    $('#modal-title').textContent = title;
    $('#modal-text').textContent = text;
    $('#modal-ok').textContent = okLabel;
    modal.hidden = false;
    const done = (v) => {
      modal.hidden = true;
      $('#modal-ok').onclick = null;
      $('#modal-cancel').onclick = null;
      resolve(v);
    };
    $('#modal-ok').onclick = () => done(true);
    $('#modal-cancel').onclick = () => done(false);
  });
}

const fmtUptime = (ms) => {
  if (ms == null) return '';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString() : '—');

/* ------------------------------------------------------------- app state */
const sessions = new Map();          // name → server view
const ui = {};                       // name → {embed, logs, settings, lines, shot}
let sseConnected = false;

// P4 scripts / runs + P5 browsers
let scripts = [];                    // [{name,size,mtime}]
let runs = [];                       // run views (newest first)
let browsers = [];                   // definitions
let localCandidates = null;          // [{port,browser}] after a scan
const uiScripts = {};                // script name → {editing,renaming,runForm,content}
const uiBrowsers = {};               // def id → {editing,pwPrompt}
const runLines = {};                 // run id → string[]
let openRunId = null;

function uiFor(name) {
  if (!ui[name]) ui[name] = { embed: false, logs: false, settings: false, lines: null, shot: null, shotAt: 0 };
  return ui[name];
}
const upsert = (view) => sessions.set(view.name, view);
const sorted = () => [...sessions.values()].sort((a, b) => a.name.localeCompare(b.name));

function isEditing() {
  const el = document.activeElement;
  return !!(el && el.closest && el.closest('input, select, textarea'));
}

/* ------------------------------------------------------------- rendering */
let renderTimer = null;
let pendingRender = false;

function scheduleRender() {
  if (isEditing()) { pendingRender = true; return; }
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}
setInterval(() => {
  if (pendingRender && !isEditing()) { pendingRender = false; scheduleRender(); }
}, 1500);

function render() {
  const grid = $('#sessions-grid');
  const list = sorted();
  grid.innerHTML = list.map(cardHTML).join('');
  $('#sessions-empty').hidden = list.length > 0;
  $('#st-sessions').textContent = String(list.length);
  const live = list.filter((s) => s.state === 'running').length;
  $('#st-running').textContent = String(live);
  $('#st-running').className = live ? 'ok' : '';
}

function viewerUrlOf(s) {
  return `${location.protocol}//${location.hostname}:${s.config.webPort}${s.viewerPath}`;
}

function chipsHTML(s) {
  const h = s.health || {};
  const c = (label, ok) => `<span class="chip ${ok == null ? '' : ok ? 'ok' : 'bad'}"><span class="k">${label}</span> ${ok == null ? '?' : ok ? 'up' : 'down'}</span>`;
  return `<div class="chips">
    ${c('web', h.web)}${c('cdp', h.cdp)}${c('rfb', h.rfb)}
    <span class="chip">:${s.config.webPort} / :${s.config.rfbPort} / :${s.config.cdpPort}</span>
    <span class="chip">display :${s.config.display}</span>
    ${s.adopted ? '<span class="chip">adopted</span>' : ''}
  </div>`;
}

function cardHTML(s) {
  const u = uiFor(s.name);
  const cfg = s.config;
  const live = ['running', 'degraded'].includes(s.state);
  const busy = ['starting', 'stopping'].includes(s.state);
  const screen = cfg.screen.split('x').slice(0, 2).join(' × ');
  const buttons = [];
  if (busy) {
    buttons.push(`<span class="btn ghost small is-busy">${esc(s.state)}…</span>`);
  } else if (live) {
    buttons.push(`<a class="btn primary small" href="${esc(viewerUrlOf(s))}" target="_blank" rel="noopener">Open VNC ↗</a>`);
    buttons.push(`<button class="btn ghost small" data-action="embed" data-name="${esc(s.name)}">${u.embed ? 'Hide viewer' : 'Embed viewer'}</button>`);
    buttons.push(`<button class="btn ghost small" data-action="snapshot" data-name="${esc(s.name)}">Snapshot</button>`);
    buttons.push(`<button class="btn ghost small" data-action="restart" data-name="${esc(s.name)}">Restart</button>`);
    buttons.push(`<button class="btn danger small" data-action="shutdown" data-name="${esc(s.name)}">Shut down</button>`);
  } else {
    buttons.push(`<button class="btn primary small" data-action="start" data-name="${esc(s.name)}">▶ Start</button>`);
    buttons.push(`<button class="btn danger small" data-action="delete" data-name="${esc(s.name)}">Remove</button>`);
  }
  buttons.push(`<button class="btn ghost small" data-action="settings" data-name="${esc(s.name)}">${u.settings ? 'Close' : 'Settings'}</button>`);
  buttons.push(`<button class="btn ghost small" data-action="logs" data-name="${esc(s.name)}">${u.logs ? 'Hide logs' : 'Logs'}</button>`);

  return `<div class="card session" data-session="${esc(s.name)}">
    <div class="s-head">
      <span class="state ${esc(s.state)}">${esc(s.state)}</span>
      <h3>${esc(s.name)}</h3>
      <span class="uptime">${s.uptimeMs != null ? 'up ' + fmtUptime(s.uptimeMs) : (s.stoppedAt ? 'stopped ' + fmtTime(s.stoppedAt) : '')}</span>
    </div>
    ${chipsHTML(s)}
    <div class="meta">
      <div class="row"><span class="lbl">browser</span><span class="val">${esc(cfg.browser)} · ${esc(screen)} · depth ${esc(cfg.screen.split('x')[2] || '24')}</span></div>
      <div class="row"><span class="lbl">profile</span><span class="val">${esc(cfg.profile)}</span></div>
      <div class="row"><span class="lbl">start url</span><span class="val">${esc(cfg.startUrl || '(session default)')}</span></div>
      <div class="row"><span class="lbl">vnc pw</span><span class="val">${cfg.passwordSet ? 'set (rfbauth)' : 'none (-nopw)'}</span></div>
    </div>
    ${s.lastError && s.state !== 'running' ? `<div class="lasterr">${esc(s.lastError)}</div>` : ''}
    <div class="btnrow">${buttons.join('')}</div>
    ${u.shot ? `<div class="thumb-wrap"><img class="thumb" src="${u.shot}" alt="session snapshot"><span class="muted">first-tab screenshot · ${esc(u.shotAtText || '')}</span></div>` : ''}
    ${u.embed && live ? `<div class="embed-frame"><iframe src="${esc(viewerUrlOf(s))}" allow="clipboard-read; clipboard-write"></iframe></div>` : ''}
    ${u.settings ? settingsHTML(s) : ''}
    ${u.logs ? logsHTML(s) : ''}
  </div>`;
}

/* ------------------------------------------------- settings + logs panels */

function opt(value, label, cur) {
  return `<option value="${esc(value)}" ${String(cur) === String(value) ? 'selected' : ''}>${esc(label)}</option>`;
}

function settingsHTML(s) {
  const cfg = s.config;
  const v = cfg.viewer || {};
  return `<div class="settings-panel" data-settings="${esc(s.name)}">
    <div class="sect-title">Display &amp; session <span class="muted">(screen/browser/url apply on restart)</span></div>
    <div class="form-grid">
      <label>Screen (WxHxD or WxH)<input name="screen" value="${esc(cfg.screen)}" pattern="\d{3,4}x\d{3,4}(x\d{1,2})?"></label>
      <label>Browser
        <select name="browser">
          ${opt('chrome', 'chrome', cfg.browser)}${opt('chromium', 'chromium', cfg.browser)}${opt('firefox', 'firefox', cfg.browser)}
        </select>
      </label>
      <label>Start URL<input name="startUrl" value="${esc(cfg.startUrl || '')}" placeholder="(session default)"></label>
    </div>
    <div class="sect-title">noVNC viewer options <span class="muted">(verified against installed noVNC — link updates instantly)</span></div>
    <div class="form-grid">
      <label>Resize mode
        <select name="vResize">
          ${opt('', 'default (no resize)', v.resize || '')}
          ${opt('scale', 'scale — fit to window', v.resize)}
          ${opt('remote', 'remote — match client size', v.resize)}
          ${opt('none', 'none — native size', v.resize)}
        </select>
      </label>
      <label class="check-lbl">View only (no mouse/keyboard input)
        <span class="checkrow"><input type="checkbox" name="vViewOnly" ${v.viewOnly ? 'checked' : ''}> disabled in viewer</span>
      </label>
    </div>
    <div class="sect-title">VNC password <span class="muted">(x11vnc -rfbauth; first 8 chars are what VNC uses)</span></div>
    <div class="pw-row">
      <span class="pw-state ${cfg.passwordSet ? 'set' : ''}">${cfg.passwordSet ? '● password set' : '○ no password'}</span>
      <input type="password" name="vncPw" placeholder="new password" autocomplete="new-password">
      <button class="btn ghost small" data-action="set-pw" data-name="${esc(s.name)}" type="button">Set password</button>
      <button class="btn danger small" data-action="clear-pw" data-name="${esc(s.name)}" type="button" ${cfg.passwordSet ? '' : 'disabled'}>Clear</button>
    </div>
    <div class="btnrow">
      <button class="btn primary small" data-action="save-settings" data-name="${esc(s.name)}" type="button">Save settings</button>
      <button class="btn ghost small" data-action="restart" data-name="${esc(s.name)}" type="button">Restart now</button>
      <span class="muted" data-settings-msg="${esc(s.name)}"></span>
    </div>
  </div>`;
}

function logsHTML(s) {
  const u = uiFor(s.name);
  const lines = u.lines || [];
  return `<div class="term">
    <div class="term-bar">
      <span class="td" style="background:var(--green)"></span>
      <span class="td" style="background:var(--warn)"></span>
      <span class="td" style="background:var(--red)"></span>
      session log — ${esc(s.name)}
      <button class="btn ghost small" data-action="copy-logs" data-name="${esc(s.name)}" type="button" style="margin-left:auto;padding:3px 10px">Copy</button>
    </div>
    <pre data-log="${esc(s.name)}">${lines.length ? esc(lines.join('\n')) : '<span class="c">no log lines yet — start or restart the session</span>'}</pre>
  </div>`;
}

/* -------------------------------------------------- scripts view (P4) */

const STARTER = `#!/usr/bin/env node
// Runs on the LIVE browser via live-run.js — CDP attach, browser.close is
// suppressed, so the VNC view and logins survive the run.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();          // redirected to the live Chrome
  const page = browser.contexts()[0].pages()[0];
  await page.goto('https://example.com');
  console.log('title:', await page.title());
  await browser.close();                            // suppressed — browser stays open
})();
`;

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || '')))) out.push(m[1] != null ? m[1] : (m[2] != null ? m[2] : m[3]));
  return out;
}

function renderScripts() {
  $('#scripts-grid').innerHTML = scripts.map(scriptCardHTML).join('');
  $('#scripts-empty').hidden = scripts.length > 0;
}

function scriptCardHTML(s) {
  const u = uiScripts[s.name] || (uiScripts[s.name] = { editing: false, renaming: false, runForm: false, content: null });
  const live = sorted().filter((x) => ['running', 'degraded'].includes(x.state));
  let inner = '';
  let btns = [];
  if (u.editing) {
    inner = `<textarea class="code-area" data-editor="${esc(s.name)}" spellcheck="false">${esc(u.content == null ? 'loading…' : u.content)}</textarea>`;
    btns = [
      `<button class="btn primary small" data-action="sc-save" data-name="${esc(s.name)}" ${u.content == null ? 'disabled' : ''}>Save</button>`,
      `<button class="btn ghost small" data-action="sc-cancel" data-name="${esc(s.name)}">Cancel</button>`,
    ];
  } else if (u.renaming) {
    inner = `<div class="pw-row"><input data-rename="${esc(s.name)}" value="${esc(s.name)}"><button class="btn primary small" data-action="sc-rename-ok" data-name="${esc(s.name)}">Rename</button><button class="btn ghost small" data-action="sc-cancel" data-name="${esc(s.name)}">Cancel</button></div>`;
  } else if (u.runForm) {
    inner = `<div class="pw-row run-form">
      <select data-run-session="${esc(s.name)}">
        ${live.length ? live.map((x) => `<option value="${esc(x.name)}">${esc(x.name)} (:${x.config.cdpPort})</option>`).join('') : '<option value="">(no running session)</option>'}
      </select>
      <input data-run-args="${esc(s.name)}" placeholder="args — e.g. codes.csv &quot;hello world&quot; (optional)">
      <button class="btn primary small" data-action="sc-run-start" data-name="${esc(s.name)}" ${live.length ? '' : 'disabled'}>▶ Run</button>
      <button class="btn ghost small" data-action="sc-cancel" data-name="${esc(s.name)}">Cancel</button>
    </div>`;
  } else {
    inner = `<div class="meta"><div class="row"><span class="lbl">file</span><span class="val">${(s.size / 1024).toFixed(1)} KB · ${esc(new Date(s.mtime).toLocaleString())}</span></div></div>`;
    btns = [
      `<button class="btn ghost small" data-action="sc-edit" data-name="${esc(s.name)}">Edit</button>`,
      `<button class="btn primary small" data-action="sc-run" data-name="${esc(s.name)}" ${live.length ? '' : 'disabled title="start a session first"'}>▶ Run on…</button>`,
      `<button class="btn ghost small" data-action="sc-rename" data-name="${esc(s.name)}">Rename</button>`,
      `<button class="btn danger small" data-action="sc-delete" data-name="${esc(s.name)}">Delete</button>`,
    ];
  }
  return `<div class="card script" data-script="${esc(s.name)}">
    <div class="s-head"><h3>${esc(s.name)}</h3></div>
    ${inner}
    <div class="btnrow">${btns.join('')}</div>
  </div>`;
}

/* ---------------------------------------------------- runs view (P4) */

function runBadge(state) {
  const cls = { running: 'starting', done: 'running', error: 'error', killed: 'killed', interrupted: 'interrupted' }[state] || 'stopped';
  return `<span class="state ${cls}">${esc(state)}</span>`;
}

function renderRuns() {
  $('#runs-list').innerHTML = runs.map(runRowHTML).join('');
  $('#runs-empty').hidden = runs.length > 0;
}

function runRowHTML(r) {
  const dur = r.endedAt ? fmtUptime(r.endedAt - r.startedAt) : `${fmtUptime(Date.now() - r.startedAt)}…`;
  const open = openRunId === r.id;
  const lines = runLines[r.id] || [];
  const btns = [
    `<button class="btn ghost small" data-action="run-log-toggle" data-id="${esc(r.id)}">${open ? 'Hide log' : 'Log'}</button>`,
  ];
  if (r.state === 'running') {
    btns.push(`<button class="btn danger small" data-action="run-kill" data-id="${esc(r.id)}">Kill</button>`);
  }
  if (open && lines.length) {
    btns.push(`<button class="btn ghost small" data-action="run-copy" data-id="${esc(r.id)}">Copy</button>`);
  }
  return `<div class="card run-row" data-run="${esc(r.id)}">
    <div class="s-head">
      ${runBadge(r.state)}
      <h3>${esc(r.script)}</h3>
      <span class="uptime">${esc(r.session)} · ${esc(dur)} · ${esc(r.id)}</span>
    </div>
    ${r.args && r.args.length ? `<div class="meta"><div class="row"><span class="lbl">args</span><span class="val">${esc(r.args.join(' '))}</span></div></div>` : ''}
    ${r.error ? `<div class="lasterr">${esc(r.error)}</div>` : ''}
    <div class="btnrow">${btns.join('')}</div>
    ${open ? `<div class="term"><div class="term-bar"><span class="td" style="background:var(--green)"></span><span class="td" style="background:var(--warn)"></span><span class="td" style="background:var(--red)"></span> run log — ${esc(r.id)}</div><pre data-run-log="${esc(r.id)}">${lines.length ? esc(lines.join('\n')) : '<span class="c">loading…</span>'}</pre></div>` : ''}
  </div>`;
}

/* ------------------------------------------------- browsers view (P5) */

function renderBrowsers() {
  $('#browsers-grid').innerHTML = browsers.map(browserCardHTML).join('');
  $('#browsers-empty').hidden = browsers.length > 0;
  renderAttachRow();
}

function browserCardHTML(d) {
  const u = uiBrowsers[d.id] || (uiBrowsers[d.id] = { editing: false, pwPrompt: false });
  if (u.editing) {
    return `<div class="card browser" data-browser="${esc(d.id)}">
      <div class="s-head"><h3>${esc(d.label)}</h3><span class="uptime">${esc(d.id)} · editing</span></div>
      <div class="form-grid">
        <label>Label <input data-be="label" value="${esc(d.label)}"></label>
        <label>Browser
          <select data-be="browser">${['chrome', 'chromium', 'firefox'].map((b) => `<option value="${b}" ${d.browser === b ? 'selected' : ''}>${b}</option>`).join('')}</select>
        </label>
        <label>Screen <input data-be="screen" value="${esc(d.screen)}"></label>
        <label>Profile <input data-be="profile" value="${esc(d.profile || '')}"></label>
        <label>Start URL <input data-be="startUrl" value="${esc(d.startUrl || '')}"></label>
        <label>Web port <input data-be="webPort" value="${d.webPort || ''}" placeholder="auto"></label>
        <label>RFB port <input data-be="rfbPort" value="${d.rfbPort || ''}" placeholder="auto"></label>
        <label>CDP port <input data-be="cdpPort" value="${d.cdpPort || ''}" placeholder="auto"></label>
        <label>Display <input data-be="display" value="${d.display == null ? '' : d.display}" placeholder="auto"></label>
      </div>
      <label class="check-lbl"><span class="checkrow"><input type="checkbox" data-be="vncPassword" ${d.vncPassword ? 'checked' : ''}> VNC password at launch</span></label>
      <div class="btnrow">
        <button class="btn primary small" data-action="br-save" data-id="${esc(d.id)}">Save</button>
        <button class="btn ghost small" data-action="br-cancel" data-id="${esc(d.id)}">Cancel</button>
      </div>
    </div>`;
  }
  let inner = `<div class="meta">
    <div class="row"><span class="lbl">browser</span><span class="val">${esc(d.browser)} · ${esc(d.screen)}</span></div>
    <div class="row"><span class="lbl">profile</span><span class="val">${esc(d.profile || '(default rule)')}</span></div>
    <div class="row"><span class="lbl">start url</span><span class="val">${esc(d.startUrl || '(session default)')}</span></div>
    <div class="row"><span class="lbl">ports</span><span class="val">${d.webPort ? `${d.webPort}/${d.rfbPort}/${d.cdpPort} disp :${d.display}` : 'auto'}</span></div>
    <div class="row"><span class="lbl">vnc pw</span><span class="val">${d.vncPassword ? 'required at launch' : 'not required'}</span></div>
  </div>`;
  if (u.pwPrompt) {
    inner += `<div class="pw-row" style="border-top:1px dashed var(--line);padding-top:12px">
      <input type="password" data-br-pw="${esc(d.id)}" placeholder="VNC password" autocomplete="new-password">
      <button class="btn primary small" data-action="br-launch-confirm" data-id="${esc(d.id)}">Launch</button>
      <button class="btn ghost small" data-action="br-pw-cancel" data-id="${esc(d.id)}">Cancel</button>
    </div>`;
  }
  const btns = [
    `<button class="btn primary small" data-action="br-launch" data-id="${esc(d.id)}">🚀 Launch</button>`,
    `<button class="btn ghost small" data-action="br-edit" data-id="${esc(d.id)}">Edit</button>`,
    `<button class="btn ghost small" data-action="br-duplicate" data-id="${esc(d.id)}">Duplicate</button>`,
    `<button class="btn danger small" data-action="br-delete" data-id="${esc(d.id)}">Delete</button>`,
  ];
  return `<div class="card browser" data-browser="${esc(d.id)}">
    <div class="s-head"><h3>${esc(d.label)}</h3><span class="uptime">${esc(d.id)}</span></div>
    ${inner}
    <div class="btnrow">${btns.join('')}</div>
  </div>`;
}

function renderAttachRow() {
  const row = $('#attach-row');
  if (!row) return;
  const scan = `<button class="btn ghost" type="button" data-action="scan-local">↻ Scan CDP 9222–9224</button>`;
  if (localCandidates === null) {
    row.innerHTML = `${scan}<span class="muted">not scanned yet</span>`;
  } else if (!localCandidates.length) {
    row.innerHTML = `${scan}<span class="muted">no external Chrome with CDP found on 9222–9224</span>`;
  } else {
    row.innerHTML = scan + localCandidates.map((c) =>
      `<button class="btn primary small" data-action="attach-start" data-port="${c.port}">Attach :${c.port} — ${esc(c.browser)}</button>`).join('');
  }
}

/* ------------------------------------------------ settings view (P6) */

async function loadSettingsMeta() {
  try {
    const h = await api('/api/health');
    $('#settings-meta').innerHTML = [
      ['bind', h.bind],
      ['auth', h.auth ? 'token required' : 'DISABLED (PANEL_NO_AUTH)'],
      ['token', h.tokenHint || '—'],
      ['uptime', fmtUptime(h.panelUptimeMs)],
      ['sessions', String(h.sessions)],
      ['sse clients', String(h.sseClients)],
    ].map(([k, v]) => `<div class="row"><span class="lbl">${esc(k)}</span><span class="val">${esc(v)}</span></div>`).join('');
  } catch (e) {
    $('#settings-meta').innerHTML = `<div class="row"><span class="lbl">error</span><span class="val">${esc(e.message)}</span></div>`;
  }
}

/* ------------------------------------------------------------- loaders */

async function loadScripts() {
  try { scripts = (await api('/api/scripts')).scripts; renderScripts(); } catch (_) {}
}
async function loadRuns() {
  try { runs = (await api('/api/runs')).runs; renderRuns(); } catch (_) {}
}
async function loadBrowsers() {
  try { browsers = (await api('/api/browsers')).browsers; renderBrowsers(); } catch (_) {}
}
async function loadRunLines(id) {
  try { runLines[id] = (await api(`/api/runs/${encodeURIComponent(id)}/logs?tail=400`)).lines; renderRuns(); } catch (_) {}
}
function upsertRun(r) {
  const i = runs.findIndex((x) => x.id === r.id);
  if (i >= 0) runs[i] = r; else runs.unshift(r);
  if (runs.length > 100) runs.length = 100;
}

/* ------------------------------------------------------------- refresh */

async function refresh() {
  try {
    const data = await api('/api/sessions');
    sessions.clear();
    data.sessions.forEach(upsert);
    render();
    $('#st-panel').textContent = 'ok';
    $('#st-panel').className = 'ok';
  } catch (e) {
    $('#st-panel').textContent = 'offline';
    $('#st-panel').className = 'bad';
  }
}

/* ------------------------------------------------------------- SSE (F8) */
let es = null;

function sseStatus(up) {
  sseConnected = up;
  const el = $('#st-sse');
  el.textContent = up ? 'live' : 'reconnecting…';
  el.className = up ? 'ok' : 'bad';
}

function connectSSE() {
  if (es) es.close();
  es = new EventSource('/api/events');
  es.addEventListener('hello', (e) => {
    try { JSON.parse(e.data).sessions.forEach(upsert); render(); } catch (_) {}
    sseStatus(true);
  });
  es.addEventListener('session', (e) => {
    try { upsert(JSON.parse(e.data)); scheduleRender(); } catch (_) {}
  });
  es.addEventListener('job', (e) => {
    try { onJob(JSON.parse(e.data)); } catch (_) {}
  });
  es.addEventListener('log', (e) => {
    try { onLog(JSON.parse(e.data)); } catch (_) {}
  });
  es.addEventListener('run', (e) => {
    try {
      const r = JSON.parse(e.data);
      upsertRun(r);
      renderRuns();
      if (r.state === 'done') toast('ok', `${r.script} finished ✓ (${r.id})`, 'run');
      else if (r.state === 'error') toast('err', `${r.script} failed — ${r.error || 'see log'} (${r.id})`, 'run');
      else if (r.state === 'killed') toast('job', `${r.id} killed`, 'run');
      else if (r.state === 'interrupted') toast('err', `${r.id} interrupted — panel restarted`, 'run');
    } catch (_) {}
  });
  es.addEventListener('run-log', (e) => {
    try {
      const d = JSON.parse(e.data);
      if (openRunId !== d.id) return;
      const lines = runLines[d.id] || (runLines[d.id] = []);
      lines.push(d.line);
      const pre = document.querySelector(`pre[data-run-log="${CSS.escape(d.id)}"]`);
      if (pre) { pre.textContent = lines.join('\n'); pre.scrollTop = pre.scrollHeight; }
    } catch (_) {}
  });
  es.onerror = () => {
    sseStatus(false);
    if (es && es.readyState === EventSource.CLOSED) setTimeout(connectSSE, 3000);
  };
}

function onJob(j) {
  const label = `${j.type} “${j.name}”`;
  if (j.state === 'running') toast('job', `${label} — running…`, 'job');
  else if (j.state === 'done') { toast('ok', `${label} — done`, 'ok'); refresh(); }
  else if (j.state === 'error') { toast('err', `${label} — ${j.error || 'failed'}`, 'error'); refresh(); }
}

function onLog(d) {
  const u = ui[d.name];
  if (!u || !u.logs || !u.lines) return;
  u.lines.push(d.line);
  if (u.lines.length > 600) u.lines.splice(0, u.lines.length - 600);
  const pre = document.querySelector(`pre[data-log="${CSS.escape(d.name)}"]`);
  if (pre) {
    pre.textContent = u.lines.join('\n');
    pre.scrollTop = pre.scrollHeight;
  }
}

/* ------------------------------------------------------------- actions */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const name = btn.dataset.name;
  try {
    if (action === 'embed') {
      const u = uiFor(name);
      u.embed = !u.embed;
      render();
    } else if (action === 'settings') {
      const u = uiFor(name);
      u.settings = !u.settings;
      render();
    } else if (action === 'logs') {
      const u = uiFor(name);
      u.logs = !u.logs;
      if (u.logs) {
        const data = await api(`/api/sessions/${encodeURIComponent(name)}/logs?tail=300`);
        u.lines = data.lines;
      }
      render();
      const pre = document.querySelector(`pre[data-log="${CSS.escape(name)}"]`);
      if (pre) pre.scrollTop = pre.scrollHeight;
    } else if (action === 'copy-logs') {
      const u = uiFor(name);
      await navigator.clipboard.writeText((u.lines || []).join('\n'));
      toast('ok', 'log copied to clipboard', name);
    } else if (action === 'start') {
      btn.classList.add('is-busy');
      const { job } = await api('/api/sessions', { method: 'POST', body: { name } });
      toast('job', `start job ${job.id} — stack coming up`, name);
    } else if (action === 'restart') {
      btn.classList.add('is-busy');
      const { job } = await api(`/api/sessions/${encodeURIComponent(name)}/restart`, { method: 'POST', body: {} });
      toast('job', `restart job ${job.id} — same profile, logins preserved`, name);
    } else if (action === 'shutdown') {
      const ok = await confirmDialog('Shut down session?',
        `This stops “${name}” — Xvfb, the browser, x11vnc and noVNC. Cookies/logins survive in the profile.`, 'Shut down');
      if (!ok) return;
      btn.classList.add('is-busy');
      const r = await api(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (r.job) toast('job', `shutdown job ${r.job.id}`, name);
      else toast('ok', 'already stopped', name);
      refresh();
    } else if (action === 'delete') {
      const ok = await confirmDialog('Remove session?',
        `Forget “${name}” from the panel (it is stopped). The profile on disk is kept.`, 'Remove');
      if (!ok) return;
      await api(`/api/sessions/${encodeURIComponent(name)}?purge=1`, { method: 'DELETE' });
      sessions.delete(name);
      delete ui[name];
      render();
      toast('ok', 'session removed', name);
    } else if (action === 'save-settings') {
      const panel = document.querySelector(`[data-settings="${CSS.escape(name)}"]`);
      const val = (n) => (panel.querySelector(`[name="${n}"]`) || {}).value;
      const body = {
        screen: val('screen'),
        browser: val('browser'),
        startUrl: val('startUrl'),
        viewer: {
          resize: val('vResize'),
          viewOnly: (panel.querySelector('[name="vViewOnly"]') || {}).checked === true,
        },
      };
      const r = await api(`/api/sessions/${encodeURIComponent(name)}/settings`, { method: 'PATCH', body });
      const m = panel.querySelector('[data-settings-msg]');
      if (m) m.textContent = r.restartRequired ? 'saved — restart to apply display changes' : 'saved';
      toast('ok', r.restartRequired ? 'Saved. Restart to apply screen/browser/URL.' : 'Viewer options saved — link updated', name);
      refresh();
    } else if (action === 'set-pw') {
      const panel = document.querySelector(`[data-settings="${CSS.escape(name)}"]`);
      const input = panel.querySelector('[name="vncPw"]');
      const pw = input.value;
      if (!pw) { toast('err', 'enter a password first', 'vnc password'); return; }
      await api(`/api/sessions/${encodeURIComponent(name)}/vnc-password`, { method: 'PUT', body: { password: pw } });
      input.value = '';
      toast('ok', 'password set — only x11vnc restarted, browser stayed up', 'vnc password');
      refresh();
    } else if (action === 'clear-pw') {
      const ok = await confirmDialog('Clear VNC password?',
        'x11vnc goes back to -nopw — the viewer will connect without a password.', 'Clear');
      if (!ok) return;
      await api(`/api/sessions/${encodeURIComponent(name)}/vnc-password`, { method: 'DELETE' });
      toast('ok', 'password cleared — x11vnc restarted with -nopw', 'vnc password');
      refresh();
    } else if (action === 'snapshot') {
      const u = uiFor(name);
      if (u.shotAt && Date.now() - u.shotAt < 5000) return;    // throttle 5s
      u.shotAt = Date.now();
      const res = await fetch(`/api/sessions/${encodeURIComponent(name)}/screenshot`);
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'screenshot failed'); }
      const blob = await res.blob();
      u.shot = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      u.shotAtText = new Date().toLocaleTimeString();
      render();

    /* ---------------- scripts (P4) ---------------- */
    } else if (action === 'sc-edit') {
      const u = uiScripts[name];
      u.editing = true; u.renaming = false; u.runForm = false;
      renderScripts();
      const s = (await api(`/api/scripts/${encodeURIComponent(name)}`)).script;
      u.content = s.content;
      renderScripts();
    } else if (action === 'sc-cancel') {
      const u = uiScripts[name];
      u.editing = false; u.renaming = false; u.runForm = false; u.content = null;
      renderScripts();
    } else if (action === 'sc-save') {
      const u = uiScripts[name];
      const ta = document.querySelector(`textarea[data-editor="${CSS.escape(name)}"]`);
      if (!ta) return;
      const { script } = await api(`/api/scripts/${encodeURIComponent(name)}`, { method: 'PUT', body: { content: ta.value } });
      const i = scripts.findIndex((x) => x.name === name);
      if (i >= 0) scripts[i] = { name: script.name, size: script.size, mtime: script.mtime };
      u.editing = false; u.content = null;
      renderScripts();
      toast('ok', `saved ${name} (${(script.size / 1024).toFixed(1)} KB)`, 'scripts');
    } else if (action === 'sc-rename') {
      const u = uiScripts[name];
      u.renaming = true; renderScripts();
      const inp = document.querySelector(`input[data-rename="${CSS.escape(name)}"]`);
      if (inp) { inp.focus(); inp.select(); }
    } else if (action === 'sc-rename-ok') {
      const inp = document.querySelector(`input[data-rename="${CSS.escape(name)}"]`);
      const to = String(inp && inp.value || '').trim();
      if (!to || to === name) { uiScripts[name].renaming = false; renderScripts(); return; }
      const { script } = await api(`/api/scripts/${encodeURIComponent(name)}/rename`, { method: 'POST', body: { to } });
      delete uiScripts[name];
      uiScripts[script.name] = { editing: false, renaming: false, runForm: false, content: null };
      await loadScripts();
      toast('ok', `renamed → ${script.name}`, 'scripts');
    } else if (action === 'sc-run') {
      const u = uiScripts[name];
      u.runForm = true; u.editing = false; u.renaming = false;
      renderScripts();
    } else if (action === 'sc-run-start') {
      const card = document.querySelector(`[data-script="${CSS.escape(name)}"]`);
      const session = card.querySelector(`select[data-run-session="${CSS.escape(name)}"]`).value;
      const args = splitArgs(card.querySelector(`input[data-run-args="${CSS.escape(name)}"]`).value);
      if (!session) { toast('err', 'no running session — start one first', 'run'); return; }
      const { run } = await api(`/api/scripts/${encodeURIComponent(name)}/run`, { method: 'POST', body: { session, args } });
      uiScripts[name].runForm = false;
      openRunId = run.id;
      upsertRun(run);
      renderRuns();
      loadRunLines(run.id);
      toast('job', `${run.id} started on “${session}” — live log below`, 'run');
    } else if (action === 'sc-delete') {
      const ok = await confirmDialog('Delete script?', `“${name}” moves to user-scripts/.trash/ (recoverable).`, 'Delete');
      if (!ok) return;
      const r = await api(`/api/scripts/${encodeURIComponent(name)}`, { method: 'DELETE' });
      scripts = scripts.filter((x) => x.name !== name);
      delete uiScripts[name];
      renderScripts();
      toast('ok', `moved to ${r.trashed}`, 'scripts');
    } else if (action === 'sc-rename-cancel') {
      uiScripts[name].renaming = false; renderScripts();

    /* ---------------- runs (P4) ---------------- */
    } else if (action === 'run-log-toggle') {
      const id = btn.dataset.id;
      if (openRunId === id) { openRunId = null; }
      else { openRunId = id; if (!runLines[id]) { renderRuns(); await loadRunLines(id); return; } }
      renderRuns();
    } else if (action === 'run-copy') {
      const id = btn.dataset.id;
      await navigator.clipboard.writeText((runLines[id] || []).join('\n'));
      toast('ok', 'run log copied', id);
    } else if (action === 'run-kill') {
      const id = btn.dataset.id;
      const ok = await confirmDialog('Kill run?', `${id} gets SIGTERM. The live browser is NOT affected.`, 'Kill');
      if (!ok) return;
      const { run } = await api(`/api/runs/${encodeURIComponent(id)}`, { method: 'DELETE' });
      upsertRun(run);
      renderRuns();
      toast('ok', `${id} killed`, 'runs');
    /* ---------------- browsers (P5) ---------------- */
    } else if (action === 'br-edit') {
      uiBrowsers[btn.dataset.id].editing = true;
      renderBrowsers();
    } else if (action === 'br-cancel') {
      uiBrowsers[btn.dataset.id].editing = false;
      uiBrowsers[btn.dataset.id].pwPrompt = false;
      renderBrowsers();
    } else if (action === 'br-save') {
      const id = btn.dataset.id;
      const card = document.querySelector(`[data-browser="${CSS.escape(id)}"]`);
      const g = (k) => { const el = card.querySelector(`[data-be="${k}"]`); return el ? (el.type === 'checkbox' ? el.checked : el.value) : undefined; };
      const { browser } = await api(`/api/browsers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: { label: g('label'), browser: g('browser'), screen: g('screen'), profile: g('profile'),
                startUrl: g('startUrl'), webPort: g('webPort'), rfbPort: g('rfbPort'),
                cdpPort: g('cdpPort'), display: g('display'), vncPassword: g('vncPassword') },
      });
      uiBrowsers[id].editing = false;
      await loadBrowsers();
      toast('ok', `updated definition “${browser.id}”`, 'browsers');
    } else if (action === 'br-delete') {
      const id = btn.dataset.id;
      const ok = await confirmDialog('Delete definition?', `“${id}” is removed. Sessions it launched are untouched.`, 'Delete');
      if (!ok) return;
      await api(`/api/browsers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      browsers = browsers.filter((x) => x.id !== id);
      delete uiBrowsers[id];
      renderBrowsers();
      toast('ok', `definition “${id}” deleted`, 'browsers');
    } else if (action === 'br-duplicate') {
      const d = browsers.find((x) => x.id === btn.dataset.id);
      if (!d) return;
      let newId = `${d.id.slice(0, 24)}-copy`;
      let n = 2;
      while (browsers.some((x) => x.id === newId)) newId = `${d.id.slice(0, 22)}-copy${n++}`;
      await api('/api/browsers', { method: 'POST', body: { ...d, id: newId, label: `${d.label} copy` } });
      await loadBrowsers();
      toast('ok', `duplicated → ${newId}`, 'browsers');
    } else if (action === 'br-launch') {
      const id = btn.dataset.id;
      const d = browsers.find((x) => x.id === id);
      if (d && d.vncPassword) { uiBrowsers[id].pwPrompt = true; renderBrowsers(); return; }
      const r = await api(`/api/browsers/${encodeURIComponent(id)}/launch`, { method: 'POST', body: {} });
      toast('job', `launching session “${r.session}” from “${id}”`, 'browsers');
      showView('sessions');
      refresh();
    } else if (action === 'br-launch-confirm') {
      const id = btn.dataset.id;
      const card = document.querySelector(`[data-browser="${CSS.escape(id)}"]`);
      const pw = card.querySelector(`input[data-br-pw="${CSS.escape(id)}"]`).value;
      if (!pw) { toast('err', 'enter a password first', 'browsers'); return; }
      const r = await api(`/api/browsers/${encodeURIComponent(id)}/launch`, { method: 'POST', body: { password: pw } });
      uiBrowsers[id].pwPrompt = false;
      renderBrowsers();
      toast('job', `launching “${r.session}” with VNC password`, 'browsers');
      showView('sessions');
      refresh();
    } else if (action === 'br-pw-cancel') {
      uiBrowsers[btn.dataset.id].pwPrompt = false;
      renderBrowsers();
    } else if (action === 'scan-local') {
      const r = await api('/api/browsers/local-chrome');
      localCandidates = r.candidates;
      renderAttachRow();
      toast('ok', `${localCandidates.length} CDP instance(s) found on 9222–9224`, 'local chrome');
    } else if (action === 'attach-start') {
      const r = await api('/api/browsers/attach-local', { method: 'POST', body: { cdpPort: btn.dataset.port } });
      toast('job', `attaching stack to CDP :${btn.dataset.port} (job ${r.job.id})`, 'local chrome');
      showView('sessions');
      refresh();
    }
  } catch (err) {
    btn.classList.remove('is-busy');
    toast('err', err.message, action);
  }
});

/* --------------------------------------------------- new session form */

$('#ns-screen').addEventListener('change', () => {
  $('#ns-custom-wrap').hidden = $('#ns-screen').value !== 'custom';
});

$('#new-session-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {};
  const set = (k, v) => { const s = String(v == null ? '' : v).trim(); if (s !== '') body[k] = s; };
  set('name', f.get('name'));
  set('browser', f.get('browser'));
  const screenSel = String(f.get('screen'));
  if (screenSel === 'custom') set('screen', f.get('customScreen'));
  else set('screen', screenSel);
  set('startUrl', f.get('startUrl'));
  set('profile', f.get('profile'));
  for (const k of ['webPort', 'rfbPort', 'cdpPort', 'display']) set(k, f.get(k));

  const msg = $('#ns-msg');
  msg.textContent = 'validating…';
  try {
    const { job } = await api('/api/sessions', { method: 'POST', body });
    msg.textContent = `job ${job.id} — starting`;
    toast('job', `starting ${body.name || 'default'} — Xvfb + browser + noVNC + CDP`, 'new session');
    setTimeout(() => { msg.textContent = ''; }, 12000);
  } catch (err) {
    msg.textContent = '';
    toast('err', err.message, 'start failed');
  }
});

/* --------------------------------------------------- create forms (P4/P5) */

$('#script-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = String(f.get('name') || '').trim();
  const msg = $('#sc-msg');
  if (!name) return;
  msg.textContent = 'creating…';
  try {
    await api('/api/scripts', { method: 'POST', body: { name, content: STARTER } });
    e.target.reset();
    msg.textContent = '';
    await loadScripts();
    uiScripts[name] = { editing: true, renaming: false, runForm: false, content: STARTER };
    renderScripts();
    toast('ok', `created ${name} — edit it, then Run on a live session`, 'scripts');
  } catch (err) {
    msg.textContent = '';
    toast('err', err.message, 'scripts');
  }
});

function collectBrowserForm(root, idOverride) {
  const g = (n) => {
    const el = root.querySelector(`[name="${n}"]`) || root.querySelector(`[data-be="${n}"]`);
    if (!el) return undefined;
    return el.type === 'checkbox' ? el.checked : el.value;
  };
  return {
    id: idOverride !== undefined ? idOverride : g('id'),
    label: g('label'), browser: g('browser'), screen: g('screen'),
    profile: g('profile'), startUrl: g('startUrl'),
    webPort: g('webPort'), rfbPort: g('rfbPort'), cdpPort: g('cdpPort'), display: g('display'),
    vncPassword: g('vncPassword'),
  };
}

$('#browser-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#br-msg');
  msg.textContent = 'saving…';
  try {
    await api('/api/browsers', { method: 'POST', body: collectBrowserForm(e.target) });
    e.target.reset();
    msg.textContent = '';
    await loadBrowsers();
    toast('ok', 'definition saved — launch it from the card', 'browsers');
  } catch (err) {
    msg.textContent = '';
    toast('err', err.message, 'browsers');
  }
});

/* ------------------------------------------------------------- tabs */

function showView(v) {
  for (const sec of document.querySelectorAll('main > section')) sec.hidden = true;
  const target = document.getElementById(`view-${v}`) || document.getElementById('view-sessions');
  target.hidden = false;
  for (const a of document.querySelectorAll('.nav-links a[data-view]')) {
    a.classList.toggle('active', a.dataset.view === (target.id || '').replace('view-', ''));
  }
  // lazy-refresh each view's data on entry
  if (target.id === 'view-scripts') { loadScripts(); loadRuns(); }
  else if (target.id === 'view-browsers') loadBrowsers();
  else if (target.id === 'view-settings') loadSettingsMeta();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute('href').slice(1);
  if (!['sessions', 'scripts', 'browsers', 'settings'].includes(id)) return;
  e.preventDefault();
  showView(id);
  history.replaceState(null, '', `#${id}`);
});

$('#btn-focus-new').addEventListener('click', () => {
  showView('sessions');
  $('#new-session-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => $('#new-session-form [name=name]').focus(), 350);
});

$('#btn-refresh').addEventListener('click', () => {
  refresh();
  toast('ok', 'refreshed', 'panel');
});

/* ------------------------------------------------------------- stars */

(function stars() {
  let html = '';
  for (let i = 0; i < 110; i++) {
    const x = (Math.random() * 100).toFixed(2);
    const y = (Math.random() * 100).toFixed(2);
    const dur = (2 + Math.random() * 3).toFixed(2);
    const delay = (Math.random() * 3).toFixed(2);
    html += `<div class="stars twinkle" style="left:${x}%;top:${y}%;animation-duration:${dur}s;animation-delay:${delay}s"></div>`;
  }
  document.getElementById('star-canvas').innerHTML = html;
})();

/* ------------------------------------------------------------- init */

showView((location.hash || '#sessions').slice(1));
refresh();
connectSSE();
loadScripts();
loadRuns();
loadBrowsers();
loadSettingsMeta();
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10000);

