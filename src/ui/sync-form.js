'use strict';
// Блок настроек «Синхронизация через API»: Python + Telethon, вход, чат, период. Только на компьютере.
const { Setting, Notice } = require('obsidian');
const tgsync = require('../tgsync');
const { copyText } = require('./dom');

const HELP = [
  ['1. Python', 'Нужен Python 3.8 или новее. Проверка: в Терминале (Mac) или командной строке (Windows) выполните python3 --version. Если Python нет: Mac: скачайте установщик на python.org/downloads или выполните brew install python; Windows: установщик с python.org, обязательно отметьте «Add python.exe to PATH»; Linux: sudo apt install python3 python3-venv.'],
  ['2. Установка Telethon', 'Нажмите «Установить Telethon». Плагин сам создаст отдельное окружение (системный Python не меняется) и поставит библиотеку. Если плагин пишет, что Python не найден, впишите в поле «Python» полный путь: в Терминале команда which python3 (Mac, Linux) или where python (Windows). На Mac бывает /opt/homebrew/bin/python3 или /usr/local/bin/python3. Если у вас команда python, а не python3, впишите python.'],
  ['3. Ключи API', 'Откройте my.telegram.org, войдите по номеру телефона, выберите «API development tools», создайте приложение (название и короткое имя любые, платформа Desktop). Скопируйте api_id (число) и api_hash (строка из букв и цифр) в поля ниже. Они хранятся вне хранилища, в папке настроек плагина.'],
  ['4. Вход', 'Нажмите «Войти в Telegram» и введите номер в международном формате (+7…). Код придёт сообщением в приложение Telegram на другом вашем устройстве (или по SMS). Если включена двухэтапная проверка, плагин спросит облачный пароль. Вход нужен один раз. Если код не приходит, используйте «Войти по QR-коду»: в приложении Telegram на телефоне откройте Настройки → Устройства → Подключить устройство и отсканируйте код.'],
  ['5. Чат', 'Нажмите «Выбрать из списка» и найдите свой канал или чат (либо впишите @имя или числовой id).'],
  ['6. Период и запуск', 'Выберите, что выгружать: всё после последней заметки в хранилище (по умолчанию), свой период или всю историю. Затем «Синхронизировать»: плагин выгрузит сообщения и файлы и сразу выполнит обычный импорт со слиянием, ссылками и вашими атрибутами.'],
  ['Важно', 'Не публикуйте и не отправляйте никому файлы из папки настроек плагина и api_hash: файл session даёт доступ к вашему аккаунту. Не запускайте синхронизацию слишком часто: у Telegram есть лимиты, при превышении плагин подождёт. Если Telegram у вас работает только через VPN или прокси (например, Telegram Desktop настроен на 127.0.0.1:порт), впишите тот же прокси в необязательное поле «Прокси»: Python не использует прокси, настроенные только в браузере. Удалённые в Telegram сообщения из заметок не удаляются.'],
];

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('превышено время ожидания')), ms))]);

// В настройках плагина остаётся только ссылка: сама форма живёт на вкладке «Telegram API»
function renderSyncForm(el, plugin) {
  el.createEl('h3', { text: 'Синхронизация через API' });
  if (!tgsync.isDesktop()) {
    el.createEl('p', { cls: 'setting-item-description', text: 'Доступно только на компьютере: нужен Python. На телефоне работает импорт из экспорта Telegram, а выгрузку можно делать на компьютере и синхронизировать хранилище.' });
    return;
  }
  new Setting(el).setName('Синхронизация с Telegram (Python и Telethon)')
    .setDesc('Выгрузка чата через API и импорт по кнопке. Инструкция для новичков внутри.')
    .addButton((b) => b.setButtonText('Открыть вкладку «Telegram API»').setCta().onClick(() => plugin.openSyncSettings()));
}

