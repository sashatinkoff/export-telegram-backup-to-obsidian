'use strict';
// Вкладка «История и инфографика»: итоги, активность по месяцам, типы контента, топ чатов и журнал сессий.
const { icon, button } = require('./dom');
const { targetRel } = require('../util');
const { barChart, donut } = require('./charts');
const { fmtNum, plural, fmtDuration, fmtBytes, fmtDateTime } = require('./format');

const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
const DAY = 86400000;
const STATUS = { ok: ['Успешно', 'tgi-chip-teal'], cancelled: ['Остановлено', 'tgi-chip-yellow'], error: ['Ошибка', 'tgi-chip-red'] };
const FILTERS = [['all', 'Все'], ['ok', 'Успешные'], ['cancelled', 'Остановленные'], ['error', 'С ошибкой']];

class HistoryTab {
  constructor(pane, plugin) {
    this.pane = pane;
    this.plugin = plugin;
    this.filter = 'all';
    this.limit = 5;
    this.openLog = new Set();
    this.sig = null;
    this.confirmClear = false;
  }

  mount() {
    this.root = this.pane.createDiv();
    this.render();
  }

  show() { this.render(); }

  signature() {
    const runs = this.plugin.history.runs;
    const last = runs[runs.length - 1];
    return `${runs.length}|${last ? `${last.id}|${last.resolved || 0}` : ''}|${this.plugin.state.running}`;
  }

  update() {
    if (this.signature() !== this.sig) this.render();
  }

  // ---------- вычисления ----------

  compute() {
    const runs = this.plugin.history.runs;
    const imports = runs.filter((r) => r.kind === 'import');
    const now = Date.now();
    const sum = (list, f) => list.reduce((s, r) => s + (f(r) || 0), 0);
    const notesOf = (r) => r.stats.notes.written + r.stats.notes.merged;
    const total = sum(imports, notesOf);
    const month = sum(imports.filter((r) => now - r.startedAt < 30 * DAY), notesOf);

    // последние 8 месяцев
    const months = [];
    const d = new Date();
    for (let i = 7; i >= 0; i--) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      months.push({ y: x.getFullYear(), m: x.getMonth(), label: MONTHS[x.getMonth()], text: 0, media: 0, peak: false });
    }
    for (const r of imports) {
      const x = new Date(r.startedAt);
      const slot = months.find((m) => m.y === x.getFullYear() && m.m === x.getMonth());
      if (slot) { slot.text += notesOf(r); slot.media += r.stats.files.copied; }
    }
    const max = Math.max(0, ...months.map((m) => m.text));
    if (max > 0) months.find((m) => m.text === max).peak = true;

