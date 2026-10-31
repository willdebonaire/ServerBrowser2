'use strict';
/** audit.js — append-only local audit trail for destructive panel actions.
 *  datastore/panel-audit.log, mode 0600 (created on first write). */
const fs = require('fs');
const path = require('path');
const { DATASTORE } = require('./state');

const FILE = path.join(DATASTORE, 'panel-audit.log');

function audit(action, detail = {}) {
  try {
    fs.mkdirSync(DATASTORE, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), action, ...detail, pid: process.pid }) + '\n';
    fs.appendFileSync(FILE, line, { mode: 0o600 });
  } catch (_) { /* auditing must never break a request */ }
}

module.exports = { audit, FILE };
