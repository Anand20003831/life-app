// Mail: "Need to know" first (what each uni email means for you), then every
// email, sorted, behind a fold.

import { esc } from './md.js';
import { I } from './icons.js';
import * as org from './organise.js';
import { state } from './store.js';
import { dayShort } from './format.js';
import { blocked, empty, firstLoad, skeleton, statusNote } from './parts.js';

export function mailView() {
  const tabs = [['important', 'Important'], ['forum', 'Forum'], ['noise', 'Filtered']];
  const pick = { important: ['direct', 'person'], forum: ['forum'], noise: ['noise', 'secret', 'reminder', 'sent'] }[state.mailTab];
  const seg = `<div class="seg" role="tablist" aria-label="Mail">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${state.mailTab === k}" class="${state.mailTab === k ? 'on' : ''}" data-action="mailTab" data-k="${k}">${l}</button>`).join('')}</div>`;
  if (state.data.mail == null && firstLoad()) return statusNote() + skeleton('list', 5);
  if (state.data.mail == null && blocked()) return statusNote() + blocked();
  const items = (state.data.mail || []).filter((m) => pick.includes(m.kind));
  const none = { important: ['No important mail', 'Emails sent to you directly, and from staff, show here.'],
                 forum: ['No forum posts', 'Moodle forum questions and answers show here.'],
                 noise: ['Nothing filtered', 'Newsletters, reminders and sign-in codes are kept out of the way here (codes are never stored).'] }[state.mailTab];
  const raw = `<div class="pane">${items.length ? `<ul class="list">${items.map((m) => `<li>${m.path ? `<button class="li-btn" data-action="open" data-path="${esc(m.path)}" data-title="${esc(m.subject)}">` : '<div class="li-btn static">'}
      <b>${esc(m.subject)}</b><span class="muted small">${m.kind === 'direct' ? 'To you · ' : ''}${esc(m.from)} · ${dayShort(m.date)}${m.module ? ` · ${esc(m.module)}` : ''}</span>${m.path ? '</button>' : '</div>'}</li>`).join('')}</ul>`
    : empty(I.mail, none[0], none[1])}</div>`;
  return statusNote() + org.needToKnow(state.data.ntk || [])
    + `<details class="card tight fold all-mail" data-fold="all-mail"><summary><h3>All emails <span class="count">${(state.data.mail || []).length}</span></h3><span class="chev">${I.chevD}</span></summary>${seg}${raw}</details>`;
}
