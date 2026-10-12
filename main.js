'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, FuzzySuggestModal, MarkdownRenderer, Modal, normalizePath } = require('obsidian');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const BUILD = '2026-10-12 · дамп конфликтов в _merge_conflicts';

const DEFAULT_SETTINGS = {
  archiveFolder: '',              // папка с экспортом Telegram (там лежит result.json); при askArchiveEachTime — последняя использованная
  askArchiveEachTime: true,       // спрашивать папку архива при каждом импорте
  targetFolder: 'Telegram',       // папка в хранилище, куда попадает результат экспорта
  recalcFolder: 'Telegram/notes', // папка в хранилище, где пересчитываются ссылки Back/Next
  recalcForce: true,              // пересчитывать все файлы, а не только те, где нет Back/Next
  prevKey: 'Back',                // имя атрибута во frontmatter для предыдущей заметки
  nextKey: 'Next',                // имя атрибута во frontmatter для следующей заметки
  dateKey: 'Date',                // имя атрибута во frontmatter для даты
  mergeThreshold: 120,            // секунд: сообщения ближе друг к другу склеиваются в один пост (0 — не склеивать)
  dateFormat: '',                 // пусто = «7 сентября 2026, 09:41»; иначе strftime-строка
  yandexApiKey: '',               // ключ Яндекс Static Maps для превью локаций
  preserveEdits: true,            // не затирать ручные правки заметок: трёхстороннее слияние
  conflicts: [],                  // заметки (пути от корня хранилища) с неразрешёнными конфликтами слияния
};

// ======================================================================
// Общие утилиты
// ======================================================================

const tick = () => new Promise((r) => setTimeout(r, 0));

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

// ======================================================================
// Рендеринг и форматирование frontmatter со строгим порядком
// ======================================================================

function renderHeader(attributes, dateKey = 'Date', prevKey = 'Back', nextKey = 'Next') {
  let header = '---';
  const renderedKeys = new Set();
  const priorityOrder = [dateKey, prevKey, nextKey].filter(Boolean);

  const appendKey = (key, value) => {
    if (value === undefined || value === null || renderedKeys.has(key)) return;
    renderedKeys.add(key);
    header += `\n${key}: `;
    if (key === 'tags') {
      for (const tag of String(value).split(',')) {
        const clean = tag.trim();
        if (clean) header += `\n  - ${clean}`;
      }
    } else {
      header += value;
    }
  };

  // 1. Строгий порядок: Дата, Назад (если есть), Вперед (если есть)
  for (const key of priorityOrder) {
    if (attributes.has(key)) appendKey(key, attributes.get(key));
  }

  // 2. Затем все остальные атрибуты
  for (const [key, value] of attributes) {
    appendKey(key, value);
  }

  return `${header}\n---`;
}

// ======================================================================
// Конвертер экспорта Telegram (result.json -> markdown)
// ======================================================================

class TelegramConverter {
  constructor({ yandexApiKey = '', dateFormat = '', threshold = 120, prevKey = 'Back', nextKey = 'Next', dateKey = 'Date' } = {}) {
    this.yandexApiKey = yandexApiKey;
    this.dateFormat = dateFormat;
    this.threshold = threshold;
    this.prevKey = prevKey || 'Back';
    this.nextKey = nextKey || 'Next';
    this.dateKey = dateKey || 'Date';
  }

  formatHeaderDate(dt) {
    if (this.dateFormat) return formatDate(this.dateFormat, dt);
    return `${dt.d} ${MONTHS_RU_GENITIVE[dt.mo - 1]} ${dt.y}, ${pad2(dt.H)}:${pad2(dt.M)}`;
  }

  getFileName(message) {
    const dt = parseDate(message.date);
    return `${dt.y}-${pad2(dt.mo)}-${pad2(dt.d)} ${pad2(dt.H)}-${pad2(dt.M)}-${pad2(dt.S)}.md`;
  }

  getRelativePath(post) {
    const dt = parseDate(post.date);
    const folder = `${dt.y}-${pad2(dt.mo)}-${MONTHS_EN[dt.mo - 1]}`;
    return path.join('notes', String(dt.y), folder, post.fileName);
  }

  getPosts(jsonData) {
    const messages = jsonData.messages || [];
    const times = messages.map((m) => parseDate(m.date).ts);
    const posts = [];
    let start = 0;

    while (start < messages.length) {
      const group = [messages[start]];
      let prev = times[start];
      let idx = start + 1;

      while (idx < messages.length) {
        if (times[idx] - prev >= this.threshold) break;
        group.push(messages[idx]);
        prev = times[idx];
        idx++;
      }

      posts.push(this.processGroup(group));
      start = idx;
    }
    return posts;
  }

