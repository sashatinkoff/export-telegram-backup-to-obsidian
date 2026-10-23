'use strict';
// Небольшие хранилища в папке плагина: индекс импорта, очередь разбора, история, «оригиналы» заметок.
const { fsx, path } = require('./platform');
const { readOrNull, writeText, writeTextAtomic, removeIfExists } = require('./util');


// JSON-файл с версией формата. Если версия не совпала или файла нет, берётся пустое значение (fresh = true).
class JsonStore {
  constructor(file, version, makeEmpty) {
    this.file = file;
    this.version = version;
    this.makeEmpty = makeEmpty;
    this.data = makeEmpty();
    this.fresh = true;
    this.timer = null;
  }

  async load() {
    this.fresh = true;
    const raw = await readOrNull(this.file);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.version === this.version) {
          this.data = parsed;
          this.fresh = false;
          return;
        }
      } catch (e) { /* повреждённый файл — начинаем заново */ }
    }
    this.data = this.makeEmpty();
  }

  async save() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await writeTextAtomic(this.file, JSON.stringify(this.data));
  }

  // Отложенное сохранение: серия быстрых изменений приводит к одной записи
  saveSoon(ms = 600) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.save().catch((e) => console.error('[telegram-import] не удалось сохранить', this.file, e)); }, ms);
  }

  async flush() {
    if (this.timer) await this.save();
  }
}

// Индекс импорта: для каждой заметки — отпечаток её текста из Telegram при прошлом импорте
const INDEX_VERSION = 4;

// Запись о заметке: h — отпечаток её текста из Telegram при согласовании. Для быстрой проверки без чтения файла:
//   r — отпечаток исходного текста поста, m и s — дата изменения и размер файла после согласования,
//   k — заметка с вашими правками, c — отпечаток соседей Back/Next при последнем пересчёте ссылок.
class NoteIndex {
  constructor(file) {
    this.store = new JsonStore(file, INDEX_VERSION, () => ({ version: INDEX_VERSION, notes: {} }));
  }

  get fresh() { return this.store.fresh; }

  async load() { await this.store.load(); }

  entry(key) { return this.store.data.notes[key]; }

  get(key) {
    const e = this.store.data.notes[key];
    return e ? e.h : undefined;
  }

  // Забыть всё о прошлых импортах (следующий импорт сравнит заметки заново)
  async clear() {
    this.store.data.notes = {};
    await this.store.save();
  }

  // Новое состояние заметки: прежние «отпечатки файла» сбрасываются
  set(key, hash) { this.store.data.notes[key] = { h: hash }; }

  // Текст заметки (отпечаток), который вы уже просмотрели и оставили на экране разбора: повторно не предлагаем
  decided(key) { const e = this.store.data.notes[key]; return e ? e.d : undefined; }

  setDecided(key, hash) { const e = this.store.data.notes[key]; if (e) e.d = hash; }

  // Запоминает состояние файла, с которым заметка согласована (st — результат fs.stat)
  mark(key, { r, st, kept }) {
    const e = this.store.data.notes[key];
    if (!e) return;
    e.r = r;
    e.m = st.mtimeMs;
    e.s = st.size;
    if (kept) e.k = 1; else delete e.k;
    delete e.c;
  }

  // Для пересчёта ссылок: что известно о файле заметки
  linkInfo(key) {
    const e = this.store.data.notes[key];
    return e && e.m !== undefined ? { m: e.m, s: e.s, sig: e.c } : null;
  }

  setLinkInfo(key, st, sig) {
    const e = this.store.data.notes[key];
    if (!e || e.m === undefined) return;
    e.m = st.mtimeMs;
    e.s = st.size;
    e.c = sig;
  }

  save() { return this.store.save(); }

  saveSoon() { this.store.saveSoon(); }

  flush() { return this.store.flush(); }
}

// «Оригиналы»: версия текста из Telegram на момент последнего согласования — только для заметок, которые вы
// изменили. Нужна, чтобы потом объединить ваши правки с новыми изменениями из Telegram.
class Originals {
  constructor(dir) {
    this.dir = dir;
    this.keys = new Set();
  }

  async load() {
    this.keys.clear();
    const walk = async (dir, prefix) => {
      let entries;
      try { entries = await fsx.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`);
        else if (e.isFile()) this.keys.add(`${prefix}${e.name}`);
      }
    };
    await walk(this.dir, '');
  }

  pathOf(key) { return path.join(this.dir, ...key.split('/')); }

  has(key) { return this.keys.has(key); }

  async read(key) { return this.has(key) ? readOrNull(this.pathOf(key)) : null; }

  async write(key, text) {
    await writeText(this.pathOf(key), text);
    this.keys.add(key);
  }

  async remove(key) {
    if (!this.keys.delete(key)) return;
    await removeIfExists(this.pathOf(key));
  }

  async clear() {
    await fsx.rm(this.dir, { recursive: true, force: true });
    this.keys.clear();
  }
}

// История импортов
const HISTORY_VERSION = 1;
const HISTORY_LIMIT = 120;

class History {
  constructor(file) {
    this.store = new JsonStore(file, HISTORY_VERSION, () => ({ version: HISTORY_VERSION, runs: [] }));
  }

  async load() { await this.store.load(); }

  get runs() { return this.store.data.runs; }

  async add(run) {
    this.runs.push(run);
    if (this.runs.length > HISTORY_LIMIT) this.runs.splice(0, this.runs.length - HISTORY_LIMIT);
    await this.store.save();
  }

  // Прибавляет 1 к числовому полю записи запуска (например, resolved)
  bump(id, field) {
    const r = this.runs.find((x) => x.id === id);
    if (!r) return;
    r[field] = (r[field] || 0) + 1;
    this.store.saveSoon();
  }

  async clear() {
    this.store.data.runs = [];
    await this.store.save();
  }

  // Суммарная статистика по всем запускам-импортам
  totals() {
    const t = { imports: 0, ok: 0, notesWritten: 0, notesMerged: 0, filesCopied: 0, durationMs: 0 };
    for (const r of this.runs) {
      if (r.kind !== 'import') continue;
      t.imports++;
      if (r.status === 'ok') t.ok++;
      t.notesWritten += r.stats.notes.written;
      t.notesMerged += r.stats.notes.merged;
      t.filesCopied += r.stats.files.copied;
      t.durationMs += r.durationMs;
    }
    return t;
  }
}

module.exports = { JsonStore, NoteIndex, Originals, History, INDEX_VERSION };
