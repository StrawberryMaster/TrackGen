const appPrefix = 'TrackGen';
const appVersion = 'v1.0.9';
const cacheName = `${appPrefix}-${appVersion}`;

// static list of files to cache
const filesToCache = [
    './',
    './index.html',
    './manifest.webmanifest',
    
    // CSS
    './static/css/style.css',
    
    // JS
    './static/js/sw.js',
    './static/js/pages.js',
    './static/js/generate.js',
    './static/js/new_point.js',
    './static/js/atcf.js',
    './static/js/rsmc.js',
    './static/js/hurdat.js',
    './static/js/ibtracs.js',
    './static/js/storms.js',
    './static/js/file_upload.js',
    './static/js/manual_input.js',
    './static/js/export.js',
    './static/js/export-hurdat.js',
    
    // media (exclude large maps)
    './static/media/favicon.png',
    './static/media/cyclone.png',
    './static/media/background.png',
    './static/media/background-dark.png',
    './static/media/bg8192.png',
    './static/media/bg12000.jpg',
    './static/media/bg13500-blkmar.jpg',
    './static/media/bg21600-nxtgen.jpg'
];

function isImage(request) {
    return request.destination === 'image' || request.url.match(/\.(png|jpg|jpeg|webp|gif)$/i);
}

function isCachable(request) {
    const url = new URL(request.url);
    if (url.origin !== location.origin) return false;
    
    // normalize pathname for comparison
    const pathname = url.pathname.replace(/^\/TrackGen/, '') || '/';
    const relativePath = './' + pathname.replace(/^\//, '');
    
    return filesToCache.includes(relativePath) || filesToCache.includes(pathname);
}

async function staleWhileRevalidate(request) {
    const cache = await caches.open(cacheName);
    const cachedResponse = await cache.match(request);

    const fetchPromise = fetch(request).then(response => {
        if (response.ok) {
            cache.put(request, response.clone());
        }
        console.log(`Updated cache for URL ${request.url}.`);
        return response;
    });

    return cachedResponse || fetchPromise;
}

async function cacheFirstWithRefresh(request) {
    try {
        const fetchResponsePromise = fetch(request).then(async networkResponse => {
            if (networkResponse.ok) {
                const cache = await caches.open(cacheName);
                cache.put(request, networkResponse.clone());
            }
            console.log(`Fetched URL ${request.url} from network.`);
            return networkResponse;
        });

        return Promise.race([
            fetchResponsePromise,
            caches.match(request)
        ]);
    } catch (error) {
        console.error(`Failed to fetch ${request.url} from cache or network.`);
        throw error;
    }
}

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(cacheName).then(cache => {
            return cache.addAll(filesToCache);
        }).catch(error => {
            console.error('Failed to cache files during install:', error);
        })
    );
});

function waitForActiveServiceWorker() {
    return new Promise((resolve) => {
        if (self.registration.active) {
            resolve(self.registration);
        } else {
            self.addEventListener('activate', () => {
                resolve(self.registration);
            });
        }
    });
}

self.addEventListener('fetch', async (event) => {
    event.respondWith(
        waitForActiveServiceWorker().then(() => {
            const request = event.request;

            if (!isCachable(request)) {
                return fetch(request);
            }

            if (isImage(request)) {
                return staleWhileRevalidate(request);
            } else {
                return cacheFirstWithRefresh(request);
            }
        })
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.filter(name => {
                    return name.startsWith(appPrefix) && name !== cacheName;
                }).map(name => {
                    return caches.delete(name);
                })
            );
        })
    );
});
