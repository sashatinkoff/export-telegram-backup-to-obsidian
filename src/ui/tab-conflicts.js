'use strict';
// Вкладка «Конфликты записей»: заметки с одинаковыми именами и разным текстом, по очереди, в три колонки:
// ваша версия, совмещённый вариант (по выбору для каждого блока) и версия из Telegram.
const { path, fsx } = require('../platform');
const { Notice } = require('obsidian');
const { REASONS } = require('../constants');
const { buildBlocks } = require('../diff');
const { recommend } = require('../review');
const { sha } = require('../util');
const { icon, button, meta, checkbox } = require('./dom');
const { fmtNum, plural, fmtDateTime } = require('./format');

const CHOICES = [['mine', 'Моё'], ['both', 'Оба'], ['theirs', 'Из Telegram']];

const shortHash = (s) => { const x = sha(s); return `sha:${x.slice(0, 6)}…${x.slice(-4)}`; };

class ConflictsTab {
  constructor(pane, plugin) {
    this.pane = pane;
    this.plugin = plugin;
    this.selected = null;
    this.analysis = null;
    this.blocks = [];
    this.choices = [];
    this.rec = [];
    this.expanded = new Set();
    this.opts = { onlyDiff: false, inline: true };
    this.token = 0;
    this.sig = null;
    this.confirmAll = false;
  }

  get review() { return this.plugin.review; }

  mount() {
    this.head = this.pane.createDiv();
    this.options = this.pane.createDiv();
    this.content = this.pane.createDiv();
  }

  show() { this.refresh(); }

  signature() { return this.review.list().map((i) => i.key).join('|'); }

  update() {
    const sig = this.signature();
    if (sig !== this.sig) this.refresh();
  }

  // ---------- выбор заметки ----------

  async refresh() {
    this.sig = this.signature();
    const items = this.review.list();
    if (!items.some((i) => i.key === this.selected)) this.selected = null;
    if (!this.selected && items.length) this.selected = items[0].key;
    await this.load();
  }

  async select(key) {
    this.selected = key;
    this.confirmAll = false;
    await this.load();
  }

  async load() {
    const token = ++this.token;
    if (!this.selected) { this.renderEmpty(); return; }
    const a = await this.review.analyze(this.selected);
    if (token !== this.token) return;
    if (!a) { await this.refresh(); return; }
    if (a.equal || a.hunkCount === 0) {
      await this.review.settle(this.selected, a.theirs, a.ours.body);
      await this.refresh();
      return;
    }
    let st = null;
    try { st = await fsx.stat(this.review.abs(this.selected)); } catch (e) { /* файл мог исчезнуть */ }
    if (token !== this.token) return;
    this.analysis = a;
    this.stat = st;
    this.blocks = buildBlocks(a.ops, a.ours.lines, a.theirs.lines, a.ours.offset, a.theirs.offset, { context: 3 });
    this.rec = recommend(a.ops);
    this.choices = this.rec.slice();
    this.expanded = new Set();
    this.render();
  }

  // ---------- отрисовка ----------

  renderEmpty() {
    this.head.empty();
    this.options.empty();
    this.content.empty();
    const box = this.content.createDiv({ cls: 'tgi-card tgi-emptystate' });
    const ic = box.createDiv({ cls: 'tgi-emptyicon' });
    icon(ic, 'check-circle-2');
    box.createEl('h3', { text: 'Конфликтов нет' });
    box.createDiv({ cls: 'tgi-muted', text: 'Все заметки с одинаковыми названиями совпадают по содержимому или уже разобраны.' });
    const row = box.createDiv({ cls: 'tgi-row' });
    button(row, { label: 'К истории импортов', cls: 'tgi-btn-primary', onClick: () => this.plugin.openTab('history') });
    button(row, { label: 'Новый импорт', cls: 'tgi-btn-outline', onClick: () => this.plugin.openTab('import') });
  }

  render() {
    this.renderHead();
    this.renderOptions();
    this.renderColumns();
  }

