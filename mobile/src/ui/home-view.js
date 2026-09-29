/**
 * Главный экран «Документ»: сетка миниатюр, перестановка, импорт, экспорт.
 * Порт ui/page_list.py + часть main_window.py.
 *
 * Экран создаётся один раз и не уничтожается: редактор открывается поверх,
 * поэтому позиция прокрутки сетки сохраняется при возврате.
 */
import * as state from './state.js';
import { h, icon, pagesWord } from './dom.js';

/**
 * @param {{onOpenPage: (id: string) => void, onImport: (files: File[], source: 'camera'|'photos') => void,
 *          onExport: () => void}} handlers
 */
let lastDragEnd = 0; // время окончания последнего перетаскивания

export function createHomeView({ onOpenPage, onImport, onExport }) {
  // --- скрытые поля выбора файлов ---
  // capture="environment" — сразу открыть заднюю камеру, без меню выбора.
  const cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const photosInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
  const picked = (input, source) => () => {
    const files = [...input.files];
    input.value = ''; // иначе повторный выбор того же файла не вызовет change
    if (files.length) onImport(files, source);
  };
  cameraInput.addEventListener('change', picked(cameraInput, 'camera'));
  photosInput.addEventListener('change', picked(photosInput, 'photos'));

  // --- шапка ---
  const count = h('p', { class: 'home-count' });
  const cvBanner = h('div', { class: 'cv-banner', role: 'status', hidden: true });
  const header = h('header', { class: 'home-header' },
    h('h1', {}, 'Документ'), count);

  // --- сетка и пустое состояние ---
  const grid = h('ul', { class: 'grid', 'aria-label': 'Страницы документа' });
  const empty = h('div', { class: 'empty', hidden: true },
    h('div', { class: 'empty-icon' }, icon('doc', 56)),
    h('h2', {}, 'Пока нет страниц'),
    h('p', {}, 'Сфотографируйте документ или выберите снимки из галереи. Края листа найдутся '
      + 'автоматически, их можно поправить вручную. Готовый документ — в PDF или картинки.'),
    h('div', { class: 'empty-buttons' },
      h('button', { class: 'btn primary big', type: 'button', onclick: () => cameraInput.click() },
        icon('camera'), 'Сфотографировать'),
      h('button', { class: 'btn big', type: 'button', onclick: () => photosInput.click() },
        icon('photo'), 'Выбрать из галереи')));
  const hint = h('p', { class: 'grid-hint' }, 'Нажмите на страницу, чтобы обрезать и улучшить. '
    + 'Удерживайте и перетащите, чтобы изменить порядок.');

  // --- нижняя панель ---
  const toolButton = (name, label, onclick) =>
    h('button', { class: 'tool-btn', type: 'button', onclick }, icon(name), h('span', {}, label));
  const cameraBtn = toolButton('camera', 'Камера', () => cameraInput.click());
  const photosBtn = toolButton('photo', 'Фото', () => photosInput.click());
  const exportBtn = toolButton('share', 'Экспорт', () => onExport());
  const toolbar = h('nav', { class: 'toolbar' }, cameraBtn, photosBtn, exportBtn);

  const el = h('section', { class: 'view home-view' },
    header,
    h('main', { class: 'home-scroll' }, cvBanner, grid, hint, empty),
    toolbar, cameraInput, photosInput);

  // --- отрисовка ---
  const items = new Map(); // id -> <li>: переиспользуем, чтобы миниатюры не мигали

  function itemFor(page) {
    let li = items.get(page.id);
    if (!li) {
      const img = h('img', { alt: '', draggable: 'false' });
      li = h('li', { class: 'thumb', dataset: { id: page.id } },
        h('button', { class: 'thumb-btn', type: 'button', onclick: () => {
          // После перетаскивания браузер может прислать «клик» — это не открытие страницы.
          if (Date.now() - lastDragEnd > 400) onOpenPage(page.id);
        } },
          h('div', { class: 'thumb-frame' }, img, h('div', { class: 'thumb-spinner spinner' })),
          h('span', { class: 'thumb-num' })));
      items.set(page.id, li);
    }
    return li;
  }

  function updateItem(page, index) {
    const li = itemFor(page);
    const url = state.thumbUrl(page.id);
    const img = li.querySelector('img');
    if (url && img.getAttribute('src') !== url) img.src = url;
    li.classList.toggle('no-thumb', !url);
    li.querySelector('.thumb-num').textContent = index + 1;
    li.querySelector('.thumb-btn').setAttribute('aria-label', `Страница ${index + 1}`);
  }

  function renderAll() {
    const pages = state.getPages();
    for (const [id, li] of items) {
      if (!state.getPage(id)) {
        li.remove();
        items.delete(id);
      }
    }
    pages.forEach((page, i) => updateItem(page, i));
    grid.replaceChildren(...pages.map((p) => items.get(p.id)));
    const n = pages.length;
    count.textContent = n ? `${n} ${pagesWord(n)}` : '';
    empty.hidden = n > 0;
    grid.hidden = n === 0;
    hint.hidden = n === 0;
    updateButtons();
  }

  function updateButtons() {
    const status = state.getCvStatus();
    const ready = status === 'ready';
    // Пока OpenCV грузится, обработать фото нечем — кнопки импорта неактивны.
    cameraBtn.disabled = photosBtn.disabled = !ready;
    for (const b of empty.querySelectorAll('button')) b.disabled = !ready;
    exportBtn.disabled = !ready || state.getPages().length === 0;
    cvBanner.hidden = ready;
    cvBanner.classList.toggle('error', status === 'error');
    cvBanner.replaceChildren(...(status === 'error'
      ? [h('span', {}, 'Не удалось загрузить модуль обработки. '),
        h('button', { class: 'link-btn', type: 'button', onclick: () => location.reload() }, 'Повторить')]
      : [h('span', { class: 'spinner small' }), h('span', {}, 'Загрузка модуля обработки…')]));
  }

  state.on('pages', renderAll);
  state.on('cv', updateButtons);
  state.on('page', (id) => {
    const i = state.pageIndex(id);
    if (i >= 0) updateItem(state.getPage(id), i);
  });
  renderAll();
  setupSortable(grid);

  return {
    el,
    openCamera: () => cameraInput.click(),
  };
}

/**
 * Перестановка перетаскиванием (SortableJS). Библиотеку подключаем динамически:
 * если файла нет, приложение работает, просто без перестановки.
 */
async function setupSortable(grid) {
  try {
    const { default: Sortable } = await import('../../vendor/sortablejs/sortable.esm.js');
    Sortable.create(grid, {
      animation: 150,
      // На сенсорном экране перетаскивание начинается после удержания 150 мс —
      // обычный свайп по сетке по-прежнему прокручивает её.
      delay: 150,
      delayOnTouchOnly: true,
      touchStartThreshold: 6, // палец чуть дрогнул во время удержания — это ещё не прокрутка
      dataIdAttr: 'data-id',
      ghostClass: 'thumb-ghost',
      chosenClass: 'thumb-chosen',
      onEnd: (evt) => {
        lastDragEnd = Date.now();
        if (evt.oldIndex === evt.newIndex) return;
        const ids = [...grid.children].map((li) => li.dataset.id);
        state.reorder(ids).catch((err) => console.error(err));
      },
    });
  } catch (err) {
    console.warn('SortableJS недоступен — перестановка страниц отключена', err);
  }
}
