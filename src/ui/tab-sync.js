'use strict';
// Вкладка «Telegram API»: настройка и запуск синхронизации через API (только компьютер).
const { buildSyncForm } = require('./sync-form');
const { isDesktop } = require('../tgsync');

class SyncTab {
  constructor(pane, plugin, view) {
    this.pane = pane;
    this.plugin = plugin;
    this.view = view;
  }

  mount() {
    const head = this.pane.createDiv({ cls: 'tgi-pagehead' });
    const tt = head.createDiv({ cls: 'tgi-pagetitle' });
    tt.createEl('h2', { text: 'Telegram API' });
    tt.createDiv({ cls: 'tgi-muted', text: 'Выгрузка чата через API: ключи, вход, чат, период, прокси' });
    this.card = this.pane.createDiv({ cls: 'tgi-card tgi-settings' });
    this.draw();
  }

  draw() {
    this.card.empty();
    if (!isDesktop()) {
      this.card.createEl('p', { cls: 'setting-item-description', text: 'Доступно только на компьютере: нужен Python. На телефоне работает импорт из экспорта Telegram, а выгрузку можно делать на компьютере и синхронизировать хранилище.' });
      return;
    }
    try {
      buildSyncForm(this.card, this.plugin, { redraw: () => this.draw() });
    } catch (e) {
      console.error('[telegram-import]', e);
      this.card.createEl('p', { text: `Ошибка: ${e.message || e}` });
    }
  }
}

module.exports = { SyncTab };
