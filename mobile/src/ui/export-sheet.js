/**
 * Экспорт документа: выбор формата -> окно прогресса -> «Поделиться»
 * (системное меню iOS: «Сохранить в Файлы», AirDrop, мессенджеры).
 *
 * Модуль export.js (jsPDF/pdf-lib) грузится только при первом экспорте.
 */
import { cvClient } from '../services/cv-client.js';
import { ensureLoaded, getPages } from './state.js';
import { pagesWord } from './dom.js';
import { actionSheet } from './sheet.js';
import { openProgress } from './progress.js';
import { toast } from './toast.js';

const KINDS = {
  pdf: { title: 'Экспорт PDF' },
  ocrPdf: { title: 'PDF с текстом' },
  jpeg: { title: 'Экспорт JPG' },
  png: { title: 'Экспорт PNG' },
};

/**
 * Полноразмерный рендер страницы для экспорта. export.js сам просит формат
 * ({format: 'auto'} для PDF, 'jpeg' | 'png' для картинок). Страницу сначала
 * регистрируем в воркере: после перезапуска приложения он о ней ещё не знает.
 */
async function renderPage(page, { format = 'auto' } = {}) {
  await ensureLoaded(page);
  return cvClient.render(page.id, page.recipe, { target: 'full', format, quality: 0.9 });
}

export async function openExportSheet() {
  const n = getPages().length;
  if (!n) return;
  const kind = await actionSheet({
    title: `Экспорт: ${n} ${pagesWord(n)}`,
    actions: [
      { label: 'PDF', value: 'pdf' },
      { label: 'PDF с текстом (OCR)', value: 'ocrPdf', hint: 'Можно искать и копировать текст; дольше' },
      { label: 'Изображения JPG', value: 'jpeg' },
      { label: 'Изображения PNG', value: 'png' },
    ],
  });
  if (kind) await runExport(kind);
}

async function runExport(kind) {
  const pages = getPages().slice(); // снимок: порядок не должен меняться посреди экспорта
  const progress = openProgress({ title: KINDS[kind].title });
  progress.update({ text: 'Подготовка…' });
  const onProgress = (done, total, stage) => {
    progress.update({
      fraction: total ? done / total : null,
      // stage от export.js уже содержит номер страницы («Обработка страницы 2 из 5»).
      text: stage || `Готово страниц: ${Math.floor(done)} из ${total}`,
    });
  };

  try {
    const exp = await import('../services/export.js');
    const baseName = exp.makeBaseName(new Date());
    const common = { onProgress, signal: progress.signal, title: baseName };
    let files;
    if (kind === 'pdf' || kind === 'ocrPdf') {
      const fn = kind === 'pdf' ? exp.exportPdf : exp.exportSearchablePdf;
      const blob = await fn(pages, { ...common, renderPage });
      files = [new File([blob], `${baseName}.pdf`, { type: 'application/pdf' })];
    } else {
      files = await exp.exportImages(pages, {
        ...common, renderPage, format: kind, baseName,
      });
    }
    if (progress.signal.aborted) throw new DOMException('Отменено', 'AbortError');

    const size = files.reduce((s, f) => s + f.size, 0);
    progress.finish({
      title: 'Готово',
      text: `${files.length > 1 ? `Файлов: ${files.length}, ` : ''}${formatSize(size)}`,
      actions: [
        { label: 'Закрыть', onClick: () => progress.close() },
        {
          label: 'Поделиться',
          primary: true,
          onClick: async () => {
            try {
              const result = await exp.shareFiles(files, { title: baseName });
              if (result === 'downloaded') toast('Файл сохранён в «Загрузки»', { type: 'success' });
              if (result !== 'cancelled') progress.close();
            } catch (err) {
              toast(`Не удалось поделиться: ${err?.message ?? err}`, { type: 'error' });
            }
          },
        },
      ],
    });
  } catch (err) {
    progress.close();
    if (err?.name === 'AbortError') toast('Экспорт отменён');
    else {
      console.error(err);
      toast(`Ошибка экспорта: ${err?.message ?? err}`, { type: 'error' });
    }
  }
}

function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
