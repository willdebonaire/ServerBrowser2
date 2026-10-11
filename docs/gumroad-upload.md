# Gumroad Upload — Working Method

Status: full process (cover image + content zip + save + publish) **CONFIRMED working** via `scripts/gumroad-upload.js` on **all 16 products** in `upload_map.json` (repo root) with a `gumroad_url`.

Latest clean combined runs (cover + content + save + publish, no manual steps):

| Product | Permalink | Result |
|---|---|---|
| Restaurants in US | `suhxvk` | `RESULT: OK` — Published! |
| Construction in India | `eealgw` | `RESULT: OK` — Published! |
| Construction in Spain | `mccwdn` | `RESULT: OK` — Published! |
| Construction in China | `gsaugt` | `RESULT: OK` — Published! |
| Construction in Brazil | `cqkdpn` | `RESULT: OK` — Published! |
| Construction in France | `jqqqs` | `RESULT: OK` — Published! |
| Construction in Germany | `fbhcqt` | `RESULT: OK` — Published! |

## Running products that are absent from the map

Some products already exist in Gumroad but have no `gumroad_url` in `upload_map.json`.
Build a queue file of `{permalink, slug, zip, thumb}` and run:

```bash
node scripts/gumroad-upload.js --queue /tmp/gumwork_queue.json
```

The queue runner does not stop on a single failure — it logs
`[queue] <permalink> FAILED: <reason>` and continues, then prints
`[queue] done: pass=N fail=M`.

**Match products to map slugs from the product's own name/description**, not by eye:
the dataset row count appears both in the product name (`-- 44,936 Companies`) and in its
description (`Sample dataset of 44,936 companies`), and it matches the map's `rows` field.
Requiring name+description+country to agree gave an unambiguous 1:1 match for every product.

Beware: the account contained **duplicate listings** — `cwybwr`/`naawkq`/`kyxdol` were all
"IT & services - france -- 33,811", plus `icbqe`/`kvmlbb` (Brazil) and `pyogqc`/`fkmxme`
(India). Only one of each was filled; the strays were left empty and unpublished.

Verification per product: header shows **"Unpublish"** (i.e. it is live) and the content
editor shows the file card (`ZIP … MB` + `Download`).


## THE FULL PROCESS (per product, in order)

