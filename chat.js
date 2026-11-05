// The Chat tab: several chats in a drawer, replies streamed as they're
// written, files and photos, voice, inline ClickUp confirmations.
// Layout follows the phone apps of ChatGPT, Claude and Gemini: ☰ opens the
// chat list (search, New chat, Pinned, then by date); replies run full width,
// your messages sit in a bubble; one composer box with + · model · mic · send,
// and send turns into Stop while a reply streams.

import * as gh from './gh.js';
import * as ai from './ai.js';
import * as threads from './threads.js';
import { render as md, esc } from './md.js';
import { I } from './icons.js';
import { toast as uiToast } from './ui.js';

const $ = (sel, root = document) => root.querySelector(sel);
let app = {};          // hooks from app.js: draw, refresh, pending(), setPending(list), data()
let list = [];         // the chat index
let t = null;          // the open chat
let live = null;       // the reply being streamed: {text, tools, model, note}
let ctrl = null;       // AbortController for Stop
let draft = '';
let files = [];        // attachments for the next message
let drawer = false;
let query = '';
let hits = new Map();  // id -> snippet from a content search
let menuFor = null;    // drawer row with its menu open
let renaming = null;
let deleting = null;
let modelList = [];
let listening = null;  // SpeechRecognition while active

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
const LIMIT = { total: 12e6, pdf: 9e6, text: 3e5, imageSide: 1600 };

// ---------------------------------------------------------------- setup

export function init(hooks) {
  app = hooks;
  list = threads.cachedIndex();
  const id = localStorage.getItem('chatCurrent');
  if (id) t = threads.cached(id);
  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('input', onInput);
  document.addEventListener('change', onChange);
  document.addEventListener('keydown', onKey);
  // while typing, the tab bar gives its room to the keyboard (as the phone apps do)
  document.addEventListener('focusin', (e) => { if (e.target.matches?.('.composer textarea')) document.body.classList.add('chat-typing'); });
  document.addEventListener('focusout', (e) => {
    if (!e.target.matches?.('.composer textarea')) return;
    setTimeout(() => { if (!document.activeElement?.matches?.('.composer textarea')) document.body.classList.remove('chat-typing'); }, 250);
  });
  // composer buttons don't take focus: the keyboard stays up after Send, and the
  // layout can't shift between pressing a button and the tap landing on it
  document.addEventListener('mousedown', (e) => { if (e.target.closest?.('.composer button')) e.preventDefault(); });
}

// Called after every draw of the Chat tab.
export async function mounted() {
  document.body.classList.add('chat-mode');
  sizeBox();
  scrollDown(true);
  if (!modelList.length) {
    try { modelList = await ai.models(); paint(); } catch { /* the select says so */ }
  }
  if (!mounted.synced) {
    mounted.synced = true;
    try {
      const moved = await threads.migrateLocal();
      list = await threads.index();
      if (moved && !t) t = moved;
      if (t && !live) {
        const fresh = await threads.load(t.id);
        if (fresh && fresh.updated !== t.updated) t = fresh;
      }
      paint();
    } catch (err) { toast(`Couldn't load chats: ${err.message}`); }
  }
}

export function unmounted() { document.body.classList.remove('chat-mode', 'chat-typing'); }

// Back button: closes the drawer if it's open (app.js calls this on popstate).
export function back() {
  if (!drawer) return false;
  drawer = false;
  paint();
  return true;
}

function closeDrawer() {
  if (!drawer) return;
  if (history.state?.drawer) history.back(); else back();
}

function paint() {
  if (app.tab() !== 'chat') return;
  app.draw();
}

const toast = (text) => uiToast(text);

// ---------------------------------------------------------------- view

export function view() {
  const title = t?.title && t.shown.length ? t.title : 'New chat';
  return `<div class="chatapp${drawer ? ' drawer-open' : ''}">
    <header class="chat-top">
      <button class="icon" data-c="drawer" aria-label="Your chats">${I.menu}</button>
      <h1 class="chat-title">${esc(title)}</h1>
      <button class="icon" data-c="new" aria-label="New chat">${I.compose}</button>
    </header>
    <div id="log" class="log" aria-live="polite">${t?.shown.length || live ? messages() : empty()}</div>
    ${composer()}
    ${drawer ? drawerView() : ''}
  </div>`;
}

