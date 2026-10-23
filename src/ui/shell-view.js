'use strict';
// Окно плагина: шапка, вкладки (Новый импорт, Конфликты записей, История и инфографика, Настройки) и подвал.
const { ItemView, Platform } = require('obsidian');
const { VIEW_DASHBOARD, VERSION } = require('../constants');
const { icon } = require('./dom');
const { ImportTab } = require('./tab-import');
const { ConflictsTab } = require('./tab-conflicts');
const { HistoryTab } = require('./tab-history');
const { SettingsTab } = require('./tab-settings');

const THEMES = ['auto', 'dark', 'light'];
const THEME_TITLE = { auto: 'Тема: как в Obsidian', dark: 'Тема: тёмная', light: 'Тема: светлая' };

class ImporterView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.tabs = {};
    this.active = null;
  }

  getViewType() { return VIEW_DASHBOARD; }

  getDisplayText() { return 'Импорт из Telegram'; }

  getIcon() { return 'send'; }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('tgi-app');
    this.root = root;
    this.applyTheme();
    this.buildHeader(root);
    this.body = root.createDiv({ cls: 'tgi-body' });
    this.buildFooter(root);

    const defs = [
      ['import', 'Новый импорт', ImportTab],
      ['conflicts', 'Конфликты записей', ConflictsTab],
      ['history', 'История и инфографика', HistoryTab],
      ['settings', 'Настройки плагина', SettingsTab],
    ];
    this.tabButtons = {};
    for (const [id, title, Cls] of defs) {
      const btn = this.nav.createEl('button', { cls: 'tgi-tab', attr: { role: 'tab' } });
      btn.addEventListener('click', () => this.setTab(id));
      this.tabButtons[id] = { btn, title };
      const pane = this.body.createDiv({ cls: 'tgi-pane tgi-hidden' });
      this.tabs[id] = { pane, impl: new Cls(pane, this.plugin, this), mounted: false };
    }
    this.onFs = () => this.paintFullscreenButton();
    document.addEventListener('fullscreenchange', this.onFs);
    this.unsubscribe = this.plugin.subscribe(() => this.update());
    this.setTab(this.plugin.uiTab || 'import');
  }

  async onClose() {
    if (this.unsubscribe) this.unsubscribe();
    document.removeEventListener('fullscreenchange', this.onFs);
    if (document.fullscreenElement) document.exitFullscreen();
    this.plugin.restoreSidebars();
    for (const t of Object.values(this.tabs)) if (t.impl.destroy) t.impl.destroy();
  }

  // ---------- шапка и подвал ----------

  buildHeader(root) {
    const head = root.createDiv({ cls: 'tgi-top' });
    const brand = head.createDiv({ cls: 'tgi-brand' });
    const logo = brand.createDiv({ cls: 'tgi-logo' });
    icon(logo, 'send');
    brand.createSpan({ cls: 'tgi-brand-name', text: 'Telegram Vault Importer' });
    brand.createSpan({ cls: 'tgi-chip tgi-chip-mono', text: `v${VERSION}` });
    const vault = brand.createSpan({ cls: 'tgi-vault' });
    vault.createSpan({ cls: 'tgi-dot' });
    vault.createSpan({ text: `Хранилище: ${this.vaultName()}` });

    const tools = head.createDiv({ cls: 'tgi-tools' });
    this.themeBtn = tools.createEl('button', { cls: 'tgi-iconbtn' });
    this.themeBtn.addEventListener('click', () => this.cycleTheme());
    this.fsBtn = tools.createEl('button', { cls: 'tgi-iconbtn' });
    this.fsBtn.addEventListener('click', () => this.toggleFullscreen());
    this.paintFullscreenButton();
    if (Platform.isMobile) this.fsBtn.addClass('tgi-hidden');
    const help = tools.createEl('button', { cls: 'tgi-iconbtn', attr: { title: 'Инструкция', 'aria-label': 'Инструкция' } });
    icon(help, 'help-circle');
    help.addEventListener('click', () => this.setTab('settings'));
    const close = tools.createEl('button', { cls: 'tgi-iconbtn', attr: { title: 'Закрыть', 'aria-label': 'Закрыть' } });
    icon(close, 'x');
    close.addEventListener('click', () => this.leaf.detach());
    this.nav = root.createDiv({ cls: 'tgi-nav', attr: { role: 'tablist' } });
    this.paintThemeButton();
  }

  // Настоящий полноэкранный режим (Esc выходит)
  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (this.root.requestFullscreen) this.root.requestFullscreen();
  }

  paintFullscreenButton() {
    const on = !!document.fullscreenElement;
    const title = on ? 'Выйти из полноэкранного режима' : 'На весь экран';
    this.fsBtn.empty();
    icon(this.fsBtn, on ? 'minimize' : 'maximize');
    this.fsBtn.setAttribute('title', title);
    this.fsBtn.setAttribute('aria-label', title);
  }

  buildFooter(root) {
    const foot = root.createDiv({ cls: 'tgi-foot' });
    const left = foot.createDiv({ cls: 'tgi-foot-left' });
    left.createSpan({ text: `Telegram Export Engine · v${VERSION}` });
    left.createSpan({ cls: 'tgi-faint', text: 'JSON / ZIP / Голосовые / Медиа' });
    this.footStatus = foot.createDiv({ cls: 'tgi-foot-right' });
  }

  vaultName() {
    try { return this.plugin.app.vault.getName(); } catch (e) { return ''; }
  }

  // ---------- тема ----------

  applyTheme() { this.root.setAttribute('data-theme', this.plugin.settings.theme || 'auto'); }

  paintThemeButton() {
    const theme = this.plugin.settings.theme || 'auto';
    this.themeBtn.empty();
    icon(this.themeBtn, theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor');
    this.themeBtn.setAttribute('title', THEME_TITLE[theme]);
    this.themeBtn.setAttribute('aria-label', THEME_TITLE[theme]);
  }

  async cycleTheme() {
    const s = this.plugin.settings;
    s.theme = THEMES[(THEMES.indexOf(s.theme || 'auto') + 1) % THEMES.length];
    await this.plugin.saveSettings();
    this.applyTheme();
    this.paintThemeButton();
  }

  // ---------- вкладки ----------

  setTab(id) {
    if (!this.tabs[id]) id = 'import';
    this.active = id;
    this.plugin.uiTab = id;
    for (const [key, t] of Object.entries(this.tabs)) {
      const on = key === id;
      t.pane.toggleClass('tgi-hidden', !on);
      this.tabButtons[key].btn.toggleClass('is-active', on);
      this.tabButtons[key].btn.setAttribute('aria-selected', String(on));
    }
    const t = this.tabs[id];
    if (!t.mounted) { t.mounted = true; t.impl.mount(); }
    if (t.impl.show) t.impl.show();
    this.update();
  }

  update() {
    const pending = this.plugin.review.count;
    for (const [id, { btn, title }] of Object.entries(this.tabButtons)) {
      const text = id === 'conflicts' && pending ? `${title} (${pending})` : title;
      if (btn.textContent !== text) btn.setText(text);
    }
    this.paintFooter();
    const t = this.tabs[this.active];
    if (t && t.impl.update) t.impl.update();
  }

  paintFooter() {
    const st = this.plugin.state;
    const pending = this.plugin.review.count;
    const text = st.running ? (st.paused ? 'На паузе' : 'Идёт импорт') : pending ? 'Ожидает разбора конфликтов' : 'Готов к импорту';
    const key = `${text}|${pending}`;
    if (this.footKey === key) return;
    this.footKey = key;
    this.footStatus.empty();
    this.footStatus.createSpan({ cls: `tgi-dot${st.running ? ' is-live' : pending ? ' is-warn' : ''}` });
    this.footStatus.createSpan({ text });
    this.footStatus.createSpan({ text: `На разборе: ${pending}` });
  }
}

module.exports = { ImporterView };
