/**
 * Панель фильтров: режим, яркость/контраст, параметры Ч/Б, поворот, «Текст».
 * Порт ui/filter_panel.py.
 *
 * Панель сама ничего не обрабатывает — только сообщает об изменениях
 * (onFilter с частью настроек, onRotate, onOcr). Превью пересчитывает редактор.
 */
import { FILTER_TITLES, defaultFilter } from '../core/filters.js';
import { h, icon } from './dom.js';

const DEFAULTS = defaultFilter();
const signed = (v) => (v > 0 ? `+${v}` : `${v}`);

/**
 * Ползунок с подписью и значением. Тап по значению (или двойной тап по строке)
 * возвращает значение по умолчанию — на телефоне точно попасть в 0 пальцем трудно.
 */
function slider({ title, key, min, max, step, fmt, onInput }) {
  const input = h('input', { type: 'range', class: 'slider', min, max, step, 'aria-label': title });
  const value = h('button', { class: 'slider-value', type: 'button', 'aria-label': `${title}: сбросить` });
  const reset = () => {
    input.value = DEFAULTS[key];
    changed();
  };
  const show = () => {
    const v = Number(input.value);
    value.textContent = fmt(v);
    value.classList.toggle('changed', v !== DEFAULTS[key]);
  };
  const changed = () => {
    show();
    onInput(key, Number(input.value));
  };
  input.addEventListener('input', changed);
  value.addEventListener('click', reset);
  const row = h('div', { class: 'slider-row', ondblclick: reset },
    h('div', { class: 'slider-head' }, h('span', { class: 'slider-title' }, title), value),
    input);
  return {
    el: row,
    set(v) {
      input.value = v;
      show();
    },
  };
}

/**
 * @param {{onFilter: (patch: object) => void, onRotate: (delta: number) => void, onOcr: () => void}} opts
 * @returns {{el: HTMLElement, set: (filter: object) => void}}
 */
export function createFilterPanel({ onFilter, onRotate, onOcr }) {
  const onInput = (key, value) => onFilter({ [key]: value });

  // --- режимы: «чипы» в одну строку с горизонтальной прокруткой ---
  const chips = Object.entries(FILTER_TITLES).map(([mode, title]) => h('button', {
    class: 'chip', type: 'button', dataset: { mode }, 'aria-pressed': 'false',
    onclick: () => {
      select(mode);
      onFilter({ mode });
    },
  }, title));

  const sliders = {
    brightness: slider({ title: 'Яркость', key: 'brightness', min: -100, max: 100, step: 1, fmt: signed, onInput }),
    contrast: slider({ title: 'Контраст', key: 'contrast', min: -100, max: 100, step: 1, fmt: signed, onInput }),
    // «Окно» — размер блока адаптивного порога в % от длинной стороны.
    bwBlockPercent: slider({ title: 'Окно, %', key: 'bwBlockPercent', min: 0.5, max: 10, step: 0.5,
      fmt: (v) => v.toFixed(1), onInput }),
    bwC: slider({ title: 'Порог C', key: 'bwC', min: 0, max: 40, step: 1, fmt: String, onInput }),
  };
  const bwGroup = h('div', { class: 'bw-group', hidden: true },
    h('p', { class: 'panel-hint' }, 'Меньше окно — лучше с тенями; больше порог — чище фон, но тоньше текст.'),
    sliders.bwBlockPercent.el, sliders.bwC.el);

  const select = (mode) => {
    for (const chip of chips) {
      const on = chip.dataset.mode === mode;
      chip.classList.toggle('selected', on);
      chip.setAttribute('aria-pressed', String(on));
    }
    bwGroup.hidden = mode !== 'bw';
  };

  const actions = h('div', { class: 'panel-actions' },
    h('button', { class: 'tool-btn', type: 'button', 'aria-label': 'Повернуть влево', onclick: () => onRotate(-1) },
      icon('rotateLeft'), h('span', {}, 'Влево')),
    h('button', { class: 'tool-btn', type: 'button', 'aria-label': 'Повернуть вправо', onclick: () => onRotate(1) },
      icon('rotateRight'), h('span', {}, 'Вправо')),
    h('button', { class: 'tool-btn', type: 'button', onclick: () => onOcr() },
      icon('text'), h('span', {}, 'Текст')));

  // Настройки прокручиваются, а строка кнопок закреплена внизу — всегда под пальцем.
  const el = h('div', { class: 'filter-panel' },
    h('div', { class: 'panel-scroll' },
      h('div', { class: 'chips', role: 'group', 'aria-label': 'Фильтр' }, chips),
      sliders.brightness.el, sliders.contrast.el, bwGroup),
    actions);

  return {
    el,
    /** Показать настройки страницы (без вызова onFilter). */
    set(filter) {
      select(filter.mode);
      for (const [key, s] of Object.entries(sliders)) s.set(filter[key] ?? DEFAULTS[key]);
    },
  };
}
