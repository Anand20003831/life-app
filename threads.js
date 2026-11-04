// Chats, stored in the private data repo so every device sees the same ones:
//   chat/threads/index.json   [{id, title, created, updated, pinned, preview, count}]
//   chat/threads/<id>.json    {id, title, ..., summary, history, shown}
// history is Gemini's own shape (thought signatures kept, file data stripped);
// shown is what the screen draws. The readable monthly archive
// (chat/<YYYY-MM>.json) is still appended to by the app.

import * as gh from './gh.js';
import { forStorage } from './ai.js';

const DIR = 'chat/threads';
const INDEX = `${DIR}/index.json`;

export function blank(model, effort) {
  const now = new Date().toISOString();
  return { v: 1, id: gh.id(), title: 'New chat', titled: false, created: now, updated: now, pinned: false,
           model, effort, summary: '', history: [], shown: [] };
}

export const cachedIndex = () => gh.cachedJSON(INDEX, []) || [];

export async function index() {
  return (await gh.readJSON(INDEX, [])) || [];
}

export async function load(id) {
  const t = await gh.readJSON(`${DIR}/${id}.json`, null).catch(() => gh.cachedJSON(`${DIR}/${id}.json`, null));
  return t;
}

export const cached = (id) => gh.cachedJSON(`${DIR}/${id}.json`, null);

function entry(t) {
  const lastUser = [...t.shown].reverse().find((m) => m.role === 'user');
  return { id: t.id, title: t.title, created: t.created, updated: t.updated, pinned: !!t.pinned,
           preview: (lastUser?.text || '').slice(0, 90), count: t.shown.length };
}

// Write the thread, then its line in the index (read-modify-write, so another
// device's chats are never lost).
export async function save(t) {
  t.updated = new Date().toISOString();
  const stored = { ...t, history: forStorage(t.history), others: undefined };
  await gh.write(`${DIR}/${t.id}.json`, JSON.stringify(stored) + '\n', `app: chat ${t.title.slice(0, 40)}`);
  await gh.update(INDEX, (list) => [entry(t), ...(list || []).filter((e) => e.id !== t.id)], [], 'app: chat index');
}

export async function patch(id, change) {
  const t = await load(id);
  if (t) {
    Object.assign(t, change);
    await gh.write(`${DIR}/${id}.json`, JSON.stringify(t) + '\n', 'app: chat');
  }
  return gh.update(INDEX, (list) => (list || []).map((e) => (e.id === id ? { ...e, ...change } : e)), [], 'app: chat index');
}

export async function remove(id) {
  await gh.remove(`${DIR}/${id}.json`, 'app: delete chat');
  return gh.update(INDEX, (list) => (list || []).filter((e) => e.id !== id), [], 'app: chat index');
}

// The one chat the app kept in localStorage before chats were stored in the repo.
export async function migrateLocal() {
  if (localStorage.getItem('chatMigrated')) return null;
  let old;
  try { old = JSON.parse(localStorage.getItem('chat') || 'null'); } catch { old = null; }
  localStorage.setItem('chatMigrated', '1');
  if (!old?.shown?.length) return null;
  const t = blank(localStorage.getItem('model') || '', localStorage.getItem('effort') || 'medium');
  Object.assign(t, { title: 'Earlier chat', titled: true, history: old.history || [],
    shown: old.shown.map((m) => ({ ...m, tools: (m.tools || []).map((n) => (typeof n === 'string' ? { name: n } : n)) })) });
  t.created = old.shown[0]?.at || t.created;
  await save(t);
  return t;
}

// Search: titles at once, then the text of each chat (cached copies first,
// the rest fetched, newest 60 at most).
export async function search(q, list, onResult) {
  const needle = q.toLowerCase().trim();
  if (!needle) return;
  const hit = (t) => {
    for (const m of t.shown || []) {
      const i = (m.text || '').toLowerCase().indexOf(needle);
      if (i >= 0) return (m.text.slice(Math.max(0, i - 30), i + 60)).replace(/\s+/g, ' ');
    }
    return null;
  };
  for (const e of list.slice(0, 60)) {
    let t = cached(e.id);
    if (!t) { try { t = await load(e.id); } catch { t = null; } }
    const snip = t && hit(t);
    if (snip) onResult(e.id, snip);
  }
}
