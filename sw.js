/* Minimal offline cache. Bump CACHE when files change. */
var CACHE = 'contours-v2';
var ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './js/rng.js', './js/noise.js', './js/edt.js', './js/field.js',
  './js/contour.js', './js/geom.js', './js/presets.js', './js/generator.js',
  './js/render.js', './js/exporters.js', './js/ui.js', './js/app.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); })
    .then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

/* Cache first — the app is fully offline capable and has no backend. */
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () { return caches.match('./index.html'); });
    })
  );
});
