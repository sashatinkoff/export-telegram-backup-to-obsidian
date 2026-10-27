'use strict';
// Конвертация изображений при копировании: другой формат (webp, jpeg, png) и ограничение размера по большей стороне.
// Работает средствами браузера (createImageBitmap и canvas), поэтому одинаково на десктопе и на телефоне, без библиотек.
// Что не удалось раскодировать или закодировать, копируется как есть.

const SOURCE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif']); // gif не трогаем: в нём может быть анимация
const FORMATS = { webp: { mime: 'image/webp', ext: 'webp' }, jpeg: { mime: 'image/jpeg', ext: 'jpg' }, png: { mime: 'image/png', ext: 'png' } };
const SKIP_DIRS = new Set(['stickers']); // стикеры (прозрачные webp) остаются как есть

// Настройки конвертации из настроек плагина: null, если конвертация выключена
function convertOptions(settings) {
  if (!settings || !settings.convertImages) return null;
  const format = FORMATS[settings.imageFormat] ? settings.imageFormat : 'webp';
  const q = Number(settings.imageQuality);
  const maxSide = Number(settings.imageMaxSide);
  return {
    format,
    quality: Math.min(100, Math.max(1, Number.isFinite(q) && q > 0 ? q : 80)),
    maxSide: Number.isFinite(maxSide) && maxSide > 0 ? Math.floor(maxSide) : 0,
  };
}

const extOf = (name) => { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; };

// Нужна ли конвертация файла (relPath — путь в архиве с прямыми слэшами). Тот же формат без ограничения размера не трогаем
function needsConversion(relPath, opts) {
  if (!opts) return false;
  const parts = relPath.split('/');
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d.toLowerCase()))) return false;
  const ext = extOf(parts[parts.length - 1]);
  if (!SOURCE_EXTS.has(ext)) return false;
  const sameFormat = FORMATS[opts.format].ext === (ext === 'jpeg' ? 'jpg' : ext);
  return !(sameFormat && !opts.maxSide);
}

// Расширение файла после конвертации (с точкой) или null, если имя не меняется
function plannedExt(relPath, opts) {
  return needsConversion(relPath, opts) ? `.${FORMATS[opts.format].ext}` : null;
}

// Реализация кодирования. В тестах без браузера подменяется через setBackend
let backend = null;
const setBackend = (fn) => { backend = fn; };

async function browserConvert(bytes, opts) {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap недоступен');
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const { width, height } = bitmap;
    const scale = opts.maxSide ? Math.min(1, opts.maxSide / Math.max(width, height)) : 1;
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const fmt = FORMATS[opts.format];
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvas.getContext('2d');
    if (opts.format === 'jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); } // у jpeg нет прозрачности
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const quality = opts.format === 'png' ? undefined : opts.quality / 100;
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: fmt.mime, quality })
      : await new Promise((resolve) => canvas.toBlob(resolve, fmt.mime, quality));
    if (!blob || blob.type !== fmt.mime) throw new Error(`Формат ${opts.format} не поддерживается этим устройством`);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h, resized: scale < 1 };
  } finally {
    if (bitmap.close) bitmap.close();
  }
}

// Конвертирует байты изображения. Возвращает { bytes, width, height, resized } или null, если лучше оставить исходный файл:
// не получилось раскодировать/закодировать, либо результат больше исходного без уменьшения размера
async function convertBytes(bytes, opts) {
  try {
    const r = await (backend || browserConvert)(bytes, opts);
    if (!r || !r.bytes) return null;
    if (!r.resized && r.bytes.length >= bytes.length) return null;
    return r;
  } catch (e) {
    return null;
  }
}

module.exports = { convertOptions, needsConversion, plannedExt, convertBytes, setBackend, FORMATS, SOURCE_EXTS };
