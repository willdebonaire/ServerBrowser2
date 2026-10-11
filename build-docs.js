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
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; color: #1f2937; background: #fff; line-height: 1.6; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  pre { background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; }
  code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
  pre code { background: transparent; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  th { background: #f8fafc; }
  blockquote { border-left: 4px solid #e5e7eb; padding-left: 16px; color: #4b5563; margin-left: 0; }
  img { max-width: 100%; }
  .back { display: inline-block; margin-bottom: 16px; }
</style>
</head>
<body>
  <a class="back" href="index.html">&larr; Back to docs</a>
  ${sec.html}
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
  :root { --sidebar-w: 280px; --bg: #0b1220; --panel: #111827; --muted: #94a3b8; --accent: #38bdf8; --text: #e2e8f0; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: var(--text); background: #0b1220; display: flex; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  #sidebar { width: var(--sidebar-w); min-width: var(--sidebar-w); height: 100vh; overflow-y: auto; background: linear-gradient(180deg, #0b1220, #0f172a); border-right: 1px solid #1f2937; padding: 18px 14px; position: sticky; top: 0; }
  #sidebar h1 { font-size: 16px; margin: 0 0 10px; color: #f8fafc; }
  #sidebar .brand { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
  .tree { list-style: none; margin: 0; padding: 0; }
  .tree li { margin: 2px 0; }
  .tree .item { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; color: #cbd5e1; cursor: pointer; user-select: none; }
  .tree .item:hover { background: #0f172a; color: #fff; }
  .tree .item.active { background: #0b1d2e; color: #7dd3fc; }
  .tree .item .chevron { width: 14px; text-align: center; font-size: 10px; color: #64748b; transition: transform 0.15s ease; }
  .tree .item .chevron.open { transform: rotate(90deg); }
  .tree .children { display: none; padding-left: 18px; }
  .tree .children.open { display: block; }
  .tree .leaf { padding-left: 28px; font-size: 13px; color: #94a3b8; cursor: pointer; }
  .tree .leaf:hover { color: #e2e8f0; }
  #content { flex: 1; height: 100vh; overflow-y: auto; background: #ffffff; color: #1f2937; }
  #content .wrap { max-width: 900px; margin: 0 auto; padding: 32px 28px 80px; }
  #content h1 { font-size: 32px; margin: 0 0 8px; }
  #content h2 { font-size: 22px; margin: 28px 0 10px; padding-bottom: 8px; border-bottom: 1px solid #e5e7eb; }
  #content h3 { font-size: 17px; margin: 22px 0 8px; }
  #content p { margin: 10px 0; }
  #content pre { background: #0f172a; color: #e2e8f0; padding: 16px; border-radius: 8px; overflow-x: auto; }
  #content code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-size: 0.95em; }
  #content pre code { background: transparent; padding: 0; }
  #content table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  #content th, #content td { border: 1px solid #e5e7eb; padding: 8px 12px; text-align: left; }
  #content th { background: #f8fafc; }
  #content blockquote { border-left: 4px solid #e5e7eb; padding-left: 16px; color: #4b5563; margin-left: 0; }
  #content img { max-width: 100%; }
  #content a { color: #2563eb; }
  #content a:hover { text-decoration: underline; }
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