    // по каждому чату берём последний импорт (повторный импорт того же архива не должен удваивать цифры)
    const latest = new Map();
    for (const r of imports) {
      const key = r.chat ? `${r.chat.name}|${r.chat.id}` : r.archive;
      latest.set(key, r);
    }
    const chats = [...latest.values()];
    const content = { text: 0, photos: 0, media: 0, files: 0 };
    for (const r of chats) {
      if (!r.content) continue;
      content.text += r.content.text;
      content.photos += r.content.photos;
      content.media += r.content.videos + r.content.voice + r.content.audio;
      content.files += r.content.files;
    }
    return {
      runs, imports, total, month,
      media: sum(imports, (r) => r.stats.files.copied),
      bytes: sum(imports, (r) => r.stats.files.bytes),
      links: sum(runs, (r) => r.stats.links.changed),
      ok: imports.filter((r) => r.status === 'ok').length,
      months, content, chats,
    };
  }

  // ---------- отрисовка ----------

  render() {
    this.sig = this.signature();
    const r = this.root;
    r.empty();
    const data = this.compute();

    const head = r.createDiv({ cls: 'tgi-pagehead' });
    const ic = head.createDiv({ cls: 'tgi-pageicon' });
    icon(ic, 'bar-chart-3');
    const tt = head.createDiv({ cls: 'tgi-pagetitle' });
    tt.createEl('h2', { text: 'История и инфографика' });
    tt.createDiv({ cls: 'tgi-muted', text: 'Сводка по всем запускам: сколько заметок и файлов попало в хранилище, из каких чатов и с какими результатами' });
    const act = head.createDiv({ cls: 'tgi-row' });
    button(act, { label: 'Экспорт отчёта в Markdown', ico: 'file-text', cls: 'tgi-btn-outline', disabled: !data.runs.length, onClick: () => this.plugin.exportHistoryReport() });
    const clear = button(act, { label: 'Очистить кэш импорта', ico: 'eraser', cls: 'tgi-btn-outline', onClick: async () => {
      if (!this.confirmClear) { this.confirmClear = true; clear.querySelector('span:last-child').setText('Точно очистить?'); setTimeout(() => { this.confirmClear = false; }, 4000); return; }
      this.confirmClear = false;
      await this.plugin.clearImportCache();
      this.render();
    } });

    this.renderKpis(r, data);
    const row = r.createDiv({ cls: 'tgi-grid3' });
    this.renderActivity(row.createDiv({ cls: 'tgi-card tgi-span2' }), data);
    this.renderTypes(row.createDiv({ cls: 'tgi-card' }), data);
    this.renderChats(r.createDiv({ cls: 'tgi-card' }), data);
    this.renderTable(r.createDiv({ cls: 'tgi-card' }), data);
  }

  renderKpis(parent, d) {
    const grid = parent.createDiv({ cls: 'tgi-kpis' });
    const card = (label, ico, value, foot, barCls, pct, valueCls) => {
      const c = grid.createDiv({ cls: 'tgi-card tgi-kpi' });
      const t = c.createDiv({ cls: 'tgi-kpi-top' });
      t.createSpan({ cls: 'tgi-eyebrow', text: label });
      icon(t, ico, 'tgi-kpi-ico');
      c.createDiv({ cls: `tgi-kpi-val ${valueCls || ''}`, text: value });
      const f = c.createDiv({ cls: 'tgi-kpi-foot' });
      for (const part of foot) f.createSpan({ cls: part[1] || '', text: part[0] });
      c.createDiv({ cls: 'tgi-share' }).createDiv({ cls: `tgi-share-fill ${barCls}`, attr: { style: `width:${Math.min(100, Math.max(2, pct))}%` } });
    };
    card('ВСЕГО ИМПОРТИРОВАНО', 'message-square', fmtNum(d.total), [[d.month ? `+${fmtNum(d.month)}` : '0', 'tgi-accent'], [' за последние 30 дней']], 'is-teal', d.total ? (100 * d.month) / d.total : 0);
    card('МЕДИАФАЙЛОВ СОХРАНЕНО', 'images', fmtNum(d.media), [[fmtBytes(d.bytes), 'tgi-red'], [' в хранилище']], 'is-red', d.media ? 70 : 0);
    card('ОБНОВЛЕНО СВЯЗЕЙ', 'network', fmtNum(d.links), [['перекрёстных ссылок Back/Next']], 'is-yellow', d.links ? 80 : 0, 'tgi-accent-y');
    card('УСПЕШНЫХ СЕССИЙ', 'check-circle-2', `${d.ok} / ${d.imports.length}`, [[d.imports.length ? `${Math.round((100 * d.ok) / d.imports.length)}%` : '—', 'tgi-chip tgi-chip-teal'], [' завершились без ошибок']], 'is-teal', d.imports.length ? (100 * d.ok) / d.imports.length : 0);
  }

  renderActivity(c, d) {
    const head = c.createDiv({ cls: 'tgi-cardhead' });
    const l = head.createDiv();
    l.createDiv({ cls: 'tgi-eyebrow', text: 'ТЕМП ПРИТОКА ДАННЫХ' });
    l.createEl('h3', { text: 'Активность импорта по месяцам' });
    const legend = head.createDiv({ cls: 'tgi-legend' });
    for (const [cls, text] of [['is-teal', 'Заметки'], ['is-red', 'Файлы'], ['is-yellow', 'Пиковый месяц']]) {
      const i = legend.createSpan({ cls: 'tgi-legend-i' });
      i.createSpan({ cls: `tgi-sq ${cls}` });
      i.createSpan({ text });
    }
    const chart = c.createDiv({ cls: 'tgi-chart' });
    chart.innerHTML = barChart(d.months);
    const peak = d.months.find((m) => m.peak);
    c.createDiv({ cls: 'tgi-mono tgi-small tgi-muted', text: peak ? `* Пик: ${peak.label}, заметок: ${fmtNum(peak.text)}.` : 'Данные появятся после первого импорта.' });
  }

  renderTypes(c, d) {
    c.createDiv({ cls: 'tgi-eyebrow', text: 'СТРУКТУРА АРХИВОВ' });
    c.createEl('h3', { text: 'Типы контента' });
    const k = d.content;
    const total = k.text + k.photos + k.media + k.files;
    const pct = (v) => (total ? Math.round((100 * v) / total) : 0);
    const chart = c.createDiv({ cls: 'tgi-donutwrap' });
    chart.innerHTML = donut([
      { value: k.text, cls: 'tgi-seg-text' }, { value: k.photos, cls: 'tgi-seg-photo' },
      { value: k.media, cls: 'tgi-seg-media' }, { value: k.files, cls: 'tgi-seg-files' },
    ], `${pct(k.text)}%`, 'Чистый текст');
    const list = c.createDiv({ cls: 'tgi-typelist' });
    for (const [label, v, cls] of [['Текст и посты', k.text, 'is-teal'], ['Фотографии', k.photos, 'is-red'], ['Видео и голосовые', k.media, 'is-yellow'], ['Файлы и архивы', k.files, 'is-gray']]) {
      const row = list.createDiv({ cls: 'tgi-typerow' });
      row.createSpan({ cls: `tgi-sq ${cls}` });
      row.createSpan({ text: label });
      row.createSpan({ cls: 'tgi-mono tgi-right', text: `${pct(v)}%  (${fmtNum(v)})` });
    }
    c.createDiv({ cls: 'tgi-mono tgi-small tgi-muted', text: 'По последнему импорту каждого чата' });
  }

  renderChats(c, d) {
    const head = c.createDiv({ cls: 'tgi-cardhead' });
    const l = head.createDiv();
    l.createDiv({ cls: 'tgi-eyebrow', text: 'ИЕРАРХИЯ ПАПОК' });
    l.createEl('h3', { text: 'Чаты и каналы в хранилище' });
    const target = targetRel(this.plugin.settings);
    const grid = c.createDiv({ cls: 'tgi-chats' });
    const chats = d.chats.filter((r) => r.chat).sort((a, b) => b.stats.notes.total - a.stats.notes.total).slice(0, 4);
    if (!chats.length) grid.createDiv({ cls: 'tgi-muted', text: 'Пока нет импортов с описанием чата.' });
    for (const r of chats) {
      const row = grid.createDiv({ cls: 'tgi-chat' });
      const ico = row.createDiv({ cls: 'tgi-chat-ico' });
      icon(ico, r.chat.type === 'saved_messages' ? 'bookmark' : r.chat.type.includes('channel') ? 'megaphone' : r.chat.type.includes('group') ? 'users' : 'message-circle');
      const b = row.createDiv({ cls: 'tgi-chat-body' });
      const t = b.createDiv({ cls: 'tgi-chat-name' });
      t.createSpan({ text: r.chat.name });
      t.createSpan({ cls: 'tgi-chip tgi-chip-mono', text: r.chat.typeLabel });
      b.createDiv({ cls: 'tgi-mono tgi-small tgi-accent', text: `${target ? `${target} / ` : ''}${r.sourceName || ''}` });
      const n = row.createDiv({ cls: 'tgi-chat-num' });
      n.createDiv({ text: fmtNum(r.stats.notes.total) });
      n.createDiv({ cls: 'tgi-mono tgi-small tgi-muted', text: plural(r.stats.notes.total, 'заметка', 'заметки', 'заметок') });
    }
  }

  renderTable(c, d) {
    const head = c.createDiv({ cls: 'tgi-cardhead' });
    const l = head.createDiv();
    l.createDiv({ cls: 'tgi-eyebrow', text: 'ЖУРНАЛ ИМПОРТОВ' });
    l.createEl('h3', { text: 'История выполненных сессий' });
    const f = head.createDiv({ cls: 'tgi-inline' });
    f.createSpan({ cls: 'tgi-mono tgi-small tgi-muted', text: 'Фильтр по статусу:' });
    const sel = f.createEl('select', { cls: 'tgi-select' });
    for (const [v, label] of FILTERS) {
      const count = v === 'all' ? d.runs.length : d.runs.filter((r) => r.status === v).length;
      const o = sel.createEl('option', { text: `${label} (${count})` });
      o.value = v;
      if (v === this.filter) o.selected = true;
    }
    sel.addEventListener('change', () => { this.filter = sel.value; this.limit = 5; this.render(); });

    const rows = d.runs.filter((r) => this.filter === 'all' || r.status === this.filter).slice().reverse();
    if (!rows.length) { c.createDiv({ cls: 'tgi-muted tgi-empty', text: 'Запусков пока не было. После первого импорта здесь появится журнал.' }); return; }

    const table = c.createEl('table', { cls: 'tgi-table' });
    const hr = table.createEl('thead').createEl('tr');
    for (const t of ['ДАТА / ВРЕМЯ', 'ИСТОЧНИК', 'ОБЪЁМ', 'СТАТУС', 'КОНФЛИКТЫ', 'ДЕЙСТВИЯ']) hr.createEl('th', { text: t });
    const body = table.createEl('tbody');
    for (const r of rows.slice(0, this.limit)) {
      const tr = body.createEl('tr');
      const dt = tr.createEl('td', { cls: 'tgi-mono' });
      dt.createSpan({ text: fmtDateTime(r.startedAt) });
      tr.createEl('td', { cls: 'tgi-mono tgi-accent tgi-srccell', text: r.kind === 'links' ? 'пересчёт ссылок' : r.sourceName || r.archive || '—', attr: { title: r.archive || '' } });
      const vol = r.kind === 'links' ? `${fmtNum(r.stats.links.total)} файлов` : `${fmtNum(r.messages || r.stats.notes.total)} сообщ.${r.bytes ? ` · ${fmtBytes(r.bytes)}` : ''}`;
      tr.createEl('td', { cls: 'tgi-mono tgi-small', text: `${vol} · ${fmtDuration(r.durationMs)}` });
      const st = STATUS[r.status] || [r.status, 'tgi-chip-mono'];
      tr.createEl('td').createSpan({ cls: `tgi-chip ${st[1]}`, text: st[0] });
      const cf = tr.createEl('td', { cls: 'tgi-mono tgi-small' });
      if (r.conflicts) cf.createSpan({ cls: (r.resolved || 0) >= r.conflicts ? 'tgi-conf-ok' : 'tgi-conf-bad', text: (r.resolved || 0) >= r.conflicts ? `${r.conflicts} разрешено` : `${r.conflicts}, разрешено ${r.resolved || 0}` });
      else cf.setText('0 коллизий');
      const ac = tr.createEl('td', { cls: 'tgi-actions-cell' });
      if (r.kind === 'import') button(ac, { label: 'Открыть в хранилище', cls: 'tgi-btn-bracket', onClick: () => this.plugin.openFolderInVault(targetRel(this.plugin.settings)) });
      button(ac, { label: 'Лог сессии', cls: 'tgi-btn-bracket', onClick: () => { if (this.openLog.has(r.id)) this.openLog.delete(r.id); else this.openLog.add(r.id); this.render(); } });
      if (this.openLog.has(r.id)) {
        const lr = body.createEl('tr', { cls: 'tgi-logrow' });
        const td = lr.createEl('td', { attr: { colspan: '6' } });
        const box = td.createDiv({ cls: 'tgi-log' });
        const lines = r.logTail || [];
        if (!lines.length) box.createDiv({ cls: 'tgi-faint', text: 'Журнал этой сессии не сохранён' });
        for (const l2 of lines) {
          const line = box.createDiv({ cls: `tgi-logline tgi-log-${l2.level}` });
          line.createSpan({ cls: 'tgi-faint', text: `[${new Date(l2.t).toLocaleTimeString('ru-RU')}]` });
          line.createSpan({ text: l2.message });
        }
      }
    }

    const foot = c.createDiv({ cls: 'tgi-tablefoot' });
    const shown = Math.min(this.limit, rows.length);
    const left = foot.createDiv({ cls: 'tgi-mono tgi-small tgi-muted' });
    left.createSpan({ text: `Показано ${shown} из ${rows.length} завершённых сессий` });
    if (rows.length > shown) {
      const more = left.createEl('button', { cls: 'tgi-link', text: ' · Показать все' });
      more.addEventListener('click', () => { this.limit = rows.length; this.render(); });
    }
    const right = foot.createDiv({ cls: 'tgi-mono tgi-small tgi-muted tgi-inline' });
    right.createSpan({ cls: 'tgi-dot is-live' });
    right.createSpan({ text: `База метаданных: ${this.plugin.manifest.dir}/import-history.json` });
  }
}

module.exports = { HistoryTab };
