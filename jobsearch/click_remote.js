// Select the "Remote" option from the open work-mode filter menu on UK Indeed,
// wait for the filtered results, and report the new URL + card count.
// usage: node select_remote.js
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const pgPage = ctx.pages().find(p => /indeed\.com\/jobs/.test(p.url())) || ctx.pages()[0];
  // Drop any open detail pane first.
  if (/[?&]vjk=/.test(pgPage.url())) {
    const u = new URL(pgPage.url()); u.searchParams.delete('vjk');
    await pgPage.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pgPage.waitForTimeout(2000);
  }
  const before = pgPage.url();
  // Ensure the Remote filter menu is open.
  const remoteBtn = pgPage.locator('button, [role="button"], a').filter({ hasText: /^Remote$/ }).first();
  try {
    if ((await remoteBtn.getAttribute('aria-expanded')) !== 'true') await remoteBtn.click({ timeout: 10000 });
  } catch (e) { /* already open or not found; continue */ }
  await pgPage.waitForTimeout(1500);
  // Select the "Remote" option inside the menu (exact text match).
  let clicked = 'not_found';
  const opt = pgPage.locator('[role="menu"] *, [class*="menu"] *, [class*="popover"] *, [class*="dropdown"] *')
    .filter({ hasText: /^Remote$/ }).first();
  try {
    await opt.click({ timeout: 10000 });
    clicked = 'Remote option';
  } catch (e) { clicked = 'err: ' + e.message.slice(0, 80); }
  await pgPage.waitForTimeout(4000);
  for (let i = 0; i < 6 && /just a moment/i.test(await pgPage.title()); i++) await pgPage.waitForTimeout(2000);
  const jks = await pgPage.evaluate(() => [...document.querySelectorAll('a.jcs-JobTitle')].map(a => a.dataset.jk));
  fs.writeFileSync('/tmp/remote.out', JSON.stringify({
    before, after: pgPage.url(), title: await pgPage.title(),
    clicked, count: jks.length, jks
  }, null, 1));
  await browser.close();
})().catch(e => { fs.writeFileSync('/tmp/remote.out', 'ERR ' + e.message); process.exit(1); });