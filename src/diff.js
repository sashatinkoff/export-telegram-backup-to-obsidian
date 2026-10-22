'use strict';
// Построчное сравнение: diff двух версий, трёхстороннее слияние и модель для экрана «side by side».

const LCS_LIMIT = 6000000; // больше — считаем изменённым целиком (защита от квадратичной памяти)

// Список операций {eq, a0, a1, b0, b1}: равные блоки и блоки изменений, подряд, без пропусков.
function diffOps(a, b) {
  const n = a.length;
  const m = b.length;
  let pre = 0;
  while (pre < n && pre < m && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;

  const ops = [];
  const push = (eq, a0, a1, b0, b1) => {
    if (a0 === a1 && b0 === b1) return;
    const last = ops[ops.length - 1];
    if (last && last.eq === eq) { last.a1 = a1; last.b1 = b1; } else ops.push({ eq, a0, a1, b0, b1 });
  };

  push(true, 0, pre, 0, pre);
  const an = n - pre - suf;
  const bn = m - pre - suf;
  if (an || bn) {
    if (an === 0 || bn === 0 || an * bn > LCS_LIMIT) {
      push(false, pre, pre + an, pre, pre + bn);
    } else {
      const w = bn + 1;
      const dp = new Uint32Array((an + 1) * w);
      for (let i = an - 1; i >= 0; i--) {
        for (let j = bn - 1; j >= 0; j--) {
          dp[i * w + j] = a[pre + i] === b[pre + j]
            ? dp[(i + 1) * w + j + 1] + 1
            : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      while (i < an || j < bn) {
        if (i < an && j < bn && a[pre + i] === b[pre + j]) {
          push(true, pre + i, pre + i + 1, pre + j, pre + j + 1);
          i++; j++;
        } else if (j < bn && (i === an || dp[i * w + j + 1] >= dp[(i + 1) * w + j])) {
          push(false, pre + i, pre + i, pre + j, pre + j + 1);
          j++;
        } else {
          push(false, pre + i, pre + i + 1, pre + j, pre + j);
          i++;
        }
      }
    }
  }
  push(true, n - suf, n, m - suf, m);
  return ops;
}

const sameSeq = (x, y) => x.length === y.length && x.every((v, k) => v === y[k]);

// Изменения other относительно base: {s, e, lines} — «заменить base[s:e] на lines»
function hunksOf(baseKeys, otherKeys, otherLines, side) {
  return diffOps(baseKeys, otherKeys)
    .filter((op) => !op.eq)
    .map((op) => ({ s: op.a0, e: op.a1, lines: otherLines.slice(op.b0, op.b1), side }));
}

// Трёхстороннее слияние (как в git): base — исходная версия, ours — ваша, theirs — новая из Telegram.
// Строки сравниваются по keyFn (чтобы «невидимые» отличия не давали конфликтов).
// Возвращает { conflict: false, lines } или { conflict: true, lines: null }.
function merge3(base, ours, theirs, keyFn) {
  const bk = base.map(keyFn);
  const all = hunksOf(bk, ours.map(keyFn), ours, 'o')
    .concat(hunksOf(bk, theirs.map(keyFn), theirs, 't'))
    .sort((x, y) => x.s - y.s || x.e - y.e);

  const apply = (hunks, gs, ge) => {
    let result = [];
    let cursor = gs;
    for (const h of hunks) {
      result = result.concat(base.slice(cursor, h.s), h.lines);
      cursor = h.e;
    }
    return result.concat(base.slice(cursor, ge));
  };

  let out = [];
  let pos = 0;
  let i = 0;
  while (i < all.length) {
    const gs = all[i].s;
    let ge = all[i].e;
    const group = [all[i++]];
    while (i < all.length && all[i].s <= ge) { // пересекающиеся и соприкасающиеся правки — одна группа
      ge = Math.max(ge, all[i].e);
      group.push(all[i++]);
    }

    out = out.concat(base.slice(pos, gs));
    pos = ge;

    const baseKeys = base.slice(gs, ge).map(keyFn);
    const a = apply(group.filter((h) => h.side === 'o'), gs, ge);
    const b = apply(group.filter((h) => h.side === 't'), gs, ge);
    const ka = a.map(keyFn);
    const kb = b.map(keyFn);

    if (sameSeq(ka, kb) || sameSeq(kb, baseKeys)) out = out.concat(a);
    else if (sameSeq(ka, baseKeys)) out = out.concat(b);
    else return { conflict: true, lines: null };
  }
  return { conflict: false, lines: out.concat(base.slice(pos)) };
}

// ---------- внутристрочная подсветка (для экрана сравнения) ----------

// Делит две строки на куски {text, changed}: общее начало и конец остаются как есть, середина подсвечивается.
// Если строки почти не похожи, подсвечивать нечего — возвращаем null (строка закрашивается целиком).
function inlineDiff(a, b) {
  let pre = 0;
  const max = Math.min(a.length, b.length);
  while (pre < max && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < max - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  if (pre + suf < 0.4 * max) return null;
  const cut = (s) => [
    { text: s.slice(0, pre), changed: false },
    { text: s.slice(pre, s.length - suf), changed: true },
    { text: s.slice(s.length - suf), changed: false },
  ].filter((p) => p.text);
  return { a: cut(a), b: cut(b) };
}

// ---------- модель для экрана «side by side» ----------

// Превращает ops в блоки для отрисовки. Номера строк — номера строк файла (offset — строк до текста).
//   { type: 'eq', rows: [{ aNo, bNo, a, b }], hidden } — равные строки; длинные серии сворачиваются
//   { type: 'hunk', index, a0, a1, b0, b1, aFrom, aTo, bFrom, bTo, rows: [{ aNo?, bNo?, a?, b?, inline? }] }
function buildBlocks(ops, aLines, bLines, aOffset, bOffset, options = {}) {
  const context = options.context ?? 3;
  const blocks = [];
  let hunkIndex = 0;

  ops.forEach((op, k) => {
    if (op.eq) {
      const rows = [];
      for (let i = 0; i < op.a1 - op.a0; i++) {
        rows.push({ aNo: aOffset + op.a0 + i + 1, bNo: bOffset + op.b0 + i + 1, a: aLines[op.a0 + i], b: bLines[op.b0 + i] });
      }
      const first = k === 0;
      const last = k === ops.length - 1;
      const keepHead = first ? 0 : context;
      const keepTail = last ? 0 : context;
      if (rows.length > keepHead + keepTail + 1) {
        blocks.push({
          type: 'eq',
          head: rows.slice(0, keepHead),
          hidden: rows.slice(keepHead, rows.length - keepTail),
          tail: rows.slice(rows.length - keepTail),
        });
      } else {
        blocks.push({ type: 'eq', head: rows, hidden: [], tail: [] });
      }
      return;
    }

    const la = op.a1 - op.a0;
    const lb = op.b1 - op.b0;
    const rows = [];
    for (let i = 0; i < Math.max(la, lb); i++) {
      const row = {};
      if (i < la) { row.aNo = aOffset + op.a0 + i + 1; row.a = aLines[op.a0 + i]; }
      if (i < lb) { row.bNo = bOffset + op.b0 + i + 1; row.b = bLines[op.b0 + i]; }
      if (i < la && i < lb) row.inline = inlineDiff(row.a, row.b);
      rows.push(row);
    }
    blocks.push({
      type: 'hunk',
      index: hunkIndex++,
      a0: op.a0, a1: op.a1, b0: op.b0, b1: op.b1,
      aFrom: la ? aOffset + op.a0 + 1 : null, aTo: la ? aOffset + op.a1 : null,
      bFrom: lb ? bOffset + op.b0 + 1 : null, bTo: lb ? bOffset + op.b1 : null,
      aAt: aOffset + op.a0, bAt: bOffset + op.b0,
      rows,
    });
  });
  return blocks;
}

module.exports = { diffOps, merge3, inlineDiff, buildBlocks, sameSeq };
