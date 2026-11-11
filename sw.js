// Lenas Tagebuch – Service Worker (offline nutzbar, Updates sofort, Benachrichtigungen)
const CACHE = 'lenas-tagebuch-v4';
const ASSETS = ['./', './manifest.json', './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.searchParams.has('check')) return; // Update-Prüfung immer direkt ans Netz

  // Die App-Seite selbst: immer frisch vom Server, als Offline-Kopie unter './' merken
  if (e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html')) {
    e.respondWith(
      fetch(url.href, { cache: 'no-store' })
        .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put('./', copy)); } return res; })
        .catch(() => caches.match('./'))
    );
    return;
  }
  e.respondWith(
    fetch(url.href, { cache: 'no-cache' })
      .then(res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname, copy)); } return res; })
      .catch(() => caches.match(url.pathname))
  );
});

// ---------- Benachrichtigungen ----------
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Lenas Tagebuch', {
    body: d.body || 'Es gibt ein neues Update ✨',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: d.tag || 'update',
    data: { url: d.url || './?open=updates' }
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './?open=updates', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('navigate' in c) return c.navigate(target).then(w => (w || c).focus()); }
    return self.clients.openWindow(target);
  }));
});
