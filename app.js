// Life: the organiser's app. Plain modules, no build step; GitHub Pages serves
// this folder as-is. All data lives in the private life-data repo (gh.js); the
// chat and delegated jobs use Gemini (ai.js). Functional first, styling later.

import * as gh from './gh.js';
import * as ai from './ai.js';
import { render as md, esc } from './md.js';

const TZ = 'Europe/London';
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

const state = {
  tab: localStorage.getItem('tab') || 'today',
  uniTab: localStorage.getItem('uniTab') || 'deadlines',
  mailTab: 'important',
  data: {},
  pending: [],     // proposed actions waiting for Confirm
  jobs: [],        // delegated jobs, queued and finished
  chat: loadChat(),
  busy: false,
};

// ---------------------------------------------------------------- formatting

const fmt = (iso, opts) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: TZ, ...opts }) : '');
const time = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
const dayShort = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const londonDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: TZ });

function until(iso) {
  const ms = new Date(iso) - Date.now();
  const h = Math.round(ms / 3600000);
  if (ms < 0) return h > -24 ? `${-h}h ago` : `${Math.round(-h / 24)}d ago`;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 36) return `${h}h`;
  return `${Math.round(h / 24)} days`;
}

function ago(iso) {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const KIND = { change: '⚠', focus: '◎', heads_up: '•', people: '♥', admin: '✎' };

// ---------------------------------------------------------------- data

const FILES = {
  today: 'today.json', deadlines: 'uni/deadlines.json', lectures: 'uni/lectures.json',
  courses: 'uni/courses.json', mail: 'uni/email/index.json', clickup: 'schedule/clickup.json',
  runs: 'state/runs.json', todos: 'schedule/todos.json',
};

function fromCache() {
  for (const [k, path] of Object.entries(FILES)) state.data[k] = gh.cachedJSON(path, state.data[k] ?? null);
  state.pending = gh.cachedJSON('c:pending', []) || [];
}

async function refresh() {
  if (!gh.configured()) return;
  setStatus('syncing');
  try {
    await Promise.all(Object.entries(FILES).map(async ([k, path]) => { state.data[k] = await gh.readJSON(path, null); }));
    await Promise.all([loadPending(), loadJobs()]);
    setStatus('ok');
  } catch (err) {
    setStatus('error', err.message);
  }
  draw();
}

async function loadPending() {
  const files = (await gh.list('inbox/actions')).filter((f) => f.name.endsWith('.json'));
  const all = await Promise.all(files.map((f) => gh.readJSON(f.path, null)));
  state.pending = all.filter((a) => a && a.status === 'proposed');
}

async function loadJobs() {
  const [queued, done] = await Promise.all([gh.list('inbox/delegate'), gh.list('inbox/delegate-done')]);
  const read = (list) => Promise.all(list.filter((f) => f.name.endsWith('.json')).map((f) => gh.readJSON(f.path, null)));
  state.jobs = [...await read(queued), ...await read(done)].filter(Boolean)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

let statusText = '';
function setStatus(kind, detail = '') {
  statusText = kind === 'error' ? detail : '';
  const dot = $('#sync');
  dot.className = `sync ${kind}`;
  dot.title = kind === 'error' ? detail : kind;
}

// ---------------------------------------------------------------- shell

function draw() {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  if (!gh.configured() && state.tab !== 'settings') { main.innerHTML = setupView(); return; }
  const view = { today: todayView, uni: uniView, mail: mailView, chat: chatView, settings: settingsView }[state.tab];
  main.innerHTML = view();
  if (state.tab === 'chat') {
    const log = $('#log');
    if (log) log.scrollTop = log.scrollHeight;
    fillModels();
  }
}

function setupView() {
  return `<section class="card"><h2>Set up this device</h2>
    <p>This app reads your private <code>life-data</code> repo and talks to Gemini. It needs the repo name and two keys, stored only on this device.</p>
    <button data-action="tab" data-tab="settings">Open settings</button></section>`;
}

// ---------------------------------------------------------------- Today

function todayView() {
  const t = state.data.today;
  const parts = [];
  parts.push(`<header class="day"><h1>${fmt(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })}</h1>
    ${t ? `<span class="muted">updated ${ago(t.generated)}</span>` : ''}</header>`);
  if (!t) return parts.join('') + '<p class="muted">Nothing built yet. The cloud job runs hourly.</p>';

  const b = t.brief;
  if (b) {
    parts.push(`<section class="card brief"><h2>${esc(b.headline || '')}</h2><ul class="items">
      ${(b.items || []).map((i) => `<li class="k-${esc(i.kind)}"><span>${KIND[i.kind] || '•'}</span>${esc(i.text)}</li>`).join('')}
      </ul>${b.focus ? `<div class="focus"><strong>Focus:</strong> ${esc(b.focus.what)}<br><span class="muted">${esc(b.focus.why || '')}</span></div>` : ''}</section>`);
  }
  if (state.pending.length) parts.push(pendingCard());

  if (t.changes?.length) {
    parts.push(`<section class="card warn"><h3>Timetable changes</h3><ul>${t.changes.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul></section>`);
  }

  const today = londonDate();
  const isToday = (iso) => iso && londonDate(new Date(iso)) === today;
  const rows = [
    ...(t.classes || []).map((e) => ({ start: e.start, end: e.end, title: e.title, where: e.location, kind: 'class' })),
    ...(t.personal || []).filter((e) => isToday(e.start)).map((e) => ({ start: e.start, end: e.end, title: e.title, where: e.location, kind: e.source, allDay: e.all_day })),
    ...(t.overrides || []).filter((o) => isToday(o.start)).map((o) => ({ start: o.start, end: o.end, title: o.title, where: o.location, kind: 'override', note: o.note })),
  ].sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || new Date(a.start) - new Date(b.start));
  const now = Date.now();
  parts.push(`<section class="card"><h3>Today</h3>${rows.length ? `<ol class="timeline">${rows.map((r) => {
    const live = !r.allDay && new Date(r.start) <= now && now < new Date(r.end || r.start);
    const past = !r.allDay && new Date(r.end || r.start) < now;
    return `<li class="${r.kind}${live ? ' live' : ''}${past ? ' past' : ''}"><time>${r.allDay ? 'all day' : time(r.start)}</time>
      <div><b>${esc(r.title)}</b>${r.where ? `<span class="muted"> · ${esc(r.where)}</span>` : ''}${r.note ? `<br><span class="tag">changed: ${esc(r.note)}</span>` : ''}</div></li>`;
  }).join('')}</ol>` : '<p class="muted">Nothing on today.</p>'}</section>`);

  const tomorrow = [...(t.tomorrow || []), ...(t.personal || []).filter((e) => !isToday(e.start)),
    ...(t.overrides || []).filter((o) => !isToday(o.start))].sort((a, b) => new Date(a.start) - new Date(b.start));
  if (tomorrow.length) {
    parts.push(`<section class="card"><h3>Tomorrow</h3><ul class="plain">${tomorrow.map((e) => `<li><time>${e.all_day ? 'all day' : time(e.start)}</time> ${esc(e.title)}</li>`).join('')}</ul></section>`);
  }
  if (t.overdue?.length) parts.push(taskCard('Overdue', t.overdue, 'warn'));
  if (t.due?.length) parts.push(taskCard('Due in the next 7 days', t.due));
  parts.push(`<form class="ask" data-action="ask"><input name="q" placeholder="Tell it something… e.g. group meeting moved to Thu 3pm" autocomplete="off"><button>→</button></form>`);
  return parts.join('');
}

function taskCard(title, items, cls = '') {
  return `<section class="card ${cls}"><h3>${title}</h3><ul class="tasks">${items.map((d, i) => `<li>
    <div><b>${esc(d.title)}</b><br><span class="muted">${esc(d.module || '')} ${d.source === 'clickup' ? (d.mine === false ? '· team' : '· yours') : ''} · ${dayShort(d.due)} ${time(d.due)} · ${until(d.due)}</span></div>
    <div class="row">${d.url ? `<a class="btn ghost" href="${esc(d.url)}" target="_blank" rel="noopener">Open</a>` : ''}
    <button class="ghost" data-action="delegate" data-task='${esc(JSON.stringify({ title: d.title, source: d.source, module: d.module, due: d.due, url: d.url }))}'>Delegate</button></div>
  </li>`).join('')}</ul></section>`;
}

function pendingCard() {
  return `<section class="card confirm"><h3>Waiting for your OK</h3>${state.pending.map((a) => `<div class="pending">
    <span>${esc(a.summary)}</span><div class="row"><button data-action="decide" data-yes="1" data-id="${a.id}">Confirm</button>
    <button class="ghost" data-action="decide" data-yes="0" data-id="${a.id}">Dismiss</button></div></div>`).join('')}</section>`;
}

// ---------------------------------------------------------------- Uni

function uniView() {
  const tabs = [['deadlines', 'Deadlines'], ['lectures', 'Lectures'], ['group', 'Group'], ['modules', 'Modules'], ['jobs', 'Delegated']];
  const seg = `<div class="seg">${tabs.map(([k, l]) => `<button class="${state.uniTab === k ? 'on' : ''}" data-action="uniTab" data-k="${k}">${l}</button>`).join('')}</div>`;
  return seg + ({ deadlines: deadlinesPane, lectures: lecturesPane, group: groupPane, modules: modulesPane, jobs: jobsPane }[state.uniTab])();
}

function deadlinesPane() {
  const moodle = (state.data.deadlines || []).map((d) => ({ ...d, source: 'moodle' }));
  const team = (state.data.clickup?.tasks || []).filter((t) => !t.done && t.due && /key dates/i.test(t.list || ''))
    .map((t) => ({ title: t.name, due: t.due, url: t.url, source: 'clickup', module: 'COMP2002', mine: t.mine }));
  const all = [...moodle, ...team].filter((d) => new Date(d.due) > Date.now() - 86400000).sort((a, b) => new Date(a.due) - new Date(b.due));
  return all.length ? taskCard('Upcoming', all) : '<p class="muted">No deadlines found.</p>';
}

function lecturesPane() {
  const lec = state.data.lectures || [];
  if (!lec.length) return '<p class="muted">No lectures yet.</p>';
  return `<ul class="list">${lec.map((l) => `<li data-action="open" data-path="${esc(l.path)}">
    <b>${esc(l.name)}</b> <span class="muted">${esc(l.module)} · ${dayShort(l.date)}</span>
    <p>${esc(l.tldr || 'Not summarised yet.')}</p></li>`).join('')}</ul>`;
}

function groupPane() {
  const tasks = (state.data.clickup?.tasks || []).filter((t) => !t.done);
  if (!state.data.clickup) return '<p class="muted">ClickUp isn\'t linked yet (see Settings → Health).</p>';
  const row = (t) => `<li><div><b>${esc(t.name)}</b><br><span class="muted">${esc(t.list || '')} · ${esc(t.status || '')}${t.due ? ` · ${dayShort(t.due)} ${time(t.due)}` : ''}${t.assignees?.length ? ` · ${esc(t.assignees.join(', '))}` : ''}</span></div>
    <div class="row"><a class="btn ghost" href="${esc(t.url)}" target="_blank" rel="noopener">Open</a>
    <button class="ghost" data-action="delegate" data-task='${esc(JSON.stringify({ title: t.name, source: 'clickup', module: 'COMP2002', due: t.due, url: t.url, description: t.description }))}'>Delegate</button></div></li>`;
  const mine = tasks.filter((t) => t.mine);
  const rest = tasks.filter((t) => !t.mine);
  return `<section class="card"><h3>Yours</h3><ul class="tasks">${mine.map(row).join('') || '<li class="muted">Nothing assigned to you.</li>'}</ul></section>
    <section class="card"><h3>Team</h3><ul class="tasks">${rest.map(row).join('')}</ul></section>`;
}

function modulesPane() {
  const c = state.data.courses || [];
  return `<ul class="list">${c.map((m) => `<li><b>${esc(m.code)}</b> <span class="muted">${esc(m.name.replace(/\s*\(.*$/, ''))}</span>
    <div class="row"><button class="ghost" data-action="open" data-path="uni/${esc(m.code)}/index.md">Page</button>
    <button class="ghost" data-action="open" data-path="uni/${esc(m.code)}/announcements.md">Announcements</button>
    <a class="btn ghost" href="${esc(m.url)}" target="_blank" rel="noopener">Moodle</a></div></li>`).join('')}</ul>`;
}

function jobsPane() {
  if (!state.jobs.length) return '<p class="muted">Nothing delegated yet. Use Delegate on any task.</p>';
  return `<ul class="list">${state.jobs.map((j) => `<li ${j.folder ? `data-action="open" data-path="${esc(j.folder)}/README.md"` : ''}>
    <b>${esc(j.task?.title || 'Job')}</b> <span class="tag ${j.status}">${esc(j.status)}</span>
    <p>${esc(j.instruction)}</p>
    <span class="muted">${esc(j.used || j.model || 'default model')} · ${esc(j.effort || 'medium')} effort · ${ago(j.finished || j.created)}</span>
    ${j.error ? `<p class="err">${esc(j.error)}</p>` : ''}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- Mail

function mailView() {
  const tabs = [['important', 'Important'], ['forum', 'Forum'], ['noise', 'Filtered']];
  const pick = { important: ['direct', 'person'], forum: ['forum'], noise: ['noise', 'secret', 'reminder', 'sent'] }[state.mailTab];
  const items = (state.data.mail || []).filter((m) => pick.includes(m.kind));
  return `<div class="seg">${tabs.map(([k, l]) => `<button class="${state.mailTab === k ? 'on' : ''}" data-action="mailTab" data-k="${k}">${l}</button>`).join('')}</div>
    <ul class="list">${items.map((m) => `<li ${m.path ? `data-action="open" data-path="${esc(m.path)}"` : ''}>
      <b>${esc(m.subject)}</b><br><span class="muted">${m.kind === 'direct' ? '✉ ' : ''}${esc(m.from)} · ${dayShort(m.date)}${m.module ? ` · ${esc(m.module)}` : ''}</span></li>`).join('') || '<li class="muted">Nothing here.</li>'}</ul>`;
}

// ---------------------------------------------------------------- Chat

function loadChat() {
  try { return JSON.parse(localStorage.getItem('chat') || 'null') || { history: [], shown: [] }; }
  catch { return { history: [], shown: [] }; }
}

function saveChat() {
  // Gemini's own history (with thought signatures) stays on the device, trimmed;
  // the readable transcript also goes to the repo so the cloud can see it.
  state.chat.history = state.chat.history.slice(-40);
  state.chat.shown = state.chat.shown.slice(-200);
  try { localStorage.setItem('chat', JSON.stringify(state.chat)); } catch { /* full */ }
}

function chatView() {
  return `<div class="chat"><div class="chatbar">
      <select id="model" data-action="model"><option>loading models…</option></select>
      <select id="effort" data-action="effort">${['low', 'medium', 'high'].map((e) => `<option ${ai.settings.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <button class="ghost" data-action="newchat" title="Start a fresh conversation">New</button></div>
    <div id="log">${state.chat.shown.map(bubble).join('') || '<p class="muted">Ask anything, or tell it a change: "group meeting moved to Thursday 3pm", "remind me to email my tutor", "make me 10 practice questions on threads".</p>'}
      ${state.busy ? `<div class="bubble model thinking">${esc(state.busy === true ? 'thinking…' : state.busy)}</div>` : ''}</div>
    ${state.pending.length ? pendingCard() : ''}
    <form class="ask" data-action="send"><textarea name="q" rows="2" placeholder="Message" ${state.busy ? 'disabled' : ''}></textarea><button ${state.busy ? 'disabled' : ''}>Send</button></form></div>`;
}

function bubble(m) {
  return `<div class="bubble ${m.role}">${m.role === 'model' ? md(m.text || '') : esc(m.text).replace(/\n/g, '<br>')}
    ${m.tools?.length ? `<div class="muted small">used: ${esc(m.tools.join(', '))}</div>` : ''}</div>`;
}

async function fillModels() {
  const sel = $('#model');
  if (!sel || sel.dataset.filled) return;
  try {
    const [all, current] = await Promise.all([ai.models(), ai.defaultModel()]);
    sel.innerHTML = all.map((m) => `<option value="${esc(m.id)}" ${m.id === current ? 'selected' : ''}>${esc(m.id)}</option>`).join('');
    sel.dataset.filled = '1';
    if (current && !ai.settings.model) ai.settings.model = current;
  } catch (err) {
    sel.innerHTML = `<option>models unavailable</option>`;
  }
}

async function sendChat(text) {
  // Read the choice from settings, not the <select>: draw() below rebuilds the
  // select, and mid-rebuild its value is the "loading models…" placeholder.
  const model = ai.settings.model || undefined;
  state.chat.shown.push({ role: 'user', text, at: new Date().toISOString() });
  state.busy = true;
  draw();
  const tools = [];
  try {
    const out = await ai.send(state.chat.history, text, {
      model, effort: ai.settings.effort,
      onTool: (name) => { tools.push(name); state.busy = `using ${name}…`; draw(); },
    });
    state.chat.history = out.history;
    state.chat.shown.push({ role: 'model', text: out.reply, at: new Date().toISOString(), tools, model: out.model });
    if (out.proposed.length) state.pending.push(...out.proposed);
  } catch (err) {
    state.chat.shown.push({ role: 'model', text: `**Couldn't answer:** ${err.message}`, at: new Date().toISOString() });
  }
  state.busy = false;
  saveChat();
  draw();
  archiveChat().catch(() => {});
  if (tools.some((t) => /schedule|todo|remember/.test(t))) refresh();
}

async function archiveChat() {
  const month = londonDate().slice(0, 7);
  const recent = state.chat.shown.slice(-2);
  await gh.update(`chat/${month}.json`, (log) => [...log, ...recent.map(({ role, text, at, tools, model }) => ({ role, text, at, tools, model }))], [], 'app: chat');
}

// ---------------------------------------------------------------- Settings

const EXPECT = { 'uni-sync': 13, 'lecture-sync': 13, 'mail-sync': 13, 'calendar-sync': 2, 'clickup-sync': 2, today: 2 };

function settingsView() {
  const runs = state.data.runs || {};
  const health = Object.entries(EXPECT).map(([job, hours]) => {
    const r = runs[job];
    let cls = 'bad';
    let note = 'not set up yet';
    if (r) {
      const age = (Date.now() - new Date(r.last_ok || 0)) / 3600000;
      cls = r.status === 'ok' && age <= hours ? 'good' : age <= hours * 2 ? 'meh' : 'bad';
      note = `${r.status === 'ok' ? 'ok' : esc(r.status)} · last good ${ago(r.last_ok)}`;
    }
    return `<li class="${cls}"><b>${job}</b> <span class="muted">${note}</span></li>`;
  }).join('');
  const masked = (v) => (v ? `${esc(v.slice(0, 6))}…${esc(v.slice(-4))}` : 'not set');
  return `<section class="card"><h2>Keys (this device only)</h2>
    <form data-action="savekeys" class="stack">
      <label>GitHub token <span class="muted">${masked(gh.cfg.token)}</span><input name="ghToken" type="password" placeholder="github_pat_…" autocomplete="off"></label>
      <label>Gemini API key <span class="muted">${masked(gh.cfg.geminiKey)}</span><input name="geminiKey" type="password" placeholder="paste to replace" autocomplete="off"></label>
      <label>Data repo <input name="repo" value="${gh.cfg.owner ? `${esc(gh.cfg.owner)}/${esc(gh.cfg.repo)}` : ''}" placeholder="your-username/life-data"></label>
      <button>Save</button></form></section>
    <section class="card"><h2>Run now</h2><div class="row wrap">
      <button data-action="run" data-wf="uni-sync.yml">Check Moodle, lectures + email</button>
      <button data-action="run" data-wf="pulse.yml">Refresh calendar + ClickUp + Today</button>
      <button class="ghost" data-action="refresh">Reload data</button></div>
      <p class="muted small">A run takes 1–5 minutes; you get a notification for anything new.</p></section>
    <section class="card"><h2>Health</h2><ul class="health">${health}</ul>
      ${statusText ? `<p class="err">${esc(statusText)}</p>` : ''}</section>`;
}

// ---------------------------------------------------------------- reader + delegate overlays

async function openFile(path) {
  const ov = overlay(`<p class="muted">Loading…</p>`);
  try {
    const text = await gh.readMaybeChunked(path);
    if (text == null) { ov.body.innerHTML = '<p class="muted">Not there yet.</p>'; return; }
    const isMd = /\.md$/.test(path.replace(/\.chunks\.json$/, ''));
    const name = path.split('/').pop().replace(/\.chunks\.json$/, '');
    ov.body.innerHTML = `<div class="row"><button class="ghost" data-action="download" data-name="${esc(name)}">Download</button></div>`
      + (isMd ? `<article class="md">${md(text)}</article>` : `<pre class="file">${esc(text)}</pre>`);
    ov.body.dataset.base = path.slice(0, path.lastIndexOf('/') + 1);
    ov.body.dataset.text = text.length < 2e6 ? text : '';
  } catch (err) {
    ov.body.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  }
}

function overlay(html) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="sheet"><button class="close" data-action="close">✕</button><div class="body">${html}</div></div>`;
  document.body.append(el);
  return { el, body: $('.body', el) };
}

async function delegateDialog(task) {
  const ov = overlay(`<h2>Delegate</h2><p><b>${esc(task.title)}</b><br><span class="muted">${esc(task.module || '')} ${task.due ? `· due ${dayShort(task.due)}` : ''}</span></p>
    <form class="stack" data-action="delegate-go">
      <label>What should it do? <textarea name="instruction" rows="4" required placeholder="e.g. write 15 practice questions with answers on this topic; or draft test cases for my parser"></textarea></label>
      <div class="row"><label>Model <select name="model"><option>loading…</option></select></label>
      <label>Effort <select name="effort">${['low', 'medium', 'high'].map((e) => `<option ${e === ai.settings.effort ? 'selected' : ''}>${e}</option>`).join('')}</select></label></div>
      <label>Files (optional) <input name="files" type="file" multiple></label>
      <p class="muted small">For non-assessed prep and practice. Results land in Uni → Delegated, and you get a notification.</p>
      <button>Start</button><p class="progress muted small"></p></form>`);
  $('form', ov.el).dataset.task = JSON.stringify(task);
  try {
    const [all, current] = await Promise.all([ai.models(), ai.defaultModel()]);
    $('select[name=model]', ov.el).innerHTML = all.map((m) => `<option ${m.id === current ? 'selected' : ''}>${esc(m.id)}</option>`).join('');
  } catch {
    $('select[name=model]', ov.el).innerHTML = '<option value="">default</option>';
  }
}

// ---------------------------------------------------------------- events

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT') return;
  const a = el.dataset.action;
  if (a === 'tab') { state.tab = el.dataset.tab; localStorage.setItem('tab', state.tab); draw(); }
  else if (a === 'uniTab') { state.uniTab = el.dataset.k; localStorage.setItem('uniTab', state.uniTab); draw(); }
  else if (a === 'mailTab') { state.mailTab = el.dataset.k; draw(); }
  else if (a === 'open') { e.preventDefault(); openFile(el.dataset.path); }
  else if (a === 'close') el.closest('.overlay').remove();
  else if (a === 'delegate') delegateDialog(JSON.parse(el.dataset.task));
  else if (a === 'refresh') refresh();
  else if (a === 'newchat') { state.chat = { history: [], shown: [] }; saveChat(); draw(); }
  else if (a === 'download') {
    const body = el.closest('.body');
    const blob = new Blob([body.dataset.text || body.innerText], { type: 'text/plain' });
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: el.dataset.name }).click();
  } else if (a === 'run') {
    el.disabled = true;
    try { await gh.dispatch(el.dataset.wf); el.textContent = 'Started ✓'; } catch (err) { alert(err.message); el.disabled = false; }
  } else if (a === 'decide') {
    const action = state.pending.find((p) => p.id === el.dataset.id);
    if (!action) return;
    el.closest('.pending').innerHTML = '<span class="muted">Sending…</span>';
    try {
      await ai.decide(action, el.dataset.yes === '1');
      state.pending = state.pending.filter((p) => p.id !== action.id);
    } catch (err) { alert(err.message); }
    draw();
  }
  // links inside rendered markdown that point at repo files
  const link = e.target.closest('a[data-path]');
  if (link) {
    e.preventDefault();
    const base = link.closest('.body')?.dataset.base || '';
    openFile(base + link.dataset.path);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'model' && /^gemini-/.test(e.target.value)) ai.settings.model = e.target.value;
  if (e.target.id === 'effort') ai.settings.effort = e.target.value;
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const a = form.dataset.action;
  const data = Object.fromEntries(new FormData(form));
  if (a === 'send' || a === 'ask') {
    const q = (data.q || '').trim();
    if (!q || state.busy) return;
    state.tab = 'chat';
    localStorage.setItem('tab', 'chat');
    sendChat(q);
  } else if (a === 'savekeys') {
    if (data.ghToken) localStorage.setItem('ghToken', data.ghToken.trim());
    if (data.geminiKey) localStorage.setItem('geminiKey', data.geminiKey.trim());
    const [owner, repo] = (data.repo || '').split('/');
    if (owner && repo) { localStorage.setItem('owner', owner.trim()); localStorage.setItem('repo', repo.trim()); }
    state.tab = 'today';
    draw();
    refresh();
  } else if (a === 'delegate-go') {
    const task = JSON.parse(form.dataset.task);
    const progress = $('.progress', form);
    form.querySelector('button').disabled = true;
    try {
      const jobId = gh.id();
      const attachments = [];
      for (const file of form.elements.files.files) {
        progress.textContent = `Uploading ${file.name}…`;
        attachments.push(await gh.upload(`inbox/files/${jobId}`, file, (m) => { progress.textContent = m; }));
      }
      progress.textContent = 'Starting…';
      await ai.queueDelegate({ id: jobId, ...task, instruction: data.instruction, model: /^gemini-/.test(data.model || '') ? data.model : undefined,
                               effort: data.effort, attachments });
      form.closest('.overlay').remove();
      state.tab = 'uni'; state.uniTab = 'jobs';
      await loadJobs();
      draw();
    } catch (err) {
      progress.textContent = err.message;
      form.querySelector('button').disabled = false;
    }
  }
});

document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
  state.tab = b.dataset.tab; localStorage.setItem('tab', state.tab); draw();
}));

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

fromCache();
draw();
refresh();
setInterval(() => { if (!document.hidden && state.tab === 'today') draw(); }, 60000); // keep "now" honest
