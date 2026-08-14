const CACHE_NAME = 'tdl-schedule-v4';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ネットワークがあれば常に最新のコードを使う(network-first)。
// パーク内などオフライン時のみキャッシュにフォールバックする。
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  // Firebase/Firestoreなど外部オリジンへの通信はService Workerを介さずそのまま流す
  if (new URL(event.request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
