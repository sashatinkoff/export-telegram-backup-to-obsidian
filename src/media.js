'use strict';
// Копирование файлов архива (фото, видео, документы) в хранилище. Ничего не перезаписывает.
const { path, fsx, isNative, nodeFs } = require('./platform');
const { mapPool } = require('./util');


const STAT_CONCURRENCY = 32;
const COPY_CONCURRENCY = 8;

const THUMB_SKIP_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isThumbnail(fileName) {
  const name = fileName.toLowerCase();
  return name.includes('_thumb') || name.includes('_preview')
    || name.endsWith('.mp4.jpg') || name.endsWith('.mp4_thumb.jpg');
}

// Семейства форматов: файл «a.png» считается уже существующим, если рядом лежит «a.webp»
// (вы могли сжать картинку или видео). Документы и прочие файлы сравниваются только по точному имени.
const MEDIA_FAMILIES = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'bmp', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aac'],
};
const EXT_FAMILY = new Map();
for (const [family, exts] of Object.entries(MEDIA_FAMILIES)) exts.forEach((e) => EXT_FAMILY.set(e, family));

// Как считать файлы с одинаковым именем и разным расширением (настройка «Файлы с тем же именем»):
//   kind (по умолчанию) — тот же файл, если расширения из одного вида: a.png и a.webp (изображения, видео, аудио)
//   any — тот же файл при любом расширении: a.jpg, a.pdf, a.zip
//   off — сравнивается точное имя вместе с расширением
// Это же правило применяется к ссылкам на медиа при сравнении текста заметок.
let sameNameMode = 'kind';
const MODES = new Set(['kind', 'any', 'off']);
const setFormatMatching = (mode) => {
  if (mode === true) sameNameMode = 'kind';
  else if (mode === false) sameNameMode = 'off';
  else sameNameMode = MODES.has(mode) ? mode : 'kind';
};
const getFormatMatching = () => sameNameMode;

function mediaKey(fileName) {
  if (sameNameMode === 'off') return null;
  const ext = path.extname(fileName);
  if (sameNameMode === 'any') return ext.length > 1 ? `any:${path.basename(fileName, ext).toLowerCase()}` : null;
  const family = EXT_FAMILY.get(ext.slice(1).toLowerCase());
  return family ? `${family}:${path.basename(fileName, ext).toLowerCase()}` : null;
}

// Побайтовое сравнение двух файлов (вызывается только для файлов одинакового размера)
async function sameContent(fileA, fileB) {
  if (!isNative) { // телефон: файлы читаются целиком
    const [a, b] = [await fsx.readBytes(fileA), await fsx.readBytes(fileB)];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  const CHUNK = 1024 * 1024;
  const [ha, hb] = [await nodeFs.promises.open(fileA, 'r'), await nodeFs.promises.open(fileB, 'r')];
  try {
    const bufA = Buffer.allocUnsafe(CHUNK);
    const bufB = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const [ra, rb] = [await ha.read(bufA, 0, CHUNK, null), await hb.read(bufB, 0, CHUNK, null)];
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await ha.close();
    await hb.close();
  }
}

// Обходит архив: список папок с файлами (result.json в корне и превью пропускаются)
async function scanArchive(src) {
  const dirs = [];
  let total = 0;
  const walk = async (rel) => {
    const entries = await fsx.readdir(path.join(src, rel), { withFileTypes: true });
    const files = [];
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory()) subdirs.push(e.name);
      else if (e.isFile()) {
        if (rel === '' && e.name === 'result.json') continue;
        if (THUMB_SKIP_EXTS.has(path.extname(e.name).toLowerCase()) && isThumbnail(e.name)) continue;
        files.push(e.name);
      }
    }
    dirs.push({ rel, files });
    total += files.length;
    for (const d of subdirs) await walk(rel ? path.join(rel, d) : d);
  };
  await walk('');
  return { dirs, total };
}

