/**
 * dataforthai.com scraper.
 *
 * For each Thai business category code you give it, this:
 *   1. Loads the list page (e.g. /business/objective/01111)
 *   2. For each company in the list, opens the detail iframe
 *   3. Parses the structured fields out of the printview HTML
 *   4. Appends one CSV line per company to the output file
 *
 * Usage:
 *   # Library form:
 *   const { scrapeCategory } = require('./dataforthai');
 *   await scrapeCategory({ code: '01111', outFile: './csv/01111.csv' });
 *
 *   # CLI form:
 *   node scrapers/dataforthai.js --code=01111
 *   node scrapers/dataforthai.js --code=01111,01112
 *   node scrapers/dataforthai.js --code=01111 --out=./csv/corn.csv
 *   node scrapers/dataforthai.js --list-codes   # scrape a curated demo set
 *
 * The CSV is written incrementally (line by line as records are parsed),
 * so if the run is interrupted the partial file is still useful.
 */
const path = require('path');
const fs   = require('fs');
const { launch } = require('../headless');

// ---------------------------------------------------------------------------
// CSV column schema
// ---------------------------------------------------------------------------
//
// We capture both the LIST data (visible on the category page) and the
// DETAIL data (visible in the company iframe). Putting both on a single
// row means each company has a single self-contained record.
//
// Field names use English keys; the original Thai labels are in the
// header comment line so a Thai speaker can map them quickly.
//
const COLUMNS = [
  // From the list page:
  'list_position',          // 1, 2, 3, ...
  'list_category_code',     // e.g. '01111'
  'list_category_name',     // e.g. 'การปลูกข้าวโพดที่ใช้เมล็ดแก่'
  'list_capital_text',      // e.g. '1,000,000' (raw string with commas)
  'list_province',          // e.g. 'นครปฐม'
  'list_district',          // e.g. 'สามพราน'
  'list_year_buddhist',     // e.g. '2569'

  // From the detail iframe (printview):
  'detail_tax_id',           // เลขทะเบียน: e.g. '0735569004240'
  'detail_name_th',         // Thai name (with บริษัท / ห้างหุ้นส่วน prefix)
  'detail_name_en',         // English name, if present
  'detail_business_type',   // ประกอบธุรกิจ: long business description
  'detail_status',          // สถานะ: ยังดำเนินกิจการอยู่ etc.
  'detail_registered_date', // วันที่จดทะเบียน: e.g. '29 เมษายน 2569'
  'detail_registered_capital_thb', // ทุนจดทะเบียน: numeric part, e.g. '1000000'
  'detail_address',         // ที่ตั้ง: full address string

  // Provenance:
  'source_url',             // the /company/.../printview URL
  'scraped_at_iso',         // ISO timestamp of when this row was written
];

// ---------------------------------------------------------------------------
// CSV utilities
// ---------------------------------------------------------------------------

/**
 * Quote a CSV field per RFC 4180:
 *   - If the value contains a comma, double-quote, or newline, wrap in
 *     double-quotes and double any internal double-quotes.
 *   - Otherwise, leave as-is.
 * Newlines are flattened to spaces so each record stays on a single line,
 * which is what was requested.
 */
