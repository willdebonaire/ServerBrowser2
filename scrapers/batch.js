/**
 * Batch runner: scrapes many categories in one process, restarting
 * the browser periodically to keep memory under control.
 *
 * Usage:
 *   node scrapers/batch.js --batch=scrapers/_batch200.json
 *   node scrapers/batch.js --batch=scrapers/_batch200.json --restart-every=20 --delay=80
 *   node scrapers/batch.js --codes=01111,01112,01113
 *
 * Behavior:
 *   - Reads a list of {code, name} objects from --batch=FILE, OR a
 *     comma-separated --codes=LIST, OR a code range --range=01111-10779.
 *   - For each code, calls scrapeCategory(). If the existing CSV
 *     already has all the rows, scrapes nothing for that code.
 *   - Restarts the browser every --restart-every=N codes (default 25)
 *     to free memory.
 *   - Writes a progress file at scrapers/_progress.json so we can
 *     resume if the process dies.
 *   - Prints a running summary every 10 codes.
 *   - Returns a final summary with totals.
 */
const path  = require('path');
const fs    = require('fs');
const { launch } = require('../headless');
const { scrapeCategory } = require('./dataforthai');

const PROGRESS_FILE = path.join(__dirname, '_progress.json');
const DEFAULT_CODES_FILE = path.join(__dirname, '_batch200.json');

function parseArgs(argv) {
  const out = { restartEvery: 25, delay: 80, skipDone: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--batch='))     out.batch = a.slice('--batch='.length);
    else if (a.startsWith('--codes='))     out.codes = a.slice('--codes='.length);
    else if (a.startsWith('--range='))     out.range = a.slice('--range='.length);
    else if (a.startsWith('--restart-every=')) out.restartEvery = parseInt(a.slice('--restart-every='.length), 10);
    else if (a.startsWith('--delay='))     out.delay = parseInt(a.slice('--delay='.length), 10);
    else if (a === '--no-skip-done')        out.skipDone = false;
    else if (a === '--headed')               out.headed = true;
    else if (a === '--list-only')            out.listOnly = true;
  }
  return out;
}

function printHelp() {
  console.log(`
batch.js - scrape many dataforthai.com categories in one process

USAGE
  node scrapers/batch.js --batch=FILENAME [flags]
  node scrapers/batch.js --codes=C1,C2,... [flags]
  node scrapers/batch.js --range=START-END [flags]

FLAGS
  --batch=FILE              JSON file with [{code, name}, ...] entries.
                            (Default: scrapers/_batch200.json)
  --codes=CSV                Comma-separated list of 5-digit codes.
  --range=START-END          Range of codes, e.g. 01111-10779 (inclusive).
  --restart-every=N          Restart the browser every N codes (default 25).
                            0 means no mid-run restarts.
  --delay=MS                 Per-company delay (default 80). Lower is
                            faster but more aggressive.
  --no-skip-done             Re-scrape categories that already have CSVs.
  --list-only                Skip the per-company detail fetch. Much
                            faster (10-50x) for big batches when the
                            printview page is gated. Detail_* columns
                            will be blank; only list data is written.
  --headed                   Run browser in headed mode (for debugging).

EXAMPLES
  # Scrape the default 200-category batch
  node scrapers/batch.js

  # Smaller restart interval (saves memory, more browser startup overhead)
  node scrapers/batch.js --restart-every=10

  # Just 5 specific codes
  node scrapers/batch.js --codes=01111,01112,01113,01114,01115

  # Code range
  node scrapers/batch.js --range=01111-01300

  # Fast list-only mode (skips per-company detail pages)
  node scrapers/batch.js --list-only

OUTPUT
  - One CSV per code in csv/{code}.csv
  - Progress file at scrapers/_progress.json (so you can --resume)
  - Final summary printed at the end
`);
}

