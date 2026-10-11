/**
 * Backfill script: for every row in csv/{code}.csv where detail_tax_id
 * is empty, fetch the source_url, parse the detail page, and write
 * the updated row back in-place. Skips rows that already have detail.
 *
 * Resumable: progress is saved to scrapers/_backfill_progress.json
 * so re-runs pick up where they left off.
 *
 * Usage:
 *   node scrapers/backfill.js                    # all 200 CSVs
 *   node scrapers/backfill.js --code=01111        # just one
 */
const path = require('path');
const fs   = require('fs');
const { launch } = require('../headless');
const { scrapeCompanyDetailOnPage } = require('./dataforthai');

const CSV_DIR = path.join(__dirname, '..', 'csv');
const PROGRESS_FILE = path.join(__dirname, '_backfill_progress.json');

function parseArgs(argv) {
  const out = { code: null, delay: 30, headless: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--code=')) out.code = a.slice('--code='.length);
    else if (a === '--headed') out.headless = false;
    else if (a.startsWith('--delay=')) out.delay = parseInt(a.slice('--delay='.length), 10);
  }
  return out;
}

function printHelp() {
  console.log(`
backfill.js - backfill detail_* fields in existing CSVs

USAGE
  node scrapers/backfill.js                  # all 200 CSVs
  node scrapers/backfill.js --code=01111      # just one
  node scrapers/backfill.js --headed          # visible browser
  node scrapers/backfill.js --delay=100       # slower (less aggressive)

Resumable: progress is saved in scrapers/_backfill_progress.json.
Delete that file to start over.
`);
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function readCsv(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] || ''; });
    return obj;
  });
  return { headers, rows };
}