  processGroup(group) {
    const textMessages = [];
    const mediaMessages = [];
    for (const msg of group) {
      (this.hasText(msg) ? textMessages : mediaMessages).push(msg);
    }
    const primary = textMessages.length ? textMessages[0] : group[0];

    const textParts = [];
    for (const msg of textMessages) {
      const part = this.createText(msg);
      if (part) textParts.push(part);
    }
    const mediaParts = [];
    for (const msg of mediaMessages) {
      const part = this.createText(msg);
      if (part) mediaParts.push(part);
    }

    let fullText = textParts.concat(mediaParts).join('\n').trim();

    if (!fullText && mediaMessages.length) {
      const fallback = [];
      for (const msg of mediaMessages) {
        const md = this.createMediaMarkdown(msg);
        if (md) fallback.push(md);
      }
      fullText = fallback.join('\n').trim();
    }

    const allTags = [];
    for (const msg of group) {
      for (const entity of msg.text_entities || []) {
        if (entity.type === 'hashtag') {
          const tag = (entity.text || '').replace(/#/g, '');
          if (tag && !allTags.includes(tag)) allTags.push(tag);
        }
      }
      if (py(msg.rich_message)) {
        for (const block of msg.rich_message.blocks || []) this.collectHashtagsFromBlock(block, allTags);
      }
    }

    fullText = this.stripTrailingHashtags(fullText);

    return {
      id: primary.id,
      date: primary.date,
      text: fullText,
      fileName: this.getFileName(primary),
      hashTags: allTags,
      forwardedFrom: primary.forwarded_from,
    };
  }

  stripTrailingHashtags(text) {
    if (!text) return text;
    const m = /(?:\s*#[^\s#]+)+\s*$/u.exec(text);
    if (!m) return text;
    return text.slice(0, m.index).trimEnd();
  }

  hasText(message) {
    if (py(message.rich_message)) return py(message.rich_message.blocks);
    const t = message.text;
    if (t === null || t === undefined) return false;
    if (typeof t === 'string') return t.trim() !== '';
    if (Array.isArray(t)) {
      for (const item of t) {
        if (typeof item === 'string' && item.trim()) return true;
        if (isDict(item) && String(item.text || '').trim()) return true;
      }
    }
    return false;
  }

  createText(message) {
    if (py(message.rich_message)) {
      return this.renderBlocks(message.rich_message.blocks || []).trim();
    }
    const entities = this.filterTextEntities(message.text_entities || []);
    const textPart = this.createTextFromEntities(entities);
    const mediaPart = this.createMediaMarkdown(message);

    if (textPart && mediaPart) return `${textPart}\n${mediaPart}`;
    return mediaPart || textPart;
  }

  filterTextEntities(entities) {
    if (!entities || !entities.length) return [];
    const list = entities.slice();

    const last = list[list.length - 1];
    if (last && last.type === 'plain' && !last.text) list.pop();

    let end = list.length - 1;
    while (end >= 0) {
      const item = list[end];
      const exclude = item.type === 'hashtag' || (item.type === 'plain' && !String(item.text || '').trim());
      if (!exclude) break;
      end--;
    }
    return list.slice(0, end + 1);
  }

  createTextFromEntities(entities) {
    const result = [];
    for (const entity of entities) {
      const text = this.createTextEntity(entity);
      if (text) result.push(text);
    }
    return result.join('').trim();
  }

  createTextEntity(entity) {
    const type = entity.type;
    const text = String(entity.text ?? '');
    switch (type) {
      case 'hashtag': return text.replace(/#/g, '');
      case 'plain': return text;
      case 'blockquote': return `\n> ${text.replace(/\n/g, '\n> ')}\n`;
      case 'pre':
      case 'code':
      case 'spoiler': return `\n\`\`\`\n${text}\n\`\`\`\n`;
      case 'text_link': return `[${text}](${entity.href})`;
      case 'italic': return `*${text}*`;
      case 'link': return `[${text}](${text})`;
      case 'bold': return `**${text}**`;
      case 'strikethrough': return `~~${text}~~`;
      case 'underline': return `<u>${text}</u>`;
      case 'custom_emoji': return text;
      default: return null;
    }
  }

  createMediaMarkdown(message) {
    const lines = [];
    for (const type of ['photo', 'file', 'sticker', 'video', 'voice', 'audio', 'animation']) {
      if (py(message[type])) lines.push(this.formatMedia(message[type], type));
    }
    return lines.join('\n');
  }

  formatMedia(field, mediaType) {
    let filePath;
    if (isDict(field)) filePath = field.file || '';
    else if (field === null || field === undefined) filePath = '';
    else filePath = String(field);

    const slash = filePath.lastIndexOf('/');
    const fileName = slash >= 0 ? filePath.slice(slash + 1) : filePath;
    if (!fileName) return '';

    const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
    if (['photo', 'sticker', 'animation'].includes(mediaType) || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      return `![](${fileName})`;
    }
    if (mediaType === 'video' || mediaType === 'animation' || ['mp4', 'mov', 'm4v', 'ogg'].includes(ext)) {
      return `![[${fileName}]]`;
    }
    if (mediaType === 'audio' || ['mp3', 'ogg', 'm4a'].includes(ext)) {
      return `![[${fileName}]]`;
    }
    return `[[${fileName}]]`;
  }

  renderBlocks(blocks) {
    const parts = [];
    for (const block of blocks || []) {
      const rendered = this.renderBlock(block);
      if (rendered) parts.push(rendered);
    }
    return parts.join('\n\n');
  }

  renderBlock(block) {
    switch (block.type) {
      case 'heading': {
        const level = Math.max(1, Math.min(parseInt(block.level ?? 1, 10) || 1, 6));
        const text = this.renderTextNode(block.text);
        return text ? `${'#'.repeat(level)} ${text}` : null;
      }
      case 'paragraph': return this.renderTextNode(block.text) || null;
      case 'footer': {
        const text = this.renderTextNode(block.text);
        return text ? `*${text}*` : null;
      }
      case 'divider': return '---';
      case 'quote': return this.renderQuoteBlock(block);
      case 'list': return this.renderListBlock(block);
      case 'table': return this.renderTableBlock(block);
      case 'details': return this.renderDetailsBlock(block);
      case 'map': return this.renderMapBlock(block);
      case 'photo': case 'video': case 'file': case 'voice':
      case 'audio': case 'animation': case 'sticker':
        return this.renderMediaBlock(block, block.type);
      default:
        return this.renderTextNode(block.text) || null;
    }
  }

  renderTextNode(node) {
    if (!isDict(node)) return '';
    const wrap = (open, close) => {
      const inner = this.renderTextNode(node.text);
      return inner ? `${open}${inner}${close}` : '';
    };
    switch (node.type) {
      case undefined: case null: case 'empty': return '';
      case 'plain': return typeof node.text === 'string' ? node.text : '';
      case 'concat':
        return Array.isArray(node.text) ? node.text.map((c) => this.renderTextNode(c)).join('') : '';
      case 'bold': wrap('**', '**');
      case 'italic': return wrap('*', '*');
      case 'underline': return wrap('<u>', '</u>');
      case 'strikethrough': return wrap('~~', '~~');
      case 'marked': return wrap('==', '==');
      case 'spoiler': return this.renderTextNode(node.text);
      case 'subscript': return wrap('<sub>', '</sub>');
      case 'superscript': return wrap('<sup>', '</sup>');
      case 'code':
      case 'pre': return wrap('`', '`');
      case 'text_link': {
        const inner = this.renderTextNode(node.text);
        return inner ? `[${inner}](${node.href || ''})` : '';
      }
      case 'link': {
        const inner = this.renderTextNode(node.text);
        return inner ? `[${inner}](${inner})` : '';
      }
      case 'hashtag': return this.renderTextNode(node.text);
      default: {
        const inner = node.text;
        if (isDict(inner)) return this.renderTextNode(inner);
        if (typeof inner === 'string') return inner;
        return '';
      }
    }
  }

  renderContentNode(container) {
    if (py(container.blocks)) return this.renderBlocks(container.blocks);
    return this.renderTextNode(container.text);
  }

  renderQuoteBlock(block) {
    const text = this.renderContentNode(block);
    if (!text) return null;

    const lines = ['> [!quote]'];
    for (const line of text.split('\n')) lines.push(line ? `> ${line}` : '>');

    const caption = this.renderTextNode(block.caption);
    if (caption) {
      lines.push('>');
      lines.push(`> — ${caption}`);
    }
    return lines.join('\n');
  }

  renderListBlock(block) {
    const kind = block.kind || 'bullet';
    const items = block.items || [];
    const lines = [];

    items.forEach((item, index) => {
      const content = this.renderContentNode(item);
      const taskState = item.task_state || 'none';

      let prefix;
      if (taskState === 'checked') prefix = '- [x] ';
      else if (taskState === 'unchecked') prefix = '- [ ] ';
      else if (kind === 'ordered') prefix = `${item.num ?? index + 1}. `;
      else prefix = '- ';

      const contentLines = content ? content.split('\n') : [''];
      const indent = ' '.repeat(prefix.length);

      lines.push(`${prefix}${contentLines[0]}`);
      for (const cont of contentLines.slice(1)) lines.push(cont ? `${indent}${cont}` : '');
    });

    return lines.length ? lines.join('\n') : null;
  }

  renderTableBlock(block) {
    const rows = block.rows || [];
    if (!rows.length) return null;

    const lines = [];
    const title = this.renderTextNode(block.title);
    if (title) {
      lines.push(title);
      lines.push('');
    }

    rows.forEach((row, rowIndex) => {
      const cells = row.cells || [];
      const texts = cells.map((c) => this.renderTextNode(c.text).replace(/\n/g, '<br>'));
      lines.push(`| ${texts.join(' | ')} |`);
      if (rowIndex === 0) lines.push(`| ${cells.map(() => '---').join(' | ')} |`);
    });
    return lines.join('\n');
  }

  renderDetailsBlock(block) {
    const title = this.renderTextNode(block.title);
    const inner = this.renderBlocks(block.blocks || []);
    const fold = block.open ? '+' : '-';

    const lines = [`> [!note]${fold} ${title}`.trimEnd()];
    for (const line of inner.split('\n')) lines.push(`> ${line}`.trimEnd());
    return lines.join('\n');
  }

  renderMediaBlock(block, mediaType) {
    const mediaMd = this.formatMedia(block[mediaType], mediaType);
    if (!mediaMd) return null;

    const caption = isDict(block.caption) ? this.renderTextNode(block.caption.text).trim() : '';
    return caption ? `${mediaMd}\n*${caption}*` : mediaMd;
  }

  renderMapBlock(block) {
    const geo = block.geo || {};
    const lat = geo.latitude;
    const lon = geo.longitude;
    if (lat === null || lat === undefined || lon === null || lon === undefined) return null;

    const zoom = block.zoom ?? 14;
    const width = Math.min(block.width ?? 600, 650);
    const height = Math.min(block.height ?? 450, 450);

    const caption = isDict(block.caption) ? this.renderTextNode(block.caption.text) : '';
    const label = caption || `${lat}, ${lon}`;
    const mapsLink = `https://yandex.ru/maps/?pt=${lon},${lat}&z=${zoom}&l=map`;

    if (this.yandexApiKey) {
      const preview = `https://static-maps.yandex.ru/v1?apikey=${this.yandexApiKey}`
        + `&ll=${lon},${lat}&z=${zoom}&size=${width},${height}&l=map&pt=${lon},${lat},pm2rdm`;
      return `![${label}](${preview})\n📍 [${label}](${mapsLink})`;
    }
    return `📍 [${label}](${mapsLink})`;
  }

  collectHashtagsFromBlock(block, tags) {
    for (const key of ['text', 'title', 'caption']) {
      if (isDict(block[key])) this.collectHashtagsFromNode(block[key], tags);
    }
    if (block.type === 'list') {
      for (const item of block.items || []) {
        if (isDict(item.text)) this.collectHashtagsFromNode(item.text, tags);
      }
    }
    if (block.type === 'table') {
      for (const row of block.rows || []) {
        for (const cell of row.cells || []) {
          if (isDict(cell.text)) this.collectHashtagsFromNode(cell.text, tags);
        }
      }
    }
    if (block.type === 'details') {
      for (const inner of block.blocks || []) this.collectHashtagsFromBlock(inner, tags);
    }
  }

  collectHashtagsFromNode(node, tags) {
    if (!isDict(node)) return;
    if (node.type === 'hashtag') {
      const tag = this.renderTextNode(node).replace(/#/g, '').trim();
      if (tag && !tags.includes(tag)) tags.push(tag);
    } else if (node.type === 'concat') {
      for (const child of Array.isArray(node.text) ? node.text : []) this.collectHashtagsFromNode(child, tags);
    } else if (isDict(node.text)) {
      this.collectHashtagsFromNode(node.text, tags);
    }
  }

  createHeader(post, nextFile, prevFile) {
    const dt = parseDate(post.date);
    const attrs = new Map();

    attrs.set(this.dateKey, this.formatHeaderDate(dt));
    if (prevFile) attrs.set(this.prevKey, `"[[${prevFile}]]"`);
    if (nextFile) attrs.set(this.nextKey, `"[[${nextFile}]]"`);
    if (py(post.forwardedFrom)) attrs.set('Источник', post.forwardedFrom);
    if (post.hashTags.length) attrs.set('tags', post.hashTags.join(', '));

    return renderHeader(attrs, this.dateKey, this.prevKey, this.nextKey);
  }

  buildNote(post, prevFile, nextFile) {
    const header = this.createHeader(post, nextFile, prevFile);
    const content = post.text.trim();
    const text = content ? `${header}\n\n${content}` : header;
    return text.replace(/\n{3,}/g, '\n\n');
  }
}

// ======================================================================
// Пересчёт ссылок Prev/Next
// ======================================================================

const HEADER_PARSE_RE = /^---\s*([\s\S]+?)\s*---/;
const HEADER_REPLACE_RE = /^---[\s\S]*?---/;

function getLinkKeys(prevKey = 'Back', nextKey = 'Next') {
  return new Set(['Next', 'Prev', 'Back', prevKey, nextKey]);
}

function parseAttributes(text, ignoreKeys) {
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
      if (ignoreKeys && ignoreKeys.has(currentKey)) {
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

function updateText(text, attributes, dateKey = 'Date', prevKey = 'Back', nextKey = 'Next') {
  const header = renderHeader(attributes, dateKey, prevKey, nextKey);

  if (HEADER_REPLACE_RE.test(text)) return text.replace(HEADER_REPLACE_RE, () => header).trim();
  return `${header}\n${text.trim()}`;
}

function needsRecalc(text, isFirst, isLast, prevKey = 'Back', nextKey = 'Next') {
  const match = HEADER_PARSE_RE.exec(text);
  if (!match) return true;
  const nextRe = new RegExp(`^\\s*${nextKey}\\s*:`, 'm');
  const prevRe = new RegExp(`^\\s*${prevKey}\\s*:`, 'm');
  const hasNext = nextRe.test(match[1]);
  const hasPrev = prevRe.test(match[1]);
  if (!isLast && !hasNext) return true;
  if (!isFirst && !hasPrev) return true;
  return false;
}

function createArgs(text, prevFile, nextFile, prevKey = 'Back', nextKey = 'Next') {
  const ignoreKeys = getLinkKeys(prevKey, nextKey);
  const args = parseAttributes(text, ignoreKeys);
  if (prevFile) args.set(prevKey, `"[[${path.basename(prevFile)}]]"`);
  if (nextFile) args.set(nextKey, `"[[${path.basename(nextFile)}]]"`);
  return args;
}

async function collectMarkdownFiles(folder) {
  const result = [];
  const walk = async (dir) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(full);
    }
  };
  await walk(folder);
  return result.sort();
}

async function recalcLinks(folder, force, dateKey = 'Date', prevKey = 'Back', nextKey = 'Next', onProgress) {
  const files = await collectMarkdownFiles(folder);
  const last = files.length - 1;
  let changed = 0;

  for (let i = 0; i < files.length; i++) {
    const text = await fsp.readFile(files[i], 'utf8');
    if (force || needsRecalc(text, i === 0, i === last, prevKey, nextKey)) {
      const args = createArgs(text, i > 0 ? files[i - 1] : null, i < last ? files[i + 1] : null, prevKey, nextKey);
      const newText = updateText(text, args, dateKey, prevKey, nextKey);
      if (newText !== text) {
        await fsp.writeFile(files[i], newText, 'utf8');
        changed++;
      }
    }
    if (i % 100 === 0) {
      if (onProgress) onProgress(i + 1, files.length);
      await tick();
    }
  }
  return { total: files.length, changed };
}

// ======================================================================
// Копирование медиа и запись заметок
// ======================================================================

const THUMB_SKIP_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function isThumbnail(fileName) {
  const name = fileName.toLowerCase();
  return name.includes('_thumb') || name.includes('_preview')
    || name.endsWith('.mp4.jpg') || name.endsWith('.mp4_thumb.jpg');
}

const MEDIA_FAMILIES = {
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'bmp', 'tif', 'tiff'],
  video: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'],
  audio: ['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aac'],
};
const EXT_FAMILY = new Map();
for (const [family, exts] of Object.entries(MEDIA_FAMILIES)) exts.forEach((e) => EXT_FAMILY.set(e, family));

function mediaKey(fileName) {
  const ext = path.extname(fileName);
  const family = EXT_FAMILY.get(ext.slice(1).toLowerCase());
  return family ? `${family}:${path.basename(fileName, ext).toLowerCase()}` : null;
}

async function sameContent(fileA, fileB) {
  const CHUNK = 1024 * 1024;
  const [ha, hb] = [await fsp.open(fileA, 'r'), await fsp.open(fileB, 'r')];
  try {
    const bufA = Buffer.allocUnsafe(CHUNK);
    const bufB = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const [ra, rb] = [await ha.read(bufA, 0, CHUNK, null), await hb.read(bufB, 0, CHUNK, null)];
      if (ra.bytesRead !== rb.bytesRead) return false;
      if (ra.bytesRead === 0) return true;
      if (!bufA.subarray(0, ra.bytesRead).equals(bufB.subarray(0, rb.bytesRead))) return false;
    }
  } finally {
    await ha.close();
    await hb.close();
  }
}

async function mergeCopy(src, dst, stats, onProgress, isRoot = true) {
  await fsp.mkdir(dst, { recursive: true });

  const existingNames = new Set();
  const existingKeys = new Set();
  const dstNames = await fsp.readdir(dst);
  for (const name of dstNames) {
    existingNames.add(name.toLowerCase());
    const key = mediaKey(name);
    if (key) existingKeys.add(key);
  }

  let sizeIndex = null;
  const getSizeIndex = async () => {
    if (sizeIndex) return sizeIndex;
    sizeIndex = new Map();
    for (const name of dstNames) {
      try {
        const st = await fsp.stat(path.join(dst, name));
        if (!st.isFile()) continue;
        if (!sizeIndex.has(st.size)) sizeIndex.set(st.size, []);
        sizeIndex.get(st.size).push(name);
      } catch (e) { }
    }
    return sizeIndex;
  };

  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isDirectory()) {
      await mergeCopy(s, d, stats, onProgress, false);
    } else if (entry.isFile()) {
      if (isRoot && entry.name === 'result.json') continue;
      if (THUMB_SKIP_EXTS.has(path.extname(entry.name).toLowerCase()) && isThumbnail(entry.name)) continue;

      const key = mediaKey(entry.name);
      if (existingNames.has(entry.name.toLowerCase()) || (key && existingKeys.has(key))) {
        stats.skipped++;
      } else {
        try {
          const st = await fsp.stat(s);
          let duplicate = false;
          for (const name of (await getSizeIndex()).get(st.size) || []) {
            if (await sameContent(s, path.join(dst, name))) { duplicate = true; break; }
          }

          if (duplicate) {
            stats.skipped++;
          } else {
            await fsp.copyFile(s, d, fs.constants.COPYFILE_EXCL);
            await fsp.utimes(d, st.atime, st.mtime);
            existingNames.add(entry.name.toLowerCase());
            if (key) existingKeys.add(key);
            if (!sizeIndex.has(st.size)) sizeIndex.set(st.size, []);
            sizeIndex.get(st.size).push(entry.name);
            stats.copied++;
          }
        } catch (e) {
          console.error('[telegram-import] ошибка копирования', s, e);
          stats.errors++;
        }
      }
      if ((stats.copied + stats.skipped) % 50 === 0) {
        if (onProgress) onProgress(stats.copied + stats.skipped);
        await tick();
      }
    }
  }
}

