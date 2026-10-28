const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const docsDir = path.join(__dirname, 'docs');
const outDir = path.join(__dirname, 'docs-html');

if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

const files = fs.readdirSync(docsDir)
  .filter(f => f.endsWith('.md'))
  .sort();

const sections = [];

for (const file of files) {
  const name = file.replace(/\.md$/, '');
  const mdPath = path.join(docsDir, file);
  const md = fs.readFileSync(mdPath, 'utf8');
  const html = marked.parse(md, { gfm: true, breaks: false });
  sections.push({ name, file, html });
}

// Write individual HTML section files
for (const sec of sections) {
  const htmlPath = path.join(outDir, `${sec.name}.html`);
  const content = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ServerBrowser — Documentation</title>
<style>
  :root{
    --bg:#050112;
    --panel:#0d0a1f;
    --line:#2a1a4a;
    --text:#e2e8f0;
    --muted:#a4b0c4;
    --accent:#06d6fd;
    --pink:#ff00ea;
    --nebula:#7b2cbf;
    --green:#34d399;
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    margin: 0; padding: 24px;
    color: var(--text);
    background: radial-gradient(ellipse at 50% 30%,#0c001f 0%,var(--bg) 65%),
                radial-gradient(circle at 85% 20%,#7b2cbf22 0%,transparent 55%),
                radial-gradient(circle at 70% 70%,#06d6fd11 0%,transparent 50%);
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
    position: relative;
    overflow-x: hidden;
  }
  /* starfield */
  body::before {
    content:'';
    position:fixed;
    inset:0;
    width:100%;
    height:100%;
    background:
      radial-gradient(2px,rgba(6,214,253,.5) 0%,transparent 70%),
      radial-gradient(2px,rgba(255,0,234,.4) 0%,transparent 70%),
      radial-gradient(1px,rgba(123,44,191,.3) 0%,transparent 70%);
    background-size:26px 26px,42px 42px,26px 26px;
    background-position:0 0,5px 5px,15px 15px;
    z-index:0;
    pointer-events:none;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--pink); text-shadow:0 0 8px var(--pink); }
  pre { background: linear-gradient(145deg,#0d0a1f,#13102a); color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; border:1px solid var(--line); }
  code { background: rgba(255,0,234,.08); color: var(--green); padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
  pre code { background: transparent; padding: 0; color: #e2e8f0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; }
  th { color: var(--accent); background: rgba(6,214,253,.06); }
  blockquote { border-left: 4px solid var(--pink); padding-left: 16px; color: var(--muted); margin-left: 0; }
  img { max-width: 100%; border-radius: 8px; }
  .back {
    display: inline-block;
    margin-bottom: 16px;
    color: var(--accent);
    font-weight: 600;
  }
  h1 { color: #f8fafc; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  h2 { color: var(--accent); margin-top: 28px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  h3 { color: var(--pink); }
  wrapper { position: relative; z-index: 1; max-width: 960px; margin: 0 auto; }
</style>
</head>
<body>
  <wrapper>
  <a class="back" href="index.html">&larr; Back to docs</a>
  ${sec.html}
  </wrapper>
</body>
</html>`;
  fs.writeFileSync(htmlPath, content);
}

// Build sidebar tree data
const sidebarItems = sections.map(sec => {
  const headings = [];
  const regex = /^#{2,3}\s+(.+)$/gm;
  let m;
  while ((m = regex.exec(sec.html)) !== null) {
    const level = (m[0].match(/^#+/) || [''])[0].length;
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    const id = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    headings.push({ level, text, id });
  }
  return { ...sec, headings };
});

// Write index.html with tree sidebar
const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ServerBrowser — Documentation</title>
  <style>
  :root { --sidebar-w: 280px; --bg: #050112; --panel: #0d0a1f; --muted: #a4b0c4; --accent: #06d6fd; --pink: #ff00ea; --text: #e2e8f0; --line: #2a1a4a; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
    color: var(--text);
    background: radial-gradient(ellipse at 50% 30%,#0c001f 0%,var(--bg) 65%),
                radial-gradient(circle at 85% 20%,#7b2cbf22 0%,transparent 55%),
                radial-gradient(circle at 20% 80%,#06d6fd11 0%,transparent 50%);
    display: flex;
    overflow-x: hidden;
  }
  /* starfield */
  body::before {
    content:'';
    position:fixed;
    inset:0;
    width:100%;
    height:100%;
    background:
      radial-gradient(2px,rgba(6,214,253,.5) 0%,transparent 70%),
      radial-gradient(2px,rgba(255,0,234,.4) 0%,transparent 70%),
      radial-gradient(1px,rgba(123,44,191,.3) 0%,transparent 70%);
    background-size:26px 26px,42px 42px,26px 26px;
    background-position:0 0,5px 5px,15px 15px;
    z-index:0;
    pointer-events:none;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--pink); text-decoration: underline; }
  #sidebar {
    width: var(--sidebar-w);
    min-width: var(--sidebar-w);
    height: 100vh;
    overflow-y: auto;
    background: linear-gradient(180deg, #0d0a1f, #070214);
    border-right: 1px solid var(--line);
    padding: 18px 14px;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  #sidebar h1 {
    font-size: 16px;
    margin: 0 0 10px;
    color: #f8fafc;
    text-shadow: 0 0 6px var(--pink);
  }
  #sidebar .brand { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
  .tree { list-style: none; margin: 0; padding: 0; }
  .tree li { margin: 2px 0; }
  .tree .item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    color: #cbd5e1;
    cursor: pointer;
    user-select: none;
    transition: all .2s ease;
  }
  .tree .item:hover { background: #1a123a; color: #fff; }
  .tree .item.active { background: #1a0d3a; color: var(--accent); text-shadow: 0 0 6px var(--accent); }
  .tree .item .chevron {
    width: 14px;
    text-align: center;
    font-size: 10px;
    color: var(--muted);
    transition: transform 0.15s ease;
  }
  .tree .item .chevron.open { transform: rotate(90deg); color: var(--accent); }
  .tree .children { display: none; padding-left: 18px; }
  .tree .children.open { display: block; }
  .tree .leaf {
    padding-left: 28px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
    transition: color .2s ease;
  }
  .tree .leaf:hover { color: var(--accent); }
  #content {
    flex: 1;
    height: 100vh;
    overflow-y: auto;
    background: #050112;
    color: var(--text);
  }
  #content .wrap { max-width: 900px; margin: 0 auto; padding: 32px 28px 80px; position: relative; z-index: 1; }
  #content h1 { font-size: 32px; margin: 0 0 8px; color: #f8fafc; }
  #content h2 { font-size: 22px; margin: 28px 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--line); color: var(--accent); }
  #content h3 { font-size: 17px; margin: 22px 0 8px; color: var(--pink); }
  #content p { margin: 10px 0; }
  #content pre { background: linear-gradient(145deg,#0d0a1f,#13102a); color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; border: 1px solid var(--line); }
  #content code { background: rgba(255,0,234,.08); color: var(--green); padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
  #content pre code { background: transparent; padding: 0; color: #e2e8f0; }
  #content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  #content th { background: rgba(6,214,253,.06); color: var(--accent); border: 1px solid var(--line); }
  #content td { border: 1px solid var(--line); color: var(--muted); }
  #content blockquote { border-left: 4px solid var(--pink); padding-left: 16px; color: var(--muted); margin-left: 0; }
  #content img { max-width: 100%; border-radius: 8px; }
  #content a { color: var(--accent); }
  #content a:hover { color: var(--pink); text-shadow: 0 0 6px var(--pink); }
</style>
</head>
<body>
  <nav id="sidebar" aria-label="Documentation">
    <h1>ServerBrowser</h1>
    <div class="brand">Documentation</div>
    <ul class="tree" id="tree"></ul>
  </nav>
  <main id="content">
    <div class="wrap" id="page"></div>
  </main>
  <script>
    const sections = ${JSON.stringify(sidebarItems)};
    const tree = document.getElementById('tree');
    const page = document.getElementById('page');

    function slugify(text) {
      return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    sections.forEach((sec, idx) => {
      const li = document.createElement('li');
      const item = document.createElement('div');
      item.className = 'item';
      const chevron = document.createElement('span');
      chevron.className = 'chevron';
      chevron.textContent = '▶';
      const label = document.createElement('span');
      label.textContent = sec.name;
      item.appendChild(chevron);
      item.appendChild(label);

      const children = document.createElement('ul');
      children.className = 'children';

      const hasHeadings = sec.headings && sec.headings.length > 0;
      if (hasHeadings) {
        sec.headings.forEach(h => {
          const leaf = document.createElement('li');
          const a = document.createElement('div');
          a.className = 'leaf';
          a.textContent = h.text;
          a.dataset.section = sec.name;
          a.dataset.anchor = h.id;
          a.addEventListener('click', () => {
            loadSection(sec.name, h.id);
            document.querySelectorAll('.tree .item').forEach(x => x.classList.remove('active'));
            document.querySelectorAll('.tree .leaf').forEach(x => x.classList.remove('active'));
            a.classList.add('active');
          });
          leaf.appendChild(a);
          children.appendChild(leaf);
        });
      }

      item.addEventListener('click', () => {
        const isOpen = children.classList.contains('open');
        if (isOpen) {
          children.classList.remove('open');
          chevron.classList.remove('open');
        } else {
          children.classList.add('open');
          chevron.classList.add('open');
        }
        if (!isOpen) {
          loadSection(sec.name);
          document.querySelectorAll('.tree .item').forEach(x => x.classList.remove('active'));
          document.querySelectorAll('.tree .leaf').forEach(x => x.classList.remove('active'));
          item.classList.add('active');
        }
      });

      li.appendChild(item);
      if (hasHeadings) li.appendChild(children);
      tree.appendChild(li);
    });

    function loadSection(name, anchor) {
      const sec = sections.find(s => s.name === name);
      if (!sec) return;
      const html = sec.html;
      if (anchor) {
        const el = document.createElement('div');
        el.innerHTML = html;
        const target = el.querySelector('#' + anchor);
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        page.innerHTML = html;
        history.replaceState(null, '', '#' + anchor);
      } else {
        page.innerHTML = html;
        history.replaceState(null, '', name + '.html');
      }
    }

    // Load from hash
    function loadFromHash() {
      const hash = location.hash.replace('#', '');
      if (!hash) return;
      const [name, anchor] = hash.split('/');
      if (name && sections.find(s => s.name === name)) {
        loadSection(name, anchor);
      }
    }

    window.addEventListener('hashchange', loadFromHash);
    loadFromHash();
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(outDir, 'index.html'), indexHtml);

console.log('Built docs-html/ with', sections.length, 'sections');
console.log('Open docs-html/index.html in a browser to view.');