1. **Download files** from `http://50.114.206.42:555/uploads/...` (see `upload_map.json` entries: `upload_thumbnail`, `upload_zip`) → `/tmp/gumwork/`.
2. **Go to Product tab**: `https://gumroad.com/products/<permalink>/edit`
3. **Cover image** — see [Cover interface variants](#cover-interface-variants) below. Feed the thumb PNG via `DOM.setFileInputFiles {files, backendNodeId}` using the id from the intercepted `Page.fileChooserOpened`.
4. **Content tab**: click `a[role=tab]` "Content" (real mouse events) → `https://gumroad.com/products/<p>/edit/content`
5. **Content zip**: click `button` "Upload your files" → modal → `div[role=menuitem]` "Computer files" (exact match) → chooser → feed the zip.
   - After upload the "Upload your files" button disappears; content editor shows `<filename>\nZIP<MB>\nDownload`.
6. **Save**: `button` "Save changes" → alert **"Changes saved!"**.
7. **Publish**: `button` "Publish and continue" (or "Unpublish" if already live) → alert **"Published!"**, lands on `/edit/share`.
8. **Verify via DOM**, then delete the product's files from `/tmp/gumwork/`.

Recording reference: `/projects/ServerBrowser/Recording 10_2_2026 at 1_46_45 AM.js` (Playwright steps for product `mbiubc` — sequential locators: section-2 button → section-2 label → set input file → content tab → upload files → header buttons = Save/Publish).

## Content flow (verified on `fbhcqt`, `suhxvk`, `eealgw`)

1. `a[role=tab]` **"Content"** → waits for `/edit/content`, then `button` **"Upload your files"**.
   - If the button is **absent** the product already has content — confirm by looking for the
     file card (`ZIP` + `Download` in the editor text) and skip.
2. Modal opens with four `div[role=menuitem]` items: **Embed media** / **Computer files** /
   **Existing product files** / **Dropbox files**. Click **"Computer files"** by **exact text
   match** — "Embed media" sits directly above it and has been mis-clicked before.
3. Intercept the chooser and feed the zip via `DOM.setFileInputFiles {files, backendNodeId}`.
4. **Wait for the upload to actually finish.** The card appears instantly as
   `ZIP 0% of N MB (0 byte/second)  Download  Cancel` and only later settles to `ZIP N MB`.
   Poll until the progress text (`\d+% of`, `byte/second`, `Cancel`) is gone — saving or
   publishing while it still reads 0% is a real race and can strand a partial upload.
5. `button` **"Save changes"** → alert **"Changes saved!"**, plus a "notify customers?" banner.
   Dismiss it with **"Skip for now"** and/or Escape before touching Publish.
6. `button` **"Publish and continue"** → alert **"Published!"**, lands on `/edit/share`.
   - A product that is **already live shows "Unpublish"** instead — never click that.

## Cover interface variants

The Cover section renders differently depending on whether the product already has a cover image.
All four were observed in the wild and are handled by `uploadCover()` in `scripts/gumroad-upload.js`.

| # | Trigger | Flow | Verified on |
|---|---------|------|-------------|
| 0 | Cover already present, tab layout | `label[role=tab]` **"Computer files"** → chooser (1 click) | `qxqkn`, `eealgw` |
| 1 | Product has a cover, `button[aria-label="Add cover"]` present | **Add cover** (+) → popover **"Upload images or videos"** → **2nd popover "Computer files"** → chooser (3 clicks) | `jqqqs` |
| 2 | Brand-new product, no cover | Cover section `button` **"Upload images or videos"** → *section inlines into the "Computer files" / "External link" tab layout* → **"Computer files"** → chooser (2 clicks) | `mccwdn` |
| 3 | No cover control anywhere | Thumbnail section `label` "Upload" → chooser. **Requires a SQUARE image ≥600×600** — our 866×362 thumbs are rejected with *"Image must be square."* | — |

### Key gotchas

- **Radix popovers render off-screen.** They are `position: fixed` and anchor to their trigger. When the
  trigger sits low in the scroll container the popper lands *below* the viewport — observed
  `transform: translate(590px, 1090px)` on an 800px-tall window — so every synthetic click misses it.
  **Park the trigger near the top of the scroll container first** (`parkAndCentre()`), then re-read the
  popper's rect.
- **`window.scrollTo()` is a no-op on this page.** The whole form lives inside its own scroll container
  (`overflow-y: auto`). Walk up to the nearest scrollable ancestor (`SCROLL_PARENT`) and set
  `scrollTop` instead.
- **Variant 2 does not open a chooser or popover.** Clicking "Upload images or videos" silently rewrites
  the Cover section into the tab layout; you must then look for the "Computer files" `label` and click it.
- Never build a section selector as a **nested template literal** — the quotes break. Use
  `sectionExpr()` (string concatenation) so the emitted JS stays valid.

## Environment

- Headed Chrome with CDP on `http://127.0.0.1:9222`
- VNC (noVNC) on `http://50.114.206.38:6080/novnc/vnc_auto.html`
- Product edit page: `https://gumroad.com/products/qxqkn/edit`
- Login session persists in `/projects/ServerBrowser/profile`
- Helper eval script: `/tmp/eval.js` (snippet below)
- Upload source files in `/tmp/gumwork/` (fetched from `http://50.114.206.42:555/`, map: `upload_map.json`)

## Why naive approaches fail (lessons learned)

- `el.click()` / `label.click()` via `Runtime.evaluate` does **not** open Chrome's file chooser here.
- `DOM.setFileInputFiles` with `nodeId` from `DOM.querySelector` fails ("Could not find node").
- `DOM.requestNode` with an objectId from a separate WS connection fails.
- Setting file via `backendNodeId` from an intercepted chooser does not populate `input.files` reliably.

**What works:** dispatch *real* mouse input events at the element's coordinates → Chrome opens the native file chooser → intercept with `Page.setInterceptFileChooserDialog` → then set the file. Verify via `input.files.length`.

> NOTE: `Page.handleFileChooser` does **NOT** exist in this Chrome build (`-32601 'Page.handleFileChooser' wasn't found`). Use `DOM.setFileInputFiles { files, backendNodeId }` where `backendNodeId` comes from the intercepted `Page.fileChooserOpened` event — this DOES work when issued while the chooser is still open/intercepted (confirmed for the content zip).


## Working recipe (copy-paste)

Save as `/tmp/upload-step.js`:

```js
const http = require('http');
function get(p) {
  return new Promise((res, rej) => {
    http.get({ host: '127.0.0.1', port: 9222, path: p }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}
function conn(wsUrl) {
  const WebSocket = require('/projects/ServerBrowser/node_modules/ws');
  return new Promise((res, rej) => {
    const s = new WebSocket(wsUrl);
    let id = 0; const pend = {}; const events = [];
    s.on('open', () => {
      s.on('message', m => {
        const j = JSON.parse(m);
        if (j.id && pend[j.id]) { pend[j.id](j); delete pend[j.id]; }
        else if (j.method) events.push(j);
      });
      res({
        send: (method, params = {}) => new Promise(r => {
          const i = ++id; pend[i] = r; s.send(JSON.stringify({ id: i, method, params }));
        }),
        events, close: () => s.close()
      });
    });
    s.on('error', rej);
  });
}

// USAGE: node upload-step.js "<label text>" "<abs path to file>"
(async () => {
  const labelText = process.argv[2] || 'Computer files';
  const filePath  = process.argv[3] || '/tmp/gumwork/construction-in-united-states-thumb.png';
  const t = (await get('/json/list')).find(x => x.type === 'page');
  const c = await conn(t.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Page.setInterceptFileChooserDialog', { enabled: true });
  // 1. find label by visible text -> center coords
  const pos = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify((function(){
      const l=[...document.querySelectorAll('label')].find(x=>x.textContent.includes(${JSON.stringify(labelText)}));
      if(!l) return null;
      const r=l.getBoundingClientRect();
      return {x:r.left+r.width/2, y:r.top+r.height/2};
    })())`, returnByValue: true
  });
  const coords = JSON.parse(pos.result.result.value);
  if (!coords) { console.log('LABEL NOT FOUND:', labelText); process.exit(1); }
  // 2. real mouse events (this opens the chooser)
  const { x, y } = coords;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await new Promise(r => setTimeout(r, 1000));
  // 3. intercepted chooser -> accept with real file
  const chooser = c.events.find(e => e.method === 'Page.fileChooserOpened');
  if (!chooser) { console.log('NO FILE CHOOSER OPENED'); process.exit(1); }
  const resp = await c.send('Page.handleFileChooser', { action: 'accept', files: [filePath] });
  console.log('handleFileChooser:', JSON.stringify(resp.result || resp.error));
  await new Promise(r => setTimeout(r, 1500));
  // 4. verify
  const chk = await c.send('Runtime.evaluate', {
    expression: `[...document.querySelectorAll('input[type=file]')].map(i=>i.files.length)`,
    returnByValue: true
  });
  console.log('files per input:', JSON.stringify(chk.result.result.value));
  c.close(); setTimeout(() => process.exit(0), 300);
})();
```

Run:
```bash
node /tmp/upload-step.js "Computer files" "/tmp/gumwork/construction-in-united-states-thumb.png"
```


## Content tab flow (CONFIRMED WORKING)

1. Navigate to `https://gumroad.com/products/qxqkn/edit/content` (click `a[role=tab]` "Content" via Input events, or go directly).
2. Click **`button` "Upload your files"** (coords ~907,274 at top of content editor) with real mouse events → opens a modal dialog (`[role=dialog]`).
3. In the modal, click the **`div[role=menuitem]` "Computer files"** (exact-match, ~930,370) with real mouse events → opens the native file chooser. (Beware: the modal also has an "Embed media" menuitem — match exactly on `Computer files`.)
4. Intercept: `Page.setInterceptFileChooserDialog {enabled:true}` BEFORE clicking step 3. On `Page.fileChooserOpened`, grab `params.backendNodeId` and send `DOM.setFileInputFiles { files:[absPath], backendNodeId }`.
5. Wait ~3s, verify a file-input change / upload progress in DOM. (`Page.handleFileChooser` unavailable in this Chrome.)
6. Modal closes automatically after file accepted.