function empty() {
  const lec = (app.data().lectures || [])[0];
  const starters = [
    ['What should I work on today?', 'What should I work on today?'],
    lec ? [`Quiz me on the last ${lec.module} lecture`, `Quiz me on my last ${lec.module} lecture ("${lec.name}", file ${lec.path}). Read it first, then ask me one question at a time.`] : null,
    ["What's due this week?", "What's due this week, and what should I start first?"],
    ['Plan my evening', 'Plan my evening around what is due soonest.'],
  ].filter(Boolean);
  return `<div class="empty">
    <h2>What can I help with?</h2>
    <p class="muted">Every chat shares one memory: what you tell one, the others know.</p>
    <div class="starters">${starters.map(([label, text]) => `<button class="starter" data-c="starter" data-text="${esc(text)}">${esc(label)}</button>`).join('')}</div>
  </div>`;
}

function messages() {
  const shown = t?.shown || [];
  const lastUser = shown.map((m) => m.role).lastIndexOf('user');
  const lastModel = shown.map((m) => m.role).lastIndexOf('model');
  const out = shown.map((m, i) => (m.role === 'user' ? userMsg(m, i === lastUser && !live)
    : modelMsg(m, i === lastModel && !live && lastModel > lastUser)));
  if (live) out.push(`<div class="msg model" id="live">${liveInner()}</div>`);
  return out.join('');
}

function userMsg(m, isLast) {
  const att = (m.files || []).map((f) => (f.thumb ? `<img class="thumb" src="${esc(f.thumb)}" alt="${esc(f.name)}">`
    : `<span class="filechip">${I.file}${esc(f.name)}</span>`)).join('');
  return `<div class="msg user"><div class="bubble">${att ? `<div class="atts">${att}</div>` : ''}${esc(m.text || '').replace(/\n/g, '<br>')}</div>
    <div class="acts">${isLast ? `<button class="act" data-c="edit" aria-label="Edit and resend">${I.edit}</button>` : ''}
    <button class="act" data-c="copy" data-text="${esc(m.text || '')}" aria-label="Copy">${I.copy}</button></div></div>`;
}

const LABEL = {
  remember: 'remembered', change_schedule: 'recorded schedule change', cancel_schedule_change: 'cancelled a change',
  add_todo: 'added a to-do', complete_todo: 'ticked off', skip_event: 'marked not going', replan: 're-planning the week',
  propose_clickup_update: 'proposed a ClickUp change', add_to_calendar: 'added to Life calendar', delegate: 'delegated a job',
  list_files: 'looked through files',
};
export function toolLabel(tool) {
  if (tool.name === 'read_file') {
    const p = tool.args?.path || tool.path || '';
    return /\/lectures\//.test(p) ? 'read lecture' : /email\//.test(p) ? 'read email' : /\/files\//.test(p) ? 'read slides'
      : /^work\//.test(p) ? 'read delegated work' : 'read file';
  }
  return LABEL[tool.name] || tool.name.replace(/_/g, ' ');
}
const chips = (tools, running) => (tools.length || running ? `<div class="toolchips">${tools.map((x) => `<span class="toolchip">✓ ${esc(toolLabel(x))}</span>`).join('')}${running ? `<span class="toolchip run">${esc(toolLabel(running))}…</span>` : ''}</div>` : '');

function modelMsg(m, isLast) {
  const pending = app.pending();
  const cards = (m.proposed || []).map((a) => {
    const handled = a.status === 'proposed' && app.pendingLoaded() && !pending.some((p) => p.id === a.id);
    return `<div class="propose"><span>${esc(a.summary)}</span>${a.status === 'proposed' && !handled
      ? `<div class="row"><button data-c="decide" data-yes="1" data-id="${esc(a.id)}">Confirm</button><button class="ghost" data-c="decide" data-yes="0" data-id="${esc(a.id)}">Dismiss</button></div>`
      : `<span class="tag ${a.status === 'confirmed' ? 'done' : ''}">${handled ? 'handled on Today' : esc(a.status)}</span>`}</div>`;
  }).join('');
  return `<div class="msg model${m.error ? ' error' : ''}">${chips(m.tools || [])}
    <div class="md">${md(m.text || '')}</div>${m.stopped ? '<p class="muted small">Stopped.</p>' : ''}${cards}
    <div class="meta">${m.model ? `<span class="muted small">${esc(m.model)}${m.note ? ` · ${esc(m.note)}` : ''}</span>` : ''}
      <span class="acts"><button class="act" data-c="copy" data-text="${esc(m.text || '')}" aria-label="Copy">${I.copy}</button>
      ${isLast ? `<button class="act" data-c="regen" aria-label="Regenerate reply">${I.retry}</button>` : ''}</span></div></div>`;
}

