// Touch: pull down to refresh, swipe Today's day view to move a day.

import { I } from './icons.js';
import { toast, reducedMotion } from './ui.js';
import { $, state, refresh } from './store.js';
import { addDays, londonDate, mondayOf } from './format.js';
import { draw } from './shell.js';

const ptr = document.createElement('div');
ptr.className = 'ptr';
ptr.innerHTML = I.refresh;
ptr.setAttribute('aria-hidden', 'true');
document.body.append(ptr);
let pull = null;

export async function pullRefresh() {
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
  const monday = mondayOf(today);
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
