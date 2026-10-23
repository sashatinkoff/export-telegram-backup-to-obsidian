'use strict';
// Общие мелкие утилиты: даты, файловые операции, пул параллельных задач.
const { fsx, path, sha1Hex } = require('./platform');


const tick = () => new Promise((r) => setTimeout(r, 0)); // отдаём управление интерфейсу Obsidian

// Истинность как в Python: пустые строки, списки и словари — ложь
const py = (v) => {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
};
const isDict = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const pad2 = (n) => String(n).padStart(2, '0');

const MONTHS_RU_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/;

function parseDate(str) {
  const m = DATE_RE.exec(String(str || ''));
  if (!m) throw new Error(`Не удалось разобрать дату сообщения: ${str}`);
  const [y, mo, d, H, M, S] = m.slice(1).map(Number);
  return { y, mo, d, H, M, S, ts: Date.UTC(y, mo - 1, d, H, M, S) / 1000 };
}

// Небольшое подмножество strftime
function formatDate(fmt, dt) {
  return fmt.replace(/%([A-Za-z%])/g, (all, c) => {
    switch (c) {
      case 'Y': return String(dt.y);
      case 'y': return pad2(dt.y % 100);
      case 'm': return pad2(dt.mo);
      case 'd': return pad2(dt.d);
      case 'H': return pad2(dt.H);
      case 'M': return pad2(dt.M);
      case 'S': return pad2(dt.S);
      case 'B': return MONTHS_EN[dt.mo - 1];
      case 'b': return MONTHS_EN[dt.mo - 1].slice(0, 3);
      case '%': return '%';
      default: return all;
    }
  });
}

const sha = (text) => sha1Hex(text).slice(0, 16);

// ---------- файлы ----------

async function readOrNull(file) {
  try { return await fsx.readFile(file, 'utf8'); } catch (e) { return null; }
}

// Запись с автоматическим созданием папки: mkdir вызывается только если папки ещё нет
async function writeText(file, text) {
  await fsx.writeFile(file, text); // папки создаются при необходимости
}

// Атомарная запись служебных файлов: сначала во временный, потом переименование
async function writeTextAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeText(tmp, text);
  await fsx.rename(tmp, file);
}

async function removeIfExists(file) {
  try { await fsx.unlink(file); } catch (e) { /* файла нет — и хорошо */ }
}

// Путь относительно корня хранилища с прямыми слэшами (так хранятся ключи заметок)
const toKey = (base, abs) => path.relative(base, abs).split(path.sep).join('/');

// ---------- параллельность ----------

// Выполняет fn(item, index) для всех элементов, не более `limit` одновременно.
// shouldStop() — проверка отмены перед запуском каждой следующей задачи.
let gateFn = null; // пока возвращает промис, воркеры ждут (пауза импорта)
const setGate = (fn) => { gateFn = fn; };

async function mapPool(items, limit, fn, shouldStop) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    for (;;) {
      if (gateFn) { const g = gateFn(); if (g) await g; }
      if (failed || (shouldStop && shouldStop())) return;
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Вызывает fn не чаще раза в `ms` миллисекунд (последний вызов не теряется)
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  const run = () => { timer = null; last = Date.now(); fn(); };
  const wrapper = () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null; } run(); } else if (!timer) timer = setTimeout(run, wait);
  };
  wrapper.flush = () => { if (timer) { clearTimeout(timer); run(); } };
  return wrapper;
}

module.exports = {
  tick, py, isDict, pad2, MONTHS_RU_GENITIVE, MONTHS_EN, parseDate, formatDate,
  sha, readOrNull, writeText, writeTextAtomic, removeIfExists, toKey, mapPool, throttle,
};

// Путь внутри хранилища (относительный) -> абсолютный, с защитой от выхода за его пределы
function resolveInVault(base, relPath, label) {
  const abs = path.resolve(base, relPath || '');
  const rel = path.relative(base, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${label} должна находиться внутри хранилища`);
  return abs;
}
module.exports.resolveInVault = resolveInVault;

// Путь внутри хранилища без лишних слешей. Пустая строка — корень хранилища
const trimRel = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
// Папка назначения: пусто = корень хранилища (заметки сразу в notes/, файлы архива рядом)
const targetRel = (settings) => trimRel(settings.targetFolder);
// Папка пересчёта ссылок: пусто = «<папка назначения>/notes»
const recalcRel = (settings) => trimRel(settings.recalcFolder) || [targetRel(settings), 'notes'].filter(Boolean).join('/');
// Подпись для интерфейса: «Telegram/» или «корень хранилища»
const targetLabel = (settings) => { const t = targetRel(settings); return t ? `${t}/` : 'корень хранилища'; };
module.exports.trimRel = trimRel;
module.exports.targetRel = targetRel;
module.exports.recalcRel = recalcRel;
module.exports.targetLabel = targetLabel;
module.exports.setGate = setGate;
module.exports.getGate = () => gateFn;
