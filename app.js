// Life: the organiser's app. Plain modules, no build step; GitHub Pages serves
// this folder as-is. All data lives in the private life-data repo (gh.js); the
// chat and delegated jobs use Gemini (ai.js).
//
// Every screen has four states: loading (skeletons), ready, empty (says what
// will appear and when), and a problem: offline (cached data, with when it was
// saved), or an error with Retry. Data older than expected is flagged as stale.
//
//   store.js     state and syncing with the repo     shell.js     routing and drawing
//   format.js    dates, times, module colours         parts.js     shared pieces
//   today.js · uni.js · mail.js · settings.js        the screens
//   sheets.js    reader and delegate sheets           gestures.js  pull to refresh, swipe
//   organise.js  suggestions and choices              chat.js      the chat
//
// This file wires taps, forms and keys to them, and starts the app.

import * as gh from './gh.js';
import * as ai from './ai.js';
import * as chat from './chat.js';
import { render as md } from './md.js';
import { toast, reducedMotion, haptic } from './ui.js';
import * as org from './organise.js';
import { $, state, folds, fromCache, refresh, loadJobs, savePending, setDot } from './store.js';
import { addDays, ago, londonDate, mondayOf, short } from './format.js';
import { draw, go, readRoute } from './shell.js';
import { clickupItems } from './uni.js';
import { closeTop, delegateDialog, openFile, resolvePath } from './sheets.js';
import { setupClick, setupSubmit, startSetup } from './settings.js';
import { pullRefresh } from './gestures.js';
import * as revise from './revise.js';
import * as offline from './offline.js';

const main = document.getElementById('main');

window.addEventListener('popstate', () => {
  if (closeTop({ fromHistory: true })) return;
  chat.back();
});

// ---------------------------------------------------------------- events

async function busy(el, label, fn) {
  el.disabled = true;
  el.classList.add('working');
  const was = el.innerHTML;
  if (label) el.textContent = label;
  try { return await fn(); } finally { el.disabled = false; el.classList.remove('working'); el.innerHTML = was; }
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
  if (setupClick(a)) { draw(); window.scrollTo(0, 0); return; }
  if (revise.onAction(a, el)) return;
  if (a === 'setup-done') {
    state.setup = false;
    haptic();
    go('today');
    draw();
    toast('All set. Loading your data…');
    refresh();
  } else if (a === 'setup-again') { startSetup(); draw(); window.scrollTo(0, 0); }
  else if (a === 'forget-keys') {
    toast('Remove the keys from this device?', { action: 'Remove', onAction: () => {
      ['ghToken', 'geminiKey', 'owner', 'repo', 'lastSync', 'pending', 'models'].forEach((k) => localStorage.removeItem(k));
      gh.clearCache();
      offline.clear();
      startSetup(); draw();
    } });
  } else if (a === 'tab') go(el.dataset.tab);
  else if (a === 'todayTab') {
    state.todayTab = el.dataset.k; localStorage.setItem('todayTab', state.todayTab);
    draw({ vt: true });
    if (!reducedMotion()) $('.pane')?.classList.add('enter');
    if (el.closest('.card')) window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else if (a === 'pickday') {
    state.day = el.dataset.day === londonDate() ? null : el.dataset.day;
    draw({ vt: true });
  } else if (a === 'week') {
    state.week = Math.max(0, Math.min(1, (state.week || 0) + +el.dataset.d));
    const monday = mondayOf(londonDate());
    state.day = state.week ? addDays(monday, 7) : null;
    draw({ vt: true });
  } else if (a === 'accept-item' || a === 'edit-item') {
    const item = findItem(el.dataset.key);
    if (!item) return;
    haptic();
    if (a === 'accept-item' && !reducedMotion()) el.classList.add('pop');
    org.editSheet(item);
  } else if (a === 'dismiss-item') {
    if (holdFired) { holdFired = false; return; } // a long press already opened the reason sheet
    const item = findItem(el.dataset.key);
    if (!item) return;
    haptic();
    org.dismiss(item);
    org.afterChange(item.key, 'dismissed');
    toast(`Dismissed: ${short(item.title)}`, { action: 'Undo', onAction: () => { org.restore(item); draw(); toast('Back in suggestions'); } });
  } else if (a === 'restore-item') {
    const item = findItem(el.dataset.key);
    if (!item) return;
    org.restore(item);
    org.afterChange(item.key, 'restored');
    toast('Back in suggestions');
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
      savePending();
      toast(yes ? 'Confirmed. ClickUp updates within a couple of minutes.' : 'Dismissed. Nothing was changed.');
    } catch (err) { toast(`Couldn't send that: ${err.message}`); }
    draw();
  } else if (a === 'sync-dot') {
    const s = state.status.kind;
    const saved = localStorage.getItem('lastSync');
    toast(s === 'loading' ? 'Syncing…' : s === 'offline' ? `Offline · saved ${ago(saved)}` : s === 'ok' ? `Synced ${ago(saved)}` : 'Sync problem: see Today', { action: s === 'loading' ? null : 'Sync now', onAction: () => pullRefresh() });
  }
});



function findItem(key) {
  return org.items(clickupItems()).find((r) => r.key === key);
}

let holdFired = false;
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-action=dismiss-item]');
  if (!el) return;
  holdFired = false;
  org.holdStart(el, () => { holdFired = true; haptic('hold'); const item = findItem(el.dataset.key); if (item) org.dismissSheet(item); });
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => document.addEventListener(t, (e) => {
  if (e.type === 'pointerleave' && !e.target.closest?.('[data-action=dismiss-item]')) return;
  org.holdCancel();
}, true));
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.sact')) e.preventDefault(); }); // long press = hold, not a menu
document.addEventListener('keydown', (e) => { // keyboard: Shift+Enter on ✕ asks for a reason
  const el = e.target.closest?.('[data-action=dismiss-item]');
  if (el && e.key === 'Enter' && e.shiftKey) { e.preventDefault(); const item = findItem(el.dataset.key); if (item) org.dismissSheet(item); }
});

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.dataset?.fold) return;
  if (d.open) folds.add(d.dataset.fold); else folds.delete(d.dataset.fold);
  try { localStorage.setItem('folds', JSON.stringify([...folds])); } catch { /* fine */ }
}, true);

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

// Arrow keys move between tabs in a tab row (week days, Day/Tasks, Uni, Mail).
document.addEventListener('keydown', (e) => {
  const tab = e.target.closest?.('[role=tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = [...tab.closest('[role=tablist]').querySelectorAll('[role=tab]:not([disabled])')];
  const i = tabs.indexOf(tab);
  const next = tabs[e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
  e.preventDefault();
  next.focus();
  next.click(); // the redraw keeps focus on this tab (shell.js)
});

document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.closest('.chatapp')) return; // the chat handles its own forms
  e.preventDefault();
  const a = form.dataset.action;
  const data = Object.fromEntries(new FormData(form));
  if (a === 'setup-step') { await setupSubmit(form, data, () => draw()); window.scrollTo(0, 0); return; }
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
      await loadJobs({ fresh: true });
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
  setPending: (list) => { state.pending = list; savePending(); },
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