// Копирует архив в хранилище. Папки объединяются; существующие файлы НЕ перезаписываются
// (ни с тем же именем, ни в другом формате того же медиа), а файлы с идентичным содержимым под другим
// именем в той же папке считаются дубликатами и пропускаются.
// hooks: onProgress(done, total, label), isCancelled()
async function copyArchive(src, dst, hooks = {}) {
  const stats = { copied: 0, skipped: 0, errors: 0, bytes: 0 };
  const { dirs, total } = await scanArchive(src);
  let done = 0;
  const advance = (n, label) => {
    done += n;
    if (hooks.onProgress) hooks.onProgress(done, total, label);
  };
  if (hooks.onProgress) hooks.onProgress(0, total, '');

  for (const { rel, files } of dirs) {
    if (hooks.isCancelled && hooks.isCancelled()) break;
    const srcDir = path.join(src, rel);
    const dstDir = path.join(dst, rel);
    await fsx.mkdir(dstDir, { recursive: true });
    if (!files.length) continue;

    const dstNames = await fsx.readdir(dstDir);
    const existingNames = new Set();
    const existingKeys = new Set();
    for (const name of dstNames) {
      existingNames.add(name.toLowerCase());
      const key = mediaKey(name);
      if (key) existingKeys.add(key);
    }

    // 1. быстрый отсев по имени (без обращения к диску)
    const candidates = [];
    for (const name of files) {
      const key = mediaKey(name);
      if (existingNames.has(name.toLowerCase()) || (key && existingKeys.has(key))) stats.skipped++;
      else candidates.push(name);
    }
    advance(files.length - candidates.length, rel);
    if (!candidates.length) continue;

    // 2. размеры файлов-кандидатов и уже лежащих в хранилище (параллельно)
    const srcStats = await mapPool(candidates, STAT_CONCURRENCY, (name) => fsx.stat(path.join(srcDir, name)).catch(() => null));
    const sizeIndex = new Map(); // размер -> пути файлов, с которыми сравниваем содержимое
    const addSize = (size, file) => {
      if (!sizeIndex.has(size)) sizeIndex.set(size, []);
      sizeIndex.get(size).push(file);
    };
    const dstStats = await mapPool(dstNames, STAT_CONCURRENCY, (name) => fsx.stat(path.join(dstDir, name)).catch(() => null));
    dstNames.forEach((name, i) => { if (dstStats[i] && dstStats[i].isFile()) addSize(dstStats[i].size, path.join(dstDir, name)); });

    // 3. решения принимаются по порядку, чтобы дубликаты внутри самого архива тоже находились
    const toCopy = [];
    for (let i = 0; i < candidates.length; i++) {
      const name = candidates[i];
      const st = srcStats[i];
      const srcFile = path.join(srcDir, name);
      if (!st) { stats.errors++; advance(1, name); continue; }

      const key = mediaKey(name);
      let skip = existingNames.has(name.toLowerCase()) || (key && existingKeys.has(key));
      if (!skip) {
        for (const ref of sizeIndex.get(st.size) || []) {
          try {
            if (await sameContent(srcFile, ref)) { skip = true; break; }
          } catch (e) { /* не смогли прочитать — считаем файлы разными */ }
        }
      }
      if (skip) { stats.skipped++; advance(1, name); continue; }

      existingNames.add(name.toLowerCase());
      if (key) existingKeys.add(key);
      addSize(st.size, srcFile); // следующие файлы сравниваются и с тем, что ещё только копируется
      toCopy.push({ name, st });
    }

    // 4. копирование (параллельно)
    await mapPool(toCopy, COPY_CONCURRENCY, async ({ name, st }) => {
      const from = path.join(srcDir, name);
      const to = path.join(dstDir, name);
      try {
        await fsx.copyFile(from, to);
        await fsx.utimes(to, st.atime, st.mtime).catch(() => {});
        stats.copied++;
        stats.bytes += st.size;
      } catch (e) {
        console.error('[telegram-import] ошибка копирования', from, e);
        stats.errors++;
      }
      advance(1, name);
    }, hooks.isCancelled);
  }
  return stats;
}

module.exports = { setFormatMatching, getFormatMatching, EXT_FAMILY, mediaKey, isThumbnail, sameContent, scanArchive, copyArchive };
