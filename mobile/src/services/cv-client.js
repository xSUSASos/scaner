/**
 * Клиент воркера обработки (основной поток). Аналог ui/workers.py из десктопа:
 * каждый вызов возвращает Promise, сама работа идёт в cv-worker.js.
 *
 * Живое превью: пока один рендер идёт, новые запросы не копятся в очередь —
 * хранится только ПОСЛЕДНИЙ, он уйдёт следующим; промежуточные получают null.
 * Иначе при быстром движении ползунка воркер обрабатывал бы десятки устаревших кадров.
 */
export class CvClient {
  constructor(workerUrl) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.nextId = 1;
    this.pending = new Map();
    this.previewState = new Map(); // pageId -> { busy, queued: {recipe, resolve} | null }
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    this.worker.onerror = (e) => {
      const err = new Error(`Ошибка обработчика изображений: ${e.message ?? e}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  call(method, args) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  /** Дождаться загрузки OpenCV.js (первый запуск: ~13 МБ, дальше из кэша). */
  ready() {
    return this.call('ping');
  }

  /** Зарегистрировать страницу: {width, height, corners|null, found}. */
  load(id, blob, { detect = true } = {}) {
    return this.call('load', { id, blob, detect });
  }

  /** Автопоиск углов заново: {corners, found}. */
  detect(id) {
    return this.call('detect', { id });
  }

  /** Исходник, повёрнутый по EXIF, в размере превью (Blob JPEG) — фон редактора углов. */
  sourcePreview(id) {
    return this.call('sourcePreview', { id });
  }

  /** Рендер: {blob, width, height, binary}. target: 'preview' | 'thumb' | 'full'. */
  render(id, recipe, { target = 'preview', format = 'auto', quality = 0.9 } = {}) {
    return this.call('render', { id, recipe, target, format, quality });
  }

  /** Живое превью «последний побеждает»: Promise<{blob,...} | null> (null — запрос устарел). */
  renderPreviewLatest(id, recipe) {
    let state = this.previewState.get(id);
    if (!state) {
      state = { busy: false, queued: null };
      this.previewState.set(id, state);
    }
    return new Promise((resolve, reject) => {
      if (state.busy) {
        state.queued?.resolve(null); // вытесненный запрос
        state.queued = { recipe, resolve, reject };
        return;
      }
      this.#runPreview(id, state, { recipe, resolve, reject });
    });
  }

  async #runPreview(id, state, job) {
    state.busy = true;
    try {
      job.resolve(await this.render(id, structuredClone(job.recipe), { target: 'preview', quality: 0.85 }));
    } catch (err) {
      job.reject(err);
    } finally {
      state.busy = false;
      const next = state.queued;
      state.queued = null;
      if (next) this.#runPreview(id, state, next);
    }
  }

  forget(id) {
    this.previewState.delete(id);
    return this.call('forget', { id });
  }
}

export const cvClient = new CvClient(new URL('../worker/cv-worker.js', import.meta.url));