  renderHead() {
    const a = this.analysis;
    const items = this.review.list();
    const pos = items.findIndex((i) => i.key === this.selected);
    const c = this.head;
    c.empty();
    const card = c.createDiv({ cls: 'tgi-card tgi-conf-head' });

    const lead = card.createDiv({ cls: 'tgi-conf-lead' });
    const ic = lead.createDiv({ cls: 'tgi-conflict-icon' });
    icon(ic, 'git-merge');
    const tt = lead.createDiv();
    tt.createEl('h2', { text: `Обнаружено ${fmtNum(items.length)} ${plural(items.length, 'конфликт', 'конфликта', 'конфликтов')}` });
    const sub = tt.createDiv({ cls: 'tgi-sub' });
    sub.createSpan({ cls: 'tgi-dot is-warn' });
    sub.createSpan({ text: `Версии из Telegram лежат в папке ${this.review.folderRel()}. Выберите вариант для каждой заметки.` });

    const mid = card.createDiv({ cls: 'tgi-conf-mid' });
    mid.createSpan({ cls: 'tgi-notechip tgi-mono', text: `Заметка ${pos + 1} из ${items.length}: ${path.basename(a.item.key, '.md')}`, attr: { title: a.item.key } });
    const reason = REASONS[a.item.reason];

    const right = card.createDiv({ cls: 'tgi-conf-right' });
    const prog = right.createDiv({ cls: 'tgi-progdots' });
    prog.createSpan({ cls: 'tgi-mono tgi-small tgi-muted', text: 'Прогресс:' });
    if (items.length <= 12) {
      items.forEach((it, i) => {
        const d = prog.createEl('button', { cls: `tgi-pdot${i === pos ? ' is-on' : ''}`, attr: { title: path.basename(it.key, '.md'), 'aria-label': `Заметка ${i + 1}` } });
        d.addEventListener('click', () => this.select(it.key));
      });
    } else prog.createSpan({ cls: 'tgi-mono tgi-small', text: `${pos + 1} / ${items.length}` });
    const nav = right.createDiv({ cls: 'tgi-row' });
    button(nav, { label: 'Предыдущий', ico: 'arrow-left', cls: 'tgi-btn-outline', disabled: items.length < 2, onClick: () => this.step(-1) });
    button(nav, { label: 'Следующий', ico: 'arrow-right', cls: 'tgi-btn-outline', disabled: items.length < 2, onClick: () => this.step(1) });
    const row2 = right.createDiv({ cls: 'tgi-row' });
    button(row2, { ico: 'file-text', title: 'Открыть заметку', cls: 'tgi-btn-outline', onClick: () => this.plugin.openNote(a.item.key) });
    button(row2, { ico: 'table', title: 'Открыть отчёт о конфликтах', cls: 'tgi-btn-outline', onClick: () => this.plugin.openReport() });
    this.allBtn = button(row2, { label: 'Применить ко всем оставшимся', ico: 'check-check', cls: 'tgi-btn-outline', onClick: () => this.applyAllRemaining() });
    if (reason) card.createDiv({ cls: 'tgi-conf-reason', text: reason.long });
  }

  renderOptions() {
    const o = this.options;
    o.empty();
    const bar = o.createDiv({ cls: 'tgi-optbar' });
    bar.createSpan({ cls: 'tgi-eyebrow', text: 'ПАРАМЕТРЫ ИНСПЕКТОРА:' });
    const opt = (label, key) => {
      const l = bar.createDiv({ cls: 'tgi-opt' });
      checkbox(l, this.opts[key], (v) => { this.opts[key] = v; this.renderColumns(); });
      l.createSpan({ text: label });
    };
    opt('Только различия', 'onlyDiff');
    opt('Подсветка изменений внутри строк', 'inline');
    const legend = bar.createDiv({ cls: 'tgi-legend' });
    for (const [cls, text] of [['is-local', 'Локальные изменения'], ['is-merge', 'Совмещённый результат'], ['is-tg', 'Новые данные Telegram']]) {
      const i = legend.createSpan({ cls: 'tgi-legend-i' });
      i.createSpan({ cls: `tgi-dot ${cls}` });
      i.createSpan({ text });
    }
  }

  // ---------- три колонки ----------

  stats() {
    const a = this.analysis;
    const hunks = a.ops.filter((o) => !o.eq);
    let fromTg = 0;
    let kept = 0;
    let replaced = 0;
    hunks.forEach((op, i) => {
      const c = this.choices[i];
      const la = op.a1 - op.a0;
      const lb = op.b1 - op.b0;
      if (c !== 'mine') fromTg += lb;
      if (c !== 'theirs') kept += la;
      if (la && lb) replaced++;
    });
    return { fromTg, kept, replaced };
  }

