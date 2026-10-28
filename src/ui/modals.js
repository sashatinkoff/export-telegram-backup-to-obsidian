'use strict';
// Небольшие окна: ввод текста (телефон, код, пароль) и выбор чата из списка.
const { Modal } = require('obsidian');

class PromptModal extends Modal {
  // opts: { title, message, secret, onDone(value|null) }
  constructor(app, opts) {
    super(app);
    this.opts = opts;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.opts.title || 'Telegram' });
    if (this.opts.message) contentEl.createEl('p', { text: this.opts.message });
    const input = contentEl.createEl('input', { type: this.opts.secret ? 'password' : 'text', cls: 'tgi-prompt-input', attr: { autocomplete: 'off', spellcheck: 'false' } });
    input.style.width = '100%';
    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    const ok = row.createEl('button', { text: 'Продолжить', cls: 'mod-cta' });
    const cancel = row.createEl('button', { text: 'Отмена' });
    const submit = () => { this.done = true; const v = input.value.trim(); this.close(); this.opts.onDone(v); };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 30);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) { this.done = true; this.opts.onDone(null); }
  }
}

class ChatPickerModal extends Modal {
  // chats: [{ id, title, kind, username }], onPick(chat)
  constructor(app, chats, onPick) {
    super(app);
    this.chats = chats;
    this.onPick = onPick;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Выберите чат или канал' });
    const input = contentEl.createEl('input', { type: 'text', cls: 'tgi-prompt-input', attr: { placeholder: 'Поиск по названию…', autocomplete: 'off' } });
    input.style.width = '100%';
    const list = contentEl.createDiv({ cls: 'tgi-chatlist' });
    list.style.maxHeight = '50vh';
    list.style.overflowY = 'auto';
    const KIND = { public_channel: 'канал', private_channel: 'канал', public_supergroup: 'группа', private_supergroup: 'группа', private_group: 'группа', personal_chat: 'личный чат' };
    const paint = () => {
      list.empty();
      const q = input.value.trim().toLowerCase();
      for (const c of this.chats.filter((x) => !q || String(x.title).toLowerCase().includes(q) || String(x.username || '').toLowerCase().includes(q)).slice(0, 200)) {
        const row = list.createDiv({ cls: 'tgi-chatrow' });
        row.style.cssText = 'padding:6px 8px;cursor:pointer;border-radius:6px;display:flex;justify-content:space-between;gap:8px';
        row.createSpan({ text: c.title || '(без названия)' });
        row.createSpan({ cls: 'tgi-muted', text: `${KIND[c.kind] || ''}${c.username ? ` @${c.username}` : ''}` });
        row.addEventListener('mouseenter', () => { row.style.background = 'var(--background-modifier-hover)'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.addEventListener('click', () => { this.close(); this.onPick(c); });
      }
    };
    input.addEventListener('input', paint);
    paint();
    setTimeout(() => input.focus(), 30);
  }

  onClose() { this.contentEl.empty(); }
}

// Вход по QR-коду: окно с картинкой, обновляется при выдаче нового кода; закрытие окна = отмена
class QrModal extends Modal {
  constructor(app, { onCancel }) {
    super(app);
    this.onCancel = onCancel;
    this.finished = false;
  }

  onOpen() {
    this.titleEl.setText('Вход в Telegram по QR-коду');
    const c = this.contentEl;
    c.empty();
    c.createEl('p', { text: 'Откройте Telegram на телефоне: Настройки → Устройства → Подключить устройство, и наведите камеру на код. Код обновляется сам.' });
    this.box = c.createDiv({ cls: 'tgi-qr' });
    this.box.setText('Готовлю код…');
    this.link = c.createEl('input', { type: 'text', attr: { readonly: 'true' } });
    this.link.style.width = '100%';
    c.createEl('p', { cls: 'setting-item-description', text: 'Ссылка выше нужна, только если QR не сканируется: её можно открыть на устройстве, где есть Telegram.' });
  }

  // matrix: массив строк из 0 и 1
  show(matrix, url) {
    if (!this.box) return;
    const n = matrix.length;
    const cell = 6;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
    svg.setAttribute('width', String(n * cell));
    svg.setAttribute('height', String(n * cell));
    svg.setAttribute('shape-rendering', 'crispEdges');
    const bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', String(n)); bg.setAttribute('height', String(n)); bg.setAttribute('fill', '#fff');
    svg.appendChild(bg);
    let d = '';
    matrix.forEach((row, y) => { for (let x = 0; x < n; x++) if (row[x] === '1') d += `M${x} ${y}h1v1h-1z`; });
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d); path.setAttribute('fill', '#000');
    svg.appendChild(path);
    this.box.empty();
    this.box.appendChild(svg);
    this.box.style.cssText = 'display:flex;justify-content:center;padding:12px;';
    if (this.link) this.link.value = url;
  }

  finish() { if (this.finished) return; this.finished = true; this.close(); }

  onClose() {
    if (this.contentEl) this.contentEl.empty();
    if (!this.finished && this.onCancel) this.onCancel();
  }
}

module.exports = { PromptModal, ChatPickerModal, QrModal };
