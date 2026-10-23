'use strict';
// Атрибуты (frontmatter) заметок и пересчёт ссылок Back/Next — порт obsidian_recalc_links.py.
const { fsx, path } = require('./platform');
const { mapPool, sha } = require('./util');


const HEADER_PARSE_RE = /^---\s*([\s\S]+?)\s*---/;
const HEADER_REPLACE_RE = /^---[\s\S]*?---/;
// Имена атрибутов со ссылками на соседние заметки (настройки «Атрибут для ссылки назад / вперёд»).
// Прежние имена Back / Next / Prev тоже считаются ссылками: при пересчёте они заменяются на настроенные.
const DEFAULT_LINK_NAMES = { prev: 'Back', next: 'Next' };
let linkNames = { ...DEFAULT_LINK_NAMES };
const cleanName = (v, fallback) => {
  const s = String(v === undefined || v === null ? '' : v).trim().replace(/[:\n\r]/g, '');
  return s || fallback;
};
const setLinkNames = ({ prev, next } = {}) => {
  linkNames = { prev: cleanName(prev, DEFAULT_LINK_NAMES.prev), next: cleanName(next, DEFAULT_LINK_NAMES.next) };
  if (linkNames.prev === linkNames.next) linkNames = { ...DEFAULT_LINK_NAMES };
};
const getLinkNames = () => linkNames;
const isLinkKey = (key) => key === linkNames.prev || key === linkNames.next || key === 'Back' || key === 'Next' || key === 'Prev';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
        attributes.set(currentKey, currentValues.join(', '));
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
  if (currentKey && currentValues.length) attributes.set(currentKey, currentValues.join(', '));
  return attributes;
}

function renderHeader(attributes) {
  let header = '---';
  for (const [key, value] of attributes) {
    header += `\n${key}: `;
    if (key === 'tags') {
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

function needsRecalc(text, isFirst, isLast) {
  const match = HEADER_PARSE_RE.exec(text);
  if (!match) return true;
  const hasNext = new RegExp(`^\\s*${escapeRe(linkNames.next)}\\s*:`, 'm').test(match[1]);
  const hasBack = new RegExp(`^\\s*${escapeRe(linkNames.prev)}\\s*:`, 'm').test(match[1]);
  if (!isLast && !hasNext) return true;
  if (!isFirst && !hasBack) return true;
  return false;
}

function createArgs(text, prevFile, nextFile) {
  const args = parseAttributes(text);
  if (prevFile) args.set(linkNames.prev, `"[[${path.basename(prevFile)}]]"`);
  if (nextFile) args.set(linkNames.next, `"[[${path.basename(nextFile)}]]"`);
  return args;
}

async function collectMarkdownFiles(folder) {
  const result = [];
  const walk = async (dir) => {
    const subdirs = [];
    for (const entry of await fsx.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) subdirs.push(full);
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
  const { force = true, concurrency = 16, onProgress, cache, isCancelled } = opts;
  const files = await collectMarkdownFiles(folder);
  const last = files.length - 1;
  let changed = 0;
  let done = 0;

  await mapPool(files, concurrency, async (file, i) => {
    const prev = i > 0 ? files[i - 1] : null;
    const next = i < last ? files[i + 1] : null;
    const sig = sha(`${prev ? path.basename(prev) : ''}|${next ? path.basename(next) : ''}|${linkNames.prev}|${linkNames.next}`);

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
      if (force || needsRecalc(text, i === 0, i === last)) {
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
  setLinkNames, getLinkNames, DEFAULT_LINK_NAMES,
  HEADER_PARSE_RE, HEADER_REPLACE_RE, parseAttributes, renderHeader, updateText, needsRecalc, createArgs,
  collectMarkdownFiles, recalcLinks,
};
