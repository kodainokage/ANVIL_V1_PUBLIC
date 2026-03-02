// ANVIL Service Worker - Basic offline caching
const CACHE_NAME = 'anvil-v2';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/about.html',
  '/terms.html',
  '/privacy.html',
  '/disclaimer.html',
  '/manifest.json',
  '/learn.html',
  '/certificate.html',
  '/admin.html',
  '/marketing.html'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_URLS).catch((err) => {
        // Don't fail install if some resources aren't available yet
        console.warn('Cache addAll failed:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch - network first, fall back to cache
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip API requests - always go to network
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    Promise.race([
      fetch(event.request).then((response) => {
        // Clone response before caching
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      }),
      // 10-second timeout for fetch
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Fetch timeout')), 10000)
      )
    ]).catch(() => {
      // Network failed or timeout, try cache
      return caches.match(event.request).then((response) => {
        return response || new Response('Offline - content not available', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: new Headers({ 'Content-Type': 'text/plain' })
        });
      });
    })
  );
});