function liveInner() {
  const body = live.text ? md(live.text) : `<p class="typing" aria-label="Writing"><span></span><span></span><span></span></p>`;
  return `${chips(live.tools, live.running)}<div class="md">${body}</div>
    <div class="meta"><span class="muted small">${esc(live.model || '')}${live.note ? ` · ${esc(live.note)}` : ''}</span></div>`;
}

function composer() {
  const model = currentModel();
  const effort = t?.effort || ai.settings.effort;
  const opts = modelList.length ? modelList.map((m) => `<option value="${esc(m.id)}" ${m.id === model ? 'selected' : ''}>${esc(m.id.replace(/^gemini-/, ''))}</option>`).join('')
    : `<option>${gh.cfg.geminiKey ? 'loading…' : 'no key'}</option>`;
  return `<form class="composer" data-c="send">
    ${files.length ? `<div class="drafts">${files.map((f, i) => `<span class="filechip">${f.thumb ? `<img src="${esc(f.thumb)}" alt="">` : I.file}${esc(f.name)}
      <button type="button" class="x" data-c="unattach" data-i="${i}" aria-label="Remove ${esc(f.name)}">${I.x}</button></span>`).join('')}</div>` : ''}
    <textarea name="q" rows="1" placeholder="${listening ? 'Listening…' : 'Message'}" aria-label="Message">${esc(draft)}</textarea>
    <div class="bar">
      <label class="icon" aria-label="Attach files or photos">${I.plus}<input type="file" id="attach" multiple accept="image/*,application/pdf,text/*,.md,.c,.h,.cpp,.py,.java,.js,.json,.csv" hidden></label>
      <select id="cmodel" aria-label="Model">${opts}</select>
      <select id="ceffort" aria-label="Effort">${['low', 'medium', 'high'].map((e) => `<option ${e === effort ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <span class="grow"></span>
      ${Speech ? `<button type="button" class="icon${listening ? ' on' : ''}" data-c="mic" aria-label="${listening ? 'Stop listening' : 'Speak'}">${I.mic}</button>` : ''}
      ${live ? `<button type="button" class="round stop" data-c="stop" aria-label="Stop">${I.stop}</button>`
        : `<button class="round" aria-label="Send">${I.send}</button>`}
    </div></form>`;
}

function currentModel() {
  const want = t?.model || ai.settings.model;
  return modelList.find((m) => m.id === want)?.id || modelList.find((m) => /-flash$/.test(m.id))?.id || modelList[0]?.id || '';
}

// ---------------------------------------------------------------- the drawer

function drawerView() {
  return `<div class="scrim" data-c="close-drawer"></div>
    <aside class="drawer" aria-label="Your chats">
      <div class="drawer-top"><label class="searchbox">${I.search}<input id="chatsearch" type="search" placeholder="Search chats" value="${esc(query)}" autocomplete="off"></label></div>
      <button class="newchat" data-c="new">${I.compose}<span>New chat</span></button>
      <div id="drawer-list">${drawerList()}</div>
    </aside>`;
}

function group(iso) {
  const d = new Date(iso);
  const day = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const today = new Date();
  if (day(d) === day(today)) return 'Today';
  if (day(d) === day(new Date(today - 864e5))) return 'Yesterday';
  if (today - d < 7 * 864e5) return 'Previous 7 days';
  if (today - d < 30 * 864e5) return 'Previous 30 days';
  return 'Older';
}

function drawerList() {
  const q = query.toLowerCase().trim();
  let rows = [...list].sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
  if (q) rows = rows.filter((e) => e.title.toLowerCase().includes(q) || hits.has(e.id));
  if (!rows.length) return `<p class="muted pad">${q ? 'No chats match.' : 'No chats yet.'}</p>`;
  const sections = [];
  const pinned = q ? [] : rows.filter((e) => e.pinned);
  if (pinned.length) sections.push(['Pinned', pinned]);
  for (const e of rows.filter((x) => q || !x.pinned)) {
    const g = q ? 'Results' : group(e.updated);
    const s = sections.find(([name]) => name === g);
    if (s) s[1].push(e); else sections.push([g, [e]]);
  }
  return sections.map(([name, items]) => `<h3>${name}</h3><ul class="chats">${items.map(row).join('')}</ul>`).join('');
}

function row(e) {
  const on = t?.id === e.id ? ' on' : '';
  if (renaming === e.id) {
    return `<li class="${on}"><form class="rename" data-c="rename-save" data-id="${esc(e.id)}"><input name="title" value="${esc(e.title)}" aria-label="Chat name" maxlength="80"><button>Save</button>
      <button type="button" class="ghost" data-c="rename-cancel">Cancel</button></form></li>`;
  }
  if (deleting === e.id) {
    return `<li class="${on}"><div class="confirmdel"><span>Delete “${esc(e.title)}”?</span><div class="row"><button class="danger" data-c="delete-yes" data-id="${esc(e.id)}">Delete</button>
      <button class="ghost" data-c="delete-no">Cancel</button></div></div></li>`;
  }
  return `<li class="${on}"><button class="chatrow" data-c="open" data-id="${esc(e.id)}">
      <span class="t">${e.pinned ? `<span class="pinmark">${I.pin}</span>` : ''}${esc(e.title)}</span>
      ${hits.get(e.id) ? `<span class="snip">…${esc(hits.get(e.id))}…</span>` : ''}</button>
    <button class="icon" data-c="menu" data-id="${esc(e.id)}" aria-label="Options for ${esc(e.title)}" aria-expanded="${menuFor === e.id}">${I.more}</button>
    ${menuFor === e.id ? `<div class="rowmenu"><button class="ghost" data-c="pin" data-id="${esc(e.id)}">${e.pinned ? 'Unpin' : 'Pin'}</button>
      <button class="ghost" data-c="rename" data-id="${esc(e.id)}">Rename</button><button class="ghost danger-text" data-c="delete" data-id="${esc(e.id)}">Delete</button></div>` : ''}</li>`;
}

function paintDrawer() {
  const el = $('#drawer-list');
  if (el) el.innerHTML = drawerList(); else paint();
}

// ---------------------------------------------------------------- sending

export function ask(text) {
  draft = '';
  return turn({ text });
}

async function userParts(text, attached) {
  const parts = [];
  for (const f of attached) {
    if (f.kind === 'text') parts.push({ text: `[Attached file: ${f.name}]\n${f.text}` });
    else parts.push({ text: `[Attached: ${f.name}]` }, { inlineData: { mimeType: f.type, data: f.data } });
  }
  if (text) parts.push({ text });
  return parts;
}

// One exchange. With `again`, the last user turn is sent again (regenerate).
async function turn({ text, again = null, reuse = [] }) {
  if (live) return;
  if (!gh.cfg.geminiKey) { toast('Add a Gemini key in Settings first.'); return; }
  if (!t) {
    t = threads.blank(currentModel() || ai.settings.model, ai.settings.effort);
    localStorage.setItem('chatCurrent', t.id);
  }
  const th = t; // this turn's chat, even if another is opened while it finishes
  const attached = again ? [] : files;
  let parts = again;
  if (!parts) {
    parts = await userParts(text, attached);
    if (!parts.length) return;
    th.shown.push({ id: gh.id(), role: 'user', text, at: new Date().toISOString(),
                   files: attached.map((f) => ({ name: f.name, type: f.type, size: f.size, thumb: f.thumb })) });
    files = [];
    draft = '';
  }
  th._lastParts = parts;
  const firstText = th.shown.find((m) => m.role === 'user')?.text || text || '';
  const naming = !th.titled ? ai.titleFor(firstText || 'files').catch(() => null) : null;
  th.others = list.filter((e) => e.id !== th.id);
  live = { text: '', tools: [], model: currentModel(), note: '' };
  ctrl = new AbortController();
  paint();
  scrollDown(true);
  let res;
  try {
    res = await ai.send(th, parts, {
      model: currentModel(), effort: th.effort || ai.settings.effort, signal: ctrl.signal, reuse,
      on: {
        text: (full) => { live.text = full; liveUpdate(); },
        tool: ({ name, args, result }) => {
          if (result === undefined) live.running = { name, args };
          else { live.running = null; live.tools.push({ name, args }); }
          liveUpdate();
        },
        model: (id, reason) => {
          live.model = id;
          if (reason) { (live.why ||= []).push(reason.replace(/gemini-/g, '')); live.note = `switched: ${live.why.join(', ')}`; }
          liveUpdate();
        },
      },
    });
  } catch (err) {
    // a failed turn leaves nothing half-done in the history; Regenerate retries it
    const i = ai.lastUserTurn(th.history);
    if (i >= 0 && i === th.history.length - 1) th.history.pop();
    th.shown.push({ id: gh.id(), role: 'model', error: true, text: `**Couldn't answer:** ${err.message}`, at: new Date().toISOString() });
    live = null; ctrl = null;
    paint();
    return;
  }
  th.shown.push({ id: gh.id(), role: 'model', text: res.reply, at: new Date().toISOString(), model: res.model, note: live.note,
                 tools: res.tools, proposed: res.proposed.map((a) => ({ ...a })), stopped: res.stopped || undefined });
  if (res.proposed.length) app.setPending([...app.pending(), ...res.proposed]);
  live = null; ctrl = null;
  if (naming) {
    const name = await Promise.race([naming, new Promise((r) => setTimeout(() => r(null), 6000))]);
    th.title = name || firstText.replace(/\s+/g, ' ').slice(0, 40) || 'Chat';
    th.titled = true;
  }
  if (th.model !== res.model && !th.model) th.model = res.model;
  paint();
  scrollDown();
  await persist(th);
  archive(th.shown.slice(-2)).catch(() => {});
  if (res.tools.some((x) => /remember|schedule|todo|skip|calendar/.test(x.name))) app.refresh();
}

