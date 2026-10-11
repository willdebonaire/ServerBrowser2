#!/usr/bin/env node
/**
 * indeed-post-all.js - Post all P2I internships to Indeed
 * Usage: node scripts/indeed-post-all.js [--dry-run] [--id <job-id>]
 * Tracks posted jobs in /opt/lampp/htdocs/P2I/data/indeed-posted.json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:' + (process.env.CDP_PORT || 9222);
const INTERNSHIPS_DIR = '/opt/lampp/htdocs/P2I/data/internships';
const TRACKING_FILE = '/opt/lampp/htdocs/P2I/data/indeed-posted.json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Human-like delay between actions (2-5 seconds)
const humanDelay = () => sleep(2000 + Math.random() * 3000);
// Longer delay between jobs (10-20 seconds)
const jobDelay = () => sleep(10000 + Math.random() * 10000);

function loadTracking() {
  try { return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); }
  catch { return { posted: {}, failed: {}, lastUpdated: null }; }
}
function saveTracking(t) {
  t.lastUpdated = new Date().toISOString();
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(t, null, 2));
}
function buildRichHTML(job) {
  const p = [];
  p.push('<p><strong>' + job.title + '</strong></p>');
  p.push('<p><strong>About the Role</strong></p>');
  p.push('<p>' + job.description + '</p>');
  if (job.type === 'Voluntary') {
    p.push('<p>This is a <strong>voluntary (unpaid)</strong>, remote internship. You will work ' + (job.hoursPerWeek || '15-20 hours') + ' per week with a flexible schedule. Duration: ' + job.duration + '.</p>');
  }
  if (job.responsibilities && job.responsibilities.length) {
    p.push('<p><strong>Responsibilities</strong></p>');
    p.push('<ul>' + job.responsibilities.map(r => '<li>' + r + '</li>').join('') + '</ul>');
  }
  if (job.requirements && job.requirements.length) {
    p.push('<p><strong>Requirements</strong></p>');
    p.push('<ul>' + job.requirements.map(r => '<li>' + r + '</li>').join('') + '</ul>');
  }
  if (job.benefits && job.benefits.length) {
    p.push('<p><strong>Benefits</strong></p>');
    p.push('<ul>' + job.benefits.map(b => '<li>' + b + '</li>').join('') + '</ul>');
  }
  p.push('<p>Mentored by ' + (job.project_leader || 'our team') + '. This internship is part of the P2Intern platform, connecting learners with established companies for guaranteed internship placements.</p>');
  return p.join('\n');
}

async function clickContinue(page) {
  try {
    const btn = await page.$('button:has-text("Continue")');
    if (btn && await btn.isVisible()) { await btn.click(); return; }
  } catch {}
  try {
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button')) {
        if (b.textContent.trim() === 'Continue' && b.offsetParent !== null) { b.click(); return; }
      }
    });
  } catch {}
}

async function skipSponsorship(page) {
  for (let i = 0; i < 5; i++) {
    const t = await page.title();
    const u = page.url();
    if (!t.toLowerCase().includes('sponsor') && !u.includes('sponsor')) return;
    console.log('  -> Skipping sponsorship (attempt ' + (i+1) + ')...');
    try {
      const btn = await page.$('button:has-text("No thanks")');
      if (btn && await btn.isVisible()) { await btn.click(); await sleep(3000); continue; }
    } catch {}
    try {
      const btn2 = await page.$('button:has-text("Skip free trial"), a:has-text("Skip free trial")');
      if (btn2 && await btn2.isVisible()) { await btn2.click(); await sleep(3000); continue; }
    } catch {}
    // Navigate away
    try {
      await page.goto('https://employers.indeed.com/jobs?status=open%2Cpaused', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      return;
    } catch {}
  }
}

async function postJob(page, job) {
  console.log('\n' + '='.repeat(60));
  console.log('POSTING: ' + job.title + ' (' + job.id + ')');
  console.log('='.repeat(60));

  // Step 1: Go to job creation
  console.log('[1/7] Navigating to job creation...');
  await page.goto('https://employers.indeed.com/post-job', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  if (!await waitForCaptcha(page)) return false;
  await humanDelay();

  // Check for account setup page
  let url = page.url();
  if (url.includes('employer-setup') || url.includes('account-details')) {
    console.log('  -> Filling account details...');
    const ci = await page.$('#employer-company-name, input[name*="companyName" i]');
    if (ci) await ci.fill('P2Intern');
    const fn = await page.$('#employerFirstName, input[name*="firstName" i]');
    if (fn) await fn.fill('P2I');
    const ln = await page.$('#employerLastName, input[name*="lastName" i]');
    if (ln) await ln.fill('Careers');
    await clickContinue(page);
    await sleep(3000);
  }

  // Step 2: Fill job title
  console.log('[2/7] Filling job title: ' + job.title);
  await sleep(2000);
  // Find title input - try multiple selectors
  let titleFilled = false;
  for (const sel of ['input[id*="job-title" i]', 'input[name*="jobTitle" i]', 'input[placeholder*="job title" i]', 'input[aria-label*="job title" i]']) {
    const inp = await page.$(sel);
    if (inp && await inp.isVisible()) { await inp.click(); await inp.fill(job.title); titleFilled = true; break; }
  }
  if (!titleFilled) {
    // Try the first visible text input
    const inp = await page.evaluateHandle(() => {
      for (const el of document.querySelectorAll('input')) {
        if (el.offsetParent && el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio') return el;
      }
      return null;
    });
    if (inp) { await inp.asElement().click(); await inp.asElement().fill(job.title); titleFilled = true; }
  }
  await sleep(2000);

  // Step 3: Set location
  console.log('[3/7] Setting location to Remote...');
  try {
    const combo = await page.$('div[role="combobox"]:has-text("person"), div[role="combobox"]:has-text("Remote"), div[role="combobox"]:has-text("Hybrid"), div[role="combobox"]:has-text("remote" i)');
    if (combo) {
      await combo.click();
      await sleep(1000);
      const remote = await page.$('li:has-text("Fully remote")');
      if (remote) { await remote.click(); await sleep(1000); }
    }
  } catch {}

  // Step 4: Navigate intermediate steps
  console.log('[4/7] Filling intermediate steps...');
  await clickContinue(page);
  await sleep(5000);
  if (!await waitForCaptcha(page)) return false;

  // Handle various step pages
  for (let step = 0; step < 10; step++) {
    const t = (await page.title()).toLowerCase();
    const u = page.url();

    if (t.includes('hiring') || t.includes('timeline')) {
      console.log('  -> Hiring timeline step...');
      // Select timeline if dropdown visible
      try {
        const dd = await page.$('div[role="combobox"]:has-text("Select")');
        if (dd) { await dd.click(); await sleep(1000); const opt = await page.$('li:has-text("2 to 4 weeks")');
          if (opt) await opt.click(); await sleep(1000); }
      } catch {}
      // Set openings
      try { await page.fill('input[placeholder="0"]', '1'); } catch {}
      await sleep(1000);
      await clickContinue(page);
      await sleep(4000);
      continue;
    }

    if (t.includes('detail')) {
      console.log('  -> Job details step...');
      try { const l = await page.$('label:has-text("Part-time")'); if (l) await l.click(); } catch {}
      await sleep(1000);
      try { await page.fill('#working-hours-minimum', '15'); } catch {}
      await sleep(1000);
      await clickContinue(page);
      await sleep(4000);
      continue;
    }

    if (t.includes('pay')) {
      console.log('  -> Pay step...');
      try { await page.fill('#jobMinimumPayInput', '1'); } catch {}
      try { await page.fill('#jobMaximumPayInput', '2'); } catch {}
      await sleep(1000);
      try { const fl = await page.$('label:has-text("Flexible schedule")'); if (fl) await fl.click(); } catch {}
      await sleep(1000);
      await clickContinue(page);
      await sleep(4000);
      continue;
    }

    if (t.includes('describ')) break; // reached description page
    if (t.includes('review')) break; // already at review
    break; // unknown page, move on
  }

  // Step 5: Job description
  console.log('[5/7] Filling job description...');
  let dt = (await page.title()).toLowerCase();
  if (dt.includes('describ')) {
    // Delete existing AI description
    try {
      const delBtn = await page.$('button[aria-label="Delete job description"]');
      if (delBtn) {
        await delBtn.click();
        await sleep(1500);
        const confBtn = await page.$('button:has-text("Delete job description")');
        if (confBtn && await confBtn.isVisible()) { await confBtn.click(); await sleep(2000); }
      }
    } catch {}

    // Paste our description
    const editor = await page.$('[contenteditable]');
    if (editor) {
      await editor.click();
      await sleep(500);
      const html = buildRichHTML(job);
      await page.evaluate((htmlContent) => {
        const el = document.querySelector('[contenteditable]');
        if (!el) return;
        el.focus();
        const d = new DataTransfer();
        d.setData('text/html', htmlContent);
        d.setData('text/plain', htmlContent.replace(/<[^>]+>/g, ''));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }));
      }, html);
      await sleep(2000);
    }

    await clickContinue(page);
    await sleep(4000);
  }

  // Step 6: Review and confirm
  console.log('[6/7] Reviewing and confirming...');
  dt = (await page.title()).toLowerCase();
  if (dt.includes('review')) {
    try {
      const confirm = await page.$('button:has-text("Confirm")');
      if (confirm) { await confirm.click(); await sleep(5000); }
    } catch {}
    await skipSponsorship(page);
  }

  // Step 7: Verify
  console.log('[7/7] Verifying...');
  await sleep(3000);
  try {
    await page.goto('https://employers.indeed.com/jobs?status=open%2Cpaused', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    await waitForCaptcha(page, 60);
    await sleep(3000);
    const text = await page.evaluate(() => document.body.innerText);
    if (text.includes(job.title)) {
      console.log('SUCCESS: "' + job.title + '" posted!');
      return true;
    }
    console.log('WARNING: Could not verify "' + job.title + '" in jobs list.');
    return false;
  } catch (err) {
    console.log('ERROR verifying: ' + err.message);
    return false;
  }
}

// Check for Cloudflare CAPTCHA and wait for manual resolution
async function waitForCaptcha(page, timeoutSec = 120) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    const title = await page.title();
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    if (title.includes('moment') || title.includes('Verification') || text.includes('Verify you are human') || text.includes('Additional Verification')) {
      console.log('\n⚠️  CAPTCHA detected! Please solve it via VNC viewer.');
      console.log('   Waiting up to ' + timeoutSec + ' seconds...');
      await sleep(5000);
      continue;
    }
    return true; // No captcha
  }
  console.log('CAPTCHA timeout! Skipping this job.');
  return false;
}

// ── Main ──
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const specificId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null;

  const files = fs.readdirSync(INTERNSHIPS_DIR).filter(f => f.endsWith('.json'));
  const allJobs = files.map(f => JSON.parse(fs.readFileSync(path.join(INTERNSHIPS_DIR, f), 'utf8')));

  const tracking = loadTracking();

  // Mark the manually-posted software-engineering-intern
  if (!tracking.posted['software-engineering-intern']) {
    tracking.posted['software-engineering-intern'] = { postedAt: '2026-08-11T00:00:00Z', title: 'Software Engineering Intern', note: 'Posted manually via VNC' };
    saveTracking(tracking);
  }

  let jobsToPost = allJobs.filter(j => !tracking.posted[j.id]);
  if (specificId) jobsToPost = jobsToPost.filter(j => j.id === specificId);

  console.log('\nP2I Indeed Job Poster');
  console.log('-'.repeat(40));
  console.log('Total: ' + allJobs.length + ' | Posted: ' + Object.keys(tracking.posted).length + ' | To post: ' + jobsToPost.length);

  if (dryRun) {
    console.log('\nDRY RUN:');
    jobsToPost.forEach((j, i) => console.log('  ' + (i+1) + '. ' + j.title + ' (' + j.id + ')'));
    return;
  }

  if (!jobsToPost.length) { console.log('\nAll jobs posted!'); return; }

  console.log('\nConnecting to Chrome...');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages()[0];
  if (!page) { console.error('No page!'); process.exit(1); }
  console.log('Connected: ' + page.url());

  let ok = 0, fail = 0;
  for (let i = 0; i < jobsToPost.length; i++) {
    const job = jobsToPost[i];
    try {
      const success = await postJob(page, job);
      if (success) { tracking.posted[job.id] = { postedAt: new Date().toISOString(), title: job.title }; ok++; }
      else { tracking.failed[job.id] = { attemptedAt: new Date().toISOString(), title: job.title, error: 'Not verified' }; fail++; }
    } catch (err) {
      console.error('ERROR: ' + job.title + ': ' + err.message);
      tracking.failed[job.id] = { attemptedAt: new Date().toISOString(), title: job.title, error: err.message };
      fail++;
    }
    saveTracking(tracking);
    if (i < jobsToPost.length - 1) { console.log('Waiting between jobs...'); await jobDelay(); }
  }

  console.log('\n' + '='.repeat(60));
  console.log('DONE! Success: ' + ok + ' | Failed: ' + fail + ' | Total posted: ' + Object.keys(tracking.posted).length + '/' + allJobs.length);
  console.log('='.repeat(60));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
