// The chat. Gemini, called straight from the browser with the key stored on
// this device. It reads the same shared memory as the cloud briefing
// (context/now.md), so the chat and Today always agree.
//
// Changes it makes:
//   - its own memory (notes, schedule changes, to-dos): written at once
//   - the team's ClickUp: only PROPOSED; nothing happens until the user confirms
//   - the "Life" calendar and delegated jobs: queued for the cloud to carry out

import * as gh from './gh.js';

// geminiBase is a local-testing hook (a mock server on this machine), ignored
// unless it points at localhost: the key only ever goes to Google.
const API = gh.localOnly(localStorage.getItem('geminiBase')) || 'https://generativelanguage.googleapis.com/v1beta';
const TZ = 'Europe/London';

export const settings = {
  get model() { return localStorage.getItem('model') || ''; },
  set model(v) { localStorage.setItem('model', v); },
  get effort() { return localStorage.getItem('effort') || 'medium'; },
  set effort(v) { localStorage.setItem('effort', v); },
};

async function request(path, body, signal) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': gh.cfg.geminiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function call(path, body, signal) {
  return (await request(path, body, signal)).json();
}

// Models this key can actually use, newest first, Flash before Pro before Lite.
let modelCache = null;
export async function models({ fresh = false } = {}) {
  if (modelCache && !fresh) return modelCache;
  const got = await call('models?pageSize=200');
  const ok = (got.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.split('/').pop(), label: m.displayName || m.name }))
    .filter((m) => /^gemini-\d/.test(m.id) && !/(embedding|tts|image|live|audio|exp|native)/.test(m.id));
  const ver = (id) => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const rank = (id) => (/-flash$/.test(id) ? 0 : /-pro$/.test(id) ? 1 : /lite/.test(id) ? 2 : 3);
  ok.sort((a, b) => ver(b.id) - ver(a.id) || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  modelCache = ok;
  try { localStorage.setItem('models', JSON.stringify(ok)); } catch { /* fine */ }
  return ok;
}

// The last list this device saw, for pickers that should fill instantly.
export function cachedModels() {
  try { return JSON.parse(localStorage.getItem('models') || '[]'); } catch { return []; }
}

export async function defaultModel() {
  const all = await models();
  return all.find((m) => m.id === settings.model)?.id || all.find((m) => /-flash$/.test(m.id))?.id || all[0]?.id;
}

// Each model has its own free daily quota (TRAPS 3), and one model can be
// overloaded while another isn't: the next Flash/Lite model not yet tried.
function nextModel(model, usable, tried) {
  tried.add(model);
  return usable.filter((id) => /^gemini-\d+(\.\d+)?-flash(-lite)?$/.test(id)).find((id) => !tried.has(id)) || null;
}

// The cheapest model for small jobs (titles, summaries): newest Flash-Lite.
async function liteModel() {
  const all = (await models()).map((m) => m.id);
  return all.find((id) => /-flash-lite$/.test(id)) || all.find((id) => /-flash$/.test(id)) || all[0];
}

// One short non-streaming call on Flash-Lite, falling through on 429/503.
async function quick(prompt, maxTokens = 300) {
  const usable = (await models()).map((m) => m.id);
  const tried = new Set();
  let model = await liteModel();
  while (model) {
    try {
      const out = await call(`models/${model}:generateContent`, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      });
      return (out.candidates?.[0]?.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
    } catch (err) {
      if (err.status !== 429 && err.status !== 503) throw err;
      model = nextModel(model, usable, tried);
    }
  }
  throw new Error('every Gemini model is busy or out of quota');
}

