# dataforthai.com scraper

Located in `scrapers/dataforthai.js`. Scrapes the business directory at
https://www.dataforthai.com/business/objective/{code} and writes one
CSV row per company.

## Quick start

```bash
# From this folder:
node scrapers/dataforthai.js --code=01111

# Output goes to ./csv/01111.csv
# - 28 rows for category 01111 (corn growing)
# - one record per line, UTF-8 + BOM (Excel-compatible)
# - 17 columns total (see "CSV schema" below)

# Run multiple categories at once
node scrapers/dataforthai.js --code=01111,01112,01113

# Custom output location
node scrapers/dataforthai.js --code=01111 --out=/path/to/myfile.csv

# Re-run is safe: existing tax IDs are skipped
node scrapers/dataforthai.js --code=01111
#   -> "12 skipped (already done), 0 new, 0 failed"

# Fast list-only mode (skips per-company detail pages, ~10-50x faster).
# Detail_* columns will be empty; only the 7 list_* columns are filled.
# Best for big batches when the printview is gated behind a login.
node scrapers/dataforthai.js --code=01111 --list-only

# See curated codes to try
node scrapers/dataforthai.js --list-codes

# SCRAPE MANY AT ONCE — the batch runner handles 200+ categories in one go.
# Pre-built batch of 200 categories in scrapers/_batch200.json (codes 01111-10779).
node scrapers/batch.js                          # full 200-code batch, list-only
node scrapers/batch.js --list-only             # same, explicit
node scrapers/batch.js --codes=01111,01112,01113 --list-only
node scrapers/batch.js --range=01111-01300 --list-only
node scrapers/batch.js --list-only --restart-every=20  # more frequent browser restarts
```

### `--list-only` vs detail mode

The site gates the per-company printview page (`/company/{tax-id}/.../printview`)
behind a free-account login. If you don't have a logged-in session, those
detail pages come back as a "please sign up" interstitial and the
detail_* fields are empty.

- **Detail mode (default):** visits the list page + tries each
  printview. Each printview takes ~1s. Useful when you DO have a
  logged-in session, or for tiny batches.
- **`--list-only`:** visits only the list page. Skips the printview
  entirely. ~10-50x faster. The 7 list_* columns are populated; the
  8 detail_* columns are blank. The `source_url` column is preserved
  so you can fetch details manually later.

The batch runner (`scrapers/batch.js`) defaults to `--list-only`
because that's the right default for big batches. To force detail
mode in a batch, drop the flag:

```bash
node scrapers/batch.js --list-only=false   # or just don't pass it
```

When run with detail mode against a gated site, every row still gets
written (the list data is captured) and the 8 detail_* columns are
empty. So you don't lose data either way.

## CSV schema (17 columns)

| # | Column | Source | Example |
| - | ------ | ------ | ------- |
| 1 | `list_position` | list page | `1` |
| 2 | `list_category_code` | CLI arg | `01111` |
| 3 | `list_category_name` | list page | `การปลูกข้าวโพดที่ใช้เมล็ดแก่` |
| 4 | `list_capital_text` | list page | `1,000,000` |
| 5 | `list_province` | list page | `นครปฐม` |
| 6 | `list_district` | list page | `สามพราน` |
| 7 | `list_year_buddhist` | list page | `2569` (= 2026 CE) |
| 8 | `detail_tax_id` | printview | `0735569004240` |
| 9 | `detail_name_th` | printview | `บริษัท 29 คอนสทรัคชั่น แอนด์ เอ็นจิเนียริ่ง จำกัด` |
| 10 | `detail_name_en` | printview | `29 CONSTRUCTION AND ENGINEERING Co., Ltd.` |
| 11 | `detail_business_type` | printview | long Thai description |
| 12 | `detail_status` | printview | `ยังดำเนินกิจการอยู่` (active) |
| 13 | `detail_registered_date` | printview | `29 เมษายน 2569` (Thai date) |
| 14 | `detail_registered_capital_thb` | printview | `1000000` (numeric only) |
| 15 | `detail_address` | printview | `88/4 หมู่บ้าน แลนซีโอ...` |
| 16 | `source_url` | derived | `https://www.dataforthai.com/company/.../printview` |
| 17 | `scraped_at_iso` | derived | `2026-07-21T03:22:02.510Z` |

Columns 1-7 are **always populated** (they come from the public list
page). Columns 8-15 come from the per-company printview page, which
as of 2026-07-21 is **gated behind a free account login** for most
categories. The scraper handles that gracefully: when gated, columns
8-15 will be empty and column 16 (the printview URL) is preserved so
you can fetch details manually once you have an account.

## Library API

