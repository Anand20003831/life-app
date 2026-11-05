// Suggestions, decisions and "need to know".
//
// The cloud decides what is a real deadline (Moodle assignments and quizzes,
// ClickUp key dates) and writes everything else with a date to
// schedule/suggestions.json. Here you accept (tick, then an edit sheet), dismiss
// (tap; press and hold to give a reason), edit or restore them. Choices are kept
// in schedule/decisions.json, which only this app writes, keyed by item, so
// saving the same choice twice changes nothing.
//
// Offline first: a choice shows at once and waits in an outbox (localStorage)
// until GitHub can be reached; then decisions.json is updated and the matching
// actions are queued for the cloud (inbox/actions: life_sync for the Life
// calendar, clickup_update / clickup_comment only when you asked for them).

import * as gh from './gh.js';

let ui = {};   // helpers from app.js: esc, chip, when, until, dayShort, I, toast, overlay, closeTop, draw, data, reducedMotion
export function init(hooks) { ui = hooks; }

// ---------------------------------------------------------------- decisions + outbox

const DECISIONS = 'schedule/decisions.json';
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
let outbox = read('outbox', []);
const saveOutbox = () => { try { localStorage.setItem('outbox', JSON.stringify(outbox)); } catch { /* full */ } };

export const pending = () => outbox.length;

// Decisions as the screen should show them: the repo's, then anything not sent yet.
export function decisions() {
  const out = { ...(ui.data().decisions || {}) };
  for (const op of outbox) {
    if (op.op !== 'decision') continue;
    if (op.value) out[op.key] = op.value; else delete out[op.key];
  }
  return out;
}

const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const nowIso = () => new Date().toISOString();

function queue(op) {
  if (op.op === 'action' && op.action.type === 'life_sync') outbox = outbox.filter((o) => !(o.op === 'action' && o.action.type === 'life_sync'));
  outbox.push(op);
  saveOutbox();
}

function setDecision(key, value) {
  queue({ op: 'decision', key, value });
}

function action(type, payload, summary, id) {
  queue({ op: 'action', action: { id: id || `${type}-${Date.now().toString(36)}`, type, status: 'confirmed', created: nowIso(), summary, payload } });
}

let flushing = null;
// Sends the outbox. Decisions go in one read-modify-write; actions are files with
// stable ids, so a retry rewrites the same file instead of adding another.
export async function flush() {
  if (flushing || !outbox.length || !gh.configured()) return flushing;
  flushing = (async () => {
    const batch = outbox.slice();
    try {
      const decs = batch.filter((o) => o.op === 'decision');
      if (decs.length) {
        await gh.update(DECISIONS, (cur) => {
          const next = { ...(cur || {}) };
          for (const o of decs) { if (o.value) next[o.key] = o.value; else delete next[o.key]; }
          return next;
        }, {}, 'app: decisions');
      }
      for (const o of batch.filter((x) => x.op === 'action')) {
        await gh.write(`inbox/actions/${o.action.id}.json`, JSON.stringify(o.action, null, 1) + '\n', `app: ${o.action.type}`);
      }
      outbox = outbox.filter((o) => !batch.includes(o));
      saveOutbox();
      // the repo copy is now current
      const merged = { ...(ui.data().decisions || {}) };
      for (const o of decs) { if (o.value) merged[o.key] = o.value; else delete merged[o.key]; }
      ui.data().decisions = merged;
      return true;
    } catch (err) {
      return false; // stays in the outbox; tried again on the next refresh or when back online
    } finally { flushing = null; }
  })();
  return flushing;
}

// ---------------------------------------------------------------- what each item is now

const sameTime = (a, b) => (!a && !b) || (a && b && +new Date(a) === +new Date(b));

// Same rule as sync/tasks.py: a dismissed ClickUp task comes back if the team
// moves its date or reassigns it.
export function cameBack(item, dec) {
  if (item.source !== 'clickup' || dec?.state !== 'dismissed') return null;
  const snap = dec.snapshot || {};
  if (!sameTime(snap.due, item.due)) return item.due ? `the team moved it to ${ui.dayShort(item.due)}` : 'the team removed its date';
  if ([...(snap.assignees || [])].sort().join() !== [...(item.assignees || [])].sort().join()) return 'it was reassigned';
  return null;
}

