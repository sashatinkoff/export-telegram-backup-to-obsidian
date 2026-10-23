'use strict';
// Чтение ZIP без внешних библиотек (в том числе ZIP64 и архивы больше 4 ГБ): список файлов и распаковка.
// Источник zip — объект { path, file? }: путь на диске (десктоп), путь внутри хранилища (телефон)
// или выбранный через системный диалог File (телефон, читается кусками без загрузки всего архива в память).
const { path, fsx, isNative, nodeFs, inflateRaw } = require('./platform');

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const dv = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const u16 = (u8, o) => dv(u8).getUint16(o, true);
const u32 = (u8, o) => dv(u8).getUint32(o, true);
const u64 = (u8, o) => Number(dv(u8).getBigUint64(o, true)); // размеры до 2^53 хватает с запасом
const utf8 = new TextDecoder('utf-8');

function dosDate(date, time) {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

// ---------- чтение кусками ----------

// Возвращает { size, read(pos, len) -> Uint8Array, close() }
async function openReader(source) {
  if (typeof source === 'string') source = { path: source };
  if (source.file) {
    const f = source.file;
    return { size: f.size, read: async (pos, len) => new Uint8Array(await f.slice(pos, pos + len).arrayBuffer()), close: async () => {} };
  }
  if (isNative) {
    const fh = await nodeFs.promises.open(source.path, 'r');
    const size = (await fh.stat()).size;
    return {
      size,
      read: async (pos, len) => {
        const buf = new Uint8Array(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        return bytesRead === len ? buf : buf.subarray(0, bytesRead);
      },
      close: () => fh.close(),
    };
  }
  // телефон, ZIP лежит в хранилище: адаптер читает файл только целиком
  const all = await fsx.readBytes(source.path);
  return { size: all.length, read: async (pos, len) => all.subarray(pos, pos + len), close: async () => {} };
}

// Список записей архива: { name, method, csize, usize, offset, mtime, dir }
async function listZip(source) {
  const rd = await openReader(source);
  try {
    const size = rd.size;
    const tailLen = Math.min(size, 0xffff + 22 + 20);
    const tail = await rd.read(size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === SIG_EOCD) { e = i; break; }
    if (e < 0) throw new Error('Это не ZIP-архив (не найден конец каталога)');

    let count = u16(tail, e + 10);
    let cdSize = u32(tail, e + 12);
    let cdOffset = u32(tail, e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) { // ZIP64
      const l = e - 20;
      if (l < 0 || u32(tail, l) !== SIG_LOC64) throw new Error('Повреждённый ZIP64-архив');
      const rec = await rd.read(u64(tail, l + 8), 56);
      if (u32(rec, 0) !== SIG_EOCD64) throw new Error('Повреждённый ZIP64-архив');
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }

    const cd = await rd.read(cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (u32(cd, p) !== SIG_CEN) throw new Error('Повреждённый каталог ZIP');
      const method = u16(cd, p + 10);
      const time = u16(cd, p + 12);
      const date = u16(cd, p + 14);
      let csize = u32(cd, p + 20);
      let usize = u32(cd, p + 24);
      const nameLen = u16(cd, p + 28);
      const extraLen = u16(cd, p + 30);
      const commentLen = u16(cd, p + 32);
      let offset = u32(cd, p + 42);
      const name = utf8.decode(cd.subarray(p + 46, p + 46 + nameLen));
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let x = 0; x + 4 <= extra.length;) {
        const id = u16(extra, x);
        const len = u16(extra, x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = u64(extra, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(extra, q); q += 8; }
          if (offset === 0xffffffff) { offset = u64(extra, q); q += 8; }
        }
        x += 4 + len;
      }
      entries.push({ name, method, csize, usize, offset, mtime: dosDate(date, time), dir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await rd.close();
  }
}

// Где в архиве лежит result.json: возвращает { prefix, entry } (prefix — папка внутри архива, '' для корня)
function findResult(entries) {
  const hits = entries.filter((e) => !e.dir && /(^|\/)result\.json$/.test(e.name) && !e.name.startsWith('__MACOSX/'));
  if (!hits.length) return null;
  hits.sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  const entry = hits[0];
  return { entry, prefix: entry.name.slice(0, entry.name.length - 'result.json'.length) };
}

// Где лежат сжатые данные записи: { start, end }
async function dataRange(rd, entry) {
  const head = await rd.read(entry.offset, 30);
  if (head.length < 30 || u32(head, 0) !== SIG_LOC) throw new Error(`Повреждённая запись в ZIP: ${entry.name}`);
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  return { start, end: start + entry.csize - 1 };
}

// Содержимое записи целиком (Uint8Array)
async function entryBytes(rd, entry) {
  if (entry.csize === 0) return new Uint8Array(0);
  const { start } = await dataRange(rd, entry);
  const raw = await rd.read(start, entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`Неподдерживаемый способ сжатия в ZIP (${entry.method}): ${entry.name}`);
}

// Поток данных записи для распаковки прямо в файл (десктоп, большие файлы)
function entryStream(zipPath, entry, range) {
  const zlib = require('zlib');
  const raw = nodeFs.createReadStream(zipPath, { start: range.start, end: Math.max(range.start, range.end), autoClose: true });
  if (entry.csize === 0) { raw.destroy(); return require('stream').Readable.from([]); }
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
  raw.destroy();
  throw new Error(`Неподдерживаемый способ сжатия в ZIP (${entry.method}): ${entry.name}`);
}

// Читает одну запись целиком как текст (для result.json)
async function readEntry(source, entry) {
  const rd = await openReader(source);
  try {
    return utf8.decode(await entryBytes(rd, entry));
  } finally {
    await rd.close();
  }
}

// Распаковывает записи под prefix в destDir (prefix отбрасывается). Возвращает число файлов.
// hooks: onProgress(done, total, label), isCancelled(), gate() — промис, пока идёт пауза
async function extractZip(source, entries, prefix, destDir, hooks = {}) {
  if (typeof source === 'string') source = { path: source };
  const files = entries.filter((e) => !e.dir && e.name.startsWith(prefix) && !e.name.startsWith('__MACOSX/'));
  const root = path.resolve(destDir);
  const streaming = isNative && !source.file; // на десктопе файлы пишутся потоком, не загружаясь в память целиком
  const rd = await openReader(source);
  let done = 0;
  try {
    if (hooks.onProgress) hooks.onProgress(0, files.length, '');
    for (const entry of files) {
      if (hooks.isCancelled && hooks.isCancelled()) break;
      if (hooks.gate) { const g = hooks.gate(); if (g) await g; }
      const rel = entry.name.slice(prefix.length);
      const out = path.resolve(root, ...rel.split('/'));
      if (out !== root && !out.startsWith(root + path.sep)) continue; // защита от путей вида ../
      await fsx.mkdir(path.dirname(out));
      if (streaming) {
        const { pipeline } = require('stream/promises');
        await pipeline(entryStream(source.path, entry, await dataRange(rd, entry)), nodeFs.createWriteStream(out));
      } else {
        await fsx.writeFile(out, await entryBytes(rd, entry));
      }
      await fsx.utimes(out, entry.mtime, entry.mtime).catch(() => {});
      done++;
      if (hooks.onProgress && (done % 20 === 0 || done === files.length)) hooks.onProgress(done, files.length, path.basename(rel));
    }
  } finally {
    await rd.close();
  }
  return done;
}

module.exports = { listZip, findResult, readEntry, extractZip };
