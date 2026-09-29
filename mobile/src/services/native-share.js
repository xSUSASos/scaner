// «Поделиться» внутри нативного iOS-приложения (Capacitor).
//
// В WKWebView у Capacitor navigator.share с файлами работает ненадёжно, поэтому:
//   1) пишем каждый File во временную папку приложения (Filesystem, Directory CACHE);
//   2) открываем системное меню «Поделиться» (Share) со ссылками file:// на эти файлы.
//
// Бандлера нет, поэтому @capacitor/core не импортируем. Плагины берём из глобального
// объекта: нативная часть Capacitor (JSExport.swift) сама внедряет в страницу
// window.Capacitor.Plugins.Filesystem / .Share для каждого установленного плагина.
//
// Вызывается из export.js только когда Capacitor.isNativePlatform() === true.

const DIR = 'CACHE'; // = Directory.Cache из @capacitor/filesystem
const ROOT = 'share'; // подпапка во временной папке; чистим перед каждым новым «Поделиться»
// Размер порции в байтах. Кратен 3, чтобы каждая порция кодировалась в base64 без «=»
// в середине, и куски можно было дописывать в файл по очереди (appendFile).
// ~3 МБ -> ~4 МБ base64 за один вызов моста: 20-мегабайтный PDF не держим в памяти строкой целиком.
const CHUNK = 3 * 1024 * 1024;

function plugins() {
  const p = globalThis.Capacitor?.Plugins;
  if (!p?.Filesystem || !p?.Share) {
    throw new Error('Плагины Capacitor Filesystem/Share недоступны');
  }
  return p;
}

// Blob -> base64 без префикса «data:...;base64,». FileReader кодирует в нативном коде,
// поэтому нет ни String.fromCharCode(...огромный массив) (переполнение стека), ни лишних копий.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('Не удалось прочитать файл'));
    r.readAsDataURL(blob);
  });
}

// Имя файла без символов, которые ломают путь; дубли -> «имя (2).pdf».
function safeNames(files) {
  const used = new Set();
  return files.map((f, i) => {
    let name = String(f.name || `file-${i + 1}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || `file-${i + 1}`;
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

async function writeFile(Filesystem, path, file) {
  let uri = null;
  let off = 0;
  // do...while: пустой файл тоже создаётся (один вызов writeFile с пустыми данными).
  do {
    const data = await blobToBase64(file.slice(off, off + CHUNK));
    if (off === 0) {
      // Без encoding данные считаются base64 и пишутся как байты.
      ({ uri } = await Filesystem.writeFile({ path, data, directory: DIR, recursive: true }));
    } else {
      await Filesystem.appendFile({ path, data, directory: DIR });
    }
    off += CHUNK;
  } while (off < file.size);
  return uri;
}

function isCancel(err) {
  // iOS-плагин Share отклоняет промис сообщением «Share canceled», если меню закрыли.
  return /cancel/i.test(String(err?.message ?? err));
}

/**
 * Открыть системное меню «Поделиться» для файлов.
 * @param {File[]} files  PDF / JPG / PNG / TXT
 * @param {{title?: string}} [opts]
 * @returns {Promise<'shared'|'cancelled'>}
 */
export async function shareNative(files, { title } = {}) {
  const { Filesystem, Share } = plugins();
  if (!files?.length) throw new Error('Нет файлов для отправки');

  // Удаляем файлы прошлого «Поделиться» (сразу после показа меню удалять нельзя:
  // получатель, например «Сохранить в Файлы», может ещё читать их).
  try {
    await Filesystem.rmdir({ path: ROOT, directory: DIR, recursive: true });
  } catch {
    /* папки ещё нет — это нормально */
  }

  const folder = `${ROOT}/${Date.now()}`;
  const names = safeNames(files);
  const uris = [];
  for (let i = 0; i < files.length; i++) {
    uris.push(await writeFile(Filesystem, `${folder}/${names[i]}`, files[i]));
  }

  try {
    await Share.share({ title, files: uris });
    return 'shared';
  } catch (err) {
    if (isCancel(err)) return 'cancelled';
    throw err;
  }
}
