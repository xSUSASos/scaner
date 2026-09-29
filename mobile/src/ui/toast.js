/**
 * Всплывающие сообщения внизу экрана (аналог строки состояния десктопа).
 * Одновременно показываем не больше трёх — старые уходят первыми.
 */
import { h, nextFrame } from './dom.js';

const MAX_TOASTS = 3;
let host = null;

function ensureHost() {
  if (!host) {
    // aria-live: VoiceOver зачитает сообщение, не перемещая фокус.
    host = h('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

/**
 * Показать сообщение.
 * @param {string} message
 * @param {{type?: 'info'|'error'|'success', duration?: number}} [opts]
 */
export function toast(message, { type = 'info', duration } = {}) {
  const root = ensureHost();
  // Ошибки висят дольше: их надо успеть прочитать.
  const ms = duration ?? (type === 'error' ? 6000 : 3000);
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' }, message);
  const hide = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  };
  el.addEventListener('click', hide); // тап — закрыть раньше
  root.append(el);
  while (root.children.length > MAX_TOASTS) root.firstElementChild.remove();
  nextFrame().then(() => el.classList.add('show'));
  setTimeout(hide, ms);
}

/** Сообщение из объекта ошибки (Error, строка, что угодно). */
export function toastError(err, prefix = '') {
  const text = err?.message ?? String(err);
  toast(prefix ? `${prefix}: ${text}` : text, { type: 'error' });
}
