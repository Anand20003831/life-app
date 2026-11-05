// Sheets: the reader (any repo file, lecture notes with contents), and the
// delegate form. A sheet is one step in the history, so Android's back button
// closes it; focus moves into it and goes back where it was when it closes.

import * as gh from './gh.js';
import * as ai from './ai.js';
import { render as md, esc } from './md.js';
import { I } from './icons.js';
import { reducedMotion } from './ui.js';
import { $, classify } from './store.js';
import { when } from './format.js';
import { empty, skeleton } from './parts.js';

export function overlay(html, { title = '', download = '', full = false } = {}) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="sheet${full ? ' full' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Details')}">
    <div class="sheet-bar"><span class="sheet-title">${esc(title)}</span>
      ${download ? `<button class="icon" data-action="download" data-name="${esc(download)}" aria-label="Download">${I.download}</button>` : ''}
      <button class="icon" data-action="close" aria-label="Close">${I.x}</button></div>
    <div class="body">${html}</div></div>`;
  el.opener = document.activeElement; // focus goes back here when the sheet closes
  document.body.append(el);
  document.body.classList.add('sheet-open');
  history.pushState({ sheet: (history.state?.sheet || 0) + 1 }, '');
  $('.sheet [data-action=close]', el).focus({ preventScroll: true });
  return { el, body: $('.body', el) };
}

export function closeTop({ fromHistory = false } = {}) {
  const all = document.querySelectorAll('.overlay:not(.closing)');
  const el = all[all.length - 1];
  if (!el) return false;
  if (!fromHistory && history.state?.sheet) { history.back(); return true; } // popstate closes it
  el.classList.add('closing');
  setTimeout(() => {
    el.remove();
    if (!document.querySelector('.overlay')) document.body.classList.remove('sheet-open');
    if (el.opener?.isConnected) el.opener.focus({ preventScroll: true });
  }, reducedMotion() ? 0 : 180);
  return true;
}

// Tab stays inside the open sheet (it's modal); Escape closes it.
document.addEventListener('keydown', (e) => {
  const all = document.querySelectorAll('.overlay:not(.closing)');
  const top = all[all.length - 1];
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); closeTop(); return; }
  if (e.key !== 'Tab') return;
  const items = [...top.querySelectorAll('a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
    .filter((x) => x.offsetParent !== null);
  if (!items.length) return;
  const [first, last] = [items[0], items[items.length - 1]];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  else if (!top.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
});

export async function openFile(path, title) {
  const name = path.split('/').pop().replace(/\.chunks\.json$/, '');
  // full height from the start, so the sheet doesn't jump when the file arrives
  const ov = overlay(skeleton('text'), { title: title || name.replace(/\.md$/, ''), download: name, full: true });
  const load = async () => {
    try {
      const text = await gh.readMaybeChunked(path);
      if (text == null) { ov.body.innerHTML = empty(I.file, 'Not there yet', 'This file hasn\'t been written yet. It usually appears after the next sync.'); return; }
      const isMd = /\.md$/.test(path.replace(/\.chunks\.json$/, ''));
      if (/\/lectures\/[^/]+\.md$/.test(path)) {
        ov.body.innerHTML = lectureView(text);
        ov.body.dataset.transcript = text.split(/\n## Transcript\s*\n/)[1] || '';
      } else {
        ov.body.innerHTML = isMd ? `<article class="md">${md(text)}</article>` : `<pre class="file">${esc(text)}</pre>`;
      }
      ov.body.dataset.base = path.slice(0, path.lastIndexOf('/') + 1);
      ov.body.dataset.text = text.length < 2e6 ? text : '';
    } catch (err) {
      const off = classify(err) === 'offline';
      ov.body.innerHTML = empty(off ? I.offline : I.alert, off ? "Can't open this offline" : "Couldn't open this",
        off ? 'Files are fetched when you open them. Try again when you have signal.' : esc(err.message), '<button class="retry-file">Retry</button>');
      $('.retry-file', ov.body).onclick = () => { ov.body.innerHTML = skeleton('text'); load(); };
    }
  };
  load();
}

// A lecture file: header, notes (or the old summary), then the transcript.
// The notes get a contents list; the transcript is collapsed and only rendered
// when opened, since it can be 60k characters.
function lectureView(text) {
  const [notes, transcript] = text.split(/\n## Transcript\s*\n/);
  const cut = notes.search(/\n## /);
  const top = cut < 0 ? notes : notes.slice(0, cut);  // title, module, recorded, slides
  const headings = [];
  const html = md(cut < 0 ? '' : notes.slice(cut), { ids: true, headings });
  const toc = headings.filter((h) => h.level >= 2 && h.level <= 3);
  const words = transcript ? transcript.split(/\s+/).length : 0;
  return `<article class="md notes">
    ${md(top)}
    ${toc.length > 2 ? `<nav class="toc" aria-label="Contents"><h4>Contents</h4><ol>${toc.map((h) =>
      `<li class="l${h.level}"><a href="#${h.id}" data-action="jump" data-id="${h.id}">${esc(h.text)}</a></li>`).join('')}</ol></nav>` : ''}
    ${html}
    ${transcript ? `<details class="transcript"><summary>Transcript <span class="muted">· ${words.toLocaleString('en-GB')} words</span></summary><div class="tx"></div></details>` : ''}
  </article>
  <button class="totop ghost" data-action="totop" aria-label="Back to top">${I.up}</button>`;
}

// "../files/x.md" from uni/C/lectures/ → uni/C/files/x.md
export function resolvePath(base, rel) {
  const parts = (base + rel).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join('/');
}

export async function delegateDialog(task) {
  const cached = ai.cachedModels();
  const current = ai.settings.model;
  const opts = (list) => list.map((m) => `<option ${m.id === current ? 'selected' : ''}>${esc(m.id)}</option>`).join('');
  const ov = overlay(`<p class="lead"><b>${esc(task.title)}</b><br><span class="muted small">${esc(task.module || '')}${task.due ? ` · due ${when(task.due)}` : ''}</span></p>
    <form class="stack" data-action="delegate-go">
      <label>What should it do? <textarea name="instruction" rows="4" required placeholder="e.g. write 15 practice questions with answers on this topic; or draft test cases for my parser"></textarea></label>
      <div class="row two"><label>Model <select name="model">${cached.length ? opts(cached) : '<option value="">Default</option>'}</select></label>
      <label>Effort <select name="effort">${['low', 'medium', 'high'].map((e) => `<option ${e === ai.settings.effort ? 'selected' : ''}>${e}</option>`).join('')}</select></label></div>
      <div class="files-field"><label class="btn ghost sm">${I.plus}Add files<input name="files" type="file" multiple hidden></label><span class="muted small picked">Optional: PDFs, images, code</span></div>
      <p class="muted small">For non-assessed prep and practice. Results land in Uni → Jobs, and you get a notification.</p>
      <button>Start</button><p class="progress muted small" role="status"></p></form>`, { title: 'Delegate' });
  $('form', ov.el).dataset.task = JSON.stringify(task);
  $('input[type=file]', ov.el).addEventListener('change', (e) => {
    const n = e.target.files.length;
    $('.picked', ov.el).textContent = n ? [...e.target.files].map((f) => f.name).join(', ') : 'Optional: PDFs, images, code';
  });
  if (!cached.length) {
    try {
      const all = await ai.models();
      $('select[name=model]', ov.el).innerHTML = opts(all);
    } catch { /* keeps "Default" */ }
  }
}
