// Keeps the app opening instantly, even with no signal. Bump CACHE whenever a
// shipped file changes: the new worker installs alongside the old one and waits;
// the app shows "A new version is ready · Reload", and Reload swaps it in.
// Data never goes through here: it comes from the GitHub API and the app caches it.
const CACHE = 'life-v14';
const SHELL = ['./', './index.html', './offline.html', './styles.css', './app.js', './gh.js', './ai.js', './md.js', './chat.js',
  './threads.js', './icons.js', './ui.js', './organise.js',
  './store.js', './format.js', './parts.js', './shell.js', './today.js', './uni.js', './mail.js', './settings.js', './sheets.js',
  './gestures.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './icons/icon-maskable-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
  // no skipWaiting here: the page decides when to switch (no mixed versions mid-use)
});

self.addEventListener('message', (e) => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // Pages: the network if it answers within 3 s, else the cached app, else the offline page.
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await Promise.race([fetch(e.request), new Promise((_, no) => setTimeout(() => no(new Error('slow')), 3000))]);
        if (res.ok) cache.put('./index.html', res.clone());
        return res;
      } catch {
        return (await cache.match('./index.html')) || (await cache.match('./offline.html')) || Response.error();
      }
    })());
    return;
  }
  // Everything else in the shell: from the cache at once, refreshed in the background.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => { if (res.ok) cache.put(e.request, res.clone()); return res; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    try { return await net; } catch { return Response.error(); }
  })());
});
