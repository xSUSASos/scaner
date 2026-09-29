/**
 * Регистрация сервис-воркера (офлайн-режим PWA).
 *
 * Не регистрируем:
 *  - в приложении Capacitor: там файлы и так лежат внутри приложения;
 *  - по http (кроме localhost): браузер всё равно не позволит.
 */
const ROOT = new URL('../../', import.meta.url);
const listeners = new Set();

function allowed() {
  if (!('serviceWorker' in navigator)) return false;
  if (globalThis.Capacitor?.isNativePlatform?.()) return false;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return location.protocol === 'https:' || local;
}

export function registerServiceWorker() {
  if (!allowed()) return;
  // Уже был активный SW и пришёл новый (skipWaiting + clients.claim) — на странице
  // работает старый код. Сообщаем UI: можно предложить «Обновить».
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) for (const cb of listeners) cb();
  });

  (async () => {
    // Версия сборки — в URL скрипта: изменилась → браузер ставит новый SW.
    let version;
    try {
      const res = await fetch(new URL('precache.json', ROOT), { cache: 'no-store' });
      if (!res.ok) return; // нет precache.json (не выполнен npm run vendor) — работаем без SW
      ({ version } = await res.json());
    } catch {
      return; // нет сети: уже установленный SW продолжает работать сам
    }
    await navigator.serviceWorker.register(new URL(`sw.js?v=${version}`, ROOT), {
      scope: ROOT.href,
      updateViaCache: 'none', // sw.js всегда из сети, не из HTTP-кэша
    });
  })().catch((err) => console.warn('Сервис-воркер не зарегистрирован:', err));
}

/** cb() вызывается, когда установлена новая версия приложения. -> функция отписки */
export function onUpdateAvailable(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
