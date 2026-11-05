// Dates, times and module colours: one way of showing each, everywhere.

import { esc } from './md.js';
import { state } from './store.js';

export const TZ = 'Europe/London';
// Intl formatters are slow to create, so each format is made once and reused
// (Today formats hundreds of dates to draw the week strip).
const formatters = new Map();
export function formatter(locale, opts) {
  const key = locale + JSON.stringify(opts);
  if (!formatters.has(key)) formatters.set(key, new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts }));
  return formatters.get(key);
}
export const fmt = (iso, opts) => (iso ? formatter('en-GB', opts).format(new Date(iso)) : '');
export const time = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit' });
export const dayShort = (iso) => fmt(iso, { weekday: 'short', day: 'numeric', month: 'short' });
export const londonDate = (d = new Date()) => formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const when = (iso) => `${dayShort(iso)}, ${time(iso)}`;

export function until(iso) {
  const ms = new Date(iso) - Date.now();
  const h = Math.round(ms / 3600000);
  if (ms < 0) return h > -24 ? `${Math.max(1, -h)}h ago` : `${Math.round(-h / 24)} day${Math.round(-h / 24) === 1 ? '' : 's'} ago`;
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60000))} min`;
  if (h < 36) return `in ${h}h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'tomorrow' : `in ${d} days`;
}

export function ago(iso) {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  const d = Math.round(m / 1440);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const dayCache = new Map();
// The London date (YYYY-MM-DD) of a time; a plain date passes through.
export const dayOf = (iso) => {
  if (!iso || iso.length <= 10) return iso;
  if (!dayCache.has(iso)) dayCache.set(iso, londonDate(new Date(iso)));
  return dayCache.get(iso);
};
export const addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const mondayOf = (date) => addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
export const shortRoom = (loc) => {
  const rooms = (loc || '').split(',').map((r) => r.trim().replace(/^JC (Computer Science|Business School)\s*/i, '')).filter(Boolean);
  return rooms.length > 1 ? `${rooms[0]} +${rooms.length - 1}` : rooms[0] || '';
};
export const short = (t, n = 40) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

// ---------------------------------------------------------------- modules: one colour each

const norm = (s) => (s || '').toLowerCase().replace(/&amp;|&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

// The module code for an event or item: its own field, or a timetable title
// ("Operating Systems AND Concurrency - Lecture") matched to a course name.
export function moduleOf(e) {
  if (e.module) return e.module;
  const title = norm((e.title || '').split(' - ')[0]);
  if (!title) return null;
  const hit = (state.data.courses || []).find((c) => norm(c.name.replace(/\s*\(.*$/, '')) === title);
  return hit ? hit.code : null;
}

export function modIndex(code) {
  const codes = (state.data.courses || []).map((c) => c.code).sort();
  const i = codes.indexOf(code);
  return (i < 0 ? [...code].reduce((a, ch) => a + ch.charCodeAt(0), 0) : i) % 6;
}

export const chip = (code) => (code ? `<span class="chip m${modIndex(code)}">${esc(code.replace(/^COMP/, ''))}</span>` : '');
export const rail = (code) => (code ? ` m${modIndex(code)}` : '');
