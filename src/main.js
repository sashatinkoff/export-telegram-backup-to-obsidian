'use strict';
// Плагин Obsidian «Telegram Import»: импорт архива Telegram в заметки одной командой.
const { fsx, path, vaultBase, init: initPlatform } = require('./platform');
const { Plugin, Notice, Platform } = require('obsidian');
const { DEFAULT_SETTINGS, VIEW_DASHBOARD } = require('./constants');
const { NoteIndex, Originals, History } = require('./store');
const { Review } = require('./review');
const { runImport, runRecalc, emptyStats } = require('./importer');
const { scanSource } = require('./scan');
const { resolveInVault, throttle, setGate, targetRel } = require('./util');
const { setFormatMatching } = require('./media');
const { setLinkNames } = require('./links');
const { buildHistoryReport } = require('./report');
const shellModule = require('./ui/shell-view');
const settingsModule = require('./ui/settings-tab');

const LOG_LIMIT = 300;
const STAGE_WEIGHT = { unpack: 0.15, copy: 0.3, notes: 0.35, links: 0.15, review: 0.05 };

const STAGES = [
  ['unpack', 'Распаковка ZIP'],
  ['copy', 'Копирование файлов'],
  ['notes', 'Заметки'],
  ['links', 'Ссылки Back/Next'],
  ['review', 'Сравнение заметок с одинаковыми именами'],
];

function newRunState() {
  const stages = {};
  for (const [id, title] of STAGES) stages[id] = { id, title, state: 'idle', done: 0, total: 0, label: '' };
  return {
    running: false, paused: false, kind: null, status: null, error: null, archive: '', source: null, meta: null,
    startedAt: 0, finishedAt: 0, pausedMs: 0, pausedAt: 0, stages, stats: emptyStats(), log: [], hasRun: false,
  };
}

