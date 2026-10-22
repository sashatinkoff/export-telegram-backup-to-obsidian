'use strict';
// Сравнение текста заметок: «содержимое» — это всё после шапки, атрибуты не учитываются.
const path = require('path');
const { EXT_FAMILY, getFormatMatching } = require('./media');
const { parseAttributes, renderHeader, HEADER_REPLACE_RE } = require('./links');

// Имя медиафайла в ссылке, приведённое к виду, не зависящему от:
//   папки, формата (photo.jpg и photo.webp — один файл),
//   сквозного номера в имени (photo_1904@… и photo_1905@…: при новом экспорте он сдвигается)
function canonMediaName(raw) {
  let name = raw.trim().replace(/^<|>$/g, '');
  try { name = decodeURIComponent(name); } catch (e) { /* имя не было закодировано */ }
  name = name.split('/').pop();
  const ext = path.extname(name);
  if (getFormatMatching() && EXT_FAMILY.has(ext.slice(1).toLowerCase())) name = name.slice(0, -ext.length);
  return name.replace(/_\d+@/, '@').toLowerCase();
}

// Встроенные медиа ![](файл) и ![[файл]] считаются одним и тем же, если это один и тот же файл
function canonMediaRefs(text) {
  const token = (name) => `⟦медиа:${canonMediaName(name)}⟧`;
  return text
    .replace(/!\[[^\]\n]*\]\(([^)\n]+)\)/g, (m, target) => (/^https?:/i.test(target.trim()) ? m : token(target)))
    .replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g, (m, name) => token(name));
}

const SPACE_RE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g;
const ZERO_WIDTH_RE = /[\u200b-\u200d\u2060\ufeff]/g;

// Одна строка без «невидимых» отличий: ссылки на медиа, форма Юникода, особые пробелы, пробелы в конце
function canonLine(line) {
  return canonMediaRefs(line).normalize('NFC').replace(SPACE_RE, ' ').replace(ZERO_WIDTH_RE, '').replace(/[ \t]+$/, '');
}

// Ключ строки для построчного сравнения (diff, слияние): пустая строка цитаты («>») = пустая строка
function lineKey(line) {
  const k = canonLine(line);
  return k === '>' ? '' : k;
}

// Ключ для сравнения текста целиком: не учитывает «невидимые» отличия (переводы строк, пробелы в конце строк,
// лишние пустые строки, неразрывные и нулевой ширины пробелы, форму Юникода), пустые строки цитат («>»)
// и различия в записи ссылок на одни и те же медиафайлы
function contentKey(body) {
  const keys = [];
  for (const line of body.replace(/\r\n?/g, '\n').split('\n')) {
    const k = canonLine(line);
    if (k !== '>') keys.push(k);
  }
  return keys.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const countNewlines = (s) => {
  let n = 0;
  for (let i = s.indexOf('\n'); i !== -1; i = s.indexOf('\n', i + 1)) n++;
  return n;
};

// Разбирает заметку на атрибуты и текст.
//   header — шапка как в файле (или null), offset — сколько строк файла идёт до первой строки текста
function splitNote(text) {
  text = text.replace(/\r\n/g, '\n');
  const attrs = parseAttributes(text);
  const m = HEADER_REPLACE_RE.exec(text);
  const headerLen = m ? m[0].length : 0;
  const rest = text.slice(headerLen);
  const lead = /^(?:[ \t]*\n)+/.exec(rest);
  const leadLen = lead ? lead[0].length : 0;
  const body = rest.slice(leadLen).trimEnd();
  return {
    attrs,
    header: m ? m[0] : null,
    body,
    key: contentKey(body),
    offset: countNewlines(text.slice(0, headerLen + leadLen)),
  };
}

function renderNote(attrs, body) {
  const header = renderHeader(attrs);
  return body ? `${header}\n\n${body}` : header;
}

module.exports = { canonMediaName, canonMediaRefs, canonLine, lineKey, contentKey, splitNote, renderNote };
