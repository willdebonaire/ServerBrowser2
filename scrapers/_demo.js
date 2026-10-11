/**
 * Demo: read all the scraped CSVs and produce some quick stats.
 * Run: node scrapers/_demo.js
 */
const path = require('path');
const fs   = require('fs');
const CSV_DIR = path.join(__dirname, '..', 'csv');

function parseCsvLine(line) {
  // Minimal RFC-4180 splitter.
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
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const fields = parseCsvLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] || ''; });
    return obj;
  });
}

const files = fs.readdirSync(CSV_DIR).filter(f => f.endsWith('.csv') && !f.startsWith('_'));
console.log(`Loaded ${files.length} CSV files from ${CSV_DIR}\n`);

// Aggregate stats
let totalRows = 0;
const provinces = new Map();
const years = new Map();
let totalCapital = 0;
let capitalCount = 0;

for (const f of files) {
  const rows = readCsv(path.join(CSV_DIR, f));
  totalRows += rows.length;
  for (const r of rows) {
    if (r.list_province) provinces.set(r.list_province, (provinces.get(r.list_province) || 0) + 1);
    if (r.list_year_buddhist) years.set(r.list_year_buddhist, (years.get(r.list_year_buddhist) || 0) + 1);
    const cap = parseInt(r.detail_registered_capital_thb, 10);
    if (!isNaN(cap) && cap > 0) { totalCapital += cap; capitalCount++; }
  }
}

console.log(`Total companies:   ${totalRows}`);
console.log(`Unique provinces:  ${provinces.size}`);
console.log(`Top 10 provinces:`);
const topP = [...provinces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
topP.forEach(([p, n]) => console.log(`  ${p.padEnd(30)} ${n}`));

console.log(`\nYear distribution (Buddhist calendar -> CE):`);
const topY = [...years.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
topY.forEach(([y, n]) => {
  const ce = parseInt(y, 10) - 543;
  console.log(`  ${y} BE (${ce} CE)  ${n} companies`);
});

console.log(`\nCapital (sum across all known):`);
console.log(`  Total:   ${totalCapital.toLocaleString()} THB`);
console.log(`  Average: ${(totalCapital / capitalCount).toLocaleString(undefined, {maximumFractionDigits: 0})} THB (over ${capitalCount} companies)`);

// Show 5 sample records
const all = [];
for (const f of files) {
  const rows = readCsv(path.join(CSV_DIR, f));
  for (const r of rows) all.push(r);
}
console.log(`\n=== 5 sample records ===`);
for (const r of all.slice(0, 5)) {
  console.log(`  ${r.list_category_code} ${r.list_position.padStart(2)}: ${r.list_province} / ${r.list_district}`);
  console.log(`    ${r.detail_name_th || r.list_capital_text}`);
  if (r.detail_address) console.log(`    @ ${r.detail_address.slice(0, 60)}`);
}
