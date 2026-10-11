// The chat. Gemini, called straight from the browser with the key stored on
// this device. It reads the same shared memory as the cloud briefing
// (context/now.md), so the chat and Today always agree.
//
// Changes it makes:
//   - its own memory (notes, schedule changes, to-dos): written at once
//   - the team's ClickUp: only PROPOSED; nothing happens until the user confirms
//   - the "Life" calendar and delegated jobs: queued for the cloud to carry out

import * as gh from './gh.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const TZ = 'Europe/London';

export const settings = {
  get model() { return localStorage.getItem('model') || ''; },
  set model(v) { localStorage.setItem('model', v); },
  get effort() { return localStorage.getItem('effort') || 'medium'; },
  set effort(v) { localStorage.setItem('effort', v); },
};

async function call(path, body) {
  const res = await fetch(`${API}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-goog-api-key': gh.cfg.geminiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Models this key can actually use, newest first, Flash before Pro before Lite.
let modelCache = null;
export async function models() {
  if (modelCache) return modelCache;
  const got = await call('models?pageSize=200');
  const ok = (got.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => ({ id: m.name.split('/').pop(), label: m.displayName || m.name }))
    .filter((m) => /^gemini-\d/.test(m.id) && !/(embedding|tts|image|live|audio|exp|native)/.test(m.id));
  const ver = (id) => parseFloat((id.match(/gemini-(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const rank = (id) => (/-flash$/.test(id) ? 0 : /-pro$/.test(id) ? 1 : /lite/.test(id) ? 2 : 3);
  ok.sort((a, b) => ver(b.id) - ver(a.id) || rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  modelCache = ok;
  return ok;
}

export async function defaultModel() {
  const all = await models();
  return all.find((m) => m.id === settings.model)?.id || all.find((m) => /-flash$/.test(m.id))?.id || all[0]?.id;
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
  { name: 'complete_todo', description: 'Mark a personal to-do done.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
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
    case 'remember': {
      const current = (await gh.readText('memory/notes.md')) || '# What the organiser has learned\n';
      await gh.write('memory/notes.md', `${current.trimEnd()}\n- ${today}: ${a.fact}\n`, 'app: remember');
      return { saved: a.fact };
    }
    case 'change_schedule': {
      const item = { id: gh.id(), title: a.title, start: a.start, end: a.end || null, location: a.location || '',
                     note: a.note, created: new Date().toISOString(), source: 'chat' };
      await gh.update('schedule/overrides.json', (list) => [...list, item], [], 'app: schedule change');
      return { recorded: item };
    }
    case 'cancel_schedule_change':
      await gh.update('schedule/overrides.json', (list) => list.map((o) => (o.id === a.id ? { ...o, cancelled: true } : o)), [], 'app: cancel change');
      return { cancelled: a.id };
    case 'add_todo': {
      const item = { id: gh.id(), title: a.title, due: a.due || null, done: false, created: new Date().toISOString() };
      await gh.update('schedule/todos.json', (list) => [...list, item], [], 'app: todo');
      return { added: item };
    }
    case 'complete_todo':
      await gh.update('schedule/todos.json', (list) => list.map((t) => (t.id === a.id ? { ...t, done: true } : t)), [], 'app: todo done');
      return { done: a.id };
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

async function systemText() {
  const [now, overrides, todos] = await Promise.all([
    gh.readText('context/now.md').catch(() => gh.cachedText('context/now.md')),
    gh.readJSON('schedule/overrides.json', []).catch(() => []),
    gh.readJSON('schedule/todos.json', []).catch(() => []),
  ]);
  return `You are the organiser inside the user's own app: one assistant with one memory,
the same one that writes their Today briefing. Who they are is in the memory below.

Current time: ${nowLondon()}.

Be brief and concrete; they read this on a phone. Never invent schedule facts.
When they report a change (meeting moved, new event, something to remember), use the tools
to record it, then confirm in one line. ClickUp belongs to their whole group: only ever
PROPOSE changes there; say they are waiting for their Confirm. If you need detail from a
lecture, email or file, read it with read_file rather than guessing.

Schedule changes recorded via chat (id, title, start, note):
${JSON.stringify(overrides.filter((o) => !o.cancelled).slice(-30))}

Personal to-dos:
${JSON.stringify(todos.filter((t) => !t.done).slice(-50))}

EVERYTHING THE ORGANISER KNOWS RIGHT NOW:
${now || '(the shared memory has not been built yet)'}`;
}

// history: [{role:'user'|'model', parts:[...]}] in Gemini's own shape, kept intact
// (Gemini 3 needs its thought signatures handed back unchanged).
export async function send(history, text, { model, effort, onTool } = {}) {
  const usable = (await models()).map((m) => m.id);
  if (!usable.includes(model)) model = await defaultModel(); // never send a placeholder or retired name
  const ctx = { proposed: [], model, effort };
  const contents = [...history, { role: 'user', parts: [{ text }] }];
  const body = () => ({
    systemInstruction: { parts: [{ text: sys }] },
    contents,
    tools: [{ functionDeclarations: TOOLS }],
    generationConfig: { temperature: 0.4, thinkingConfig: thinking(model, effort) },
  });
  const sys = await systemText();
  for (let step = 0; step < 6; step++) {
    let out;
    try {
      out = await call(`models/${model}:generateContent`, body());
    } catch (err) {
      if (err.status === 400 && /thinking/i.test(err.message)) {
        out = await call(`models/${model}:generateContent`, { ...body(), generationConfig: { temperature: 0.4 } });
      } else throw err;
    }
    const msg = out.candidates?.[0]?.content;
    if (!msg) throw new Error('Gemini returned nothing (it may have been blocked).');
    contents.push(msg);
    const calls = (msg.parts || []).filter((p) => p.functionCall);
    if (!calls.length) {
      const reply = (msg.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      return { history: contents, reply, proposed: ctx.proposed, model };
    }
    const responses = [];
    for (const p of calls) {
      onTool?.(p.functionCall.name);
      let result;
      try { result = await runTool(p.functionCall.name, p.functionCall.args || {}, ctx); }
      catch (err) { result = { error: String(err.message || err) }; }
      responses.push({ functionResponse: { name: p.functionCall.name, response: result } });
    }
    contents.push({ role: 'user', parts: responses });
  }
  return { history: contents, reply: '(Stopped after several tool steps.)', proposed: ctx.proposed, model };
}