  renderColumns() {
    if (!this.analysis) return;
    const a = this.analysis;
    const c = this.content;
    c.empty();
    const st = this.stats();

    const heads = c.createDiv({ cls: 'tgi-tri tgi-tri-heads' });
    const mk = (cls) => heads.createDiv({ cls: `tgi-card tgi-colhead ${cls}` });

    const left = mk('');
    const lt = left.createDiv({ cls: 'tgi-coltitle' });
    icon(lt, 'folder-open');
    lt.createSpan({ text: 'Текущая заметка в Obsidian' });
    lt.createSpan({ cls: 'tgi-chip tgi-chip-mono', text: 'Хранилище' });
    button(left, { label: 'Использовать текущую', ico: 'pin', cls: 'tgi-btn-outline tgi-btn-block', onClick: () => this.apply('mine') });
    const lm = left.createDiv({ cls: 'tgi-metas' });
    meta(lm, 'Файл:', path.basename(a.item.key));
    meta(lm, 'Обновлено:', this.stat ? fmtDateTime(this.stat.mtimeMs) : '—');
    meta(lm, 'Хеш текста:', shortHash(a.ours.key));

    const midc = mk('is-merged');
    const mt = midc.createDiv({ cls: 'tgi-coltitle' });
    icon(mt, 'git-merge');
    mt.createSpan({ text: 'Совмещённый вариант' });
    mt.createSpan({ cls: 'tgi-chip tgi-chip-yellow', text: 'Рекомендуется' });
    button(midc, { label: 'Использовать совмещённую', ico: 'check-circle-2', cls: 'tgi-btn-danger tgi-btn-block', onClick: () => this.apply('choices') });
    const mm = midc.createDiv({ cls: 'tgi-metas' });
    meta(mm, 'Стратегия:', 'сохранить ваши правки, добавить новое из Telegram', 'tgi-accent-y');
    meta(mm, 'Изменения:', `+${st.fromTg} строк из Telegram, ${st.kept} ваших сохранено`);
    meta(mm, 'Конфликт строк:', st.replaced ? `в ${st.replaced} ${plural(st.replaced, 'месте', 'местах', 'местах')} правили оба, выбор ниже` : 'автоматически разрешено без потерь', st.replaced ? 'tgi-bad-soft' : 'tgi-accent-y');

    const right = mk('');
    const rt = right.createDiv({ cls: 'tgi-coltitle' });
    icon(rt, 'send');
    rt.createSpan({ text: 'Новая версия из Telegram' });
    rt.createSpan({ cls: 'tgi-chip tgi-chip-teal', text: 'Telegram' });
    button(right, { label: 'Использовать новую', ico: 'download', cls: 'tgi-btn-outline tgi-btn-block', onClick: () => this.apply('theirs') });
    const rm = right.createDiv({ cls: 'tgi-metas' });
    meta(rm, 'Файл:', path.basename(a.item.incoming));
    const date = /^Date:\s*(.+)$/m.exec(a.theirs.header || '');
    meta(rm, 'Дата в шапке:', date ? date[1].trim() : '—');
    meta(rm, 'Хеш текста:', shortHash(a.theirs.key));

    const diff = c.createDiv({ cls: 'tgi-tri tgi-tridiff' });
    this.hunkEls = [];
    this.blocks.forEach((b, i) => this.renderBlock(diff, b, i));
  }

  renderBlock(diff, block, idx) {
    if (block.type === 'eq') {
      if (!this.opts.onlyDiff) {
        for (const r of block.head) this.eqRow(diff, r);
        if (block.hidden.length) {
          const open = this.expanded.has(idx);
          const f = diff.createDiv({ cls: 'tgi-fold' });
          f.setText(open ? 'Свернуть неизменённые строки' : `Показать неизменённые строки: ${fmtNum(block.hidden.length)}`);
          f.addEventListener('click', () => { if (open) this.expanded.delete(idx); else this.expanded.add(idx); this.renderColumns(); });
          if (open) for (const r of block.hidden) this.eqRow(diff, r);
        }
        for (const r of block.tail) this.eqRow(diff, r);
      }
      return;
    }

    const op = this.analysis.ops.filter((o) => !o.eq)[block.index];
    const bar = diff.createDiv({ cls: 'tgi-hunkbar' });
    bar.createSpan({ cls: 'tgi-hunk-title', text: `Отличие ${block.index + 1} из ${this.analysis.hunkCount}` });
    bar.createSpan({ cls: 'tgi-muted tgi-small', text: this.rangeText(block) });
    if (this.rec[block.index] !== undefined) bar.createSpan({ cls: 'tgi-muted tgi-small', text: `рекомендовано: ${this.rec[block.index] === 'theirs' ? 'из Telegram' : 'моё'}` });
    const pick = bar.createDiv({ cls: 'tgi-segmini' });
    for (const [value, label] of CHOICES) {
      const b = pick.createEl('button', { cls: `tgi-segmini-btn${this.choices[block.index] === value ? ' is-on' : ''}`, text: label });
      b.addEventListener('click', () => { this.choices[block.index] = value; this.renderColumns(); });
    }

    const mine = this.analysis.ours.lines.slice(op.a0, op.a1);
    const theirs = this.analysis.theirs.lines.slice(op.b0, op.b1);
    const choice = this.choices[block.index];
    const mid = [];
    if (choice !== 'theirs') mine.forEach((t) => mid.push({ t, from: 'local' }));
    if (choice !== 'mine') theirs.forEach((t) => mid.push({ t, from: 'tg' }));
    const n = Math.max(block.rows.length, mid.length);
    for (let i = 0; i < n; i++) {
      const r = block.rows[i] || {};
      const m = mid[i];
      const row = diff.createDiv({ cls: 'tgi-trirow is-change' });
      this.cell(row, r.aNo, r.a, 'local', this.opts.inline && r.inline ? r.inline.a : null);
      this.cell(row, undefined, m ? m.t : undefined, m ? `merge-${m.from}` : 'void', null);
      this.cell(row, r.bNo, r.b, 'tg', this.opts.inline && r.inline ? r.inline.b : null);
    }
  }

