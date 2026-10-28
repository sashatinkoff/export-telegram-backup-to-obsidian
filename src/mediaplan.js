'use strict';
// Раскладка медиа: по каким папкам и под какими именами класть файлы архива.
// Возвращает Map «путь в архиве (как в result.json) -> относительный путь в папке назначения».
const { parseDate } = require('./util');
const { plannedExt } = require('./imageconv');

const LAYOUTS = ['keep', 'year', 'year-rename'];

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

// Папка типа медиа по первой папке пути в архиве (photos, video_files, ...): из настройки mediaFolders; неизвестные типы остаются как есть
function typeFolder(dir, folders) {
  const top = dir.split('/')[0];
  if (!top) return '';
  const v = folders && Object.prototype.hasOwnProperty.call(folders, top) ? folders[top] : top;
  return String(v === undefined || v === null ? top : v).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function planMedia(posts, { layout = 'keep', root = '', convert = null, folders = null } = {}) {
  const plan = new Map();
  if (layout === 'keep' && !convert) return plan;
  const rootPart = String(root || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  for (const post of posts) {
    const dt = parseDate(post.date);
    const stem = post.fileName.replace(/\.md$/i, '').replace(' ', '_'); // как в Media Organizer: 2026-10-03_09-46-36_001
    let n = 0;
    for (const src of post.media || []) {
      if (plan.has(src)) continue;
      n++;
      const slash = src.lastIndexOf('/');
      const dir = slash >= 0 ? src.slice(0, slash) : '';
      const base = slash >= 0 ? src.slice(slash + 1) : src;
      const newExt = plannedExt(src, convert);
      let name = base;
      if (layout === 'year-rename') name = `${stem}_${String(n).padStart(3, '0')}${extOf(base)}`;
      if (newExt) name = name.slice(0, name.length - extOf(name).length) + newExt;
      const folder = layout === 'keep' ? dir : (folders ? [rootPart, typeFolder(dir, folders), String(dt.y)] : [rootPart, String(dt.y)]).filter(Boolean).join('/');
      plan.set(src, folder ? `${folder}/${name}` : name);
    }
  }
  return plan;
}

module.exports = { planMedia, LAYOUTS };
