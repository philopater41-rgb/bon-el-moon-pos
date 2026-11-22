const CACHE_NAME = 'bon-pos-shell-v2';
const SHELL_PATH = '/pos';

// Cache only the POS application shell and versioned static assets. Never cache
// API responses: orders and inventory remain in IndexedDB / the server.
async function cacheShell() {
  const response = await fetch(SHELL_PATH, { cache: 'reload' });
  if (!response.ok) throw new Error('Could not load POS shell');
  const html = await response.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="(\/_next\/static\/[^"?#]+(?:\?[^"#]*)?)"/g)]
    .map(match => match[1].replace(/&amp;/g, '&'));
  const cache = await caches.open(CACHE_NAME);
  await cache.put(SHELL_PATH, response);
  await Promise.all([...new Set(assets)].map(async asset => {
    const result = await fetch(asset, { cache: 'reload' });
    if (!result.ok) throw new Error(`Could not cache asset: ${asset}`);
    await cache.put(asset, result);
  }));
  await cache.addAll(['/bon-logo.jpg', '/brand-color.jpeg']);
}

self.addEventListener('install', event => {
  event.waitUntil(cacheShell().then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(fetch(request).catch(() => Response.redirect(new URL(SHELL_PATH, self.location.origin).href)));
    return;
  }
  if (request.mode === 'navigate' && (url.pathname === '/pos' || url.pathname === '/pos/')) {
    event.respondWith(fetch(request).then(async response => {
      if (response.ok) await (await caches.open(CACHE_NAME)).put(SHELL_PATH, response.clone());
      return response;
    }).catch(async () => (await (await caches.open(CACHE_NAME)).match(SHELL_PATH)) || Response.error()));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || (url.pathname === '/bon-logo.jpg' || url.pathname === '/brand-color.jpeg')) {
    event.respondWith(caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    }));
  }
});