const MISSED_MS = 3 * 864e5;
// Suggestions with the latest decisions applied (the cloud's state, overlaid with
// anything decided on this device since).
export function items(extra = []) {
  const decs = decisions();
  const base = [...(ui.data().suggestions?.items || []), ...extra];
  const seen = new Set();
  return base.filter((r) => !seen.has(r.key) && seen.add(r.key)).map((r) => {
    const dec = decs[r.key];
    let state = 'open';
    let returned = null;
    if (dec) {
      returned = cameBack(r, dec);
      state = returned ? 'open' : dec.state;
    }
    const missed = state === 'open' && r.due && new Date(r.due) < Date.now() - MISSED_MS;
    return { ...r, state, group: state === 'open' ? (missed ? 'missed' : 'suggested') : state, decision: dec || null,
             returned: returned ? { why: returned, reason: dec?.reason } : null };
  });
}

// ---------------------------------------------------------------- choices

function snapshot(item) {
  return { title: item.title, due: item.due || null, assignees: item.assignees || [] };
}

export function dismiss(item, { reason = '', comment = false } = {}) {
  const was = decisions()[item.key];
  setDecision(item.key, { state: 'dismissed', at: nowIso(), ...(reason ? { reason } : {}), ...(comment ? { comment: true } : {}), snapshot: snapshot(item) });
  if (comment && reason && item.task_id) {
    action('clickup_comment', { task_id: item.task_id, text: reason }, `Comment on ${item.title}: "${reason}"`, `cm-${item.task_id}-${hash(reason)}`);
  }
  if (was?.state === 'accepted') action('life_sync', {}, 'Update the Life calendar');
  if (reason === 'Already done' && (item.source === 'todo' || item.source === 'checkpoint')) ui.markDone?.(item.id);
  flush();
}

export function accept(item, edit) {
  const prev = decisions()[item.key];
  setDecision(item.key, { state: 'accepted', at: nowIso(), snapshot: snapshot(item), edit });
  action('life_sync', {}, 'Update the Life calendar');
  const cu = clickupChange(item, edit, prev?.edit);
  if (cu) action('clickup_update', cu.payload, `ClickUp: ${cu.lines.join('; ')}`, `cu-${item.task_id}-${hash(JSON.stringify(cu.payload))}`);
  flush();
}

export function restore(item) {
  const was = decisions()[item.key];
  setDecision(item.key, null);
  if (was?.state === 'accepted') action('life_sync', {}, 'Update the Life calendar');
  flush();
}

// What a save would change on ClickUp, if anything (only when "ClickUp" is ticked).
function clickupChange(item, edit, before) {
  if (!item.task_id || !edit.to.includes('clickup')) return null;
  const lines = [];
  const payload = { task_id: item.task_id };
  const was = before?.to?.includes('clickup') ? before : { title: item.title, start: item.due };
  if (!sameTime(was.start, edit.start)) { payload.due = edit.start; lines.push(`due ${was.start ? ui.when(was.start) : 'none'} → ${ui.when(edit.start)}`); }
  if ((was.title || '') !== edit.title) { payload.name = edit.title; lines.push(`name "${was.title}" → "${edit.title}"`); }
  return lines.length ? { payload, lines } : null;
}

// ---------------------------------------------------------------- rows

const LABEL = { clickup: 'ClickUp', todo: 'To-do', checkpoint: 'Checkpoint', plan: 'Plan', accepted: 'Accepted' };

