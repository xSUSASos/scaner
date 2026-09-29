/**
 * Распознавание текста одной страницы (аналог ui/ocr_dialog.py) — в шторке.
 *
 * Распознаём ПОЛНОРАЗМЕРНЫЙ результат обработки: на превью 1400 px мелкий
 * шрифт превращается в кашу, и Tesseract ошибается заметно чаще.
 * Модуль OCR (~15 МБ с языками) грузится только при первом нажатии «Текст».
 */
import { cvClient } from '../services/cv-client.js';
import { ensureLoaded } from './state.js';
import { h } from './dom.js';
import { openModal } from './sheet.js';
import { toast } from './toast.js';

export function openOcr(page, { title = 'Текст страницы' } = {}) {
  let closed = false;
  // Закрыли шторку — прерываем распознавание (ocr.js понимает AbortSignal).
  const controller = new AbortController();
  const status = h('p', { class: 'ocr-status' }, 'Подготовка изображения…');
  const bar = h('progress', { class: 'progress-bar', max: 1 });
  const content = h('div', { class: 'ocr-content' }, status, bar);
  const closeBtn = h('button', { class: 'link-btn', type: 'button' }, 'Готово');
  const body = h('div', { class: 'ocr-sheet' },
    h('div', { class: 'sheet-header' }, h('h2', {}, 'Распознанный текст'), closeBtn),
    content,
    h('p', { class: 'panel-hint' }, 'Рукописный текст распознаётся плохо — Tesseract рассчитан на печатный.'));

  const modal = openModal(body, { kind: 'sheet', label: 'Распознанный текст', onDismiss: () => {
    closed = true;
    controller.abort();
  } });
  closeBtn.addEventListener('click', () => {
    closed = true;
    controller.abort();
    modal.close();
  });

  const progress = (fraction, text) => {
    if (closed) return;
    if (text) status.textContent = text;
    if (fraction == null) bar.removeAttribute('value');
    else bar.value = fraction;
  };

  (async () => {
    try {
      await ensureLoaded(page);
      const { blob } = await cvClient.render(page.id, page.recipe, { target: 'full', format: 'auto', quality: 0.95 });
      if (closed) return;
      progress(null, 'Загрузка модуля распознавания…');
      const { recognizeText } = await import('../services/ocr.js');
      const text = await recognizeText(blob, {
        signal: controller.signal,
        onProgress: (fraction, statusText) => progress(fraction, statusText || 'Распознавание…'),
      });
      if (!closed) showText(content, text?.trim() ?? '', title);
    } catch (err) {
      console.error(err);
      if (!closed && err?.name !== 'AbortError') {
        content.replaceChildren(h('p', { class: 'ocr-error', role: 'alert' },
          `Не удалось распознать текст: ${err?.message ?? err}`));
      }
    }
  })();
}

function showText(content, text, title) {
  if (!text) {
    content.replaceChildren(h('p', { class: 'ocr-status' }, 'Текст не найден.'));
    return;
  }
  // readonly, а не disabled: из readonly-поля на iOS можно выделять и копировать.
  const area = h('textarea', { class: 'ocr-text', readonly: true, rows: 10 });
  area.value = text;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Старый способ: выделить текст в поле и выполнить «копировать».
      area.focus();
      area.setSelectionRange(0, text.length);
      if (!document.execCommand('copy')) {
        toast('Не удалось скопировать — выделите текст и скопируйте вручную', { type: 'error' });
        return;
      }
    }
    toast('Текст скопирован', { type: 'success' });
  };
  const share = async () => {
    try {
      const { shareText } = await import('../services/export.js');
      await shareText(text, { title });
    } catch (err) {
      if (err?.name !== 'AbortError') toast(`Не удалось поделиться: ${err?.message ?? err}`, { type: 'error' });
    }
  };
  content.replaceChildren(area, h('div', { class: 'sheet-buttons' },
    h('button', { class: 'btn', type: 'button', onclick: copy }, 'Копировать'),
    h('button', { class: 'btn primary', type: 'button', onclick: share }, 'Поделиться')));
}