```js
const { scrapeCategory, scrapeCompanyDetail, loadList } = require('./scrapers/dataforthai');

// Scrape a single category, writing rows to a CSV.
const summary = await scrapeCategory({
  code: '01111',
  outFile: './csv/01111.csv',  // optional
  delayMs: 250,                // polite delay between detail requests
  onProgress: (p) => console.log(p.phase, p.current.name),
});
console.log(summary);
// { code: '01111', outFile: '...', total: 28, scraped: N, skipped: N, failed: N, errors: [...] }

// Just get the list (no detail fetching):
const { page, close } = await launch({ url: 'https://www.dataforthai.com/business/objective/01111' });
const { categoryName, list } = await loadList(page, '01111');
console.log(categoryName, list.length);  // 'การปลูกข้าวโพดที่ใช้เมล็ดแก่' 28
await close();

// Fetch a single detail page (returns {ok, record} or {ok:false, error}):
const result = await scrapeCompanyDetail(page, 'https://www.dataforthai.com/company/.../printview', {});
```

## How the data is fetched

1. **List page** (`/business/objective/{code}`) — the site renders this
   server-side as a `<table>` where each row has class `click-able-row`
   and an `onclick="show__company(taxId, name)"`. We extract the
   position, name, capital, province, district, year, and tax ID for
   every row, then build a printview URL by transforming the tax ID
   (the site swaps two characters for obfuscation; the transform is
   `substr(0,7) + substr(8,1) + substr(7,1) + substr(9,5)`).

2. **Detail page** (`/company/{transformed-tax-id}/{url-encoded-name}/printview`) —
   this is a small HTML doc with the company fields. We parse it by
   looking for `<tr>` rows whose first `<td>` matches a known Thai
   label (`เลขทะเบียน`, `ประกอบธุรกิจ`, etc.). The English name is
   read from the page's `<h2>` (if present). This page is currently
   gated behind a free-account login, so most detail fields will be
   empty unless the user is logged in.

3. **Cookies** — a one-time cookie consent dialog is dismissed
   automatically by removing the modal element via JS.

4. **Persistence** — the scraper uses the same persistent profile at
   `../profile/` as the rest of the `ServerBrowser` toolkit, so cookies
   (e.g. a logged-in account) carry over.

5. **Resumability** — if the output CSV already exists, the scraper
   reads it, extracts all known `detail_tax_id` values, and skips
   those companies on re-run. New rows are appended.

6. **Robustness** —
   - The detail page is reused across iterations (not opened/closed
     per company) to keep memory low.
   - If the detail page ever gets closed mid-run, the scraper
     automatically recreates it and continues.
   - If a single detail fetch fails (404, gated, parse error), the
     list data is still written and the failure is recorded in
     `summary.errors[]`.

## Memory and timing

- About 5-8 seconds per company (1 list-page nav + 1 detail-page
  nav + 1 detail parse + small delay).
- ~200-400 MB resident memory for the headless Chrome process.
- A full category of 100 companies takes ~10-15 minutes.

## Known limitations

- **Detail pages are gated by Cloudflare** as of 2026-07-21. When
  Cloudflare's bot challenge is active, the printview URL
  (`/company/{tax-id}/{name}/printview`) returns a "please sign up"
  interstitial instead of the company data. A valid
  `cf_clearance` cookie in the persistent profile unblocks the
  detail pages. With a fresh cookie, the scraper successfully
  fetches ALL the per-company fields listed in the schema above.
  Without one, the `detail_*` columns will be empty.

- **Phone / email / website are not in the public data.** The site
  only has the basic company info (name, tax ID, business type,
  status, registration date, capital, address). The "ค้นหาเบอร์โทร"
  (Find phone) button on the detail page is just a Google search
  link. The official DBD DataWarehouse
  (https://datawarehouse.dbd.go.th/) doesn't have per-company
  contact info either — it just has a generic DBD phone/email.
  Phone, email, and website would have to come from the company
  registering themselves on the DBD e-Service portal.

- **No pagination.** Each category page caps at 100 rows; the site
  doesn't seem to expose a "next page" control. If a category has
  more than 100 companies, only the first 100 are scraped.

- **Rate limiting.** A polite `delayMs` of 200-500ms is recommended.
  The site doesn't seem to aggressively rate-limit, but a sustained
  100-requests-per-minute pace may trigger a temporary block.

## About the existing CSVs

The 200 CSVs in `csv/` were generated with the `--list-only` mode
(the fast mode that skips the per-company detail fetch). That run
captured list-level data (position, category, capital, province,
district, year, source_url) for all 9,969 companies, but the
`detail_*` columns are empty because the per-company printview
pages were not visited.

The scraper IS capable of filling in the detail columns
(see `01111.csv` for an example — rows 1-8 have full Thai + English
names, business type, status, address, etc.) but doing so for
all 9,969 rows requires an unblocked session and ~3-5 hours of
scraping time.

To backfill in place: see `scrapers/backfill.js`. Note that the
backfill will be slow and may fail if the site is currently gated.
