// Settings: Health first (is everything working, and if not, what to do), then
// Run now, Notifications, and this device's keys. A new device gets a short
// walk-through instead (onboarding), one step per thing it needs.

import * as gh from './gh.js';
import * as ai from './ai.js';
import { esc } from './md.js';
import { I } from './icons.js';
import { state } from './store.js';
import { ago } from './format.js';
import { statusNote } from './parts.js';
import * as org from './organise.js';

// ---------------------------------------------------------------- health

// Each job, what it's called here, and how long it may go without running
// (hours while you're awake / overnight, when the hourly jobs sleep).
const JOBS = [
  ['uni-sync', 'Moodle', 15, 15], ['lecture-sync', 'Lectures', 15, 15], ['mail-sync', 'Uni email', 15, 15],
  ['calendar-sync', 'Calendar', 2, 9.5], ['clickup-sync', 'ClickUp', 2, 9.5], ['today', 'Today', 2, 9.5],
  ['life-calendar', 'Life calendar', 2, 9.5], ['planner', 'Week planner', 26, 26],
];

const DOT = { ok: 'good', warn: 'meh', fail: 'bad' };

function jobRows() {
  const runs = state.data.runs || {};
  const hour = +new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }).format(new Date());
  const awake = hour >= 8;
  return JOBS.map(([key, label, day, night]) => {
    const r = runs[key];
    if (!r || !r.last_attempt) return { label, cls: 'meh', line: "Hasn't run yet", fix: 'It runs on its own schedule; nothing to do unless this stays for a day.' };
    const late = (Date.now() - new Date(r.last_attempt)) / 36e5 > (awake ? day : night);
    if (r.status && r.status !== 'ok') {
      return { label, cls: 'bad', line: r.problem || `Last run failed (${r.status})`, fix: r.fix || 'Ask Claude to look at the Actions log.' };
    }
    if (late) return { label, cls: 'meh', line: `Last ran ${ago(r.last_attempt)}: late`, fix: 'GitHub sometimes skips a scheduled run. Use Run now below if it lasts.' };
    return { label, cls: 'good', line: `OK · ${ago(r.last_ok || r.last_attempt)}` };
  });
}

function row({ label, cls, line, fix }) {
  return `<li class="${cls}"><span class="hdot" aria-hidden="true"></span><span class="h-text"><b>${esc(label)}</b>
    <span class="h-line">${esc(line)}</span>${fix && cls !== 'good' ? `<span class="h-fix">${esc(fix)}</span>` : ''}</span>
    <span class="sr-only">${{ good: 'working', meh: 'needs a look', bad: 'not working' }[cls]}</span></li>`;
}

// Anything that needs a look stays open, with what to do; what works folds into one line.
function group(items, noun, fold) {
  const ok = items.filter((x) => x.cls === 'good');
  const rest = items.filter((x) => x.cls !== 'good');
  return `${rest.length ? `<ul class="health">${rest.map(row).join('')}</ul>` : ''}
    ${ok.length ? `<details class="fold-inline health-ok" data-fold="${fold}"><summary><span class="hdot ok" aria-hidden="true"></span>${ok.length === items.length ? `All ${ok.length} ${noun} working` : `${ok.length} more working`}<span class="chev">${I.chevD}</span></summary>
      <ul class="health">${ok.map(row).join('')}</ul></details>` : ''}`;
}

function healthCard() {
  const h = state.data.health;
  const checks = (h?.checks || []).filter((c) => c.id !== 'schedule').map((c) => ({ label: c.label, cls: DOT[c.state] || 'meh', line: c.detail, fix: c.fix }));
  const jobs = jobRows();
  const bad = [...checks, ...jobs].filter((x) => x.cls === 'bad').length;
  const meh = [...checks, ...jobs].filter((x) => x.cls === 'meh').length;
  const verdict = bad ? `${bad} thing${bad > 1 ? 's' : ''} need${bad > 1 ? '' : 's'} you` : meh ? 'Working, with something to keep an eye on' : 'Everything is working';
  return `<section class="card health-card"><h2>Health</h2>
    <p class="verdict ${bad ? 'bad' : meh ? 'meh' : 'good'}">${bad ? I.alert : I.check}<span>${verdict}</span></p>
    <h3 class="sub">Connections <span class="muted small">${h ? `checked ${ago(h.checked)}` : 'not checked yet'}</span></h3>
    ${checks.length ? group(checks, 'connections', 'health-ok-connections')
    : '<p class="muted small">The daily self-test checks Moodle, Echo360, Gmail, Google Calendar, ClickUp, Gemini and notifications for real, without changing anything. It runs at about 05:30, or now:</p>'}
    <button class="ghost sm" data-action="run" data-wf="selftest.yml" data-label="Self-test">${I.retry}Check now</button>
    <h3 class="sub">Jobs</h3>${group(jobs, 'jobs', 'health-ok-jobs')}
    ${deviceLine()}</section>`;
}