function buildSyncForm(el, plugin, { redraw }) {
  const s = plugin.settings;
  const save = async (key, value) => { s[key] = value; await plugin.saveSettings(); };

  const help = el.createEl('details', { cls: 'tgi-help' });
  help.createEl('summary', { text: 'Инструкция для новичков: как всё настроить' });
  for (const [title, text] of HELP) {
    const p = help.createEl('p', { cls: 'setting-item-description' });
    p.createEl('strong', { text: `${title}. ` });
    p.appendText(text);
  }

  let logEl = null;
  const lines = [];
  const showLog = (m) => {
    lines.push(m);
    if (lines.length > 500) lines.shift();
    if (logEl) logEl.setText(lines.join('\n'));
  };
  const guard = async (fn, ok) => {
    try { const r = await fn(); if (ok) new Notice(ok(r)); return r; } catch (e) { new Notice(`Telegram: ${e.message || e}`, 10000); showLog(`Ошибка: ${e.message || e}`); return null; }
  };

  const env = new Setting(el).setName('Python и Telethon').setDesc('Нажмите «Проверить»');
  env.addText((t) => t.setPlaceholder('python3 (определить автоматически)').setValue(s.tgPython || '').onChange((v) => save('tgPython', v.trim())));
  const refresh = async () => { const r = await withTimeout(plugin.tgCheck(), 30000).catch((e) => ({ ok: false, text: String(e.message || e) })); env.setDesc(`${r.ok ? 'Готово: ' : 'Не готово: '}${r.text}`); return r; };
  env.addButton((b) => b.setButtonText('Проверить').onClick(async () => { env.setDesc('Проверка…'); await refresh(); }));
  env.addButton((b) => b.setButtonText('Установить Telethon').setCta().onClick(async () => {
    b.setDisabled(true);
    showLog('Установка…');
    const r = await guard(() => plugin.tgSetup(showLog));
    b.setDisabled(false);
    if (r && !r.ok) { showLog(r.error); new Notice(`Telegram: ${r.error}`, 12000); }
    await refresh();
  }));

  const apiSet = new Setting(el).setName('api_id и api_hash').setDesc('С my.telegram.org (шаг 3 инструкции). Хранятся вне хранилища.');
  let creds = { apiId: '', apiHash: '' };
  const saveCreds = () => tgsync.saveCreds(creds).catch((e) => new Notice(`Telegram: ${e.message}`));
  let apiId; let apiHash;
  apiSet.addText((t) => { apiId = t; t.setPlaceholder('api_id').onChange((v) => { creds.apiId = v.trim(); saveCreds(); }); });
  apiSet.addText((t) => { apiHash = t; t.inputEl.type = 'password'; t.setPlaceholder('api_hash').onChange((v) => { creds.apiHash = v.trim(); saveCreds(); }); });
  tgsync.loadCreds().then((c) => { creds = c; apiId.setValue(String(c.apiId || '')); apiHash.setValue(String(c.apiHash || '')); });

  new Setting(el).setName('Прокси (необязательно)')
    .setDesc('Необязательно. Нужен, если Telegram у вас работает только через прокси (посмотрите в Telegram Desktop: Настройки → Продвинутые → Тип соединения). Формат: socks5://127.0.0.1:1443, http://127.0.0.1:8080 или mtproxy://127.0.0.1:1443?secret=… Пусто: прямое подключение.')
    .addText((t) => t.setPlaceholder('socks5://127.0.0.1:1080').setValue(s.tgProxy || '').onChange((v) => save('tgProxy', v.trim())));

  const login = new Setting(el).setName('Вход в Telegram').setDesc('Проверка…');
  const refreshLogin = async () => {
    const ok = await tgsync.hasSession();
    login.setDesc(ok ? 'Вход выполнен' : 'Входа нет: нажмите «Войти в Telegram»');
  };
  login.addButton((b) => b.setButtonText('Войти в Telegram').setCta().onClick(async () => {
    showLog('Подключение к Telegram… (до 45 секунд)');
    const who = await guard(() => plugin.tgLogin(showLog), (w) => `Telegram: вход выполнен${w ? ` (${w})` : ''}`);
    if (who !== null) showLog('Вход выполнен');
    await refreshLogin();
  }));
  login.addButton((b) => b.setButtonText('Войти по QR-коду').setTooltip('Если код из сообщения не приходит: сканируете QR в приложении Telegram на телефоне').onClick(async () => {
    showLog('Вход по QR-коду: подключение к Telegram…');
    const who = await guard(() => plugin.tgLogin(showLog, { qr: true }), (w) => `Telegram: вход выполнен${w ? ` (${w})` : ''}`);
    if (who !== null) showLog('Вход выполнен');
    await refreshLogin();
  }));
  login.addButton((b) => b.setButtonText('Выйти').onClick(async () => { await tgsync.dropSession(); new Notice('Telegram: сессия удалена'); await refreshLogin(); }));
  refreshLogin();

  const chat = new Setting(el).setName('Чат или канал').setDesc(s.tgChatTitle ? `Выбрано: ${s.tgChatTitle}` : 'Выберите из списка или впишите @имя / числовой id');
  chat.addText((t) => t.setPlaceholder('@имя или id').setValue(s.tgChat || '').onChange((v) => { s.tgChatTitle = ''; save('tgChat', v.trim()); }));
  chat.addButton((b) => b.setButtonText('Выбрать из списка').onClick(async () => {
    b.setDisabled(true);
    showLog('Загрузка списка чатов…');
    const chats = await guard(() => plugin.tgChats());
    b.setDisabled(false);
    if (!chats) return;
    const { ChatPickerModal } = require('./modals');
    new ChatPickerModal(plugin.app, chats, async (c) => {
      s.tgChatTitle = c.title || '';
      await save('tgChat', c.username ? `@${c.username}` : String(c.id));
      redraw();
    }).open();
  }));

  const period = new Setting(el).setName('Период выгрузки')
    .setDesc('«После последней заметки»: берётся дата самой свежей заметки с обязательным атрибутом «Источник» (имя и значение в настройках плагина, по умолчанию Источник: Telegram), с запасом в час назад. Если таких заметок нет, берётся самая свежая по дате в имени. «Свой период»: даты включительно. «Вся история»: всё, что есть в чате.');
  period.addDropdown((d) => d.addOptions({ last: 'После последней заметки', range: 'Свой период', all: 'Вся история' }).setValue(s.tgPeriod || 'last').onChange(async (v) => { await save('tgPeriod', v); redraw(); }));
  if (s.tgPeriod === 'range') {
    const range = new Setting(el).setName('С даты и по дату').setDesc('Любую границу можно оставить пустой.');
    range.addText((t) => { t.inputEl.type = 'date'; t.setValue(s.tgFrom || '').onChange((v) => save('tgFrom', v)); });
    range.addText((t) => { t.inputEl.type = 'date'; t.setValue(s.tgTo || '').onChange((v) => save('tgTo', v)); });
  }

  new Setting(el).setName('Скачивать медиа').setDesc('Фото, видео, голосовые и файлы. Выключено: только текст.')
    .addToggle((t) => t.setValue(s.tgMedia !== false).onChange(async (v) => { await save('tgMedia', v); redraw(); }));
  if (s.tgMedia !== false) {
    new Setting(el).setName('Не скачивать файлы больше, МБ').setDesc('0 — без ограничения. Пропущенные файлы записываются в журнал.')
      .addText((t) => t.setValue(String(s.tgMaxMb || 0)).onChange((v) => save('tgMaxMb', Math.max(0, Number(v) || 0))));
  }
  new Setting(el).setName('Удалять выгрузку после импорта').setDesc('Выгрузка (result.json и файлы) временная: после успешного импорта все файлы уже в хранилище.')
    .addToggle((t) => t.setValue(s.tgCleanup !== false).onChange((v) => save('tgCleanup', v)));
  new Setting(el).setName('Папка для выгрузки').setDesc(`Пусто: ${tgsync.defaultExportDir()}`)
    .addText((t) => t.setPlaceholder(tgsync.defaultExportDir()).setValue(s.tgExportDir || '').onChange((v) => save('tgExportDir', v.trim())));

  new Setting(el).setName('Синхронизировать сейчас').setDesc('Выгрузка из Telegram за выбранный период и импорт. Ход выполнения виден в окне импорта.')
    .addButton((b) => b.setButtonText('Синхронизировать').setCta().onClick(() => plugin.runSync()));
  new Setting(el).setName('Журнал')
    .setDesc('Текст можно выделить и скопировать вручную или кнопкой.')
    .addButton((b) => b.setButtonText('Копировать журнал').onClick(async () => { new Notice(await copyText(lines.join('\n')) ? 'Журнал скопирован' : 'Не удалось скопировать: выделите текст вручную'); }))
    .addButton((b) => b.setButtonText('Очистить').onClick(() => { lines.length = 0; if (logEl) logEl.setText(''); }));
  logEl = el.createEl('pre', { cls: 'tgi-tglog setting-item-description' });
  logEl.style.whiteSpace = 'pre-wrap';
  if (lines.length) logEl.setText(lines.join('\n'));
}

module.exports = { renderSyncForm, buildSyncForm, HELP };
