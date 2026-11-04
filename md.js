// Just enough Markdown for the files the cloud jobs write: headings, lists,
// bold, italics, code, links, rules, quotes and simple tables. Everything is
// escaped first, so a file can never inject HTML into the app.
//
// Two quote shapes from lecture notes get special treatment:
//   > **Answer:** …            → a collapsed <details> (try the question first)
//   > **Likely examinable:** … → a highlighted callout

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

export function slugify(s) {
  return 'h-' + (s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'x');
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// opts.ids: give headings ids (for a contents list); opts.headings collects them.
export function render(md, opts = {}) {
  const out = [];
  const used = opts.used || new Set();
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const close = () => { flush(); if (list) { out.push(`</${list}>`); list = null; } };
  const lines = md.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      close();
      let code = '';
      while (++i < lines.length && !lines[i].startsWith('```')) code += lines[i] + '\n';
      out.push(`<pre><code>${esc(code)}</code></pre>`);
      continue;
    }
    if (/^>/.test(line)) {
      close();
      const quote = [];
      while (i < lines.length && /^>/.test(lines[i])) quote.push(lines[i++].replace(/^> ?/, ''));
      i--;
      const text = quote.join('\n');
      const answer = text.match(/^\*\*Answer:\*\*\s*([\s\S]*)/);
      if (answer) out.push(`<details class="answer"><summary>Answer</summary>${render(answer[1], { used })}</details>`);
      else if (/^\*\*Likely examinable:\*\*/.test(text)) out.push(`<aside class="exam">${render(text, { used })}</aside>`);
      else out.push(`<blockquote>${render(text, { used })}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      close();
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      close();
      const level = h[1].length + 1;
      let id = '';
      if (opts.ids) {
        id = slugify(h[2]);
        while (used.has(id)) id += '-';
        used.add(id);
        opts.headings?.push({ level: h[1].length, text: h[2], id });
      }
      out.push(`<h${level}${id ? ` id="${id}"` : ''}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^---+\s*$/.test(line)) { close(); out.push('<hr>'); continue; }
    const li = line.match(/^\s*(?:[-*]|(\d+)\.)\s+(.*)/);
    if (li) {
      flush();
      const kind = li[1] ? 'ol' : 'ul';
      if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline(li[2])}</li>`);
      continue;
    }
    if (!line.trim()) { close(); continue; }
    if (list) close();
    para.push(line);
  }
  close();
  return out.join('\n');
}

export { esc };
