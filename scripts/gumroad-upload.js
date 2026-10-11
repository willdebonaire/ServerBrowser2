#!/usr/bin/env node
/*
 * gumroad-upload.js — automate the full per-product upload flow.
 * Sources: Recording 10_2_2026 (mbiubc) + docs/gumroad-upload.md.
 * Flow: wget thumb+zip -> CDP attach -> Product tab cover ->
 * Content tab -> Upload your files -> modal Computer files -> zip ->
 * Save changes -> Publish -> delete local files.
 * Usage: node scripts/gumroad-upload.js [index] [--test]
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const WebSocket = require('ws');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MAP = process.env.MAP || path.join(__dirname, '..', 'upload_map.json');
const WORKDIR = process.env.WORKDIR || '/tmp/gumwork';
const BASE = (process.env.BASE || 'http://50.114.206.42:555').replace(/\/$/, '');
const PROGRESS = process.env.PROGRESS || '/tmp/gumroad-progress.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdpHost() {
  const u = new URL(CDP_URL);
  return { host: u.hostname, port: Number(u.port || 80) };
}
function getJSON(p) {
  const { host, port } = cdpHost();
  return new Promise((res, rej) => {
    http.get({ host, port, path: p }, (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function dl(url, dest) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : http;
    const f = fs.createWriteStream(dest);
    mod.get(url, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        f.close();
        return dl(new URL(r.headers.location, url).toString(), dest).then(res, rej);
      }
      if (r.statusCode !== 200) { f.close(); fs.unlink(dest, () => {}); return rej(new Error('HTTP ' + r.statusCode + ' ' + url)); }
      r.pipe(f);
      f.on('finish', () => f.close(res));
    }).on('error', (e) => { f.close(); fs.unlink(dest, () => {}); rej(e); });
  });
}
function wgetOne(url, dest) {
  return new Promise((res, rej) => {
    execFile('wget', ['-q', '-O', dest, url], (err) => (err ? rej(err) : res()));
  });
}
async function fetchFile(url, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024) return 'exists';
  try { await dl(url, dest); return 'downloaded'; }
  catch (e) { return wgetOne(url, dest).then(() => 'downloaded'); }
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const s = new WebSocket(wsUrl, { maxPayload: 200 * 1024 * 1024 });
    let id = 0;
    const pend = {};
    const events = [];
    s.on('open', () => {
      s.on('message', (buf) => {
        let j; try { j = JSON.parse(buf.toString()); } catch { return; }
        if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; }
        else if (j.method) events.push(j);
      });
      const send = (method, params = {}) => new Promise((r) => {
        const i = ++id; pend[i] = r;
        s.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (pend[i]) { pend[i]({ error: 'timeout', method }); delete pend[i]; } }, 25000);
      });
      res({ send, events, close: () => { try { s.close(); } catch {} } });
    });
    s.on('error', rej);
  });
}
async function evalJSON(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = r.result && r.result.result && r.result.result.value;
  try { return JSON.parse(v); } catch { return v; }
}
async function realClick(c, p) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await sleep(60);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(80);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}
/**
 * Wait for the next intercepted Page.fileChooserOpened and feed it `absFile`.
 *
 * IMPORTANT (verified): a file may ONLY be attached via DOM.setFileInputFiles
 * while the chooser is still open/intercepted, and ONLY using the
 * `backendNodeId` reported by the Page.fileChooserOpened event. Setting files
 * on a node obtained from DOM.querySelector (no chooser open) silently fails,
 * and the returned backendNodeId differs from the queried input's node.
 */
async function acceptNextChooser(c, absFile, timeoutMs = 15000) {
  const t0 = Date.now();
  const seen = c.events.length;
  while (Date.now() - t0 < timeoutMs) {
    const ev = c.events.slice(seen).find((e) => e.method === 'Page.fileChooserOpened');
    if (ev) {
      const r = await c.send('DOM.setFileInputFiles', { files: [absFile], backendNodeId: ev.params.backendNodeId });
      if (r.error) throw new Error('setFileInputFiles: ' + JSON.stringify(r.error));
      console.log('[chooser] fed', absFile.split('/').pop(), 'backendNodeId=' + ev.params.backendNodeId, 'mode=' + ev.params.mode);
      return ev.params.backendNodeId;
    }
    await sleep(250);
  }
  throw new Error('no Page.fileChooserOpened (chooser never opened - check the click target)');
}