export function row(r) {
  const { esc, chip, when, until, I } = ui;
  const meta = [LABEL[r.source] || r.source, r.due ? when(r.due) : null, r.for ? `for ${r.for}` : null].filter(Boolean).join(' · ');
  const late = r.due && new Date(r.due) < Date.now();
  if (r.state === 'accepted') {
    const e = r.decision?.edit || {};
    const where = (e.to || []).map((t) => (t === 'calendar' ? 'Life calendar' : 'ClickUp')).join(' + ');
    return `<li class="srow accepted" data-key="${esc(r.key)}"><button class="srow-main" data-action="edit-item" data-key="${esc(r.key)}">
      <span class="trow-title">${esc(e.title || r.title)}</span>
      <span class="trow-meta"><span class="ok">${I.check}</span><span>${e.start ? esc(when(e.start)) : ''}${e.minutes ? ` · ${e.minutes} min` : ''}</span><span class="muted">· ${esc(where || 'kept here')}</span></span></button>
      <span class="srow-go">${I.chevR}</span></li>`;
  }
  if (r.state === 'dismissed') {
    return `<li class="srow dismissed" data-key="${esc(r.key)}"><div class="srow-main static">
      <span class="trow-title">${esc(r.title)}</span>
      <span class="trow-meta"><span class="reason">${r.decision?.reason ? esc(r.decision.reason) : 'Dismissed'}</span>${r.decision?.comment ? '<span class="muted">· posted on ClickUp</span>' : ''}</span></div>
      <button class="ghost sm" data-action="restore-item" data-key="${esc(r.key)}">Restore</button></li>`;
  }
  return `<li class="srow" data-key="${esc(r.key)}">
    <div class="srow-main static">
      <span class="trow-title">${esc(r.title)}</span>
      <span class="trow-meta">${chip(r.module)}<span class="when${late ? ' soon' : ''}">${r.due ? until(r.due) : ''}</span><span class="muted">· ${esc(meta)}</span>${r.url ? `<a class="src" href="${esc(r.url)}" target="_blank" rel="noopener">ClickUp</a>` : ''}</span>
      ${r.returned ? `<span class="returned">${I.retry}Back: ${esc(r.returned.why)}${r.returned.reason ? ` (you said: ${esc(r.returned.reason)})` : ''}</span>` : ''}
    </div>
    <div class="srow-acts">
      <button class="sact no" data-action="dismiss-item" data-key="${esc(r.key)}" aria-label="Dismiss ${esc(r.title)}. Press and hold to give a reason">${I.x}<svg class="hold-ring" viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="20"/></svg></button>
      <button class="sact yes" data-action="accept-item" data-key="${esc(r.key)}" aria-label="Accept ${esc(r.title)}">${I.check}</button>
    </div></li>`;
}

export function section(title, rows, { cls = '', note = '', collapsed = false, fold = '' } = {}) {
  if (!rows.length) return '';
  const body = `<ul class="srows">${rows.map(row).join('')}</ul>`;
  if (collapsed) {
    return `<details class="card tight fold ${cls}"${fold ? ` data-fold="${fold}"` : ''}><summary><h3>${title} <span class="count">${rows.length}</span></h3><span class="chev">${ui.I.chevD}</span></summary>${body}</details>`;
  }
  return `<section class="card tight ${cls}"><h3>${title} <span class="count">${rows.length}</span></h3>${note ? `<p class="muted small sec-note">${note}</p>` : ''}${body}</section>`;
}

// ---------------------------------------------------------------- sheets