function deviceLine() {
  const saved = localStorage.getItem('lastSync');
  const queued = org.pending();
  return `<p class="muted small">This device synced ${ago(saved)}${queued ? `; ${queued} change${queued > 1 ? 's' : ''} waiting to send` : ''}.
    The dot at the top is green when synced, blue while syncing, grey offline and red when something's wrong.</p>`;
}

// ---------------------------------------------------------------- the page

export function settingsView() {
  const masked = (v) => (v ? `${esc(v.slice(0, 4))}…${esc(v.slice(-4))}` : 'not set');
  return `${statusNote()}${healthCard()}
    <section class="card"><h2>Run now</h2><div class="stack-btns">
      <button class="ghost" data-action="run" data-wf="uni-sync.yml" data-label="Moodle, lectures and email">${I.play}Check Moodle, lectures and email</button>
      <button class="ghost" data-action="run" data-wf="pulse.yml" data-label="Calendar, ClickUp and Today">${I.play}Refresh calendar, ClickUp and Today</button>
      <button class="ghost" data-action="replan">${I.calendar}Re-plan the week</button>
      <button class="ghost" data-action="refresh">${I.refresh}Reload data on this device</button></div>
      <p class="muted small">A run takes 1 to 5 minutes. You get a notification only if something new turns up.</p></section>
    <section class="card"><h2>Notifications</h2>
      <p class="small">They come through the free <b>ntfy</b> app, on your private topic. You hear about new deadlines and moved ones,
        what a uni email means for you (only when something is new or has changed), timetable changes, ClickUp tasks given to you,
        new lectures, finished jobs, the morning plan, and anything here that stops working.</p>
      <p class="muted small">Not getting them? Open ntfy and check you're subscribed to your topic. The topic is in
        docs/CREDENTIALS.md on your PC; it works like a password, so keep it to yourself.</p></section>
    <section class="card"><h2>This device</h2>
      <details class="fold-inline keys"><summary>Keys <span class="muted small">GitHub ${masked(gh.cfg.token)} · Gemini ${masked(gh.cfg.geminiKey)}</span><span class="chev">${I.chevD}</span></summary>
      <form data-action="savekeys" class="stack">
        <label>GitHub token <input name="ghToken" type="password" placeholder="Paste a new one to replace it" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label>Gemini API key <input name="geminiKey" type="password" placeholder="Paste a new one to replace it" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        <label>Data repo <input name="repo" value="${gh.cfg.owner ? `${esc(gh.cfg.owner)}/${esc(gh.cfg.repo)}` : ''}" placeholder="your-username/life-data" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <button>Save</button></form></details>
      <div class="row wrap"><button class="ghost sm" data-action="setup-again">Set up again</button>
        <button class="ghost sm danger" data-action="forget-keys">Remove keys from this device</button></div>
      <p class="muted small">Keys stay on this device and are only ever sent to GitHub and Google's Gemini. <a href="privacy.html">Privacy</a></p></section>`;
}

// ---------------------------------------------------------------- onboarding

// One step per thing a new device needs. Each key is checked for real before
// moving on, so a typo shows up here and not as a mystery later.
const STEPS = ['welcome', 'repo', 'github', 'gemini', 'notify'];
let step = 0;
let note = { kind: '', text: '' };

export function startSetup() { step = 0; note = { kind: '', text: '' }; state.setup = true; }

function stepper() {
  return `<ol class="steps" aria-label="Step ${step + 1} of ${STEPS.length}">${STEPS.map((_, i) =>
    `<li class="${i < step ? 'done' : i === step ? 'on' : ''}" aria-hidden="true"></li>`).join('')}</ol>`;
}

function result() {
  return `<p class="setup-note ${note.kind}" role="status" aria-live="polite">${note.text ? `${note.kind === 'bad' ? I.alert : note.kind === 'good' ? I.check : ''}<span>${esc(note.text)}</span>` : ''}</p>`;
}

// Setting up again on a device that already has a key: no need to paste it again.
const keep = (k) => (localStorage.getItem(k) ? '<button type="button" class="ghost" data-action="setup-next">Keep current key</button>' : '');