async function persist(th = t) {
  try {
    await threads.save(th);
    list = [threads.cachedIndex().find((e) => e.id === th.id) || { id: th.id, title: th.title, updated: th.updated, pinned: th.pinned },
            ...list.filter((e) => e.id !== th.id)];
    if (drawer) paintDrawer();
  } catch (err) { toast(`Not saved to the repo yet: ${err.message}`); }
}

// The readable monthly transcript (chat/<YYYY-MM>.json) the cloud can read.
async function archive(recent) {
  const month = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }).slice(0, 7);
  await gh.update(`chat/${month}.json`, (log) => [...log, ...recent.map(({ role, text, at, tools, model }) =>
    ({ role, text, at, tools: (tools || []).map((x) => x.name || x), model, thread: t.id, title: t.title }))], [], 'app: chat');
}

let raf = 0;
function liveUpdate() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const el = $('#live');
    if (!el || !live) return;
    const stick = nearBottom();
    el.innerHTML = liveInner();
    if (stick) scrollDown(true);
  });
}

function nearBottom() {
  const log = $('#log');
  return !log || log.scrollHeight - log.scrollTop - log.clientHeight < 120;
}

function scrollDown(force) {
  const log = $('#log');
  if (log && (force || nearBottom())) log.scrollTop = log.scrollHeight;
}