function writeCsv(file, headers, rows) {
  const csv = rows.map(r => headers.map(h => {
    const v = r[h] || '';
    let s = String(v);
    s = s.replace(/[\r\n\t]+/g, ' ').replace(/"/g, '""').trim();
    if (/[,"]/.test(s)) return '"' + s + '"';
    return s;
  }).join(',')).join('\n');
  fs.writeFileSync(file, '\uFEFF' + headers.join(',') + '\n' + csv + '\n');
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return {}; }
}

function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}

/**
 * Run a batch. Returns a final summary.
 *
 * @param {Object} opts
 * @param {string} [opts.code]            Only process this one code.
 * @param {number} [opts.delay=30]         Per-company delay (ms).
 * @param {boolean} [opts.headless=true]
 * @param {function} [opts.onProgress]      (state) => void called per code.
 */
async function backfill(opts = {}) {
  const { code = null, delay = 30, headless = true, onProgress = null } = opts;

  let csvFiles = fs.readdirSync(CSV_DIR).filter(f => f.endsWith('.csv') && !f.startsWith('_'));
  if (code) csvFiles = csvFiles.filter(f => f.replace('.csv', '') === code);
  console.log(`[backfill] ${csvFiles.length} CSV file(s) to process`);

  const progress = loadProgress();
  // Open the browser ONCE; we'll restart it every ~100 companies.
  let browserCtx = null;
  let detailPage = null;
  let pageLaunchedAt = 0;
  const RESTART_EVERY = 100;
  const summary = {
    totalFiles: csvFiles.length,
    doneFiles: 0,
    rowsScanned: 0,
    rowsUpdated: 0,
    rowsSkipped: 0,
    rowsFailed: 0,
    errors: [],
  };
  const startTime = Date.now();

  async function ensureBrowser() {
    if (browserCtx) return;
    console.log('[backfill] launching browser...');
    const r = await launch({ headless });
    browserCtx = r;
    detailPage = await r.page.context().newPage();
    pageLaunchedAt = Date.now();
  }

  for (const f of csvFiles) {
    const c = f.replace('.csv', '');
    if (progress[c] && progress[c].done) {
      console.log(`  [${c}] already done`);
      summary.doneFiles++;
      continue;
    }
    const file = path.join(CSV_DIR, f);
    const { headers, rows } = readCsv(file);
    if (rows.length === 0) continue;
    let updated = 0;
    let skipped = 0;
    let failed = 0;
    progress[c] = progress[c] || { urls: {} };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Skip rows that already have detail data.
      if (r.detail_tax_id && r.detail_tax_id.trim()) {
        skipped++;
        summary.rowsSkipped++;
        continue;
      }
      if (!r.source_url) {
        skipped++;
        summary.rowsSkipped++;
        continue;
      }
      // Skip already-processed URLs (resume support).
      const key = r.source_url;
      if (progress[c].urls[key]) {
        Object.assign(r, progress[c].urls[key]);
        updated++;
        summary.rowsUpdated++;
        continue;
      }

      summary.rowsScanned++;

      // Periodic browser restart.
      if (detailPage && (summary.rowsScanned - pageLaunchedAt) > RESTART_EVERY) {
        console.log(`[backfill] periodic browser restart (after ${RESTART_EVERY} companies)`);
        try { await detailPage.close(); } catch {}
        try { await browserCtx.close(); } catch {}
        browserCtx = null;
        detailPage = null;
      }

      try {
        await ensureBrowser();
        const result = await scrapeCompanyDetailOnPage(detailPage, r.source_url, r);
        if (result.ok && result.record) {
          // Merge only the detail_* fields back into the row.
          const detailFields = {};
          Object.keys(result.record).forEach(k => {
            if (k.startsWith('detail_')) {
              r[k] = result.record[k];
              detailFields[k] = result.record[k];
            }
          });
          // Also update the scraped_at_iso
          r.scraped_at_iso = new Date().toISOString();
          detailFields.scraped_at_iso = r.scraped_at_iso;
          progress[c].urls[key] = detailFields;
          updated++;
          summary.rowsUpdated++;
        } else {
          failed++;
          summary.rowsFailed++;
          summary.errors.push({ code: c, taxId: r.list_position, error: result.error });
        }
      } catch (err) {
        failed++;
        summary.rowsFailed++;
        summary.errors.push({ code: c, taxId: r.list_position, error: (err && err.message) || String(err) });
      }

      if (delay > 0) {
        try { await browserCtx.page.waitForTimeout(delay); } catch { /* page closed */ }
      }

      // Save progress every 50 records so we don't lose work.
      if (summary.rowsScanned % 50 === 0) {
        // Write the file back with the current rows.
        writeCsv(file, headers, rows);
        saveProgress(progress);
      }
    }
    // Final write of the file.
    writeCsv(file, headers, rows);
    progress[c].done = true;
    progress[c].rows = rows.length;
    saveProgress(progress);
    summary.doneFiles++;
    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`  [${c}] ${updated} updated, ${skipped} skipped, ${failed} failed (${elapsed.toFixed(0)}s elapsed)`);
    if (onProgress) onProgress({ ...summary, currentCode: c });
  }

  // Cleanup.
  if (detailPage) { try { await detailPage.close(); } catch {} }
  if (browserCtx) { try { await browserCtx.close(); } catch {} }

  const elapsed = (Date.now() - startTime) / 1000;
  console.log('\n=== backfill summary ===');
  console.log(`  files:        ${summary.doneFiles}/${summary.totalFiles}`);
  console.log(`  rows scanned: ${summary.rowsScanned} (${(summary.rowsScanned / Math.max(1, elapsed)).toFixed(1)}/s)`);
  console.log(`  rows updated: ${summary.rowsUpdated}`);
  console.log(`  rows skipped: ${summary.rowsSkipped} (already had detail data)`);
  console.log(`  rows failed:  ${summary.rowsFailed}`);
  console.log(`  elapsed:      ${elapsed.toFixed(0)}s`);

  return summary;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  backfill({ code: args.code, delay: args.delay, headless: args.headless })
    .catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
}

module.exports = { backfill };
