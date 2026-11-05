// Revise: the review questions from the lecture notes, a few a day, spaced out.
//
// The cloud collects every answered question into uni/questions.json (a question
// without an answer is never included). Progress is uni/revision.json, which only
// this app writes: {"v": 1, "cards": {id: {box, due, first, last, reps, lapses}},
// "sessions": [{at, module, n, again, hard, good}]}.
//
// Spaced repetition: Good moves a card up a box (1, 3, 7, 16, then 35 days), Hard
// repeats its box's interval halved, Again brings it back today (and once more at
// the end of this session). At most NEW_PER_DAY new questions a day. The cloud's
// sync/revision.py counts "due today" the same way, for the planner's suggestion.
//
// Offline first: a grade is kept on the device at once (localStorage outbox) and
// sent when GitHub can be reached; per question, the newest grade wins.

import * as gh from './gh.js';
import { render as md, esc } from './md.js';
import { I } from './icons.js';
import { haptic } from './ui.js';
import { state } from './store.js';
import { addDays, chip, dayShort, londonDate } from './format.js';
import { empty } from './parts.js';
import { draw } from './shell.js';

const FILE = 'uni/revision.json';
export const INTERVALS = [1, 3, 7, 16, 35];
export const NEW_PER_DAY = 10;

// ---------------------------------------------------------------- progress + outbox

const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
let outbox = read('revOutbox', { cards: {}, sessions: [] });
const saveOutbox = () => { try { localStorage.setItem('revOutbox', JSON.stringify(outbox)); } catch { /* full: kept in memory */ } };

export const pending = () => Object.keys(outbox.cards).length + outbox.sessions.length;

function mergeInto(base, extra) {
  const cards = { ...(base?.cards || {}) };
  for (const [id, c] of Object.entries(extra.cards || {})) {
    if (!cards[id] || (cards[id].last || '') <= (c.last || '')) cards[id] = c;
  }
  const seen = new Set((base?.sessions || []).map((s) => s.at));
  const sessions = [...(base?.sessions || []), ...(extra.sessions || []).filter((s) => !seen.has(s.at))].slice(-100);
  return { v: 1, cards, sessions };
}

// What the screen shows: the repo's progress with this device's unsent grades on top.
export const progress = () => mergeInto(state.data.revision, outbox);

let flushing = null;
export async function flush() {
  if (flushing || !pending() || !gh.configured()) return flushing;
  flushing = (async () => {
    const batch = JSON.parse(JSON.stringify(outbox));
    try {
      let saved = null;
      await gh.update(FILE, (cur) => { saved = mergeInto(cur, batch); return saved; }, { v: 1, cards: {}, sessions: [] }, 'app: revision');
      for (const [id, c] of Object.entries(batch.cards)) if (outbox.cards[id]?.last === c.last) delete outbox.cards[id];
      outbox.sessions = outbox.sessions.filter((s) => !batch.sessions.some((b) => b.at === s.at));
      saveOutbox();
      if (saved) state.data.revision = saved;
      return true;
    } catch {
      return false; // stays in the outbox; tried again on the next refresh
    } finally { flushing = null; }
  })();
  return flushing;
}

// ---------------------------------------------------------------- the rule

// Questions with both a question and an answer (anything else is skipped, never shown broken).
export const questions = () => (state.data.questions?.questions || []).filter((q) => q && q.id && String(q.q || '').trim() && String(q.a || '').trim());

export function grade(card, g, today = londonDate()) {
  const c = { box: -1, reps: 0, lapses: 0, first: today, ...(card || {}) };
  if (g === 'again') { c.box = -1; c.lapses += 1; c.due = today; }
  else if (g === 'hard') { c.box = Math.max(0, c.box); c.due = addDays(today, Math.max(1, Math.round(INTERVALS[c.box] / 2))); }
  else { c.box = Math.min(c.box + 1, INTERVALS.length - 1); c.due = addDays(today, INTERVALS[c.box]); }
  c.reps += 1;
  c.last = new Date().toISOString();
  return c;
}

