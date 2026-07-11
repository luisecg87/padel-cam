// Service worker de Pádel Cam: hace la app instalable (PWA) y jugable sin
// conexión (modos sin cámara) después de la primera visita.
//
// Estrategia por tipo de recurso:
//  - Navegaciones (index.html): RED PRIMERO con respaldo de caché → cada
//    deploy llega a los usuarios en cuanto tienen conexión; sin conexión se
//    sirve la última versión vista. Así el SW nunca "ancla" una versión rota.
//  - /assets/ (ficheros con hash de Vite, inmutables entre builds): CACHÉ
//    PRIMERO. Un build nuevo cambia el hash, así que nunca hay conflicto.
//  - Resto del mismo origen (iconos, manifest…): caché con revalidación en
//    segundo plano.
//  - Orígenes externos (CDNs de MediaPipe, señalización de PeerJS): SIEMPRE
//    red, sin cachear. Sin conexión solo se pierde el modo cámara y el
//    online, como documenta PLAN.md.

const CACHE = 'padelcam-v1';
const SHELL = ['./', 'manifest.webmanifest', 'favicon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await c.addAll(SHELL);
      // Precachea también los ficheros con hash del build actual leyendo el
      // HTML: el juego funciona sin conexión desde la primera visita.
      try {
        const html = await (await fetch('./')).text();
        const assets = [...html.matchAll(/(?:src|href)="(\.\/assets\/[^"]+)"/g)].map((m) => m[1]);
        await c.addAll(assets);
      } catch {
        // Sin red durante la instalación: los assets se cachean al navegar
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Navegación: red primero, respaldo del caché si no hay conexión
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./')),
    );
    return;
  }

  // Ficheros con hash: caché primero (inmutables)
  if (url.pathname.includes('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Resto del mismo origen: caché al instante + actualización en segundo plano
  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => hit);
      return hit ?? net;
    }),
  );
});
