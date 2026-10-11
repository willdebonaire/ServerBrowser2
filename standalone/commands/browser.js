#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

const LIVE_JS = path.resolve(__dirname, '..', '..', 'scripts', 'live.js');

const invokeLive = (args) => {
  // `fork` requires an array of strings; undefined/null options must be dropped
  // rather than stringified into "undefined" arguments.
  const safeArgs = (args || []).filter((a) => a !== undefined && a !== null).map(String);
  const child = require('child_process').fork(LIVE_JS, safeArgs, { silent: true });

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
  goto: (url) => invokeLive(['goto', url]),
  reload: () => invokeLive(['reload']),
  back: () => invokeLive(['back']),
  forward: () => invokeLive(['forward']),
  wait: (ms) => invokeLive(['wait', String(ms)]),
  waitfor: (css, ms) => invokeLive(['waitfor', css, ms && String(ms)]),
  fill: (css, text) => invokeLive(['fill', css, text]),
  type: (css, text, delay) => invokeLive(['type', css, text, delay && String(delay)]),
  click: (css) => invokeLive(['click', css]),
  press: (css, key) => invokeLive(['press', css, key]),
  keyboard: (key) => invokeLive(['keyboard', key]),
  clear: (css) => invokeLive(['clear', css]),
  url: () => invokeLive(['url']),
  title: () => invokeLive(['title']),
  text: () => invokeLive(['text']),
  html: () => invokeLive(['html']),
  dump: () => invokeLive(['dump']),
  eval: (js) => invokeLive(['eval', js]),
  screenshot: (file) => invokeLive(['screenshot', file]),
  tabs: () => invokeLive(['tabs']),
  tab: (idx) => invokeLive(['tab', String(idx)]),
  'close-tab': (idx) => invokeLive(['close-tab', idx && String(idx) || '']),

  // --- scraping / extraction (todo item 9) ---
  'save-page-json': (file) => invokeLive(['save-page-json', file]),
  'extract-css': (selector) => invokeLive(['extract-css', selector]),
  'extract-regex': (pattern, flags) => invokeLive(['extract-regex', pattern, flags]),
  'extract-table': (selector) => invokeLive(['extract-table', selector]),
  'extract-links': (filter) => invokeLive(['extract-links', filter]),
  'extract-images': () => invokeLive(['extract-images']),
  'screenshot-element': (selector, file) => invokeLive(['screenshot-element', selector, file]),
  pdf: (file) => invokeLive(['pdf', file]),

  // --- VNC HUD overlay + pause/resume (todo items 3-4) ---
  'status-set': (text) => invokeLive(['status-set', text]),
  progress: (value) => invokeLive(['progress', String(value)]),
  notify: (text, duration) => invokeLive(['notify', text, duration && String(duration)]),
  'overlay-state': () => invokeLive(['overlay-state']),
  pause: () => invokeLive(['pause']),
  resume: () => invokeLive(['resume']),

  // --- multitab / concurrent agents (todo item 7) ---
  'agent-tab-create': (name, contextId) => invokeLive(['agent-tab-create', name, contextId]),
  'agent-tab-switch': (id) => invokeLive(['agent-tab-switch', id]),
  'agent-tab-close': (id) => invokeLive(['agent-tab-close', id]),
  'context-new': () => invokeLive(['context-new']),
  'context-use': (id) => invokeLive(['context-use', id]),
  contexts: () => invokeLive(['contexts']),

  // --- DuckDB datastore (todo item 2) ---
  'db-connect': (dbPath) => invokeLive(['db-connect', dbPath]),
  'db-close': () => invokeLive(['db-close']),
  'db-status': () => invokeLive(['db-status']),
  'db-query': (sql) => invokeLive(['db-query', sql]),
  'db-exec': (sql) => invokeLive(['db-exec', sql]),
  'db-create-table': (table, columns) => invokeLive(['db-create-table', table, columns]),
  'db-insert': (table, json) => invokeLive(['db-insert', table, json]),
  'db-select': (table, whereJson) => invokeLive(['db-select', table, whereJson]),
  'db-update': (table, setJson, whereJson) => invokeLive(['db-update', table, setJson, whereJson]),
  'db-delete': (table, whereJson) => invokeLive(['db-delete', table, whereJson]),
  'db-tables': () => invokeLive(['db-tables']),
};
