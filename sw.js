/*
 * sw.js — offline support.
 *
 * Strategy is stale-while-revalidate: a request is answered from the cache
 * immediately (so the app opens instantly and works with no network), while a
 * fresh copy is fetched in the background for next time. Plain cache-first
 * would pin the app to whatever was cached the first time it was opened, which
 * is the wrong trade for a site you push updates to — this way a deploy lands
 * on the next launch without any cache-name bookkeeping.
 *
 * Every path is relative, so this works unchanged whether the app is served
 * from a domain root or a GitHub Pages project subpath.
 */
var CACHE = 'contours-v4';
var ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest', './icon.svg',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './js/rng.js', './js/noise.js', './js/edt.js', './js/field.js',
  './js/contour.js', './js/geom.js', './js/presets.js', './js/generator.js',
  './js/render.js', './js/exporters.js', './js/ui.js', './js/app.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      // one missing file must not fail the whole install
      .then(function (c) {
        return Promise.all(ASSETS.map(function (a) {
          return c.add(a).catch(function () {});
        }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  // only our own files; never get between the page and anything else
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req).then(function (hit) {
        var fresh = fetch(req).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () {
          // offline: the cached copy is the answer, or the shell for a page load
          return hit || (req.mode === 'navigate' ? cache.match('./index.html') : undefined);
        });
        return hit || fresh;
      });
    })
  );
});