### Content upload result
- ✅ Content zip `/tmp/gumwork/construction-in-united-states-50000.zip` (5.9MB) accepted on product `qxqkn` (user confirmed "ok that worked").
- ✅ Cover image uploaded earlier via "Computer files" label on Product tab.

## DOM map of the product edit page (Product tab)

- **Cover section**: `label` with text **"Computer files"** (role=`tab`), sibling `a` = "External link".
  - First child: `<input type="file" class="sr-only" multiple accept=".jpeg,.jpg,.png,.gif,.mov">`.
  - Parent chain: `div[role="tablist"]` → container div → dashed-border upload box → `section` (Cover section).
  - Clicking "Computer files" opens the chooser → feed it the image file.
- **Thumbnail section**: label **"Upload"** (accept `.jpeg,.jpg,.png,.gif,.webp,image/avif`) — same recipe. (Deferred.)
- **Content tab**: separate tab ("Product | Content | Receipt | Share") — not yet mapped.
- Image-accepting file inputs on page: 2 (`accept` contains `avif`), audio input: 1 (`accept` contains `mp3`).

## Verification helpers

Simple eval against the page (save as `/tmp/eval.js`):
```js
const http=require('http');
function get(p){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9222,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)})}
function send(ws,expr){return new Promise((res,rej)=>{const id=Math.floor(Math.random()*1e9);const WebSocket=require('/projects/ServerBrowser/node_modules/ws');const s=new WebSocket(ws);s.on('open',()=>s.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression:expr,returnByValue:true}})));s.on('message',m=>{const j=JSON.parse(m);if(j.id===id){res(j);s.close()}});s.on('error',rej)})}
(async()=>{const t=(await get('/json/list')).find(x=>x.type==='page');const r=await send(t.webSocketDebuggerUrl,process.argv[2]||'1+1');console.log(JSON.stringify(r.result||r.error,null,1));})();
```
- Check file inputs:
  `node /tmp/eval.js "[...document.querySelectorAll('input[type=file]')].map(i=>({n:i.files.length,acc:i.accept.slice(0,30)}))"`
