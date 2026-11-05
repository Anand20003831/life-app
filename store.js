// What the app knows, and keeping it in step with the life-data repo.
//
// Every screen draws from `state`. refresh() reads the repo's files (sending any
// choices made offline first), and redraws only if something changed, so an
// unchanged background refresh costs no layout and nothing on screen moves.

import * as gh from './gh.js';
import * as org from './organise.js';
import { ago } from './format.js';
import { draw } from './shell.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export const state = {
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
};

// <details data-fold> sections left open, remembered on this device
export const folds = new Set((() => { try { return JSON.parse(localStorage.getItem('folds') || '[]'); } catch { return []; } })());

export const FILES = {
  today: 'today.json', deadlines: 'uni/deadlines.json', lectures: 'uni/lectures.json',
  courses: 'uni/courses.json', mail: 'uni/email/index.json', clickup: 'schedule/clickup.json',
  runs: 'state/runs.json', health: 'state/health.json', todos: 'schedule/todos.json', calendar: 'schedule/calendar.json',
  plan: 'schedule/plan.json', skipped: 'schedule/skipped.json', suggestions: 'schedule/suggestions.json',
  decisions: 'schedule/decisions.json', ntk: 'uni/email/items.json',
};

export function fromCache() {
  for (const [k, path] of Object.entries(FILES)) state.data[k] = gh.cachedJSON(path, state.data[k] ?? null);
  try { state.pending = JSON.parse(localStorage.getItem('pending') || '[]'); } catch { state.pending = []; }
}

export function classify(err) {
  if (!navigator.onLine || err instanceof TypeError || /GitHub 5\d\d/.test(err.message)) return 'offline';
  if (/token|can't see|public repo|can read but not write/i.test(err.message)) return 'auth';
  return 'error';
}

export const firstLoad = () => state.status.kind === 'loading' && !localStorage.getItem('lastSync');

let syncing = null;
export async function refresh() {
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
      await org.flush(); // choices made offline go first, so what's read back includes them
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
let dirs = null;
async function inboxDirs() {
  const items = await gh.list('inbox');
  return new Set(items.filter((i) => i.type === 'dir').map((i) => i.name));
}

async function loadPending() {
  dirs = await inboxDirs();
  const files = dirs.has('actions') ? (await gh.list('inbox/actions')).filter((f) => f.name.endsWith('.json')) : [];
  const all = await Promise.all(files.map((f) => gh.readJSON(f.path, null)));
  state.pending = all.filter((a) => a && a.status === 'proposed');
  state.pendingLoaded = true;
  savePending();
}

export function savePending() {
  try { localStorage.setItem('pending', JSON.stringify(state.pending)); } catch { /* storage full: kept in memory */ }
}

export async function loadJobs({ fresh = false } = {}) {
  if (fresh || !dirs) dirs = await inboxDirs();
  const [queued, done] = await Promise.all(['delegate', 'delegate-done'].map((d) => (dirs.has(d) ? gh.list(`inbox/${d}`) : [])));
  const read = (list) => Promise.all(list.filter((f) => f.name.endsWith('.json')).map((f) => gh.readJSON(f.path, null)));
  state.jobs = [...await read(queued), ...await read(done)].filter(Boolean)
    .sort((a, b) => (b.created || '').localeCompare(a.created || ''));
}

// The dot in the header: green synced, blue syncing, grey offline, red a problem.
export function setDot(kind) {
  const dot = $('#sync');
  const k = kind || { ok: 'ok', loading: 'syncing', offline: 'offline', error: 'error', auth: 'error' }[state.status.kind] || '';
  dot.className = `sync ${k}`;
  const saved = localStorage.getItem('lastSync');
  dot.setAttribute('aria-label', { ok: `Synced ${ago(saved)}`, syncing: 'Syncing…', offline: `Offline · saved ${ago(saved)}`, error: 'Sync problem' }[k] || 'Sync status');
}
