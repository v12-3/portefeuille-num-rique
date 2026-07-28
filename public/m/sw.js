/* Service worker de l'app mobile.
   Coquille en cache pour un démarrage hors réseau ; l'API reste toujours réseau d'abord. */
'use strict';

const CACHE = 'patrimoine-shell-v2';
const SHELL = ['/m/', '/m/index.html', '/m/world-exposure.html', '/m/manifest.webmanifest', '/m/icon-192.png', '/m/icon-512.png'];

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
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // l'API n'est jamais servie depuis le cache : les cotations doivent être fraîches
  // (l'app garde elle-même le dernier instantané dans localStorage)
  if (url.pathname.startsWith('/api/')) return;

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
