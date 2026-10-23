'use strict';
// Синхронизация одной заметки с версией из Telegram: что записать, что оставить, что отправить на сравнение.
const { fsx } = require('./platform');
const { splitNote, renderNote, lineKey } = require('./text');
const { sha, readOrNull, writeText } = require('./util');
const { getLinkNames } = require('./links');

const statOrNull = (file) => fsx.stat(file).catch(() => null);
const { merge3 } = require('./diff');

// Атрибуты существующей заметки не трогаем; из Telegram добавляем только те ключи, которых у вас нет
// Ключи из ignore (настройка «Игнорировать атрибуты») из Telegram не добавляются вовсе
function mergeAttrs(oursAttrs, freshAttrs, links, ignore) {
  const attrs = new Map(oursAttrs);
  for (const [key, value] of freshAttrs) if (!attrs.has(key) && !(ignore && ignore.has(key.toLowerCase()))) attrs.set(key, value);
  const names = getLinkNames();
  if (links.prev) attrs.set(names.prev, `"[[${links.prev}]]"`);
  if (links.next) attrs.set(names.next, `"[[${links.next}]]"`);
  return attrs;
}

class NoteSync {
  // index — NoteIndex, originals — Originals, review — Review, preserve — беречь ручные правки
  constructor({ index, originals, review, preserve, fullScan, ignoreAttrs, reviewEdits }) {
    this.reviewEdits = reviewEdits !== false; // ваши правки при неизменном тексте в Telegram тоже показывать на сравнении
    this.ignore = new Set((ignoreAttrs || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));
    this.index = index;
    this.originals = originals;
    this.review = review;
    this.preserve = preserve;
    this.fullScan = fullScan; // не пропускать заметки по дате изменения: читать каждую с диска
  }

  // Результат:
  //   written   — записана версия из Telegram (заметки не было или вы её текст не правили)
  //   unchanged — текст совпадает, ничего не делаем
  //   kept      — оставлена ваша версия (в Telegram текст не менялся)
  //   merged    — ваши правки и изменения из Telegram объединены без конфликтов
  //   review    — текст отличается, и решить автоматически нельзя: заметка ушла на сравнение
  // rawHash — отпечаток исходного текста поста, build() — собирает полный текст заметки (только когда он нужен)
  async sync({ file, key, links, rawHash, build }) {
    const { index, preserve } = this;

    // Быстрый путь: текст поста не менялся, а файл не тронут с прошлого согласования — читать его не нужно
    let st = null;
    if (preserve) {
      const e = index.entry(key);
      if (!this.fullScan && e && e.m !== undefined && e.r === rawHash) {
        st = await statOrNull(file);
        if (st && st.mtimeMs === e.m && st.size === e.s) return e.k ? 'kept' : 'unchanged';
      }
      if (!st) st = await statOrNull(file); // состояние файла запоминаем ДО чтения: изменится позже — заметим
    }

    const status = await this.syncSlow({ file, key, links, fresh: build() });
    if (preserve && (status === 'unchanged' || status === 'kept' || status === 'written' || status === 'merged')) {
      const now = status === 'unchanged' || status === 'kept' ? st : await statOrNull(file);
      if (now) index.mark(key, { r: rawHash, st: now, kept: status === 'kept' });
    }
    return status;
  }

  async syncSlow({ file, key, links, fresh }) {
    const { index, originals, review, preserve } = this;
    const F = splitNote(fresh);
    const freshHash = sha(F.key);

    const disk = await readOrNull(file);
    if (disk === null) {
      await writeText(file, fresh);
      if (preserve) index.set(key, freshHash);
      await originals.remove(key);
      await review.discard(key);
      return 'written';
    }

    const D = splitNote(disk);

    if (!preserve) {
      if (D.key === F.key) return 'unchanged';
      await writeText(file, fresh);
      return 'written';
    }

    // Текст совпал: эталон и очередь больше не нужны
    if (D.key === F.key) {
      index.set(key, freshHash);
      await originals.remove(key);
      await review.discard(key);
      return 'unchanged';
    }

    const known = index.get(key); // отпечаток текста из Telegram при прошлом импорте
    if (known === undefined) {
      // Заметка есть, текст другой, а записи о прошлом импорте нет — кто прав, неизвестно
      await review.enqueue(key, 'no-history', fresh);
      return 'review';
    }

    if (known === freshHash) {
      // В Telegram текст не менялся, значит различие — ваши правки. Показываем их на сравнении один раз
      if (this.reviewEdits && index.decided(key) !== sha(D.key)) {
        if (!originals.has(key)) await originals.write(key, F.body);
        await review.enqueue(key, 'local-edit', fresh);
        return 'review';
      }
      // Уже просмотрено: запоминаем «оригинал» для будущих слияний
      if (!originals.has(key)) await originals.write(key, F.body);
      await review.discard(key);
      return 'kept';
    }

    // Текст в Telegram изменился с прошлого импорта
    if (sha(D.key) === known) {
      // вы текст не правили: обновляем его, атрибуты оставляем как есть
      await writeText(file, renderNote(mergeAttrs(D.attrs, F.attrs, links, this.ignore), F.body));
      index.set(key, freshHash);
      await originals.remove(key);
      await review.discard(key);
      return 'written';
    }

    // Менялось и у вас, и в Telegram
    const baseBody = await originals.read(key);
    if (baseBody === null) {
      await review.enqueue(key, 'both-changed-no-base', fresh);
      return 'review';
    }
    const merged = merge3(baseBody.split('\n'), D.body.split('\n'), F.body.split('\n'), lineKey);
    if (merged.conflict) {
      await review.enqueue(key, 'both-changed', fresh);
      return 'review';
    }
    await writeText(file, renderNote(mergeAttrs(D.attrs, F.attrs, links, this.ignore), merged.lines.join('\n').trim()));
    index.set(key, freshHash);
    await originals.write(key, F.body);
    await review.discard(key);
    return 'merged';
  }
}

module.exports = { NoteSync, mergeAttrs };