function csvField(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Flatten newlines/tabs to spaces so each record really is one line.
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/"/g, '""').trim();
  if (/[,"]/.test(s)) return '"' + s + '"';
  return s;
}

function csvRow(values) {
  return values.map(csvField).join(',');
}

/**
 * Write a CSV header line if the file is empty/new. Always returns the
 * file handle so subsequent rows can be appended. The file is opened
 * with a UTF-8 BOM so Excel/Numbers render Thai text correctly when the
 * user double-clicks the .csv.
 */
function openCsv(outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const exists = fs.existsSync(outFile);
  // 'a' = append, but if the file is new we want a BOM.
  const fd = fs.openSync(outFile, 'a');
  if (!exists) {
    fs.writeSync(fd, '\uFEFF');                      // UTF-8 BOM
    fs.writeSync(fd, csvRow(COLUMNS) + '\n');       // header
  }
  return fd;
}

function appendCsvRow(fd, values) {
  fs.writeSync(fd, csvRow(values) + '\n');
}

// ---------------------------------------------------------------------------
// Detail-page parsing
// ---------------------------------------------------------------------------
//
// The company detail page (printview) is a small HTML doc with a layout
// like:
//
//   <h1>บริษัท ...</h1>             <- Thai name (sometimes only this)
//   <h2>... Co., Ltd.</h2>          <- English name (optional)
//   <table>
//     <tr><th>เลขทะเบียน</th><td>0735569004240</td></tr>
//     <tr><th>ประกอบธุรกิจ</th><td>...</td></tr>
//     <tr><th>สถานะ</th><td>...</td></tr>
//     ...
//   </table>
//
// We extract the Thai/English names by walking the headings, then read
// each label/value row from the table.

const DETAIL_LABELS = {
  'เลขทะเบียน':     'detail_tax_id',
  'ประกอบธุรกิจ':   'detail_business_type',
  'สถานะ':          'detail_status',
  'วันที่จดทะเบียน': 'detail_registered_date',
  'ทุนจดทะเบียน':    'detail_registered_capital_thb_raw',
  'ที่ตั้ง':         'detail_address',
};

/**
 * Parse the printview HTML of a company detail page. Returns a
 * partial record object with detail_* fields populated.
 *
 * @param {import('playwright').Page} page  the page already on the list view
 * @param {string} printviewUrl             the iframe URL to open
 * @param {{list_position, list_category_code, list_category_name, list_capital_text, list_province, list_district, list_year_buddhist}} listData
 * @returns {Promise<{ok: boolean, record?: object, error?: string}>}
 */
async function scrapeCompanyDetail(listPage, printviewUrl, listData) {
  // Open the printview in a fresh tab. The bulk-scrape path bypasses
  // this and uses scrapeCompanyDetailOnPage() directly with a
  // long-lived detail tab, to keep memory low on long runs.
  const detailPage = await listPage.context().newPage();
  try {
    return await scrapeCompanyDetailOnPage(detailPage, printviewUrl, listData);
  } finally {
    try { await detailPage.close(); } catch { /* ignore */ }
  }
}

/**
 * Navigate `detailPage` to the printview URL and parse the company
 * fields. The caller owns the page and is responsible for closing it.
 *
 * Reusing one page across many iterations keeps the process count and
 * memory low (~200-400 MB per tab), which matters on memory-tight
 * containers.
 */
async function scrapeCompanyDetailOnPage(detailPage, printviewUrl, listData) {
  try {
    await detailPage.goto(printviewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // The printview is small, so networkidle fires quickly.
    await detailPage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    // Extract fields. We do this in a single page.evaluate so the
    // page object is referenced once.
    //
    // The printview uses a non-standard layout: each label/value pair
    // is its own 1-row, 2-cell table (<td>label</td><td>value</td>).
    // We therefore iterate all tables and pick the ones whose first
    // <td> exactly matches a known Thai label.
    const KNOWN_LABELS = {
      'เลขทะเบียน':     'tax_id',
      'ประกอบธุรกิจ':   'business_type',
      'สถานะ':          'status',
      'วันที่จดทะเบียน': 'registered_date',
      'ทุนจดทะเบียน':    'registered_capital_raw',
      'ที่ตั้ง':         'address',
    };

    const parsed = await detailPage.evaluate((knownLabels) => {
      const out = {};

      // Names: the printview has a Thai heading (h1) and sometimes an
      // English heading (h2). Pick the first H1, then look for an H2.
      const h1 = detailH1();
      const h2 = detailH2();
      if (h1) out.name_th = h1.innerText.trim();
      if (h2) out.name_en = h2.innerText.trim();

      // Find every <tr> with exactly two <td>s where the first <td>'s
      // text contains one of our known labels. (Some labels are
      // followed by a sub-button inside the same <td>, so we do a
      // startsWith check rather than an exact match.)
      const trs = Array.from(document.querySelectorAll('tr'));
      for (const tr of trs) {
        const tds = tr.querySelectorAll(':scope > td');
        if (tds.length < 2) continue;
        const rawLabel = (tds[0].innerText || '').trim();
        // Find the first known label that the cell starts with.
        let matched = null;
        for (const lbl of Object.keys(knownLabels)) {
          if (rawLabel === lbl || rawLabel.startsWith(lbl)) { matched = lbl; break; }
        }
        if (matched) {
          // Concatenate all the value cells' text (in case a field
          // spans multiple <td>s, e.g. the address has "แผนที่" button).
          const value = Array.from(tds).slice(1).map(c => (c.innerText || '').trim()).join(' ').trim();
          out[knownLabels[matched]] = value;
        }
      }
      return out;

      function detailH1() {
        // Pick the first <h1> whose text is not the site-wide title
        // (which is always the same dataforthai tagline).
        const all = Array.from(document.querySelectorAll('h1'));
        return all.find(h => h.innerText.trim() && !/ข้อมูลและเทคโนโลยีเพื่อคนไทย/.test(h.innerText));
      }
      function detailH2() {
        const all = Array.from(document.querySelectorAll('h2'));
        const h2 = all.find(h => {
          const t = (h.innerText || '').trim();
          // English company names typically contain "Co.," "Ltd." etc.
          return t && /Co\.|Ltd\.|Limited|Inc\.|Corporation|Company/i.test(t);
        });
        return h2 || null;
      }
    }, KNOWN_LABELS);

    // Map labels to our schema.
    const rec = {
      detail_tax_id:               parsed.tax_id || '',
      detail_name_th:              parsed.name_th || '',
      detail_name_en:              parsed.name_en || '',
      detail_business_type:        parsed.business_type || '',
      detail_status:               parsed.status || '',
      detail_registered_date:      parsed.registered_date || '',
      detail_registered_capital_thb: numericOnly(parsed.registered_capital_raw || ''),
      detail_address:              parsed.address || '',
    };

    // The site has been known to gate the printview behind a
    // free-account login. When that happens, the page returns the
    // "please sign up" interstitial instead of company data, and
    // every detail_* field is empty. We always return the record
    // (so the list data is preserved) and set `ok: true` only when
    // we got real detail data (i.e. tax_id is present).
    return { ok: !!rec.detail_tax_id, record: { ...listData, ...rec, source_url: printviewUrl } };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  // No finally: the caller owns the page and is responsible for closing it.
}

/** "1,000,000 บาท" -> "1000000"; "" -> "" */
function numericOnly(s) {
  return (s || '').replace(/[^0-9]/g, '');
}

// ---------------------------------------------------------------------------
// List-page parsing
// ---------------------------------------------------------------------------

/**
 * Load the list page and return the metadata + per-company list rows.
 * Each row includes the printview URL so the caller can fetch details.
 *
 * @param {import('playwright').Page} page
 * @param {string} code  e.g. '01111'
 * @returns {Promise<{categoryName: string, list: Array<{position, name, taxId, capital, province, district, year, printviewUrl}>}>}
 */
async function loadList(page, code) {
  const url = `https://www.dataforthai.com/business/objective/${code}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

  // The cookie modal is a positioned overlay that doesn't block the
  // table itself, but it can block .click() if we use one. Since we
  // never click on the page (we open printview in a new tab), the
  // modal is harmless. We still try to dismiss it for cleanliness.
  await dismissCookieModal(page);

  // The list page is rendered server-side. The category name appears
  // in a heading near the top, e.g. "รายชื่อผู้ประกอบการกลุ่มธุรกิจ การปลูกข้าวโพด..."
  const data = await page.evaluate(() => {
    // Find the data table (the one with click-able-row).
    const tables = Array.from(document.querySelectorAll('table'));
    const dataTable = tables.find(t => t.querySelector('tr.click-able-row'));
    if (!dataTable) return { categoryName: '', list: [] };

    // Category name: look in the first <h1> or <h2> before the table.
    // The site uses a heading like "รายชื่อผู้ประกอบการกลุ่มธุรกิจ X".
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'));
    const headingEl = headings.find(h => /รายชื่อผู้ประกอบการ/.test(h.innerText));
    const categoryName = headingEl
      ? headingEl.innerText.replace(/^รายชื่อผู้ประกอบการ(กลุ่มธุรกิจ)?\s*/, '').trim()
      : '';

    const rows = Array.from(dataTable.querySelectorAll('tr.click-able-row'));
    const list = rows.map((row) => {
      const onclick = row.getAttribute('onclick') || '';
      // show__company('TAXID','NAME')
      const m = onclick.match(/show__company\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/);
      const taxId = m ? m[1] : '';
      const nameFromOnclick = m ? m[2] : '';

      const tds = Array.from(row.querySelectorAll('td')).map(td => (td.innerText || '').trim());
      // The 7 columns we observed: [#, name, '', capital, '', 'province\ndistrict', year]
      const position = tds[0] || '';
      const name     = tds[1] || nameFromOnclick;
      const capital  = tds[3] || '';
      const provDist = (tds[5] || '').split('\n').map(s => s.trim()).filter(Boolean);
      const province = provDist[0] || '';
      const district = provDist[1] || '';
      const year     = tds[6] || '';

      // Build the printview URL. The site uses the same transform as
      // show__company:  i.substr(0,7)+i.substr(8,1)+i.substr(7,1)+i.substr(9,5)
      let printviewUrl = '';
      if (taxId) {
        const t = taxId;
        const transformed = t.substr(0, 7) + t.substr(8, 1) + t.substr(7, 1) + t.substr(9, 5);
        printviewUrl = 'https://www.dataforthai.com/company/' + transformed + '/' + encodeURIComponent(nameFromOnclick) + '/printview';
      }

      return { position, name, taxId, capital, province, district, year, printviewUrl };
    });

    return { categoryName, list };
  });

  return data;
}

/**
 * Remove the cookie-consent overlay. The site shows a fixed-position
 * div with "ยอมรับ" (Accept) and "ไม่ยอมรับ" (Decline) buttons. We
 * find the smallest containing fixed/absolute element and remove it.
 */
async function dismissCookieModal(page) {
  try {
    await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
        const t = (el.innerText || '').trim();
        return t.includes('ยอมรับ') && t.includes('ไม่ยอมรับ') && el.children.length < 10;
      });
      candidates.forEach(c => {
        let p = c;
        for (let i = 0; i < 6 && p && p.parentElement; i++) {
          p = p.parentElement;
          if (!p || p.tagName === 'BODY') break;
          const style = getComputedStyle(p);
          if ((style.position === 'fixed' || style.position === 'absolute') && p.offsetWidth > 600) {
            p.remove();
            return;
          }
        }
      });
    });
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Resumability
// ---------------------------------------------------------------------------

/**
 * If `outFile` already exists, parse out the source URLs that have
 * full detail data (i.e. detail_tax_id is non-empty).
 *
 * Returns: { fullDetail: Set<string>, anyRow: Set<string> }
 *   - fullDetail: source_urls that already have detail data. The
 *     per-row loop will skip the detail fetch for these.
 *   - anyRow: all source_urls present. The per-row loop uses this
 *     to skip the row entirely (avoid duplicates across runs).
 *
 * `fullDetail` is what we use to decide whether to re-fetch detail.
 * `anyRow` is what we use to decide whether to skip the whole row.
 *
 * (Naming kept as `loadAlreadyScrapedTaxIds` for backward compat
 * with existing call sites; the return type is a plain object.)
 */
function loadAlreadyScrapedTaxIds(outFile) {
  const result = { fullDetail: new Set(), anyRow: new Set() };
  if (!fs.existsSync(outFile)) return result;
  try {
    const raw = fs.readFileSync(outFile, 'utf8');
    const text = raw.replace(/^\uFEFF/, '');
    const lines = text.split('\n').slice(1).filter(Boolean);
    const taxIdCol = COLUMNS.indexOf('detail_tax_id');
    const urlCol    = COLUMNS.indexOf('source_url');
    for (const line of lines) {
      const fields = parseCsvLine(line);
      const url    = (fields[urlCol] || '').trim();
      const taxId  = (fields[taxIdCol] || '').trim();
      const key    = url || taxId;
      if (key) result.anyRow.add(key);
      // A row counts as having "full detail" if it has a tax_id
      // (which only comes from the printview page).
      if (taxId && url) result.fullDetail.add(url);
      else if (taxId) result.fullDetail.add(taxId);
    }
  } catch (e) {
    console.error('[warn] could not read existing CSV for resume:', e.message);
  }
  return result;
}

/** Minimal RFC-4180 CSV line parser (handles quoted fields). */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { cur += c; }
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') { inQuotes = true; }
      else { cur += c; }
    }
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// High-level scrape
// ---------------------------------------------------------------------------

/**
 * Scrape one category, appending rows to `outFile`. Returns a summary.
 */
async function scrapeCategory({ code, outFile, headless = true, delayMs = 250, onProgress = null, listOnly = false } = {}) {
  if (!code) throw new Error('scrapeCategory: code is required');
  if (!outFile) outFile = path.join(__dirname, '..', 'csv', `${code}.csv`);

  // alreadyDone is { fullDetail, anyRow } from loadAlreadyScrapedTaxIds.
  // - anyRow: every source_url already in the CSV (used to skip the
  //   row entirely so we don't duplicate it).
  // - fullDetail: subset of anyRow where the row has detail data
  //   (we don't need to refetch detail for those).
  const alreadyDone = loadAlreadyScrapedTaxIds(outFile);
  // Per-run dedup: if the scraper is interrupted and restarted within
  // the same process, this set makes sure we don't double-write.
  const writtenThisRun = new Set();
  const fd = openCsv(outFile);
  const summary = { code, outFile, total: 0, scraped: 0, skipped: 0, failed: 0, errors: [] };

  const { page, close } = await launch({ headless });
  // In list-only mode we never touch the printview detail pages,
  // which is ~10-50x faster (each gated printview costs ~1s) and
  // avoids browser memory pressure on large categories.
  let detailPage = null;
  if (!listOnly) {
    // Reuse a single detail page across all iterations. Reusing the
    // same tab keeps memory low and avoids the OOM crash that
    // happens when you open dozens of new tabs.
    // Declared with `let` so we can recreate it if it ever gets closed.
    detailPage = await page.context().newPage();
  }
  try {
    const { categoryName, list } = await loadList(page, code);
    summary.total = list.length;
    console.log(`[${code}] category="${categoryName}" found ${list.length} rows.`);

    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const listData = {
        list_position:        row.position,
        list_category_code:   code,
        list_category_name:   categoryName,
        list_capital_text:    row.capital,
        list_province:        row.province,
        list_district:        row.district,
        list_year_buddhist:   row.year,
      };

      try {
        // Dedup by source_url first, then fall back to taxId. This
        // works even when the printview is gated and detail_tax_id
        // is empty in the existing CSV rows.
        const dedupKey = (row.printviewUrl || '').trim() || (row.taxId || '').trim();
        if (dedupKey && (alreadyDone.anyRow.has(dedupKey) || writtenThisRun.has(dedupKey))) {
          summary.skipped++;
          if (onProgress) onProgress({ ...summary, current: row, phase: 'skip' });
          continue;
        }

        if (!row.printviewUrl) {
          summary.failed++;
          summary.errors.push({ taxId: row.taxId, error: 'no printview URL' });
          continue;
        }

        // If the detail page got closed (e.g. by a crash recovery),
        // create a fresh one before continuing. (In list-only mode
        // detailPage is null, so skip this check.)
        if (detailPage && detailPage.isClosed()) {
          try {
            detailPage = await page.context().newPage();
            summary.errors.push({ taxId: row.taxId, error: 'detail page was closed; recreated' });
          } catch (e) {
            // Couldn't recreate. Write what we have so far and move on.
            summary.errors.push({ taxId: row.taxId, error: 'could not recreate detail page: ' + e.message });
            summary.failed++;
            const rec = { ...listData, source_url: row.printviewUrl, scraped_at_iso: new Date().toISOString() };
            appendCsvRow(fd, COLUMNS.map(c => rec[c] ?? ''));
            if (dedupKey) writtenThisRun.add(dedupKey);
            if (onProgress) onProgress({ ...summary, current: row, phase: 'fail' });
            continue;
          }
        }

        // In list-only mode, skip the detail fetch entirely. We
        // just write the list data and move on.
        let result;
        if (listOnly) {
          result = { ok: false, error: 'list-only mode: detail fetch skipped' };
        } else {
          result = await scrapeCompanyDetailOnPage(detailPage, row.printviewUrl, listData);
        }
        // Build the final record. We ALWAYS write a row for the list data,
        // even if the detail page failed (e.g. the site has gated the
        // detail view behind a login, or one tab got rate-limited).
        // Empty detail_* columns will just be blank in the CSV.
        const record = {
          ...listData,
          ...(result.ok ? result.record : {}),
          source_url: row.printviewUrl,
          scraped_at_iso: new Date().toISOString(),
        };
        appendCsvRow(fd, COLUMNS.map(c => record[c] ?? ''));
        if (dedupKey) writtenThisRun.add(dedupKey);
        if (result.ok) {
          summary.scraped++;
          if (onProgress) onProgress({ ...summary, current: row, phase: 'ok' });
        } else if (listOnly) {
          // In list-only mode the detail was deliberately skipped, so
          // the row is intentionally written without detail data and
          // this isn't a "failure". Just count it as a list-mode row.
          // (Don't push to errors[] to keep the output clean.)
          if (onProgress) onProgress({ ...summary, current: row, phase: 'list' });
        } else {
          summary.failed++;
          summary.errors.push({ taxId: row.taxId, name: row.name, error: result.error });
          if (onProgress) onProgress({ ...summary, current: row, phase: 'fail' });
        }

        // Polite delay between requests. The site isn't aggressive but
        // we don't want to hammer it.
        if (delayMs > 0 && i < list.length - 1) {
          try { await page.waitForTimeout(delayMs); } catch { /* page closed -- ignore */ }
        }
      } catch (err) {
        // Catch-all so one bad row never kills the whole scrape.
        summary.failed++;
        summary.errors.push({ taxId: row.taxId, name: row.name, error: 'outer: ' + (err.message || String(err)) });
        if (onProgress) onProgress({ ...summary, current: row, phase: 'fail' });
      }
    }
  } finally {
    if (detailPage) try { await detailPage.close(); } catch { /* already closed */ }
    try { await close(); } catch { /* ignore */ }
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(`
dataforthai.com scraper

USAGE
  node scrapers/dataforthai.js --code=CATEGORY_CODE[,CATEGORY_CODE...] [flags]
  node scrapers/dataforthai.js --list-codes

FLAGS
  --code=CODES         Comma-separated list of 5-digit business codes
                        (e.g. --code=01111 or --code=01111,01112).
  --out=PATH           Output CSV file. If --code has multiple values
                        the path is treated as a directory.
                        Default: ./csv/<code>.csv
  --headed             Run the browser with a visible window.
  --delay=MS           Delay between detail-page requests (default 250).
  --list-only          Skip the per-company detail fetch. 10-50x faster,
                       useful for big batches when the printview is
                       gated. Detail_* columns will be blank.
  --list-codes         Print a small curated set of category codes to try.
  --help, -h           Show this help.

EXAMPLES
  node scrapers/dataforthai.js --code=01111
  node scrapers/dataforthai.js --code=01111,01112 --out=./csv/agri.csv
  node scrapers/dataforthai.js --code=47111 --out=./csv/supermarkets.csv --delay=500
  node scrapers/dataforthai.js --code=01111 --list-only   # fast mode
`);
    return;
  }
  if (args.listCodes) {
    console.log(`
Curated set of business-category codes to try:

  01111  การปลูกข้าวโพดที่ใช้เมล็ดแก่            (Corn growing, ~28)
  01112  การปลูกธัญพืช (ยกเว้นข้าวและข้าวโพด)   (Cereal crops, ~36)
  01113  การปลูกพืชตระกูลถั่ว                  (Legume crops, ~12)
  47111  ซุปเปอร์มาร์เก็ต                       (Supermarkets, ~100)
  56101  ภัตตาคาร/ร้านอาหาร                  (Restaurants, ~100)
  62010  การเขียนโปรแกรมคอมพิวเตอร์           (Computer programming, varies)
  70110  การบริหารจัดการสำนักงาน               (Office management)

Use:  node scrapers/dataforthai.js --code=01111
`);
    return;
  }

  if (!args.code) {
    console.error('ERROR: --code is required. Use --help or --list-codes for examples.');
    process.exit(1);
  }

  const codes = args.code.split(',').map(s => s.trim()).filter(Boolean);
  const { launch: _ } = { launch: null };  // ensure module loaded
  const allSummaries = [];

  for (const code of codes) {
    let outFile;
    if (args.out) {
      // If --out ends with .csv, treat as a single file (only valid for one code).
      if (codes.length === 1 && /\.csv$/i.test(args.out)) {
        outFile = args.out;
      } else {
        outFile = path.join(args.out, `${code}.csv`);
      }
    } else {
      outFile = path.join(__dirname, '..', 'csv', `${code}.csv`);
    }
    const summary = await scrapeCategory({
      code,
      outFile,
      headless: !args.headed,
      delayMs:  args.delay,
      listOnly: args.listOnly,
      onProgress: (p) => {
        if (p.phase === 'ok') {
          process.stdout.write(`  [${p.code}] ${p.current.position}/${p.total} OK   ${p.current.name.slice(0, 40).padEnd(40)} ${p.current.province}\n`);
        } else if (p.phase === 'list') {
          process.stdout.write(`  [${p.code}] ${p.current.position}/${p.total} LIST ${p.current.name.slice(0, 40).padEnd(40)} ${p.current.province}\n`);
        } else if (p.phase === 'skip') {
          process.stdout.write(`  [${p.code}] ${p.current.position}/${p.total} SKIP (already scraped)  ${p.current.name.slice(0, 30)}\n`);
        } else if (p.phase === 'fail') {
          process.stdout.write(`  [${p.code}] ${p.current.position}/${p.total} FAIL ${p.current.name.slice(0, 30)}: ${p.summary_errors || ''}\n`);
        }
      },
    });
    allSummaries.push(summary);
    console.log(`[${code}] done: scraped=${summary.scraped} skipped=${summary.skipped} failed=${summary.failed}  -> ${outFile}`);
  }

  console.log('\n=== summary ===');
  for (const s of allSummaries) {
    // In list-only mode, "new" means rows actually written (== total
    // because every row is a "new" write). In detail mode, "new"
    // means companies that had at least one row successfully scraped
    // with detail data.
    const written = (s.scraped || 0) + (s.failed || 0);
    console.log(`  ${s.code} (${s.total} companies): ${written} rows written, ${s.skipped} already done, ${s.failed} detail-failed`);
  }
}

function parseArgs(argv) {
  const out = { help: false, headed: false, delay: 250, listCodes: false, listOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--headed') out.headed = true;
    else if (a === '--list-codes') out.listCodes = true;
    else if (a === '--list-only') out.listOnly = true;
    else if (a.startsWith('--code=')) out.code = a.slice('--code='.length);
    else if (a === '--code' && argv[i + 1]) out.code = argv[++i];
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
    else if (a === '--out' && argv[i + 1]) out.out = argv[++i];
    else if (a.startsWith('--delay=')) out.delay = parseInt(a.slice('--delay='.length), 10);
    else if (a === '--delay' && argv[i + 1]) out.delay = parseInt(argv[++i], 10);
  }
  return out;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch(err => {
    console.error('ERROR:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  scrapeCategory,
  scrapeCompanyDetail,
  scrapeCompanyDetailOnPage,
  loadList,
  dismissCookieModal,
  COLUMNS,
  openCsv,
  appendCsvRow,
  csvField,
  csvRow,
  parseCsvLine,
  loadAlreadyScrapedTaxIds,
};
