'use strict';
// Плагин Obsidian «Telegram Import»: импорт архива Telegram в заметки одной командой.
const { fsx, path, vaultBase, init: initPlatform } = require('./platform');
const { Plugin, Notice, Platform } = require('obsidian');
const { DEFAULT_SETTINGS, VIEW_DASHBOARD } = require('./constants');
const { NoteIndex, Originals, History } = require('./store');
const { Review } = require('./review');
const { runImport, runRecalc, runAddAttrs, emptyStats } = require('./importer');
const tgsync = require('./tgsync');
const { sourceAttr } = require('./converter');
const { collectMarkdownFiles } = require('./links');
const { scanSource } = require('./scan');
const { resolveInVault, throttle, setGate, targetRel } = require('./util');
const { setFormatMatching, setMediaByDate } = require('./media');
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
    if (tgsync.isDesktop()) this.addCommand({ id: 'sync-telegram-settings', name: 'Настройки синхронизации с Telegram', callback: () => this.openSyncSettings() });
    if (tgsync.isDesktop()) this.addCommand({ id: 'sync-telegram-api', name: 'Синхронизировать с Telegram через API (выгрузка и импорт)', callback: () => this.runSync() });
    this.addCommand({ id: 'add-attrs-json', name: 'Добавить свои атрибуты к заметкам из result.json', callback: () => this.runAddAttrs('json') });
    this.addCommand({ id: 'add-attrs-all', name: 'Добавить свои атрибуты ко всем заметкам папки назначения', callback: () => this.runAddAttrs('all') });
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
    // Схема раскладки медиа v2: раскладка по типам и годам с переименованием включена по умолчанию (один раз для настроек прежних версий)
    if (!saved.mediaSchema) {
      if ((saved.mediaLayout || 'keep') === 'keep') this.settings.mediaLayout = 'year-rename';
      if (saved.mediaRoot === 'media') this.settings.mediaRoot = '';
      this.settings.mediaSchema = DEFAULT_SETTINGS.mediaSchema;
    }
    this.settings.mediaFolders = Object.assign({}, DEFAULT_SETTINGS.mediaFolders, saved.mediaFolders);
    if (saved.mediaSameName === undefined && saved.ignoreMediaFormat === false) this.settings.mediaSameName = 'off'; // прежняя настройка-переключатель
    setFormatMatching(this.settings.mediaSameName);
    setMediaByDate(this.settings.mediaByDate);
    this.applyAttrNames();
    if (this.settings.recalcFolder === 'Telegram/notes') this.settings.recalcFolder = ''; // прежнее значение по умолчанию -> «автоматически»
  }

  async saveSettings() { setFormatMatching(this.settings.mediaSameName); setMediaByDate(this.settings.mediaByDate); this.applyAttrNames(); await this.saveData(this.settings); }

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
    if (kind === 'links' || kind === 'attrs') { for (const id of ['unpack', 'copy', 'notes', 'review']) st.stages[id].state = 'skipped'; }
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
  // opts (для синхронизации через API): keepSource — не запоминать папку как «архив», before() — действие после начала запуска
  // (выгрузка из Telegram), dropFirst/dropLast — отбросить крайние, возможно неполные, посты
  async runImport(sourceArg, opts = {}) {
    if (this.state.running) { new Notice('Telegram: импорт уже выполняется'); return null; }
    await this.ready;
    const source = typeof sourceArg === 'string' || !sourceArg
      ? { kind: this.settings.sourceKind || 'folder', path: sourceArg || this.settings.archiveFolder }
      : sourceArg;
    if (!source.file && !opts.keepSource) this.settings.archiveFolder = source.path; // выбранный через диалог File пути на диске не имеет
    if (!opts.keepSource) this.settings.sourceKind = source.kind;
    await this.saveSettings();
    this.beginRun('import', source);
    const prescan = !opts.before && this.prescan && this.prescan.path === source.path && this.prescan.kind === source.kind ? this.prescan : null;
    let result = null;
    let error = null;
    try {
      if (opts.before) await opts.before();
      if (opts.before && this.cancelled) {
        result = { status: 'cancelled', stats: emptyStats(), pending: this.review.count, meta: null };
      } else result = await runImport({
        vaultBase: this.vaultBase(),
        settings: this.settings,
        source,
        prescan,
        index: this.index,
        originals: this.originals,
        review: this.review,
        hooks: this.hooks(),
        isCancelled: () => this.cancelled,
        dropFirst: !!opts.dropFirst,
        dropLast: !!opts.dropLast,
      });
    } catch (e) {
      console.error('[telegram-import]', e);
      error = e;
    }
    if (opts.after) { try { await opts.after(result, error); } catch (e) { console.error('[telegram-import]', e); } }
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

  // Добавляет свои атрибуты в существующие заметки; mode: 'json' (по датам из result.json) или 'all'
  async runAddAttrs(mode, sourceArg) {
    if (this.state.running) { new Notice('Telegram: уже выполняется'); return null; }
    await this.ready;
    // источник: выбранный на вкладке «Импорт» (в настройки он попадает только после запуска импорта), иначе осмотренный, иначе из настроек
    const source = sourceArg || (this.prescan ? { kind: this.prescan.kind, path: this.prescan.path } : { kind: this.settings.sourceKind || 'folder', path: this.settings.archiveFolder });
    if (mode !== 'all' && !source.path) { new Notice('Telegram: сначала выберите экспорт (папку или ZIP) на вкладке «Импорт»'); return null; }
    this.beginRun('attrs', mode === 'all' ? null : source);
    let result = null;
    let error = null;
    try {
      let json = null;
      if (mode !== 'all') {
        this.log(`Чтение result.json: ${source.path}`);
        const prescan = this.prescan && this.prescan.path === source.path && this.prescan.kind === source.kind ? this.prescan : null;
        json = prescan ? prescan.json : (await scanSource(source)).json;
        this.log(`Сообщений в JSON: ${(json.messages || []).length}`);
      }
      result = await runAddAttrs({
        vaultBase: this.vaultBase(), settings: this.settings, json, mode, review: this.review,
        hooks: this.hooks(), isCancelled: () => this.cancelled,
      });
    } catch (e) {
      console.error('[telegram-import]', e);
      error = e;
    }
    const record = await this.endRun(result, error);
    if (error) new Notice(`Telegram: ошибка\n${record.error}`, 10000);
    else if (result && result.stats) {
      const l = result.stats.links;
      new Notice(l.total ? `Telegram: атрибуты добавлены в ${l.changed} из ${l.total} найденных заметок` : 'Telegram: подходящих заметок не найдено. Подробности в журнале на вкладке «Импорт»', l.total ? 5000 : 10000);
    }
    return record;
  }

  // ---------- синхронизация через API (Python + Telethon, только компьютер) ----------

  openSyncSettings() { return this.openTab('sync'); }

  tgScript() { return path.join(this.pluginDir, 'tg_export.py'); }

  async tgEnv() {
    const creds = await tgsync.loadCreds();
    const py = await tgsync.resolvePython(this.settings.tgPython);
    if (!py) throw new Error('Python не найден. Нажмите «Установить Telethon» в настройках (раздел «Синхронизация через API») или укажите путь к Python');
    if (!(await fsx.exists(this.tgScript()))) throw new Error('Рядом с плагином нет tg_export.py. Скопируйте папку плагина целиком (вместе с этим файлом)');
    return { python: py.exe, script: this.tgScript(), env: { TGI_API_ID: String(creds.apiId || ''), TGI_API_HASH: String(creds.apiHash || ''), TGI_PROXY: String(this.settings.tgProxy || '') }, creds };
  }

  // Запрос текста у пользователя (телефон, код, пароль); null — отмена. Подменяется в тестах
  promptText(title, message, opts = {}) {
    const { PromptModal } = require('./ui/modals');
    return new Promise((resolve) => new PromptModal(this.app, { title, message, secret: !!opts.secret, onDone: resolve }).open());
  }

  async tgCheck() {
    return tgsync.checkEnv({ preferred: this.settings.tgPython, script: this.tgScript() });
  }

  async tgSetup(onLog) {
    const r = await tgsync.setupEnv({ preferred: this.settings.tgPython, onLog });
    return r;
  }

  // Вход в Telegram: телефон, код, при необходимости пароль 2FA
  async tgLogin(onLog, opts = {}) {
    const env = await this.tgEnv();
    if (!env.creds.apiId || !env.creds.apiHash) throw new Error('Укажите api_id и api_hash (my.telegram.org)');
    try { await fsx.mkdir(tgsync.configDir(), { recursive: true }); } catch (e) { throw new Error(`Нет прав на запись в ${tgsync.configDir()}: ${e.code || e.message}`); }
    const titles = { phone: 'Вход в Telegram: телефон', code: 'Вход в Telegram: код', password: 'Вход в Telegram: пароль' };
    let who = '';
    let cancelled = false;
    let qrModal = null;
    const args = ['login', '--session', tgsync.sessionPath()];
    if (opts.qr) args.push('--qr');
    const r = await tgsync.runPy({
      python: env.python, script: env.script, args, env: env.env,
      isCancelled: () => cancelled,
      onAsk: (key, prompt) => this.promptText(titles[key] || 'Telegram', prompt, { secret: key === 'password' }),
      onEvent: (ev) => {
        if (ev.event === 'logged_in') { who = ev.name || ev.phone || ''; if (qrModal) qrModal.finish(); }
        if (ev.event === 'log' && onLog) onLog(ev.message);
        if (ev.event === 'qr') {
          if (!qrModal) {
            const { QrModal } = require('./ui/modals');
            qrModal = new QrModal(this.app, { onCancel: () => { cancelled = true; } });
            qrModal.open();
          }
          qrModal.show(ev.matrix, ev.url);
        }
      },
    });
    if (qrModal) qrModal.finish();
    if (cancelled) throw new Error('Вход отменён');
    if (r.error) throw new Error(r.error);
    return who;
  }

  // Список чатов аккаунта для выбора
  async tgChats() {
    const env = await this.tgEnv();
    const chats = [];
    const r = await tgsync.runPy({
      python: env.python, script: env.script, args: ['chats', '--session', tgsync.sessionPath()], env: env.env,
      onEvent: (ev) => { if (ev.event === 'chat') chats.push(ev); },
    });
    if (r.error) throw new Error(r.error);
    return chats;
  }

  // Кнопка «Синхронизировать»: выгрузка из Telegram за период и обычный импорт результата
  async runSync() {
    if (this.state.running) { new Notice('Telegram: уже выполняется'); return null; }
    if (!tgsync.isDesktop()) { new Notice('Telegram: синхронизация через API доступна только на компьютере'); return null; }
    await this.ready;
    const s = this.settings;
    if (!s.tgChat) { new Notice('Telegram: выберите чат в настройках (раздел «Синхронизация через API»)'); return null; }
    let env;
    try { env = await this.tgEnv(); } catch (e) { new Notice(`Telegram: ${e.message}`, 10000); return null; }
    if (!env.creds.apiId || !env.creds.apiHash) { new Notice('Telegram: укажите api_id и api_hash в настройках'); return null; }
    if (!(await tgsync.hasSession())) { new Notice('Telegram: сначала войдите в Telegram (настройки, кнопка «Войти в Telegram»)'); return null; }

    const out = s.tgExportDir && s.tgExportDir.trim() ? s.tgExportDir.trim() : tgsync.defaultExportDir();
    let bounds = { since: null, until: null };
    const prepare = async () => {
      let lastNote = null;
      if (!s.tgPeriod || s.tgPeriod === 'last') {
        const target = resolveInVault(this.vaultBase(), s.targetFolder, 'Папка назначения');
        if (await fsx.exists(target)) {
          const files = await collectMarkdownFiles(target, [resolveInVault(this.vaultBase(), s.conflictsFolder || 'merge_conflicts', 'Папка конфликтов')]);
          // «Последняя заметка» — самая свежая из помеченных обязательным атрибутом «Источник» (имя и значение из настроек)
          const src = sourceAttr(s);
          this.log(`Ищу последнюю заметку с атрибутом «${src.name}: ${src.value}» среди ${files.length} файлов`);
          const found = await tgsync.lastNoteByAttr(files, src);
          if (found.date) {
            lastNote = found.date;
            this.log(`Последняя заметка с «${src.name}: ${src.value}»: ${tgsync.localIso(lastNote).replace('T', ' ')} (просмотрено заметок: ${found.scanned})`);
          } else {
            const other = found.others.length ? ` В заметках встречаются другие значения: ${found.others.join(', ')}.` : '';
            this.log(`Нет заметок с атрибутом «${src.name}: ${src.value}» (просмотрено ${found.scanned}).${other} Чтобы проставить атрибут в существующие заметки, нажмите «Атрибуты: во все»`, 'warn');
            lastNote = tgsync.newestNoteDate(files);
            if (lastNote) this.log(`Беру самую свежую заметку по дате в имени файла: ${tgsync.localIso(lastNote).replace('T', ' ')}`, 'warn');
          }
        } else {
          this.log(`Папки назначения нет: ${target}`, 'warn');
        }
        if (!lastNote) {
          // Не выгружаем всю историю молча: это долго и часто не то, что нужно
          throw new Error(`Не нашёл последнюю заметку (папка: ${target}). Проверьте «Папку назначения» в настройках или выберите период вручную. Если вы действительно хотите всю историю, выберите период «Вся история»`);
        }
      }
      bounds = tgsync.periodBounds(s, lastNote);
    };

    const hooks = () => this.hooks();
    const exportFromTelegram = async () => {
      await prepare();
      const st = this.state.stages.unpack;
      st.title = 'Выгрузка из Telegram';
      hooks().stage('unpack', { state: 'running', done: 0, total: 0, label: 'подключение…' });
      await fsx.mkdir(out, { recursive: true });
      await fsx.unlink(path.join(out, 'result.json')).catch(() => {});
      const args = ['export', '--session', tgsync.sessionPath(), '--chat', String(s.tgChat), '--out', out];
      if (bounds.since) args.push('--since', bounds.since);
      if (bounds.until) args.push('--until', bounds.until);
      if (s.tgMedia === false) args.push('--no-media');
      else if (Number(s.tgMaxMb) > 0) args.push('--max-media-mb', String(Number(s.tgMaxMb)));
      this.log(`Выгрузка из Telegram: ${s.tgChatTitle || s.tgChat}, период ${bounds.since ? bounds.since.replace('T', ' ') : 'с начала'} — ${bounds.until ? bounds.until.replace('T', ' ') : 'по сегодня'}`);
      const r = await tgsync.runPy({
        python: env.python, script: env.script, args, env: env.env, isCancelled: () => this.cancelled,
        onEvent: (ev) => {
          if (ev.event === 'progress') hooks().stage('unpack', { done: ev.done, total: ev.total || 0, label: ev.label || '' });
          else if (ev.event === 'log') this.log(ev.message, ev.level === 'warn' ? 'warn' : 'info');
          else if (ev.event === 'wait') this.log(ev.message, 'warn');
        },
      });
      if (this.cancelled) { hooks().stage('unpack', { state: 'cancelled' }); return; }
      if (r.error || !r.last) throw new Error(r.error || 'Выгрузка не завершилась');
      hooks().stage('unpack', { state: 'done', label: '' });
      this.log(`Выгружено сообщений: ${r.last.messages} (просмотрено ${r.last.scanned}), файлов: ${r.last.media}${r.last.skipped ? `, пропущено ${r.last.skipped}` : ''}`);
      if (!r.last.messages) throw new Error('За выбранный период в чате нет новых сообщений');
    };

    const record = await this.runImport({ kind: 'folder', path: out }, {
      keepSource: true,
      before: exportFromTelegram,
      after: async (result, error) => {
        if (s.tgCleanup !== false && !error && result && result.status === 'ok') await fsx.rm(out, { recursive: true, force: true }).catch(() => {});
      },
      get dropFirst() { return !!bounds.since; },
      get dropLast() { return !!bounds.until; },
    });
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

  // Открывает окно плагина на нужной вкладке: import | conflicts | history | sync | settings
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