function sizeBox() {
  const box = $('.composer textarea');
  if (!box) return;
  box.style.height = 'auto';
  box.style.height = `${Math.min(box.scrollHeight, 160)}px`;
}

// Back to just before the last user turn: for Regenerate and Edit.
function rewind() {
  const i = ai.lastUserTurn(t.history);
  const parts = i >= 0 ? t.history[i].parts : t._lastParts;
  // what the rewound reply's tools returned, so Regenerate doesn't repeat them
  const done = i >= 0 ? t.history.slice(i + 1).flatMap((c) => (c.role === 'user' ? c.parts : []))
    .filter((p) => p.functionResponse && !p.functionResponse.response?.error)
    .map((p) => ({ name: p.functionResponse.name, response: p.functionResponse.response })) : [];
  t._reuse = done;
  if (i >= 0) t.history = t.history.slice(0, i);
  const u = t.shown.map((m) => m.role).lastIndexOf('user');
  const userMsgShown = t.shown[u];
  t.shown = t.shown.slice(0, u + 1);
  return { parts, userMsgShown, u };
}

// ---------------------------------------------------------------- files

async function attach(fileList) {
  let total = files.reduce((n, f) => n + f.bytes, 0);
  for (const f of fileList) {
    try {
      let item;
      if (f.type.startsWith('image/')) item = await image(f);
      else if (f.type === 'application/pdf') {
        if (f.size > LIMIT.pdf) throw new Error(`${f.name} is over 9 MB`);
        item = { kind: 'inline', name: f.name, type: f.type, size: f.size, data: await b64(f), bytes: f.size };
      } else if (f.size <= LIMIT.text) {
        item = { kind: 'text', name: f.name, type: f.type || 'text/plain', size: f.size, text: await f.text(), bytes: f.size };
      } else throw new Error(`${f.name}: only photos, PDFs and text files up to 300 KB`);
      if (total + item.bytes > LIMIT.total) throw new Error('that would be over 12 MB for one message');
      total += item.bytes;
      files.push(item);
    } catch (err) { toast(err.message); }
  }
  paint();
}