// ----------------------------------------------------------------------
// Синхронизация заметок и слияние ручных правок
// ----------------------------------------------------------------------

const INDEX_VERSION = 3;
const MARK_OURS = '<<<<<<< Мои правки (в хранилище)';
const MARK_SEP = '=======';
const MARK_THEIRS = '>>>>>>> Telegram (новая версия)';

async function readOrNull(file) {
  try { return await fsp.readFile(file, 'utf8'); } catch (e) { return null; }
}

async function writeText(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text, 'utf8');
}

async function removeIfExists(file) {
  try { await fsp.unlink(file); } catch (e) { }
}

const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

function canonMediaName(raw) {
  let name = raw.trim().replace(/^<|>$/g, '');
  try { name = decodeURIComponent(name); } catch (e) { }
  name = name.split('/').pop();
  const ext = path.extname(name);
  if (EXT_FAMILY.has(ext.slice(1).toLowerCase())) name = name.slice(0, -ext.length);
  return name.replace(/_\d+@/, '@').toLowerCase();
}

function canonMediaRefs(text) {
  const token = (name) => `⟦медиа:${canonMediaName(name)}⟧`;
  return text
    .replace(/!\[[^\]\n]*\]\(([^)\n]+)\)/g, (m, target) => (/^https?:/i.test(target.trim()) ? m : token(target)))
    .replace(/!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]/g, (m, name) => token(name));
}