module.exports = class TelegramImportPlugin extends Plugin {
  async onload() {
    initPlatform(this.app, this.manifest.dir);
    await this.loadSettings();
    this.state = newRunState();
    this.listeners = new Set();
    this.cancelled = false;
    this.pausePromise = null;
    this.resumeFn = null;
    this.uiTab = 'import';
    this.scanState = { status: 'idle', info: null, error: null, source: null };
    this.prescan = null; // разобранный result.json после осмотра, чтобы не читать его дважды
    setGate(() => this.pausePromise);
    this.notify = throttle(() => this.listeners.forEach((fn) => { try { fn(this.state); } catch (e) { console.error(e); } }), 100);

    const base = this.vaultBase();
    this.pluginDir = path.join(base, this.manifest.dir);
    this.index = new NoteIndex(path.join(this.pluginDir, 'import-index.json'));
    this.originals = new Originals(path.join(this.pluginDir, 'originals'));
    this.history = new History(path.join(this.pluginDir, 'import-history.json'));
    this.review = new Review({
      vaultBase: base,
      file: path.join(this.pluginDir, 'review-queue.json'),
      getFolder: () => this.settings.conflictsFolder,
      index: this.index,
      originals: this.originals,
    });
    this.review.onChange = () => { this.updateStatusBar(); this.notify(); };
    this.review.onSettled = (item) => { if (item.runId) this.history.bump(item.runId, 'resolved'); };
    this.ready = this.loadStores().catch((e) => console.error('[telegram-import] не удалось загрузить данные', e));

    this.registerView(VIEW_DASHBOARD, (leaf) => new shellModule.ImporterView(leaf, this));
    if (settingsModule.TelegramImportSettingTab) this.addSettingTab(new settingsModule.TelegramImportSettingTab(this.app, this));

    this.addCommand({ id: 'open-panel', name: 'Открыть панель импорта Telegram', callback: () => this.openTab('import') });
    this.addCommand({ id: 'open-history', name: 'История импортов Telegram и инфографика', callback: () => this.openTab('history') });
    this.addCommand({ id: 'run-full-import', name: 'Импорт из Telegram', callback: () => this.startFromUi() });
    this.addCommand({ id: 'recalc-links-only', name: 'Только пересчитать ссылки Back/Next', callback: () => this.runRecalc() });
    this.addCommand({ id: 'review-conflicts', name: 'Разобрать конфликты слияния (сравнение side by side)', callback: () => this.openReview() });
    this.addRibbonIcon('send', 'Импорт из Telegram', () => this.openTab('import'));

    try { this.statusEl = this.addStatusBarItem(); } catch (e) { this.statusEl = null; } // на телефоне строки состояния нет
    if (this.statusEl && this.statusEl.addEventListener) this.statusEl.addEventListener('click', () => this.openTab(this.review.count && !this.state.running ? 'conflicts' : 'import'));
    if (this.statusEl && this.statusEl.addClass) this.statusEl.addClass('mod-clickable');
    this.subscribe(() => this.updateStatusBar());
  }

  async onunload() {
    try { await this.review.flush(); await this.history.store.flush(); } catch (e) { console.error(e); }
  }

  // ---------- данные ----------

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    delete saved.conflicts; // поле прежних версий
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (saved.mediaSameName === undefined && saved.ignoreMediaFormat === false) this.settings.mediaSameName = 'off'; // прежняя настройка-переключатель
    setFormatMatching(this.settings.mediaSameName);
    this.applyAttrNames();
    if (this.settings.recalcFolder === 'Telegram/notes') this.settings.recalcFolder = ''; // прежнее значение по умолчанию -> «автоматически»
  }

  async saveSettings() { setFormatMatching(this.settings.mediaSameName); this.applyAttrNames(); await this.saveData(this.settings); }

  applyAttrNames() { setLinkNames({ prev: this.settings.linkPrevName, next: this.settings.linkNextName, date: this.settings.dateAttrName }); }

  vaultBase() { return vaultBase(this.app); }

  async loadStores() {
    await Promise.all([this.index.load(), this.history.load(), this.review.load(), this.originals.load()]);
    if (this.index.fresh) await this.originals.clear(); // формат индекса сменился: старые «оригиналы» не подходят
    await fsx.rm(path.join(this.pluginDir, 'base'), { recursive: true, force: true }); // папка прежних версий
    this.updateStatusBar();
    this.notify();
  }

  // ---------- состояние запуска и подписчики ----------

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  log(message, level = 'info') {
    this.state.log.push({ t: Date.now(), message, level });
    if (this.state.log.length > LOG_LIMIT) this.state.log.splice(0, this.state.log.length - LOG_LIMIT);
    this.notify();
  }

  updateStatusBar() {
    if (!this.statusEl) return;
    const st = this.state;
    let text = '';
    if (st.running) {
      const active = Object.values(st.stages).find((s) => s.state === 'running');
      if (active) {
        const pct = active.total ? ` ${Math.round((100 * active.done) / active.total)}%` : '';
        text = `Telegram: ${active.title.toLowerCase()}${pct}`;
      } else text = 'Telegram: импорт…';
    } else if (this.review && this.review.count) {
      text = `Telegram: на сравнении ${this.review.count}`;
    }
    this.statusEl.setText(text);
  }

  hooks() {
    return {
      stage: (name, patch) => { Object.assign(this.state.stages[name], patch); this.notify(); },
      log: (message, level) => this.log(message, level),
      stats: (stats) => { this.state.stats = { notes: { ...stats.notes }, files: { ...stats.files }, links: { ...stats.links } }; this.notify(); },
    };
  }

  beginRun(kind, source) {
    const st = newRunState();
    Object.assign(st, { running: true, kind, source, archive: source ? source.path : '', startedAt: Date.now(), hasRun: true });
    if (kind === 'links') { for (const id of ['unpack', 'copy', 'notes', 'review']) st.stages[id].state = 'skipped'; }
    else if (!source || source.kind !== 'zip') st.stages.unpack.state = 'skipped';
    this.state = st;
    this.cancelled = false;
    this.pausePromise = null;
    this.resumeFn = null;
    this.review.runId = st.startedAt;
    this.notify();
  }

  // Общий прогресс 0..1 по этапам с весами, оценка оставшегося времени и скорость (операций в секунду)
  progress() {
    const st = this.state;
    let sum = 0;
    let weights = 0;
    let units = 0;
    for (const s of Object.values(st.stages)) {
      if (s.state === 'skipped') continue;
      const w = STAGE_WEIGHT[s.id] || 0;
      weights += w;
      if (s.state === 'done') sum += w;
      else if (s.total) sum += w * Math.min(1, s.done / s.total);
      units += s.state === 'done' ? s.total || 0 : s.done || 0;
    }
    const fraction = weights ? sum / weights : 0;
    const end = st.running ? Date.now() : st.finishedAt;
    const active = Math.max(1, end - st.startedAt - st.pausedMs - (st.paused ? Date.now() - st.pausedAt : 0));
    const etaMs = st.running && fraction > 0.02 ? (active * (1 - fraction)) / fraction : null;
    return { fraction, etaMs, opsPerSec: units / (active / 1000), activeMs: active };
  }

  pause() {
    const st = this.state;
    if (!st.running || st.paused) return;
    st.paused = true;
    st.pausedAt = Date.now();
    this.pausePromise = new Promise((resolve) => { this.resumeFn = resolve; });
    this.log('Пауза: уже начатые операции завершатся, новые не стартуют', 'warn');
    this.updateStatusBar();
  }

  resume() {
    const st = this.state;
    if (!st.paused) return;
    st.pausedMs += Date.now() - st.pausedAt;
    st.paused = false;
    const resolve = this.resumeFn;
    this.pausePromise = null;
    this.resumeFn = null;
    if (resolve) resolve();
    this.log('Импорт продолжен');
    this.updateStatusBar();
  }

  async endRun(result, error) {
    const st = this.state;
    st.running = false;
    st.finishedAt = Date.now();
    st.status = error ? 'error' : result.status;
    st.error = error ? String(error.message || error) : null;
    if (error) {
      const active = Object.values(st.stages).find((s) => s.state === 'running');
      if (active) active.state = 'error';
      this.log(`Ошибка: ${st.error}`, 'error');
    } else {
      st.stats = result.stats;
    }
    if (st.paused) this.resume();
    const info = this.scanState.info && this.scanState.source && this.scanState.source.path === st.archive ? this.scanState.info : null;
    const meta = (result && result.meta) || null;
    const record = {
      id: st.startedAt, kind: st.kind, startedAt: st.startedAt, finishedAt: st.finishedAt, durationMs: st.finishedAt - st.startedAt,
      archive: st.archive, sourceKind: st.source ? st.source.kind : null, sourceName: st.archive ? path.basename(st.archive) : '',
      status: st.status, stats: st.stats, pending: this.review.count, error: st.error,
      chat: meta ? meta.chat : null, content: meta ? meta.content : null, messages: meta ? meta.messages : 0,
      bytes: info ? info.bytes : st.stats.files.bytes || 0, conflicts: st.stats.notes.review, resolved: 0,
      logTail: st.log.slice(-40),
    };
    try { await this.history.add(record); } catch (e) { console.error('[telegram-import] не удалось сохранить историю', e); }
    this.updateStatusBar();
    this.notify.flush();
    this.notify();
    return { ...record, stats: st.stats };
  }

  // ---------- запуск ----------

  // Основной вход (его вызывает панель импорта и тесты). source — { kind: 'folder'|'zip', path } или строка-путь папки.
  // Возвращает запись истории или null, если уже идёт импорт.
  async runImport(sourceArg) {
    if (this.state.running) { new Notice('Telegram: импорт уже выполняется'); return null; }
    await this.ready;
    const source = typeof sourceArg === 'string' || !sourceArg
      ? { kind: this.settings.sourceKind || 'folder', path: sourceArg || this.settings.archiveFolder }
      : sourceArg;
    if (!source.file) this.settings.archiveFolder = source.path; // выбранный через диалог File пути на диске не имеет
    this.settings.sourceKind = source.kind;
    await this.saveSettings();
    this.beginRun('import', source);
    const prescan = this.prescan && this.prescan.path === source.path && this.prescan.kind === source.kind ? this.prescan : null;
    let result = null;
    let error = null;
    try {
      result = await runImport({
        vaultBase: this.vaultBase(),
        settings: this.settings,
        source,
        prescan,
        index: this.index,
        originals: this.originals,
        review: this.review,
        hooks: this.hooks(),
        isCancelled: () => this.cancelled,
      });
    } catch (e) {
      console.error('[telegram-import]', e);
      error = e;
    }
    this.prescan = null; // разобранный JSON может быть очень большим: после импорта не держим его в памяти
    const record = await this.endRun(result, error);
    if (!error && record.pending && this.settings.autoOpenReview && result.status === 'ok') await this.openTab('conflicts');
    if (error) new Notice(`Telegram: ошибка\n${record.error}`, 10000);
    return record;
  }

  async runRecalc() {
    if (this.state.running) { new Notice('Telegram: уже выполняется'); return null; }
    await this.ready;
    this.beginRun('links', null);
    let result = null;
    let error = null;
    try {
      result = await runRecalc({
        vaultBase: this.vaultBase(),
        settings: this.settings,
        index: this.index,
        review: this.review,
        hooks: this.hooks(),
        isCancelled: () => this.cancelled,
      });
    } catch (e) {
      console.error('[telegram-import]', e);
      error = e;
    }
    const record = await this.endRun(result, error);
    if (error) new Notice(`Telegram: ошибка\n${record.error}`, 10000);
    else if (result && result.stats && result.stats.links) {
      const l = result.stats.links;
      new Notice(`Telegram: ссылки Back/Next ${result.status === 'cancelled' ? 'остановлены' : 'пересчитаны'}\nобновлено ${l.changed} из ${l.total}`);
    }
    return record;
  }

  cancelImport() {
    if (!this.state.running) return;
    this.cancelled = true;
    this.log('Остановка по запросу…', 'warn');
    if (this.state.paused) this.resume();
  }

  // Осмотр источника перед импортом: сообщения, медиа, размер
  async scan(source) {
    const token = (this.scanToken = (this.scanToken || 0) + 1);
    this.scanState = { status: 'scanning', info: null, error: null, source };
    this.prescan = null;
    this.notify();
    try {
      const res = await scanSource(source);
      if (token !== this.scanToken) return;
      this.prescan = { kind: source.kind, path: source.path, json: res.json, zipInfo: res.zipInfo };
      this.scanState = { status: 'ok', info: res.info, error: null, source };
    } catch (e) {
      if (token !== this.scanToken) return;
      this.scanState = { status: 'error', info: null, error: String(e.message || e), source };
    }
    this.notify();
  }

  resetScan() {
    this.scanToken = (this.scanToken || 0) + 1;
    this.scanState = { status: 'idle', info: null, error: null, source: null };
    this.prescan = null;
    this.notify();
  }

  // Команда «Импорт из Telegram»: открыть панель; если подтверждать папку не нужно — сразу запустить
  async startFromUi() {
    await this.openTab('import');
    if (!this.settings.askArchiveEachTime && this.settings.archiveFolder) this.runImport(this.settings.archiveFolder);
  }

  // Забыть историю согласований: следующий импорт заново сравнит заметки с одинаковыми именами
  async clearImportCache() {
    await this.ready;
    await this.index.clear();
    await this.originals.clear();
    new Notice('Telegram: кэш импорта очищен');
  }

  // ---------- экраны ----------

  async openView(type) {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type, active: true });
    }
    ws.revealLeaf(leaf);
    return leaf;
  }

  // Открывает окно плагина на нужной вкладке: import | conflicts | history | settings
  async openTab(tab) {
    this.uiTab = tab;
    if (this.settings.fullscreen !== false && !Platform.isMobile) this.hideSidebars();
    const leaf = await this.openView(VIEW_DASHBOARD);
    this.notify();
    if (leaf && leaf.view && leaf.view.setTab) leaf.view.setTab(tab);
    return leaf;
  }

  // Режим «на весь экран»: боковые панели сворачиваются, пока открыто окно плагина
  hideSidebars() {
    const ws = this.app.workspace;
    if (this.sidebars || !ws.leftSplit || !ws.rightSplit) return;
    this.sidebars = { left: !ws.leftSplit.collapsed, right: !ws.rightSplit.collapsed };
    ws.leftSplit.collapse();
    ws.rightSplit.collapse();
  }

  restoreSidebars() {
    const ws = this.app.workspace;
    const s = this.sidebars;
    this.sidebars = null;
    if (!s || !ws.leftSplit || !ws.rightSplit) return;
    if (s.left) ws.leftSplit.expand();
    if (s.right) ws.rightSplit.expand();
  }

  openDashboard() { return this.openTab('import'); }

  openReview() { return this.openTab('conflicts'); }

  openSettings() { return this.openTab('settings'); }

  // Настройки самого Obsidian (вкладка плагина)
  openObsidianSettings() {
    const setting = this.app.setting;
    if (!setting) return;
    setting.open();
    if (setting.openTabById) setting.openTabById(this.manifest.id);
  }

  async openFolderInVault(rel) {
    const folder = rel ? this.app.vault.getAbstractFileByPath(rel) : this.app.vault.getRoot();
    const explorer = this.app.workspace.getLeavesOfType('file-explorer')[0];
    if (folder && explorer && explorer.view && explorer.view.revealInFolder) {
      this.app.workspace.revealLeaf(explorer);
      explorer.view.revealInFolder(folder);
    } else new Notice(`Telegram: папка ${rel || 'корень хранилища'}`);
  }

  // Markdown-отчёт по истории запусков в папке назначения
  async exportHistoryReport() {
    const rel = [targetRel(this.settings), 'Отчёт об импортах.md'].filter(Boolean).join('/');
    const abs = path.join(this.vaultBase(), ...rel.split('/'));
    await fsx.mkdir(path.dirname(abs), { recursive: true });
    await fsx.writeFile(abs, buildHistoryReport(this.history.runs, this.history.totals()), 'utf8');
    new Notice(`Telegram: отчёт сохранён\n${rel}`);
    await this.openNote(rel);
  }

  async openNote(key) {
    const file = this.app.vault.getAbstractFileByPath(key);
    if (file) await this.app.workspace.getLeaf('tab').openFile(file);
    else await this.app.workspace.openLinkText(key, '', 'tab');
  }

  async openReport() {
    const rel = path.relative(this.vaultBase(), this.review.reportPath()).split(path.sep).join('/');
    await this.openNote(rel);
  }

  static get STAGES() { return STAGES; }

  validateFolders() {
    resolveInVault(this.vaultBase(), this.settings.targetFolder, 'Папка назначения');
  }
};

