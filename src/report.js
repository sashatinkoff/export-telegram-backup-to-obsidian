'use strict';
// Markdown-отчёт о заметках, которые нужно сравнить: какие блоки отличаются и на каких строках.
const { REASONS } = require('./constants');

const MAX_HUNKS_PER_NOTE = 30;
const MAX_NOTES_IN_DETAILS = 300;
const CELL_LIMIT = 150;

// Текст для ячейки таблицы: одна строка, без разметки (иначе ![[фото]] превратится в картинку)
function cell(lines, limit = CELL_LIMIT) {
  if (!lines.length) return '—';
  if (lines.every((l) => l.trim() === '')) return '(пустая строка)';
  let t = lines.map((l) => l.trim()).filter((l) => l !== '').join(' ↵ ');
  if (t.length > limit) t = `${t.slice(0, limit - 1)}…`;
  return t.replace(/([\\`*_{}[\]<>#|~!=])/g, '\\$1');
}

function range(from, to, at) {
  if (from === null) return `— (после строки ${at})`;
  return from === to ? String(from) : `${from}–${to}`;
}

// Краткий список диапазонов для сводной таблицы: «3–5; 9; 12»
function rangeList(hunks, side) {
  const parts = hunks.map((h) => (side === 'a' ? range(h.aFrom, h.aTo, h.aAt) : range(h.bFrom, h.bTo, h.bAt)));
  const shown = parts.slice(0, 6).join('; ');
  return parts.length > 6 ? `${shown}; … (+${parts.length - 6})` : shown;
}

const pad = (n) => String(n).padStart(2, '0');
const formatWhen = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// entries: [{ key, name, incomingName, reason, hunks: [{ aFrom, aTo, aAt, bFrom, bTo, bAt, aLines, bLines }] }]
function buildReport({ entries, when = new Date() }) {
  const out = [];
  out.push('# Конфликты импорта Telegram', '');
  out.push('Файл создаёт плагин **Telegram Import** и обновляет при каждом импорте и разборе. Ручные правки здесь будут перезаписаны.', '');
  out.push(`- Обновлено: ${formatWhen(when)}`);
  out.push(`- Заметок на сравнении: **${entries.length}**`);
  out.push('- Версия каждой заметки из Telegram лежит в этой же папке, в имени есть пометка «(Telegram)».');
  out.push('- Выбрать, какой вариант оставить, можно на экране сравнения: команда «Разобрать конфликты слияния».');
  out.push('- Номера строк — это номера строк файла так, как их видно в редакторе (шапка с атрибутами тоже считается).', '');

  out.push('## Сводка', '');
  out.push('| № | Заметка | Причина | Блоков | Строки у вас | Строки в Telegram | Версия из Telegram |');
  out.push('|---|---|---|---|---|---|---|');
  entries.forEach((e, i) => {
    out.push(`| ${i + 1} | [[${e.name}]] | ${(REASONS[e.reason] || { short: e.reason }).short} | ${e.hunks.length} | ${rangeList(e.hunks, 'a')} | ${rangeList(e.hunks, 'b')} | [[${e.incomingName}]] |`);
  });
  out.push('');

  out.push('## Подробно', '');
  entries.slice(0, MAX_NOTES_IN_DETAILS).forEach((e, i) => {
    out.push(`### ${i + 1}. [[${e.name}]]`, '');
    out.push(`- Путь: \`${e.key}\``);
    out.push(`- Версия из Telegram: [[${e.incomingName}]]`);
    out.push(`- Причина: ${(REASONS[e.reason] || { long: e.reason }).long}`, '');
    out.push('| Блок | Строки у вас | Строки в Telegram | У вас | В Telegram |');
    out.push('|---|---|---|---|---|');
    e.hunks.slice(0, MAX_HUNKS_PER_NOTE).forEach((h, k) => {
      out.push(`| ${k + 1} | ${range(h.aFrom, h.aTo, h.aAt)} | ${range(h.bFrom, h.bTo, h.bAt)} | ${cell(h.aLines)} | ${cell(h.bLines)} |`);
    });
    if (e.hunks.length > MAX_HUNKS_PER_NOTE) out.push(`| … | | | ещё блоков: ${e.hunks.length - MAX_HUNKS_PER_NOTE} | |`);
    out.push('');
  });
  if (entries.length > MAX_NOTES_IN_DETAILS) out.push(`Подробно показаны первые ${MAX_NOTES_IN_DETAILS} заметок, остальные есть в сводке.`, '');

  return `${out.join('\n')}\n`;
}

// Отчёт по истории запусков (кнопка «Экспорт отчёта в Markdown»)
function buildHistoryReport(runs, totals) {
  const when = (ts) => formatWhen(new Date(ts));
  const lines = [
    '# Отчёт об импортах Telegram',
    '',
    `- Импортов: **${totals.imports}** (успешных: ${totals.ok})`,
    `- Заметок записано: **${totals.notesWritten}**, объединено: ${totals.notesMerged}`,
    `- Файлов скопировано: **${totals.filesCopied}**`,
    '',
    '| Дата | Источник | Что | Итог | Сообщений | Записано | Объединено | Файлов | Ссылок | Конфликтов | Разрешено | Время, с |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of runs.slice().reverse()) {
    const n = r.stats.notes;
    lines.push(`| ${when(r.startedAt)} | ${cell([r.sourceName || ''])} | ${r.kind === 'links' ? 'Ссылки' : 'Импорт'} | ${r.status} | ${r.messages || ''} | ${n.written} | ${n.merged} | ${r.stats.files.copied} | ${r.stats.links.changed} | ${r.conflicts || 0} | ${r.resolved || 0} | ${Math.round(r.durationMs / 100) / 10} |`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = {
  buildHistoryReport, buildReport, cell, range, formatWhen };
