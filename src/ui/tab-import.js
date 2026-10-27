'use strict';
// Вкладка «Новый импорт»: источник, правила, результаты сканирования, прогресс, журнал и кнопки запуска.
const { TelegramConverter } = require('../converter');
const { targetRel, targetLabel } = require('../util');
const { h, icon, button, checkbox } = require('./dom');
const { fmtNum, plural, fmtDuration, fmtTime, fmtBytes, fmtDate } = require('./format');
const { pickFolder, pickFile, pickFileObject, pathOfFile } = require('./pick-folder');
const { isNative } = require('../platform');

const STAGE_SHORT = { unpack: 'Распаковка', copy: 'Файлы', notes: 'Заметки', links: 'Ссылки', review: 'Сравнение' };
const STAGE_ICON = { idle: 'circle', running: 'loader', done: 'check-circle-2', cancelled: 'x-circle', error: 'alert-triangle', skipped: 'minus-circle' };

const kindOf = (p) => (/\.zip$/i.test(String(p).trim()) ? 'zip' : 'folder');
const cleanPath = (p) => String(p || '').trim().replace(/^["']+|["']+$/g, '');

class ImportTab {
  constructor(pane, plugin) {
    this.pane = pane;
    this.plugin = plugin;
    this.source = null;
    this.scanKey = null;
    this.treeOpen = false;
    this.logMenu = false;
  }

  mount() {
    const s = this.plugin.settings;
    if (s.archiveFolder) this.source = { kind: kindOf(s.archiveFolder) === 'zip' ? 'zip' : s.sourceKind || 'folder', path: s.archiveFolder };
    this.mode = this.source ? this.source.kind : s.sourceKind || 'folder';
    const pane = this.pane;

    // заголовок страницы
    const title = pane.createDiv({ cls: 'tgi-pagehead' });
    const ic = title.createDiv({ cls: 'tgi-pageicon' });
    icon(ic, 'upload');
    const tt = title.createDiv({ cls: 'tgi-pagetitle' });
    tt.createEl('h2', { text: 'Новый импорт из Telegram' });
    tt.createDiv({ cls: 'tgi-muted', text: 'Импорт экспортированных чатов и каналов Telegram (ZIP или папка) в заметки Obsidian' });
    this.targetChip = title.createDiv({ cls: 'tgi-target' });
    this.targetChip.addEventListener('click', () => this.plugin.openTab('settings'));

    const grid = pane.createDiv({ cls: 'tgi-grid2' });
    const left = grid.createDiv({ cls: 'tgi-col' });
    const right = grid.createDiv({ cls: 'tgi-col' });

    this.sourceCard = left.createDiv({ cls: 'tgi-card' });
    this.rulesCard = left.createDiv({ cls: 'tgi-card' });
    this.scanCard = right.createDiv({ cls: 'tgi-card tgi-card-flush' });
    this.buildRules();

    this.logCard = pane.createDiv({ cls: 'tgi-card' });
    this.buildLog();
    this.treeCard = pane.createDiv({ cls: 'tgi-card tgi-hidden' });
    this.bar = pane.createDiv({ cls: 'tgi-actionbar' });
    this.buildBar();

    this.renderTarget();
    this.renderSource();
    if (this.source) this.maybeAutoScan();
  }

  show() { this.renderTarget(); }

  // ---------- источник ----------

  renderTarget() {
    this.targetChip.empty();
    this.targetChip.createSpan({ cls: 'tgi-dot' });
    this.targetChip.createSpan({ text: `Куда: ${targetLabel(this.plugin.settings)}` });
    icon(this.targetChip, 'sliders-horizontal');
  }

  setMode(mode) {
    this.mode = mode;
    if (this.source && this.source.kind !== mode) { this.source = null; this.plugin.resetScan(); }
    this.renderSource();
  }

  choose(path) {
    const p = cleanPath(path);
    if (!p) return;
    this.source = { kind: kindOf(p), path: p };
    this.mode = this.source.kind;
    this.plugin.scan(this.source);
    this.renderSource();
  }

  maybeAutoScan() {
    const st = this.plugin.scanState;
    if (st.status === 'idle' || !st.source || st.source.path !== this.source.path) this.plugin.scan(this.source);
  }

  // Телефон: ZIP выбирается системным диалогом (файл читается кусками), папка и ZIP внутри хранилища вводятся путём
  chooseFile(file) {
    this.source = { kind: 'zip', path: file.name, file };
    this.mode = 'zip';
    this.plugin.scan(this.source);
    this.renderSource();
  }

  async pick() {
    if (!isNative) {
      if (this.mode === 'zip') { const f = await pickFileObject(['zip']); if (f) this.chooseFile(f); } else this.input.focus();
      return;
    }
    const p = this.mode === 'zip' ? await pickFile(['zip']) : await pickFolder();
    if (p) this.choose(p);
  }

  async onDrop(ev) {
    ev.preventDefault();
    this.drop.removeClass('is-over');
    const dt = ev.dataTransfer;
    if (!dt || !dt.files || !dt.files.length) return;
    const p = pathOfFile(dt.files[0]);
    if (p) this.choose(p);
  }

  renderSource() {
    const c = this.sourceCard;
    c.empty();
    const head = c.createDiv({ cls: 'tgi-cardhead' });
    const l = head.createDiv();
    l.createSpan({ cls: 'tgi-eyebrow tgi-accent', text: 'ИСТОЧНИК ДАННЫХ' });
    l.createSpan({ cls: 'tgi-faint tgi-mono', text: ' / Экспорт Telegram Desktop' });
    head.createSpan({ cls: 'tgi-chip tgi-chip-yellow', text: 'JSON-экспорт' });

    const seg = c.createDiv({ cls: 'tgi-segbar' });
    for (const [id, label, ico] of [['folder', 'Папка с экспортом', 'folder-open'], ['zip', 'ZIP-архив Telegram (result.json)', 'file-archive']]) {
      const b = button(seg, { label, ico, cls: `tgi-seg${this.mode === id ? ' is-on' : ''}`, onClick: () => this.setMode(id) });
      b.setAttribute('role', 'tab');
    }

    const drop = (this.drop = c.createDiv({ cls: 'tgi-drop' }));
    const cloud = drop.createDiv({ cls: 'tgi-drop-ico' });
    icon(cloud, 'cloud-upload');
    if (isNative) {
      drop.createDiv({ cls: 'tgi-drop-title', text: this.mode === 'zip' ? 'Перетащите ZIP-архив с экспортом сюда' : 'Перетащите папку с экспортом сюда' });
      drop.createDiv({ cls: 'tgi-drop-title', text: 'или выберите на диске' });
      drop.createDiv({ cls: 'tgi-mono tgi-faint tgi-small', text: 'Поддерживаются: result.json, папки экспорта, архивы .zip (в том числе больше 4 ГБ)' });
    } else {
      drop.createDiv({ cls: 'tgi-drop-title', text: this.mode === 'zip' ? 'Нажмите, чтобы выбрать ZIP-архив' : 'Введите путь к папке экспорта внутри хранилища' });
      drop.createDiv({ cls: 'tgi-mono tgi-faint tgi-small', text: this.mode === 'zip' ? 'Архив читается с телефона прямо из «Файлов», копировать в хранилище не нужно' : 'Скопируйте распакованный экспорт Telegram в хранилище и укажите папку с result.json' });
    }
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.addClass('is-over'); });
    drop.addEventListener('dragleave', () => drop.removeClass('is-over'));
    drop.addEventListener('drop', (e) => this.onDrop(e));
    drop.addEventListener('click', (e) => { if (e.target === drop || !e.target.closest('.tgi-pill')) this.pick(); });

    const pill = drop.createDiv({ cls: 'tgi-pill' });
    pill.addEventListener('click', (e) => e.stopPropagation());
    this.pillIcon = icon(pill, 'circle');
    this.input = pill.createEl('input', { type: 'text', cls: 'tgi-pill-input', attr: { placeholder: !isNative ? (this.mode === 'zip' ? 'ZIP в хранилище (необязательно)' : 'папка/в/хранилище') : this.mode === 'zip' ? '/путь/к/ChatExport.zip' : '/путь/к/ChatExport', 'aria-label': 'Путь к экспорту', list: 'tgi-src-list' } });
    if (!isNative) this.fillSuggestions(pill);
    this.input.value = this.source ? this.source.path : '';
    this.input.addEventListener('change', () => this.choose(this.input.value));
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.choose(this.input.value); });
    this.sizeChip = pill.createSpan({ cls: 'tgi-chip tgi-chip-teal tgi-hidden' });
    const swap = pill.createEl('button', { cls: 'tgi-iconbtn', attr: { title: 'Выбрать другой', 'aria-label': 'Выбрать другой' } });
    icon(swap, 'repeat-2');
    swap.addEventListener('click', () => this.pick());
    this.paintSource();
  }

  // Подсказки пути на телефоне: папки или ZIP-файлы хранилища
  fillSuggestions(parent) {
    const dl = parent.createEl('datalist', { attr: { id: 'tgi-src-list' } });
    const v = this.plugin.app.vault;
    let items = [];
    try {
      items = this.mode === 'zip'
        ? v.getFiles().filter((f) => /\.zip$/i.test(f.path)).map((f) => f.path)
        : (v.getAllFolders ? v.getAllFolders(false) : v.getAllLoadedFiles().filter((f) => Array.isArray(f.children))).map((f) => f.path).filter((p) => p && p !== '/');
    } catch (e) { /* без подсказок */ }
    for (const p of items.slice(0, 300)) dl.createEl('option', { attr: { value: p } });
  }

  // Состояние плашки пути: проверка / ошибка / размер
  paintSource() {
    if (!this.pillIcon) return;
    const st = this.plugin.scanState;
    const same = this.source && st.source && st.source.path === this.source.path;
    const status = same ? st.status : 'idle';
    this.pillIcon.empty();
    icon(this.pillIcon, status === 'ok' ? 'check-circle-2' : status === 'error' ? 'alert-triangle' : status === 'scanning' ? 'loader' : 'circle');
    this.pillIcon.className = `tgi-pill-state is-${status}`;
    if (status === 'ok') {
      const total = st.info.kind === 'zip' ? (st.info.bytes || 0) : st.info.bytes;
      this.sizeChip.setText(fmtBytes(total));
      this.sizeChip.removeClass('tgi-hidden');
    } else this.sizeChip.addClass('tgi-hidden');
  }

  // ---------- правила ----------

  buildRules() {
    const c = this.rulesCard;
    c.createDiv({ cls: 'tgi-eyebrow', text: 'ПРАВИЛА ПРЕОБРАЗОВАНИЯ В MARKDOWN' });
    const s = this.plugin.settings;
    const save = async (key, value) => { s[key] = value; await this.plugin.saveSettings(); this.renderTarget(); };
    const rows = [
      {
        title: 'Преобразовывать теги', checked: s.convertTags !== false, key: 'convertTags',
        desc: ['Хэштеги Telegram (', ['code', '#research'], ') попадают в теги заметки, из текста убираются'],
      },
      {
        title: 'Сохранять медиафайлы в папку назначения', checked: s.copyMedia !== false, key: 'copyMedia',
        desc: ['Фото, видео, голосовые и документы копируются в ', ['code', targetLabel(s)], '; существующие файлы не перезаписываются'],
      },
      {
        title: 'Беречь ваши правки в заметках', checked: s.preserveEdits !== false, key: 'preserveEdits',
        desc: ['Сравнивается только текст. Различия показываются на вкладке «Конфликты записей»'],
      },
      {
        title: 'Создавать YAML-шапку (frontmatter)', checked: true, locked: true,
        desc: ['Поля ', ['code', 'Date, tags, Источник, Back, Next'], ': без шапки не работают ссылки Back/Next, поэтому всегда включено'],
      },
    ];
    for (const r of rows) {
      const row = c.createDiv({ cls: 'tgi-rule' });
      checkbox(row, r.checked, (v) => save(r.key, v), r.locked);
      const body = row.createDiv();
      body.createDiv({ cls: 'tgi-rule-title', text: r.title });
      const d = body.createDiv({ cls: 'tgi-rule-desc' });
      for (const part of r.desc) {
        if (Array.isArray(part)) d.createEl('code', { text: part[1] });
        else d.appendText(part);
      }
    }
  }

  // ---------- журнал ----------

  buildLog() {
    const c = this.logCard;
    const head = c.createDiv({ cls: 'tgi-cardhead' });
    const l = head.createDiv({ cls: 'tgi-loghead' });
    l.createSpan({ cls: 'tgi-dot is-live' });
    l.createSpan({ cls: 'tgi-mono tgi-small', text: 'Журнал обработки в реальном времени' });
    this.logRate = head.createSpan({ cls: 'tgi-mono tgi-small tgi-accent-y' });
    this.logEl = c.createDiv({ cls: 'tgi-log', attr: { role: 'log' } });
  }

  // ---------- нижняя панель ----------

  buildBar() {
    const b = this.bar;
    const left = b.createDiv({ cls: 'tgi-bar-left' });
    button(left, { label: 'Структура папок', ico: 'folder-tree', cls: 'tgi-btn-ghost', onClick: () => { this.treeOpen = !this.treeOpen; this.renderTree(); } });
    this.logBtn = button(left, { label: 'Только ошибки в журнале', ico: 'filter', cls: 'tgi-btn-ghost', onClick: () => this.toggleLogFilter() });
    button(left, { label: 'Пересчитать ссылки', ico: 'link', cls: 'tgi-btn-ghost', onClick: () => this.plugin.runRecalc() });
    this.leftBtns = left;
    const right = b.createDiv({ cls: 'tgi-bar-right' });
    this.cancelBtn = button(right, { label: 'Отмена', cls: 'tgi-btn-ghost', onClick: () => this.onCancel() });
    this.pauseBtn = button(right, { label: 'Приостановить', ico: 'pause', cls: 'tgi-btn-outline', onClick: () => this.onPause() });
    this.startBtn = button(right, { label: 'Запустить полный импорт', ico: 'play', cls: 'tgi-btn-primary', onClick: () => this.start() });
  }

  async toggleLogFilter() {
    const s = this.plugin.settings;
    s.logLevel = s.logLevel === 'warn' ? 'all' : 'warn';
    await this.plugin.saveSettings();
    this.paintLog(true);
  }

  onCancel() {
    const st = this.plugin.state;
    if (st.running) this.plugin.cancelImport();
    else { this.source = null; this.plugin.resetScan(); this.renderSource(); }
  }

  onPause() {
    const st = this.plugin.state;
    if (st.paused) this.plugin.resume(); else this.plugin.pause();
  }

  start() {
    const st = this.plugin.scanState;
    if (!this.source || st.status !== 'ok' || this.plugin.state.running) return;
    this.plugin.runImport(this.source);
  }

  // ---------- обновление ----------

  update() {
    const st = this.plugin.state;
    const scan = this.plugin.scanState;
    const key = `${scan.status}|${scan.source ? scan.source.path : ''}|${st.running}`;
    if (key !== this.scanKey) {
      this.scanKey = key;
      this.paintSource();
      this.renderScan();
      if (this.input) this.input.disabled = st.running;
    }
    this.paintProgress();
    this.paintLog();
    this.paintButtons();
  }

  paintButtons() {
    const st = this.plugin.state;
    const scan = this.plugin.scanState;
    const running = st.running;
    this.startBtn.disabled = running || !(this.source && scan.status === 'ok');
    this.pauseBtn.disabled = !running;
    this.pauseBtn.empty();
    icon(this.pauseBtn, st.paused ? 'play' : 'pause');
    this.pauseBtn.createSpan({ text: st.paused ? 'Продолжить' : 'Приостановить' });
    this.cancelBtn.setText(running ? 'Остановить' : 'Отмена');
    this.cancelBtn.disabled = !running && !this.source;
    this.logBtn.querySelector('span:last-child').setText(this.plugin.settings.logLevel === 'warn' ? 'Показать весь журнал' : 'Только ошибки в журнале');
  }

  // ---------- результаты сканирования ----------

  renderScan() {
    const c = this.scanCard;
    c.empty();
    const scan = this.plugin.scanState;
    const top = c.createDiv({ cls: 'tgi-scan-top' });
    const head = top.createDiv({ cls: 'tgi-cardhead' });
    const t = head.createDiv({ cls: 'tgi-cardtitle' });
    icon(t, 'bar-chart-3');
    t.createSpan({ text: 'Результаты сканирования' });
    const chipText = { idle: 'Выберите источник', scanning: 'Сканирование…', ok: 'Готов к импорту', error: 'Ошибка' }[scan.status];
    head.createSpan({ cls: `tgi-chip ${scan.status === 'ok' ? 'tgi-chip-teal' : scan.status === 'error' ? 'tgi-chip-red' : 'tgi-chip-mono'}`, text: chipText });

    if (scan.status === 'idle') top.createDiv({ cls: 'tgi-muted tgi-empty', text: 'После выбора папки или ZIP здесь появится описание архива: число сообщений, фото, видео, файлов и нужное место.' });
    else if (scan.status === 'scanning') {
      top.createDiv({ cls: 'tgi-muted tgi-empty', text: 'Читаю result.json и считаю вложения…' });
      top.createDiv({ cls: 'tgi-bar tgi-indeterminate' }).createDiv({ cls: 'tgi-bar-fill' });
    } else if (scan.status === 'error') top.createDiv({ cls: 'tgi-msg tgi-msg-bad', text: scan.error });
    else this.renderInfo(top, scan.info);

    this.progressEl = c.createDiv({ cls: 'tgi-progress' });
    this.buildProgress();
  }

  renderInfo(parent, info) {
    const c = info.content;
    const stat = parent.createDiv({ cls: 'tgi-bigstat' });
    const a = stat.createDiv();
    a.createDiv({ cls: 'tgi-eyebrow', text: 'ВСЕГО В АРХИВЕ' });
    const num = a.createDiv({ cls: 'tgi-bignum' });
    num.createSpan({ text: fmtNum(info.messages) });
    num.createSpan({ cls: 'tgi-accent tgi-bigunit', text: ` ${plural(info.messages, 'сообщение', 'сообщения', 'сообщений')}` });
    const b = stat.createDiv({ cls: 'tgi-right' });
    b.createDiv({ cls: 'tgi-eyebrow', text: 'ТРЕБУЕМОЕ МЕСТО' });
    b.createDiv({ cls: 'tgi-bigsize', text: `~${fmtBytes(info.bytes)}` });
    b.createDiv({ cls: 'tgi-mono tgi-small tgi-muted', text: 'в хранилище Obsidian' });

    const tiles = parent.createDiv({ cls: 'tgi-tiles' });
    const photos = tiles.createDiv({ cls: 'tgi-tile' });
    const ph = photos.createDiv({ cls: 'tgi-tile-head' });
    icon(ph, 'image');
    ph.createSpan({ text: 'Фотографии' });
    ph.createSpan({ cls: 'tgi-mono tgi-right', text: `${fmtNum(c.photos)} фото` });
    photos.createDiv({ cls: 'tgi-share' }).createDiv({ cls: 'tgi-share-fill', attr: { style: `width:${info.messages ? Math.max(3, (100 * c.photos) / info.messages) : 0}%` } });
    const av = tiles.createDiv({ cls: 'tgi-tile' });
    const ah = av.createDiv({ cls: 'tgi-tile-head' });
    icon(ah, 'mic');
    ah.createSpan({ text: 'Аудио и видео' });
    const l1 = av.createDiv({ cls: 'tgi-tile-line' });
    l1.createSpan({ text: `${fmtNum(c.videos)} видео` });
    l1.createSpan({ cls: 'tgi-mono tgi-accent', text: info.exts.videos.join(' / ') });
    const l2 = av.createDiv({ cls: 'tgi-tile-line' });
    l2.createSpan({ text: `${fmtNum(c.voice + c.audio)} голосовых и аудио` });
    l2.createSpan({ cls: 'tgi-mono tgi-accent', text: info.exts.voice.join(' / ') });

    const row = parent.createDiv({ cls: 'tgi-filesrow' });
    const f = row.createDiv({ cls: 'tgi-inline' });
    icon(f, 'file-text');
    f.createSpan({ cls: 'tgi-strong', text: `${fmtNum(c.files)} ${plural(c.files, 'файл', 'файла', 'файлов')}` });
    if (info.exts.files.length) f.createSpan({ cls: 'tgi-muted', text: `(${info.exts.files.join(', ')})` });
    const k = row.createDiv({ cls: 'tgi-inline' });
    icon(k, 'link');
    k.createSpan({ cls: 'tgi-strong', text: `${fmtNum(c.links)} веб-ссылок` });
    icon(row, 'badge-check', 'tgi-accent-y tgi-right');

    const chat = parent.createDiv({ cls: 'tgi-chatcard' });
    chat.createDiv({ cls: 'tgi-avatar', text: (info.chat.name || '?').trim().slice(0, 1).toUpperCase() });
    const cb = chat.createDiv();
    const ct = cb.createDiv({ cls: 'tgi-chattitle' });
    ct.createSpan({ text: `Чат: ${info.chat.name}` });
    icon(ct, 'badge-check', 'tgi-accent');
    cb.createDiv({ cls: 'tgi-mono tgi-small tgi-muted', text: `Тип: ${info.chat.typeLabel} · Экспорт от ${fmtDate(info.exportedAt)}` });
  }

  // ---------- прогресс ----------

  buildProgress() {
    const p = this.progressEl;
    p.empty();
    const top = p.createDiv({ cls: 'tgi-prog-top' });
    this.pctEl = top.createSpan({ cls: 'tgi-pct', text: '0%' });
    this.countEl = top.createSpan({ cls: 'tgi-mono tgi-small tgi-muted' });
    this.etaEl = top.createSpan({ cls: 'tgi-mono tgi-small tgi-accent-y tgi-right' });
    const bar = p.createDiv({ cls: 'tgi-bar tgi-bar-lg' });
    this.fillEl = bar.createDiv({ cls: 'tgi-bar-fill tgi-bar-grad' });
    this.chipsEl = p.createDiv({ cls: 'tgi-stagechips' });
    const bottom = p.createDiv({ cls: 'tgi-prog-bottom' });
    this.speedEl = bottom.createSpan({ cls: 'tgi-mono tgi-small tgi-muted' });
    this.errEl = bottom.createSpan({ cls: 'tgi-mono tgi-small tgi-right' });
    this.resultEl = p.createDiv();
    this.chipKey = '';
  }

  paintProgress() {
    if (!this.pctEl) return;
    const plugin = this.plugin;
    const st = plugin.state;
    const pr = plugin.progress();
    const idle = !st.hasRun;
    const finished = st.hasRun && !st.running;
    const frac = finished && st.status === 'ok' ? 1 : idle ? 0 : pr.fraction;
    this.pctEl.setText(`${Math.round(frac * 100)}%`);
    this.fillEl.style.width = `${frac * 100}%`;

    const active = Object.values(st.stages).find((s) => s.state === 'running') || null;
    this.countEl.setText(active && active.total ? `(${fmtNum(active.done)} / ${fmtNum(active.total)})` : idle ? '' : finished ? `(${fmtNum(st.stats.notes.total)} заметок)` : '');
    this.etaEl.setText(st.paused ? 'Пауза' : st.running ? (pr.etaMs ? `Осталось: ~${fmtDuration(pr.etaMs)}` : 'Оценка времени…') : finished ? `Готово за ${fmtDuration(pr.activeMs)}` : '');
    const bytes = st.stats.files.bytes || 0;
    this.speedEl.setText(idle ? 'Скорость: ожидание запуска' : `Скорость: ${fmtNum(Math.round(pr.opsPerSec))} оп/с${bytes ? ` · ${fmtBytes(bytes / (pr.activeMs / 1000))}/с` : ''}`);
    const errors = st.stats.files.errors || 0;
    this.errEl.setText(`${errors} ${plural(errors, 'ошибка', 'ошибки', 'ошибок')} копирования`);
    this.errEl.toggleClass('tgi-accent-y', errors === 0);
    this.errEl.toggleClass('tgi-bad', errors > 0);
    this.paintChips(st);
    this.paintResult(st, finished);
    this.logRate.setText(st.running ? `Поток: ${st.paused ? 'пауза' : 'активен'} · ${fmtNum(Math.round(pr.opsPerSec))} оп/с` : 'Поток: ожидание');
  }

  paintChips(st) {
    const stages = Object.values(st.stages).filter((s) => s.state !== 'skipped');
    const key = stages.map((s) => `${s.id}:${s.state}:${s.state === 'running' ? s.done : ''}`).join('|');
    if (key === this.chipKey) return;
    this.chipKey = key;
    this.chipsEl.empty();
    for (const s of stages) {
      const chip = this.chipsEl.createDiv({ cls: `tgi-stagechip is-${s.state}` });
      icon(chip, STAGE_ICON[s.state] || 'circle');
      chip.createSpan({ text: STAGE_SHORT[s.id] || s.title });
      if (s.state === 'running' && s.total) chip.createSpan({ cls: 'tgi-mono tgi-muted', text: `${Math.round((100 * s.done) / s.total)}%` });
    }
  }

  paintResult(st, finished) {
    const key = `${finished}|${st.status}|${st.finishedAt}|${this.plugin.review.count}`;
    if (key === this.resultKey) return;
    this.resultKey = key;
    this.resultEl.empty();
    if (!finished) return;
    const pending = this.plugin.review.count;
    if (st.status === 'error') h(this.resultEl, 'div', 'tgi-msg tgi-msg-bad', `Ошибка: ${st.error}`);
    else if (st.status === 'cancelled') h(this.resultEl, 'div', 'tgi-msg tgi-msg-warn', 'Импорт остановлен. Сделанное сохранено: повторный запуск продолжит с того же места.');
    else if (st.kind === 'import') {
      const box = this.resultEl.createDiv({ cls: pending ? 'tgi-msg tgi-msg-warn' : 'tgi-msg tgi-msg-ok' });
      box.createSpan({ text: pending ? `Заметок на сравнении: ${fmtNum(pending)}` : 'Импорт завершён, конфликтов нет' });
      if (pending) {
        button(box, { label: 'Разобрать', cls: 'tgi-btn-primary tgi-btn-sm', onClick: () => this.plugin.openTab('conflicts') });
        button(box, { label: 'Открыть отчёт', cls: 'tgi-btn-outline tgi-btn-sm', onClick: () => this.plugin.openReport() });
      }
    }
  }

  paintLog(force) {
    const st = this.plugin.state;
    const only = this.plugin.settings.logLevel === 'warn';
    const lines = st.log.filter((l) => !only || l.level !== 'info').slice(-80);
    const key = `${only}|${lines.length}|${lines.length ? lines[lines.length - 1].t : 0}`;
    if (!force && key === this.logKey) return;
    this.logKey = key;
    this.logEl.empty();
    if (!lines.length) this.logEl.createDiv({ cls: 'tgi-faint', text: st.hasRun ? 'Нет записей для выбранного фильтра' : 'Журнал появится после запуска импорта' });
    for (const l of lines) {
      const line = this.logEl.createDiv({ cls: `tgi-logline tgi-log-${l.level}` });
      line.createSpan({ cls: 'tgi-faint', text: `[${fmtTime(l.t)}]` });
      line.createSpan({ text: l.message });
    }
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  // ---------- структура папок ----------

  renderTree() {
    const c = this.treeCard;
    c.toggleClass('tgi-hidden', !this.treeOpen);
    if (!this.treeOpen) return;
    c.empty();
    const target = targetRel(this.plugin.settings);
    c.createDiv({ cls: 'tgi-eyebrow', text: 'СТРУКТУРА ПАПОК ПОСЛЕ ИМПОРТА' });
    const pre = this.plugin.prescan;
    if (!pre || !pre.json) { c.createDiv({ cls: 'tgi-muted', text: 'Сначала выберите архив и дождитесь сканирования.' }); return; }
    const s = this.plugin.settings;
    const conv = new TelegramConverter({ yandexApiKey: '', dateFormat: s.dateFormat, threshold: Math.max(0, Number(s.mergeThreshold) || 0), convertTags: s.convertTags !== false });
    const posts = conv.getPosts(pre.json);
    const groups = new Map();
    for (const p of posts) {
      const dir = conv.getRelativePath(p).split(/[\\/]/).slice(0, -1).join('/');
      groups.set(dir, (groups.get(dir) || 0) + 1);
    }
    const tree = c.createDiv({ cls: 'tgi-tree tgi-mono' });
    tree.createDiv({ text: target ? `${target}/` : '/ (корень хранилища)' });
    let lastYear = '';
    for (const [dir, n] of [...groups.entries()].sort()) {
      const parts = dir.split('/');
      if (parts[1] !== lastYear) { lastYear = parts[1]; tree.createDiv({ cls: 'tgi-tree-l1', text: `${parts[0]}/${parts[1]}/` }); }
      const row = tree.createDiv({ cls: 'tgi-tree-l2' });
      row.createSpan({ text: `${parts[2]}/` });
      row.createSpan({ cls: 'tgi-muted', text: `${fmtNum(n)} ${plural(n, 'заметка', 'заметки', 'заметок')}` });
    }
    const lay = this.plugin.settings.mediaLayout || 'keep';
    const root = this.plugin.settings.mediaRoot === undefined ? 'media' : this.plugin.settings.mediaRoot;
    tree.createDiv({ cls: 'tgi-tree-l1 tgi-muted', text: lay === 'keep' ? 'photos/, video_files/, files/ ... : файлы архива с сохранением структуры' : `${root ? `${root}/` : ''}2026/ ... : медиа по годам${lay === 'year-rename' ? ', имя по заметке' : ''}` });
    c.createDiv({ cls: 'tgi-muted tgi-small', text: `Всего заметок: ${fmtNum(posts.length)}` });
  }
}

module.exports = { ImportTab };
