'use strict';
// Копирование файлов архива (фото, видео, документы) в хранилище. Ничего не перезаписывает.
const { path, fsx, isNative, nodeFs } = require('./platform');
const { mapPool } = require('./util');
const { needsConversion, convertBytes } = require('./imageconv');


const STAT_CONCURRENCY = 32;
const COPY_CONCURRENCY = 8;
const CONVERT_CONCURRENCY = 3;

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

// Дата в имени файла. Telegram называет файлы photo_1904@03-10-2026_09-46-36.jpg, а упорядочивание галереи
// (например, плагин Media Organizer) переименовывает их в 2026-10-03_09-46-36_001.webp: по дате это один и тот же файл.
// Возвращает ключ вида dt:2026-10-03_09-46-36 или null
const TG_DATE_RE = /@(\d{2})-(\d{2})-(\d{4})_(\d{2})-(\d{2})-(\d{2})/;
const ISO_DATE_RE = /(?:^|[^\d])(\d{4})-(\d{2})-(\d{2})[_ T](\d{2})-(\d{2})-(\d{2})(?!\d)/;
function dateKey(fileName) {
  let m = TG_DATE_RE.exec(fileName);
  if (m) return `dt:${m[3]}-${m[2]}-${m[1]}_${m[4]}-${m[5]}-${m[6]}`;
  m = ISO_DATE_RE.exec(fileName);
  return m ? `dt:${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}-${m[6]}` : null;
}
let byDate = true;
const setMediaByDate = (on) => { byDate = on !== false; };
const getMediaByDate = () => byDate;

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

// Даты в именах медиафайлов, уже лежащих в папке назначения (в любых подпапках): ключ даты -> имя файла
async function collectDateKeys(root) {
  const keys = new Map();
  const SKIP = new Set(['.obsidian', '.git', '.trash', 'node_modules']);
  const walk = async (dir) => {
    let entries;
    try { entries = await fsx.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory()) { if (!SKIP.has(e.name)) subdirs.push(path.join(dir, e.name)); } else if (e.isFile() && EXT_FAMILY.has(path.extname(e.name).slice(1).toLowerCase())) {
        const k = dateKey(e.name);
        if (k && !keys.has(k)) keys.set(k, e.name);
      }
    }
    await Promise.all(subdirs.map(walk));
  };
  await walk(root);
  return keys;
}

const posixRel = (...parts) => parts.filter(Boolean).join('/').replace(/\\/g, '/');
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// Записывает файл с конвертацией. Возвращает { name, converted, size, saved }: name — итоговое имя (если
// конвертировать не удалось или результат больше исходного, файл копируется как есть под исходным расширением)
async function writeConverted(srcFile, dstDir, toName, origName, st, convert) {
  const bytes = await fsx.readBytes(srcFile);
  const r = await convertBytes(bytes, convert);
  if (r) {
    const to = path.join(dstDir, toName);
    if (await fsx.exists(to)) throw new Error(`файл уже существует: ${to}`);
    await fsx.writeFile(to, r.bytes);
    await fsx.utimes(to, st.atime, st.mtime).catch(() => {});
    return { name: toName, converted: true, size: r.bytes.length, saved: Math.max(0, bytes.length - r.bytes.length) };
  }
  const stem = toName.slice(0, toName.lastIndexOf('.') > 0 ? toName.lastIndexOf('.') : toName.length);
  const name = `${stem}${origName.includes('.') ? origName.slice(origName.lastIndexOf('.')) : ''}`;
  const to = path.join(dstDir, name);
  await fsx.copyFile(srcFile, to);
  await fsx.utimes(to, st.atime, st.mtime).catch(() => {});
  return { name, converted: false, size: st.size, saved: 0 };
}

