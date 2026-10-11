#!/usr/bin/env node
/**
 * click_apply.js — click "Apply on company site" in the right pane, follow the
 * NEW TAB through its redirect chain, and print the FINAL employer URL.
 *
 * Key facts learned by doing this by hand:
 *   - The control is a <button> whose href lives in an ATTRIBUTE (not an <a>),
 *     so we match on visible text.
 *   - Clicking it opens the employer site in a NEW TAB. The main search-results
 *     tab is never navigated, so the job page stays put.
 *   - The new tab starts on indeed.com/applystart?... and redirects onward to the
 *     employer's own domain. We want the URL AFTER the redirects.
 *
 * Does NOT submit anything. Does NOT close the employer tab (left open so the
 * user/agent can inspect it), and never closes the main tab.
 *
 * Usage: node click_apply.js
 */
const { chromium } = require('playwright');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const b = await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:9222');
  const ctx = b.contexts()[0];
  const pages = ctx.pages();
  const main = pages.find((p) => /indeed\.[a-z.]+\/jobs\?/i.test(p.url()));
  if (!main) {
    console.error('ERR: no Indeed search-results tab open');
    process.exit(1);
  }

  const before = new Set(ctx.pages());

  const clicked = await main.evaluate(() => {
    const pane = document.querySelector('.jobsearch-RightPane, #jobsearch-ViewJobPaneWrapper');
    if (!pane) return 'no-pane';
    const btn = [...pane.querySelectorAll('button, a, [role="button"]')].find((e) =>
      /apply on company site|apply on the company site/i.test((e.innerText || '').trim())
    );
    if (!btn) return 'no-offsite-button';
    btn.click();
    return 'clicked';
  });

  if (clicked !== 'clicked') {
    console.log(JSON.stringify({ ok: false, reason: clicked }));
    process.exit(0);
  }

  // Wait for the NEW tab (identified by set difference — never by index).
  let target = null;
  for (let i = 0; i < 20 && !target; i++) {
    await sleep(700);
    target = ctx.pages().find((p) => !before.has(p) && p !== main) || null;
  }
  if (!target) {
    console.log(JSON.stringify({ ok: false, reason: 'no new tab appeared' }));
    process.exit(0);
  }

  try {
    await target.waitForLoadState('domcontentloaded', { timeout: 25000 });
  } catch (_) {}

  // Follow the redirect chain until we leave Indeed's applystart redirector.
  const chain = [];
  let last = '';
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    let cur = '';
    try {
      cur = target.url();
    } catch (_) {
      break;
    }
    if (cur && cur !== last) {
      chain.push(cur);
      last = cur;
      if (!/^https?:\/\/[^/]*indeed\.com\//i.test(cur)) break;
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        finalUrl: last,
        isEmployerDomain: !/^https?:\/\/[^/]*indeed\.com\//i.test(last),
        redirectChain: chain,
      },
      null,
      1
    )
  );
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});