/**
 * Модальное окно прогресса с кнопкой «Отмена» (аналог QProgressDialog десктопа).
 *
 * Отмена — через AbortController: окно отдаёт signal, долгая операция
 * проверяет его между страницами. Прервать страницу «на середине» нельзя,
 * поэтому после нажатия пишем, что ждём окончания текущей.
 */
import { h } from './dom.js';
import { openModal } from './sheet.js';

/**
 * @param {{title: string, cancellable?: boolean}} opts
 */
export function openProgress({ title, cancellable = true }) {
  const controller = new AbortController();
  const titleEl = h('h2', { class: 'dialog-title' }, title);
  const textEl = h('p', { class: 'dialog-message progress-text' }, '');
  // Без value <progress> показывает «неопределённую» анимацию — пока доля неизвестна.
  const bar = h('progress', { class: 'progress-bar', max: 1 });
  const buttons = h('div', { class: 'dialog-buttons' });
  const cancelBtn = h('button', { class: 'dialog-btn', type: 'button' }, 'Отмена');
  cancelBtn.addEventListener('click', () => {
    controller.abort();
    cancelBtn.disabled = true;
    textEl.textContent = 'Отмена… (дожидаемся текущей страницы)';
  });
  if (cancellable) buttons.append(cancelBtn);

  const body = h('div', { class: 'dialog-body progress-body' }, titleEl, textEl, bar, buttons);
  const modal = openModal(body, { kind: 'dialog', dismissible: false, label: title });

  return {
    signal: controller.signal,

    /** fraction: 0..1 или null (неизвестно); text — строка под заголовком. */
    update({ fraction = null, text } = {}) {
      if (controller.signal.aborted) return;
      if (text != null) textEl.textContent = text;
      if (fraction == null) bar.removeAttribute('value');
      else bar.value = Math.max(0, Math.min(1, fraction));
    },

    /**
     * Перевести окно в состояние «готово» с кнопками.
     * Нужно для «Поделиться»: iOS разрешает navigator.share только сразу после
     * нажатия пользователя, а после долгого экспорта этот «жест» уже истёк —
     * поэтому просим нажать ещё одну кнопку.
     */
    finish({ title: doneTitle, text, actions = [] }) {
      if (doneTitle) titleEl.textContent = doneTitle;
      textEl.textContent = text ?? '';
      bar.remove();
      buttons.replaceChildren(...actions.map((a) => h('button', {
        class: `dialog-btn${a.primary ? ' strong' : ''}`,
        type: 'button',
        onclick: a.onClick,
      }, a.label)));
    },

    close: () => modal.close(),
  };
}
