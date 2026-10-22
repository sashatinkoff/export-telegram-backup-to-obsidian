'use strict';
// Очередь заметок на сравнение: у заметки с таким же именем в хранилище другой текст, чем в Telegram.
// Версии из Telegram лежат в папке merge_conflicts, рядом с ними — markdown-отчёт.
const fs = require('fs');
const path = require('path');
const { lineKey, splitNote, contentKey } = require('./text');
const { diffOps } = require('./diff');
const { sha, readOrNull, writeText, removeIfExists, mapPool, tick } = require('./util');
const { buildReport } = require('./report');
const { JsonStore } = require('./store');

const fsp = fs.promises;

const QUEUE_VERSION = 1;
const REPORT_NAME = 'Отчёт о конфликтах.md';

class Review {
  // index — NoteIndex, originals — Originals, getFolder() — папка для конфликтов из настроек
  constructor({ vaultBase, file, getFolder, index, originals }) {
    this.vaultBase = vaultBase;
    this.getFolder = getFolder;
    this.index = index;
    this.originals = originals;
    this.store = new JsonStore(file, QUEUE_VERSION, () => ({ version: QUEUE_VERSION, items: {} }));
    this.claimed = new Set();
    this.reportTimer = null;
    this.onChange = null; // вызывается при любом изменении очереди (обновить интерфейс)
    this.onSettled = null; // вызывается с записью очереди, когда заметка согласована
    this.runId = 0;        // номер текущего запуска: запоминается в заметках, попавших в очередь
  }

  async load() {
    await this.store.load();
    this.claimed = new Set(Object.values(this.items).map((i) => i.incoming));
  }

  get items() { return this.store.data.items; }

  get count() { return Object.keys(this.items).length; }

