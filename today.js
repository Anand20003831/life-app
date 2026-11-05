// Today: glanceable first. A week strip, then Day (now/next, focus, what needs
// you, the agenda) or Tasks (deadlines, missed, suggestions, accepted). Details
// are one tap away, not on the first screen.

import { esc } from './md.js';
import { I } from './icons.js';
import * as org from './organise.js';
import { state } from './store.js';
import { addDays, ago, chip, dayOf, fmt, londonDate, mondayOf, moduleOf, rail, shortRoom, time, until } from './format.js';
import { blocked, empty, firstLoad, skeleton, statusNote, taskCard, taskRow } from './parts.js';

const KIND = { change: I.alert, focus: I.sparkle, heads_up: I.clock, people: I.users, admin: I.edit };

// Today is built hourly (07:00-23:00). Older than 3 hours while awake means a run was missed.
function staleNote(t) {
  const hours = (Date.now() - new Date(t.generated)) / 36e5;
  const hourNow = +fmt(new Date().toISOString(), { hour: '2-digit', hour12: false });
  if (hours < 3 || hourNow < 9) return '';
  return `<div class="note warn" role="status">${I.clock}<span>Today was built ${ago(t.generated)}; the hourly update may be late.</span>
    <button class="link" data-action="run" data-wf="pulse.yml" data-label="Today">Update now</button></div>`;
}

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
  const decided = org.decisions();
  for (const b of blocks) {
    if (dayOf(b.start) !== date) continue;
    const key = `plan:${dayOf(b.start)}:${(b.title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)}`;
    if (decided[key]) continue; // accepted ones show at the chosen time; dismissed ones not at all
    rows.push({ ...b, kind: `plan ${b.kind || ''}`, plan: true, suggested: true, key });
  }
  for (const o of t.overrides || []) if (!o.cancelled && dayOf(o.start) === date) rows.push({ ...o, kind: 'override' });
  rows.push(...acceptedOn(date));
  return rows.sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || new Date(a.start) - new Date(b.start));
}

// What's due on a day (Moodle, ClickUp key dates, to-dos), for the strip's dots and the agenda.
function dueOn(date) {
  const t = state.data.today || {};
  const seen = new Set();
  return [...(t.due || []).filter((d) => d.kind !== 'accepted'), ...(state.data.deadlines || []).filter((d) => ['assign', 'quiz', undefined].includes(d.kind))]
    .filter((d) => d.due && dayOf(d.due) === date && !seen.has(d.title) && seen.add(d.title));
}

// Things he accepted, at the time he chose (this device's latest choices included).
function acceptedOn(date) {
  return org.items().filter((r) => r.state === 'accepted' && r.decision?.edit?.start && dayOf(r.decision.edit.start) === date)
    .map((r) => { const e = r.decision.edit; return { title: e.title, start: e.start, end: new Date(new Date(e.start).getTime() + (e.minutes || 60) * 60000).toISOString(), kind: 'accepted', key: r.key }; });
}

const TILE = { class: I.book, personal: I.calendar, override: I.edit, plan: I.sparkle, gym: I.play, due: I.clock, accepted: I.check };
function tileFor(r) {
  if (r.kind.startsWith('plan')) return /gym/i.test(r.kind + r.title) ? I.play : I.sparkle;
  if (r.kind === 'class' && /group|project/i.test(r.title)) return I.users;
  return TILE[r.kind] || I.calendar;
}

