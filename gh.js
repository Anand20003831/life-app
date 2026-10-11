// GitHub contents API: the only way this app reads or writes the private
// life-data repo. The token is a fine-grained PAT scoped to that repo alone
// (Contents read/write, Actions read/write). It lives in localStorage on each
// device and is only ever sent to api.github.com.

// apiBase is a local-testing hook (a mock server); unset in real use.
const API = localStorage.getItem('apiBase') || 'https://api.github.com';

export const cfg = {
  get owner() { return localStorage.getItem('owner') || ''; },
  get repo() { return localStorage.getItem('repo') || 'life-data'; },
  get token() { return localStorage.getItem('ghToken') || ''; },
  get geminiKey() { return localStorage.getItem('geminiKey') || ''; },
};

export function configured() {
  return Boolean(cfg.owner && cfg.token && cfg.geminiKey);
}

function headers(accept = 'application/vnd.github+json') {
  return { Authorization: `Bearer ${cfg.token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
}

function url(path) {
  return `${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const enc = new TextEncoder();
function b64(text) {
  const bytes = typeof text === 'string' ? enc.encode(text) : text;
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Raw file text. Cached in localStorage so the app opens instantly and offline;
// the network copy replaces it when it arrives.
export async function readText(path, { cache = true } = {}) {
  const res = await fetch(url(path) + `?t=${Date.now()}`, { headers: headers('application/vnd.github.raw+json') });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}`);
  const text = await res.text();
  if (cache && text.length < 400000) {
    try { localStorage.setItem(`c:${path}`, text); } catch { /* storage full: fine, just not cached */ }
  }
  return text;
}

export function cachedText(path) {
  return localStorage.getItem(`c:${path}`);
}

export async function readJSON(path, fallback = null) {
  const t = await readText(path);
  return t == null ? fallback : JSON.parse(t);
}

export function cachedJSON(path, fallback = null) {
  const t = cachedText(path);
  try { return t == null ? fallback : JSON.parse(t); } catch { return fallback; }
}

export async function list(dir) {
  const res = await fetch(url(dir) + `?t=${Date.now()}`, { headers: headers() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub ${res.status} listing ${dir}`);
  return res.json();
}

async function sha(path) {
  const res = await fetch(url(path) + `?t=${Date.now()}`, { headers: headers() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}`);
  return (await res.json()).sha;
}

// Write a file. Retries once on a sha conflict (a cloud job wrote it meanwhile).
export async function write(path, content, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = { message: message || `app: ${path}`, content: b64(content) };
    const s = await sha(path);
    if (s) body.sha = s;
    const res = await fetch(url(path), { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
    if (res.ok) {
      if (typeof content === 'string') {
        try { localStorage.setItem(`c:${path}`, content); } catch { /* fine */ }
      }
      return;
    }
    if (res.status !== 409 && res.status !== 422) throw new Error(`GitHub ${res.status} writing ${path}`);
  }
  throw new Error(`Couldn't write ${path}: it kept changing underneath`);
}

// Read-modify-write a JSON file through a function, retrying on conflict.
export async function update(path, fn, fallback, message) {
  const current = await readJSON(path, fallback);
  const next = fn(current);
  await write(path, JSON.stringify(next, null, 1) + '\n', message);
  return next;
}

// Upload a browser File. Anything over CHUNK is split into numbered parts plus
// a <name>.chunks.json index, the same shape the cloud jobs write.
const CHUNK = 20 * 1024 * 1024;
export async function upload(dir, file, onProgress) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.replace(/[^A-Za-z0-9._ -]/g, '_');
  if (bytes.length <= CHUNK) {
    await write(`${dir}/${name}`, bytes, `app: attach ${name}`);
    return `${dir}/${name}`;
  }
  const parts = [];
  for (let i = 0, n = 0; i < bytes.length; i += CHUNK, n++) {
    const part = `${name}.part${String(n).padStart(3, '0')}.txt`;
    onProgress?.(`${name}: part ${n + 1} of ${Math.ceil(bytes.length / CHUNK)}`);
    await write(`${dir}/${part}`, bytes.subarray(i, i + CHUNK), `app: attach ${part}`);
    parts.push(part);
  }
  const index = `${dir}/${name}.chunks.json`;
  await write(index, JSON.stringify({ file: name, parts, bytes: bytes.length }, null, 1), `app: attach ${name}`);
  return index;
}

// Read a file the cloud may have split into chunks, joined back together.
export async function readMaybeChunked(path) {
  if (!path.endsWith('.chunks.json')) return readText(path, { cache: false });
  const meta = JSON.parse(await readText(path, { cache: false }));
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  const parts = await Promise.all(meta.parts.map((p) => readText(dir + p.split('/').pop(), { cache: false })));
  return parts.join('');
}

// Can this token actually see the repo? GitHub answers 404 (not 403) for a
// private repo the token can't access, which otherwise looks like "no files yet".
export async function checkAccess() {
  const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}`, { headers: headers() });
  if (res.status === 401) throw new Error('GitHub rejected the token (expired, revoked or mistyped). Make a new one and paste it in Settings.');
  if (res.status === 404) throw new Error(`This token can't see "${cfg.owner}/${cfg.repo}". Check the repo name, and that the token's Repository access includes life-data.`);
  if (!res.ok) throw new Error(`GitHub ${res.status} checking the repo`);
  const repo = await res.json();
  if (repo.permissions && !repo.permissions.push) throw new Error('The token can read but not write. Set Contents to "Read and write".');
  return repo;
}

export async function dispatch(workflow) {
  const res = await fetch(`${API}/repos/${cfg.owner}/${cfg.repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST', headers: headers(), body: JSON.stringify({ ref: 'main' }),
  });
  if (!res.ok) throw new Error(`Couldn't start ${workflow} (${res.status}). Does the token have Actions: write?`);
}

export function id() {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}
