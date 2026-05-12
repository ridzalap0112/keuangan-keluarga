// ============================================================
//  Keuangan Keluarga — Service Worker
//  Handles caching for offline support
// ============================================================

const CACHE_NAME = 'keuangan-keluarga-v1';
const ASSETS = [
  '/keuangan-keluarga/',
  '/keuangan-keluarga/index.html',
  '/keuangan-keluarga/manifest.json',
  '/keuangan-keluarga/icon-192.png',
  '/keuangan-keluarga/icon-512.png'
];

// Install — cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate — delete old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Don't cache Google Apps Script requests (always needs network)
  if (event.request.url.includes('script.google.com') ||
      event.request.url.includes('googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(cached => {
        if (cached) return cached;
        return fetch(event.request)
          .then(response => {
            // Cache new requests dynamically
            if (response && response.status === 200 && response.type === 'basic') {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            }
            return response;
          })
          .catch(() => {
            // Offline fallback — return cached index
            if (event.request.destination === 'document') {
              return caches.match('/keuangan-keluarga/index.html');
            }
          });
      })
  );
});

// Background sync — retry failed transactions when back online
self.addEventListener('sync', event => {
  if (event.tag === 'sync-transactions') {
    event.waitUntil(syncPendingTransactions());
  }
});

async function syncPendingTransactions() {
  // Notify all clients to reload data
  const clients = await self.clients.matchAll();
  clients.forEach(client => {
    client.postMessage({ type: 'SYNC_REQUIRED' });
  });
}
