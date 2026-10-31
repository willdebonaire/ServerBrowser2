'use strict';
/**
 * state.js — JSON state files under datastore/ with mode 0600.
 * Same precedent as datastore/tunnel-state.json: written atomically
 * (tmp + rename) so a different process can read it minutes later safely.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATASTORE = path.join(ROOT, 'datastore');

function fileFor(name) {
  if (!/^[a-z0-9._-]+$/i.test(name)) throw new Error(`invalid state name: ${name}`);
  return path.join(DATASTORE, `${name}.json`);
}

function load(name, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function save(name, data) {
  const file = fileFor(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
  return file;
}

module.exports = { ROOT, DATASTORE, load, save, fileFor };
