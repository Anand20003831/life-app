// Life: the organiser's app. Plain modules, no build step; GitHub Pages serves
// this folder as-is. All data lives in the private life-data repo (gh.js); the
// chat and delegated jobs use Gemini (ai.js).
//
// Every screen has four states: loading (skeletons), ready, empty (says what
// will appear and when), and a problem: offline (cached data, with when it was
// saved), or an error with Retry. Data older than expected is flagged as stale.

import * as gh from './gh.js';
import * as ai from './ai.js';
import * as chat from './chat.js';
import { render as md, esc } from './md.js';
import { I } from './icons.js';
import { toast, reducedMotion } from './ui.js';

const TZ = 'Europe/London';
const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

const state = {
  tab: localStorage.getItem('tab') || 'today',
  uniTab: localStorage.getItem('uniTab') || 'deadlines',
  mailTab: 'important',
  todayTab: localStorage.getItem('todayTab') || 'day',
  day: null,       // the day picked in Today's week strip (null = today)
  week: 0,         // 0 = this week, 1 = next
  data: {},
  pending: [],     // proposed actions waiting for Confirm
  jobs: [],        // delegated jobs, queued and finished
  pendingLoaded: false,
  status: { kind: 'idle' }, // idle | loading | ok | offline | error | auth
  hidden: new Set(), // rows marked done this session (optimistic, undoable)
};
const scrolls = {};

// ---------------------------------------------------------------- formatting

// Intl formatters are slow to create, so each format is made once and reused
// (Today formats hundreds of dates to draw the week strip).
const formatters = new Map();
function formatter(locale, opts) {
  const key = locale + JSON.stringify(opts);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }));
  return formatters.get(key);
}
const fmt = (iso, opts) => (iso ? formatter('en-GB', opts).format(new Date(iso)) : '');
const time = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
const dayShort = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
const londonDate = (d = new Date()) => formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const when = (iso) => `${dayShort(iso)}, ${time(iso)}`;

function until(iso) {
  const ms = new Date(iso) - Date.now();
  const h = Math.round(ms / 3600000);
  if (ms < 0) return h > -24 ? `${-h}h ago` : `${Math.round(-h / 24)}d ago`;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 36) return `in ${h}h`;
  return `in ${Math.round(h / 24)} days`;
}

