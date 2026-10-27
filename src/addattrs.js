'use strict';
// Добавление своих атрибутов в уже существующие заметки: только строки шапки, текст и остальные атрибуты не трогаются.
const { getLinkNames } = require('./links');

// Ключи верхнего уровня в шапке (в нижнем регистре)
function headerKeys(header) {
  const keys = new Set();
  for (const line of header.split('\n')) {
    const m = /^([^\s#:-][^:]*?)\s*:/.exec(line);
    if (m) keys.add(m[1].trim().toLowerCase());
  }
  return keys;
}

// items — результат converter.attrLines(): [{ name, lines: ['Источник: телеграм'] }]; ignore — Set имён в нижнем регистре.
// Возвращает новый текст или null, если добавлять нечего
function addAttrsToText(text, items, ignore) {
  const names = getLinkNames();
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/.exec(text);
  const have = m ? headerKeys(m[1].replace(/\r/g, '')) : new Set();
  const add = items.filter((a) => {
    const k = a.name.toLowerCase();
    return !have.has(k) && !(ignore && ignore.has(k)) && a.name !== names.date && a.name !== names.prev && a.name !== names.next;
  });
  if (!add.length) return null;
  const lines = add.flatMap((a) => a.lines).join(eol);
  if (!m) return `---${eol}${lines}${eol}---${eol}${eol}${text}`;
  const pos = text.indexOf('\n') + 1 + m[1].length; // конец последней строки шапки
  return `${text.slice(0, pos)}${eol}${lines}${text.slice(pos)}`;
}

// Почему атрибут не добавлен: { reason: 'exists'|'ignored'|'reserved', name, line } для первого пропущенного (для журнала)
function skipReason(text, items, ignore) {
  const names = getLinkNames();
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/.exec(text);
  const header = m ? m[1].replace(/\r/g, '') : '';
  const have = headerKeys(header);
  for (const a of items) {
    const k = a.name.toLowerCase();
    if (a.name === names.date || a.name === names.prev || a.name === names.next) return { reason: 'reserved', name: a.name };
    if (ignore && ignore.has(k)) return { reason: 'ignored', name: a.name };
    if (have.has(k)) return { reason: 'exists', name: a.name, line: header.split('\n').find((l) => l.toLowerCase().startsWith(k)) || '' };
  }
  return null;
}

module.exports = { addAttrsToText, headerKeys, skipReason };