// Копирует архив в хранилище. Папки объединяются; существующие файлы НЕ перезаписываются
// (ни с тем же именем, ни в другом формате того же медиа, ни переименованные по дате), а файлы с идентичным
// содержимым под другим именем в той же папке считаются дубликатами и пропускаются.
// hooks: onProgress(done, total, label), isCancelled(),
//   plan — Map «путь в архиве -> куда положить» (раскладка по годам, новые имена и расширения), convert — настройки конвертации.
// Возвращает статистику и resolved: Map «путь в архиве -> имя файла в хранилище» (для ссылок в заметках)
async function copyArchive(src, dst, hooks = {}) {
  const stats = { copied: 0, skipped: 0, errors: 0, bytes: 0, converted: 0, saved: 0 };
  const resolved = new Map();
  const convert = hooks.convert || null;
  const plan = hooks.plan || null;
  const { dirs, total } = await scanArchive(src);
  let done = 0;
  const advance = (n, label) => {
    done += n;
    if (hooks.onProgress) hooks.onProgress(done, total, label);
  };
  if (hooks.onProgress) hooks.onProgress(0, total, '');
  const dateKeys = byDate ? await collectDateKeys(dst) : null; // файлы, переименованные по дате, считаются уже существующими

  // Куда идёт каждый файл: группы по папке назначения
  const groups = new Map();
  for (const { rel, files } of dirs) {
    for (const name of files) {
      const fromRel = posixRel(rel, name);
      const toRel = (plan && plan.get(fromRel)) || fromRel;
      const toDir = dirOf(toRel);
      if (!groups.has(toDir)) groups.set(toDir, []);
      groups.get(toDir).push({ fromRel, name, toName: baseOf(toRel), srcFile: path.join(src, rel, name) });
    }
  }

  for (const [toDir, jobs] of groups) {
    if (hooks.isCancelled && hooks.isCancelled()) break;
    const dstDir = path.join(dst, ...toDir.split('/').filter(Boolean));
    await fsx.mkdir(dstDir, { recursive: true });

    const dstNames = await fsx.readdir(dstDir);
    const existingNames = new Map(); // имя в нижнем регистре -> настоящее имя
    const existingKeys = new Map();
    for (const name of dstNames) {
      existingNames.set(name.toLowerCase(), name);
      const key = mediaKey(name);
      if (key && !existingKeys.has(key)) existingKeys.set(key, name);
    }

    // 1. быстрый отсев по имени (без обращения к диску)
    const candidates = [];
    for (const job of jobs) {
      const key = mediaKey(job.toName);
      const dk = dateKeys ? dateKey(job.name) : null;
      const found = existingNames.get(job.toName.toLowerCase()) || (key && existingKeys.get(key)) || (dk && dateKeys.get(dk));
      if (found) { stats.skipped++; resolved.set(job.fromRel, found); advance(1, job.name); } else candidates.push(job);
    }
    if (!candidates.length) continue;

    // 2. размеры файлов-кандидатов и уже лежащих в хранилище (параллельно)
    const srcStats = await mapPool(candidates, STAT_CONCURRENCY, (job) => fsx.stat(job.srcFile).catch(() => null));
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
      const job = candidates[i];
      const st = srcStats[i];
      if (!st) { stats.errors++; advance(1, job.name); continue; }

      const willConvert = needsConversion(job.fromRel, convert);
      const key = mediaKey(job.toName);
      let found = existingNames.get(job.toName.toLowerCase()) || (key && existingKeys.get(key)) || null;
      if (!found && !willConvert) {
        for (const ref of sizeIndex.get(st.size) || []) {
          try {
            if (await sameContent(job.srcFile, ref)) { found = baseOf(ref.replace(/\\/g, '/')); break; }
          } catch (e) { /* не смогли прочитать — считаем файлы разными */ }
        }
      }
      if (found) { stats.skipped++; resolved.set(job.fromRel, found); advance(1, job.name); continue; }

      existingNames.set(job.toName.toLowerCase(), job.toName);
      if (key) existingKeys.set(key, job.toName);
      if (!willConvert) addSize(st.size, job.srcFile); // следующие файлы сравниваются и с тем, что ещё только копируется
      toCopy.push({ job, st, willConvert });
    }

    // 4. копирование и конвертация (параллельно; конвертация тяжелее, поэтому потоков меньше)
    const anyConvert = toCopy.some((x) => x.willConvert);
    await mapPool(toCopy, anyConvert ? CONVERT_CONCURRENCY : COPY_CONCURRENCY, async ({ job, st, willConvert }) => {
      try {
        if (willConvert) {
          const r = await writeConverted(job.srcFile, dstDir, job.toName, job.name, st, convert);
          resolved.set(job.fromRel, r.name);
          stats.bytes += r.size;
          if (r.converted) { stats.converted++; stats.saved += r.saved; }
        } else {
          await fsx.copyFile(job.srcFile, path.join(dstDir, job.toName));
          await fsx.utimes(path.join(dstDir, job.toName), st.atime, st.mtime).catch(() => {});
          resolved.set(job.fromRel, job.toName);
          stats.bytes += st.size;
        }
        stats.copied++;
      } catch (e) {
        console.error('[telegram-import] ошибка копирования', job.srcFile, e);
        stats.errors++;
      }
      advance(1, job.name);
    }, hooks.isCancelled);
  }
  stats.resolved = resolved;
  return stats;
}

module.exports = { dateKey, setMediaByDate, getMediaByDate, setFormatMatching, getFormatMatching, EXT_FAMILY, mediaKey, isThumbnail, sameContent, scanArchive, copyArchive };