function ago(iso) {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const KIND = { change: I.alert, focus: I.sparkle, heads_up: I.clock, people: I.users, admin: I.edit };

// ---------------------------------------------------------------- modules: one colour each

const norm = (s) => (s || '').toLowerCase().replace(/&amp;|&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

// The module code for an event or item: its own field, or a timetable title
// ("Operating Systems AND Concurrency - Lecture") matched to a course name.
function moduleOf(e) {
  if (e.module) return e.module;
  const title = norm((e.title || '').split(' - ')[0]);
  if (!title) return null;
  const hit = (state.data.courses || []).find((c) => norm(c.name.replace(/\s*\(.*$/, '')) === title);
  return hit ? hit.code : null;
}

function modIndex(code) {
  const codes = (state.data.courses || []).map((c) => c.code).sort();
  const i = codes.indexOf(code);
  return (i < 0 ? [...code].reduce((a, ch) => a + ch.charCodeAt(0), 0) : i) % 6;
}

const chip = (code) => (code ? `<span class="chip m${modIndex(code)}">${esc(code.replace(/^COMP/, ''))}</span>` : '');
const rail = (code) => (code ? ` m${modIndex(code)}` : '');

// ---------------------------------------------------------------- shared pieces

function empty(icon, title, text, action = '') {
  return `<div class="empty-state">${icon}<h2>${esc(title)}</h2><p class="muted">${text}</p>${action}</div>`;
}

// Placeholder shapes while the first load is under way (nothing cached yet).
function skeleton(kind = 'cards', n = 3) {
  const line = (w) => `<span class="sk" style="width:${w}%"></span>`;
  if (kind === 'list') {
    return `<div class="skel" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () =>
      `<div class="sk-card">${line(70)}${line(35)}${line(90)}</div>`).join('')}</div>`;
  }
  if (kind === 'text') return `<div class="skel" aria-busy="true" aria-label="Loading">${line(60)}${line(95)}${line(88)}${line(92)}${line(40)}</div>`;
  return `<div class="skel" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) =>
    `<div class="sk-card">${line(i ? 30 : 75)}${line(92)}${line(84)}${i ? '' : line(66)}</div>`).join('')}</div>`;
}

const firstLoad = () => state.status.kind === 'loading' && !localStorage.getItem('lastSync');

// The line under each screen's title: when the data was saved, and any problem.
function statusNote() {
  const s = state.status;
  const saved = localStorage.getItem('lastSync');
  const retry = `<button class="link" data-action="refresh">Retry</button>`;
  if (s.kind === 'offline') {
    if (!saved) return ''; // nothing to show: the screen's own offline panel says so
    return `<div class="note" role="status">${I.offline}<span>Offline · showing what was saved ${ago(saved)}</span>${retry}</div>`;
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
function blocked() {
  const s = state.status;
  if (s.kind === 'offline') return empty(I.offline, "You're offline", 'Nothing has been saved on this device yet. Connect once and it will work offline after that.', `<button data-action="refresh">Retry</button>`);
  if (s.kind === 'error') return empty(I.alert, "Couldn't load", esc(s.msg), `<button data-action="refresh">Retry</button>`);
  return '';
}

// ---------------------------------------------------------------- data

const FILES = {
  today: 'today.json', deadlines: 'uni/deadlines.json', lectures: 'uni/lectures.json',
  courses: 'uni/courses.json', mail: 'uni/email/index.json', clickup: 'schedule/clickup.json',
  runs: 'state/runs.json', todos: 'schedule/todos.json', calendar: 'schedule/calendar.json', plan: 'schedule/plan.json',
  skipped: 'schedule/skipped.json',
};

function fromCache() {
  for (const [k, path] of Object.entries(FILES)) state.data[k] = gh.cachedJSON(path, state.data[k] ?? null);
  try { state.pending = JSON.parse(localStorage.getItem('pending') || '[]'); } catch { state.pending = []; }
}

function classify(err) {
  if (!navigator.onLine || err instanceof TypeError || /GitHub 5\d\d/.test(err.message)) return 'offline';
  if (/token|can't see|public repo|can read but not write/i.test(err.message)) return 'auth';
  return 'error';
}

let syncing = null;
// Loads everything; redraws only if something changed, so an unchanged refresh
// costs no layout and nothing on screen moves.
async function refresh() {
  if (!gh.configured()) return null;
  if (syncing) return syncing;
  syncing = (async () => {
    const before = JSON.stringify([state.data, state.pending, state.jobs]);
    const was = state.status.kind;
    state.status = { kind: 'loading' };
    setDot('syncing');
    if (firstLoad()) draw();
    let changed = false;
    try {
      if (!navigator.onLine) throw new TypeError('offline');
      await gh.checkAccess();
      const got = await Promise.all(Object.entries(FILES).map(async ([k, p]) => [k, await gh.readJSON(p, null)]));
      for (const [k, v] of got) state.data[k] = v;
      await Promise.all([loadPending(), loadJobs()]);
      localStorage.setItem('lastSync', new Date().toISOString());
      state.status = { kind: 'ok' };
    } catch (err) {
      state.status = { kind: classify(err), msg: err.message };
    }
    setDot();
    changed = JSON.stringify([state.data, state.pending, state.jobs]) !== before;
    if (changed || state.status.kind !== was || was === 'idle') draw();
    return { changed, status: state.status.kind };
  })();
  try { return await syncing; } finally { syncing = null; }
}

// Only the inbox folders that exist are listed (a missing one is a 404).
async function inboxDirs() {
  const items = await gh.list('inbox');
  return new Set(items.filter((i) => i.type === 'dir').map((i) => i.name));
}

let dirs = null;
async function loadPending() {
  dirs = await inboxDirs();
  const files = dirs.has('actions') ? (await gh.list('inbox/actions')).filter((f) => f.name.endsWith('.json')) : [];
  const all = await Promise.all(files.map((f) => gh.readJSON(f.path, null)));
  state.pending = all.filter((a) => a && a.status === 'proposed');
  state.pendingLoaded = true;
  try { localStorage.setItem('pending', JSON.stringify(state.pending)); } catch { /* full */ }
}

async function loadJobs() {
  dirs ||= await inboxDirs();
  const [queued, done] = await Promise.all(['delegate', 'delegate-done'].map((d) => (dirs.has(d) ? gh.list(`inbox/${d}`) : [])));
  const read = (list) => Promise.all(list.filter((f) => f.name.endsWith('.json')).map((f) => gh.readJSON(f.path, null)));
  state.jobs = [...await read(queued), ...await read(done)].filter(Boolean)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

function setDot(kind) {
  const dot = $('#sync');
  const k = kind || { ok: 'ok', loading: 'syncing', offline: 'offline', error: 'error', auth: 'error' }[state.status.kind] || '';
  dot.className = `sync ${k}`;
  const saved = localStorage.getItem('lastSync');
  dot.setAttribute('aria-label', { ok: `Synced ${ago(saved)}`, syncing: 'Syncing…', offline: `Offline · saved ${ago(saved)}`, error: 'Sync problem' }[k] || 'Sync status');
}

// ---------------------------------------------------------------- shell + routing

// #today, #uni/lectures, #mail/forum, #chat, #settings (notifications link here)
function readRoute() {
  const [tab, sub] = location.hash.slice(1).split('/');
  if (!['today', 'uni', 'mail', 'chat', 'settings'].includes(tab)) return false;
  state.tab = tab;
  if (tab === 'uni' && ['deadlines', 'lectures', 'group', 'modules', 'jobs'].includes(sub)) state.uniTab = sub;
  if (tab === 'mail' && ['important', 'forum', 'noise'].includes(sub)) state.mailTab = sub;
  return true;
}

function writeRoute() {
  const sub = state.tab === 'uni' ? `/${state.uniTab}` : state.tab === 'mail' ? `/${state.mailTab}` : '';
  history.replaceState(history.state, '', `#${state.tab}${sub}`);
}

function go(tab) {
  if (tab === state.tab) { window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }
  scrolls[state.tab] = window.scrollY;
  state.tab = tab;
  localStorage.setItem('tab', tab);
  draw({ enter: true });
  window.scrollTo(0, scrolls[tab] || 0);
}

const drawn = { tab: '', html: '' };
function draw({ enter = false } = {}) {
  document.querySelectorAll('nav.tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.tab === state.tab);
    if (b.dataset.tab === state.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  document.body.dataset.tab = state.tab;
  $('#top .brand').textContent = { today: 'Today', uni: 'Uni', mail: 'Mail', chat: 'Chat', settings: 'Settings' }[state.tab] || 'Life';
  writeRoute();
  if (!gh.configured() && state.tab !== 'settings') { main.innerHTML = setupView(); chat.unmounted(); return; }
  const view = { today: todayView, uni: uniView, mail: mailView, chat: chat.view, settings: settingsView }[state.tab];
  const html = view();
  // Same screen, same HTML: leave the DOM alone (no repaint, nothing re-created,
  // focus and selection kept). Most background refreshes end here.
  if (state.tab !== 'chat' && !enter && html === drawn.html && drawn.tab === state.tab && main.firstChild) return;
  drawn.html = html;
  drawn.tab = state.tab;
  main.innerHTML = html;
  if (enter && !reducedMotion()) { main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter'); }
  if (state.tab === 'chat') chat.mounted(); else chat.unmounted();
}

function setupView() {
  return empty(I.sparkle, 'Set up this device', 'This app reads your private <code>life-data</code> repo and talks to Gemini. It needs the repo name and two keys, stored only on this device.',
    `<button data-action="tab" data-tab="settings">Open Settings</button>`);
}

// ---------------------------------------------------------------- Today
// Glanceable first: a week strip, then Day (now/next, focus, what needs you,
// the agenda) or Tasks (checkpoints, overdue, due this week). Details are one
// tap away, not on the first screen.

// Today is built hourly (07:00-23:00). Older than 3 hours while awake means a run was missed.
function staleNote(t) {
  const hours = (Date.now() - new Date(t.generated)) / 36e5;
  const hourNow = +fmt(new Date().toISOString(), { hour: '2-digit', hour12: false });
  if (hours < 3 || hourNow < 9) return '';
  return `<div class="note warn" role="status">${I.clock}<span>Today was built ${ago(t.generated)}; the hourly update may be late.</span>
    <button class="link" data-action="run" data-wf="pulse.yml" data-label="Today">Update now</button></div>`;
}

const dayCache = new Map();
const dayOf = (iso) => {
  if (!iso || iso.length <= 10) return iso;
  if (!dayCache.has(iso)) dayCache.set(iso, londonDate(new Date(iso)));
  return dayCache.get(iso);
};
const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const shortRoom = (loc) => {
  const rooms = (loc || '').split(',').map((r) => r.trim().replace(/^JC (Computer Science|Business School)\s*/i, '')).filter(Boolean);
  return rooms.length > 1 ? `${rooms[0]} +${rooms.length - 1}` : rooms[0] || '';
};

function skippedEvent(e) {
  const skip = state.data.skipped || [];
  return skip.some((s) => e.id === s || (e.id || '').startsWith(`${s}_`));
}

// Everything on one day, from the 14-day calendar, the plan, chat changes and
// deadlines. Falls back to today.json when the calendar file isn't there yet.
function agenda(date) {
  const t = state.data.today || {};
  const cal = state.data.calendar;
  const rows = [];
  if (cal) {
    for (const e of cal.timetable || []) if (dayOf(e.start) === date) rows.push({ ...e, kind: 'class', mod: moduleOf(e) });
    for (const e of cal.personal || []) {
      if (dayOf(e.start) !== date || e.response === 'declined' || skippedEvent(e) || e.life_kind) continue;
      rows.push({ ...e, kind: 'personal', allDay: e.all_day });
    }
  } else if (date === londonDate()) {
    for (const e of t.classes || []) rows.push({ ...e, kind: 'class', mod: moduleOf(e) });
    for (const e of t.personal || []) if (dayOf(e.start) === date) rows.push({ ...e, kind: 'personal', allDay: e.all_day });
  } else if (date === addDays(londonDate(), 1)) {
    for (const e of t.tomorrow || []) rows.push({ ...e, kind: 'class', mod: moduleOf(e) });
  }
  const blocks = state.data.plan?.blocks || (date === londonDate() ? t.plan_today : date === addDays(londonDate(), 1) ? t.plan_tomorrow : []) || [];
  for (const b of blocks) if (dayOf(b.start) === date) rows.push({ ...b, kind: `plan ${b.kind || ''}`, plan: true });
  for (const o of t.overrides || []) if (!o.cancelled && dayOf(o.start) === date) rows.push({ ...o, kind: 'override' });
  return rows.sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || new Date(a.start) - new Date(b.start));
}

// What's due on a day (Moodle, ClickUp key dates, to-dos), for the strip's dots and the agenda.
function dueOn(date) {
  const t = state.data.today || {};
  const seen = new Set();
  return [...(t.due || []), ...(t.overdue || []), ...(state.data.deadlines || [])]
    .filter((d) => d.due && dayOf(d.due) === date && !seen.has(d.title) && seen.add(d.title));
}

const TILE = { class: I.book, personal: I.calendar, override: I.edit, plan: I.sparkle, gym: I.play, due: I.clock };
function tileFor(r) {
  if (r.kind.startsWith('plan')) return /gym/i.test(r.kind + r.title) ? I.play : I.sparkle;
  if (r.kind === 'class' && /group|project/i.test(r.title)) return I.users;
  return TILE[r.kind] || I.calendar;
}

function weekStrip(sel) {
  const today = londonDate();
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const start = addDays(monday, 7 * (state.week || 0));
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const month = new Date(`${start}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  return `<div class="week">
    <div class="week-head"><b>${month}</b>
      <div class="row"><button class="icon sm" data-action="week" data-d="-1" aria-label="Previous week" ${state.week <= 0 ? 'disabled' : ''}>${I.chevL}</button>
      <button class="icon sm" data-action="week" data-d="1" aria-label="Next week" ${state.week >= 1 ? 'disabled' : ''}>${I.chevR}</button></div></div>
    <div class="days" role="tablist" aria-label="Days">${days.map((d) => {
      const dt = new Date(`${d}T12:00:00Z`);
      const has = agenda(d).some((r) => !r.allDay);
      const due = dueOn(d).length;
      return `<button role="tab" aria-selected="${d === sel}" class="day-btn${d === sel ? ' on' : ''}${d === today ? ' today' : ''}${d < today ? ' past' : ''}" data-action="pickday" data-day="${d}"
        aria-label="${dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}${due ? `, ${due} due` : ''}">
        <span class="dw">${dt.toLocaleDateString('en-GB', { weekday: 'narrow', timeZone: 'UTC' })}</span><span class="dn">${dt.getUTCDate()}</span>
        <span class="dots">${has ? '<i></i>' : ''}${due ? '<i class="due"></i>' : ''}</span></button>`;
    }).join('')}</div></div>`;
}

// The one card to read first: what's on now, or next, with the room.
function heroCard(rows) {
  const now = Date.now();
  const timed = rows.filter((r) => !r.allDay);
  const live = timed.find((r) => new Date(r.start) <= now && now < new Date(r.end || r.start));
  const next = timed.find((r) => new Date(r.start) > now);
  const r = live || next;
  if (!r) {
    const tmrw = agenda(addDays(londonDate(), 1)).filter((x) => !x.allDay)[0];
    return `<section class="hero quiet"><span class="eyebrow">Nothing else today</span>
      ${tmrw ? `<p class="hero-title">Tomorrow starts ${time(tmrw.start)} · ${esc(tmrw.title)}</p>` : '<p class="hero-title">A free evening</p>'}</section>`;
  }
  const label = live ? `Now · until ${time(r.end)}` : `Next · ${until(r.start)}`;
  return `<section class="hero${rail(r.mod)}${live ? ' live' : ''}"><span class="eyebrow">${label}</span>
    <p class="hero-title">${r.plan ? '▸ ' : ''}${esc(r.title)}</p>
    <p class="hero-meta">${time(r.start)}–${time(r.end)}${r.location ? ` · ${esc(shortRoom(r.location))}` : ''} ${chip(r.mod)}</p>
    ${r.first_step ? `<p class="hero-step">Start with: ${esc(r.first_step)}</p>` : ''}</section>`;
}

// Focus in one line; the full briefing, the week's plan and timetable changes behind a tap.
function focusCard(t) {
  const b = t.brief;
  if (!b) return '';
  const changes = (t.changes || []).slice(0, 5);
  return `<details class="focus-card"><summary>${I.sparkle}<span class="f-text"><span class="eyebrow">Focus</span>
      <span class="f-what">${esc(b.focus?.what || b.headline || '')}</span></span><span class="chev">${I.chevD}</span></summary>
    <div class="f-more">${b.focus?.why ? `<p class="muted">${esc(b.focus.why)}</p>` : ''}
      ${b.headline && b.focus ? `<p><b>${esc(b.headline)}</b></p>` : ''}
      <ul class="items">${(b.items || []).map((i) => `<li class="k-${esc(i.kind)}"><span>${KIND[i.kind] || I.clock}</span><span class="txt">${esc(i.text)}</span></li>`).join('')}</ul>
      ${t.plan_summary ? `<p class="muted small">This week: ${esc(t.plan_summary)}</p>` : ''}
      ${changes.length ? `<p class="small"><b>Timetable changes</b></p><ul class="plainlist small">${changes.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul>` : ''}</div></details>`;
}

// Everything with a date that's open, soonest first: the Tasks tab and the "needs you" strip.
function openTasks() {
  const t = state.data.today || {};
  const now = Date.now();
  const cps = (t.checkpoints || []).map((cp) => ({ ...cp, source: 'checkpoint', group: 'Checkpoints' }));
  // anything past its date is overdue, whichever list it came from (newest first)
  const dated = [...(t.overdue || []), ...(t.due || [])].map((d) => ({ ...d, group: new Date(d.due) < now ? 'Overdue' : 'Due in the next 7 days' }));
  const over = dated.filter((d) => d.group === 'Overdue').sort((a, b) => new Date(b.due) - new Date(a.due));
  const due = dated.filter((d) => d.group !== 'Overdue').sort((a, b) => new Date(a.due) - new Date(b.due));
  return [...over, ...cps, ...due].filter((d) => !state.hidden.has(d.id));
}

function taskRow(d) {
  const doneable = d.source === 'todo' || d.source === 'checkpoint';
  const soon = new Date(d.due) - Date.now() < 3 * 864e5;
  const meta = [d.source === 'checkpoint' ? `for ${d.for}` : null, d.source === 'clickup' ? (d.mine === false ? 'team' : 'yours') : null,
    when(d.due)].filter(Boolean).join(' · ');
  return `<li class="trow" data-row="${esc(d.id || '')}">
    <button class="trow-main" data-action="expand" aria-expanded="false">
      <span class="trow-title">${esc(d.title)}</span>
      <span class="trow-meta">${chip(d.module)}<span class="when${soon ? ' soon' : ''}">${until(d.due)}</span><span class="muted">· ${esc(meta)}</span></span></button>
    ${doneable ? `<button class="tick" data-action="done" data-id="${esc(d.id)}" data-title="${esc(d.title)}" aria-label="Mark done: ${esc(d.title)}">${I.check}</button>` : ''}
    <div class="trow-acts">${d.url ? `<a class="btn ghost sm" href="${esc(d.url)}" target="_blank" rel="noopener">${I.open}Open</a>` : ''}
      <button class="ghost sm" data-action="delegate" data-task='${esc(JSON.stringify({ title: d.title, source: d.source, module: d.module, due: d.due, url: d.url }))}'>${I.delegate}Delegate</button></div></li>`;
}

function taskCard(title, items, cls = '') {
  const rows = items.filter((d) => !state.hidden.has(d.id));
  if (!rows.length) return '';
  return `<section class="card ${cls}"><h3>${title} <span class="count">${rows.length}</span></h3><ul class="trows">${rows.map(taskRow).join('')}</ul></section>`;
}

function pendingCard() {
  return `<section class="card confirm"><h3>Waiting for your OK</h3>${state.pending.map((a) => `<div class="pending">
    <span>${esc(a.summary)}</span><div class="row"><button data-action="decide" data-yes="1" data-id="${a.id}">Confirm</button>
    <button class="ghost" data-action="decide" data-yes="0" data-id="${a.id}">Dismiss</button></div></div>`).join('')}</section>`;
}

function todayView() {
  const t = state.data.today;
  const sel = state.day || londonDate();
  const isToday = sel === londonDate();
  const parts = [`<p class="dateline">${fmt(new Date().toISOString(), { weekday: 'long', day: 'numeric', month: 'long' })}${t ? ` · updated ${ago(t.generated)}` : ''}</p>`];
  parts.push(statusNote());
  if (!t) {
    if (firstLoad()) return parts.join('') + skeleton('cards', 3);
    return parts.join('') + (blocked() || empty(I.calendar, "Today isn't built yet",
      'The hourly job builds it from your timetable, deadlines and email.', `<button data-action="run" data-wf="pulse.yml" data-label="Today">Build it now</button>`));
  }
  parts.push(staleNote(t));
  const tasks = openTasks();
  const urgent = tasks.filter((d) => d.group === 'Overdue' || d.source === 'checkpoint' || new Date(d.due) - Date.now() < 2 * 864e5).length;
  parts.push(`<div class="seg pill" role="tablist" aria-label="Today">
    <button role="tab" aria-selected="${state.todayTab !== 'tasks'}" class="${state.todayTab !== 'tasks' ? 'on' : ''}" data-action="todayTab" data-k="day">Day</button>
    <button role="tab" aria-selected="${state.todayTab === 'tasks'}" class="${state.todayTab === 'tasks' ? 'on' : ''}" data-action="todayTab" data-k="tasks">Tasks${tasks.length ? ` <span class="badge${urgent ? ' hot' : ''}">${tasks.length}</span>` : ''}</button></div>`);
  if (state.pending.length) parts.push(pendingCard());

  if (state.todayTab === 'tasks') {
    const by = (g) => tasks.filter((d) => d.group === g);
    const body = taskCard('Overdue', by('Overdue'), 'warn') + taskCard('Checkpoints', by('Checkpoints')) + taskCard('Due in the next 7 days', by('Due in the next 7 days'));
    return parts.join('') + `<div class="pane">${body || empty(I.check, 'All clear', 'Nothing overdue and nothing due in the next 7 days.')}</div>`;
  }

  const rows = agenda(sel);
  const due = dueOn(sel);
  const now = Date.now();
  const day = [weekStrip(sel)];
  if (isToday) {
    day.push(heroCard(rows), focusCard(t));
    // what's coming in the next 48 hours first, then the most recently missed
    const soon = tasks.filter((d) => new Date(d.due) >= now && new Date(d.due) - now < 2 * 864e5).sort((a, b) => new Date(a.due) - new Date(b.due));
    const missed = tasks.filter((d) => new Date(d.due) < now).sort((a, b) => new Date(b.due) - new Date(a.due));
    const needs = [...soon, ...missed].slice(0, 3);
    if (needs.length) {
      day.push(`<section class="card tight"><h3>Needs you <button class="link" data-action="todayTab" data-k="tasks">All tasks (${tasks.length})</button></h3>
        <ul class="trows">${needs.map(taskRow).join('')}</ul></section>`);
    }
  }
  // on today, only deadlines still ahead (the missed ones are in Needs you / Tasks)
  const dueRows = due.filter((d) => !isToday || new Date(d.due) > now).map((d) => ({ start: d.due, title: d.title, kind: 'due', mod: d.module, dueItem: true }));
  const list = [...rows, ...dueRows].sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || new Date(a.start) - new Date(b.start));
  const label = isToday ? 'Schedule' : new Date(`${sel}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  day.push(`<section class="card tight"><h3>${label}</h3>${list.length ? `<ol class="agenda">${list.map((r) => {
    const live = isToday && !r.allDay && !r.dueItem && new Date(r.start) <= now && now < new Date(r.end || r.start);
    const past = isToday && !r.allDay && new Date(r.end || r.start) < now;
    const sub = r.dueItem ? 'Due' : [r.location ? shortRoom(r.location) : '', r.note ? `changed: ${r.note}` : ''].filter(Boolean).join(' · ');
    return `<li class="ag ${r.kind}${rail(r.mod)}${live ? ' live' : ''}${past ? ' past' : ''}">
      <time>${r.allDay ? 'all day' : time(r.start)}${r.end && !r.allDay && !r.dueItem && dayOf(r.end) === dayOf(r.start) ? `<span>${time(r.end)}</span>` : ''}</time>
      <span class="tile">${r.dueItem ? I.clock : tileFor(r)}</span>
      <span class="ag-text"><b>${esc(r.title)}</b><span class="ag-meta">${chip(r.mod)}${sub ? `<span>${esc(sub)}</span>` : ''}${live ? '<span class="now">now</span>' : ''}</span>
      ${r.first_step && !past ? `<span class="ag-step">Start with: ${esc(r.first_step)}</span>` : ''}</span></li>`;
  }).join('')}</ol>` : `<p class="muted">${isToday ? 'Nothing else on today.' : 'Nothing on this day.'}</p>`}</section>`);
  day.push(`<form class="ask" data-action="ask"><input name="q" placeholder="Tell it something…" autocomplete="off" aria-label="Tell the organiser something">
    <button class="round" aria-label="Send to chat">${I.send}</button></form>`);
  return parts.join('') + `<div class="pane">${day.join('')}</div>`;
}

// ---------------------------------------------------------------- Uni

function uniView() {
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

function groupPane() {
  if (!state.data.clickup) return empty(I.users, "ClickUp isn't linked yet", 'Once the ClickUp token is set, the group board shows here (Settings → Health).');
  const tasks = (state.data.clickup?.tasks || []).filter((t) => !t.done);
  const row = (t) => `<li><div class="task-text"><b>${esc(t.name)}</b><span class="muted small">${esc(t.list || '')} · ${esc(t.status || '')}${t.due ? ` · ${when(t.due)}` : ''}${t.assignees?.length ? ` · ${esc(t.assignees.join(', '))}` : ''}</span></div>
    <div class="task-acts"><a class="btn ghost sm" href="${esc(t.url)}" target="_blank" rel="noopener">${I.open}Open</a>
    <button class="ghost sm" data-action="delegate" data-task='${esc(JSON.stringify({ title: t.name, source: 'clickup', module: 'COMP2002', due: t.due, url: t.url, description: t.description }))}'>${I.delegate}Delegate</button></div></li>`;
  const mine = tasks.filter((t) => t.mine);
  const rest = tasks.filter((t) => !t.mine);
  return `<section class="card"><h3>Yours</h3>${mine.length ? `<ul class="tasks">${mine.map(row).join('')}</ul>` : '<p class="muted">Nothing assigned to you.</p>'}</section>
    <section class="card"><h3>Team</h3>${rest.length ? `<ul class="tasks">${rest.map(row).join('')}</ul>` : '<p class="muted">No open team tasks.</p>'}</section>`;
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

// ---------------------------------------------------------------- Mail

function mailView() {
  const tabs = [['important', 'Important'], ['forum', 'Forum'], ['noise', 'Filtered']];
  const pick = { important: ['direct', 'person'], forum: ['forum'], noise: ['noise', 'secret', 'reminder', 'sent'] }[state.mailTab];
  const seg = `<div class="seg" role="tablist" aria-label="Mail">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${state.mailTab === k}" class="${state.mailTab === k ? 'on' : ''}" data-action="mailTab" data-k="${k}">${l}</button>`).join('')}</div>`;
  if (state.data.mail == null && firstLoad()) return statusNote() + seg + skeleton('list', 5);
  if (state.data.mail == null && blocked()) return statusNote() + seg + blocked();
  const items = (state.data.mail || []).filter((m) => pick.includes(m.kind));
  const none = { important: ['No important mail', 'Emails sent to you directly, and from staff, show here.'],
                 forum: ['No forum posts', 'Moodle forum questions and answers show here.'],
                 noise: ['Nothing filtered', 'Newsletters, reminders and sign-in codes are kept out of the way here (codes are never stored).'] }[state.mailTab];
  return statusNote() + seg + `<div class="pane">${items.length ? `<ul class="list">${items.map((m) => `<li>${m.path ? `<button class="li-btn" data-action="open" data-path="${esc(m.path)}" data-title="${esc(m.subject)}">` : '<div class="li-btn static">'}
      <b>${esc(m.subject)}</b><span class="muted small">${m.kind === 'direct' ? 'To you · ' : ''}${esc(m.from)} · ${dayShort(m.date)}${m.module ? ` · ${esc(m.module)}` : ''}</span>${m.path ? '</button>' : '</div>'}</li>`).join('')}</ul>`
    : empty(I.mail, none[0], none[1])}</div>`;
}

// ---------------------------------------------------------------- Settings

const EXPECT = { 'uni-sync': 13, 'lecture-sync': 13, 'mail-sync': 13, 'calendar-sync': 2, 'clickup-sync': 2, today: 2, planner: 26 };
const JOB = { 'uni-sync': 'Moodle', 'lecture-sync': 'Lectures', 'mail-sync': 'Email', 'calendar-sync': 'Calendar', 'clickup-sync': 'ClickUp', today: 'Today briefing', planner: 'Week planner' };

function settingsView() {
  const runs = state.data.runs || {};
  const health = Object.entries(EXPECT).map(([job, hours]) => {
    const r = runs[job];
    let cls = 'bad';
    let note = 'not set up yet';
    if (r) {
      const age = (Date.now() - new Date(r.last_ok || 0)) / 3600000;
      cls = r.status === 'ok' && age <= hours ? 'good' : age <= hours * 2 ? 'meh' : 'bad';
      note = `${r.status === 'ok' ? (cls === 'good' ? 'OK' : 'late') : esc(r.status)} · last good ${ago(r.last_ok)}`;
    }
    return `<li class="${cls}"><b>${JOB[job]}</b> <span class="muted small">${note}</span></li>`;
  }).join('');
  const masked = (v) => (v ? `${esc(v.slice(0, 6))}…${esc(v.slice(-4))}` : 'not set');
  const saved = localStorage.getItem('lastSync');
  return `${statusNote()}<section class="card"><h2>Keys (this device only)</h2>
    <form data-action="savekeys" class="stack">
      <label>GitHub token <span class="muted small">${masked(gh.cfg.token)}</span><input name="ghToken" type="password" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label>Gemini API key <span class="muted small">${masked(gh.cfg.geminiKey)}</span><input name="geminiKey" type="password" placeholder="Paste to replace" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label>Data repo <input name="repo" value="${gh.cfg.owner ? `${esc(gh.cfg.owner)}/${esc(gh.cfg.repo)}` : ''}" placeholder="your-username/life-data" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <button>Save</button></form></section>
    <section class="card"><h2>Run now</h2><div class="stack-btns">
      <button class="ghost" data-action="run" data-wf="uni-sync.yml" data-label="Moodle, lectures and email">${I.play}Check Moodle, lectures and email</button>
      <button class="ghost" data-action="run" data-wf="pulse.yml" data-label="Calendar, ClickUp and Today">${I.play}Refresh calendar, ClickUp and Today</button>
      <button class="ghost" data-action="replan">${I.calendar}Re-plan the week</button>
      <button class="ghost" data-action="refresh">${I.refresh}Reload data on this device</button></div>
      <p class="muted small">A run takes 1 to 5 minutes; you get a notification for anything new.</p></section>
    <section class="card"><h2>Health</h2><ul class="health">${health}</ul>
      <p class="muted small">This device last synced ${ago(saved)}. The dot at the top is green when synced, blue while syncing, grey offline, red on a problem.</p></section>`;
}

// ---------------------------------------------------------------- sheets (reader, delegate)

// A sheet is one step in the history, so Android's back button closes it.
function overlay(html, { title = '', download = '', full = false } = {}) {
  const el = document.createElement('div');
  el.className = 'overlay';
  el.innerHTML = `<div class="sheet${full ? ' full' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title || 'Details')}">
    <div class="sheet-bar"><span class="sheet-title">${esc(title)}</span>
      ${download ? `<button class="icon" data-action="download" data-name="${esc(download)}" aria-label="Download">${I.download}</button>` : ''}
      <button class="icon" data-action="close" aria-label="Close">${I.x}</button></div>
    <div class="body">${html}</div></div>`;
  document.body.append(el);
  document.body.classList.add('sheet-open');
  history.pushState({ sheet: (history.state?.sheet || 0) + 1 }, '');
  $('.sheet [data-action=close]', el).focus({ preventScroll: true });
  return { el, body: $('.body', el) };
}

function closeTop({ fromHistory = false } = {}) {
  const all = document.querySelectorAll('.overlay:not(.closing)');
  const el = all[all.length - 1];
  if (!el) return false;
  if (!fromHistory && history.state?.sheet) { history.back(); return true; } // popstate closes it
  el.classList.add('closing');
  setTimeout(() => {
    el.remove();
    if (!document.querySelector('.overlay')) document.body.classList.remove('sheet-open');
  }, reducedMotion() ? 0 : 180);
  return true;
}

window.addEventListener('popstate', () => {
  if (closeTop({ fromHistory: true })) return;
  chat.back();
});

async function openFile(path, title) {
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
function resolvePath(base, rel) {
  const parts = (base + rel).split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.') out.push(p); }
  return out.join('/');
}

async function delegateDialog(task) {
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

// ---------------------------------------------------------------- pull to refresh

const ptr = document.createElement('div');
ptr.className = 'ptr';
ptr.innerHTML = I.refresh;
ptr.setAttribute('aria-hidden', 'true');
document.body.append(ptr);
let pull = null;

async function pullRefresh() {
  ptr.classList.add('spin');
  const got = await refresh();
  ptr.classList.remove('spin', 'ready');
  ptr.style.transform = '';
  if (!got) return;
  toast(got.status === 'ok' ? (got.changed ? 'Updated' : 'Already up to date') : got.status === 'offline' ? 'Offline: showing saved data' : "Couldn't refresh");
}

window.addEventListener('touchstart', (e) => {
  if (!['today', 'uni', 'mail'].includes(state.tab) || window.scrollY > 0 || document.querySelector('.overlay') || e.touches.length !== 1) return;
  pull = { y: e.touches[0].clientY, d: 0 };
}, { passive: true });
window.addEventListener('touchmove', (e) => {
  if (!pull) return;
  const d = e.touches[0].clientY - pull.y;
  if (d < 0 || window.scrollY > 0) { pull = null; ptr.style.transform = ''; return; }
  pull.d = Math.min(d * 0.45, 96);
  ptr.style.transform = `translate(-50%, ${pull.d}px) rotate(${pull.d * 3}deg)`;
  ptr.classList.toggle('ready', pull.d > 64);
}, { passive: true });
// swipe left or right on Today's Day view to move a day
let swipe = null;
window.addEventListener('touchstart', (e) => {
  swipe = state.tab === 'today' && state.todayTab !== 'tasks' && e.touches.length === 1 && e.target.closest('.week, .agenda, .hero')
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
window.addEventListener('touchend', (e) => {
  if (!swipe) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipe.x;
  const dy = t.clientY - swipe.y;
  swipe = null;
  if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
  const today = londonDate();
  const next = addDays(state.day || today, dx < 0 ? 1 : -1);
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  if (next < monday || next > addDays(monday, 13)) return; // the calendar holds two weeks
  state.day = next === today ? null : next;
  state.week = next >= addDays(monday, 7) ? 1 : 0;
  draw();
  if (!reducedMotion()) $('.agenda')?.closest('.card')?.classList.add(dx < 0 ? 'from-right' : 'from-left');
});
window.addEventListener('touchend', () => {
  if (!pull) return;
  const go2 = pull.d > 64;
  pull = null;
  if (go2) { ptr.style.transform = 'translate(-50%, 64px)'; pullRefresh(); } else { ptr.style.transform = ''; ptr.classList.remove('ready'); }
});

// ---------------------------------------------------------------- events

async function busy(el, label, fn) {
  el.disabled = true;
  el.classList.add('working');
  const was = el.innerHTML;
  if (label) el.textContent = label;
  try { return await fn(); } finally { el.disabled = false; el.classList.remove('working'); el.innerHTML = was; }
}

async function markDone(el) {
  const { id, title } = el.dataset;
  state.hidden.add(id);
  const row = el.closest('li');
  row?.classList.add('leaving');
  setTimeout(() => draw(), reducedMotion() ? 0 : 200);
  try {
    await ai.markDone(id);
    toast(`Done: ${title}`, { action: 'Undo', onAction: async () => {
      state.hidden.delete(id);
      draw();
      try { await ai.markUndone(id); toast('Put back'); } catch (err) { toast(`Couldn't undo: ${err.message}`); }
    } });
  } catch (err) {
    state.hidden.delete(id);
    draw();
    toast(`Couldn't mark it done: ${err.message}`);
  }
}

document.addEventListener('click', async (e) => {
  // links inside rendered markdown that point at repo files (they have no data-action)
  const link = e.target.closest('a[data-path]');
  if (link && !link.dataset.action) {
    e.preventDefault();
    const base = link.closest('.body')?.dataset.base || '';
    openFile(resolvePath(base, link.dataset.path), link.textContent);
    return;
  }
  if (e.target.classList?.contains('overlay')) { closeTop(); return; } // tap outside a sheet
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'FORM' || el.tagName === 'SELECT') return;
  const a = el.dataset.action;
  if (a === 'tab') go(el.dataset.tab);
  else if (a === 'todayTab') {
    state.todayTab = el.dataset.k; localStorage.setItem('todayTab', state.todayTab);
    draw();
    if (!reducedMotion()) $('.pane')?.classList.add('enter');
    if (el.closest('.card')) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else if (a === 'pickday') {
    state.day = el.dataset.day === londonDate() ? null : el.dataset.day;
    draw();
  } else if (a === 'week') {
    state.week = Math.max(0, Math.min(1, (state.week || 0) + +el.dataset.d));
    const monday = addDays(londonDate(), -((new Date(`${londonDate()}T12:00:00Z`).getUTCDay() + 6) % 7));
    state.day = state.week ? addDays(monday, 7) : null;
    draw();
  } else if (a === 'expand') {
    const row = el.closest('.trow');
    const open = row.classList.toggle('open');
    el.setAttribute('aria-expanded', String(open));
  } else if (a === 'uniTab' || a === 'mailTab') {
    if (a === 'uniTab') { state.uniTab = el.dataset.k; localStorage.setItem('uniTab', state.uniTab); } else state.mailTab = el.dataset.k;
    draw();
    const pane = $('.pane');
    if (pane && !reducedMotion()) pane.classList.add('enter');
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  } else if (a === 'open') { e.preventDefault(); openFile(el.dataset.path, el.dataset.title); }
  else if (a === 'close') closeTop();
  else if (a === 'jump') {
    e.preventDefault();
    document.getElementById(el.dataset.id)?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  } else if (a === 'totop') el.closest('.sheet')?.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  else if (a === 'delegate') delegateDialog(JSON.parse(el.dataset.task));
  else if (a === 'refresh') {
    const got = await busy(el, el.closest('.note') ? 'Retrying…' : null, refresh);
    if (got) toast(got.status === 'ok' ? (got.changed ? 'Updated' : 'Already up to date') : got.status === 'offline' ? 'Still offline' : "Couldn't refresh");
  } else if (a === 'download') {
    const body = el.closest('.sheet').querySelector('.body');
    const blob = new Blob([body.dataset.text || body.innerText], { type: 'text/plain' });
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: el.dataset.name }).click();
    toast(`Saved ${el.dataset.name}`);
  } else if (a === 'done') {
    markDone(el);
  } else if (a === 'replan') {
    await busy(el, 'Starting…', async () => {
      try { await gh.dispatch('pulse.yml', { plan_now: 'true' }); toast('Re-planning the week. The new plan lands in a few minutes.'); }
      catch (err) { toast(err.message); }
    });
  } else if (a === 'run') {
    await busy(el, 'Starting…', async () => {
      try { await gh.dispatch(el.dataset.wf); toast(`Started: ${el.dataset.label || 'sync'}. About 1 to 5 minutes.`); }
      catch (err) { toast(err.message); }
    });
  } else if (a === 'decide') {
    const action = state.pending.find((p) => p.id === el.dataset.id);
    if (!action) return;
    const yes = el.dataset.yes === '1';
    el.closest('.pending').innerHTML = `<span class="muted">${yes ? 'Confirming…' : 'Dismissing…'}</span>`;
    try {
      await ai.decide(action, yes);
      state.pending = state.pending.filter((p) => p.id !== action.id);
      localStorage.setItem('pending', JSON.stringify(state.pending));
      toast(yes ? 'Confirmed. ClickUp updates within a couple of minutes.' : 'Dismissed. Nothing was changed.');
    } catch (err) { toast(`Couldn't send that: ${err.message}`); }
    draw();
  } else if (a === 'sync-dot') {
    const s = state.status.kind;
    const saved = localStorage.getItem('lastSync');
    toast(s === 'loading' ? 'Syncing…' : s === 'offline' ? `Offline · saved ${ago(saved)}` : s === 'ok' ? `Synced ${ago(saved)}` : 'Sync problem: see Today', { action: s === 'loading' ? null : 'Sync now', onAction: () => pullRefresh() });
  }
});

// Render a lecture transcript the first time it's opened.
document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.classList?.contains('transcript') || !d.open) return;
  const box = $('.tx', d);
  if (box && !box.dataset.done) {
    box.innerHTML = md(d.closest('.body')?.dataset.transcript || '');
    box.dataset.done = '1';
  }
}, true);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.querySelector('.overlay')) closeTop(); });

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.closest('.chatapp')) return; // the chat handles its own forms
  e.preventDefault();
  const a = form.dataset.action;
  const data = Object.fromEntries(new FormData(form));
  if (a === 'ask') {
    const q = (data.q || '').trim();
    if (!q) return;
    go('chat');
    chat.ask(q);
  } else if (a === 'savekeys') {
    if (data.ghToken) localStorage.setItem('ghToken', data.ghToken.trim());
    if (data.geminiKey) localStorage.setItem('geminiKey', data.geminiKey.trim());
    const [owner, repo] = (data.repo || '').split('/');
    if (owner && repo) { localStorage.setItem('owner', owner.trim()); localStorage.setItem('repo', repo.trim()); }
    toast('Saved. Loading your data…');
    go('today');
    refresh();
  } else if (a === 'delegate-go') {
    const task = JSON.parse(form.dataset.task);
    const progress = $('.progress', form);
    const btn = form.querySelector('button:not([type=button])');
    btn.disabled = true;
    btn.textContent = 'Starting…';
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
      closeTop();
      state.uniTab = 'jobs';
      dirs = null;
      await loadJobs();
      go('uni');
      draw();
      toast('Started. You\'ll get a notification when it\'s done.');
    } catch (err) {
      progress.textContent = `Couldn't start it: ${err.message}`;
      btn.disabled = false;
      btn.textContent = 'Start';
    }
  }
});

