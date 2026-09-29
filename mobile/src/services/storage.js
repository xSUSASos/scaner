/**
 * Хранилище страниц в IndexedDB.
 *
 * Зачем: iOS может в любой момент выгрузить PWA из памяти (свернули, открыли
 * камеру, мало памяти) — всё, что только в JS-переменных, пропадёт. Поэтому
 * каждая страница (исходное фото + рецепт обработки + миниатюра) сразу пишется
 * на «диск». Blob'ы в IndexedDB на iOS 14+ хранятся нормально.
 *
 * Page = { id, order, name, source: Blob, recipe, autoDetected, width, height,
 *          thumb: Blob|null, createdAt }
 */

const DB_NAME = 'scaner';
const DB_VERSION = 1;
const STORE = 'pages';

/** Ошибка хранилища с понятным пользователю текстом. */
export class StorageError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'StorageError';
    this.cause = cause;
  }
}

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Safari иногда закрывает соединение, пока приложение в фоне
      // («Connection to Indexed Database server lost»). Сбрасываем кэш —
      // следующий запрос откроет базу заново.
      db.onclose = () => { dbPromise = null; };
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { dbPromise = null; reject(new Error('База данных занята другой вкладкой')); };
  });
  return dbPromise;
}

/** Перевести техническую ошибку IndexedDB в сообщение для пользователя. */
function friendly(err) {
  if (err instanceof StorageError) return err;
  if (err?.name === 'QuotaExceededError') {
    return new StorageError(
      'Не хватает места для сохранения. Удалите ненужные страницы или освободите память iPhone.', err);
  }
  return new StorageError(`Ошибка сохранения: ${err?.message ?? err}`, err);
}

/**
 * Выполнить fn(store) в транзакции; промис завершается, когда транзакция
 * ЗАФИКСИРОВАНА (complete), а не просто когда запрос выполнен — только тогда
 * данные действительно на диске.
 */
async function withStore(mode, fn, retry = true) {
  let db;
  try {
    db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(STORE))).then((r) => { result = r; }, reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Транзакция прервана'));
    });
  } catch (err) {
    // Соединение умерло в фоне — одна повторная попытка со свежим соединением.
    if (retry && err?.name === 'InvalidStateError') {
      dbPromise = null;
      return withStore(mode, fn, false);
    }
    throw friendly(err);
  }
}

/** Обернуть IDBRequest в Promise. */
function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Все страницы по порядку. */
export async function listPages() {
  const pages = await withStore('readonly', (store) => done(store.getAll()));
  return pages.sort((a, b) => a.order - b.order);
}

export function putPage(page) {
  return withStore('readwrite', (store) => done(store.put(page)));
}

export function deletePage(id) {
  return withStore('readwrite', (store) => done(store.delete(id)));
}

/** Сохранить новый порядок: order = индекс id в массиве. Одна транзакция на всё. */
export function saveOrder(ids) {
  return withStore('readwrite', (store) => {
    // Колбэки, а не await: put выдаём прямо в onsuccess, пока транзакция
    // гарантированно активна (старые Safari закрывали её между микрозадачами).
    ids.forEach((id, i) => {
      const req = store.get(id);
      req.onsuccess = () => {
        const page = req.result;
        if (page && page.order !== i) store.put({ ...page, order: i });
      };
    });
  });
}

export function clearAll() {
  return withStore('readwrite', (store) => done(store.clear()));
}

/**
 * Попросить браузер не вычищать наши данные при нехватке места
 * (иначе Safari может удалить хранилище сайта, который давно не открывали).
 */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && !(await navigator.storage.persisted())) {
      await navigator.storage.persist?.();
    }
  } catch {
    // Не поддерживается — не страшно.
  }
}
