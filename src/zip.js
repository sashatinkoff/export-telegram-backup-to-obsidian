'use strict';
// Чтение ZIP без внешних библиотек (в том числе ZIP64 и архивы больше 4 ГБ): список файлов и распаковка на диск.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const fsp = fs.promises;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

const big = (v) => Number(v); // размеры до 2^53 хватает с запасом

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

function dosDate(date, time) {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

// Список записей архива: { name, method, csize, usize, offset, mtime, dir }
async function listZip(zipPath) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const size = (await fh.stat()).size;
    const tailLen = Math.min(size, 0xffff + 22 + 20);
    const tail = await readAt(fh, size - tailLen, tailLen);
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG_EOCD) { e = i; break; }
    if (e < 0) throw new Error('Это не ZIP-архив (не найден конец каталога)');

    let count = tail.readUInt16LE(e + 10);
    let cdSize = tail.readUInt32LE(e + 12);
    let cdOffset = tail.readUInt32LE(e + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) { // ZIP64
      const l = e - 20;
      if (l < 0 || tail.readUInt32LE(l) !== SIG_LOC64) throw new Error('Повреждённый ZIP64-архив');
      const pos64 = big(tail.readBigUInt64LE(l + 8));
      const rec = await readAt(fh, pos64, 56);
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new Error('Повреждённый ZIP64-архив');
      count = big(rec.readBigUInt64LE(32));
      cdSize = big(rec.readBigUInt64LE(40));
      cdOffset = big(rec.readBigUInt64LE(48));
    }

    const cd = await readAt(fh, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== SIG_CEN) throw new Error('Повреждённый каталог ZIP');
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const time = cd.readUInt16LE(p + 12);
      const date = cd.readUInt16LE(p + 14);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString(flags & 0x800 ? 'utf8' : 'utf8', p + 46, p + 46 + nameLen);
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let x = 0; x + 4 <= extra.length;) {
        const id = extra.readUInt16LE(x);
        const len = extra.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = big(extra.readBigUInt64LE(q)); q += 8; }
          if (csize === 0xffffffff) { csize = big(extra.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff) { offset = big(extra.readBigUInt64LE(q)); q += 8; }
        }
        x += 4 + len;
      }
      entries.push({ name, method, csize, usize, offset, mtime: dosDate(date, time), dir: name.endsWith('/') });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
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

function openEntry(fh, entry) {
  return readAt(fh, entry.offset, 30).then((head) => {
    if (head.readUInt32LE(0) !== SIG_LOC) throw new Error(`Повреждённая запись в ZIP: ${entry.name}`);
    const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
    return { start, end: start + entry.csize - 1 };
  });
}

function entryStream(zipPath, fh, entry, range) {
  const raw = fs.createReadStream(zipPath, { start: range.start, end: Math.max(range.start, range.end), autoClose: true });
  if (entry.csize === 0) { raw.destroy(); return require('stream').Readable.from([]); }
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
  raw.destroy();
  throw new Error(`Неподдерживаемый способ сжатия в ZIP (${entry.method}): ${entry.name}`);
}

// Читает одну запись целиком (для result.json)
async function readEntry(zipPath, entry) {
  const fh = await fsp.open(zipPath, 'r');
  try {
    const range = await openEntry(fh, entry);
    const chunks = [];
    for await (const c of entryStream(zipPath, fh, entry, range)) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await fh.close();
  }
}

// Распаковывает записи под prefix в destDir (prefix отбрасывается). Возвращает число файлов.
// hooks: onProgress(done, total, label), isCancelled(), gate() — промис, пока идёт пауза
async function extractZip(zipPath, entries, prefix, destDir, hooks = {}) {
  const files = entries.filter((e) => !e.dir && e.name.startsWith(prefix) && !e.name.startsWith('__MACOSX/'));
  const root = path.resolve(destDir);
  const fh = await fsp.open(zipPath, 'r');
  let done = 0;
  try {
    if (hooks.onProgress) hooks.onProgress(0, files.length, '');
    for (const entry of files) {
      if (hooks.isCancelled && hooks.isCancelled()) break;
      if (hooks.gate) { const g = hooks.gate(); if (g) await g; }
      const rel = entry.name.slice(prefix.length);
      const out = path.resolve(root, ...rel.split('/'));
      if (out !== root && !out.startsWith(root + path.sep)) continue; // защита от путей вида ../
      await fsp.mkdir(path.dirname(out), { recursive: true });
      const range = await openEntry(fh, entry);
      await pipeline(entryStream(zipPath, fh, entry, range), fs.createWriteStream(out));
      await fsp.utimes(out, entry.mtime, entry.mtime).catch(() => {});
      done++;
      if (hooks.onProgress && (done % 20 === 0 || done === files.length)) hooks.onProgress(done, files.length, path.basename(rel));
    }
  } finally {
    await fh.close();
  }
  return done;
}

module.exports = { listZip, findResult, readEntry, extractZip };
