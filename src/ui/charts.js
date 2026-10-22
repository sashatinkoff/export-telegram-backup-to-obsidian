'use strict';
// Простые SVG-диаграммы для вкладки истории (без библиотек).

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// «Красивый» верх шкалы: 8420 -> 10000, 130 -> 150
function niceMax(v) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}

const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '')}k` : String(n));

// months: [{ label, text, media, peak }]
function barChart(months) {
  const W = 760;
  const H = 230;
  const L = 44;
  const T = 24;
  const B = 28;
  const plotH = H - T - B;
  const max = niceMax(Math.max(1, ...months.map((m) => Math.max(m.text, m.media))));
  const y = (v) => T + plotH - (plotH * v) / max;
  const step = (W - L - 8) / months.length;
  const bw = Math.min(26, step / 3.2);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="tgi-svg" role="img" aria-label="Активность импорта по месяцам" preserveAspectRatio="xMidYMid meet">`;
  for (let i = 0; i <= 3; i++) {
    const v = (max * i) / 3;
    svg += `<line x1="${L}" x2="${W - 8}" y1="${y(v)}" y2="${y(v)}" class="tgi-grid"/>`;
    svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="tgi-axis">${short(Math.round(v))}</text>`;
  }
  months.forEach((m, i) => {
    const cx = L + step * i + step / 2;
    const isPeak = m.peak && m.text > 0;
    svg += `<g><title>${esc(m.label)}: заметок ${m.text}, файлов ${m.media}</title>`;
    svg += `<rect x="${cx - bw - 2}" y="${y(m.text)}" width="${bw}" height="${plotH - (y(m.text) - T)}" rx="3" class="${isPeak ? 'tgi-bar-peak' : 'tgi-bar-text'}"/>`;
    svg += `<rect x="${cx + 2}" y="${y(m.media)}" width="${bw}" height="${plotH - (y(m.media) - T)}" rx="3" class="tgi-bar-media"/>`;
    svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="${isPeak ? 'tgi-axis tgi-axis-peak' : 'tgi-axis'}">${esc(m.label)}${isPeak ? ' *' : ''}</text></g>`;
    if (isPeak) svg += `<text x="${cx - bw / 2}" y="${y(m.text) - 8}" text-anchor="middle" class="tgi-axis tgi-axis-peak">MAX ${m.text}</text>`;
  });
  return `${svg}</svg>`;
}

// parts: [{ value, cls }] -> кольцо; центр: большая подпись и малая
function donut(parts, big, small) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const R = 62;
  const C = 2 * Math.PI * R;
  let off = 0;
  let svg = '<svg viewBox="0 0 160 160" class="tgi-svg tgi-donut" role="img" aria-label="Типы контента">';
  svg += `<circle cx="80" cy="80" r="${R}" class="tgi-donut-bg" fill="none" stroke-width="16"/>`;
  if (total > 0) {
    for (const p of parts) {
      if (!p.value) continue;
      const len = (C * p.value) / total;
      svg += `<circle cx="80" cy="80" r="${R}" fill="none" stroke-width="16" class="${p.cls}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 80 80)"/>`;
      off += len;
    }
  }
  svg += `<text x="80" y="82" text-anchor="middle" class="tgi-donut-big">${esc(big)}</text><text x="80" y="100" text-anchor="middle" class="tgi-axis">${esc(small)}</text></svg>`;
  return svg;
}

module.exports = { barChart, donut, niceMax };
