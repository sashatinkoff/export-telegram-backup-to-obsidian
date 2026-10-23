'use strict';
// Вкладка «Настройки плагина»: форма настроек и инструкция (README) внутри окна плагина.
const { path, fsx } = require('../platform');
const { MarkdownRenderer, Component } = require('obsidian');
const { VERSION } = require('../constants');
const { renderSettingsForm } = require('./settings-form');

class SettingsTab {
  constructor(pane, plugin, view) {
    this.pane = pane;
    this.plugin = plugin;
    this.view = view;
    this.component = null;
  }

  mount() {
    const head = this.pane.createDiv({ cls: 'tgi-pagehead' });
    const tt = head.createDiv({ cls: 'tgi-pagetitle' });
    tt.createEl('h2', { text: 'Настройки плагина' });
    tt.createDiv({ cls: 'tgi-muted', text: `Telegram Vault Importer v${VERSION}` });
    this.form = this.pane.createDiv({ cls: 'tgi-card tgi-settings' });
    this.readme = this.pane.createDiv({ cls: 'tgi-card tgi-readme markdown-rendered' });
    this.draw();
  }

  show() { this.renderReadme(); }

  draw() {
    this.form.empty();
    renderSettingsForm(this.form, this.plugin, { redraw: () => this.draw() });
  }

  async renderReadme() {
    if (this.rendered) return;
    this.rendered = true;
    const file = path.join(this.plugin.vaultBase(), this.plugin.manifest.dir, 'README.md');
    let text;
    try { text = await fsx.readFile(file); } catch (e) {
      this.readme.setText('README.md не найден: положите его рядом с main.js, и инструкция появится здесь.');
      return;
    }
    this.component = new Component();
    this.component.load();
    await MarkdownRenderer.render(this.plugin.app, text, this.readme, '', this.component);
  }

  destroy() { if (this.component) this.component.unload(); }
}

module.exports = { SettingsTab };
