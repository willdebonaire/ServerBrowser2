#!/usr/bin/env node
/*
 * gumroad-create.js — create NEW Gumroad products from upload_map.json.
 *
 * Deliberately does NOT upload cover images or content zips — it only creates
 * the listing (name, description, price). Use scripts/gumroad-upload.js for the
 * cover/content/save/publish flow.
 *
 * Pricing: $1 per 10,000 records (rows/10000, rounded to cents).
 *
 * Usage:
 *   node scripts/gumroad-create.js            # create next 20 unpublished slugs
 *   node scripts/gumroad-create.js --limit 5
 *   node scripts/gumroad-create.js --only construction-in-france,retail-in-france
 *   node scripts/gumroad-create.js --dry-run
 *   node scripts/gumroad-create.js --publish  # also publish after creating
 *
 * Writes created permalinks back into upload_map.json (gumroad_url).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';
const MAP = process.env.MAP || path.join(__dirname, '..', 'upload_map.json');
const CREATED_LOG = process.env.CREATED_LOG || '/tmp/gumroad-created.json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const priceFor = (rows) => Math.round((rows / 10000) * 100) / 100;

function getJSON(p) {
  const u = new URL(CDP_URL);
  return new Promise((res, rej) => {
    http.get({ host: u.hostname, port: Number(u.port || 80), path: p }, (r) => {
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
function connect(wsUrl) {
  return new Promise((res, rej) => {
    const s = new WebSocket(wsUrl, { maxPayload: 200 * 1024 * 1024 });
    let id = 0; const pend = {}; const events = [];
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
/** Trusted mouse click — required; el.click() will not open menus/choosers. */
async function realClick(c, p) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
  await sleep(70);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(90);
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 });
}

/**
 * The ServerBrowser HUD overlay is position:fixed at z-index 2147483647 across
 * the top ~60px and a toast child has pointer-events:auto, which silently
 * swallows clicks on header buttons ("Next: Customize", "Save and continue").
 * Hide it for the duration of automation.
 */
async function hideHud(c) {
  await evalJSON(c, `(function(){var h=document.getElementById('serverbrowser-hud');if(h){h.style.display='none';}return 1})()`);
}
/** Dismiss the post-save "notify customers?" banner if present. */
async function dismissBanner(c) {
  const i = await evalJSON(c, `[...document.querySelectorAll('button')].findIndex(function(x){return (x.textContent||'').trim()==='Skip for now'})`);
  if (i < 0) return false;
  const p = await evalJSON(c, `JSON.stringify((function(){var el=[...document.querySelectorAll('button')][${i}];var r=el.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})())`);
  if (p && p.x) await realClick(c, p);
  await sleep(1200);
  return true;
}

/**
 * Collect validation messages from the new-product form.
 *
 * When the submit handler rejects the form it calls setError() and never POSTs,
 * so nothing appears in the network log and the failure looks identical to a
 * dropped submit. These messages are the only clue, so surface them.
 */
async function fieldErrors(c) {
  // evalJSON already JSON.parses the result, so `errs` is an array here -- do
  // not parse it again. A second parse threw "Unexpected token 'p'" and replaced
  // the real diagnostic with a confusing crash on every failing product.
  const errs = await evalJSON(c, `[...document.querySelectorAll('[aria-invalid="true"]')].map(function(el){
    var msg='';
    var p=el.closest('div');
    for(var i=0;p&&i<4;i++,p=p.parentElement){
      var t=(p.textContent||'').trim();
      if(t&&t.length<80&&/required|invalid|too|must|cannot/i.test(t)){msg=t;break;}
    }
    return (el.id||el.tagName)+': '+msg;
  })`);
  // evalJSON returns the raw string when the expression throws, so tolerate a
  // non-array result rather than throwing here and masking the real cause.
  const list = Array.isArray(errs) ? errs : [];
  return list.length ? ' — ' + list.join('; ') : '';
}

/** Fill a text input using the native setter + input/change events (React-safe). */
async function setInputValue(c, innerExpr, value) {
  return evalJSON(c, `(function(){var el=(${innerExpr});if(!el)return null;` +
    `var proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;` +
    `var s=Object.getOwnPropertyDescriptor(proto,'value').set;s.call(el,${JSON.stringify(value)});` +
    `el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));` +
    `el.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,key:'a'}));return el.value;})()`);
}

/**
 * Create one product.
 * Flow (verified end-to-end):
 *   /products/new  -> the form needs a NAME ("Name is required" blocks submit)
 *   -> "Next: Customize" (type=submit, form=new-product-form-*)
 *   -> POST /links -> lands on /products/<permalink>/edit
 *   -> set description (TipTap contenteditable) + price (Pricing section)
 *   -> Save and continue
 */
