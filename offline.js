// Lecture notes that open with no signal.
//
// After each successful sync, the study notes of the last WEEKS weeks' lectures
// are saved on the device (IndexedDB: localStorage is small and already holds the
// data files). Only the notes are kept, not the transcript (that can be 60k
// characters). A lecture is fetched again only when its notes change (the
// catalogue's version and gist), and anything older is let go, so storage stays
// within MAX lectures. The reader opens from here first, then from the network.

import * as gh from './gh.js';
import { state } from './store.js';
import { addDays, londonDate } from './format.js';

const DB = 'life-offline';
const WEEKS = 3;
const MAX = 40;
const VERSIONS = 'offlineNotes'; // localStorage: {path: version}, so the list can show what's saved at once

function store(mode, fn) {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('notes');
    req.onerror = () => resolve(null); // private browsing: notes just aren't saved
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('notes', mode);
        const got = fn(tx.objectStore('notes'));
        tx.oncomplete = () => { db.close(); resolve(got?.result ?? null); };
        tx.onerror = () => { db.close(); resolve(null); };
      } catch { db.close(); resolve(null); }
    };
  });
}

const versions = () => { try { return JSON.parse(localStorage.getItem(VERSIONS) || '{}'); } catch { return {}; } };
const saveVersions = (v) => { try { localStorage.setItem(VERSIONS, JSON.stringify(v)); } catch { /* fine */ } };

// Paths saved on this device (for the "Saved for offline" tag).
export const saved = () => new Set(Object.keys(versions()));

// The saved notes of a lecture, or null.
export const get = (path) => store('readonly', (s) => s.get(path));

const notesOnly = (text) => text.split(/\n## Transcript\s*\n/)[0];
const version = (l) => `${l.notes || 0}:${l.summarised ? 1 : 0}:${(l.tldr || '').slice(0, 60)}`;

// The lectures worth keeping: with notes, from the last WEEKS weeks, newest first.
function wanted() {
  const cutoff = addDays(londonDate(), -7 * WEEKS);
  return (state.data.lectures || []).filter((l) => l.path && (l.notes || l.summarised) && (l.date || '') >= cutoff)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, MAX);
}

let running = null;
export function saveRecent() {
  if (running || !gh.configured() || typeof indexedDB === 'undefined') return running;
  running = (async () => {
    const have = versions();
    const want = wanted();
    let added = 0;
    for (const l of want) {
      if (have[l.path] === version(l)) continue;
      if (!navigator.onLine) break;
      let text = null;
      try { text = await gh.readText(l.path, { cache: false }); } catch { break; } // offline or GitHub trouble: next sync
      if (text == null) continue;
      await store('readwrite', (s) => s.put(notesOnly(text), l.path));
      have[l.path] = version(l);
      added += 1;
      saveVersions(have);
    }
    const keep = new Set(want.map((l) => l.path));
    for (const p of Object.keys(have)) {
      if (keep.has(p)) continue;
      await store('readwrite', (s) => s.delete(p));
      delete have[p];
    }
    saveVersions(have);
    return added;
  })().finally(() => { running = null; });
  return running;
}

// Settings → Remove keys forgets these too.
export function clear() {
  saveVersions({});
  return store('readwrite', (s) => s.clear());
}