function contentKey(body) {
  return canonMediaRefs(body)
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .replace(/[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .split('\n').map((line) => line.replace(/[ \t]+$/, '')).filter((line) => line !== '>').join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitNote(text, ignoreKeys) {
  text = text.replace(/\r\n/g, '\n');
  const attrs = parseAttributes(text, ignoreKeys);
  const m = HEADER_REPLACE_RE.exec(text);
  const rest = m ? text.slice(m[0].length) : text;
  const body = rest.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  return { attrs, body, key: contentKey(body) };
}

function collectDifferences(textA, textB) {
  const la = textA.split('\n');
  const lb = textB.split('\n');
  const diffs = [];
  const max = Math.max(la.length, lb.length);
  for (let i = 0; i < max; i++) {
    if (la[i] !== lb[i]) {
      diffs.push({
        line: i + 1,
        ours: la[i] !== undefined ? la[i] : '(нет строки)',
        theirs: lb[i] !== undefined ? lb[i] : '(нет строки)',
      });
    }
  }
  return diffs;
}

function renderNote(attrs, body, dateKey = 'Date', prevKey = 'Back', nextKey = 'Next') {
  const header = renderHeader(attrs, dateKey, prevKey, nextKey);
  return body ? `${header}\n\n${body}` : header;
}

function lcsHunks(base, other) {
  const n = base.length;
  const m = other.length;
  if (n * m > 4000000) return [{ s: 0, e: n, lines: other }];

  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = base[i] === other[j]
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const hunks = [];
  let i = 0;
  let j = 0;
  let hs = -1;
  let hj = -1;
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === other[j]) {
      if (hs !== -1) { hunks.push({ s: hs, e: i, lines: other.slice(hj, j) }); hs = -1; }
      i++; j++;
    } else {
      if (hs === -1) { hs = i; hj = j; }
      if (j < m && (i === n || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) j++;
      else i++;
    }
  }
  if (hs !== -1) hunks.push({ s: hs, e: i, lines: other.slice(hj, j) });
  return hunks;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((v, k) => v === b[k]);
}

function merge3(base, ours, theirs) {
  const all = lcsHunks(base, ours).map((h) => ({ ...h, side: 'o' }))
    .concat(lcsHunks(base, theirs).map((h) => ({ ...h, side: 't' })))
    .sort((x, y) => x.s - y.s || x.e - y.e);

  const apply = (hunks, gs, ge) => {
    let result = [];
    let cursor = gs;
    for (const h of hunks) {
      result = result.concat(base.slice(cursor, h.s), h.lines);
      cursor = h.e;
    }
    return result.concat(base.slice(cursor, ge));
  };

  let out = [];
  let pos = 0;
  let conflict = false;
  let i = 0;

  while (i < all.length) {
    const gs = all[i].s;
    let ge = all[i].e;
    const group = [all[i++]];
    while (i < all.length && all[i].s <= ge) {
      ge = Math.max(ge, all[i].e);
      group.push(all[i++]);
    }

    out = out.concat(base.slice(pos, gs));
    pos = ge;

    const baseRange = base.slice(gs, ge);
    const a = apply(group.filter((h) => h.side === 'o'), gs, ge);
    const b = apply(group.filter((h) => h.side === 't'), gs, ge);

    if (sameLines(a, b) || sameLines(b, baseRange)) out = out.concat(a);
    else if (sameLines(a, baseRange)) out = out.concat(b);
    else {
      conflict = true;
      out = out.concat([MARK_OURS], a, [MARK_SEP], b, [MARK_THEIRS]);
    }
  }
  return { lines: out.concat(base.slice(pos)), conflict };
}

function mergeAttrs(oursAttrs, freshAttrs, links, prevKey = 'Back', nextKey = 'Next') {
  const attrs = new Map(oursAttrs);
  for (const [key, value] of freshAttrs) if (!attrs.has(key)) attrs.set(key, value);
  if (links.prev) attrs.set(prevKey, `"[[${links.prev}]]"`);
  if (links.next) attrs.set(nextKey, `"[[${links.next}]]"`);
  return attrs;
}

async function syncNote(file, fresh, links, preserve, index, key, dateKey, prevKey, nextKey) {
  const done = (result, conflicted = false, details = null) => ({ result, conflicted, details });
  const ignoreKeys = getLinkKeys(prevKey, nextKey);
  const F = splitNote(fresh, ignoreKeys);
  const freshHash = sha(F.key);

  const disk = await readOrNull(file);
  if (disk === null) {
    await writeText(file, fresh);
    if (preserve) index[key] = freshHash;
    return done('written');
  }

  const marked = disk.includes(MARK_OURS);
  const D = splitNote(disk, ignoreKeys);

  if (!preserve) {
    if (D.key === F.key) return done('unchanged', marked);
    await writeText(file, fresh);
    return done('written');
  }

  if (D.key === F.key) {
    index[key] = freshHash;
    return done('unchanged', marked);
  }

  const known = index[key];
  if (known === undefined || known === freshHash) {
    index[key] = freshHash;
    return done('kept', marked);
  }

  if (sha(D.key) === known) {
    await writeText(file, renderNote(mergeAttrs(D.attrs, F.attrs, links, prevKey, nextKey), F.body, dateKey, prevKey, nextKey));
    index[key] = freshHash;
    return done('written');
  }

  // Изменения есть и локально, и в Telegram
  let body;
  let conflict;
  const m = merge3(D.body.split('\n'), D.body.split('\n'), F.body.split('\n')); // прямое трехстороннее при отсутствии базы
  body = [MARK_OURS, D.body, MARK_SEP, F.body, MARK_THEIRS].join('\n');
  conflict = true;

  await writeText(file, renderNote(mergeAttrs(D.attrs, F.attrs, links, prevKey, nextKey), body, dateKey, prevKey, nextKey));
  index[key] = freshHash;

  const diffs = collectDifferences(D.body, F.body);
  return done('conflict', true, {
    key,
    file,
    diskContent: disk,
    freshContent: fresh,
    diffs,
  });
}

// ======================================================================
// Запись отчёта и файлов конфликтов в _merge_conflicts
// ======================================================================

async function dumpConflicts(vaultBase, conflictsInfo) {
  const conflictDir = path.join(vaultBase, '_merge_conflicts');
  await fsp.mkdir(conflictDir, { recursive: true });

  const escapeMd = (str) => String(str).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');

  let report = `# ⚠️ Неразрешённые конфликты слияния (${conflictsInfo.length})\n\n`;
  report += `Сгенерировано: ${new Date().toLocaleString('ru-RU')}\n\n`;
  report += `В таблице ниже собраны подробные расхождения для каждого файла между вашей текущей версией в хранилище и новой версией из Telegram.\n\n`;
  report += `| Файл | Строка | Версия в хранилище | Версия из Telegram |\n`;
  report += `| --- | :---: | --- | --- |\n`;

  for (const item of conflictsInfo) {
    const baseName = path.basename(item.file, '.md');
    const safeKey = item.key.replace(/\//g, '__');

    // Сохраняем дампы двух вариантов рядом для наглядного сравнения
    await writeText(path.join(conflictDir, `${safeKey}.хранилище.md`), item.diskContent);
    await writeText(path.join(conflictDir, `${safeKey}.telegram.md`), item.freshContent);

    const link = `[[${item.key}\\|${baseName}]]`;
    if (!item.diffs.length) {
      report += `| ${link} | — | *(текст совпадает, конфликт в структуре)* | *(текст совпадает)* |\n`;
    } else {
      for (const d of item.diffs) {
        report += `| ${link} | ${d.line} | \`\${escapeMd(d.ours)}\` | \`\${escapeMd(d.theirs)}\` |\n`;
      }
    }
  }

  const reportPath = path.join(conflictDir, '_00_Конфликты_сравнение.md');
  await writeText(reportPath, report);
}

// ======================================================================
// Выбор папки
// ======================================================================

async function pickFolder() {
  try {
    const electron = require('electron');
    const dialog = electron.remote && electron.remote.dialog;
    if (dialog) {
      const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    }
  } catch (e) { }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      let filePath = file.path;
      try {
        const { webUtils } = require('electron');
        if (webUtils && webUtils.getPathForFile) filePath = webUtils.getPathForFile(file);
      } catch (e) { }
      if (!filePath) return resolve(null);
      let dir = filePath;
      const depth = file.webkitRelativePath.split('/').length - 1;
      for (let i = 0; i < depth; i++) dir = path.dirname(dir);
      resolve(dir);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

// ======================================================================
// Диалог выбора папки архива перед импортом
// ======================================================================

class ArchivePromptModal extends Modal {
  constructor(app, initial, onSubmit) {
    super(app);
    this.value = initial || '';
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Папка с архивом Telegram' });
    contentEl.createEl('p', {
      text: 'Папка экспорта (JSON), в которой лежит result.json. Путь можно вставить или выбрать.',
      cls: 'setting-item-description',
    });

    const row = contentEl.createDiv();
    row.style.display = 'flex';
    row.style.gap = '8px';
    this.input = row.createEl('input', { type: 'text' });
    this.input.value = this.value;
    this.input.placeholder = '/путь/к/ChatExport_2026-10-12';
    this.input.style.flex = '1';
    this.input.addEventListener('input', () => { this.value = this.input.value; this.setError(''); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.submit(); });

    const pick = row.createEl('button', { text: 'Выбрать…' });
    pick.addEventListener('click', async () => {
      const dir = await pickFolder();
      if (dir) { this.input.value = dir; this.value = dir; this.setError(''); }
    });

    this.errorEl = contentEl.createDiv();
    this.errorEl.style.color = 'var(--text-error)';
    this.errorEl.style.marginTop = '8px';

    const actions = contentEl.createDiv();
    actions.style.display = 'flex';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '8px';
    actions.style.marginTop = '16px';
    const cancel = actions.createEl('button', { text: 'Отмена' });
    cancel.addEventListener('click', () => this.close());
    this.goButton = actions.createEl('button', { text: 'Импортировать', cls: 'mod-cta' });
    this.goButton.addEventListener('click', () => this.submit());

    this.input.focus();
    if (this.input.select) this.input.select();
  }

  setError(text) {
    if (this.errorEl) this.errorEl.setText(text);
  }

  submit() {
    const dir = this.value.trim().replace(/^["']+|["']+\$/g, '');
    if (!dir) return this.setError('Укажи папку с архивом.');
    if (!fs.existsSync(path.join(dir, 'result.json'))) return this.setError('В этой папке нет result.json.');
    this.close();
    this.onSubmit(dir);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ======================================================================
// Список конфликтов
// ======================================================================

class ConflictsModal extends FuzzySuggestModal {
  constructor(app, items) {
    super(app);
    this.items = items;
    this.setPlaceholder('Заметки с конфликтами слияния…');
  }

  getItems() { return this.items; }

  getItemText(item) { return item; }

  onChooseItem(item) {
    const file = this.app.vault.getAbstractFileByPath(item);
    if (file) this.app.workspace.getLeaf(false).openFile(file);
    else this.app.workspace.openLinkText(item, '', false);
  }
}

// ======================================================================
// Плагин
// ======================================================================

module.exports = class TelegramImportPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.running = false;
    this.statusEl = this.addStatusBarItem();

    this.addCommand({
      id: 'run-full-import',
      name: 'Импорт из Telegram (экспорт → копирование → пересчёт ссылок)',
      callback: () => this.startImport(),
    });
    this.addCommand({
      id: 'recalc-links-only',
      name: 'Только пересчитать ссылки Back/Next',
      callback: () => this.runRecalcOnly(),
    });
    this.addCommand({
      id: 'show-conflicts',
      name: 'Показать заметки с конфликтами слияния',
      callback: () => this.showConflicts(),
    });
    this.addRibbonIcon('send', 'Импорт из Telegram', () => this.startImport());
    this.addSettingTab(new TelegramImportSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  setStatus(text) {
    this.statusEl.setText(text ? `Telegram: ${text}` : '');
  }

  vaultPath(relPath, label) {
    const base = this.app.vault.adapter.getBasePath();
    const abs = path.resolve(base, relPath || '');
    const rel = path.relative(base, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`${label} должна находиться внутри хранилища`);
    }
    return abs;
  }

  async refreshConflicts(extra = []) {
    const base = this.app.vault.adapter.getBasePath();
    const paths = [...new Set([...(this.settings.conflicts || []), ...extra])];
    const alive = [];
    for (const rel of paths) {
      const text = await readOrNull(path.join(base, rel));
      if (text !== null && text.includes(MARK_OURS)) alive.push(rel);
    }
    this.settings.conflicts = alive.sort();
    await this.saveSettings();
    return this.settings.conflicts;
  }

  async showConflicts() {
    const list = await this.refreshConflicts();
    if (!list.length) return new Notice('Telegram: конфликтов слияния нет');
    new ConflictsModal(this.app, list).open();
  }

  async startImport() {
    if (this.running) return new Notice('Импорт уже выполняется');
    if (!this.settings.askArchiveEachTime) return this.runFullImport(this.settings.archiveFolder);

    new ArchivePromptModal(this.app, this.settings.archiveFolder, async (dir) => {
      this.settings.archiveFolder = dir;
      await this.saveSettings();
      this.runFullImport(dir);
    }).open();
  }

  async runFullImport(archiveFolder) {
    if (this.running) return new Notice('Импорт уже выполняется');
    const s = this.settings;

    if (!archiveFolder) return new Notice('Укажи папку с архивом Telegram в настройках плагина');
    const jsonPath = path.join(archiveFolder, 'result.json');
    if (!fs.existsSync(jsonPath)) return new Notice(`В папке архива нет result.json:\n${archiveFolder}`);

    this.running = true;
    try {
      const target = this.vaultPath(s.targetFolder, 'Папка назначения');
      if (!s.recalcFolder) throw new Error('Укажи папку для пересчёта ссылок в настройках плагина');
      const recalcDir = this.vaultPath(s.recalcFolder, 'Папка для пересчёта ссылок');

      new Notice('Telegram: копирование файлов…');
      const copyStats = { copied: 0, skipped: 0, errors: 0 };
      await mergeCopy(archiveFolder, target, copyStats, (n) => this.setStatus(`копирование файлов: ${n}`));

      this.setStatus('чтение result.json…');
      await tick();
      const raw = (await fsp.readFile(jsonPath, 'utf8')).replace(/^\uFEFF/, '');
      const json = JSON.parse(raw);

      const converter = new TelegramConverter({
        yandexApiKey: s.yandexApiKey,
        dateFormat: s.dateFormat,
        threshold: Math.max(0, Number(s.mergeThreshold) || 0),
        prevKey: s.prevKey || 'Back',
        nextKey: s.nextKey || 'Next',
        dateKey: s.dateKey || 'Date',
      });
      const posts = converter.getPosts(json);

      const vaultBase = this.app.vault.adapter.getBasePath();
      const pluginDir = path.join(vaultBase, this.manifest.dir);
      const indexFile = path.join(pluginDir, 'import-index.json');
      await fsp.rm(path.join(pluginDir, 'base'), { recursive: true, force: true });
      await fsp.rm(path.join(pluginDir, 'originals'), { recursive: true, force: true });

      let index = {};
      try {
        const saved = JSON.parse(await fsp.readFile(indexFile, 'utf8'));
        if (saved && saved.version === INDEX_VERSION) index = saved.notes;
      } catch (e) { }

      const noteStats = { written: 0, unchanged: 0, kept: 0, merged: 0, conflict: 0 };
      const newConflicts = [];
      const conflictsInfo = [];

      try {
        for (let i = 0; i < posts.length; i++) {
          const prev = i > 0 ? posts[i - 1].fileName : null;
          const next = i < posts.length - 1 ? posts[i + 1].fileName : null;
          const text = converter.buildNote(posts[i], prev, next);
          const file = path.join(target, converter.getRelativePath(posts[i]));
          const key = path.relative(vaultBase, file).split(path.sep).join('/');

          const { result, conflicted, details } = await syncNote(
            file,
            text,
            { prev, next },
            s.preserveEdits,
            index,
            key,
            s.dateKey || 'Date',
            s.prevKey || 'Back',
            s.nextKey || 'Next'
          );
          noteStats[result]++;
          if (conflicted) {
            newConflicts.push(key);
            if (details) conflictsInfo.push(details);
          }

          if (i % 50 === 0) {
            this.setStatus(`заметки ${i + 1}/${posts.length}`);
            await tick();
          }
        }
      } finally {
        if (s.preserveEdits) {
          await writeText(indexFile, JSON.stringify({ version: INDEX_VERSION, notes: index }));
        }
      }

      if (conflictsInfo.length) {
        await dumpConflicts(vaultBase, conflictsInfo);
      }

      if (!fs.existsSync(recalcDir)) throw new Error(`Нет папки для пересчёта ссылок:\n${recalcDir}`);
      const rs = await recalcLinks(
        recalcDir,
        s.recalcForce,
        s.dateKey || 'Date',
        s.prevKey || 'Back',
        s.nextKey || 'Next',
        (n, total) => this.setStatus(`пересчёт ссылок ${n}/${total}`)
      );

      const conflicts = await this.refreshConflicts(newConflicts);

      let msg = `Telegram: готово.\nЗаметки: записано ${noteStats.written}, без изменений ${noteStats.unchanged}`
        + `, оставлено ваших версий ${noteStats.kept}, объединено ${noteStats.merged}, с конфликтами ${noteStats.conflict}.`
        + `\nФайлы: скопировано ${copyStats.copied}, без изменений ${copyStats.skipped}.`
        + `\nСсылки: обновлено ${rs.changed} из ${rs.total}.`;
      if (copyStats.errors) msg += `\nОшибок копирования: ${copyStats.errors} (подробности в консоли).`;
      if (conflicts.length) {
        msg += `\nНеразрешённых конфликтов: ${conflicts.length}. Подробная таблица и файлы сохранены в папку «_merge_conflicts».`;
      }
      new Notice(msg, 12000);
    } catch (e) {
      console.error('[telegram-import]', e);
      new Notice(`Telegram: ошибка\n${e.message}`, 12000);
    } finally {
      this.running = false;
      this.setStatus('');
    }
  }

  async runRecalcOnly() {
    if (this.running) return new Notice('Уже выполняется');
    this.running = true;
    try {
      if (!this.settings.recalcFolder) throw new Error('Укажи папку для пересчёта ссылок в настройках плагина');
      const dir = this.vaultPath(this.settings.recalcFolder, 'Папка для пересчёта ссылок');
      if (!fs.existsSync(dir)) throw new Error(`Нет папки для пересчёта ссылок:\n${dir}`);
      const rs = await recalcLinks(
        dir,
        this.settings.recalcForce,
        this.settings.dateKey || 'Date',
        this.settings.prevKey || 'Back',
        this.settings.nextKey || 'Next',
        (n, total) => this.setStatus(`пересчёт ссылок ${n}/${total}`)
      );
      new Notice(`Telegram: ссылки обновлены в ${rs.changed} из ${rs.total} файлов.`, 6000);
    } catch (e) {
      console.error('[telegram-import]', e);
      new Notice(`Telegram: ошибка\n${e.message}`, 12000);
    } finally {
      this.running = false;
      this.setStatus('');
    }
  }
};

// ======================================================================
// Настройки
// ======================================================================

class TelegramImportSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    let archiveText;
    new Setting(containerEl)
      .setName('Папка с архивом Telegram')
      .setDesc('Папка экспорта «Telegram Desktop → Экспорт данных → JSON», в которой лежит result.json. Если включён вопрос при каждом импорте, это значение подставляется в диалог по умолчанию.')
      .addText((t) => {
        archiveText = t;
        t.setPlaceholder('/путь/к/ChatExport_2026-10-12')
          .setValue(s.archiveFolder)
          .onChange(async (v) => { s.archiveFolder = v.trim(); await save(); });
        t.inputEl.style.width = '320px';
      })
      .addButton((b) => b.setButtonText('Выбрать…').onClick(async () => {
        const dir = await pickFolder();
        if (!dir) return;
        s.archiveFolder = dir;
        archiveText.setValue(dir);
        await save();
      }));

    new Setting(containerEl)
      .setName('Спрашивать папку архива при каждом импорте')
      .setDesc('Перед импортом открывается диалог с путём к архиву (последний использованный подставляется). Если выключить, всегда берётся папка из поля выше.')
      .addToggle((t) => t.setValue(s.askArchiveEachTime)
        .onChange(async (v) => { s.askArchiveEachTime = v; await save(); }));

    new Setting(containerEl)
      .setName('Папка назначения в хранилище')
      .setDesc('Сюда попадает результат: заметки в «notes/…» и файлы архива. Существующие файлы не перезаписываются, в том числе если вы сменили формат (например, png → webp), а файлы с тем же содержимым пропускаются.')
      .addText((t) => t.setValue(s.targetFolder)
        .onChange(async (v) => { s.targetFolder = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName('Папка для пересчёта ссылок')
      .setDesc('Путь внутри хранилища. Все .md внутри (включая вложенные папки) выстраиваются в цепочку по порядку имён.')
      .addText((t) => t.setPlaceholder('Telegram/notes').setValue(s.recalcFolder)
        .onChange(async (v) => { s.recalcFolder = v.trim().replace(/^[\\/]+|[\\/]+\$/g, ''); await save(); }));

    new Setting(containerEl)
      .setName('Пересчитывать все файлы')
      .setDesc('Нужно, если заметки сливаются с уже существующими: иначе файлы, у которых уже есть ссылки навигации, пропускаются.')
      .addToggle((t) => t.setValue(s.recalcForce)
        .onChange(async (v) => { s.recalcForce = v; await save(); }));

    containerEl.createEl('h3', { text: 'Атрибуты frontmatter (порядок: Дата → Назад → Вперед → остальные)' });

    new Setting(containerEl)
      .setName('Имя атрибута для даты')
      .setDesc('Ключ во frontmatter, куда записывается дата заметки (первая позиция, по умолчанию: Date).')
      .addText((t) => t.setPlaceholder('Date').setValue(s.dateKey)
        .onChange(async (v) => {
          s.dateKey = v.trim() || 'Date';
          await save();
        }));

    new Setting(containerEl)
      .setName('Имя атрибута для предыдущей заметки')
      .setDesc('Ключ во frontmatter, куда записывается ссылка на предыдущую заметку (вторая позиция, по умолчанию: Back).')
      .addText((t) => t.setPlaceholder('Back').setValue(s.prevKey)
        .onChange(async (v) => {
          s.prevKey = v.trim() || 'Back';
          await save();
        }));

    new Setting(containerEl)
      .setName('Имя атрибута для следующей заметки')
      .setDesc('Ключ во frontmatter, куда записывается ссылка на следующую заметку (третья позиция, по умолчанию: Next).')
      .addText((t) => t.setPlaceholder('Next').setValue(s.nextKey)
        .onChange(async (v) => {
          s.nextKey = v.trim() || 'Next';
          await save();
        }));

    new Setting(containerEl)
      .setName('Беречь ручные правки')
      .setDesc('Сравнивается только текст заметки, атрибуты игнорируются. Если вы правили текст, а в Telegram пост тоже изменился, правки объединяются (как в git); при пересечении в тексте остаются маркеры конфликта, а подробности и варианты складываются в «_merge_conflicts».')
      .addToggle((t) => t.setValue(s.preserveEdits)
        .onChange(async (v) => { s.preserveEdits = v; await save(); }));

    containerEl.createEl('h3', { text: 'Оформление заметок' });

    new Setting(containerEl)
      .setName('Порог склейки сообщений, секунд')
      .setDesc('Сообщения, идущие подряд с меньшим интервалом, объединяются в один пост. 0 — не склеивать.')
      .addText((t) => t.setValue(String(s.mergeThreshold))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!Number.isNaN(n) && n >= 0) { s.mergeThreshold = n; await save(); }
        }));

    new Setting(containerEl)
      .setName('Формат даты в шапке')
      .setDesc('Пусто — «7 сентября 2026, 09:41». Иначе строка в стиле strftime: %d %m %Y %y %H %M %S %B %b, например «%d.%m.%Y %H:%M».')
      .addText((t) => t.setPlaceholder('%d.%m.%Y %H:%M').setValue(s.dateFormat)
        .onChange(async (v) => { s.dateFormat = v.trim(); await save(); }));

    new Setting(containerEl)
      .setName('Ключ Яндекс Static Maps')
      .setDesc('Для превью-картинок локаций. Без ключа вместо картинки будет только ссылка. Хранится в data.json плагина.')
      .addText((t) => t.setValue(s.yandexApiKey)
        .onChange(async (v) => { s.yandexApiKey = v.trim(); await save(); }));

    containerEl.createEl('h3', { text: 'Инструкция' });
    containerEl.createEl('p', { text: `Версия сборки: ${BUILD}`, cls: 'setting-item-description' });
    const details = containerEl.createEl('details');
    details.createEl('summary', { text: 'Открыть README' });
    const readmeEl = details.createDiv();
    readmeEl.style.maxHeight = '60vh';
    readmeEl.style.overflowY = 'auto';
    readmeEl.style.padding = '8px 4px';
    let loaded = false;
    details.addEventListener('toggle', async () => {
      if (!details.open || loaded) return;
      loaded = true;
      await this.renderReadme(readmeEl);
    });
  }

  async renderReadme(el) {
    const file = normalizePath(`${this.plugin.manifest.dir}/README.md`);
    let markdown;
    try {
      markdown = await this.app.vault.adapter.read(file);
    } catch (e) {
      el.setText(`Файл README.md не найден в папке плагина (${file}).`);
      return;
    }
    if (MarkdownRenderer.render) await MarkdownRenderer.render(this.app, markdown, el, '', this.plugin);
    else await MarkdownRenderer.renderMarkdown(markdown, el, '', this.plugin);
  }
}