// Click a job card on the Indeed search list by jk; wait for right pane to update.
// usage: node step_card.js <jk>
const { chromium } = require('playwright');
const jk = process.argv[2];
if (!jk) { console.error('usage: node step_card.js <jk>'); process.exit(1); }

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find(p => /th\.indeed\.com\/jobs/.test(p.url())) || ctx.pages()[0];
  const before = page.url();
  // Mobile list renders only ~8 cards; scroll until the target card exists, then click.
  let r = 'NOT_FOUND';
  for (let i = 0; i < 14 && r !== 'CLICKED'; i++) {
    r = await page.evaluate(jk => {
      const a = document.querySelector(`a.jcs-JobTitle[data-jk="${jk}"]`);
      if (a) { a.scrollIntoView({ block: 'center' }); a.click(); return 'CLICKED'; }
      const sc = [...document.querySelectorAll('div,main,section')]
        .filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200)
        .sort((x, y) => y.scrollHeight - x.scrollHeight)[0];
      if (sc) sc.scrollTop = sc.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
      return 'SCROLLED';
    }, jk);
    if (r !== 'CLICKED') await page.waitForTimeout(900);
  }
  if (r !== 'CLICKED') { console.log(JSON.stringify({ ok: false, why: r })); await browser.close(); process.exit(2); }
  // pane update reflects in URL vjk param
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(500);
    if (page.url() !== before && page.url().includes(jk)) break;
  }
  console.log(JSON.stringify({ ok: true, url: page.url(), changed: page.url() !== before }));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
