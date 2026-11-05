// Small shared UI pieces: the toast (one line of feedback, optional action such
// as Undo), and helpers for motion that respect prefers-reduced-motion.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// A short buzz on tick, dismiss and hold, where the phone supports it (Android;
// iOS Safari has no vibration API, so it's simply silent there).
export function haptic(kind = 'tap') {
  try { if (navigator.vibrate && !reducedMotion()) navigator.vibrate(kind === 'hold' ? [10, 40, 10] : 8); } catch { /* not allowed: fine */ }
}

let box = null;
let timer = 0;

// toast('Done: Lab 3', { action: 'Undo', onAction, ms }): a new toast replaces the old one.
export function toast(text, { action, onAction, ms = 4000, sticky = false } = {}) {
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  clearTimeout(timer);
  box.innerHTML = `<span>${esc(text)}</span>${action ? `<button type="button" class="toast-act">${esc(action)}</button>` : ''}`;
  box.classList.add('show');
  if (action) {
    box.querySelector('.toast-act').onclick = () => { hide(); onAction?.(); };
  }
  if (!sticky) timer = setTimeout(hide, action ? Math.max(ms, 6000) : ms);
}

export function hide() {
  clearTimeout(timer);
  box?.classList.remove('show');
}
