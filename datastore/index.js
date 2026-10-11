const fs = require('fs');
const path = require('path');
const duckdb = require('duckdb');

const DEFAULT_DATASTORE_DIR = path.resolve(__dirname, '..', 'datastore');
const DEFAULT_DB_PATH = path.join(DEFAULT_DATASTORE_DIR, 'browser.duckdb');

let db = null;
let dbPath = null;
let connecting = null;

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Open (or return) the datastore connection.
 *
 * The connection is opened lazily on first use, so `db-select` / `db-query`
 * work without a prior explicit `db-connect`. Connecting to the same path twice
 * is a no-op; connecting to a different path re-opens the database.
 */
function connect(newPath) {
  const resolved = newPath || process.env.DATASTORE_PATH || dbPath || DEFAULT_DB_PATH;
  if (db && dbPath === resolved) return Promise.resolve(resolved);
  if (connecting) return connecting;
  if (db) close();

  ensureDir(resolved);
  connecting = new Promise((resolve, reject) => {
    const opened = new duckdb.Database(resolved, (err) => {
      connecting = null;
      if (err) {
        db = null;
        dbPath = null;
        reject(err);
        return;
      }
      db = opened;
      dbPath = resolved;
      resolve(resolved);
    });
  });
  return connecting;
}

function close() {
  if (db) {
    try { db.close(); } catch (_) {}
  }
  db = null;
  dbPath = null;
  connecting = null;
}

async function ensure() {
  if (!db) await connect();
  return db;
}

/** Statement that returns no rows (CREATE/INSERT/UPDATE/DELETE). */
async function exec(sql, params) {
  const conn = await ensure();
  return new Promise((resolve, reject) => {
    conn.run(sql, ...(params || []), (err) => (err ? reject(err) : resolve({ ok: true })));
  });
}

/** DuckDB returns BIGINT as JS BigInt, which JSON.stringify rejects. */
function decodeValue(v) {
  if (typeof v !== 'bigint') return v;
  return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(v) : v.toString();
}

const decodeRow = (row) => {
  if (!row || typeof row !== 'object') return decodeValue(row);
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = decodeValue(v);
  return out;
};

/** Statement that returns rows (SELECT / RETURNING / PRAGMA). */
async function query(sql, params) {
  const conn = await ensure();
  return new Promise((resolve, reject) => {
    conn.all(sql, ...(params || []), (err, rows) => {
      if (err) return reject(err);
      resolve((rows || []).map(decodeRow));
    });
  });
}

function buildWhere(where, action) {
  const clauses = [];
  const params = [];
  for (const [k, v] of Object.entries(where || {})) {
    if (v === null || v === undefined) {
      clauses.push(`${k} IS NULL`);
    } else {
      clauses.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (!clauses.length) {
    throw new Error(`${action} requires a where clause (refusing to touch every row)`);
  }
  return { sql: clauses.join(' AND '), params };
}

async function createTable(name, columns) {
  // Columns may be "id INTEGER, name TEXT" or bare names ("id, name"), in which
  // case TEXT is assumed — DuckDB rejects a type-less column list, and silently
  // failing with "syntax error at end of input" is a bad first experience.
  const specs = Array.isArray(columns) ? columns : Object.keys(columns || {});
  const types = Array.isArray(columns) ? null : columns;
  const cols = specs
    .map((spec, i) => {
      const text = String(spec).trim();
      if (!text) return null;
      const withType = types ? String(types[spec] || '').trim() : '';
      return /\s/.test(text) || withType ? `${text} ${withType}`.trim() : `${text} TEXT`;
    })
    .filter(Boolean);
  if (!cols.length) throw new Error(`create table "${name}" needs at least one column`);
  await exec(`CREATE TABLE IF NOT EXISTS ${name} (${cols.join(', ')})`);
  return { table: name, columns: cols };
}

async function insert(table, row) {
  const keys = Object.keys(row || {});
  if (!keys.length) throw new Error('insert requires at least one column');
  const placeholders = keys.map(() => '?').join(', ');
  const values = keys.map((k) => row[k]);
  await exec(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${placeholders})`, values);
  return { table, inserted: row };
}

async function select(table, where) {
  let sql = `SELECT * FROM ${table}`;
  const params = [];
  const clauses = [];
  for (const [k, v] of Object.entries(where || {})) {
    if (v === null || v === undefined) {
      clauses.push(`${k} IS NULL`);
    } else {
      clauses.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  const rows = await query(sql, params);
  return rows;
}

async function update(table, set, where) {
  const setClauses = [];
  const params = [];
  for (const [k, v] of Object.entries(set || {})) {
    if (v === null || v === undefined) {
      setClauses.push(`${k} = NULL`);
    } else {
      setClauses.push(`${k} = ?`);
      params.push(v);
    }
  }
  if (!setClauses.length) throw new Error('update requires at least one column to set');
  const w = buildWhere(where, 'update');
  await exec(`UPDATE ${table} SET ${setClauses.join(', ')} WHERE ${w.sql}`, [...params, ...w.params]);
  return { table, ok: true };
}

async function remove(table, where) {
  const w = buildWhere(where, 'remove');
  await exec(`DELETE FROM ${table} WHERE ${w.sql}`, w.params);
  return { table, ok: true };
}

async function listTables() {
  const rows = await query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name"
  );
  return rows.map((r) => r.table_name);
}

async function status() {
  // Report the path that would be used even before a connection exists — handy
  // for the one-shot CLI, where every invocation starts disconnected.
  if (!db) return { connected: false, dbPath: process.env.DATASTORE_PATH || DEFAULT_DB_PATH, tables: [] };
  return { connected: true, dbPath, tables: await listTables() };
}

module.exports = {
  DEFAULT_DB_PATH,
  connect,
  close,
  exec,
  query,
  createTable,
  insert,
  select,
  update,
  remove,
  listTables,
  status,
};
