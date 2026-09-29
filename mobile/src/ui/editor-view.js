/**
 * Экран редактирования страницы: вкладки «Углы» и «Результат».
 *
 * Рецепт страницы (углы + фильтр + поворот) правится здесь, а сохраняет его
 * state.updateRecipe (с задержкой). Превью результата строит воркер по
 * принципу «последний запрос побеждает» (cvClient.renderPreviewLatest).
 */
import { cvClient } from '../services/cv-client.js';
import { fullFrameCorners } from '../core/geometry.js';
import * as state from './state.js';
import { CornerEditor } from './corner-editor.js';
import { createFilterPanel } from './filter-panel.js';
import { debounce, h, icon, urlHolder } from './dom.js';
import { confirmDialog } from './sheet.js';
import { toast } from './toast.js';

let lastTab = null; // вкладка запоминается при переходе между страницами

/**
 * @param {string} pageId
 * @param {{onBack: () => void, onNavigate: (id: string) => void}} handlers
 * @returns {{el: HTMLElement, destroy: () => void, pageId: string}}
 */
export function createEditorView(pageId, { onBack, onNavigate }) {
  const page = state.getPage(pageId);
  const sourceUrl = urlHolder();
  const resultUrl = urlHolder();
  const unsubscribe = [];
  let destroyed = false;
  let sourceLoaded = false;
  let resultDirty = true;

  // --- шапка ---
  const title = h('h1', { class: 'topbar-title' });
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'nav-btn', type: 'button', onclick: () => onBack() }, icon('back'), 'Назад'),
    title,
    h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': 'Удалить страницу', onclick: remove },
      icon('trash')));

  // --- переключатель вкладок и стрелки между страницами ---
  const tabButtons = {
    corners: h('button', { class: 'seg', type: 'button', onclick: () => showTab('corners') }, 'Углы'),
    result: h('button', { class: 'seg', type: 'button', onclick: () => showTab('result') }, 'Результат'),
  };
  const prevBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Предыдущая страница',
    onclick: () => go(-1) }, icon('back'));
  const nextBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Следующая страница',
    onclick: () => go(1) }, icon('next'));
  const segRow = h('div', { class: 'seg-row' },
    prevBtn, h('div', { class: 'segmented', role: 'tablist' }, tabButtons.corners, tabButtons.result), nextBtn);

  // --- вкладка «Углы» ---
  const corners = new CornerEditor({ onChange: (c) => setRecipe({ corners: c }) });
  const cornersStage = h('div', { class: 'stage' }, corners.el, spinnerOverlay());
  const detectHint = h('p', { class: 'panel-hint' });
  const cornersPanel = h('div', { class: 'editor-panel' },
    detectHint,
    h('div', { class: 'panel-actions' },
      h('button', { class: 'tool-btn', type: 'button', onclick: autoDetect }, icon('magic'), h('span', {}, 'Авто')),
      h('button', { class: 'tool-btn', type: 'button', onclick: fullFrame }, icon('frame'), h('span', {}, 'Весь кадр'))));

  // --- вкладка «Результат» ---
  const resultImg = h('img', { class: 'result-image', alt: 'Результат обработки', draggable: 'false' });
  const resultError = h('p', { class: 'stage-error', hidden: true });
  const resultStage = h('div', { class: 'stage result-stage' }, resultImg, resultError, spinnerOverlay());
  const filters = createFilterPanel({
    onFilter: (patch) => setRecipe({ filter: { ...page.recipe.filter, ...patch } }),
    onRotate: (delta) => setRecipe({ rotation: (((page.recipe.rotation + delta) % 4) + 4) % 4 }),
    onOcr: async () => {
      const { openOcr } = await import('./ocr-view.js');
      openOcr(page, { title: `Страница ${state.pageIndex(pageId) + 1}` });
    },
  });
  const resultPanel = h('div', { class: 'editor-panel' }, filters.el);

  const el = h('section', { class: 'view editor-view' },
    topbar, segRow, cornersStage, resultStage, cornersPanel, resultPanel);

  // ---------- логика ----------
  function updateTitle() {
    const i = state.pageIndex(pageId);
    const n = state.getPages().length;
    title.textContent = `Страница ${i + 1} из ${n}`;
    prevBtn.disabled = i <= 0;
    nextBtn.disabled = i >= n - 1;
  }

  function go(delta) {
    const pages = state.getPages();
    const target = pages[state.pageIndex(pageId) + delta];
    if (target) onNavigate(target.id);
  }

  function setBusy(stage, busy, text) {
    const overlay = stage.querySelector('.stage-busy');
    overlay.hidden = !busy;
    if (text) overlay.querySelector('.stage-busy-text').textContent = text;
  }

  function showTab(tab) {
    lastTab = tab;
    for (const [name, btn] of Object.entries(tabButtons)) {
      btn.classList.toggle('selected', name === tab);
      btn.setAttribute('aria-selected', String(name === tab));
    }
    cornersStage.hidden = cornersPanel.hidden = tab !== 'corners';
    resultStage.hidden = resultPanel.hidden = tab !== 'result';
    if (tab === 'corners') loadSource();
    else if (resultDirty) schedulePreview();
  }

  /** Фон редактора углов — исходник от воркера (уже повёрнут по EXIF, как и углы). */
  async function loadSource() {
    if (sourceLoaded) return;
    sourceLoaded = true;
    setBusy(cornersStage, true, waitText());
    try {
      await state.ensureLoaded(page);
      const blob = await cvClient.sourcePreview(pageId);
      if (destroyed) return;
      corners.setImage(sourceUrl.set(blob));
      corners.setCorners(page.recipe.corners);
    } catch (err) {
      sourceLoaded = false;
      toast(`Не удалось открыть фото: ${err?.message ?? err}`, { type: 'error' });
    } finally {
      if (!destroyed) setBusy(cornersStage, false);
    }
  }

  // Живое превью: ждём 80 мс тишины, чтобы не дёргать воркер на каждый пиксель ползунка.
  const schedulePreview = debounce(renderPreview, 80);

  async function renderPreview() {
    resultDirty = false;
    setBusy(resultStage, true, waitText());
    try {
      await state.ensureLoaded(page);
      const result = await cvClient.renderPreviewLatest(pageId, page.recipe);
      if (!result || destroyed) return; // null — запрос вытеснен более новым
      resultImg.src = resultUrl.set(result.blob);
      resultError.hidden = true;
      setBusy(resultStage, false);
    } catch (err) {
      if (destroyed) return;
      resultError.textContent = `Ошибка обработки: ${err?.message ?? err}`;
      resultError.hidden = false;
      setBusy(resultStage, false);
    }
  }

  function setRecipe(patch) {
    state.updateRecipe(pageId, { ...page.recipe, ...patch });
    if (patch.filter) filters.set(page.recipe.filter);
    resultDirty = true;
    if (!resultStage.hidden) schedulePreview();
  }

  async function autoDetect() {
    try {
      await state.ensureLoaded(page);
      const { corners: found, found: ok } = await cvClient.detect(pageId);
      const c = ok && found ? found : fullFrameCorners();
      corners.setCorners(c);
      setRecipe({ corners: c });
      page.autoDetected = ok;
      updateDetectHint();
      toast(ok ? 'Документ найден' : 'Контур не найден — рамка по краям', { type: ok ? 'success' : 'info' });
    } catch (err) {
      toast(`Автопоиск не удался: ${err?.message ?? err}`, { type: 'error' });
    }
  }

  function fullFrame() {
    corners.setCorners(fullFrameCorners());
    setRecipe({ corners: fullFrameCorners() });
  }

  function updateDetectHint() {
    detectHint.textContent = page.autoDetected
      ? 'Перетащите круглые маркеры, чтобы уточнить края листа.'
      : 'Контур не найден автоматически — перетащите маркеры на углы листа.';
  }

  async function remove() {
    const ok = await confirmDialog({
      title: 'Удалить страницу?',
      message: 'Страница будет удалена из документа. Это нельзя отменить.',
      confirmText: 'Удалить',
      destructive: true,
    });
    if (!ok) return;
    try {
      await state.removePage(pageId);
      onBack();
    } catch (err) {
      toast(err?.message ?? String(err), { type: 'error' });
    }
  }

  function waitText() {
    return state.getCvStatus() === 'loading' ? 'Загрузка модуля обработки…' : '';
  }

  // Свайп влево/вправо по результату — соседняя страница.
  let swipe = null;
  resultStage.addEventListener('pointerdown', (e) => {
    swipe = { x: e.clientX, y: e.clientY, t: performance.now() };
  });
  resultStage.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    const fast = performance.now() - swipe.t < 600;
    swipe = null;
    if (fast && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) go(dx < 0 ? 1 : -1);
  });
  resultStage.addEventListener('pointercancel', () => { swipe = null; });

  // ---------- запуск ----------
  unsubscribe.push(state.on('pages', () => {
    if (state.getPage(pageId)) updateTitle();
  }));
  filters.set(page.recipe.filter);
  updateTitle();
  updateDetectHint();
  // Документ не найден автоматически — сразу показываем углы, иначе результат.
  showTab(lastTab ?? (page.autoDetected ? 'result' : 'corners'));

  return {
    el,
    pageId,
    destroy() {
      destroyed = true;
      schedulePreview.cancel();
      corners.destroy();
      unsubscribe.forEach((fn) => fn());
      sourceUrl.clear();
      resultUrl.clear();
    },
  };
}

function spinnerOverlay() {
  return h('div', { class: 'stage-busy', hidden: true },
    h('div', { class: 'spinner' }), h('p', { class: 'stage-busy-text' }));
}