const pad = (n) => String(n).padStart(2, '0');
function localParts(iso) {
  const d = new Date(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
// A London wall-clock date + time as an ISO instant (handles BST/GMT).
function londonIso(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const back = localParts(guess.toISOString());
  const diff = (new Date(`${back.date}T${back.time}:00Z`) - guess) / 60000;
  return new Date(guess - diff * 60000).toISOString();
}

// Where an accepted item starts by default: a plan block keeps its time; a ClickUp
// date-only task (04:00) or anything already past starts at 18:00; otherwise it
// ends at its due time.
function defaultStart(item, minutes) {
  if (item.start) return item.start;
  const now = Date.now();
  if (!item.due || new Date(item.due) < now) {
    const t = localParts(new Date(now + 864e5).toISOString());
    return londonIso(t.date, '18:00');
  }
  const p = localParts(item.due);
  if (p.time === '04:00') return londonIso(p.date, '18:00');
  return new Date(new Date(item.due) - minutes * 60000).toISOString();
}

export function editSheet(item) {
  const { esc, overlay, I } = ui;
  const prev = item.decision?.state === 'accepted' ? item.decision.edit : null;
  const minutes = prev?.minutes || item.minutes || 60;
  const start = prev?.start || defaultStart(item, minutes);
  const p = localParts(start);
  const to = prev?.to || ['calendar'];
  const lens = [15, 30, 45, 60, 90, 120, 180, 240];
  const ov = overlay(`<form class="stack edit-form" data-key="${esc(item.key)}">
      <label>Title <input name="title" value="${esc(prev?.title || item.title)}" required maxlength="140"></label>
      <div class="row three"><label>Date <input name="date" type="date" value="${p.date}" required></label>
        <label>Time <input name="time" type="time" value="${p.time}" required></label>
        <label>Length <select name="minutes">${lens.map((m) => `<option value="${m}" ${m === +minutes ? 'selected' : ''}>${m < 60 ? `${m} min` : `${m / 60} h`}</option>`).join('')}</select></label></div>
      <fieldset class="where"><legend>Where it goes</legend>
        <label class="check"><input type="checkbox" name="calendar" ${to.includes('calendar') ? 'checked' : ''}><span>Life calendar</span></label>
        <label class="check${item.task_id ? '' : ' off'}"><input type="checkbox" name="clickup" ${item.task_id ? '' : 'disabled'} ${to.includes('clickup') ? 'checked' : ''}><span>ClickUp${item.task_id ? '' : ' (only for ClickUp tasks)'}</span></label>
      </fieldset>
      <div class="changes" aria-live="polite"></div>
      <div class="row end">${item.source === 'todo' || item.source === 'checkpoint' ? '<button type="button" class="ghost" data-act="done">Mark as done</button>' : ''}
        ${prev ? '<button type="button" class="ghost" data-act="unaccept">Back to suggestions</button>' : ''}
        <button class="save">${prev ? 'Save changes' : 'Accept'}</button></div>
    </form>`, { title: prev ? 'Edit' : 'Accept' });
  const form = ov.el.querySelector('form');
  const read2 = () => {
    const f = new FormData(form);
    return { title: String(f.get('title') || '').trim(), start: londonIso(f.get('date'), f.get('time')), minutes: +f.get('minutes'),
             to: [f.get('calendar') ? 'calendar' : null, f.get('clickup') ? 'clickup' : null].filter(Boolean) };
  };
  // exactly what saving will do, before it's done
  const preview = () => {
    const e = read2();
    const lines = [];
    const end = new Date(new Date(e.start).getTime() + e.minutes * 60000).toISOString();
    const span = `${ui.when(e.start)}–${ui.time(end)}`;
    const onCal = prev?.to?.includes('calendar');
    if (e.to.includes('calendar')) lines.push(onCal ? (sameTime(prev.start, e.start) && prev.minutes === e.minutes && prev.title === e.title ? `Life calendar: no change` : `Life calendar: update to "${e.title}", ${span}`) : `Life calendar: add "${e.title}", ${span}`);
    else if (onCal) lines.push('Life calendar: remove it');
    const cu = clickupChange(item, e, prev);
    if (cu) lines.push(...cu.lines.map((l) => `ClickUp (the team sees this): ${l}`));
    else if (e.to.includes('clickup')) lines.push('ClickUp: no change');
    if (!e.to.length) lines.push('Kept in the app only: nothing goes to a calendar.');
    form.querySelector('.changes').innerHTML = `<h4>What will change</h4><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
  };
  form.addEventListener('input', preview);
  form.addEventListener('change', preview);
  preview();
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const e = read2();
    accept(item, e);
    ui.closeTop();
    ui.afterChange(item.key, 'accepted');
    ui.toast(prev ? 'Saved' : `Accepted: ${e.title.length > 40 ? `${e.title.slice(0, 39)}…` : e.title}`);
  });
  form.querySelector('[data-act=done]')?.addEventListener('click', () => {
    ui.closeTop();
    ui.markDone?.(item.id);
    setDecision(item.key, { state: 'dismissed', at: nowIso(), reason: 'Done', snapshot: snapshot(item) });
    flush();
    ui.afterChange(item.key, 'done');
    ui.toast(`Done: ${item.title.length > 40 ? `${item.title.slice(0, 39)}…` : item.title}`);
  });
  form.querySelector('[data-act=unaccept]')?.addEventListener('click', () => {
    ui.closeTop();
    restore(item);
    ui.afterChange(item.key, 'restored');
    ui.toast('Back in suggestions');
  });
  return ov;
}

const REASONS = ['Someone else is doing it', 'Not needed', 'Do later', 'Already done'];

export function dismissSheet(item) {
  const { esc, overlay } = ui;
  const ov = overlay(`<form class="stack dismiss-form">
      <p class="lead"><b>${esc(item.title)}</b></p>
      <div class="chips" role="group" aria-label="Quick reasons">${REASONS.map((r) => `<button type="button" class="chipbtn" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      <label>Reason <input name="reason" placeholder="e.g. someone else on the team has it" maxlength="200" autocomplete="off"></label>
      ${item.task_id ? `<label class="check"><input type="checkbox" name="comment"><span>Also post this reason as a comment on the ClickUp task<span class="muted small"> · the team will see it</span></span></label>` : ''}
      <div class="row end"><button type="button" class="ghost" data-act="cancel">Cancel</button><button>Dismiss</button></div>
    </form>`, { title: 'Dismiss with a reason' });
  const form = ov.el.querySelector('form');
  form.querySelectorAll('.chipbtn').forEach((b) => b.addEventListener('click', () => {
    form.elements.reason.value = b.dataset.reason;
    form.querySelectorAll('.chipbtn').forEach((x) => x.classList.toggle('on', x === b));
  }));
  form.querySelector('[data-act=cancel]').addEventListener('click', () => ui.closeTop());
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const reason = String(form.elements.reason.value || '').trim();
    const comment = !!form.elements.comment?.checked && !!reason;
    dismiss(item, { reason, comment });
    ui.closeTop();
    ui.afterChange(item.key, 'dismissed');
    ui.toast(comment ? 'Dismissed. Your reason will be posted on ClickUp.' : 'Dismissed');
  });
  setTimeout(() => form.elements.reason.focus({ preventScroll: true }), 50);
  return ov;
}

// ---------------------------------------------------------------- press and hold to dismiss

const HOLD_MS = 500;
let hold = null;
export function holdStart(el, onHold) {
  holdCancel();
  el.classList.add('holding');
  hold = { el, fired: false, t: setTimeout(() => { hold.fired = true; el.classList.remove('holding'); navigator.vibrate?.(15); onHold(); }, HOLD_MS) };
}
export function holdCancel() {
  if (!hold) return false;
  clearTimeout(hold.t);
  hold.el.classList.remove('holding');
  const fired = hold.fired;
  hold = null;
  return fired;
}

// ---------------------------------------------------------------- need to know (Mail)

const KIND_ICON = { deadline_moved: 'calendar', deadline_new: 'calendar', room_change: 'pin', time_change: 'clock', cancelled: 'x',
  online_only: 'offline', requirement: 'alert', reply_needed: 'mail', signup: 'edit', info: 'sparkle', reminder: 'clock' };

export function needToKnow(itemsList) {
  const { esc, chip, dayShort, I } = ui;
  const rank = (i) => (i.status === 'changed' ? 1 : 0) + (i.importance || 1);
  const live = itemsList.filter((i) => i.status !== 'known').sort((a, b) => rank(b) - rank(a) || b.email_date.localeCompare(a.email_date));
  const known = itemsList.filter((i) => i.status === 'known');
  const li = (i) => `<li class="ntk k-${esc(i.kind)}"><span class="ntk-icon">${I[KIND_ICON[i.kind]] || I.mail}</span>
    <div class="ntk-body"><p>${esc(i.text)}</p>
      <span class="ntk-meta">${i.status !== 'known' ? `<span class="pill ${i.status}">${i.status === 'changed' ? 'Changed' : 'New'}</span>` : ''}${chip(i.module)}
      <span>${dayShort(i.email_date)}</span>
      ${i.path ? `<button class="link src" data-action="open" data-path="${esc(i.path)}" data-title="${esc(i.subject || 'Email')}">Email</button>`
        : i.link ? `<a class="src" href="${esc(i.link)}" target="_blank" rel="noopener">Email</a>` : ''}</span></div></li>`;
  return `<section class="card tight ntk-card"><h3>Need to know <span class="count">${live.length}</span></h3>
      ${live.length ? `<ul class="ntks">${live.map(li).join('')}</ul>`
        : '<p class="muted">Nothing new to act on. Moved deadlines, room changes, cancellations and things to reply to or sign up for show up here.</p>'}
      ${known.length ? `<details class="fold-inline"><summary>Already known <span class="count">${known.length}</span><span class="chev">${I.chevD}</span></summary><ul class="ntks quiet">${known.slice(0, 30).map(li).join('')}</ul></details>` : ''}
    </section>`;
}