document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

window.addEventListener('hashchange', () => { if (readRoute()) draw({ enter: true }); });
window.addEventListener('online', () => refresh());
window.addEventListener('offline', () => { state.status = { kind: 'offline' }; setDot(); draw(); });

let lastShown = Date.now();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { lastShown = Date.now(); return; }
  if (Date.now() - lastShown > 30000) refresh(); // not on every quick app switch
  navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => {});
});

// ---------------------------------------------------------------- updates (service worker)

let asked = false;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const offer = (w) => toast('A new version is ready', { action: 'Reload', sticky: true, onAction: () => { asked = true; w.postMessage('skipWaiting'); } });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(() => {});
  // Reload only when the person tapped Reload. (A first install also fires
  // controllerchange; reloading then would load the app twice on first visit.)
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (asked) { asked = false; location.reload(); } });
}

// ---------------------------------------------------------------- start

readRoute();
fromCache();
chat.init({
  draw, refresh, tab: () => state.tab, data: () => state.data, go,
  pending: () => state.pending, pendingLoaded: () => state.pendingLoaded,
  setPending: (list) => { state.pending = list; localStorage.setItem('pending', JSON.stringify(list)); },
});
setDot(localStorage.getItem('lastSync') ? 'ok' : '');
draw();
// paint what's saved first, then sync: the screen never waits on the network
requestAnimationFrame(() => setTimeout(refresh, 0));
// keep "now" honest on Today, but never redraw under someone typing or reading a sheet
setInterval(() => {
  if (document.hidden || state.tab !== 'today' || document.querySelector('.overlay') || main.contains(document.activeElement)) return;
  draw();
}, 60000);
