/**
 * Состояние документа (аналог ui/document_model.py): список страниц, их
 * сохранение в IndexedDB и связь с обработчиком изображений.
 *
 * Поток данных: экран вызывает действие (importFiles, updateRecipe, ...) ->
 * действие меняет pages в памяти, сразу генерирует событие (экран перерисовывается)
 * и в фоне сохраняет в IndexedDB / перестраивает миниатюру.
 *
 * События: 'pages' — изменился состав или порядок; 'page' (id) — изменилась одна
 * страница (рецепт или миниатюра); 'cv' — сменился статус модуля обработки.
 */
import { cvClient } from '../services/cv-client.js';
import * as storage from '../services/storage.js';
import { defaultRecipe } from '../core/pipeline.js';
import { fullFrameCorners } from '../core/geometry.js';
import { debounce } from './dom.js';

// ---------- мини-эмиттер событий ----------
const listeners = new Map(); // событие -> Set(fn)

/** Подписаться; возвращает функцию отписки. */
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

function emit(event, payload) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err); // ошибка одного подписчика не должна ломать остальных
    }
  }
}

// ---------- данные ----------
/** Страницы в порядке показа (записи как в IndexedDB). */
let pages = [];
/** Статус OpenCV: 'loading' | 'ready' | 'error'. */
let cvStatus = 'loading';

export const getPages = () => pages;
export const getPage = (id) => pages.find((p) => p.id === id) ?? null;
export const pageIndex = (id) => pages.findIndex((p) => p.id === id);
export const getCvStatus = () => cvStatus;

// ---------- миниатюры (object URL) ----------
const thumbUrls = new Map(); // id -> object URL

/** URL миниатюры страницы (или null, если её ещё нет). */
export function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const page = getPage(id);
  if (!page?.thumb) return null;
  const url = URL.createObjectURL(page.thumb);
  thumbUrls.set(id, url);
  return url;
}

function dropThumbUrl(id) {
  const url = thumbUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  thumbUrls.delete(id);
}

// ---------- загрузка страниц в воркер ----------
/**
 * Воркер держит страницы в памяти только пока приложение открыто. После
 * перезапуска их надо «зарегистрировать» заново — но лениво, по требованию:
 * декодирование 12-Мп фото занимает время и память.
 */
const loading = new Map(); // id -> Promise

export function ensureLoaded(page) {
  if (!loading.has(page.id)) {
    const p = cvClient.load(page.id, page.source, { detect: false });
    // Ошибку не кэшируем: следующий вызов попробует снова.
    p.catch(() => loading.delete(page.id));
    loading.set(page.id, p);
  }
  return loading.get(page.id);
}

// ---------- запуск ----------
export async function init() {
  pages = await storage.listPages();
  emit('pages');
  storage.requestPersistence();
  cvClient.ready().then(
    () => {
      cvStatus = 'ready';
      emit('cv');
      rebuildMissingThumbs();
    },
    (err) => {
      console.error(err);
      cvStatus = 'error';
      emit('cv', err);
    });
}

/** Страницы без миниатюры (приложение закрыли посреди импорта) — достроить. */
async function rebuildMissingThumbs() {
  for (const page of pages.filter((p) => !p.thumb)) {
    try {
      await refreshThumb(page.id);
    } catch (err) {
      console.warn('Миниатюра не построена', err);
    }
  }
}

// ---------- импорт ----------
// iOS при выборе из «Фото» сам перекодирует HEIC в JPEG; расширения — на случай «Файлов».
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|tiff?)$/i;

function isImage(file) {
  return file.type.startsWith('image/') || IMAGE_EXT.test(file.name);
}

/**
 * Добавить файлы как страницы. Строго по одному: декодированное 12-Мп фото
 * в WebAssembly занимает ~150 МБ, параллельная обработка пяти снимков
 * гарантированно довела бы iPhone до выгрузки вкладки.
 * @param {File[]} files
 * @param {{onProgress?: (done: number, total: number, name: string) => void, signal?: AbortSignal}} opts
 * @returns {Promise<{added: number, errors: string[]}>}
 */
