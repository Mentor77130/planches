/* Planches — fonctionnement hors ligne.
 * La page et ses scripts restent disponibles sans réseau ; les BD, elles, sont gardées par la page
 * dans IndexedDB. Chaque déploiement change VERSION : l'ancien cache est alors effacé. */
const VERSION = 'planches-202611251308';
const VENDOR = 'planches-vendor-1'; // pdf.js et pako : ne changent pas d'une version à l'autre
const SHELL = [
  './',
  'manifest.webmanifest',
  'config.js?v=202611251308',
  'formats.js?v=202611251308',
  'rar-worker.js?v=202611251308',
  'pako_inflate.min.js',
  'icone-32.png',
  'icone-180.png',
  'icone-192.png',
  'icone-512.png',
];

// tout ce qu'il faut pour lire un PDF sans connexion, gardé dès l'installation
const VENDOR_FILES = [
  'pdf.min.js', 'pdf.worker.min.js',
  'openjpeg.wasm', 'jbig2.wasm', 'qcms_bg.wasm', 'openjpeg_nowasm_fallback.js', 'jbig2_nowasm_fallback.js',
  'CGATS001Compat-v2-micro.icc',
  'FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb',
  'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb',
  'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-Italic.ttf', 'LiberationSans-BoldItalic.ttf',
];

async function keepVendor() {
  const c = await caches.open(VENDOR);
  await Promise.all(VENDOR_FILES.map(async (u) => {
    if (await c.match(u)) return;
    try { await c.add(new Request(u, { cache: 'reload' })); } catch (e) { /* gardé à la première lecture */ }
  }));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' : jamais une copie périmée du cache HTTP du navigateur
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => keepVendor())
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

  // les pages : la plus récente si le réseau répond, sinon celle gardée
  if (req.mode === 'navigate') {
    const accueil = /\/(index\.html)?$/.test(url.pathname);
    const cle = accueil ? './' : req;
    e.respondWith(
      fetch(req)
        .then((res) => keep(VERSION, cle, res))
        .catch(() => caches.match(cle, { cacheName: VERSION }).then((r) => r || caches.match(cle)).then((r) => r || caches.match('./'))),
    );
    return;
  }

  // scripts, polices, icônes : d'abord le cache (leur adresse change à chaque version)
  const bucket = same && /(pdf(\.worker)?\.min\.js|pako_inflate\.min\.js|\.wasm|\.pfb|\.ttf|\.icc|\.bcmap)$/.test(url.pathname) ? VENDOR : VERSION;
  e.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(bucket, req, res))),
  );
});
