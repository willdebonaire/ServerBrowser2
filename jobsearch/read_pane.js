#!/usr/bin/env node
/**
 * read_pane.js — read the CURRENT right-hand pane of the Indeed search page.
 *
 * Side-effect free: it does not click, navigate, or open tabs. It just reports
 * what the right pane currently shows, so the job can be inspected step by step
 * before anything is recorded.
 *
 * Usage: node read_pane.js
 */
const { chromium } = require('playwright');

(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  const pages = b.contexts()[0].pages();
  // The search-results tab is the one on indeed.com/jobs
  const page = pages.find((p) => /indeed\.[a-z.]+\/jobs\?/i.test(p.url())) || pages[0];

  const d = await page.evaluate(() => {
    const pane = document.querySelector('.jobsearch-RightPane, #jobsearch-ViewJobPaneWrapper');
    if (!pane) return { error: 'no right pane' };
    const txt = pane.innerText || '';

    // Apply controls — note Indeed renders these as <button> elements whose
    // href lives in an ATTRIBUTE, so we must read both text and href.
    const controls = [...pane.querySelectorAll('a, button, [role="button"]')].map((e) => ({
      tag: e.tagName.toLowerCase(),
      text: (e.innerText || '').trim(),
      href: e.getAttribute('href') || e.getAttribute('data-href') || '',
    }));
    const applyish = controls.filter((c) => /apply|สมัคร/i.test(c.text + ' ' + c.href));

    const line = (re) => (txt.match(re) || [''])[0].trim();
    return {
      pageUrl: location.href,
      title: ((pane.querySelector('.jobsearch-JobInfoHeader-title') || {}).innerText || '')
        .replace(/\s*-\s*job post\s*$/i, '')
        .trim(),
      company: (pane.querySelector('[data-testid="inlineHeader-companyName"]') || {}).innerText || '',
      location: (pane.querySelector('[data-testid="inlineHeader-companyLocation"]') || {}).innerText || '',
      pay: line(/[\d,]+\s*[-–]\s*[\d,]+\s*THB[^\n]*/) || line(/THB[^\n]*/),
      applyControls: applyish,
      applyRoute: applyish.some((c) => /company site/i.test(c.text))
        ? 'employer-site'
        : applyish.some((c) => /apply with indeed|easily apply/i.test(c.text))
        ? 'indeed-hosted'
        : 'unknown',
      description: txt.replace(/\n{2,}/g, '\n').trim(),
    };
  });

  console.log(JSON.stringify(d, null, 1));
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});