'use strict';
// Быстрый осмотр источника перед импортом: что внутри архива (сообщения, медиа, размер).
const fs = require('fs');
const path = require('path');
const { scanArchive } = require('./media');
const { mapPool } = require('./util');
const zip = require('./zip');

const fsp = fs.promises;

function emptyContent() {
  return { text: 0, photos: 0, videos: 0, voice: 0, audio: 0, files: 0, links: 0 };
}

// Считает сообщения по видам. text — сообщения без вложений.
function countContent(json) {
  const c = emptyContent();
  const exts = { videos: new Map(), files: new Map(), voice: new Map() };
  const bump = (map, file) => { const e = path.extname(String(file || '')).toLowerCase(); if (e) map.set(e, (map.get(e) || 0) + 1); };
  for (const m of json.messages || []) {
    if (m.type && m.type !== 'message') continue;
    if (m.photo) c.photos++;
    else if (m.media_type === 'voice_message') { c.voice++; bump(exts.voice, m.file); }
    else if (m.media_type === 'video_file' || m.media_type === 'video_message' || m.media_type === 'animation') { c.videos++; bump(exts.videos, m.file); }
    else if (m.media_type === 'audio_file') c.audio++;
    else if (m.file) { c.files++; bump(exts.files, m.file); }
    else c.text++;
    const ents = Array.isArray(m.text_entities) ? m.text_entities : [];
    for (const e of ents) if (e && (e.type === 'link' || e.type === 'text_link')) c.links++;
  }
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([e]) => e);
  return { counts: c, exts: { videos: top(exts.videos, 2), files: top(exts.files, 3), voice: top(exts.voice, 1) } };
}

const CHAT_TYPES = {
  personal_chat: 'Личный чат', private_group: 'Группа', private_supergroup: 'Группа', public_supergroup: 'Группа',
  public_channel: 'Канал', private_channel: 'Канал', saved_messages: 'Личное', bot_chat: 'Бот',
};

function chatInfo(json) {
  return {
    name: json.name || (json.type === 'saved_messages' ? 'Избранное' : 'Без названия'),
    type: json.type || '',
    typeLabel: CHAT_TYPES[json.type] || 'Чат',
    id: json.id || null,
  };
}

// source: { kind: 'folder'|'zip', path }. Возвращает описание архива и разобранный result.json (для повторного использования)
async function scanSource(source) {
  let jsonText;
  let bytes = 0;
  let files = 0;
  let exportedAt = 0;
  let zipInfo = null;
  if (source.kind === 'zip') {
    const entries = await zip.listZip(source.path);
    const found = zip.findResult(entries);
    if (!found) throw new Error('В ZIP-архиве нет result.json');
    jsonText = await zip.readEntry(source.path, found.entry);
    const under = entries.filter((e) => !e.dir && e.name.startsWith(found.prefix) && !e.name.startsWith('__MACOSX/'));
    files = under.length - 1;
    bytes = under.reduce((s, e) => s + e.usize, 0) - found.entry.usize;
    exportedAt = found.entry.mtime.getTime();
    zipInfo = { entries, prefix: found.prefix, size: (await fsp.stat(source.path)).size };
  } else {
    const jsonPath = path.join(source.path, 'result.json');
    const st = await fsp.stat(jsonPath);
    exportedAt = st.mtimeMs;
    jsonText = await fsp.readFile(jsonPath, 'utf8');
    const { dirs } = await scanArchive(source.path);
    const flat = dirs.flatMap((d) => d.files.map((f) => path.join(source.path, d.rel, f)));
    const stats = await mapPool(flat, 32, (f) => fsp.stat(f).catch(() => null));
    files = flat.length;
    bytes = stats.reduce((s, x) => s + (x ? x.size : 0), 0);
  }
  const json = JSON.parse(jsonText.charCodeAt(0) === 0xfeff ? jsonText.slice(1) : jsonText);
  const { counts, exts } = countContent(json);
  return {
    json,
    zipInfo,
    info: {
      kind: source.kind,
      path: source.path,
      name: path.basename(source.path),
      chat: chatInfo(json),
      messages: (json.messages || []).length,
      content: counts,
      exts,
      files,
      bytes,
      exportedAt,
    },
  };
}

module.exports = { scanSource, countContent, chatInfo, emptyContent };
