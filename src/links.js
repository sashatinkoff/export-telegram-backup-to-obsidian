'use strict';
// Атрибуты (frontmatter) заметок и пересчёт ссылок Back/Next — порт obsidian_recalc_links.py.
const { fsx, path } = require('./platform');
const { mapPool, sha } = require('./util');


const HEADER_PARSE_RE = /^---\s*([\s\S]+?)\s*---/;
const HEADER_REPLACE_RE = /^---[\s\S]*?---/;
// Имена атрибутов со ссылками на соседние заметки (настройки «Атрибут для ссылки назад / вперёд»).
// Прежние имена Back / Next / Prev тоже считаются ссылками: при пересчёте они заменяются на настроенные.
const DEFAULT_LINK_NAMES = { prev: 'Back', next: 'Next', date: 'Date' }; // date — имя атрибута с датой поста
let linkNames = { ...DEFAULT_LINK_NAMES };
const cleanName = (v, fallback) => {
  const s = String(v === undefined || v === null ? '' : v).trim().replace(/[:\n\r]/g, '');
  return s || fallback;
};
const setLinkNames = ({ prev, next, date } = {}) => {
  linkNames = { prev: cleanName(prev, DEFAULT_LINK_NAMES.prev), next: cleanName(next, DEFAULT_LINK_NAMES.next), date: cleanName(date, DEFAULT_LINK_NAMES.date) };
  if (new Set([linkNames.prev, linkNames.next, linkNames.date]).size < 3) linkNames = { ...DEFAULT_LINK_NAMES };
};
const getLinkNames = () => linkNames;
const isLinkKey = (key) => key === linkNames.prev || key === linkNames.next || key === 'Back' || key === 'Next' || key === 'Prev';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Список в шапке: tags хранится строкой через запятую (так сложилось), остальные списки — массивом, чтобы остаться списками
const listValue = (key, values) => (key === 'tags' ? values.join(', ') : values.slice());

function parseAttributes(text) {
  const attributes = new Map();
  const match = HEADER_PARSE_RE.exec(text);
  if (!match) return attributes;

  let currentKey = null;
  let currentValues = [];

  for (let line of match[1].split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
    line = line.trim();
    const kv = /^([^:\n]+):\s*(.*)$/.exec(line);

    if (kv) {
      if (currentKey && currentValues.length) {
        attributes.set(currentKey, listValue(currentKey, currentValues));
        currentValues = [];
      }
      currentKey = kv[1].trim();
      if (isLinkKey(currentKey)) {
        currentKey = null;
        continue;
      }
      const value = kv[2].trim();
      if (value) {
        attributes.set(currentKey, value);
        currentKey = null;
      }
    } else if (line.startsWith('-') && currentKey) {
      currentValues.push(line.replace(/^-+/, '').trim());
    }
  }
  if (currentKey && currentValues.length) attributes.set(currentKey, listValue(currentKey, currentValues));
  return attributes;
}