export function setupView() {
  const back = step ? '<button type="button" class="ghost" data-action="setup-back">Back</button>' : '';
  const body = {
    welcome: `<h1>Set up this device</h1>
      <p>Life reads your private <b>life-data</b> repo on GitHub and uses Gemini for the chat. This takes about two minutes:</p>
      <ol class="plain-steps"><li>Your data repo's name</li><li>A GitHub key that can open only that repo</li><li>A Gemini key</li><li>Notifications (optional)</li></ol>
      <p class="muted small">The keys are kept on this device only.</p>
      <div class="row end"><button data-action="setup-next">Start</button></div>`,
    repo: `<h1>Your data repo</h1>
      <p>The private repo that holds your data, as <b>owner/name</b>. It's <b>not</b> life-app (that one is public and holds only this app).</p>
      <form class="stack" data-action="setup-step" data-step="repo">
        <label>Data repo <input name="repo" required value="${esc(localStorage.getItem('owner') ? `${localStorage.getItem('owner')}/${localStorage.getItem('repo') || 'life-data'}` : '')}" placeholder="your-username/life-data" autocapitalize="off" autocorrect="off" spellcheck="false" autocomplete="off"></label>
        ${result()}<div class="row end">${back}<button>Next</button></div></form>`,
    github: `<h1>GitHub key</h1>
      <p>Make a fine-grained token that can open only your data repo:</p>
      <ol class="plain-steps small"><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub → new fine-grained token</a>.</li>
        <li>Name it after this device (e.g. <i>life-phone</i>), so you can revoke one device alone. Expiry: a year.</li>
        <li>Repository access: <b>Only select repositories</b> → your data repo.</li>
        <li>Permissions: <b>Contents: Read and write</b> and <b>Actions: Read and write</b>. Nothing else.</li>
        <li>Generate, copy, and paste it here.</li></ol>
      <form class="stack" data-action="setup-step" data-step="github">
        <label>GitHub token <input name="token" type="password" ${localStorage.getItem('ghToken') ? '' : 'required'} placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        ${result()}<div class="row end">${back}${keep('ghToken')}<button>Check and continue</button></div></form>`,
    gemini: `<h1>Gemini key</h1>
      <p>The chat and "Tell it something" use Google's Gemini. The free tier is enough.</p>
      <ol class="plain-steps small"><li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio → API keys</a>.</li>
        <li>Create a key (or copy the one you already use) and paste it here.</li></ol>
      <form class="stack" data-action="setup-step" data-step="gemini">
        <label>Gemini API key <input name="key" type="password" ${localStorage.getItem('geminiKey') ? '' : 'required'} placeholder="AIza…" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
        ${result()}<div class="row end">${back}${keep('geminiKey')}<button>Check and continue</button></div></form>`,
    notify: `<h1>Notifications</h1>
      <p>Pushes arrive through the free <b>ntfy</b> app, not the browser, so they work even when this app is closed.</p>
      <ol class="plain-steps small"><li>Install <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noopener">ntfy from Google Play</a> (or the App Store).</li>
        <li>Tap <b>+</b> and subscribe to your private topic. It's in docs/CREDENTIALS.md on your PC. Treat it like a password.</li>
        <li>Optional: add this app to your home screen from the browser menu, so it opens full screen.</li></ol>
      ${result()}<div class="row end">${back}<button data-action="setup-done">Finish</button></div>`,
  }[STEPS[step]];
  return `<div class="setup">${stepper()}${body}</div>`;
}

// Taps on the setup screens. Returns true if it handled the tap.
export function setupClick(a) {
  if (a === 'setup-next') { step = Math.min(step + 1, STEPS.length - 1); note = { kind: '', text: '' }; return true; }
  if (a === 'setup-back') { step = Math.max(step - 1, 0); note = { kind: '', text: '' }; return true; }
  return false;
}

// A setup form was sent: check what was typed, then move on. Returns true when finished.
export async function setupSubmit(form, data, repaint) {
  const which = form.dataset.step;
  const btn = form.querySelector('button:not([type=button])');
  const say = (kind, text) => { note = { kind, text }; repaint(); };
  if (which === 'repo') {
    const m = (data.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '').match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) return say('bad', 'That should look like your-username/life-data.');
    localStorage.setItem('owner', m[1]);
    localStorage.setItem('repo', m[2]);
    step += 1; note = { kind: '', text: '' }; repaint();
    return;
  }
  if (which === 'github') {
    const token = (data.token || '').trim();
    if (!token) return say('bad', 'Paste a token first, or keep the current one.');
    const was = localStorage.getItem('ghToken');
    localStorage.setItem('ghToken', token);
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      await gh.checkAccess();
      step += 1; note = { kind: 'good', text: 'GitHub key works: it can read and write your data repo.' }; repaint();
    } catch (err) {
      if (was) localStorage.setItem('ghToken', was); else localStorage.removeItem('ghToken');
      say('bad', !navigator.onLine ? "You're offline. Connect, then try again."
        : err.message.replace(' and paste it in Settings', ' and paste it here').replace('Fix the Data repo field in Settings.', 'Go back and fix the repo name.'));
    }
    return;
  }
  if (which === 'gemini') {
    const key = (data.key || '').trim();
    if (!key) return say('bad', 'Paste a key first, or keep the current one.');
    const was = localStorage.getItem('geminiKey');
    localStorage.setItem('geminiKey', key);
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      const list = await ai.models({ fresh: true });
      step += 1; note = { kind: 'good', text: `Gemini key works: ${list.length} models available.` }; repaint();
    } catch (err) {
      if (was) localStorage.setItem('geminiKey', was); else localStorage.removeItem('geminiKey');
      say('bad', !navigator.onLine ? "You're offline. Connect, then try again." : `Gemini didn't accept that key (${err.message}).`);
    }
  }
}