// The Gumroad edit page keeps everything inside its own scroll container, so
// window.scrollTo() is a no-op. Return the scrollable ancestor of an element.
const SCROLL_PARENT = `(function(el){let p=el&&el.parentElement;while(p&&p!==document.body){const st=getComputedStyle(p);if(/(auto|scroll)/.test(st.overflowY)&&p.scrollHeight>p.clientHeight+50)return p;p=p.parentElement}return document.scrollingElement||document.documentElement})`;

/**
 * Build the JS source for locating a section by its heading text.
 * Built with string concatenation (NOT a nested template literal) so the
 * emitted expression stays valid inside other template literals.
 */
function sectionExpr(name) {
  return '[...document.querySelectorAll("section")].filter(function(s){' +
    'var h=(s.querySelector("h1,h2,h3,h4,legend,label")||{}).textContent||"";' +
    'return h.trim()===' + JSON.stringify(name) + ';}).pop()';
}

/**
 * Scroll an element (already resolved in the page) into view and return its
 * viewport-centre coords, or null when it cannot be found.
 * `innerExpr` must evaluate to a DOM element.
 */
async function scrollToAndCentre(c, innerExpr) {
  const expr = `JSON.stringify((function(){var el=(${innerExpr});if(!el)return {err:"not-found"};` +
    `var r=el.getBoundingClientRect();if(!(r.width>0&&r.height>0))return {err:"zero-box",rect:[r.left,r.top,r.width,r.height]};` +
    `if(r.top<0||r.bottom>innerHeight){var sp=(${SCROLL_PARENT})(el);sp.scrollTop+=r.top-(sp.clientHeight/2)+(r.height/2);}` +
    `r=el.getBoundingClientRect();` +
    `return {x:r.left+r.width/2,y:r.top+r.height/2,top:Math.round(r.top),h:Math.round(r.height)};})())`;
  return evalJSON(c, expr);
}
/** Viewport-centre coords of the Nth element matching a CSS selector. */
async function centreOf(c, sel, idx) {
  return scrollToAndCentre(c, `[...document.querySelectorAll(${JSON.stringify(sel)})][${idx || 0}]`);
}
/**
 * Park an element near the TOP of its scroll container and return its centre.
 * Radix popovers are position:fixed and anchor to the trigger; when the trigger
 * is far down the page the popper renders below the viewport and cannot be
 * clicked. Parking the trigger high keeps any anchored popper on-screen.
 */
async function parkAndCentre(c, sel, idx, offset = 260) {
  const p = await scrollToAndCentre(c, `[...document.querySelectorAll(${JSON.stringify(sel)})][${idx || 0}]`);
  if (!p || p.err) return p;
  if (p.top > offset || p.top < 0) {
    const q = await evalJSON(c, `JSON.stringify((function(){var el=[...document.querySelectorAll(${JSON.stringify(sel)})][${idx || 0}];if(!el)return {err:"gone"};var sp=(${SCROLL_PARENT})(el);sp.scrollTop+=el.getBoundingClientRect().top-${offset};var r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,top:Math.round(r.top),h:Math.round(r.height)};})())`);
    if (q && !q.err) return q;
  }
  return p;
}
/** Dismiss any open Radix popover / dialog with a real Escape keystroke. */
async function pressEscape(c) {
  for (const type of ['keyDown', 'keyUp']) {
    await c.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  }
  await sleep(500);
}

/**
 * Locate a control by visible text inside the most recently opened Radix
 * popover, and return its viewport-centre coords.
 * Radix popovers are position:fixed and anchor to their trigger; when the
 * trigger sits low in the scroll container the popper renders BELOW the
 * viewport (observed translate(590px, 1090px) on an 800px-tall window) so every
 * synthetic click misses it. Callers park the trigger high first.
 */