function weekStrip(sel) {
  const today = londonDate();
  const monday = mondayOf(today);
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
        ${d === sel ? '<span class="sel-bg" aria-hidden="true"></span>' : ''}<span class="dw">${dt.toLocaleDateString('en-GB', { weekday: 'narrow', timeZone: 'UTC' })}</span><span class="dn">${dt.getUTCDate()}</span>
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

// Real deadlines (Moodle, ClickUp key dates), soonest first.
export function realDeadlines() {
  return ((state.data.today || {}).due || []).filter((d) => d.kind !== 'accepted');
}


function tasksPane() {
  const all = org.items();
  const by = (g) => all.filter((r) => r.group === g);
  const body = taskCard('Deadlines', realDeadlines())
    + org.section('Missed: still doing this?', by('missed'), { cls: 'warn', note: 'More than 3 days past their date. Tick to plan it again, or dismiss it.' })
    + org.section('Suggestions', by('suggested'), { note: 'Not in your calendar until you tick one. Tap ✕ to dismiss; hold it to give a reason.' })
    + org.section('Accepted', by('accepted'))
    + org.section('Dismissed', by('dismissed'), { collapsed: true, fold: 'dismissed' });
  return body || empty(I.check, 'All clear', 'No deadlines in the next 7 days and nothing waiting for a decision.');
}

function pendingCard() {
  return `<section class="card confirm"><h3>Waiting for your OK</h3>${state.pending.map((a) => `<div class="pending">
    <span>${esc(a.summary)}</span><div class="row"><button data-action="decide" data-yes="1" data-id="${a.id}">Confirm</button>
    <button class="ghost" data-action="decide" data-yes="0" data-id="${a.id}">Dismiss</button></div></div>`).join('')}</section>`;
}

export function todayView() {
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
  const sugg = org.items();
  const open = sugg.filter((r) => r.group === 'missed' || r.group === 'suggested');
  const tasks = [...realDeadlines(), ...open];
  const urgent = sugg.some((r) => r.group === 'missed') || realDeadlines().some((d) => new Date(d.due) - Date.now() < 2 * 864e5);
  parts.push(`<div class="seg pill" role="tablist" aria-label="Today">
    <button role="tab" aria-selected="${state.todayTab !== 'tasks'}" class="${state.todayTab !== 'tasks' ? 'on' : ''}" data-action="todayTab" data-k="day">${state.todayTab !== 'tasks' ? '<span class="pill-bg" aria-hidden="true"></span>' : ''}<span class="lbl">Day</span></button>
    <button role="tab" aria-selected="${state.todayTab === 'tasks'}" class="${state.todayTab === 'tasks' ? 'on' : ''}" data-action="todayTab" data-k="tasks">${state.todayTab === 'tasks' ? '<span class="pill-bg" aria-hidden="true"></span>' : ''}<span class="lbl">Tasks</span>${tasks.length ? ` <span class="badge${urgent ? ' hot' : ''}">${tasks.length}</span>` : ''}</button></div>`);
  if (state.pending.length) parts.push(pendingCard());

  if (state.todayTab === 'tasks') return parts.join('') + `<div class="pane">${tasksPane()}</div>`;

  const rows = agenda(sel);
  const due = dueOn(sel);
  const now = Date.now();
  const day = [weekStrip(sel)];
  if (isToday) {
    day.push(heroCard(rows), focusCard(t));
    // real deadlines in the next 48 hours, then suggestions due soon (with tick / dismiss)
    const soonD = realDeadlines().filter((d) => new Date(d.due) - now < 2 * 864e5);
    const soonS = open.filter((r) => r.group === 'suggested' && r.source !== 'plan' && r.due && new Date(r.due) - now < 2 * 864e5);
    const missedN = sugg.filter((r) => r.group === 'missed').length;
    const take = Math.max(0, 3 - soonD.length);
    if (soonD.length || soonS.length || missedN) {
      day.push(`<section class="card tight"><h3>Needs you <button class="link" data-action="todayTab" data-k="tasks">All tasks (${tasks.length})</button></h3>
        ${soonD.length ? `<ul class="trows">${soonD.slice(0, 3).map(taskRow).join('')}</ul>` : ''}
        ${soonS.length && take ? `<ul class="srows">${soonS.slice(0, take).map(org.row).join('')}</ul>` : ''}
        ${missedN ? `<button class="missed-link" data-action="todayTab" data-k="tasks">${I.clock}<span>${missedN} missed: still doing ${missedN > 1 ? 'these' : 'this'}?</span>${I.chevR}</button>` : ''}</section>`);
    }
  }
  // on today, only deadlines still ahead (the missed ones are in Needs you / Tasks)
  const dueRows = due.filter((d) => !isToday || new Date(d.due) > now).map((d) => ({ start: d.due, title: d.title, kind: 'due', mod: d.module, dueItem: true }));
  const list = [...rows, ...dueRows].sort((a, b) => (a.allDay ? -1 : 0) - (b.allDay ? -1 : 0) || new Date(a.start) - new Date(b.start));
  const label = isToday ? 'Schedule' : new Date(`${sel}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  day.push(`<section class="card tight"><h3>${label}</h3>${list.length ? `<ol class="agenda">${list.map((r) => {
    const live = isToday && !r.allDay && !r.dueItem && new Date(r.start) <= now && now < new Date(r.end || r.start);
    const past = isToday && !r.allDay && new Date(r.end || r.start) < now;
    const sub = r.dueItem ? 'Due' : r.kind === 'accepted' ? 'Accepted' : r.suggested ? 'Suggested · not in your calendar' : [r.location ? shortRoom(r.location) : '', r.note ? `changed: ${r.note}` : ''].filter(Boolean).join(' · ');
    return `<li class="ag ${r.kind}${r.suggested ? ' suggested' : ''}${rail(r.mod)}${live ? ' live' : ''}${past ? ' past' : ''}">
      <time>${r.allDay ? 'all day' : time(r.start)}${r.end && !r.allDay && !r.dueItem && dayOf(r.end) === dayOf(r.start) ? `<span>${time(r.end)}</span>` : ''}</time>
      <span class="tile">${r.dueItem ? I.clock : tileFor(r)}</span>
      <span class="ag-text"><b>${esc(r.title)}</b><span class="ag-meta">${chip(r.mod)}${sub ? `<span>${esc(sub)}</span>` : ''}${live ? '<span class="now">now</span>' : ''}</span>
      ${r.first_step && !past ? `<span class="ag-step">Start with: ${esc(r.first_step)}</span>` : ''}</span></li>`;
  }).join('')}</ol>` : `<p class="muted">${isToday ? 'Nothing else on today.' : 'Nothing on this day.'}</p>`}</section>`);
  day.push(`<form class="ask" data-action="ask"><input name="q" placeholder="Tell it something…" autocomplete="off" aria-label="Tell the organiser something">
    <button class="round" aria-label="Send to chat">${I.send}</button></form>`);
  return parts.join('') + `<div class="pane">${day.join('')}</div>`;
}
