// Pieces every screen shares: empty and loading states, the status line, and
// the deadline row.

import { esc } from './md.js';
import { I } from './icons.js';
import * as org from './organise.js';
import { state, firstLoad } from './store.js';
import { ago, chip, until, when } from './format.js';

export { firstLoad };

export function empty(icon, title, text, action = '') {
  return `<div class="empty-state">${icon}<h2>${esc(title)}</h2><p class="muted">${text}</p>${action}</div>`;
}

// Placeholder shapes while the first load is under way (nothing cached yet).
export function skeleton(kind = 'cards', n = 3) {
  const line = (w) => `<span class="sk" style="width:${w}%"></span>`;
  if (kind === 'list') {
    return `<div class="skel" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () =>
      `<div class="sk-card">${line(70)}${line(35)}${line(90)}</div>`).join('')}</div>`;
  }
  if (kind === 'text') return `<div class="skel" aria-busy="true" aria-label="Loading">${line(60)}${line(95)}${line(88)}${line(92)}${line(40)}</div>`;
  return `<div class="skel" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) =>
    `<div class="sk-card">${line(i ? 30 : 75)}${line(92)}${line(84)}${i ? '' : line(66)}</div>`).join('')}</div>`;
}

// The line under each screen's title: when the data was saved, and any problem.
export function statusNote() {
  const s = state.status;
  const saved = localStorage.getItem('lastSync');
  const retry = `<button class="link" data-action="refresh">Retry</button>`;
  if (s.kind === 'offline') {
    if (!saved) return ''; // nothing to show: the screen's own offline panel says so
    const queued = org.pending();
    return `<div class="note" role="status">${I.offline}<span>Offline · showing what was saved ${ago(saved)}${queued ? ` · ${queued} change${queued > 1 ? 's' : ''} will sync when you're back` : ''}</span>${retry}</div>`;
  }
  if (s.kind === 'error') {
    if (!saved) return ''; // the screen shows the error panel instead
    return `<div class="note bad" role="alert">${I.alert}<span>Couldn't refresh: ${esc(s.msg)}</span>${retry}</div>`;
  }
  if (s.kind === 'auth') {
    return `<section class="card warn" role="alert"><h2>Can't open your data</h2><p>${esc(s.msg)}</p>
      <div class="row"><button data-action="tab" data-tab="settings">Settings</button><button class="ghost" data-action="refresh">Retry</button></div></section>`;
  }
  return '';
}

// A screen with no data at all and a problem: one clear message, not an empty page.
export function blocked() {
  const s = state.status;
  if (s.kind === 'offline') return empty(I.offline, "You're offline", 'Nothing has been saved on this device yet. Connect once and it will work offline after that.', `<button data-action="refresh">Retry</button>`);
  if (s.kind === 'error') return empty(I.alert, "Couldn't load", esc(s.msg), `<button data-action="refresh">Retry</button>`);
  return '';
}

// A real deadline (Moodle, ClickUp key date): tap to show Open and Delegate.
export function taskRow(d) {
  const soon = new Date(d.due) - Date.now() < 3 * 864e5;
  const meta = [d.source === 'clickup' ? (d.mine === false ? 'team' : 'yours') : d.source === 'moodle' ? 'Moodle' : null, when(d.due)].filter(Boolean).join(' · ');
  return `<li class="trow" data-row="${esc(d.id || '')}">
    <button class="trow-main" data-action="expand" aria-expanded="false">
      <span class="trow-title">${esc(d.title)}</span>
      <span class="trow-meta">${chip(d.module)}<span class="when${soon ? ' soon' : ''}">${until(d.due)}</span>${d.moved ? '<span class="tag">moved by email</span>' : ''}<span class="muted">· ${esc(meta)}</span></span></button>
    <div class="trow-acts">${d.url ? `<a class="btn ghost sm" href="${esc(d.url)}" target="_blank" rel="noopener">${I.open}Open</a>` : ''}
      <button class="ghost sm" data-action="delegate" data-task='${esc(JSON.stringify({ title: d.title, source: d.source, module: d.module, due: d.due, url: d.url }))}'>${I.delegate}Delegate</button></div></li>`;
}

export function taskCard(title, items, cls = '') {
  if (!items.length) return '';
  const rows = items;
  return `<section class="card tight ${cls}"><h3>${title} <span class="count">${rows.length}</span></h3><ul class="trows">${rows.map(taskRow).join('')}</ul></section>`;
}
