/* Planches — fonctionnement hors ligne.
 * La page et ses scripts restent disponibles sans réseau ; les BD, elles, sont gardées par la page
 * dans IndexedDB. Chaque déploiement change VERSION : l'ancien cache est alors effacé. */
const VERSION = 'planches-202611072124';
const VENDOR = 'planches-vendor-1'; // pdf.js et pako : ne changent pas d'une version à l'autre
const SHELL = [
  './',
  'manifest.webmanifest',
  'config.js?v=202611072124',
  'formats.js?v=202611072124',
  'rar-worker.js?v=202611072124',
  'pako_inflate.min.js',
  'icone-32.png',
  'icone-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' : jamais une copie périmée du cache HTTP du navigateur
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('planches-') && k !== VERSION && k !== VENDOR).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function keep(cacheName, req, res) {
  if (res && (res.ok || res.type === 'opaque')) {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const same = url.origin === self.location.origin;
  const fonts = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!same && !fonts) return;

  // la page : la plus récente si le réseau répond, sinon celle gardée
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => keep(VERSION, './', res))
        .catch(() => caches.match('./', { cacheName: VERSION }).then((r) => r || caches.match('./'))),
    );
    return;
  }

  // scripts, polices, icônes : d'abord le cache (leur adresse change à chaque version)
  const bucket = same && /(pdf(\.worker)?\.min\.js|pako_inflate\.min\.js|\.wasm|\.pfb|\.ttf|\.icc|\.bcmap)$/.test(url.pathname) ? VENDOR : VERSION;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(bucket, req, res))),
  );
});
