// One-job driver: click card -> read right pane -> if employer-site, click
// "Apply on company site" and capture the new tab's final URL.
// usage: node step_job.js <jk> [page]     (run from /projects/ServerBrowser)
//   page = the pagination page number this jk lives on (stored in the record).
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const jk = process.argv[2];
const pg = process.argv[3] || '1';
if (!jk) { console.error('usage: node step_job.js <jk> [page]'); process.exit(1); }
const OUT = '/tmp/uk';
try { fs.mkdirSync(OUT, { recursive: true }); } catch (e) {}

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const pgPage = ctx.pages().find(p => /indeed\.com\/jobs/.test(p.url())) || ctx.pages()[0];
  // Reset to the clean list first: when a pane is open (vjk in URL) the card
  // list is display:none on mobile and DOM clicks are ignored.
  if (/[?&]vjk=/.test(pgPage.url())) {
    // Reset to the clean list but KEEP pagination (start=) so page-2+ targets
    // stay findable in the left list.
    const u = new URL(pgPage.url());
    u.searchParams.delete('vjk');
    await pgPage.goto(u.toString(), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pgPage.waitForTimeout(2500);
    // Cloudflare occasionally interposes on the reset; wait for it to clear.
    for (let i = 0; i < 10 && /just a moment/i.test(await pgPage.title()); i++) await pgPage.waitForTimeout(2000);
    if (/just a moment/i.test(await pgPage.title())) {
      console.log(JSON.stringify({ ok: false, stage: 'challenge', jk }));
      await browser.close(); process.exit(3);
    }
  }
  const before = pgPage.url();

  // 1. click the card (DOM-level; list may be visually hidden while a pane is open)
  let r = 'NOT_FOUND';
  for (let i = 0; i < 14 && r !== 'CLICKED'; i++) {
    r = await pgPage.evaluate(jk => {
      const a = document.querySelector(`a.jcs-JobTitle[data-jk="${jk}"]`);
      if (a) { a.scrollIntoView({ block: 'center' }); a.click(); return 'CLICKED'; }
      const sc = [...document.querySelectorAll('div,main,section')]
        .filter(e => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 200)
        .sort((x, y) => y.scrollHeight - x.scrollHeight)[0];
      if (sc) sc.scrollTop = sc.scrollHeight; else window.scrollTo(0, document.body.scrollHeight);
      return 'SCROLLED';
    }, jk);
    if (r !== 'CLICKED') await pgPage.waitForTimeout(900);
  }
  if (r !== 'CLICKED') { console.log(JSON.stringify({ ok: false, stage: 'click', why: r })); await browser.close(); process.exit(2); }
  for (let i = 0; i < 30; i++) {
    await pgPage.waitForTimeout(500);
    if (pgPage.url() !== before && pgPage.url().includes(jk)) break;
  }

  // 2. read the right-hand pane
  const pane = JSON.parse(execFileSync('node', ['jobsearch/read_pane.js'],
    { cwd: '/projects/ServerBrowser', timeout: 60000 }).toString());

  // 3. employer-site -> click apply, wait for the external tab to land
  let employerUrl = null;
  if (pane.applyRoute === 'employer-site') {
    try { execFileSync('node', ['jobsearch/click_apply.js'], { cwd: '/projects/ServerBrowser', timeout: 90000 }); }
    catch (e) { /* click_apply may exit non-zero after triggering; fall through to tab scan */ }
    for (let i = 0; i < 40; i++) {
      await pgPage.waitForTimeout(500);
      const t = ctx.pages().find(p => !/indeed\.com|about:blank/.test(p.url()));
      if (t && t.url().startsWith('http')) { employerUrl = t.url(); break; }
    }
  }
  console.log(JSON.stringify({ ok: true, jk, page: pg, pane, employerUrl }));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