async function popoverClick(c, text) {
  return evalJSON(c, `JSON.stringify((function(){
    var wraps=[...document.querySelectorAll('[data-radix-popper-content-wrapper]')];
    if(!wraps.length) return {err:"no-popover"};
    var d=wraps[wraps.length-1];
    var inner=d.querySelector('[role=dialog]')||d;
    var el=[...inner.querySelectorAll('label,a,button,[role=menuitem]')].find(function(x){
      return (x.textContent||'').trim().indexOf(${JSON.stringify(text)})===0;
    });
    if(!el) return {err:"no-control", text:inner.textContent.trim().slice(0,80)};
    var r=el.getBoundingClientRect();
    var res={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),top:Math.round(r.top),tag:el.tagName};
    if(!(r.width>0&&r.height>0)) res.err="zero-box";
    else if(r.top<0||r.bottom>innerHeight||r.left<0||r.right>innerWidth)
      res.err="offscreen:"+JSON.stringify([Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]);
    return res;
  })())`);
}
/** Count real (<img> with pixels) images inside a named section. -1 if section missing. */
async function sectionHasImage(c, name) {
  return evalJSON(c, `JSON.stringify((function(){var s=${sectionExpr(name)};if(!s)return -1;return [...s.querySelectorAll('img')].filter(function(i){return i.naturalWidth>10}).length})())`);
}
/** Does the Thumbnail section expose a real (visible) image file input? */
async function thumbHasFileInput(c) {
  return evalJSON(c, `JSON.stringify((function(){var s=${sectionExpr('Thumbnail')};if(!s)return false;return [...s.querySelectorAll('input[type=file]')].some(function(i){return /image\\//.test(i.accept||'')})})())`);
}

