/*
 * GatePass scanner service worker (registered by /scan with scope /scan).
 *
 * Caches only the static app shell, so a door phone can open the scanner
 * without a connection and show that it is offline:
 *   - navigations: network first; the last good /scan page is the offline fallback
 *   - /assets/*: cache first (file names carry a content hash, so they never change)
 *   - everything else, and in particular /api/* and /p/*: not handled here, so
 *     the browser goes to the network as if there were no service worker.
 * Verdicts, sessions and pass pages are never cached or answered from a cache:
 * every admission needs a live server answer (fail closed).
 */
const VERSION = 'v1';
const SHELL_CACHE = `gatepass-shell-${VERSION}`;
const ASSET_CACHE = `gatepass-assets-${VERSION}`;
const SHELL_URL = '/scan';
/** Hashed assets from older releases pile up; keep the newest this many. */
const MAX_ASSETS = 60;
/** A navigation that takes longer than this falls back to the cached shell (venue Wi-Fi can hang). */
const NAVIGATION_TIMEOUT_MS = 5000;

const isNetworkOnly = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/p/');
const isAsset = (url) => url.origin === self.location.origin && url.pathname.startsWith('/assets/') && !isNetworkOnly(url);

async function trimAssets() {
  const cache = await caches.open(ASSET_CACHE);
  const keys = await cache.keys();
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)));
}

async function cacheAssets(urls) {
  const cache = await caches.open(ASSET_CACHE);
  for (const href of urls) {
    const url = new URL(href, self.location.origin);
    if (!isAsset(url) || (await cache.match(url.href))) continue;
    try {
      const response = await fetch(url.href);
      if (response.ok && response.type === 'basic') await cache.put(url.href, response);
    } catch {
      // Offline or gone: the next load caches it.
    }
  }
  await trimAssets();
}

/** Stores a good shell page and the hashed assets it names, so the next start works offline. */
async function rememberShell(response) {
  const html = await response.clone().text();
  await (await caches.open(SHELL_CACHE)).put(SHELL_URL, response);
  await cacheAssets([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const response = await fetch(SHELL_URL, { cache: 'no-cache' });
        if (response.ok) await rememberShell(response);
      } catch {
        // Installed without a shell; the next online navigation stores it.
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE]);
      for (const name of await caches.keys()) if (name.startsWith('gatepass-') && !keep.has(name)) await caches.delete(name);
      await self.clients.claim();
    })()
  );
});

/** The page sends the hashed files it loaded before this worker controlled it (fonts, the decoder). */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'cache-assets' && Array.isArray(data.urls)) event.waitUntil(cacheAssets(data.urls.filter((url) => typeof url === 'string').slice(0, 100)));
});

async function navigate(event) {
  const network = fetch(event.request).then(async (response) => {
    if (response.ok && new URL(response.url || event.request.url).pathname.startsWith(SHELL_URL)) event.waitUntil(rememberShell(response.clone()));
    return response;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NAVIGATION_TIMEOUT_MS, null));
  network.catch(() => undefined); // a late failure after the cached shell was served is not an error
  try {
    const first = await Promise.race([network, timeout]);
    if (first) return first;
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
    return cached ?? (await network);
  } catch {
    const cached = await caches.match(SHELL_URL, { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw new Error('Offline and no cached scanner app');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone());
    await trimAssets();
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isNetworkOnly(url)) return;
  if (request.mode === 'navigate') event.respondWith(navigate(event));
  else if (isAsset(url)) event.respondWith(cacheFirst(request));
});
