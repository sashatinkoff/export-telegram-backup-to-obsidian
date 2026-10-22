'use strict';
// Вкладка плагина в настройках Obsidian: те же настройки, что и в окне плагина, и кнопка открытия окна.
const { PluginSettingTab, Setting } = require('obsidian');
const { renderSettingsForm } = require('./settings-form');

class TelegramImportSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Окно импорта').setDesc('Выбор архива, прогресс, конфликты, история и инструкция.')
      .addButton((b) => b.setButtonText('Открыть').setCta().onClick(() => this.plugin.openTab('import')));
    renderSettingsForm(containerEl, this.plugin, { redraw: () => this.display() });
  }
}

module.exports = { TelegramImportSettingTab };
