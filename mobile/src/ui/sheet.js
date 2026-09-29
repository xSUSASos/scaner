/**
 * Модальные окна: нижняя «шторка» (action sheet, как в iOS) и диалог по центру.
 *
 * Не используем <dialog>/confirm(): в WKWebView (обёртка Capacitor) системные
 * confirm/alert зависят от нативного кода, а своё окно везде выглядит одинаково.
 */
import { h, nextFrame } from './dom.js';

/**
 * Открыть модальное окно с произвольным содержимым.
 * @param {HTMLElement} content
 * @param {{kind?: 'sheet'|'dialog', dismissible?: boolean, onDismiss?: () => void, label?: string}} opts
 *   dismissible — закрывать ли тапом по затемнению.
 * @returns {{el: HTMLElement, close: () => Promise<void>}}
 */
export function openModal(content, { kind = 'sheet', dismissible = true, onDismiss, label } = {}) {
  const panel = h('div', { class: `modal-panel modal-${kind}`, role: 'dialog', 'aria-modal': 'true',
    'aria-label': label }, content);
  const backdrop = h('div', { class: 'modal-backdrop' }, panel);
  let closed = false;

  const close = async () => {
    if (closed) return;
    closed = true;
    backdrop.classList.remove('show');
    await new Promise((r) => setTimeout(r, 220)); // дать доиграть анимации
    backdrop.remove();
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop && dismissible) {
      close();
      onDismiss?.();
    }
  });
  document.body.append(backdrop);
  nextFrame().then(() => backdrop.classList.add('show'));
  return { el: panel, close };
}

/**
 * Шторка с вариантами действий. Возвращает value выбранного пункта или null (отмена).
 * @param {{title?: string, actions: {label: string, value: any, destructive?: boolean, hint?: string}[]}} opts
 */
export function actionSheet({ title, actions }) {
  return new Promise((resolve) => {
    let modal;
    const pick = (value) => {
      modal.close();
      resolve(value);
    };
    const group = h('div', { class: 'sheet-group' },
      title ? h('div', { class: 'sheet-title' }, title) : null,
      actions.map((a) => h('button', {
        class: `sheet-action${a.destructive ? ' danger' : ''}`,
        type: 'button',
        onclick: () => pick(a.value),
      }, h('span', {}, a.label), a.hint ? h('small', {}, a.hint) : null)));
    const cancel = h('button', { class: 'sheet-action sheet-cancel', type: 'button', onclick: () => pick(null) },
      'Отмена');
    modal = openModal(h('div', { class: 'sheet-stack' }, group, cancel),
      { kind: 'sheet', onDismiss: () => resolve(null), label: title });
  });
}

/**
 * Диалог подтверждения. Возвращает true, если пользователь согласился.
 */
export function confirmDialog({ title, message, confirmText = 'OK', cancelText = 'Отмена', destructive = false }) {
  return new Promise((resolve) => {
    let modal;
    const answer = (value) => {
      modal.close();
      resolve(value);
    };
    const body = h('div', { class: 'dialog-body' },
      h('h2', { class: 'dialog-title' }, title),
      message ? h('p', { class: 'dialog-message' }, message) : null,
      h('div', { class: 'dialog-buttons' },
        h('button', { class: 'dialog-btn', type: 'button', onclick: () => answer(false) }, cancelText),
        h('button', { class: `dialog-btn strong${destructive ? ' danger' : ''}`, type: 'button',
          onclick: () => answer(true) }, confirmText)));
    modal = openModal(body, { kind: 'dialog', onDismiss: () => resolve(false), label: title });
  });
}