/**
 * Navigate to a brand-new product form and wait for it to be interactive.
 *
 * MUST use Page.navigate, not `location.href=`. Setting location.href from the
 * same origin triggers a same-document (SPA) navigation, so the React form is
 * never re-mounted. Chrome/Gumroad also restore the input's value across
 * reloads, so we do not rely on it being empty - the caller sets it explicitly.
 */
async function gotoNewProduct(c) {
  await c.send('Page.navigate', { url: 'https://gumroad.com/products/new' }).catch(() => {});
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    // The form is server-rendered, so it appears before React hydrates and the
    // __reactProps keys land. Returning on markup alone means the first attempt
    // runs against an inert form (no handlers -> nothing is set, nothing is
    // submitted) and has to be thrown away, so wait for the handlers too.
    const ok = await evalJSON(c, `JSON.stringify((function(){
      var b=[...document.querySelectorAll('button')].find(function(x){return (x.textContent||'').trim().indexOf('Next')===0;});
      if(!b)return {ok:false};
      var f=document.querySelector('form[id="'+b.getAttribute('form')+'"]');
      if(!f||!f.querySelector('input[type=text]'))return {ok:false};
      var reactProps=function(el){return el&&Object.keys(el).find(function(x){return x.indexOf('__reactProps')===0;});};
      var fk=reactProps(f);
      if(!fk||typeof f[fk].onSubmit!=='function')return {ok:false,why:'form not hydrated'};
      if(!reactProps(document.querySelector('input[id^="name-"]')))return {ok:false,why:'name input not hydrated'};
      if(!reactProps(document.querySelector('input[id^="price-"]')))return {ok:false,why:'price input not hydrated'};
      var cur=[...document.querySelectorAll('select')].find(function(x){return [...x.options].some(function(o){return o.value==='usd'})});
      if(!cur||!reactProps(cur))return {ok:false,why:'currency select not hydrated'};
      return {ok:true};
    })())`);
    if (ok && ok.ok) { await hideHud(c); return true; }
    if (i === 24) console.log('   (form never hydrated:', (ok && ok.why) || 'unknown', ')');
  }
  await hideHud(c);
  return false;
}

/**
 * Create one product.
 *
 * Every attempt navigates to a FRESH /products/new page, because the form is a
 * controlled React form and a partially-filled one from a failed attempt leaves
 * the component state inconsistent.
 *
 * Flow (verified): /products/new -> wait for React to hydrate -> set product
 * type (Digital product) + name + USD + price through React's own onChange
 * handlers -> invoke the form's onSubmit -> POST /links -> /products/<id>/edit
 * -> description (TipTap contenteditable) -> price (Pricing section) -> Save.
 */
