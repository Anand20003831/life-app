// Just enough Markdown for the files the cloud jobs write: headings, lists,
// bold, italics, code, links, rules. Everything is escaped first, so a file
// can never inject HTML into the app.

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) =>
      /^https?:\/\//.test(href) ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
        : `<a href="#" data-path="${href}">${text}</a>`)
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
}

export function render(md) {
  const out = [];
  let list = null;
  let code = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of md.replace(/\r/g, '').split('\n')) {
    if (code !== null) {
      if (line.startsWith('```')) { out.push(`<pre><code>${esc(code)}</code></pre>`); code = null; }
      else code += line + '\n';
      continue;
    }
    if (line.startsWith('```')) { close(); code = ''; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { close(); out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); continue; }
    if (/^---+\s*$/.test(line)) { close(); out.push('<hr>'); continue; }
    const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
    if (li) {
      const kind = li[1] ? 'ol' : 'ul';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(li[2])}</li>`);
      continue;
    }
    if (!line.trim()) { close(); continue; }
    close();
    out.push(`<p>${inline(line)}</p>`);
  }
  close();
  if (code !== null) out.push(`<pre><code>${esc(code)}</code></pre>`);
  return out.join('\n');
}

export { esc };
