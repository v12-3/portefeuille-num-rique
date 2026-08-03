/* Service worker de l'app mobile.
   Coquille en cache pour un démarrage hors réseau. Les appels Firebase
   (Auth, Firestore, Cloud Functions) partent vers des origines Google
   distinctes (googleapis.com, cloudfunctions.net) : le filtre d'origine
   ci-dessous les laisse passer sans interférer — le SDK Firestore gère
   lui-même son propre cache hors-ligne (IndexedDB). */
'use strict';

const CACHE = 'patrimoine-shell-v10';
const SHELL = [
  '/m/', '/m/index.html', '/m/world-exposure.html', '/m/manifest.webmanifest',
  '/m/icon-192.png', '/m/icon-512.png',
  '/firebase-config.js?v=7', '/app-core.js?v=7', '/firebase-client.js?v=7'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // laisse passer tout ce qui n'est pas un GET same-origin (POST, requêtes Firebase
  // vers d'autres domaines, etc.) sans passer par le cache de la coquille.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/m/index.html')))
  );
});
