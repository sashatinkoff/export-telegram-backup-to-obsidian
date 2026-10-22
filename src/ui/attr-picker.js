'use strict';
// Поле со списком «чипов» и подсказками: ключи YAML-атрибутов из хранилища.
const BASE_KEYS = ['Date', 'tags', 'cssclasses', 'aliases', 'rating', 'status'];
const LIMIT = 8;

// Ключи frontmatter из кэша Obsidian: считаем, в скольких заметках встречается каждый
function vaultAttrKeys(app) {
  const counts = new Map();
  const cache = app && app.metadataCache;
  const files = app && app.vault && app.vault.getMarkdownFiles ? app.vault.getMarkdownFiles() : [];
  if (cache && cache.getFileCache) {
    for (const f of files) {
      const fm = (cache.getFileCache(f) || {}).frontmatter;
      if (!fm) continue;
      for (const k of Object.keys(fm)) if (k !== 'position') counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  for (const k of BASE_KEYS) if (!counts.has(k)) counts.set(k, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => ({ key: k, count: n }));
}

function renderAttrPicker(el, { app, values, onChange }) {
  let list = values.slice();
  let all = null; // ленивая загрузка: обход кэша только при первом фокусе
  let active = -1;
  let shown = [];

  const box = el.createDiv({ cls: 'tgi-attrbox' });
  const chips = box.createDiv({ cls: 'tgi-chips' });
  const input = chips.createEl('input', { cls: 'tgi-attr-input', type: 'text', attr: { placeholder: 'Добавить атрибут…', 'aria-label': 'Игнорируемые атрибуты', autocomplete: 'off', spellcheck: 'false' } });
  const pop = box.createDiv({ cls: 'tgi-suggest' });
  pop.style.display = 'none';

  const commit = () => onChange(list.slice());
  const has = (k) => list.some((x) => x.toLowerCase() === k.toLowerCase());
  const add = (raw) => {
    const k = String(raw).trim().replace(/[,:]+$/, '').trim();
    if (!k || has(k)) { input.value = ''; hide(); return; }
    list.push(k);
    input.value = '';
    paintChips();
    hide();
    commit();
  };
  const remove = (k) => { list = list.filter((x) => x !== k); paintChips(); commit(); };

  function paintChips() {
    for (const c of Array.from(chips.querySelectorAll('.tgi-achip'))) c.remove();
    for (const k of list) {
      const chip = chips.createSpan({ cls: 'tgi-achip' });
      chip.createSpan({ cls: 'tgi-mono', text: k });
      const x = chip.createEl('button', { cls: 'tgi-achip-x', text: '×', attr: { title: 'Убрать', 'aria-label': `Убрать ${k}`, type: 'button' } });
      x.addEventListener('click', (e) => { e.preventDefault(); remove(k); input.focus(); });
      chips.insertBefore(chip, input);
    }
  }

  function hide() { pop.style.display = 'none'; active = -1; shown = []; }
  function show() {
    if (!all) all = vaultAttrKeys(app);
    const q = input.value.trim().toLowerCase();
    shown = all.filter((o) => !has(o.key) && (!q || o.key.toLowerCase().includes(q)))
      .sort((a, b) => (b.key.toLowerCase().startsWith(q) ? 1 : 0) - (a.key.toLowerCase().startsWith(q) ? 1 : 0))
      .slice(0, LIMIT);
    pop.empty();
    if (!shown.length && !q) { hide(); return; }
    shown.forEach((o, i) => {
      const row = pop.createDiv({ cls: `tgi-suggest-row${i === active ? ' is-active' : ''}` });
      row.createSpan({ cls: 'tgi-mono', text: o.key });
      if (o.count) row.createSpan({ cls: 'tgi-faint', text: `${o.count} зам.` });
      row.addEventListener('mousedown', (e) => { e.preventDefault(); add(o.key); });
    });
    if (q && !shown.some((o) => o.key.toLowerCase() === q) && !has(q)) {
      const row = pop.createDiv({ cls: 'tgi-suggest-row tgi-suggest-new' });
      row.createSpan({ text: `Добавить «${input.value.trim()}»` });
      row.addEventListener('mousedown', (e) => { e.preventDefault(); add(input.value); });
    }
    pop.style.display = pop.childElementCount ? '' : 'none';
  }

  input.addEventListener('focus', show);
  input.addEventListener('input', () => { active = -1; show(); });
  input.addEventListener('blur', () => { if (input.value.trim()) add(input.value); else hide(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!shown.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      show();
    } else if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(active >= 0 && shown[active] ? shown[active].key : input.value);
    } else if (e.key === 'Backspace' && !input.value && list.length) {
      remove(list[list.length - 1]);
    } else if (e.key === 'Escape') hide();
  });
  chips.addEventListener('click', () => input.focus());
  paintChips();
  return box;
}

module.exports = { renderAttrPicker, vaultAttrKeys };
