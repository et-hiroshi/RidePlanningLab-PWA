const CACHE = 'ride-planning-lab-10cbdf09c4920455';
const PREFIX = 'ride-planning-lab-';
const VERSION = 'ride-planning-service-worker-v3';
const UPDATED_AT = '2026-09-03T08:21:57+09:00';
const ASSETS = ["./app.js", "./apple-touch-icon.png", "./artifacts/ride_planning_runtime_v1.json", "./build-info.json", "./execution_snapshots.js", "./icon-192.png", "./icon-512.png", "./index.html", "./manifest.webmanifest", "./release-info.css", "./runtime/ride_planning_runtime.js", "./style.css", "./index.html?v=ride-planning-ui-v38", "./app.js?v=ride-planning-ui-v38", "./execution_snapshots.js?v=ride-planning-ui-v38", "./runtime/ride_planning_runtime.js?v=ride-planning-ui-v38", "./release-info.css?v=ride-planning-ui-v38"];
const HASHES = {"./app.js": "9917abdd3147e083c2a46357d2ae35e33f44294de18f6c4d7a0c65e71ae9866a", "./app.js?v=ride-planning-ui-v38": "9917abdd3147e083c2a46357d2ae35e33f44294de18f6c4d7a0c65e71ae9866a", "./apple-touch-icon.png": "dea6d0cdc5553b0796a748b331d92b7782d347e66e3bc2f5f2388cb2654d43f0", "./artifacts/ride_planning_runtime_v1.json": "f0a948feefd106a7f638cdf8fb248d4b4e91409b1513033faa6a5bb860fa71c3", "./build-info.json": "ad9407e59557f048ea3cfa8b6e7219f63fb8f763dfee40efe485e3c6b4fcb740", "./execution_snapshots.js": "0db4605e1c9732f539d5c5993edef2f4c2efa380d2d8fabe516d94bc101f2c3f", "./execution_snapshots.js?v=ride-planning-ui-v38": "0db4605e1c9732f539d5c5993edef2f4c2efa380d2d8fabe516d94bc101f2c3f", "./icon-192.png": "85c472b3b016f91b914c643b74ebe203f645653b4b7af594adc549fc31a11113", "./icon-512.png": "58232114f499b870952cb202c80859ede732012bfe9f0469c53576f2befaa529", "./index.html": "c3e57e4ca1319b246f989791ed1793efcee25f0d23d1ed8c1e3170e3b1ecdeb8", "./index.html?v=ride-planning-ui-v38": "c3e57e4ca1319b246f989791ed1793efcee25f0d23d1ed8c1e3170e3b1ecdeb8", "./manifest.webmanifest": "d21a2b145385c824d070c4b3f559e042d9b5950af725fed39db8e7696626301f", "./release-info.css": "8d74a940ffe93af4805531576cefc2c2cea785af1891968723a3351e329f751d", "./release-info.css?v=ride-planning-ui-v38": "8d74a940ffe93af4805531576cefc2c2cea785af1891968723a3351e329f751d", "./runtime/ride_planning_runtime.js": "85440f26890d5ab960a8858ec1ea5173bfa0b9c44ca78bbc51922b06536aa68c", "./runtime/ride_planning_runtime.js?v=ride-planning-ui-v38": "85440f26890d5ab960a8858ec1ea5173bfa0b9c44ca78bbc51922b06536aa68c", "./style.css": "0cf158fa6ce28465aaccdaa39d4a08e2f8748896c3c77aa3fb773bebd6771f19"};
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
    if (event.request.mode === 'navigate') return (await caches.open(CACHE)).match(new URL('./index.html?v=ride-planning-ui-v38', self.registration.scope).href);
    throw new Error('offline asset is unavailable');
  })));
});
self.addEventListener('message', event => {
  const reply = value => { if (event.ports && event.ports[0]) event.ports[0].postMessage(value); };
  if (event.data?.type === 'GET_VERSION') {
    reply({cacheId:CACHE,serviceWorkerVersion:VERSION,cacheUpdatedAt:UPDATED_AT,uiVersion:'ride-planning-ui-v38'});
  }
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting().then(() => reply({activated:true})));
  }
  if (event.data?.type === 'VERIFY_ASSETS' || event.data?.type === 'REFRESH_ASSETS') {
    event.waitUntil(verifyCache().then(() => reply({valid:true,refreshed:true,cacheId:CACHE}))
      .catch(error => reply({valid:false,refreshed:false,cacheId:CACHE,error:error.message})));
  }
});