async function uploadCover(c, thumbPath) {
  const st = await evalJSON(c, `JSON.stringify((function(){
    var ts=${sectionExpr('Thumbnail')}, cs=${sectionExpr('Cover')};
    return {
      addCover:!![...document.querySelectorAll('button')].find(function(b){return b.getAttribute('aria-label')==='Add cover'}),
      directUploadBtn:[...document.querySelectorAll('button')].findIndex(function(b){return (b.textContent||'').trim()==='Upload images or videos';}),
      coverImgLabel:[...document.querySelectorAll('label')].findIndex(function(l){return (l.textContent||'').trim()==='Computer files';}),
      coverTabLabel:cs?[...cs.querySelectorAll('label[role=tab]')].findIndex(function(l){return (l.textContent||'').trim()==='Computer files';}):-1,
      thumbSection:ts?ts.textContent.trim().replace(/\\s+/g,' ').slice(0,70):null,
      thumbLabelText:ts&&ts.querySelector('label')?(ts.querySelector('label').textContent||'').trim():null,
      thumbHasVisibleLabel:!!(ts&&ts.querySelector('label')&&ts.querySelector('label').getBoundingClientRect().width>0),
      thumbInputs:ts?[...ts.querySelectorAll('input[type=file]')].map(function(i){return i.accept||''}):[],
      coverImgs:cs?[...cs.querySelectorAll('img')].filter(function(i){return i.naturalWidth>10}).length:-1
    };})())`);
  console.log('[cover] state:', JSON.stringify(st));

  // ---------------------------------------------------------------------------
  // PREFERRED path (VERIFIED WORKING on untouched product `eealgw` index 3):
  // Cover section -> label[role=tab] "Computer files". Its input accepts video
  // too and has NO square constraint. A trusted mouse click on the label opens
  // the chooser; feed it from Page.fileChooserOpened.
  // ---------------------------------------------------------------------------
  if (st.coverTabLabel >= 0) {
    console.log('[cover] variant=Cover "Computer files" tab (coverImgs=' + st.coverImgs + ')');
    const p = await scrollToAndCentre(c, `${sectionExpr('Cover')}.querySelectorAll('label[role=tab]')[${st.coverTabLabel}]`);
    if (!p || p.err) throw new Error('Cover "Computer files" label not found: ' + JSON.stringify(p));
    console.log(`[cover] click Cover "Computer files" @ ${Math.round(p.x)},${Math.round(p.y)} (top=${p.top})`);
    await realClick(c, p);
    await acceptNextChooser(c, thumbPath, 20000);
    await sleep(9000);
    const chk0 = await sectionHasImage(c, 'Cover');
    console.log('[cover] verify Cover imgs:', chk0);
    if (chk0 > 0) return;
    console.log('[cover] Cover img not detected, falling through');
  }

  // "Add cover" (+) -> Radix popover -> "Upload images or videos" -> SECOND
  // Radix popover -> "Computer files" -> chooser. VERIFIED on `jqqqs`.
  // GOTCHA: both poppers are position:fixed and anchor to the trigger; when
  // the trigger sits low in the scroll container they render BELOW the viewport
  // (observed translate(590px, 1090px) on an 800px-tall window) so every
  // synthetic click misses. We park the trigger near the top first.
  if (st.addCover) {
    console.log('[cover] variant=Add cover popover (3-step)');
    const a = await parkAndCentre(c, 'button[aria-label="Add cover"]', 0);
    if (!a || a.err) throw new Error('Add cover button not found: ' + JSON.stringify(a));
    console.log(`[cover] click Add cover @ ${Math.round(a.x)},${Math.round(a.y)} (top=${a.top})`);
    await realClick(c, a);
    await sleep(1500);
    const s1 = await popoverClick(c, 'Upload images or videos');
    if (!s1 || s1.err) throw new Error('popover step1 failed: ' + JSON.stringify(s1));
    console.log(`[cover] click popover "Upload images or videos" @ ${s1.x},${s1.y} (top=${s1.top})`);
    await realClick(c, s1);
    await sleep(1800);
    const s2 = await popoverClick(c, 'Computer files');
    if (!s2 || s2.err) throw new Error('popover step2 failed: ' + JSON.stringify(s2));
    console.log(`[cover] click popover "Computer files" @ ${s2.x},${s2.y} (top=${s2.top})`);
    await realClick(c, s2);
    await acceptNextChooser(c, thumbPath, 20000);
    await sleep(9000);
    const chkA = await sectionHasImage(c, 'Cover');
    console.log('[cover] verify Cover imgs:', chkA);
    if (chkA > st.coverImgs) return;
    console.log('[cover] no new Cover image, falling through');
    await pressEscape(c);
  }

  const directIdx = st.directUploadBtn;
  if (st.coverImgs <= 0 && directIdx >= 0) {
    // Fresh product: the Cover section shows an inline "Upload images or
    // videos" button. Clicking it does NOT open a chooser or a popover - it
    // swaps the Cover section into the "Computer files" / "External link" tab
    // layout (same shape as a product that already has a cover). We then click
    // that label, which owns a real file input.
    console.log('[cover] variant=Cover direct button (inlines into Computer files tab)');
    const p = await parkAndCentre(c, 'button', directIdx);
    if (!p || p.err) throw new Error('Cover "Upload images or videos" button not found: ' + JSON.stringify(p));
    console.log(`[cover] click Cover button @ ${Math.round(p.x)},${Math.round(p.y)} (top=${p.top})`);
    await realClick(c, p);
    // Wait for the section to become the Computer-files tab layout.
    let tab = null;
    for (let i = 0; i < 12; i++) {
      await sleep(500);
      tab = await scrollToAndCentre(c, `${sectionExpr('Cover')}.querySelector('label[role=tab]')`);
      if (tab && !tab.err) break;
      tab = await scrollToAndCentre(c, `${sectionExpr('Cover')}.querySelector('label')`);
      if (tab && !tab.err) break;
      tab = null;
    }
    if (!tab) throw new Error('Cover section did not reveal a "Computer files" tab after clicking Upload');
    console.log(`[cover] click Cover "Computer files" @ ${Math.round(tab.x)},${Math.round(tab.y)} (top=${tab.top})`);
    await realClick(c, tab);
    await acceptNextChooser(c, thumbPath, 20000);
  } else {
    // Last resort: the Thumbnail section. NOTE Gumroad validates this one and
    // rejects non-square images with "Image must be square." (min 600x600);
    // our thumb PNGs are 866x362 landscape, so this usually fails.
    if (!(st.thumbHasVisibleLabel && (st.thumbInputs || []).some((a) => /image\//.test(a))))
      throw new Error('no known image-upload control found on page');
    console.log('[cover] variant=Thumbnail label [SQUARE-ONLY, likely to be rejected]');
    const p = await scrollToAndCentre(c, `${sectionExpr('Thumbnail')}.querySelector('label')`);
    if (!p || p.err) throw new Error('Thumbnail upload label not found: ' + JSON.stringify(p));
    console.log(`[cover] click Thumbnail label @ ${Math.round(p.x)},${Math.round(p.y)} (top=${p.top})`);
    await realClick(c, p);
    await acceptNextChooser(c, thumbPath, 20000);
  }

  await sleep(8000);
  const chk = await evalJSON(c, `JSON.stringify((function(){var c=${sectionExpr('Cover')},t=${sectionExpr('Thumbnail')};return {cover:c?[...c.querySelectorAll('img')].filter(function(i){return i.naturalWidth>10}).length:-1,thumb:t?[...t.querySelectorAll('img')].filter(function(i){return i.naturalWidth>10}).length:-1};})())`);
  console.log('[cover] verify:', JSON.stringify(chk));
  if (!(chk.cover > 0 || chk.thumb > 0)) throw new Error('cover image not visible');
}
/**
 * Upload the content zip. Flow (from the recording + verified on fbhcqt):
 *   a[role=tab] "Content" -> button "Upload your files" -> modal
 *   -> div[role=menuitem] "Computer files" (EXACT match; "Embed media" sits
 *   directly above it) -> chooser -> zip.
 */
async function uploadContent(c, zipPath) {
  // Dismiss a leftover "Changes saved / Skip for now" banner from a previous
  // run - it can sit over the controls we need to click.
  await dismissBanner(c);

  const contentIdx = await evalJSON(c, `[...document.querySelectorAll('a[role=tab]')].findIndex(function(x){return x.textContent.trim()==='Content'})`);
  let p = await centreOf(c, 'a[role=tab]', contentIdx);
  if (!p || p.err) throw new Error('Content tab not found: ' + JSON.stringify(p));
  await realClick(c, p);
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const u = await evalJSON(c, 'location.pathname');
    if (typeof u === 'string' && u.indexOf('/edit/content') !== -1) break;
    await sleep(500);
  }
  await sleep(2000);

  const upIdx = await evalJSON(c, `[...document.querySelectorAll('button')].findIndex(function(x){return (x.textContent||'').trim()==='Upload your files'})`);
  p = upIdx >= 0 ? await centreOf(c, 'button', upIdx) : null;
  if (!p || p.err) {
    // "Upload your files" disappears once content exists - confirm by looking
    // for the uploaded file card (e.g. "<name> | ZIP1.8 MB | Download").
    const has = await contentHasZip(c);
    if (has) { console.log('[content] already uploaded, skipping'); return true; }
    throw new Error('Upload your files button not found');
  }
  console.log('[content] click "Upload your files" @', Math.round(p.x) + ',' + Math.round(p.y));
  await realClick(c, p);

  // Wait for the upload modal, then click "Computer files" by EXACT text match.
  let mi = null;
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    mi = await scrollToAndCentre(c, `[...(document.querySelector('[role=dialog]')||document).querySelectorAll('[role=menuitem]')].find(function(x){return (x.textContent||'').trim()==='Computer files'})`);
    if (mi && !mi.err) break;
    mi = null;
  }
  if (!mi) throw new Error('modal "Computer files" menuitem not found (exact match required)');
  console.log('[content] click modal "Computer files" @', Math.round(mi.x) + ',' + Math.round(mi.y));
  await realClick(c, mi);
  await acceptNextChooser(c, zipPath, 25000);

  // Upload is async. The card appears immediately showing "ZIP 0% of N MB ...
  // Cancel" and only later settles to "ZIP N MB". Wait for the progress
  // indicators to clear, otherwise Save/Publish can fire mid-upload.
  let st = { zip: false, uploading: true };
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    st = await evalJSON(c, `JSON.stringify((function(){
      var ed=document.querySelector('[contenteditable=true]')||document.body;
      var t=(ed.innerText||'');
      var card=/ZIP/i.test(t)&&/Download/i.test(t);
      var busy=/\\d+%\\s*of|byte\\/second|Cancel/i.test(t);
      return {zip:card,uploading:busy};
    })())`);
    if (st.zip && !st.uploading) break;
  }
  console.log('[content] verify:', JSON.stringify(st));
  if (!st.zip) throw new Error('zip not present in content editor after upload');
  if (st.uploading) throw new Error('zip upload did not finish (still showing progress) - aborting before save/publish');
  await dismissBanner(c);
  return true;
}
/**
 * Does the content editor show an uploaded file node?
 * The zip card renders as "<name>\nZIP · <size>\nDownload" - the filename in
 * the card has NO .zip extension, so match on the ZIP/size + Download text.
 */