// Photos are scaled to 1600 px and re-encoded, so a 6 MB phone photo goes as ~300 KB.
async function image(f) {
  const bmp = await createImageBitmap(f);
  const scale = Math.min(1, LIMIT.imageSide / Math.max(bmp.width, bmp.height));
  const big = encode(bmp, scale, 0.85);
  const thumb = encode(bmp, Math.min(1, 160 / Math.max(bmp.width, bmp.height)), 0.7);
  const data = big.split(',')[1];
  return { kind: 'inline', name: f.name.replace(/\.\w+$/, '') + '.jpg', type: 'image/jpeg', size: f.size, data, thumb, bytes: data.length * 0.75 };
}

function encode(bmp, scale, q) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', q);
}

function b64(f) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = () => fail(r.error);
    r.readAsDataURL(f);
  });
}

// ---------------------------------------------------------------- voice

function mic() {
  if (listening) { listening.stop(); return; }
  const rec = new Speech();
  rec.lang = 'en-GB';
  rec.interimResults = true;
  rec.continuous = false;
  const base = draft ? `${draft.trimEnd()} ` : '';
  rec.onresult = (e) => {
    const said = [...e.results].map((r) => r[0].transcript).join('');
    draft = base + said;
    const box = $('.composer textarea');
    if (box) { box.value = draft; sizeBox(); }
  };
  rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Voice: ${e.error}`); };
  rec.onend = () => { listening = null; paint(); };
  listening = rec;
  rec.start();
  paint();
}

// ---------------------------------------------------------------- events

async function onClick(e) {
  const el = e.target.closest('[data-c]');
  if (!el || !el.closest('.chatapp') || el.tagName === 'FORM') return;
  const c = el.dataset.c;
  const id = el.dataset.id;
  if (c === 'drawer') {
    drawer = true; menuFor = renaming = deleting = null;
    history.pushState({ drawer: true }, '');   // Android back closes it
    paint();
    $('#chatsearch')?.focus({ preventScroll: true });
  } else if (c === 'close-drawer') closeDrawer();
  else if (c === 'new') {
    if (live) return;
    t = null; files = []; draft = '';
    closeDrawer();
    localStorage.removeItem('chatCurrent');
    paint();
    $('.composer textarea')?.focus();
  } else if (c === 'open') {
    if (live) return;
    closeDrawer();
    localStorage.setItem('chatCurrent', id);
    t = threads.cached(id) || { ...threads.blank(), id, title: list.find((x) => x.id === id)?.title || 'Chat', titled: true };
    paint();
    try { const fresh = await threads.load(id); if (fresh && t?.id === id) { t = fresh; paint(); scrollDown(true); } }
    catch (err) { toast(err.message); }
  } else if (c === 'menu') { menuFor = menuFor === id ? null : id; paintDrawer(); }
  else if (c === 'pin') {
    const ent = list.find((x) => x.id === id);
    ent.pinned = !ent.pinned; menuFor = null;
    if (t?.id === id) t.pinned = ent.pinned;
    paintDrawer();
    threads.patch(id, { pinned: ent.pinned }).catch((err) => toast(err.message));
  } else if (c === 'rename') { renaming = id; menuFor = null; paintDrawer(); $('.rename input')?.select(); }
  else if (c === 'rename-cancel') { renaming = null; paintDrawer(); }
  else if (c === 'delete') { deleting = id; menuFor = null; paintDrawer(); }
  else if (c === 'delete-no') { deleting = null; paintDrawer(); }
  else if (c === 'delete-yes') {
    deleting = null;
    list = list.filter((x) => x.id !== id);
    if (t?.id === id) { t = null; localStorage.removeItem('chatCurrent'); }
    paint();
    threads.remove(id).catch((err) => toast(err.message));
  } else if (c === 'starter') { turn({ text: el.dataset.text }); }
  else if (c === 'stop') { ctrl?.abort(); }
  else if (c === 'mic') { mic(); }
  else if (c === 'unattach') { files.splice(+el.dataset.i, 1); paint(); }
  else if (c === 'copy') {
    try { await navigator.clipboard.writeText(el.dataset.text); el.classList.add('done'); el.setAttribute('aria-label', 'Copied'); setTimeout(() => el.classList.remove('done'), 1500); }
    catch { toast("Couldn't copy"); }
  } else if (c === 'regen') {
    if (live || !t) return;
    const { parts } = rewind();
    paint();
    turn({ again: parts, reuse: t._reuse });
  } else if (c === 'edit') {
    if (live || !t) return;
    const { parts, u } = rewind();
    const text = t.shown[u]?.text || '';
    // files that are still in memory come back as attachments; text files too
    files = [];
    (parts || []).forEach((p, i) => {
      const name = (parts[i - 1]?.text || '').match(/^\[Attached: (.+)\]$/)?.[1];
      if (p.inlineData && name) files.push({ kind: 'inline', name, type: p.inlineData.mimeType, data: p.inlineData.data, bytes: p.inlineData.data.length * 0.75,
        thumb: t.shown[u]?.files?.find((f) => f.name === name)?.thumb });
      const tf = (p.text || '').match(/^\[Attached file: (.+)\]\n([\s\S]*)$/);
      if (tf) files.push({ kind: 'text', name: tf[1], type: 'text/plain', text: tf[2], bytes: tf[2].length });
    });
    t.shown = t.shown.slice(0, u);
    draft = text;
    paint();
    const box = $('.composer textarea');
    box?.focus();
    box?.setSelectionRange(box.value.length, box.value.length);
  } else if (c === 'decide') {
    const msg = t.shown.find((m) => (m.proposed || []).some((a) => a.id === id));
    const action = msg?.proposed.find((a) => a.id === id);
    if (!action) return;
    el.closest('.propose').innerHTML = '<span class="muted">Sending…</span>';
    try {
      const done = await ai.decide(action, el.dataset.yes === '1');
      action.status = done.status;
      app.setPending(app.pending().filter((p) => p.id !== id));
      persist();
    } catch (err) { toast(err.message); }
    paint();
  }
}

function onSubmit(e) {
  const form = e.target;
  if (!form.closest?.('.chatapp')) return;
  e.preventDefault();
  if (form.dataset.c === 'send') {
    const text = (form.elements.q.value || '').trim();
    if ((!text && !files.length) || live) return;
    form.elements.q.value = '';
    draft = '';
    turn({ text });
  } else if (form.dataset.c === 'rename-save') {
    const id = form.dataset.id;
    const title = (form.elements.title.value || '').trim().slice(0, 80);
    renaming = null;
    if (!title) { paintDrawer(); return; }
    const ent = list.find((x) => x.id === id);
    if (ent) ent.title = title;
    if (t?.id === id) { t.title = title; t.titled = true; }
    paint();
    threads.patch(id, { title, titled: true }).catch((err) => toast(err.message));
  }
}

let searchSeq = 0;
function onInput(e) {
  if (e.target.matches?.('.composer textarea')) { draft = e.target.value; sizeBox(); }
  if (e.target.id === 'chatsearch') {
    query = e.target.value;
    hits = new Map();
    paintDrawer();
    const seq = ++searchSeq;
    clearTimeout(onInput.timer);
    onInput.timer = setTimeout(() => threads.search(query, list, (id, snip) => {
      if (seq !== searchSeq) return;
      hits.set(id, snip);
      paintDrawer();
    }), 250);
  }
}

function onChange(e) {
  if (e.target.id === 'attach') { attach([...e.target.files]); e.target.value = ''; }
  if (e.target.id === 'cmodel' && /^gemini-/.test(e.target.value)) {
    ai.settings.model = e.target.value;
    if (t) t.model = e.target.value;
  }
  if (e.target.id === 'ceffort') {
    ai.settings.effort = e.target.value;
    if (t) t.effort = e.target.value;
  }
}

// Enter sends on a computer; on a phone Enter is a new line (as in the phone apps).
function onKey(e) {
  if (e.target.matches?.('.composer textarea') && e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
  if (e.key === 'Escape' && drawer) closeDrawer();
}
