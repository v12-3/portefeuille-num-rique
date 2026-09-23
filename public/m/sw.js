/* Service worker de l'app mobile.
   Coquille en cache pour un démarrage hors réseau. Les appels Firebase
   (Auth, Firestore) et le service de cotations partent vers d'autres
   origines : le filtre d'origine ci-dessous les laisse passer sans y toucher —
   le SDK Firestore gère lui-même son cache hors-ligne (IndexedDB). */
'use strict';

const CACHE = 'patrimoine-shell-v15';
const SHELL = [
  '/m/', '/m/index.html', '/m/manifest.webmanifest',
  '/m/icon-192.png', '/m/icon-512.png',
  '/firebase-config.js?v=11', '/app-core.js?v=11', '/ui-kit.js?v=11', '/firebase-client.js?v=11'
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
  // laisse passer tout ce qui n'est pas un GET same-origin (POST, Firebase,
  // cotations…) sans passer par le cache de la coquille.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // seules les réponses complètes et valides remplacent la copie en cache
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || (e.request.mode === 'navigate' ? caches.match('/m/index.html') : Response.error())))
  );
});