function loadCodesFromArgs(args) {
  let list;
  if (args.codes) {
    list = args.codes.split(',').map(s => s.trim()).filter(Boolean).map(c => ({ code: c, name: '' }));
  } else if (args.range) {
    const [start, end] = args.range.split('-').map(s => s.trim());
    if (!start || !end) throw new Error('--range=START-END, e.g. --range=01111-10779');
    list = [];
    const sNum = parseInt(start, 10);
    const eNum = parseInt(end, 10);
    if (Number.isNaN(sNum) || Number.isNaN(eNum)) throw new Error('Invalid --range');
    for (let n = sNum; n <= eNum; n++) {
      list.push({ code: String(n).padStart(5, '0'), name: '' });
    }
  } else {
    const file = args.batch || DEFAULT_CODES_FILE;
    if (!fs.existsSync(file)) throw new Error(`batch file not found: ${file}`);
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  if (!Array.isArray(list) || list.length === 0) throw new Error('empty code list');
  return list;
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch { return null; }
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function clearProgress() {
  if (fs.existsSync(PROGRESS_FILE)) fs.unlinkSync(PROGRESS_FILE);
}

/**
 * Quick-count the rows in a CSV without launching a browser.
 * Returns 0 for missing files.
 */
function countCsvRows(code) {
  const file = path.join(__dirname, '..', 'csv', `${code}.csv`);
  if (!fs.existsSync(file)) return 0;
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    // Subtract 1 for the header.
    return Math.max(0, text.split('\n').filter(Boolean).length - 1);
  } catch { return 0; }
}

/**
 * Run a batch. Returns a final summary.
 *
 * @param {Object} opts
 * @param {string} [opts.batch]      JSON file with [{code, name}]
 * @param {string} [opts.codes]      Comma-separated codes
 * @param {string} [opts.range]      Code range
 * @param {number} [opts.restartEvery=25]
 * @param {number} [opts.delay=80]
 * @param {boolean} [opts.skipDone=true]  Skip codes with existing CSVs that have rows.
 * @param {boolean} [opts.headed=false]
 * @param {boolean} [opts.resume=false]    Resume from _progress.json.
 * @param {function} [opts.onProgress]    (state) => void called every code.
 */
async function runBatch(opts = {}) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return; }
  const list = loadCodesFromArgs({ ...args, ...opts });
  const restartEvery = opts.restartEvery ?? args.restartEvery;
  const delay        = opts.delay        ?? args.delay;
  const skipDone     = opts.skipDone     ?? args.skipDone;
  const resume       = opts.resume       ?? false;

  // Resume from prior progress if asked.
  let done = new Set();
  let startedAt = new Date().toISOString();
  if (resume) {
    const prev = loadProgress();
    if (prev) {
      done = new Set(prev.done || []);
      startedAt = prev.startedAt || startedAt;
      console.log(`[resume] already done: ${done.size} codes`);
    }
  }

  // Final summary state.
  const summary = {
    startedAt,
    finishedAt: null,
    totalCodes: list.length,
    skipped: 0,
    scraped: 0,
    failed: 0,
    byCode: {},   // {code: {ok, total, scraped, skipped, failed, ...}}
  };

  console.log(`[batch] ${list.length} codes queued. restartEvery=${restartEvery} delay=${delay}ms skipDone=${skipDone}`);
  if (done.size) console.log(`[batch] (resuming, ${done.size} already done)`);

  let lastRestartAt = 0;
  let browserRef = null;       // currently-open browser context (for mid-batch restart)

  for (let i = 0; i < list.length; i++) {
    const { code, name } = list[i];
    const startedAtCode = Date.now();

    // Skip if already done in this run.
    if (done.has(code)) {
      const existing = countCsvRows(code);
      summary.byCode[code] = { skipped: true, rows: existing };
      summary.skipped++;
      continue;
    }
    // Skip if CSV already has rows and skipDone is on.
    if (skipDone) {
      const existing = countCsvRows(code);
      if (existing > 0) {
        summary.byCode[code] = { skipped: true, rows: existing, reason: 'csv already has rows' };
        summary.skipped++;
        done.add(code);
        saveProgress({ startedAt, done: [...done] });
        continue;
      }
    }

    // Periodic summary print.
    if (i % 10 === 0) {
      const elapsed = (Date.now() - Date.parse(startedAt)) / 1000;
      const doneCount = summary.scraped + summary.skipped + summary.failed;
      const eta = doneCount > 0 ? (elapsed / doneCount) * (list.length - doneCount) : 0;
      console.log(`[batch] ${i + 1}/${list.length} (${code}${name ? ' ' + name.slice(0, 30) : ''}) - elapsed ${elapsed.toFixed(0)}s ETA ${eta.toFixed(0)}s`);
    }

    try {
      const codeStart = Date.now();
      const out = path.join(__dirname, '..', 'csv', `${code}.csv`);
      const result = await scrapeCategory({
        code,
        outFile: out,
        headless: !args.headed,
        delayMs:  delay,
        listOnly: !!args.listOnly,
        // No per-company onProgress; we use the summary.
      });
      const codeElapsed = Date.now() - codeStart;
      summary.byCode[code] = {
        ...result,
        elapsedMs: codeElapsed,
        // In list-only mode, the rows are written but result.scraped
        // is 0 (no detail data). result.total is the list-page count.
        rowsWritten: result.scraped > 0 ? result.scraped : (result.total || 0),
      };
      if (result.scraped > 0 || result.total > 0) summary.scraped++;
      else summary.failed++;
      done.add(code);
      saveProgress({ startedAt, done: [...done] });
      console.log(`  [${code}] ${result.scraped} scraped, ${result.skipped} skipped, ${result.failed} failed (${result.total} total, ${codeElapsed}ms)`);
    } catch (err) {
      summary.byCode[code] = { error: err.message || String(err) };
      summary.failed++;
      done.add(code);
      saveProgress({ startedAt, done: [...done] });
      console.log(`  [${code}] ERROR: ${err.message || err}`);
      // Hard error: kill the browser so the next iteration starts fresh.
      try { if (browserRef) await browserRef.close(); } catch {}
      browserRef = null;
    }

    // Periodic browser restart to free memory. We restart AFTER
    // every `restartEvery` codes (counted from the last restart).
    if (restartEvery > 0 && (summary.scraped + summary.skipped + summary.failed) - lastRestartAt >= restartEvery) {
      console.log(`[batch] periodic browser restart (after ${restartEvery} codes)`);
      lastRestartAt = summary.scraped + summary.skipped + summary.failed;
      try { if (browserRef) await browserRef.close(); } catch {}
      browserRef = null;
    }
  }

  summary.finishedAt = new Date().toISOString();
  // Final progress write
  saveProgress({ startedAt, done: [...done], summary });

  console.log('\n=== batch summary ===');
  console.log(`  total codes:     ${summary.totalCodes}`);
  console.log(`  done (>=1 row):  ${summary.scraped}`);
  console.log(`  skipped (had rows already): ${summary.skipped}`);
  console.log(`  failed (threw an error):     ${summary.failed}`);
  console.log(`  total data rows written: ${
    Object.values(summary.byCode).reduce((s, c) => s + ((c.rowsWritten) || (c.rows) || 0), 0)
  }`);

  return summary;
}

module.exports = { runBatch, parseArgs, loadCodesFromArgs, countCsvRows, PROGRESS_FILE, clearProgress };

if (require.main === module) {
  runBatch().catch(err => {
    console.error('FATAL:', err.message || err);
    process.exit(1);
  });
}