export async function titleFor(text) {
  const t = await quick(`Write a title of 2 to 6 words for a chat that starts with the message below. Plain text, no quotes, no full stop.\n\nMessage: ${text.slice(0, 1500)}`, 30);
  return t.split('\n')[0].replace(/^["'“]|["'”.]$/g, '').slice(0, 60);
}

function thinking(model, effort) {
  const v = parseInt((model.match(/gemini-(\d+)/) || [0, 0])[1], 10);
  if (v >= 3) return { thinkingLevel: effort };
  return { thinkingBudget: { low: 1024, medium: 8192, high: 24576 }[effort] ?? 8192 };
}

export function nowLondon() {
  const d = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    weekday: 'long', timeZoneName: 'shortOffset',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${parts.timeZoneName}, Europe/London)`;
}

// ---------------------------------------------------------------- tools

const TOOLS = [
  { name: 'remember', description: 'Save a lasting fact about the user, their preferences, people in their life, or how they work. Use when they tell you something worth knowing next time.',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] } },
  { name: 'change_schedule', description: 'Record a schedule change or one-off event they report, e.g. "group meeting moved to Thu 3pm". Shows on Today immediately. Use ISO 8601 with the UK offset.',
    parameters: { type: 'object', properties: {
      title: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 with offset' },
      end: { type: 'string' }, location: { type: 'string' },
      note: { type: 'string', description: 'what changed, in a few words' } }, required: ['title', 'start', 'note'] } },
  { name: 'cancel_schedule_change', description: 'Remove a schedule change recorded earlier.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'add_todo', description: 'Add a personal to-do.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string', description: 'ISO 8601, optional' } }, required: ['title'] } },
  { name: 'complete_todo', description: 'Mark a personal to-do OR a planner checkpoint (id starts with cp-) done. Ids are in the context.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'skip_event', description: "Record that they are NOT going to a family/personal calendar event, so the planner can use that time. Nothing is sent to anyone. Use the event_id from the context; whole_series for a repeating event.",
    parameters: { type: 'object', properties: { event_id: { type: 'string' }, whole_series: { type: 'boolean' } }, required: ['event_id'] } },
  { name: 'replan', description: 'Ask the planner to re-plan the week now (e.g. after a big change). Takes a few minutes.',
    parameters: { type: 'object', properties: {} } },
  { name: 'propose_clickup_update', description: "Propose a change to the TEAM's ClickUp board (due date, status, name, or a comment). It is NOT applied until the user taps Confirm. Use the task id from the context.",
    parameters: { type: 'object', properties: {
      task_id: { type: 'string' }, task_name: { type: 'string' }, due: { type: 'string', description: 'new ISO 8601 due date' },
      status: { type: 'string' }, comment: { type: 'string' } }, required: ['task_id', 'task_name'] } },
  { name: 'add_to_calendar', description: 'Put an event in their "Life" Google calendar (one the app made; never his real or family calendars).',
    parameters: { type: 'object', properties: { title: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' },
      location: { type: 'string' }, note: { type: 'string' } }, required: ['title', 'start'] } },
  { name: 'delegate', description: 'Hand a small non-assessed job (practice material, tests, drafts, research notes) to a cloud job that works on it while they are away.',
    parameters: { type: 'object', properties: { task_title: { type: 'string' }, instruction: { type: 'string' },
      module: { type: 'string', description: 'module code like COMP2007, if any' } }, required: ['task_title', 'instruction'] } },
  { name: 'read_file', description: 'Read a file from their repo, e.g. a lecture (uni/COMP2007/lectures/...), an email (uni/email/...), a PDF text (uni/<CODE>/files/...), or delegated work (work/...).',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'list_files', description: 'List a folder in their repo, e.g. uni/COMP2065/lectures or work.',
    parameters: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] } },
];

const READABLE = /^(uni|work|schedule|profile|memory|context|inbox\/delegate-done)\//;

export async function queueDelegate({ id, title, instruction, module, source, due, url, description, model, effort, attachments = [] }) {
  const jobId = id || gh.id();
  const job = { id: jobId, created: new Date().toISOString(), status: 'queued', instruction,
                task: { title, source, module, due, url, description }, model, effort, attachments };
  await gh.write(`inbox/delegate/${jobId}.json`, JSON.stringify(job, null, 1) + '\n', `app: delegate ${title}`);
  return job;
}

async function runTool(name, a, ctx) {
  const today = new Date().toISOString().slice(0, 10);
  switch (name) {
    // Each write below is safe to repeat: an identical note, change or to-do that
    // is already there is returned instead of being added twice.
    case 'remember': {
      const current = (await gh.readText('memory/notes.md')) || '# What the organiser has learned\n';
      const known = current.split('\n').map((l) => same(l.replace(/^- \d{4}-\d{2}-\d{2}: /, '')));
      if (known.includes(same(a.fact))) return { saved: a.fact, note: 'Already in memory; not added again.' };
      await gh.write('memory/notes.md', `${current.trimEnd()}\n- ${today}: ${a.fact}\n`, 'app: remember');
      return { saved: a.fact };
    }
    case 'change_schedule': {
      let item = { id: gh.id(), title: a.title, start: a.start, end: a.end || null, location: a.location || '',
                   note: a.note, created: new Date().toISOString(), source: 'chat' };
      let existed = false;
      await gh.update('schedule/overrides.json', (list) => {
        const dup = list.find((o) => !o.cancelled && same(o.title) === same(a.title) && +new Date(o.start) === +new Date(a.start));
        if (dup) { item = dup; existed = true; return list; }
        return [...list, item];
      }, [], 'app: schedule change');
      return existed ? { recorded: item, note: 'This change was already recorded; not added again.' } : { recorded: item };
    }
    case 'cancel_schedule_change':
      await gh.update('schedule/overrides.json', (list) => list.map((o) => (o.id === a.id ? { ...o, cancelled: true } : o)), [], 'app: cancel change');
      return { cancelled: a.id };
    case 'add_todo': {
      let item = { id: gh.id(), title: a.title, due: a.due || null, done: false, created: new Date().toISOString() };
      let existed = false;
      await gh.update('schedule/todos.json', (list) => {
        const dup = list.find((t) => !t.done && same(t.title) === same(a.title));
        if (dup) { item = dup; existed = true; return list; }
        return [...list, item];
      }, [], 'app: todo');
      return existed ? { added: item, note: 'Already on the list; not added again.' } : { added: item };
    }
    case 'complete_todo':
      await markDone(a.id);
      return { done: a.id };
    case 'skip_event': {
      const id = a.whole_series ? a.event_id.split('_')[0] : a.event_id;
      await gh.update('schedule/skipped.json', (list) => (list.includes(id) ? list : [...list, id]), [], 'app: not going');
      return { skipped: id, note: 'The planner will treat that time as free from its next run.' };
    }
    case 'replan':
      await gh.dispatch('pulse.yml', { plan_now: 'true' });
      return { started: true, note: 'The new plan lands in the app and the Life calendar in a few minutes.' };
    case 'propose_clickup_update': {
      const out = [];
      if (a.due || a.status) {
        out.push(await propose('clickup_update', `${a.task_name}: ${a.due ? `due → ${fmt(a.due)}` : ''}${a.status ? ` status → ${a.status}` : ''}`,
          { task_id: a.task_id, due: a.due, status: a.status }));
      }
      if (a.comment) out.push(await propose('clickup_comment', `Comment on ${a.task_name}: "${a.comment}"`, { task_id: a.task_id, text: a.comment }));
      ctx.proposed.push(...out);
      return { proposed: out.map((o) => o.summary), note: 'Waiting for the user to tap Confirm in the chat.' };
    }
    case 'add_to_calendar': {
      const action = { id: gh.id(), type: 'calendar_add', status: 'confirmed', created: new Date().toISOString(),
                       summary: `Add "${a.title}" to Life calendar`, payload: a };
      await gh.write(`inbox/actions/${action.id}.json`, JSON.stringify(action, null, 1) + '\n', 'app: calendar add');
      return { queued: action.summary };
    }
    case 'delegate': {
      const job = await queueDelegate({ title: a.task_title, instruction: a.instruction, module: a.module,
                                        source: 'chat', model: ctx.model, effort: ctx.effort });
      return { queued: job.id, note: 'Runs in the cloud now; they get a notification when done.' };
    }
    case 'read_file': {
      if (!READABLE.test(a.path)) return { error: 'Not a readable path.' };
      const text = await gh.readMaybeChunked(a.path);
      return text == null ? { error: 'No such file.' } : { content: text.slice(0, 120000) };
    }
    case 'list_files': {
      if (!READABLE.test(a.dir.replace(/\/?$/, '/'))) return { error: 'Not a readable folder.' };
      const items = await gh.list(a.dir.replace(/\/$/, ''));
      return { files: items.map((i) => `${i.path}${i.type === 'dir' ? '/' : ''}`).slice(0, 200) };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// For "is this the same thing?": case, spacing and trailing punctuation don't count.
const same = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.!\s]+$/, '').trim();

// Tools that change something. On Regenerate these are not run again: the
// result from the first time is handed back to the model instead.
export const EFFECTS = new Set(['remember', 'change_schedule', 'cancel_schedule_change', 'add_todo', 'complete_todo', 'skip_event',
  'replan', 'propose_clickup_update', 'add_to_calendar', 'delegate']);

// Checkpoints live in the planner's file, so "done" for them is a list of ids;
// to-dos are the app's own and carry their own flag.
export async function markDone(id) {
  if (id.startsWith('cp-')) {
    await gh.update('schedule/done.json', (list) => (list.includes(id) ? list : [...list, id]), [], 'app: checkpoint done');
  } else {
    await gh.update('schedule/todos.json', (list) => list.map((t) => (t.id === id ? { ...t, done: true } : t)), [], 'app: todo done');
  }
}

// Undo for markDone.
export async function markUndone(id) {
  if (id.startsWith('cp-')) {
    await gh.update('schedule/done.json', (list) => list.filter((x) => x !== id), [], 'app: checkpoint undone');
  } else {
    await gh.update('schedule/todos.json', (list) => list.map((t) => (t.id === id ? { ...t, done: false } : t)), [], 'app: todo undone');
  }
}

async function propose(type, summary, payload) {
  const action = { id: gh.id(), type, status: 'proposed', created: new Date().toISOString(), summary, payload };
  await gh.write(`inbox/actions/${action.id}.json`, JSON.stringify(action, null, 1) + '\n', 'app: propose');
  return action;
}

export async function decide(action, yes) {
  const next = { ...action, status: yes ? 'confirmed' : 'dismissed' };
  await gh.write(`inbox/actions/${action.id}.json`, JSON.stringify(next, null, 1) + '\n', `app: ${next.status}`);
  return next;
}

function fmt(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

// ---------------------------------------------------------------- the turn

async function systemText(thread) {
  // Read fresh every turn: memory/notes.md, schedule changes and to-dos are what
  // any chat has just learned; context/now.md is the hourly shared memory.
  const [now, notes, overrides, todos, others] = await Promise.all([
    gh.readText('context/now.md').catch(() => gh.cachedText('context/now.md')),
    gh.readText('memory/notes.md').catch(() => gh.cachedText('memory/notes.md')),
    gh.readJSON('schedule/overrides.json', []).catch(() => []),
    gh.readJSON('schedule/todos.json', []).catch(() => []),
    Promise.resolve(thread?.others || []),
  ]);
  return `You are the organiser inside the user's own app: one assistant with one memory,
the same one that writes their Today briefing. Who they are is in the memory below.
They can have several chats; all of them share this memory.

Current time: ${nowLondon()}.

Be brief and concrete; they read this on a phone. Never invent schedule facts.
When they report a change (meeting moved, new event, something to remember), use the tools
to record it, then confirm in one line. ClickUp belongs to their whole group: only ever
PROPOSE changes there; say they are waiting for their Confirm. If you need detail from a
lecture, email or file, read it with read_file rather than guessing.
${thread?.summary ? `\nEARLIER IN THIS CHAT (older turns, summarised):\n${thread.summary}\n` : ''}
Other recent chats (titles only): ${others.slice(0, 8).map((o) => o.title).join(' · ') || 'none'}

Things learned in chat (memory/notes.md, newest last):
${(notes || '(nothing yet)').slice(-6000)}

Schedule changes recorded via chat (id, title, start, note):
${JSON.stringify(overrides.filter((o) => !o.cancelled).slice(-30))}

Personal to-dos:
${JSON.stringify(todos.filter((t) => !t.done).slice(-50))}

EVERYTHING THE ORGANISER KNOWS RIGHT NOW:
${now || '(the shared memory has not been built yet)'}`;
}

// ---- keeping a long chat inside the context

const isUserText = (c) => c.role === 'user' && (c.parts || []).some((p) => p.text != null || p.inlineData);
const BIG_RESULT = 4000;

// Old tool results (a whole lecture read three questions ago) are cut down; the
// last two user turns keep everything. Returns a new array; the input is untouched.
export function slim(history) {
  const starts = history.map((c, i) => (isUserText(c) ? i : -1)).filter((i) => i >= 0);
  const keepFrom = starts.length >= 2 ? starts[starts.length - 2] : 0;
  return history.map((c, i) => {
    if (i >= keepFrom || c.role !== 'user') return c;
    const parts = c.parts.map((p) => {
      if (!p.functionResponse) return p;
      const text = JSON.stringify(p.functionResponse.response);
      if (text.length <= BIG_RESULT) return p;
      return { functionResponse: { name: p.functionResponse.name,
        response: { trimmed: true, note: 'Large result trimmed from an older turn; call the tool again if you need it.', preview: text.slice(0, 1500) } } };
    });
    return { ...c, parts };
  });
}

// What gets stored in the repo: no inline file data (photos and PDFs go to
// Gemini with the message they belong to, and aren't kept), old results slimmed.
export function forStorage(history) {
  return slim(history).map((c) => (c.parts?.some((p) => p.inlineData)
    ? { ...c, parts: c.parts.map((p) => (p.inlineData ? { text: `(a ${p.inlineData.mimeType} file was attached here; it was only sent with this message)` } : p)) }
    : c));
}

const size = (history) => history.reduce((n, c) => n + (c.parts || []).reduce((m, p) => m + (p.inlineData ? 0 : JSON.stringify(p).length), 0), 0);
export const LIMITS = { chars: 150000, turns: 30 };

// When a chat gets long, the oldest half is summarised (Flash-Lite) into
// thread.summary and dropped from what's sent. The messages stay on screen.
export async function compact(thread) {
  const starts = thread.history.map((c, i) => (isUserText(c) ? i : -1)).filter((i) => i >= 0);
  if (size(slim(thread.history)) <= LIMITS.chars && starts.length <= LIMITS.turns) return false;
  const cut = starts[Math.floor(starts.length / 2)];
  if (!cut) return false;
  const old = thread.history.slice(0, cut);
  const readable = old.map((c) => (c.parts || []).map((p) => (p.text && !p.thought ? `${c.role === 'user' ? 'User' : 'Assistant'}: ${p.text}`
    : p.functionCall ? `(used ${p.functionCall.name})` : '')).filter(Boolean).join('\n')).filter(Boolean).join('\n').slice(-60000);
  let summary;
  try {
    summary = await quick(`Summarise this earlier part of a chat between a student and their organiser assistant, so the assistant can carry on. Keep facts, decisions, open questions, and anything the student asked to be done. At most 200 words.\n\n${thread.summary ? `Summary of what came before:\n${thread.summary}\n\n` : ''}${readable}`, 600);
  } catch {
    summary = `${thread.summary || ''}\n(Earlier turns dropped to save space: ${readable.slice(0, 600)}…)`.trim();
  }
  thread.summary = summary;
  thread.history = thread.history.slice(cut);
  return true;
}

// ---- one turn, streamed

// Gemini's stream sends parts in pieces: join neighbouring text, and keep a
// thought signature on the part it arrived with (Gemini 3 needs them back).
function mergeParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && p.text != null && last.text != null && !p.functionCall && !last.functionCall && !!p.thought === !!last.thought
        && !(last.thoughtSignature && p.text)) {
      last.text += p.text;
      if (p.thoughtSignature) last.thoughtSignature = p.thoughtSignature;
    } else {
      out.push({ ...p });
    }
  }
  return out.filter((p) => p.functionCall || p.thoughtSignature || p.text);
}

async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i).replace(/^\r?\n\r?\n/, '');
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
  }
}

// Sends one user turn and runs any tool calls. thread.history is Gemini's own
// shape and is kept intact. `on` gets: text(full), tool({name,args,result}),
// model(id, reason). signal stops it; whatever was written so far is kept.
// reuse: the tool calls a regenerated reply already made ([{name, response}]);
// a tool with side effects is not run twice, its earlier result is reused.
export async function send(thread, userParts, { model, effort, on = {}, signal, reuse = [] } = {}) {
  const spare = reuse.map((r) => ({ ...r }));
  const usable = (await models()).map((m) => m.id);
  if (!usable.includes(model)) model = await defaultModel(); // never send a placeholder or retired name
  const tried = new Set();
  const ctx = { proposed: [], model, effort };
  await compact(thread);
  thread.history.push({ role: 'user', parts: userParts });
  const sys = await systemText(thread);
  let reply = '';
  let noThinking = false;
  const tools = [];
  on.model?.(model);
  for (let step = 0; step < 6; step++) {
    const body = () => ({
      systemInstruction: { parts: [{ text: sys }] },
      contents: slim(thread.history),
      tools: [{ functionDeclarations: TOOLS }],
      generationConfig: noThinking ? { temperature: 0.4 } : { temperature: 0.4, thinkingConfig: thinking(model, effort) },
    });
    let parts = [];
    let busy = 0;
    for (;;) {
      parts = [];
      try {
        const res = await request(`models/${model}:streamGenerateContent?alt=sse`, body(), signal);
        for await (const chunk of sse(res)) {
          const got = chunk.candidates?.[0]?.content?.parts || [];
          parts.push(...got);
          const text = got.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
          if (text) { reply += text; on.text?.(reply); }
        }
        break;
      } catch (err) {
        if (signal?.aborted || err.name === 'AbortError') return finish(true);
        if (err.status === 400 && /thinking/i.test(err.message) && !noThinking) { noThinking = true; continue; }
        // 429: this model's daily quota is gone. 503: overloaded; one retry, then move on.
        if (err.status === 503 && busy++ < 1) { await new Promise((r) => setTimeout(r, 1500)); continue; }
        const next = (err.status === 429 || err.status === 503) && nextModel(model, usable, tried);
        if (!next) throw err;
        on.model?.(next, `${model} ${err.status === 429 ? 'is out of quota' : 'is overloaded'}`);
        model = next;
        ctx.model = model;
        busy = 0;
        if (reply) { reply = ''; on.text?.(''); }
      }
    }
    const msg = { role: 'model', parts: mergeParts(parts) };
    if (!msg.parts.length) throw new Error('Gemini returned nothing (it may have been blocked).');
    thread.history.push(msg);
    const calls = msg.parts.filter((p) => p.functionCall);
    if (!calls.length) return finish(false);
    const responses = [];
    for (const p of calls) {
      const { name, args = {} } = p.functionCall;
      on.tool?.({ name, args });
      let result;
      const before = EFFECTS.has(name) && spare.find((r) => r.name === name && !r.used);
      if (before) {
        before.used = true;
        result = { ...before.response, note: 'Already done when this reply was first written; not repeated.' };
      } else {
        try { result = await runTool(name, args, ctx); } catch (err) { result = { error: String(err.message || err) }; }
      }
      tools.push({ name, args: { path: args.path, title: args.title || args.task_title || args.task_name } });
      on.tool?.({ name, args, result });
      responses.push({ functionResponse: { name, response: result } });
    }
    thread.history.push({ role: 'user', parts: responses });
    if (signal?.aborted) return finish(true);
    if (reply && !reply.endsWith('\n')) reply += '\n\n';
  }
  reply += '(Stopped after several tool steps.)';
  return finish(false);

  function finish(stopped) {
    const last = thread.history[thread.history.length - 1];
    if (stopped) {
      // never leave a call without its answer, or a turn with no reply, in the history
      if (last?.role === 'model' && last.parts.some((p) => p.functionCall)) thread.history.pop();
      const tail = thread.history[thread.history.length - 1];
      if (tail?.role === 'user') thread.history.push({ role: 'model', parts: [{ text: reply || '(stopped)' }] });
    }
    return { reply: reply.trim(), proposed: ctx.proposed, model, tools, stopped };
  }
}

// The user turn (text plus files) that a regenerate or edit starts from.
export function lastUserTurn(history) {
  for (let i = history.length - 1; i >= 0; i--) if (isUserText(history[i])) return i;
  return -1;
}
