/**
 * Мелкие помощники для работы с DOM без фреймворка.
 */

/**
 * Создать элемент: h('button', { class: 'btn', onclick: fn }, 'Текст', childEl).
 * Свойства on* вешаются как обработчики, dataset — как data-атрибуты,
 * остальное — атрибутами (true -> пустой атрибут, false/null -> не ставим).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key === 'dataset') {
      Object.assign(el.dataset, value);
    } else if (key === 'html') {
      el.innerHTML = value; // только для своих констант (иконки), не для данных пользователя
    } else if (key in el && typeof value !== 'string') {
      el[key] = value; // value, checked, disabled и т.п. как свойства
    } else {
      el.setAttribute(key, value === true ? '' : value);
    }
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

/**
 * Отложенный вызов: fn выполнится через ms после ПОСЛЕДНЕГО вызова.
 * flush() — выполнить немедленно, если что-то ждёт (например, перед выгрузкой страницы).
 */
export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = null;
  const run = () => {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    return fn(...args);
  };
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  debounced.flush = () => {
    if (timer === null) return undefined;
    clearTimeout(timer);
    return run();
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/** «1 страница», «2 страницы», «5 страниц». */
export function pagesWord(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'страница';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'страницы';
  return 'страниц';
}

/**
 * Держатель object URL: при замене старый URL освобождается.
 * Без revokeObjectURL каждый Blob жил бы в памяти до перезагрузки страницы.
 */
export function urlHolder() {
  let url = null;
  return {
    set(blob) {
      if (url) URL.revokeObjectURL(url);
      url = blob ? URL.createObjectURL(blob) : null;
      return url;
    },
    get: () => url,
    clear() { this.set(null); },
  };
}

// Иконки — inline SVG (stroke = currentColor, поэтому цвет берётся из CSS).
const ICON_PATHS = {
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  photo: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5-5-9 9"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  next: '<path d="M9 5l7 7-7 7"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  rotateLeft: '<path d="M4 4v5h5"/><path d="M5.5 15a7 7 0 1 0 1.2-7.3L4 9"/>',
  rotateRight: '<path d="M20 4v5h-5"/><path d="M18.5 15a7 7 0 1 1-1.2-7.3L20 9"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  magic: '<path d="M5 19L17 7M15 5l4 4"/><path d="M8 3v3M6.5 4.5h3M19 14v3M17.5 15.5h3"/>',
  frame: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  doc: '<path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
};

export function icon(name, size = 24) {
  return h('span', {
    class: 'icon',
    'aria-hidden': 'true',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
      + `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] ?? ''}</svg>`,
  });
}

/** Дождаться следующего кадра отрисовки (чтобы CSS-переход увидел начальное состояние). */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
