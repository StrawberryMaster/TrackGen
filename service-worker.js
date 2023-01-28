const cacheName = "cache-v1";

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(cacheName).then(cache => {
            cache.addAll([
                "/",
                "/manifest.json",
                "/index.html",
                "/static/media/favicon.png",
                "/static/media/cyclone.png",
                "/static/media/background.png",
                "/static/media/map.jpg",
                "/static/js/sw.js",
                "/static/js/rsmc.js",
                "/static/js/new_point.js",
                "/static/js/hurdat.js",
                "/static/js/pages.js",
                "/static/js/ibtracs.js",
                "/static/js/manual_input.js",
                "/static/js/generate.js",
                "/static/js/atcf.js",
                "/static/js/file_upload.js",
                "/static/css/style.css"
            ]);
        })
    );
});

self.addEventListener('fetch', e => {
    e.respondWith((async () => {
        const r = await caches.match(e.request);

        console.log('Fetching', e.request.url);

        if (r && !navigator.onLine)
            return r;

        const response = await fetch(e.request);
        const cache = await caches.open(cacheName);

        console.log('Caching', e.request.url);

        cache.put(e.request, response.clone());

        return response;
    })());
});