export async function importFiles(files, { onProgress, signal } = {}) {
  const errors = [];
  let added = 0;
  for (let i = 0; i < files.length; i++) {
    if (signal?.aborted) break;
    const file = files[i];
    onProgress?.(i, files.length, file.name);
    if (!isImage(file)) {
      errors.push(`«${file.name}» — не изображение`);
      continue;
    }
    try {
      await addPage(file);
      added++;
    } catch (err) {
      console.error(err);
      if (err instanceof storage.StorageError) {
        errors.push(err.message);
        break; // место кончилось — дальше будет то же самое
      }
      errors.push(`«${file.name}» — не удалось открыть (${err?.message ?? err})`);
    }
  }
  onProgress?.(files.length, files.length, '');
  return { added, errors };
}

async function addPage(file) {
  // Копируем содержимое в обычный Blob: File из <input> на iOS — ссылка на
  // временный файл, и некоторые версии Safari не могли положить её в IndexedDB.
  const source = new Blob([await file.arrayBuffer()], { type: file.type || 'image/jpeg' });
  const id = crypto.randomUUID();
  const info = await cvClient.load(id, source, { detect: true });
  loading.set(id, Promise.resolve(info));
  const page = {
    id,
    order: pages.length ? Math.max(...pages.map((p) => p.order)) + 1 : 0,
    name: file.name,
    source,
    recipe: defaultRecipe(info.corners ?? fullFrameCorners()),
    autoDetected: Boolean(info.found),
    width: info.width,
    height: info.height,
    thumb: null,
    createdAt: Date.now(),
  };
  try {
    await storage.putPage(page);
  } catch (err) {
    cvClient.forget(id);
    loading.delete(id);
    throw err;
  }
  pages.push(page);
  emit('pages');
  await refreshThumb(id);
}

// ---------- правка страницы ----------
const saveTimers = new Map();  // id -> debounce сохранения рецепта
const thumbTimers = new Map(); // id -> debounce миниатюры

function timerFor(map, id, fn, ms) {
  if (!map.has(id)) map.set(id, debounce(() => fn(id), ms));
  return map.get(id);
}

/**
 * Новый рецепт страницы. В памяти меняется сразу (превью реагирует мгновенно),
 * на диск и в миниатюру — с задержкой: при движении ползунка событий десятки
 * в секунду, писать каждое в базу незачем.
 */
export function updateRecipe(id, recipe) {
  const page = getPage(id);
  if (!page) return;
  page.recipe = recipe;
  emit('page', id);
  timerFor(saveTimers, id, persist, 300)();
  timerFor(thumbTimers, id, (pid) => refreshThumb(pid).catch((e) => console.warn(e)), 700)();
}

async function persist(id) {
  const page = getPage(id);
  if (page) await storage.putPage(page).catch((err) => emit('error', err));
}

/** Перестроить миниатюру по текущему рецепту и сохранить. */
export async function refreshThumb(id) {
  const page = getPage(id);
  if (!page) return;
  await ensureLoaded(page);
  const { blob } = await cvClient.render(id, page.recipe, { target: 'thumb', format: 'jpeg', quality: 0.8 });
  const current = getPage(id);
  if (!current) return; // страницу удалили, пока считали
  current.thumb = blob;
  dropThumbUrl(id);
  emit('page', id);
  await storage.putPage(current).catch((err) => emit('error', err));
}

/** Немедленно сохранить всё отложенное (перед сворачиванием приложения). */
export function flushPending() {
  for (const t of saveTimers.values()) t.flush();
  for (const t of thumbTimers.values()) t.flush();
}

// ---------- удаление и порядок ----------
export async function removePage(id) {
  saveTimers.get(id)?.cancel();
  thumbTimers.get(id)?.cancel();
  await storage.deletePage(id);
  pages = pages.filter((p) => p.id !== id);
  dropThumbUrl(id);
  if (loading.has(id)) {
    loading.delete(id);
    cvClient.forget(id).catch(() => {});
  }
  emit('pages');
}

/** Новый порядок страниц (массив id). */
export async function reorder(ids) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  pages = ids.map((id) => byId.get(id)).filter(Boolean);
  pages.forEach((p, i) => { p.order = i; });
  emit('pages');
  await storage.saveOrder(ids);
}

/** Подписка на ошибки фонового сохранения. */
export const onError = (fn) => on('error', fn);
