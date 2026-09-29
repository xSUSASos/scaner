/**
 * Управление памятью OpenCV.js.
 *
 * В OpenCV.js каждый cv.Mat живёт в памяти WebAssembly, и сборщик мусора JS
 * о ней не знает: забытый .delete() — утечка. На iPhone с фото 12 Мп это
 * сотни мегабайт за несколько правок, после чего iOS убивает вкладку.
 *
 * Поэтому все временные объекты регистрируем в «трекере» и освобождаем в finally.
 */
export function tracker() {
  const items = [];
  return {
    /** Зарегистрировать объект (Mat, MatVector и т.п.) и вернуть его же. */
    add(obj) {
      items.push(obj);
      return obj;
    },
    /** Убрать объект из трекера — его освободит вызывающий код (результат функции). */
    keep(obj) {
      const i = items.indexOf(obj);
      if (i >= 0) items.splice(i, 1);
      return obj;
    },
    free() {
      for (const obj of items) {
        if (obj && !obj.isDeleted?.()) obj.delete();
      }
      items.length = 0;
    },
  };
}

/** Выполнить fn(t) с трекером; всё, что не отмечено keep, освобождается. */
export function withMats(fn) {
  const t = tracker();
  try {
    return fn(t);
  } finally {
    t.free();
  }
}
