/**
 * Сервис-воркер: приложение работает без интернета после первого открытия.
 *
 * Регистрируется из src/services/pwa.js как sw.js?v=<версия из precache.json>.
 * Меняется версия (любой файл изменился и заново выполнен npm run vendor) —
 * меняется URL скрипта, и браузер ставит новый сервис-воркер.
 *
 * Два кэша:
 *  - scaner-app-…    файлы приложения (index.html, src/, иконки); свой на каждую версию.
 *  - scaner-vendor-… библиотеки из vendor/ (OpenCV 13 МБ, Tesseract ~16 МБ). Общий
 *    для версий: каждый файл помечен хешем, при обновлении перекачиваются только
 *    изменившиеся — иначе каждое исправление в коде стоило бы 13+ МБ трафика.
 */
const VERSION = 1; // менять при изменении логики этого файла
const BUILD = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'scaner-';
const APP_CACHE = `${PREFIX}app-v${VERSION}-${BUILD}`;
const VENDOR_CACHE = `${PREFIX}vendor-v${VERSION}`;
const HASH_HEADER = 'X-Scaner-Hash';

const SCOPE = self.registration.scope; // https://…/mobile/ — все пути от него
const abs = (path) => new URL(path, SCOPE).href;
const INDEX = abs('index.html');
const MANIFEST = abs('precache.json');
// На localhost код приложения берём из сети: при разработке правки видны сразу.
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

let manifestPromise = null;

/** precache.json: при установке — из сети, потом — из кэша приложения. */
function loadManifest(fromNetwork = false) {
  if (fromNetwork || !manifestPromise) {
    manifestPromise = (async () => {
      const cached = fromNetwork ? null : await caches.match(MANIFEST, { cacheName: APP_CACHE });
      const res = cached ?? await fetch(MANIFEST, { cache: 'no-store' });
      if (!res.ok) throw new Error(`precache.json: ${res.status}`);
      return res.json();
    })();
    manifestPromise.catch(() => { manifestPromise = null; });
  }
  return manifestPromise;
}

async function vendorHash(url) {
  try {
    const m = await loadManifest();
    return m.vendor.find((f) => abs(f.url) === url)?.hash ?? '';
  } catch {
    return '';
  }
}

/** Положить ответ в кэш vendor с хешем в заголовке (по нему потом понятно, устарел ли файл). */
async function putVendor(cache, url, res, hash) {
  const headers = new Headers(res.headers);
  headers.set(HASH_HEADER, hash);
  await cache.put(url, new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const manifest = await loadManifest(true);

    const app = await caches.open(APP_CACHE);
    // cache: 'reload' — мимо HTTP-кэша браузера, иначе можно закэшировать старый файл.
    const appUrls = manifest.app.map((f) => abs(f.url));
    await app.addAll(appUrls.map((url) => new Request(url, { cache: 'reload' })));
    await app.put(MANIFEST, new Response(JSON.stringify(manifest), {
      headers: { 'Content-Type': 'application/json' },
    }));

    const vendor = await caches.open(VENDOR_CACHE);
    for (const f of manifest.vendor.filter((v) => v.precache)) {
      const url = abs(f.url);
      const old = await vendor.match(url);
      if (old?.headers.get(HASH_HEADER) === f.hash) continue; // не изменился — не качаем
      const res = await fetch(url, { cache: 'reload' });
      if (!res.ok) throw new Error(`${f.url}: ${res.status}`);
      await putVendor(vendor, url, res, f.hash);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith(PREFIX) && name !== APP_CACHE && name !== VENDOR_CACHE) {
        await caches.delete(name);
      }
    }
    // Удаляем из vendor файлы, которых нет в новой версии или которые изменились.
    try {
      const manifest = await loadManifest();
      const current = new Map(manifest.vendor.map((f) => [abs(f.url), f.hash]));
      const vendor = await caches.open(VENDOR_CACHE);
      for (const req of await vendor.keys()) {
        const res = await vendor.match(req);
        if (current.get(req.url) !== res?.headers.get(HASH_HEADER)) await vendor.delete(req);
      }
    } catch {
      // без манифеста чистить не по чему — оставляем как есть
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !request.url.startsWith(SCOPE)) return;
  const path = request.url.slice(SCOPE.length).split(/[?#]/)[0];
  // Эти два файла — только из сети: по ним проверяется обновление.
  if (path === 'precache.json' || path === 'sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, INDEX));
  } else if (path.startsWith('vendor/')) {
    event.respondWith(vendorCacheFirst(event));
  } else {
    event.respondWith(DEV ? networkFirst(request) : appCacheFirst(request));
  }
});

/** Страница: сначала сеть (свежая версия), без сети — index.html из кэша. */
async function networkFirst(request, fallbackUrl) {
  try {
    return await fetch(request);
  } catch (err) {
    const cached = await caches.match(fallbackUrl ?? request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function appCacheFirst(request) {
  const cached = await caches.match(request, { cacheName: APP_CACHE, ignoreSearch: true });
  return cached ?? fetch(request);
}

/**
 * vendor/: сначала кэш. Файлы Tesseract не входят в предзагрузку и попадают в
 * кэш при первом распознавании — дальше OCR работает без сети.
 */
async function vendorCacheFirst(event) {
  const { request } = event;
  const url = request.url.split(/[?#]/)[0];
  const cache = await caches.open(VENDOR_CACHE);
  const cached = await cache.match(url);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok && res.status === 200) {
    // Кладём копию; оригинал сразу отдаём странице. waitUntil — чтобы браузер не
    // остановил сервис-воркер, пока многомегабайтный файл ещё пишется в кэш.
    const copy = res.clone();
    event.waitUntil(vendorHash(url).then((hash) => putVendor(cache, url, copy, hash)).catch(() => {}));
  }
  return res;
}
