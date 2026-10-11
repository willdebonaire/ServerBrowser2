#!/usr/bin/env node
/**
 * harvest_jobs.js — Stage 1 of the employer-site application workflow.
 *
 * Walks the Indeed TH search-results list (Khon Kaen) top to bottom. For each
 * job it clicks the card so the detail loads in the RIGHT-HAND PANE (never
 * navigating to viewjob?jk=..., which re-triggers Cloudflare), then reads the
 * pane and captures:
 *
 *   - title / company / location / pay
 *   - the full description text
 *   - the "Apply on company site" link (offsite employer route)
 *   - whether the job is Indeed-hosted apply instead ("Apply with Indeed")
 *
 * Results are written to jobsearch/jobs.json. No applications are submitted —
 * this is capture only. Applying happens later, on the employer websites.
 *
 * Usage:
 *   node harvest_jobs.js [--pages N] [--start N] [--limit N]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:' + (process.env.CDP_PORT || 9222);
const OUT = path.resolve(__dirname, 'jobs.json');
const SEARCH = 'https://th.indeed.com/jobs?q=&l=Khon+Kaen&sort=date';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const LIMIT = arg('--limit', 16);
const START = arg('--start', 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0].pages()[0];

  // Make sure we are on the results list.
  const onResults = () => /indeed\.[a-z.]+\/jobs\?/i.test(page.url());
  if (!onResults()) {
    await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
  }

  const ensureResults = async () => {
    // Safety net only. The main tab stays on the search results the whole time
    // because "Apply on company site" opens the EMPLOYER site in a NEW TAB —
    // it never navigates the job page. So normally this does nothing.
    if (!onResults()) {
      await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3500);
    }
  };

  // Collect the job keys visible on this page.
  const readCards = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('a.jcs-JobTitle[data-jk]')].map((a) => ({
        jk: a.getAttribute('data-jk'),
        title: (a.innerText || '').trim(),
      }))
    );

  await ensureResults();
  const cards = await readCards();

  console.log(`[harvest] found ${cards.length} cards on the page`);

  const jobs = [];
  for (let i = START; i < Math.min(cards.length, START + LIMIT); i++) {
    const { jk, title } = cards[i];
    try {
      await ensureResults();
      // Click the card so the RIGHT PANE shows this job (no viewjob navigation).
      await page.evaluate((k) => {
        const a = document.querySelector(`a.jcs-JobTitle[data-jk="${k}"]`);
        if (a) a.click();
      }, jk);
      await sleep(3200);

      const d = await page.evaluate(() => {
        const pane = document.querySelector('.jobsearch-RightPane, #jobsearch-ViewJobPaneWrapper');
        if (!pane) return { error: 'no right pane' };
        const txt = pane.innerText || '';

        // The apply control lives inside the pane but may be a <button> or a
        // styled <div>/<a> with no href, so match on visible text across the
        // whole document and record where it was found.
        const all = [...document.querySelectorAll('a, button, [role="button"]')].map((e) => ({
          text: (e.innerText || e.textContent || '').trim(),
          href: e.getAttribute('href') || '',
          inPane: !!e.closest('.jobsearch-RightPane, #jobsearch-ViewJobPaneWrapper'),
          tag: e.tagName.toLowerCase(),
        }));
        const applyish = all.filter((l) => /apply|indeedapply|applystart|สมัคร/i.test(l.text + ' ' + l.href));

        const offsite = applyish.find(
          (l) =>
            /applystart/i.test(l.href) ||
            /apply on company site|apply on the company site|company site/i.test(l.text)
        );
        const indeedHosted = applyish.find(
          (l) => /indeedapply/i.test(l.href) || /apply with indeed|easily apply/i.test(l.text)
        );

        const line = (re) => (txt.match(re) || [''])[0].trim();
        return {
          header:
            (pane.querySelector('.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"]') || {})
              .innerText || '',
          company: (
            pane.querySelector('[data-testid="inlineHeader-companyName"]') ||
            pane.querySelector('[data-testid="inlineHeader-companyName"] div') ||
            {}
          ).innerText || '',
          location: (
            pane.querySelector('[data-testid="inlineHeader-companyLocation"]') ||
            pane.querySelector('[data-testid="job-location"]') ||
            {}
          ).innerText || '',
          pay: line(/[\d,]+\s*-\s*[\d,]+\s*THB[^\n]*/) || line(/THB[^\n]*/),
          offsiteHref: offsite ? offsite.href : '',
          indeedHosted: !!indeedHosted,
          applyButtons: applyish.map((l) => l.text || l.href).slice(0, 6),
          description: txt.replace(/\n{2,}/g, '\n').slice(0, 6000),
        };
      });

      // --- Click "Apply on company site" and capture the FINAL redirect URL ---
      let employerUrl = '';
      let employerChain = [];
      if (d.offsiteHref || (d.applyButtons || []).some((t) => /company site/i.test(t))) {
        try {
          const before = page.context().pages().length;
          // Find the offsite control (may be an <a>, <button> or styled <div>).
          const clicked = await page.evaluate(() => {
            const pane = document.querySelector('.jobsearch-RightPane, #jobsearch-ViewJobPaneWrapper');
            if (!pane) return false;
            const els = [...pane.querySelectorAll('a, button, [role="button"]')];
            const el = els.find(
              (e) =>
                /applystart/i.test(e.getAttribute('href') || '') ||
                /apply on company site|apply on the company site/i.test((e.innerText || '').trim())
            );
            if (!el) return false;
            el.click();
            return true;
          });

          if (clicked) {
            // Identify the NEW tab by set difference — never assume index order,
            // and never touch the main search-results tab.
            const beforeSet = new Set(page.context().pages());
            let newPage = null;
            for (let w = 0; w < 18 && !newPage; w++) {
              await sleep(800);
              newPage = page.context().pages().find((p) => !beforeSet.has(p) && p !== page) || null;
            }

            if (newPage) {
              // Let the redirect chain settle (applystart -> employer site).
              try {
                await newPage.waitForLoadState('domcontentloaded', { timeout: 25000 });
              } catch (_) {}
              let last = '';
              for (let w = 0; w < 15; w++) {
                await sleep(1200);
                let cur = '';
                try {
                  cur = newPage.url();
                } catch (_) {
                  break;
                }
                if (cur && cur !== last) {
                  employerChain.push(cur);
                  last = cur;
                }
                // Stop once we have left Indeed's applystart redirector.
                if (cur && !/^https?:\/\/[^/]*indeed\.com\//i.test(cur)) break;
              }
              employerUrl = last || '';
            }
          }
        } catch (e) {
          employerChain.push('ERROR: ' + e.message);
        }
      }

      const clean = (s) => (s || '').replace(/\s*-\s*job post\s*$/i, '').trim();

      // The pane occasionally still shows the previous job; retry until the
      // header matches the card title (or give up after a few attempts).
      let attempts = 0;
      while (attempts < 4 && clean(d.header) && clean(d.header) !== title && !clean(d.header).includes(title.slice(0, 12))) {
        await sleep(2200);
        attempts++;
        const again = await page.evaluate(() => {
          const pane = document.querySelector('.jobsearch-RightPane, #jobsearch-ViewJobPaneWrapper');
          if (!pane) return null;
          const all = [...document.querySelectorAll('a, button, [role="button"]')].map((e) => ({
            text: (e.innerText || e.textContent || '').trim(),
            href: e.getAttribute('href') || '',
          }));
          const applyish = all.filter((l) => /apply|indeedapply|applystart|สมัคร/i.test(l.text + ' ' + l.href));
          const offsite = applyish.find(
            (l) => /applystart/i.test(l.href) || /apply on company site|company site/i.test(l.text)
          );
          const indeedHosted = applyish.find(
            (l) => /indeedapply/i.test(l.href) || /apply with indeed|easily apply/i.test(l.text)
          );
          return {
            header: (pane.querySelector('.jobsearch-JobInfoHeader-title, [data-testid="jobsearch-JobInfoHeader-title"]') || {}).innerText || '',
            offsiteHref: offsite ? offsite.href : '',
            indeedHosted: !!indeedHosted,
            applyButtons: applyish.map((l) => l.text || l.href).slice(0, 6),
          };
        });
        if (again) Object.assign(d, again);
      }

      const row = {
        index: i + 1,
        jk,
        titleFromCard: title,
        title: clean(d.header) || title,
        company: (d.company || '').trim(),
        location: (d.location || '').trim(),
        pay: (d.pay || '').trim(),
        applyRoute: employerUrl
          ? 'employer-site'
          : d.offsiteHref
          ? 'employer-site-redirect-only'
          : d.indeedHosted
          ? 'indeed-hosted'
          : 'unknown',
        employerApplyLink: employerUrl || d.offsiteHref || '',
        indeedApplyRedirect: d.offsiteHref || '',
        redirectChain: employerChain,
        jobUrl: `https://th.indeed.com/viewjob?jk=${jk}`,
        applyButtons: d.applyButtons || [],
        description: d.description || '',
        harvestedAt: new Date().toISOString(),
      };
      jobs.push(row);
      console.log(
        `[harvest] ${i + 1}. ${row.title.slice(0, 40).padEnd(42)} | ${row.applyRoute.padEnd(14)} | ${row.pay.slice(0, 24)}`
      );
    } catch (e) {
      console.log(`[harvest] ${i + 1}. jk=${jk} FAILED: ${e.message}`);
      jobs.push({ index: i + 1, jk, titleFromCard: title, error: String(e.message) });
    }
  }

  // Merge with any previously harvested rows so repeated runs accumulate.
  let existing = [];
  try {
    existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch (_) {}
  const byJk = new Map(existing.map((j) => [j.jk, j]));
  jobs.forEach((j) => byJk.set(j.jk, j));
  const merged = [...byJk.values()].sort((a, b) => a.index - b.index);

  fs.writeFileSync(OUT, JSON.stringify(merged, null, 2));
  console.log(`\n[harvest] wrote ${merged.length} jobs → ${OUT}`);

  const employer = merged.filter((j) => j.applyRoute === 'employer-site').length;
  console.log(`[harvest] employer-site apply links: ${employer}`);
  console.log(`[harvest] indeed-hosted (store for review): ${merged.filter((j) => j.applyRoute === 'indeed-hosted').length}`);
  process.exit(0);
})().catch((e) => {
  console.error('[harvest] fatal:', (e && e.stack) || e);
  process.exit(1);
});
