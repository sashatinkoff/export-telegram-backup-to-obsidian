'use strict';
// Конвертер экспорта Telegram: result.json -> посты -> markdown-заметки.
const { py, isDict, pad2, parseDate, formatDate, MONTHS_RU_GENITIVE, MONTHS_EN } = require('./util');
const { path } = require('./platform');
const { getLinkNames } = require('./links');

class TelegramConverter {
  constructor({ yandexApiKey = '', dateFormat = '', threshold = 120, convertTags = true } = {}) {
    this.convertTags = convertTags; // хэштеги -> tags в шапке (иначе остаются в тексте)
    this.yandexApiKey = yandexApiKey;
    this.dateFormat = dateFormat;
    this.threshold = threshold;
  }

  formatHeaderDate(dt) {
    if (this.dateFormat) return formatDate(this.dateFormat, dt);
    return `${dt.d} ${MONTHS_RU_GENITIVE[dt.mo - 1]} ${dt.y}, ${pad2(dt.H)}:${pad2(dt.M)}`;
  }

  getFileName(message) {
    const dt = parseDate(message.date);
    return `${dt.y}-${pad2(dt.mo)}-${pad2(dt.d)} ${pad2(dt.H)}-${pad2(dt.M)}-${pad2(dt.S)}.md`;
  }

  // Относительный путь заметки внутри папки назначения: notes/2026/2026-09-September/<имя>.md
  getRelativePath(post) {
    const dt = parseDate(post.date);
    const folder = `${dt.y}-${pad2(dt.mo)}-${MONTHS_EN[dt.mo - 1]}`;
    return path.join('notes', String(dt.y), folder, post.fileName);
  }

  // ---------- группировка сообщений в посты ----------

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

    // чисто медиа-пост
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

    // Хэштеги в конце текста дублируют tags во frontmatter — убираем их из тела
    if (this.convertTags) fullText = this.stripTrailingHashtags(fullText);

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

  // ---------- текст сообщения ----------

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
      const exclude = (this.convertTags && item.type === 'hashtag') || (item.type === 'plain' && !String(item.text || '').trim());
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
      case 'hashtag': return this.convertTags ? text.replace(/#/g, '') : text;
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

  // ---------- медиа ----------

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

  // ---------- rich_message (структурированные блоки) ----------

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
      case 'bold': return wrap('**', '**');
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
    const width = Math.min(block.width ?? 600, 650);   // лимит бесплатного тарифа Static API
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

  // ---------- хэштеги из rich_message ----------

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

  // ---------- сборка заметки ----------

  createHeader(post, nextFile, prevFile) {
    const dt = parseDate(post.date);
    const names = getLinkNames();
    let header = `---\n${names.date}: ${this.formatHeaderDate(dt)}`;
    // Порядок как у пересчёта ссылок (links.orderedAttributes): Date, назад, вперёд, tags, остальное
    if (prevFile) header += `\n${names.prev}: "[[${prevFile}]]"`;
    if (nextFile) header += `\n${names.next}: "[[${nextFile}]]"`;
    if (this.convertTags && post.hashTags.length) header += `\ntags: \n${post.hashTags.map((t) => `  - ${t}`).join('\n')}`; // «tags: » с пробелом — как у пересчёта ссылок, иначе он переписывал бы каждую новую заметку
    if (py(post.forwardedFrom)) header += `\nИсточник: ${post.forwardedFrom}`;
    return `${header}\n---`;
  }

  buildNote(post, prevFile, nextFile) {
    const header = this.createHeader(post, nextFile, prevFile);
    const content = post.text.trim();
    const text = content ? `${header}\n\n${content}` : header;
    return text.replace(/\n{3,}/g, '\n\n'); // 3+ переносов -> один пустой абзац
  }
}

module.exports = { TelegramConverter };