// The questions to ask today, reviews first (oldest due first), then new ones
// (oldest lecture first), new ones capped per day across all modules.
export function dueList(module = '', day = londonDate()) {
  const { cards } = progress();
  const qs = questions().filter((q) => !module || q.module === module);
  const reviews = qs.filter((q) => cards[q.id] && (cards[q.id].due || day) <= day)
    .sort((a, b) => cards[a.id].due.localeCompare(cards[b.id].due));
  const started = Object.values(cards).filter((c) => c.first === day).length;
  const fresh = qs.filter((q) => !cards[q.id]).slice(0, Math.max(0, NEW_PER_DAY - started));
  return [...reviews, ...fresh];
}

export const dueCount = (module = '') => dueList(module).length;

// ---------------------------------------------------------------- the session

let filter = read('reviseModule', '');
let session = null; // {module, queue: [id], i, shown, tally, again: Set, done, at}

const byId = () => new Map(questions().map((q) => [q.id, q]));
const days = (n) => (n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
const gap = (from, to) => Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 864e5);

function start() {
  const queue = dueList(filter).map((q) => q.id);
  if (!queue.length) return;
  session = { module: filter, queue, i: 0, shown: false, tally: { again: 0, hard: 0, good: 0 }, again: new Set(), done: false, at: new Date().toISOString() };
}

function answer(g) {
  if (!session || session.done || !session.shown) return;
  const id = session.queue[session.i];
  const today = londonDate();
  outbox.cards[id] = grade(progress().cards[id], g, today);
  session.tally[g] += 1;
  if (g === 'again' && !session.again.has(id)) { session.again.add(id); session.queue.push(id); } // once more, at the end
  session.i += 1;
  session.shown = false;
  if (session.i >= session.queue.length) {
    session.done = true;
    const { again, hard, good } = session.tally;
    outbox.sessions.push({ at: session.at, module: session.module || 'all', n: again + hard + good, again, hard, good });
    flush();
  }
  saveOutbox();
}

// Taps on the Revise screen. Returns true when it handled one.
export function onAction(a, el) {
  if (!a.startsWith('rv-')) return false;
  if (a === 'rv-module') { filter = el.dataset.k || ''; try { localStorage.setItem('reviseModule', JSON.stringify(filter)); } catch { /* fine */ } }
  else if (a === 'rv-start') { start(); haptic(); }
  else if (a === 'rv-show') { if (session) session.shown = true; }
  else if (a === 'rv-grade') { answer(el.dataset.g); haptic(); }
  else if (a === 'rv-stop') {
    if (session && !session.done && session.i > 0) {
      const { again, hard, good } = session.tally;
      outbox.sessions.push({ at: session.at, module: session.module || 'all', n: again + hard + good, again, hard, good });
      saveOutbox();
      flush();
    }
    session = null;
  } else if (a === 'rv-home') session = null;
  draw();
  // keyboard users land on the next thing to press
  requestAnimationFrame(() => document.querySelector('.rv-show, .rv-grade [data-g=good], .rv-done [data-action=rv-home], [data-action=rv-start]')?.focus({ preventScroll: true }));
  return true;
}

// Space or Enter shows the answer; 1, 2, 3 grade it (Again, Hard, Good).
document.addEventListener('keydown', (e) => {
  if (!session || session.done || state.tab !== 'uni' || state.uniTab !== 'revise' || document.querySelector('.overlay')) return;
  if (e.target.closest?.('input, textarea, select')) return;
  const map = { 1: 'again', 2: 'hard', 3: 'good' };
  if (!session.shown && (e.key === ' ' || (e.key === 'Enter' && !e.target.closest?.('button, a')))) {
    e.preventDefault(); onAction('rv-show', e.target);
  } else if (session.shown && map[e.key]) {
    e.preventDefault(); onAction('rv-grade', { dataset: { g: map[e.key] } });
  }
});

// ---------------------------------------------------------------- the screen

export function view() {
  const all = questions();
  if (!all.length) {
    return empty(I.book, 'No review questions yet', 'They come from the Review questions at the end of each lecture\'s study notes. Older notes are being rewritten a few at each sync, and their questions appear here as they are.');
  }
  if (session && session.done) return summary();
  if (session) return card();
  return home(all);
}

