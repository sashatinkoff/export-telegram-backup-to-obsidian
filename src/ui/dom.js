'use strict';
// Мелкие помощники для разметки (используют методы DOM, которые добавляет Obsidian).
const { setIcon } = require('obsidian');

// Создаёт элемент: tag.cls с текстом
function h(parent, tag, cls, text) {
  const o = {};
  if (cls) o.cls = cls;
  if (text !== undefined && text !== null) o.text = String(text);
  return parent.createEl(tag, o);
}

// Иконка Lucide
function icon(parent, name, cls) {
  const s = parent.createSpan({ cls: `tgi-ico${cls ? ` ${cls}` : ''}` });
  setIcon(s, name);
  return s;
}

// Кнопка с иконкой и подписью
function button(parent, { label, ico, cls, title, onClick, disabled }) {
  const b = parent.createEl('button', { cls: `tgi-btn${cls ? ` ${cls}` : ''}`, attr: title ? { title, 'aria-label': title } : {} });
  if (ico) icon(b, ico);
  if (label) b.createSpan({ text: label });
  if (disabled) b.disabled = true;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// Переключатель-квадрат из макетов (чекбокс)
function checkbox(parent, checked, onChange, disabled) {
  const b = parent.createEl('button', { cls: 'tgi-check', attr: { role: 'checkbox', 'aria-checked': String(!!checked) } });
  if (checked) b.addClass('is-on');
  if (disabled) b.disabled = true;
  icon(b, 'check');
  b.addEventListener('click', () => {
    if (b.disabled) return;
    const next = !b.hasClass('is-on');
    b.toggleClass('is-on', next);
    b.setAttribute('aria-checked', String(next));
    onChange(next);
  });
  return b;
}

// Строка «ключ — значение» с моноширинными подписями
function meta(parent, label, value, cls) {
  const row = parent.createDiv({ cls: 'tgi-meta' });
  row.createSpan({ cls: 'tgi-meta-k', text: label });
  row.createSpan({ cls: `tgi-meta-v${cls ? ` ${cls}` : ''}`, text: value });
  return row;
}

// Копирование текста в буфер обмена: сначала современный API, затем запасной вариант через временное поле
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.body.createEl('textarea');
      ta.value = text;
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e2) { return false; }
  }
}

module.exports = {
  copyText, h, icon, button, checkbox, meta };