// Порядок атрибутов в шапке: Date, ссылка назад, ссылка вперёд, tags, затем все остальные в прежнем порядке
function orderedAttributes(attributes) {
  const rank = (key) => {
    const k = key.toLowerCase();
    if (key === linkNames.date || k === 'date') return 0;
    if (key === linkNames.prev) return 1;
    if (key === linkNames.next) return 2;
    if (k === 'tags') return 3;
    return 4;
  };
  return [...attributes.entries()].map((e, i) => ({ e, i, r: rank(e[0]) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.e);
}

function renderHeader(attributes) {
  let header = '---';
  for (const [key, value] of orderedAttributes(attributes)) {
    header += `\n${key}: `;
    if (Array.isArray(value)) {
      for (const item of value) header += `\n  - ${item}`;
    } else if (key === 'tags') {
      for (const tag of value.split(',')) header += `\n  - ${tag.trim()}`;
    } else {
      header += value;
    }
  }
  return `${header}\n---`;
}

function updateText(text, attributes) {
  const header = renderHeader(attributes);
  if (HEADER_REPLACE_RE.test(text)) return text.replace(HEADER_REPLACE_RE, () => header).trim();
  return `${header}\n${text.trim()}`;
}

// Значение атрибута-ссылки в шапке: «"[[имя.md]]"» -> «имя.md» (null, если атрибута нет)
function linkTarget(header, name) {
  const m = new RegExp(`^\\s*${escapeRe(name)}\\s*:\\s*"?\\[\\[([^\\]|#]+)`, 'm').exec(header);
  return m ? m[1].trim() : null;
}

// expected — { prev, next }: имена реально существующих соседних заметок (null — соседа нет).
// Ссылка, ведущая не на соседа (например, на удалённую или перенесённую заметку), требует пересчёта
function needsRecalc(text, isFirst, isLast, expected) {
  const match = HEADER_PARSE_RE.exec(text);
  if (!match) return true;
  if (expected) {
    if (linkTarget(match[1], linkNames.prev) !== (expected.prev || null)) return true;
    if (linkTarget(match[1], linkNames.next) !== (expected.next || null)) return true;
    return false;
  }
  const hasNext = new RegExp(`^\\s*${escapeRe(linkNames.next)}\\s*:`, 'm').test(match[1]);
  const hasBack = new RegExp(`^\\s*${escapeRe(linkNames.prev)}\\s*:`, 'm').test(match[1]);
  if (!isLast && !hasNext) return true;
  if (!isFirst && !hasBack) return true;
  return false;
}

function createArgs(text, prevFile, nextFile) {
  let args = parseAttributes(text);
  if (linkNames.date !== 'Date' && args.has('Date') && !args.has(linkNames.date)) { // прежнее имя «Date» заменяется настроенным, место в шапке сохраняется
    args = new Map([...args].map(([k, v]) => [k === 'Date' ? linkNames.date : k, v]));
  }
  if (prevFile) args.set(linkNames.prev, `"[[${path.basename(prevFile)}]]"`);
  if (nextFile) args.set(linkNames.next, `"[[${path.basename(nextFile)}]]"`);
  return args;
}

// exclude — абсолютные пути папок, которые не входят в цепочку (например, папка конфликтов: её файлы временные,
// ссылки на них оказались бы мёртвыми). Папки, начинающиеся с точки (.obsidian, .trash, .git), пропускаются всегда
async function collectMarkdownFiles(folder, exclude = []) {
  const result = [];
  const skip = new Set(exclude.map((d) => path.resolve(d)));
  const walk = async (dir) => {
    const subdirs = [];
    for (const entry of await fsx.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!entry.name.startsWith('.') && !skip.has(path.resolve(full))) subdirs.push(full); }
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(full);
    }
    await Promise.all(subdirs.map(walk));
  };
  await walk(folder);
  return result.sort();
}

// Выстраивает все .md в папке в цепочку Back/Next по порядку путей.
// opts: force, concurrency, onProgress(done,total), isCancelled(),
//   cache — необязательный кэш { lookup(file) -> { m, s, sig } | null, store(file, st, sig) }: файлы, которые не менялись
//   с прошлого пересчёта и у которых те же соседи, не читаются с диска
async function recalcLinks(folder, opts = {}) {
  const { force = true, concurrency = 16, onProgress, cache, isCancelled, exclude } = opts;
  const files = await collectMarkdownFiles(folder, exclude);
  const last = files.length - 1;
  let changed = 0;
  let done = 0;

  await mapPool(files, concurrency, async (file, i) => {
    const prev = i > 0 ? files[i - 1] : null;
    const next = i < last ? files[i + 1] : null;
    const sig = sha(`${prev ? path.basename(prev) : ''}|${next ? path.basename(next) : ''}|${linkNames.prev}|${linkNames.next}|${linkNames.date}|v2`); // v2: порядок атрибутов в шапке; при смене порядка файлы перечитываются

    let st = null;
    const known = cache ? cache.lookup(file) : null;
    if (known) {
      st = await fsx.stat(file).catch(() => null);
      if (st && known.sig === sig && known.m === st.mtimeMs && known.s === st.size) {
        done++;
        if (onProgress && (done % 100 === 0 || done === files.length)) onProgress(done, files.length, path.basename(file));
        return;
      }
    }
    return slow();

    async function slow() {
      if (cache && !st) st = await fsx.stat(file).catch(() => null); // до чтения: изменится позже — заметим
      const text = await fsx.readFile(file, 'utf8');
      let final = st;
      if (force || needsRecalc(text, i === 0, i === last, { prev: prev ? path.basename(prev) : null, next: next ? path.basename(next) : null })) {
        const newText = updateText(text, createArgs(text, prev, next));
        if (newText !== text) {
          await fsx.writeFile(file, newText, 'utf8');
          changed++;
          final = cache ? await fsx.stat(file).catch(() => null) : null;
        }
      }
      if (cache && final) cache.store(file, final, sig);
      done++;
      if (onProgress && (done % 100 === 0 || done === files.length)) onProgress(done, files.length, path.basename(file));
    }
  }, isCancelled);

  return { total: files.length, changed };
}

module.exports = {
  setLinkNames, getLinkNames, DEFAULT_LINK_NAMES, orderedAttributes,
  HEADER_PARSE_RE, HEADER_REPLACE_RE, parseAttributes, renderHeader, updateText, needsRecalc, createArgs,
  collectMarkdownFiles, recalcLinks,
};