async function contentHasZip(c) {
  return evalJSON(c, `JSON.stringify((function(){
    var ed=document.querySelector('[contenteditable=true]')||document.body;
    var t=(ed.innerText||'');
    return /ZIP/i.test(t) && /Download/i.test(t);
  })())`);
}
/** Click "Skip for now" on the post-save notification banner if it is showing. */
async function dismissBanner(c) {
  const i = await evalJSON(c, `[...document.querySelectorAll('button')].findIndex(function(x){return (x.textContent||'').trim()==='Skip for now'})`);
  if (i < 0) return false;
  const p = await centreOf(c, 'button', i);
  if (p && !p.err) await realClick(c, p);
  await sleep(1200);
  return true;
}
/**
 * Save changes then publish.
 * Save changes -> alert "Changes saved!" (plus a notify banner offering
 * "Skip for now") -> dismiss banner -> Publish and continue -> alert
 * "Published!" and navigation to /edit/share.
 */
async function saveAndPublish(c) {
  const clickBtn = async (text) => {
    const i = await evalJSON(c, `[...document.querySelectorAll('button')].findIndex(function(x){return (x.textContent||'').trim()===${JSON.stringify(text)}})`);
    if (i < 0) return null;
    const p = await centreOf(c, 'button', i);
    return p && !p.err ? p : null;
  };
  const alerts = () => evalJSON(c, `JSON.stringify([...document.querySelectorAll('[role=alert],[role=status]')].map(x=>(x.textContent||'').trim().slice(0,90)).filter(Boolean).slice(0,4))`);

  const sp = await clickBtn('Save changes');
  if (sp) { console.log('[save] click @', Math.round(sp.x) + ',' + Math.round(sp.y)); await realClick(c, sp); await sleep(4000); }
  else console.log('[save] Save changes not present');
  const al1 = await alerts();
  console.log('[save] alerts:', JSON.stringify(al1));

  // The post-save "notify customers?" banner can cover the Publish button.
  await dismissBanner(c);
  await pressEscape(c);

  // An unpublished product shows "Publish and continue"; an already-live one
  // shows "Unpublish" (we do NOT want to click that).
  const live = await evalJSON(c, `[...document.querySelectorAll('button')].some(function(x){return (x.textContent||'').trim()==='Unpublish'})`);
  let pp = live ? null : await clickBtn('Publish and continue');
  if (live) {
    console.log('[publish] product already live ("Unpublish" showing) - skipping publish');
  } else if (pp) {
    console.log('[publish] click @', Math.round(pp.x) + ',' + Math.round(pp.y));
    await realClick(c, pp);
    await sleep(5000);
  } else {
    console.log('[publish] "Publish and continue" not found');
  }
  const fin = await evalJSON(c, `JSON.stringify({path:location.pathname,alerts:[...document.querySelectorAll('[role=alert],[role=status]')].map(x=>(x.textContent||'').trim().slice(0,90)).filter(Boolean).slice(0,4)})`);
  console.log('[final]', JSON.stringify(fin));
  return fin;
}
function loadProgress() {
  try { const p = JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); if (!Array.isArray(p.done)) p.done = []; return p; } catch { return { done: [], cover_done: [] }; }
}
function saveProgress(p) { fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 1)); }
/** Record that a product's cover image is on Gumroad (verified via DOM). */
function markCoverDone(idx) {
  const p = loadProgress();
  p.cover_done = p.cover_done || [];
  if (!p.cover_done.includes(idx)) p.cover_done.push(idx);
  saveProgress(p);
  console.log('cover_done:', JSON.stringify(p.cover_done));
}
async function runOne(entry, idx, testOnly, coverOnly) {
  const slug = entry.slug;
  // Accept either a map entry (gumroad_url + upload_zip/upload_thumbnail)
  // or a queue entry (permalink + zip + thumb).
  const permalink = entry.permalink || (entry.gumroad_url || '').split('/l/')[1];
  if (!permalink) throw new Error('no permalink for index ' + idx);
  const zipRel = entry.zip || (entry.upload_zip || [])[0];
  const thumbRel = entry.thumb || (entry.upload_thumbnail || [])[0];
  if (!zipRel || !thumbRel) throw new Error('map missing paths for ' + slug);
  const zipPath = path.join(WORKDIR, path.basename(zipRel));
  const thumbPath = path.join(WORKDIR, path.basename(thumbRel));
  console.log(`\n=== [${idx}] ${slug} -> products/${permalink}/edit ===`);
  fs.mkdirSync(WORKDIR, { recursive: true });
  console.log('thumb:', await fetchFile(BASE + '/' + thumbRel, thumbPath), fs.statSync(thumbPath).size);
  if (!coverOnly) console.log('zip:  ', await fetchFile(BASE + '/' + zipRel, zipPath), fs.statSync(zipPath).size);
  if (testOnly) { console.log('[test] dry run'); return false; }
  const list = await getJSON('/json/list');
  const page = list.find((x) => x.type === 'page');
  if (!page) throw new Error('no page target');
  const c = await connect(page.webSocketDebuggerUrl);
  try {
    await c.send('Page.enable');
    await c.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await c.send('Runtime.evaluate', { expression: `location.href=${JSON.stringify('https://gumroad.com/products/' + permalink + '/edit')}`, returnByValue: true }).catch(() => {});
    await sleep(4500);
    console.log('on:', await evalJSON(c, 'location.href'));
    await uploadCover(c, thumbPath);
    if (coverOnly) { console.log('RESULT: COVER-ONLY OK (no save/publish, files kept)'); markCoverDone(idx); return false; }
    await uploadContent(c, zipPath);
    const fin = await saveAndPublish(c);
    const ok = (fin.alerts || []).some((a) => /Changes saved|Published/i.test(a));
    console.log('RESULT:', ok ? 'OK (banner seen)' : 'CHECK (no banner)');
    if (ok) { for (const f of [thumbPath, zipPath]) { try { fs.unlinkSync(f); console.log('deleted', f); } catch (e) { console.log('keep', f); } } }
    return ok;
  } finally { c.close(); }
}
async function main() {
  const args = process.argv.slice(2);
  const testOnly = args.includes('--test');
  const coverOnly = args.includes('--cover-only');
  const idxArg = args.find((a) => /^[0-9]+$/.test(a));

  // --queue <file>: run an explicit list of {permalink, slug, zip, thumb}
  // entries (products that already exist in Gumroad but are absent from the
  // map). Duplicates should be de-duplicated before writing the queue.
  const qi = args.indexOf('--queue');
  if (qi !== -1) {
    const qf = args[qi + 1] || '/tmp/gumwork_queue.json';
    const queue = JSON.parse(fs.readFileSync(qf, 'utf8'));
    console.log('queue:', queue.length, 'from', qf);
    fs.mkdirSync(WORKDIR, { recursive: true });
    let pass = 0, fail = 0;
    for (let n = 0; n < queue.length; n++) {
      const q = queue[n];
      try {
        const ok = await runOne(q, 'q' + n, false, coverOnly);
        if (ok) pass++; else fail++;
      } catch (e) {
        fail++;
        console.error(`[queue] ${q.permalink} FAILED: ${(e && e.message) || e}`);
      }
    }
    console.log(`\n[queue] done: pass=${pass} fail=${fail}`);
    return;
  }

  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  console.log('map:', map.length, '| CDP:', CDP_URL);
  const withUrl = map.map((e, i) => ({ e, i })).filter(({ e }) => e.gumroad_url);
  console.log('with gumroad_url:', withUrl.length);
  if (testOnly && idxArg === undefined) {
    const v = await getJSON('/json/version').catch((e) => ({ error: String(e) }));
    console.log('CDP:', v.Browser || v.error);
    const l = await getJSON('/json/list').catch(() => []);
    console.log('pages:', l.filter((x) => x.type === 'page').map((x) => x.url));
    return;
  }
  let idx;
  if (idxArg !== undefined) idx = Number(idxArg);
  else {
    const prog = loadProgress();
    const next = withUrl.find(({ i }) => !prog.done.includes(i));
    if (!next) { console.log('ALL DONE'); return; }
    idx = next.i;
  }
  const ok = await runOne(map[idx], idx, testOnly, coverOnly);
  if (ok && !testOnly) {
    const prog = loadProgress();
    if (!prog.done.includes(idx)) prog.done.push(idx);
    saveProgress(prog);
    console.log('progress:', prog.done);
  }
}
main().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
