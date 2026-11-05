// The shell: which screen is showing, the address (#today, #uni/lectures, …;
// notifications link to these), and drawing the screen.

import * as gh from './gh.js';
import * as chat from './chat.js';
import { reducedMotion } from './ui.js';
import { $, state, folds } from './store.js';
import { todayView } from './today.js';
import { uniView } from './uni.js';
import { mailView } from './mail.js';
import { settingsView, setupView } from './settings.js';

const main = document.getElementById('main');
const scrolls = {};

// #today, #uni/lectures, #mail/forum, #chat, #settings (notifications link here)
export function readRoute() {
  const [tab, sub] = location.hash.slice(1).split('/');
  if (!['today', 'uni', 'mail', 'chat', 'settings'].includes(tab)) return false;
  state.tab = tab;
  if (tab === 'uni' && ['deadlines', 'lectures', 'group', 'modules', 'jobs'].includes(sub)) state.uniTab = sub;
  if (tab === 'today' && ['day', 'tasks'].includes(sub)) state.todayTab = sub;
  if (tab === 'mail' && ['important', 'forum', 'noise'].includes(sub)) state.mailTab = sub;
  return true;
}

function writeRoute() {
  const sub = state.tab === 'uni' ? `/${state.uniTab}` : state.tab === 'mail' ? `/${state.mailTab}` : state.tab === 'today' && state.todayTab === 'tasks' ? '/tasks' : '';
  history.replaceState(history.state, '', `#${state.tab}${sub}`);
}

export function go(tab) {
  if (tab === state.tab) { window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }
  scrolls[state.tab] = window.scrollY;
  state.tab = tab;
  localStorage.setItem('tab', tab);
  draw({ enter: true });
  window.scrollTo(0, scrolls[tab] || 0);
}

const drawn = { tab: '', html: '' };
// vt: animate the change with a View Transition (the selected day and the Day/Tasks
// pill glide to their new place); falls back to a plain redraw.
export function draw({ enter = false, vt = false } = {}) {
  if (vt && document.startViewTransition && !reducedMotion() && !document.hidden) {
    document.startViewTransition(() => paint({ enter: false, stagger: true }));
    return;
  }
  paint({ enter, stagger: enter });
}

function paint({ enter = false, stagger = false } = {}) {
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
  main.querySelectorAll('details[data-fold]').forEach((d) => { d.open = folds.has(d.dataset.fold); });
  if (stagger && !reducedMotion()) { main.classList.remove('stagger'); void main.offsetWidth; main.classList.add('stagger'); }
  if (enter && !reducedMotion()) { main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter'); }
  if (state.tab === 'chat') chat.mounted(); else chat.unmounted();
}
