// Scroll the results list to load lazy cards, then report all visible jks.
// usage: node scroll_list.js [rounds]   (detached; writes /tmp/scroll.out)
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const rounds = parseInt(process.argv[2] || '14', 10);
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /indeed\.com\/jobs/.test(p.url())) || ctx.pages()[0];
  // Strip any open detail pane (Indeed may re-add vjk=; loop until gone).
  for (let attempt = 0; attempt < 6; attempt++) {
    await page.waitForTimeout(1000);
    if (!/[?&]vjk=/.test(page.url())) break;
    const u = new URL(page.url()); u.searchParams.delete('vjk');
    await page.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  for (let i = 0; i < 8 && /just a moment/i.test(await page.title()); i++) await page.waitForTimeout(2000);
  for (let i = 0; i < rounds; i++) {
    await page.evaluate(() => {
      const sc = [...document.querySelectorAll('div,main,section')]
        .filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200)
        .sort((x, y) => y.scrollHeight - x.scrollHeight)[0];
      if (sc) sc.scrollTop = sc.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
    });
    await page.waitForTimeout(1400);
  }
  const jks = await page.evaluate(() => [...document.querySelectorAll('a.jcs-JobTitle')].map(a => a.dataset.jk));
  fs.writeFileSync('/tmp/scroll.out', JSON.stringify({ url: page.url(), count: jks.length, jks }, null, 1));
  await browser.close();
})().catch(e => { fs.writeFileSync('/tmp/scroll.out', 'ERR ' + e.message); process.exit(1); });
