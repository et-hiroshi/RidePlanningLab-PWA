const CACHE = 'ride-planning-lab-fc28f09676bff3ff';
const PREFIX = 'ride-planning-lab-';
const VERSION = 'ride-planning-service-worker-v2';
const UPDATED_AT = '2026-07-31T18:27:27+09:00';
const ASSETS = ["./app.js", "./apple-touch-icon.png", "./artifacts/ride_planning_runtime_v1.json", "./build-info.json", "./execution_snapshots.js", "./icon-192.png", "./icon-512.png", "./index.html", "./manifest.webmanifest", "./release-info.css", "./runtime/ride_planning_runtime.js", "./style.css", "./index.html?v=ride-planning-ui-v15", "./app.js?v=ride-planning-ui-v15", "./execution_snapshots.js?v=ride-planning-ui-v15", "./release-info.css?v=ride-planning-ui-v15"];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).catch(() => {
    if (event.request.mode === 'navigate') return caches.match(new URL('./index.html?v=ride-planning-ui-v15', self.registration.scope).href);
    throw new Error('offline asset is unavailable');
  })));
});
self.addEventListener('message', event => {
  const reply = value => { if (event.ports && event.ports[0]) event.ports[0].postMessage(value); };
  if (event.data?.type === 'GET_VERSION') {
    reply({cacheId:CACHE,serviceWorkerVersion:VERSION,cacheUpdatedAt:UPDATED_AT});
  }
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting().then(() => reply({activated:true})));
  }
  if (event.data?.type === 'REFRESH_ASSETS') {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))
      .then(() => caches.keys()).then(keys => Promise.all(keys.filter(
        key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
      .then(() => reply({refreshed:true,cacheId:CACHE})));
  }
});
