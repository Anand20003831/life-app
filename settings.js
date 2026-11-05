// Settings: health first (is everything working, and what to do if not), then
// Run now, then this device's keys. First run on a new device is a short
// walk-through (onboarding) instead.

import * as gh from './gh.js';
import { esc } from './md.js';
import { I } from './icons.js';
import { state } from './store.js';
import { ago } from './format.js';
import { empty, statusNote } from './parts.js';

const EXPECT = { 'uni-sync': 13, 'lecture-sync': 13, 'mail-sync': 13, 'calendar-sync': 2, 'clickup-sync': 2, today: 2, planner: 26 };
const JOB = { 'uni-sync': 'Moodle', 'lecture-sync': 'Lectures', 'mail-sync': 'Email', 'calendar-sync': 'Calendar', 'clickup-sync': 'ClickUp', today: 'Today briefing', planner: 'Week planner' };

export function settingsView() {
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

export function setupView() {
  return empty(I.sparkle, 'Set up this device', 'This app reads your private <code>life-data</code> repo and talks to Gemini. It needs the repo name and two keys, stored only on this device.',
    `<button data-action="tab" data-tab="settings">Open Settings</button>`);
}
