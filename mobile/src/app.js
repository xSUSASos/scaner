/**
 * Точка входа: собирает экраны, навигацию и глобальную обработку ошибок.
 *
 * Навигация через history: при открытии редактора делаем pushState, поэтому
 * системный жест «назад» (свайп от края в Safari) и кнопка «Назад» Android-браузера
 * возвращают на главный экран, а не закрывают приложение.
 */
import * as state from './ui/state.js';
import { createHomeView } from './ui/home-view.js';
import { createEditorView } from './ui/editor-view.js';
import { openExportSheet } from './ui/export-sheet.js';
import { openProgress } from './ui/progress.js';
import { toast } from './ui/toast.js';
import { pagesWord } from './ui/dom.js';
import { confirmDialog } from './ui/sheet.js';

const root = document.getElementById('app');
let editor = null; // открытый редактор или null

// ---------- глобальные ошибки ----------
// Любое необработанное исключение — в сообщение, а не в «тихо сломалось».
window.addEventListener('error', (e) => {
  console.error(e.error ?? e.message);
  toast(`Ошибка: ${e.error?.message ?? e.message}`, { type: 'error' });
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(`Ошибка: ${e.reason?.message ?? e.reason}`, { type: 'error' });
});
state.onError((err) => toast(err?.message ?? String(err), { type: 'error' }));

// ---------- экраны ----------
const home = createHomeView({
  onOpenPage: (id) => openEditor(id),
  onImport: (files, source) => runImport(files, source),
  onExport: () => openExportSheet(),
});
root.append(home.el);

/** Показать редактор страницы. push=false — при переходе по истории (popstate). */
function openEditor(id, { push = true, replace = false } = {}) {
  if (!state.getPage(id)) return;
  closeEditor();
  editor = createEditorView(id, {
    onBack: () => goHome(),
    onNavigate: (nextId) => openEditor(nextId, { push: false, replace: true }),
  });
  root.append(editor.el);
  home.el.setAttribute('aria-hidden', 'true');
  if (replace) history.replaceState({ view: 'editor', id }, '');
  else if (push) history.pushState({ view: 'editor', id }, '');
}

function closeEditor() {
  if (!editor) return;
  editor.destroy();
  editor.el.remove();
  editor = null;
  home.el.removeAttribute('aria-hidden');
}

/** «Назад» из редактора: через историю, чтобы запись pushState не осталась висеть. */
function goHome() {
  if (history.state?.view === 'editor') history.back(); // дальше сработает popstate
  else closeEditor();
}

window.addEventListener('popstate', (e) => {
  if (e.state?.view === 'editor' && state.getPage(e.state.id)) openEditor(e.state.id, { push: false });
  else closeEditor();
});

// ---------- импорт ----------
async function runImport(files, source) {
  const progress = openProgress({ title: 'Добавление страниц' });
  let lastAdded = null;
  const before = new Set(state.getPages().map((p) => p.id));
  try {
    const { added, errors } = await state.importFiles(files, {
      signal: progress.signal,
      onProgress: (done, total) => progress.update({
        fraction: total ? done / total : null,
        text: done < total ? `Обработка ${done + 1} из ${total}` : 'Готово',
      }),
    });
    lastAdded = state.getPages().find((p) => !before.has(p.id)) ?? null;
    if (added) toast(`Добавлено: ${added} ${pagesWord(added)}`, { type: 'success' });
    if (errors.length) {
      const more = errors.length > 3 ? ` и ещё ${errors.length - 3}` : '';
      toast(`Не добавлено: ${errors.slice(0, 3).join('; ')}${more}`, { type: 'error' });
    }
    // Снимок с камеры — сразу в редактор, как в CamScanner: проверить обрезку.
    if (source === 'camera' && added === 1 && lastAdded) openEditor(lastAdded.id);
  } finally {
    progress.close();
  }
}

// ---------- сохранение перед сворачиванием ----------
// iOS может выгрузить свёрнутое приложение без предупреждения — отложенные
// сохранения выполняем сразу, как только оно ушло в фон.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') state.flushPending();
});
window.addEventListener('pagehide', () => state.flushPending());

// ---------- запуск ----------
async function start() {
  // После перезагрузки в истории может остаться запись редактора — начинаем с главного.
  if (history.state?.view === 'editor') history.replaceState(null, '');
  try {
    await state.init();
  } catch (err) {
    console.error(err);
    toast(`Не удалось открыть сохранённые страницы: ${err?.message ?? err}`, { type: 'error' });
  }
  // Service worker — офлайн-работа. Не критичен: ошибка не мешает приложению.
  import('./services/pwa.js')
    .then((m) => {
      m.registerServiceWorker();
      // Новая версия уже скачана — предлагаем перезапуск (всё сохранено в IndexedDB).
      m.onUpdateAvailable?.(async () => {
        const ok = await confirmDialog({
          title: 'Доступна новая версия',
          message: 'Перезапустить приложение сейчас? Страницы сохранятся.',
          confirmText: 'Обновить',
          cancelText: 'Позже',
        });
        if (ok) {
          state.flushPending();
          location.reload();
        }
      });
    })
    .catch((err) => console.warn('Service worker не зарегистрирован', err));
}

// Точка для отладки из консоли (и для автотестов в браузере).
window.__scaner = { state, runImport, openEditor, goHome };

start();
