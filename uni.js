// Uni: deadlines, lectures, the group's ClickUp board, modules and delegated jobs.

import { esc } from './md.js';
import { I } from './icons.js';
import * as org from './organise.js';
import { state } from './store.js';
import { ago, chip, dayShort, rail } from './format.js';
import { blocked, empty, firstLoad, skeleton, statusNote, taskCard } from './parts.js';

export function uniView() {
  const tabs = [['deadlines', 'Deadlines'], ['lectures', 'Lectures'], ['group', 'Group'], ['modules', 'Modules'], ['jobs', 'Jobs']];
  const seg = `<div class="seg" role="tablist" aria-label="Uni">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${state.uniTab === k}" class="${state.uniTab === k ? 'on' : ''}" data-action="uniTab" data-k="${k}">${l}</button>`).join('')}</div>`;
  const need = { deadlines: 'deadlines', lectures: 'lectures', group: 'clickup', modules: 'courses', jobs: null }[state.uniTab];
  let body;
  if (need && state.data[need] == null && firstLoad()) body = skeleton('list', 4);
  else if (need && state.data[need] == null && blocked()) body = blocked();
  else body = ({ deadlines: deadlinesPane, lectures: lecturesPane, group: groupPane, modules: modulesPane, jobs: jobsPane }[state.uniTab])();
  return statusNote() + seg + `<div class="pane">${body}</div>`;
}

function deadlinesPane() {
  const moodle = (state.data.deadlines || []).map((d) => ({ ...d, source: 'moodle' }));
  const team = (state.data.clickup?.tasks || []).filter((t) => !t.done && t.due && /key dates/i.test(t.list || ''))
    .map((t) => ({ title: t.name, due: t.due, url: t.url, source: 'clickup', module: 'COMP2002', mine: t.mine }));
  const all = [...moodle, ...team].filter((d) => new Date(d.due) > Date.now() - 864e5).sort((a, b) => new Date(a.due) - new Date(b.due));
  return all.length ? taskCard('Upcoming', all) : empty(I.calendar, 'No deadlines coming up', 'Moodle deadlines and the group\'s ClickUp key dates show here. Moodle is checked at 8am and 6pm.');
}

function lecturesPane() {
  const lec = state.data.lectures || [];
  if (!lec.length) return empty(I.book, 'No lectures yet', 'Recordings appear here after the 8am and 6pm sync, with study notes and the transcript.');
  return `<ul class="list">${lec.map((l) => `<li><button class="li-btn" data-action="open" data-path="${esc(l.path)}" data-title="${esc(l.name)}">
    <span class="li-head"><b>${esc(l.name)}</b>${chip(l.module)}</span>
    <span class="muted small">${dayShort(l.date)} · ${(l.notes || 0) >= 2 ? '<span class="tag done">Study notes</span>' : l.summarised ? '<span class="tag plain">Summary</span>' : '<span class="tag plain">Transcript only</span>'}</span>
    <span class="p">${esc(l.tldr || 'Notes are written at the next sync.')}</span></button></li>`).join('')}</ul>`;
}

// ClickUp tasks as suggestions (tick / dismiss), key dates as deadlines.
export function clickupItems() {
  return (state.data.clickup?.tasks || []).filter((t) => !t.done && !/key dates/i.test(t.list || ''))
    .map((t) => ({ key: `clickup:${t.id}`, source: 'clickup', title: t.name, due: t.due, url: t.url, task_id: t.id,
                   assignees: t.assignees || [], list: t.list, module: 'COMP2002', mine: t.mine }));
}

function groupPane() {
  if (!state.data.clickup) return empty(I.users, "ClickUp isn't linked yet", 'Once the ClickUp token is set, the group board shows here (Settings → Health).');
  const keyDates = (state.data.clickup.tasks || []).filter((t) => !t.done && t.due && /key dates/i.test(t.list || ''))
    .map((t) => ({ id: t.id, title: t.name, due: t.due, url: t.url, source: 'clickup', module: 'COMP2002', mine: t.mine }));
  const extra = clickupItems();
  const all = org.items(extra).filter((r) => r.source === 'clickup');
  const mineKeys = new Set(extra.filter((t) => t.mine).map((t) => t.key));
  const live = (r) => r.state !== 'dismissed';
  return taskCard('Key dates (deadlines)', keyDates)
    + org.section('Yours', all.filter((r) => mineKeys.has(r.key) && live(r)))
    + org.section('Team', all.filter((r) => !mineKeys.has(r.key) && live(r)), { note: 'Tick one to put it in your own calendar.' })
    + org.section('Dismissed', all.filter((r) => r.state === 'dismissed'), { collapsed: true, fold: 'group-dismissed' });
}

function modulesPane() {
  const c = state.data.courses || [];
  if (!c.length) return empty(I.book, 'No modules yet', 'Your Moodle modules appear after the first uni sync.');
  return `<ul class="list">${c.map((m) => `<li class="mod${rail(m.code)}"><div class="li-head"><b>${esc(m.name.replace(/\s*\(.*$/, ''))}</b>${chip(m.code)}</div>
    <div class="row"><button class="ghost sm" data-action="open" data-path="uni/${esc(m.code)}/index.md" data-title="${esc(m.code)} page">Page</button>
    <button class="ghost sm" data-action="open" data-path="uni/${esc(m.code)}/announcements.md" data-title="${esc(m.code)} announcements">Announcements</button>
    <a class="btn ghost sm" href="${esc(m.url)}" target="_blank" rel="noopener">${I.open}Moodle</a></div></li>`).join('')}</ul>`;
}

function jobsPane() {
  if (!state.jobs.length) return empty(I.delegate, 'Nothing delegated yet', 'Tap Delegate on any deadline or group task to hand a small, non-assessed job to the cloud. Results land here.');
  return `<ul class="list">${state.jobs.map((j) => {
    const inner = `<span class="li-head"><b>${esc(j.task?.title || 'Job')}</b><span class="tag ${j.status}">${esc(j.status)}</span></span>
      <span class="p">${esc(j.instruction)}</span>
      <span class="muted small">${esc(j.used || j.model || 'default model')} · ${esc(j.effort || 'medium')} effort · ${ago(j.finished || j.created)}</span>
      ${j.error ? `<span class="err small">${esc(j.error)}</span>` : ''}`;
    return `<li>${j.folder ? `<button class="li-btn" data-action="open" data-path="${esc(j.folder)}/README.md" data-title="${esc(j.task?.title || 'Job')}">${inner}</button>` : `<div class="li-btn static">${inner}</div>`}</li>`;
  }).join('')}</ul>`;
}