- Screenshot: `node /projects/ServerBrowser/scripts/live.js screenshot /tmp/x.png`
- User prefers **DOM evaluation over screenshots** — always verify via DOM.

### Publish & save buttons (both CONFIRMED WORKING)

Top bar of the edit page (after scrolling to top, ~y=64):

1. **`button` "Publish and continue"** (x≈1154, y≈64) → real mouse click → publishes the product. Page shows **"Published!"** alert and navigates to the next tab (e.g. `/products/qxqkn/edit/share`).
2. **`button` "Save changes"** (x≈1168, y≈64) → real mouse click → saves. Page shows **"Changes saved!"** alert + optional "notify your customers?" prompt (Skip it) + Gumroad Discover eligibility notice.

Standard click recipe for both:
```js
await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
await c.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
```
Find coords via `Runtime.evaluate` on the button's `getBoundingClientRect()`. Verify via URL change + `[role=alert]` text in DOM.

## Current state / next steps

- ✅ Cover image uploaded to product `qxqkn` via "Computer files" label (user confirmed).
- ✅ Content zip uploaded on Content tab via "Upload your files" → modal → "Computer files" → chooser (user confirmed).
- ✅ **"Publish and continue"** pressed → "Published!" → landed on Share tab.
- ✅ **"Save changes"** pressed → "Changes saved!" (customer-notify prompt skipped).
- ⏸ Thumbnail: on hold, per user.
- Delete files from `/tmp/gumwork/` only after user confirms the upload is verified.