  list() {
    return Object.values(this.items).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  abs(rel) { return path.join(this.vaultBase, ...rel.split('/')); }

  folderRel() { return (this.getFolder() || 'merge_conflicts').replace(/^[\\/]+|[\\/]+$/g, ''); }

  changed() { if (this.onChange) this.onChange(); }

  // ---------- очередь ----------

  allocIncoming(key) {
    const base = path.basename(key, '.md');
    let rel = `${this.folderRel()}/${base} (Telegram).md`;
    for (let n = 2; this.claimed.has(rel); n++) rel = `${this.folderRel()}/${base} (Telegram ${n}).md`;
    this.claimed.add(rel);
    return rel;
  }

  // Ставит заметку на сравнение и кладёт версию из Telegram в папку конфликтов
  async enqueue(key, reason, freshText) {
    let item = this.items[key];
    if (!item) {
      item = { key, reason, incoming: this.allocIncoming(key), createdAt: Date.now(), runId: this.runId };
      this.items[key] = item;
    }
    item.reason = reason;
    item.updatedAt = Date.now();
    await writeText(this.abs(item.incoming), freshText);
  }

  // Убирает заметку из очереди (и копию из Telegram). Для заметок не из очереди ничего не делает
  async discard(key) {
    const item = this.items[key];
    if (!item) return;
    delete this.items[key];
    this.claimed.delete(item.incoming);
    await removeIfExists(this.abs(item.incoming));
  }

  // ---------- анализ ----------

  // Сравнивает заметку в хранилище с версией из Telegram. null — если одного из файлов уже нет
  async analyze(key) {
    const item = this.items[key];
    if (!item) return null;
    const [diskText, incomingText] = await Promise.all([readOrNull(this.abs(key)), readOrNull(this.abs(item.incoming))]);
    if (diskText === null || incomingText === null) {
      await this.discard(key);
      this.store.saveSoon();
      return null;
    }
    const ours = splitNote(diskText);
    const theirs = splitNote(incomingText);
    ours.lines = ours.body.split('\n');
    theirs.lines = theirs.body.split('\n');
    const ops = diffOps(ours.lines.map(lineKey), theirs.lines.map(lineKey));
    const hunkCount = ops.filter((o) => !o.eq).length;
    return { item, ours, theirs, ops, hunkCount, equal: ours.key === theirs.key };
  }

  // Заметка согласована: версия из Telegram становится точкой отсчёта для следующих импортов
  async settle(key, theirs, finalBody) {
    const item = this.items[key];
    this.index.set(key, sha(theirs.key));
    this.index.setDecided(key, sha(contentKey(finalBody)));
    if (contentKey(finalBody) === theirs.key) await this.originals.remove(key);
    else await this.originals.write(key, theirs.body);
    await this.discard(key);
    if (item && this.onSettled) this.onSettled(item);
    this.index.saveSoon();
    this.store.saveSoon();
    this.reportSoon();
    this.changed();
  }

  // Убирает из очереди заметки, у которых тексты уже совпали (например, вы поправили заметку вручную)
  async reconcile(onProgress) {
    const keys = Object.keys(this.items);
    let settled = 0;
    let done = 0;
    await mapPool(keys, 8, async (key) => {
      const a = await this.analyze(key);
      if (a && (a.equal || a.hunkCount === 0)) {
        await this.settle(key, a.theirs, a.ours.body);
        settled++;
      }
      done++;
      if (onProgress) onProgress(done, keys.length);
      if (done % 50 === 0) await tick();
    });
    return settled;
  }

  // choices — выбор по каждому блоку отличий по порядку: 'mine' (оставить своё), 'theirs' (взять из Telegram) или 'both' (своё, затем из Telegram)
  async applyChoices(key, choices) {
    const a = await this.analyze(key);
    if (!a) return { status: 'gone' };
    if (a.equal || a.hunkCount === 0) {
      await this.settle(key, a.theirs, a.ours.body);
      return { status: 'equal', wrote: false };
    }

    const out = [];
    let c = 0;
    for (const op of a.ops) {
      if (op.eq) out.push(...a.ours.lines.slice(op.a0, op.a1));
      else {
        const mine = a.ours.lines.slice(op.a0, op.a1);
        const theirs = a.theirs.lines.slice(op.b0, op.b1);
        const pick = choices[c++];
        out.push(...(pick === 'theirs' ? theirs : pick === 'both' ? mine.concat(theirs) : mine));
      }
    }
    const body = out.join('\n').replace(/\s+$/, '');

    let wrote = false;
    if (body !== a.ours.body) { // «оставить всё своё» ничего не пишет в заметку
      const header = a.ours.header;
      await writeText(this.abs(key), header ? (body ? `${header}\n\n${body}` : header) : body);
      wrote = true;
    }
    await this.settle(key, a.theirs, body);
    return { status: 'applied', wrote };
  }

  // ---------- отчёт ----------

  reportPath() { return this.abs(`${this.folderRel()}/${REPORT_NAME}`); }

  reportSoon(ms = 800) {
    if (this.reportTimer) clearTimeout(this.reportTimer);
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      this.writeReport().catch((e) => console.error('[telegram-import] не удалось обновить отчёт', e));
    }, ms);
  }

  async flush() {
    if (this.reportTimer) { clearTimeout(this.reportTimer); this.reportTimer = null; await this.writeReport(); }
    await this.store.flush();
    await this.index.flush();
  }

  async writeReport(onProgress) {
    const file = this.reportPath();
    const items = this.list();
    if (!items.length) {
      await removeIfExists(file);
      try { await fsp.rmdir(path.dirname(file)); } catch (e) { /* папка не пуста или её нет */ }
      return;
    }

    let done = 0;
    const analyses = await mapPool(items, 8, async (it) => {
      const a = await this.analyze(it.key);
      done++;
      if (onProgress) onProgress(done, items.length);
      if (done % 50 === 0) await tick();
      return a;
    });

    const entries = analyses.filter(Boolean).map((a) => ({
      key: a.item.key,
      name: path.basename(a.item.key),
      incomingName: path.basename(a.item.incoming),
      reason: a.item.reason,
      hunks: a.ops.filter((o) => !o.eq).map((o) => ({
        aFrom: o.a1 > o.a0 ? a.ours.offset + o.a0 + 1 : null, aTo: a.ours.offset + o.a1, aAt: a.ours.offset + o.a0,
        bFrom: o.b1 > o.b0 ? a.theirs.offset + o.b0 + 1 : null, bTo: a.theirs.offset + o.b1, bAt: a.theirs.offset + o.b0,
        aLines: a.ours.lines.slice(o.a0, o.a1),
        bLines: a.theirs.lines.slice(o.b0, o.b1),
      })),
    }));
    if (!entries.length) { await this.writeReport(); return; }
    await writeText(file, buildReport({ entries, when: new Date() }));
  }
}

// Рекомендуемый выбор по блокам («совмещённый вариант»): новое из Telegram добавляется, ваши правки сохраняются
function recommend(ops) {
  return ops.filter((o) => !o.eq).map((o) => (o.a1 === o.a0 && o.b1 > o.b0 ? 'theirs' : 'mine'));
}

module.exports = { Review, REPORT_NAME, recommend };
