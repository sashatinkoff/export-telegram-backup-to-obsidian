'use strict';
// Форматирование чисел, времени и склонений для интерфейса.

const nf = new Intl.NumberFormat('ru-RU');
const fmtNum = (n) => nf.format(n || 0);

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '0 с';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} с`;
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return r ? `${m} мин ${r} с` : `${m} мин`;
}

function fmtDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

const STATUS_TEXT = { ok: 'Готово', cancelled: 'Остановлено', error: 'Ошибка' };

module.exports = { fmtNum, plural, fmtDuration, fmtDateTime, fmtTime, STATUS_TEXT };

// Размер в байтах: 1,85 ГБ
function fmtBytes(n) {
  if (!n || n < 0) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2).replace('.', ',')} ${units[i]}`;
}

const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');

module.exports.fmtBytes = fmtBytes;
module.exports.fmtDate = fmtDate;