async function createOne(c, entry) {
  const name = entry.gumroad_name;
  const desc = entry.gumroad_description || '';
  const price = priceFor(entry.rows);
  const slug = entry.slug;

  let permalink = null;
  let lastErr = null;
  let dailyLimitHit = null;
  for (let attempt = 0; attempt < 3 && !permalink; attempt++) {
    if (attempt) console.log('   (retry ' + attempt + ' on a fresh page' + (lastErr ? ': ' + lastErr : '') + ')');
    const fresh = await gotoNewProduct(c);
    if (!fresh) { lastErr = 'new-product form did not load'; await sleep(2000); continue; }

    // Set the fields through React's own onChange handlers.
    //
    // The /products/new form is a controlled React form, and its submit handler
    // reads state, NOT the DOM. A native value setter + input event is silently
    // ignored by React here, so drive the handlers directly. (The native setter
    // looks like it works -- the DOM value and even the cached React props show
    // the new text -- but on submit React still sees the empty initial state.)
    //
    // BOTH link.name AND link.price_range are required by the submit handler;
    // if either is blank it calls setError() and never POSTs. The price must be
    // set on THIS page, not later on the edit page, or no product is created.
    const setReactValue = async (sel, value) => evalJSON(c, `(function(){
      var el=document.querySelector(${JSON.stringify(sel)});
      if(!el)return null;
      var k=Object.keys(el).find(function(x){return x.indexOf('__reactProps')===0;});
      if(!k)return null;
      el[k].onChange({target:{value:${JSON.stringify(value)}}});
      return el.value;
    })()`);

    // Ensure "Digital product" is the selected type (it is the default, but a
    // stray click during a previous attempt can leave another type checked).
    await evalJSON(c, `(function(){
      var el=[...document.querySelectorAll('button[aria-checked]')].find(function(x){
        return (x.textContent||'').trim().indexOf('Digital product')===0;});
      if(!el)return false;
      if(el.getAttribute('aria-checked')!=='true'){
        var k=Object.keys(el).find(function(x){return x.indexOf('__reactProps')===0;});
        if(k)el[k].onClick({});
      }
      return el.getAttribute('aria-checked')==='true';
    })()`);

    // Currency MUST be set explicitly: the form's currency <select> carries over
    // the seller's account default (currently GBP), so a product created without
    // touching it is priced in pounds even though priceFor() is a dollar amount.
    // Set it before the price, otherwise the price is interpreted as GBP.
    //
    // Reading select.value back in the same tick as onChange() races React's
    // re-render and still reports the old currency, which failed the check and
    // burned a retry. Change it first, then poll for the new value.
    await evalJSON(c, `(function(){
      var s=[...document.querySelectorAll('select')].find(function(x){
        return [...x.options].some(function(o){return o.value==='usd'})});
      if(!s)return false;
      var k=Object.keys(s).find(function(x){return x.indexOf('__reactProps')===0;});
      if(k&&s[k].onChange)s[k].onChange({target:{value:'usd'}});
      return true;
    })()`);
    let curSet = null;
    for (let i = 0; i < 10 && curSet !== 'usd'; i++) {
      await sleep(300);
      curSet = await evalJSON(c, `(function(){
        var s=[...document.querySelectorAll('select')].find(function(x){
          return [...x.options].some(function(o){return o.value==='usd'})});
        return s?s.value:null;
      })()`);
    }
    if (curSet !== 'usd') { lastErr = 'currency select not set (got ' + curSet + ')'; continue; }

    const setName = await setReactValue('input[id^="name-"]', name);
    if (setName === null) { lastErr = 'name input missing'; continue; }
    await setReactValue('input[id^="price-"]', String(price));
    await sleep(700);

    // Submit by invoking React's onSubmit directly.
    //
    // A real trusted mouse click on "Next: Customize" does NOT reach React's
    // submit handler on this page: the click and native submit event both fire
    // at the DOM, but no POST /links follows, so the script retries the page
    // three times and reports "submit did not navigate". Invoking the handler
    // off __reactProps issues the POST /links and lands on /products/<id>/edit.
    await hideHud(c);
    await sleep(300);
    const submitted = await evalJSON(c, `(function(){
      var f=document.querySelector('form[id^="new-product-form"]');
      if(!f)return {e:'no form'};
      var k=Object.keys(f).find(function(x){return x.indexOf('__reactProps')===0;});
      if(!k)return {e:'no react props'};
      if(typeof f[k].onSubmit!=='function')return {e:'no onSubmit'};
      try{ f[k].onSubmit({preventDefault:function(){},stopPropagation:function(){},target:f,currentTarget:f}); }
      catch(err){ return {e:'threw: '+err.message}; }
      return {ok:true};
    })()`);
    if (!submitted || submitted.e) { lastErr = submitted && submitted.e || 'submit failed'; continue; }

    for (let k = 0; k < 12; k++) {
      await sleep(700);
      const path = await evalJSON(c, `location.pathname`);
      if (typeof path === 'string' && /^\/products\/[^/]+\/edit$/.test(path)) { permalink = path.split('/')[2]; break; }
    }
    if (!permalink) {
      // A failed POST /links comes back as a server error rather than a
      // navigation. Gumroad enforces a hard account limit of 10 new products
      // per day ("link.base": "Sorry, you can only create 10 products per day."),
      // which looks exactly like a dropped submit -- so read it off the page and
      // stop the whole batch instead of retrying every remaining slug 3x.
      const serverErr = await evalJSON(c, `(function(){
        // Check the daily-cap text FIRST. The server returns this as
        // {"link.base": ...} and also flags the price field aria-invalid, so
        // testing aria-invalid first would suppress the cap and report it as a
        // bogus price validation error.
        var m=(document.body.innerText||'').match(/Sorry, you can only create \\d+ products? per day\\.?/);
        return m?m[0]:null;
      })()`);
      if (serverErr) { dailyLimitHit = serverErr; break; }
      lastErr = 'submit did not navigate' + (await fieldErrors(c));
    }
  }
  if (dailyLimitHit) throw new Error('GUMROAD DAILY LIMIT: ' + dailyLimitHit + ' — stop the batch and retry after the limit resets.');
  if (!permalink) throw new Error('product was not created (' + lastErr + ')');
  console.log('   created:', permalink);
  await hideHud(c);
  await sleep(2500);

  // Description: gumroad_description is HTML but the editor is TipTap
  // contenteditable — insert the stripped text.
  if (desc) {
    const text = desc.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const got = await evalJSON(c, `(function(){
      var ed=document.querySelector('[contenteditable=true]');
      if(!ed)return null;
      ed.focus();
      return document.activeElement===ed;
    })()`);
    if (got) { await c.send('Input.insertText', { text }); await sleep(1200); }
  }

  // Price: first text input in the Pricing section.
  await evalJSON(c, `(function(){
    var pr=[...document.querySelectorAll('section')].filter(function(s){
      var h=(s.querySelector('h1,h2,h3,h4,legend,label')||{}).textContent||'';return h.trim()==='Pricing';}).pop();
    if(pr){var i=pr.querySelector('input[type=text]');if(i)i.scrollIntoView({block:'center'});}
    return 1;})()`);
  await sleep(700);
  const pset = await setInputValue(c, `[...document.querySelectorAll('section')].filter(function(s){
    var h=(s.querySelector('h1,h2,h3,h4,legend,label')||{}).textContent||'';return h.trim()==='Pricing';}).pop().querySelector('input[type=text]')`, String(price));
  if (pset === null) throw new Error('price input not found');

  // Save.
  await dismissBanner(c);
  await hideHud(c);
  await sleep(400);
  const sv = await evalJSON(c, `JSON.stringify((function(){
    var b=[...document.querySelectorAll('button')].find(function(x){
      var t=(x.textContent||'').trim();return t==='Save and continue'||t==='Save changes';});
    if(!b)return null; b.scrollIntoView({block:'center'});
    var r=b.getBoundingClientRect();
    var x=r.left+r.width/2,y=r.top+r.height/2;var t=document.elementFromPoint(x,y);
    return {x:Math.round(x),y:Math.round(y),ok:!!(t===b||b.contains(t))};})())`);
  if (sv && sv.x) { await realClick(c, sv); await sleep(4500); }
  const alerts = await evalJSON(c, `JSON.stringify([...document.querySelectorAll('[role=alert],[role=status]')].map(function(x){return (x.textContent||'').trim().slice(0,70)}).filter(Boolean).slice(0,3))`);

  return { slug, name, price, permalink, url: `https://islandprosoftware.gumroad.com/l/${permalink}`, alerts };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const doPublish = args.includes('--publish');
  const li = args.indexOf('--limit');
  const limit = li !== -1 ? Number(args[li + 1]) : 20;
  const oi = args.indexOf('--only');
  const only = oi !== -1 ? args[oi + 1].split(',').map((s) => s.trim()) : null;

  const map = JSON.parse(fs.readFileSync(MAP, 'utf8'));
  let todo = map.filter((e) => !e.gumroad_url);
  if (only) todo = todo.filter((e) => only.includes(e.slug));
  todo = todo.slice(0, limit);
  console.log('creating', todo.length, 'products; price = rows/10000');
  if (dryRun) { todo.forEach((e) => console.log('  ', e.slug, '$' + priceFor(e.rows))); return; }

  const list = await getJSON('/json/list');
  const page = list.find((x) => x.type === 'page');
  const c = await connect(page.webSocketDebuggerUrl);
  const created = [];
  let done = 0;
  let dailyLimit = null;
  for (const e of todo) {
    try {
      const r = await createOne(c, e);
      created.push(r); done++;
      console.log(`[${done}/${todo.length}] ${e.slug} -> ${r.permalink} $${r.price}`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      console.error(`[${done + 1}/${todo.length}] ${e.slug} FAILED: ${msg}`);
      // The daily cap is account-wide, so every remaining slug would fail the
      // same way. Persist what we have and stop.
      if (/DAILY LIMIT/i.test(msg)) { dailyLimit = msg; break; }
    }
  }
  c.close();

  // Persist results back into the map.
  if (created.length) {
    for (const r of created) {
      const ent = map.find((e) => e.slug === r.slug);
      if (ent) { ent.gumroad_url = r.url; ent.gumroad_price = r.price; }
    }
    fs.writeFileSync(MAP, JSON.stringify(map, null, 1));
    fs.writeFileSync(CREATED_LOG, JSON.stringify(created, null, 1));
    console.log('map updated + log at', CREATED_LOG);
  }
  console.log('done:', done, 'of', todo.length);
  if (dailyLimit) {
    console.error('\nSTOPPED: ' + dailyLimit);
    console.error('Gumroad allows 10 new products per day per account. Re-run the same');
    console.error('command after the limit resets; finished products are already saved to the map.');
    process.exitCode = 2;
  }
}
main().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
