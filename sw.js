const CACHE_NAME = 'offline-cache-v1';
const ASSETS = ["./", "./index.html", "./manifest.json"];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request).then(cached => {
            return cached || fetch(event.request).then(response => {
                return caches.open(CACHE_NAME).then(cache => {
                    if (event.request.method === 'GET' && response.status === 200) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                });
            }).catch(() => caches.match('./index.html'));
        })
    );
});
