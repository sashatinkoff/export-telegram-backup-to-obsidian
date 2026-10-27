'use strict';
// Редактор своих атрибутов для новых заметок: строки «имя — значение». Несколько строк в значении дают список.
const { vaultAttrKeys } = require('./attr-picker');

function renderCustomAttrs(el, { app, values, onChange }) {
  let rows = values.map((r) => ({ name: String(r.name || ''), value: String(r.value || '') }));
  const box = el.createDiv({ cls: 'tgi-cattrs' });
  const listId = `tgi-ca-${Math.random().toString(36).slice(2, 8)}`;
  const dl = box.createEl('datalist', { attr: { id: listId } });
  let loaded = false;
  const loadKeys = () => {
    if (loaded) return;
    loaded = true;
    for (const { key } of vaultAttrKeys(app).slice(0, 40)) dl.createEl('option', { attr: { value: key } });
  };
  const body = box.createDiv();
  const commit = () => onChange(rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), value: r.value })));

  function paint() {
    body.empty();
    rows.forEach((row, i) => {
      const line = body.createDiv({ cls: 'tgi-cattr' });
      const name = line.createEl('input', { cls: 'tgi-cattr-name', type: 'text', value: row.name, attr: { placeholder: 'Атрибут', list: listId, 'aria-label': 'Имя атрибута', autocomplete: 'off', spellcheck: 'false' } });
      const value = line.createEl('textarea', { cls: 'tgi-cattr-value', attr: { rows: String(Math.max(1, row.value.split('\n').length)), placeholder: 'Значение (каждая строка — элемент списка)', 'aria-label': 'Значение' } });
      value.value = row.value;
      const del = line.createEl('button', { cls: 'tgi-achip-x tgi-cattr-del', text: '×', attr: { type: 'button', title: 'Убрать', 'aria-label': 'Убрать атрибут' } });
      name.addEventListener('focus', loadKeys);
      name.addEventListener('input', () => { row.name = name.value; commit(); });
      value.addEventListener('input', () => { row.value = value.value; value.rows = Math.max(1, value.value.split('\n').length); commit(); });
      del.addEventListener('click', (e) => { e.preventDefault(); rows.splice(i, 1); paint(); commit(); });
    });
  }
  paint();
  const add = box.createEl('button', { cls: 'tgi-cattr-add', text: '+ Добавить атрибут', attr: { type: 'button' } });
  add.addEventListener('click', (e) => { e.preventDefault(); rows.push({ name: '', value: '' }); paint(); const last = body.querySelector('.tgi-cattr:last-child .tgi-cattr-name'); if (last) last.focus(); });
}

module.exports = { renderCustomAttrs };
