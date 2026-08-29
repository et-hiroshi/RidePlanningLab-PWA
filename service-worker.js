const CACHE = 'ride-planning-lab-72dc8c012356552c';
const PREFIX = 'ride-planning-lab-';
const VERSION = 'ride-planning-service-worker-v3';
const UPDATED_AT = '2026-08-29T21:23:13+09:00';
const ASSETS = ["./app.js", "./apple-touch-icon.png", "./artifacts/ride_planning_runtime_v1.json", "./build-info.json", "./execution_snapshots.js", "./icon-192.png", "./icon-512.png", "./index.html", "./manifest.webmanifest", "./release-info.css", "./runtime/ride_planning_runtime.js", "./style.css", "./index.html?v=ride-planning-ui-v30", "./app.js?v=ride-planning-ui-v30", "./execution_snapshots.js?v=ride-planning-ui-v30", "./runtime/ride_planning_runtime.js?v=ride-planning-ui-v30", "./release-info.css?v=ride-planning-ui-v30"];
const HASHES = {"./app.js": "5126a644f9d0f05ddbb961242458081d65ddd642690e8f63adb36588a70fead3", "./app.js?v=ride-planning-ui-v30": "5126a644f9d0f05ddbb961242458081d65ddd642690e8f63adb36588a70fead3", "./apple-touch-icon.png": "dea6d0cdc5553b0796a748b331d92b7782d347e66e3bc2f5f2388cb2654d43f0", "./artifacts/ride_planning_runtime_v1.json": "ac8259b5b6c7a1eee3411b204020b4c74d5b908549ee4a6771425792ac01e164", "./build-info.json": "0b36d7684971a2591a33bce3588e5f217974d6fc2de92aea59025b5dc18aaf5a", "./execution_snapshots.js": "cdd1196798b85d6a01bfd73966991b339e0ff5629dee06ce049c675fee1aedeb", "./execution_snapshots.js?v=ride-planning-ui-v30": "cdd1196798b85d6a01bfd73966991b339e0ff5629dee06ce049c675fee1aedeb", "./icon-192.png": "85c472b3b016f91b914c643b74ebe203f645653b4b7af594adc549fc31a11113", "./icon-512.png": "58232114f499b870952cb202c80859ede732012bfe9f0469c53576f2befaa529", "./index.html": "39f5a6ea86fc6e90a3c6615beda4fa010cb7b34a6290f4611ea22746bc8a031d", "./index.html?v=ride-planning-ui-v30": "39f5a6ea86fc6e90a3c6615beda4fa010cb7b34a6290f4611ea22746bc8a031d", "./manifest.webmanifest": "d21a2b145385c824d070c4b3f559e042d9b5950af725fed39db8e7696626301f", "./release-info.css": "d486f2b186a7e09fdbe6777cdf33cb317349cfdcd9203609d98529f42a4de497", "./release-info.css?v=ride-planning-ui-v30": "d486f2b186a7e09fdbe6777cdf33cb317349cfdcd9203609d98529f42a4de497", "./runtime/ride_planning_runtime.js": "85440f26890d5ab960a8858ec1ea5173bfa0b9c44ca78bbc51922b06536aa68c", "./runtime/ride_planning_runtime.js?v=ride-planning-ui-v30": "85440f26890d5ab960a8858ec1ea5173bfa0b9c44ca78bbc51922b06536aa68c", "./style.css": "1213eafb81fe4ec7f5ea556b2a7338bc2123087be1fdf21cfa4c546e6d4cfb0f"};
async function sha256(response) {
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
async function verifyCache() {
  const cache = await caches.open(CACHE);
  await Promise.all(Object.entries(HASHES).map(async ([url, expected]) => {
    const response = await cache.match(url);
    if (!response || !response.ok || await sha256(response.clone()) !== expected) {
      throw new Error(`cached asset verification failed: ${url}`);
    }
  }));
  return true;
}
async function populateCache() {
  await caches.delete(CACHE);
  try {
    const cache = await caches.open(CACHE);
    const requests = ASSETS.map(url => new Request(url, { cache: 'reload' }));
    await cache.addAll(requests);
    await verifyCache();
  } catch (error) {
    await caches.delete(CACHE);
    throw error;
  }
}
self.addEventListener('install', event => event.waitUntil(populateCache()));
self.addEventListener('activate', event => event.waitUntil(verifyCache()
  .then(() => caches.keys()).then(keys => Promise.all(keys.filter(
    key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key))))
  .then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.open(CACHE).then(cache => cache.match(event.request)).then(cached => cached || fetch(event.request).catch(async () => {
    if (event.request.mode === 'navigate') return (await caches.open(CACHE)).match(new URL('./index.html?v=ride-planning-ui-v30', self.registration.scope).href);
    throw new Error('offline asset is unavailable');
  })));
});
self.addEventListener('message', event => {
  const reply = value => { if (event.ports && event.ports[0]) event.ports[0].postMessage(value); };
  if (event.data?.type === 'GET_VERSION') {
    reply({cacheId:CACHE,serviceWorkerVersion:VERSION,cacheUpdatedAt:UPDATED_AT,uiVersion:'ride-planning-ui-v30'});
  }
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting().then(() => reply({activated:true})));
  }
  if (event.data?.type === 'VERIFY_ASSETS' || event.data?.type === 'REFRESH_ASSETS') {
    event.waitUntil(verifyCache().then(() => reply({valid:true,refreshed:true,cacheId:CACHE}))
      .catch(error => reply({valid:false,refreshed:false,cacheId:CACHE,error:error.message})));
  }
});
