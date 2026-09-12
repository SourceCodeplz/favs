/* FAVS service worker — offline shell with dev-safe cache busting.
 *
 * Strategy:
 * - Navigations (HTML): network-first, so deploys show up immediately and
 *   the fresh HTML pulls the current ?v= asset URLs. Falls back to cache
 *   (then index.html) when offline.
 * - Same-origin static assets (CSS/JS/icons with ?v=): stale-while-revalidate.
 *   Bumping ?v= in HTML creates a new URL, so it bypasses the old entry
 *   automatically — no stale CSS/JS while developing.
 * Bump CACHE below when changing the precached shell.
 */
'use strict';

var CACHE = 'favs-v1';

var PRECACHE = [
  './',
  'index.html',
  'vault.html',
  'settings.html',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE) return caches.delete(key);
        return null;
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

function isSameOrigin(url) {
  return url.origin === self.location.origin;
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (!isSameOrigin(url)) return; // never cache third-party (favicons, search)

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && (res.status === 200 || res.type === 'opaque')) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || network;
    })
  );
});
