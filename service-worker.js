const CACHE = 'ride-planning-lab-890d6e07af2b3bd9';
const PREFIX = 'ride-planning-lab-';
const ASSETS = ["./.nojekyll", "./_headers", "./app.js", "./apple-touch-icon.png", "./artifacts/ride_planning_runtime_v1.json", "./icon-192.png", "./icon-512.png", "./index.html", "./manifest.webmanifest", "./runtime/ride_planning_runtime.js", "./style.css"];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).catch(() => {
    if (event.request.mode === 'navigate') return caches.match(new URL('./index.html', self.registration.scope).href);
    throw new Error('offline asset is unavailable');
  })));
});