  eqRow(diff, r) {
    const row = diff.createDiv({ cls: 'tgi-trirow' });
    this.cell(row, r.aNo, r.a, 'eq', null);
    this.cell(row, undefined, r.a, 'eq', null);
    this.cell(row, r.bNo, r.b, 'eq', null);
  }

  cell(row, no, text, kind, parts) {
    const cell = row.createDiv({ cls: `tgi-tcell is-${kind}${text === undefined ? ' is-void' : ''}` });
    cell.createSpan({ cls: 'tgi-no', text: no === undefined ? '' : String(no) });
    const body = cell.createSpan({ cls: 'tgi-text' });
    if (text === undefined) return;
    if (parts) for (const p of parts) body.createSpan({ cls: p.changed ? 'tgi-mark' : '', text: p.text });
    else body.setText(text === '' ? ' ' : text);
  }

  rangeText(b) {
    const r = (from, to) => (from === null ? 'нет строк' : from === to ? `строка ${from}` : `строки ${from}-${to}`);
    return `у вас: ${r(b.aFrom, b.aTo)} · в Telegram: ${r(b.bFrom, b.bTo)}`;
  }

  // ---------- действия ----------

  next(key) {
    const items = this.review.list();
    const i = items.findIndex((x) => x.key === key);
    const order = items.slice(i + 1).concat(items.slice(0, i));
    return order.length ? order[0].key : null;
  }

  step(delta) {
    const items = this.review.list();
    const i = items.findIndex((x) => x.key === this.selected);
    this.select(items[(i + delta + items.length) % items.length].key);
  }

  async apply(mode) {
    const key = this.selected;
    const next = this.next(key);
    const n = this.analysis.hunkCount;
    const choices = mode === 'mine' ? new Array(n).fill('mine') : mode === 'theirs' ? new Array(n).fill('theirs') : this.choices.slice();
    try {
      const res = await this.review.applyChoices(key, choices);
      if (res.status === 'applied' && res.wrote) new Notice('Telegram: заметка обновлена');
    } catch (e) {
      console.error('[telegram-import]', e);
      new Notice(`Telegram: не удалось применить\n${e.message || e}`);
      return;
    }
    this.selected = next;
    await this.refresh();
  }

  // Рекомендуемый вариант для всех оставшихся заметок (два нажатия: подтверждение)
  async applyAllRemaining() {
    const items = this.review.list();
    if (!this.confirmAll) {
      this.confirmAll = true;
      this.allBtn.setText(`Точно применить к ${items.length}?`);
      setTimeout(() => { if (this.confirmAll) { this.confirmAll = false; if (this.allBtn) this.allBtn.setText('Применить ко всем оставшимся'); } }, 4000);
      return;
    }
    this.confirmAll = false;
    this.allBtn.disabled = true;
    let done = 0;
    for (const it of items) {
      const a = await this.review.analyze(it.key);
      if (!a) continue;
      await this.review.applyChoices(it.key, recommend(a.ops));
      done++;
      this.allBtn.setText(`Применено ${done} из ${items.length}`);
    }
    new Notice(`Telegram: применён совмещённый вариант к ${done} ${plural(done, 'заметке', 'заметкам', 'заметкам')}`);
    this.selected = null;
    await this.refresh();
  }
}

module.exports = { ConflictsTab };
