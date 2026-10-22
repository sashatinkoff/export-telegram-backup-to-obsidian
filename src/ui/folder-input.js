'use strict';
// Текстовое поле пути к папке хранилища с подсказками: список папок берётся из хранилища.
const LIMIT = 8;

// Все папки хранилища (без корня), по алфавиту
function vaultFolders(app) {
  const v = app && app.vault;
  if (!v) return [];
  let list = [];
  if (typeof v.getAllFolders === 'function') list = v.getAllFolders(false);
  else if (typeof v.getAllLoadedFiles === 'function') list = v.getAllLoadedFiles().filter((f) => Array.isArray(f.children));
  return list.map((f) => f.path).filter((p) => p && p !== '/').sort((a, b) => a.localeCompare(b));
}

function renderFolderInput(el, { app, value, placeholder, onChange }) {
  let folders = null; // ленивая загрузка при первом фокусе
  let active = -1;
  let shown = [];

  const box = el.createDiv({ cls: 'tgi-attrbox tgi-folderbox' });
  const input = box.createEl('input', { type: 'text', cls: 'tgi-folder-input', attr: { placeholder: placeholder || '', autocomplete: 'off', spellcheck: 'false' } });
  input.value = value || '';
  const pop = box.createDiv({ cls: 'tgi-suggest' });
  pop.style.display = 'none';

  const hide = () => { pop.style.display = 'none'; active = -1; shown = []; };
  const pick = (p) => { input.value = p; hide(); onChange(p); };

  const show = () => {
    if (!folders) folders = vaultFolders(app);
    const q = input.value.trim().replace(/^\/+/, '').toLowerCase();
    const rank = (p) => { const l = p.toLowerCase(); return l.startsWith(q) ? 0 : l.split('/').pop().startsWith(q) ? 1 : 2; };
    shown = folders.filter((p) => !q || p.toLowerCase().includes(q)).sort((a, b) => rank(a) - rank(b) || a.length - b.length).slice(0, LIMIT);
    pop.empty();
    shown.forEach((p, i) => {
      const row = pop.createDiv({ cls: `tgi-suggest-row${i === active ? ' is-active' : ''}` });
      row.createSpan({ cls: 'tgi-mono', text: p });
      row.addEventListener('mousedown', (e) => { e.preventDefault(); pick(p); });
    });
    pop.style.display = shown.length ? '' : 'none';
  };

  input.addEventListener('focus', show);
  input.addEventListener('input', () => { active = -1; onChange(input.value.trim()); show(); });
  input.addEventListener('blur', hide);
  input.addEventListener('keydown', (e) => {
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      show();
    } else if (e.key === 'Enter' && active >= 0 && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') hide();
  });
  return box;
}

module.exports = { renderFolderInput, vaultFolders };