function home(all) {
  const { cards } = progress();
  const modules = [...new Set(all.map((q) => q.module))].sort();
  if (filter && !modules.includes(filter)) filter = '';
  const due = dueCount(filter);
  const scoped = all.filter((q) => !filter || q.module === filter);
  const lectures = new Set(scoped.map((q) => q.path)).size;
  const learnt = scoped.filter((q) => (cards[q.id]?.box ?? -1) >= 1).length;
  const tomorrow = dueList(filter, addDays(londonDate(), 1)).length;
  const last = [...(progress().sessions || [])].reverse()[0];
  const chips = [['', 'All', dueCount('')], ...modules.map((m) => [m, m.replace(/^COMP/, ''), dueCount(m)])];
  return `<section class="card rv-home">
    <div class="rv-due" aria-live="polite"><span class="rv-n">${due}</span><span>${due === 1 ? 'question' : 'questions'} due today${filter ? ` in ${esc(filter)}` : ''}</span></div>
    <div class="rv-filter" role="group" aria-label="Module">${chips.map(([k, label, n]) =>
      `<button class="chipbtn${k === filter ? ' on' : ''}" data-action="rv-module" data-k="${esc(k)}" aria-pressed="${k === filter}">${esc(label)} <span class="count">${n}</span></button>`).join('')}</div>
    ${due ? `<button class="rv-go" data-action="rv-start">${I.play}Start (${due})</button>`
      : `<p class="rv-clear">${I.check}<span>All done for today.${tomorrow ? ` Tomorrow: ${tomorrow}.` : ''}</span></p>`}
    <p class="muted small">${scoped.length} question${scoped.length === 1 ? '' : 's'} from ${lectures} lecture${lectures === 1 ? '' : 's'} · ${learnt} learnt · up to ${NEW_PER_DAY} new a day</p>
    ${last ? `<p class="muted small">Last session ${dayShort(last.at)}: ${last.n} question${last.n === 1 ? '' : 's'}, ${last.good} good, ${last.hard} hard, ${last.again} again.</p>` : ''}
  </section>
  <p class="muted small rv-note">Questions come from each lecture's study notes. Older notes are being rewritten a few at each sync; their questions join as they're done.</p>`;
}

function card() {
  const q = byId().get(session.queue[session.i]);
  if (!q) { session.i += 1; if (session.i >= session.queue.length) session.done = true; return session.done ? summary() : card(); }
  const { cards } = progress();
  const c = cards[q.id];
  const total = session.queue.length;
  const today = londonDate();
  const hint = (g) => days(gap(today, grade(c, g, today).due));
  return `<section class="card rv-card" aria-label="Question ${session.i + 1} of ${total}">
    <div class="rv-top"><span class="muted small">${session.i + 1} of ${total}</span>
      <span class="rv-bar" aria-hidden="true"><i style="width:${Math.round((session.i / total) * 100)}%"></i></span>
      <button class="link" data-action="rv-stop">End</button></div>
    <p class="rv-meta">${chip(q.module)}<button class="link" data-action="open" data-path="${esc(q.path)}" data-title="${esc(q.lecture)}">${esc(q.lecture)} · ${esc(dayShort(q.date))}</button>${c ? '' : '<span class="tag plain">New</span>'}</p>
    <div class="rv-q md">${md(q.q)}</div>
    ${session.shown ? `<div class="rv-a md"><span class="eyebrow">Answer</span>${md(q.a)}</div>
      <div class="rv-grade" role="group" aria-label="How did you do?">
        <button class="ghost" data-action="rv-grade" data-g="again" aria-label="Again: see it again ${hint('again')}">Again<small>${hint('again')}</small></button>
        <button class="ghost" data-action="rv-grade" data-g="hard" aria-label="Hard: next in ${hint('hard')}">Hard<small>${hint('hard')}</small></button>
        <button data-action="rv-grade" data-g="good" aria-label="Good: next in ${hint('good')}">Good<small>${hint('good')}</small></button></div>`
    : '<button class="rv-show" data-action="rv-show">Show answer</button>'}
  </section>`;
}

function summary() {
  const { again, hard, good } = session.tally;
  const n = again + hard + good;
  const tomorrow = dueList(session.module, addDays(londonDate(), 1)).length;
  return `<section class="card rv-done"><h2>${I.check}Session done</h2>
    <p>${n} question${n === 1 ? '' : 's'}: <b>${good}</b> good, <b>${hard}</b> hard, <b>${again}</b> again.</p>
    <p class="muted">${tomorrow ? `Tomorrow: ${tomorrow} due${session.module ? ` in ${esc(session.module)}` : ''}.` : 'Nothing due tomorrow.'}${again ? ' The ones you got wrong come back first.' : ''}</p>
    <button data-action="rv-home">Back to Revise</button></section>`;
}
