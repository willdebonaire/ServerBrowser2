// Navigate the live Chrome to a URL, then reset to a clean list (drop any
// open detail pane vjk=) so the card list is visible again.
// usage: node goto.js <url>
const { chromium } = require('playwright');
(async () => {
  const url = process.argv[2];
  if (!url) { console.error('usage: node goto.js <url>'); process.exit(2); }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /indeed\.com/.test(p.url())) || ctx.pages()[0];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2000);
    // Drop any open detail pane so the card list renders. Indeed may re-add
  // vjk= on load, so loop until it's gone.
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.waitForTimeout(1000);
    if (!/[?&]vjk=/.test(page.url())) break;
    const u = new URL(page.url()); u.searchParams.delete('vjk');
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  for (let i = 0; i < 10 && /just a moment/i.test(await page.title()); i++) await page.waitForTimeout(2000);
  console.log(JSON.stringify({ url: page.url(), title: await page.title() }));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });