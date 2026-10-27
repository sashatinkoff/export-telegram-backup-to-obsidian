'use strict';
// Форма настроек: одна и та же во вкладке окна плагина и в настройках Obsidian.
const { Setting } = require('obsidian');
const { pickFolder, pickFile } = require('./pick-folder');
const { renderAttrPicker } = require('./attr-picker');
const { renderCustomAttrs } = require('./custom-attrs');
const { renderFolderInput } = require('./folder-input');
const { isNative } = require('../platform');
const { VERSION } = require('../constants');

function renderSettingsForm(el, plugin, { redraw }) {
  const s = plugin.settings;
  const save = async (key, value) => { s[key] = value; await plugin.saveSettings(); };
  const group = (title) => el.createEl('h3', { text: title });

  el.createEl('p', { cls: 'setting-item-description', text: `Telegram Import ${VERSION}` });
  group('Источник и папки');
  new Setting(el)
    .setName('Папка или ZIP с экспортом Telegram')
    .setDesc(isNative ? 'Где лежит result.json (или ZIP с ним). Меняется и в окне «Новый импорт».' : 'Папка внутри хранилища, где лежит result.json (или ZIP в хранилище). ZIP из «Файлов» выбирается в окне «Новый импорт».')
    .addText((t) => t.setPlaceholder('/путь/к/ChatExport').setValue(s.archiveFolder).onChange((v) => save('archiveFolder', v.trim())))
    .addButton((b) => { if (!isNative) b.buttonEl.addClass('tgi-hidden'); return b.setButtonText('Папка…').onClick(async () => { const d = await pickFolder(); if (d) { s.sourceKind = 'folder'; await save('archiveFolder', d); redraw(); } }); })
    .addButton((b) => { if (!isNative) b.buttonEl.addClass('tgi-hidden'); return b.setButtonText('ZIP…').onClick(async () => { const d = await pickFile(['zip']); if (d) { s.sourceKind = 'zip'; await save('archiveFolder', d); redraw(); } }); });
  new Setting(el)
    .setName('Подтверждать источник в окне импорта')
    .setDesc('Выключено: команда «Импорт из Telegram» сразу запускает импорт с сохранённым источником.')
    .addToggle((t) => t.setValue(s.askArchiveEachTime).onChange((v) => save('askArchiveEachTime', v)));
  const folderSetting = (name, desc, key, placeholder, fallback) => {
    const st = new Setting(el).setName(name).setDesc(desc);
    st.settingEl.addClass('tgi-attr-setting');
    renderFolderInput(st.controlEl, { app: plugin.app, value: s[key] || '', placeholder, onChange: (v) => save(key, fallback && !v ? fallback : v) });
  };
  folderSetting('Папка назначения в хранилище',
    'Куда кладутся заметки (внутри них notes/год/месяц) и файлы архива (photos, video_files…). Пусто: прямо в корень хранилища, то есть заметки окажутся в notes/. Существующие файлы не перезаписываются.',
    'targetFolder', 'пусто = корень хранилища');
  folderSetting('Папка для пересчёта ссылок',
    'Все .md внутри выстраиваются в цепочку Back/Next по порядку имён. Пусто: «папка назначения/notes».',
    'recalcFolder', 'пусто = папка назначения/notes');
  folderSetting('Папка для конфликтов',
    'Версии из Telegram для сравнения и «Отчёт о конфликтах.md» с таблицей по строкам.',
    'conflictsFolder', 'merge_conflicts', 'merge_conflicts');

  group('Преобразование и слияние');
  new Setting(el).setName('Преобразовывать теги').setDesc('Хэштеги Telegram становятся тегами заметки.')
    .addToggle((t) => t.setValue(s.convertTags !== false).onChange((v) => save('convertTags', v)));
  new Setting(el).setName('Копировать медиафайлы').setDesc('Фото, видео, голосовые и документы архива копируются в папку назначения.')
    .addToggle((t) => t.setValue(s.copyMedia !== false).onChange((v) => save('copyMedia', v)));
  new Setting(el).setName('Беречь ручные правки')
    .setDesc('Сравнивается только текст заметки. Пересекающиеся изменения попадают на вкладку «Конфликты записей».')
    .addToggle((t) => t.setValue(s.preserveEdits).onChange((v) => save('preserveEdits', v)));
  new Setting(el).setName('Файлы с тем же именем, но другим расширением')
    .setDesc('Что делать, если в папке хранилища уже есть img_001.webp, а в архиве img_001.png. «Пропускать, если вид тот же»: изображения, видео и аудио считаются одним файлом внутри своего вида. «Пропускать при любом расширении»: report.pdf и report.docx тоже один файл. «Копировать»: сравнивается точное имя. Ссылки на такие файлы в тексте сравниваются по тому же правилу. После переключения сохранённая история сверок сбрасывается.')
    .addDropdown((d) => d.addOptions({ kind: 'Пропускать, если вид тот же', any: 'Пропускать при любом расширении', off: 'Копировать' }).setValue(s.mediaSameName || 'kind').onChange(async (v) => {
      await save('mediaSameName', v);
      if (plugin.index) { await plugin.ready; await plugin.index.clear(); }
    }));
  new Setting(el).setName('Узнавать переименованные медиа по дате в имени')
    .setDesc('Telegram называет файлы photo_1904@03-10-2026_09-46-36.jpg, а упорядочивание галереи (например, плагин Media Organizer) переименовывает их в 2026-10-03_09-46-36_001.webp. Включено: по дате в имени это один файл, ссылки на них в тексте не считаются различием, а файл не копируется повторно, даже если лежит в другой папке хранилища. После переключения история сверок сбрасывается.')
    .addToggle((t) => t.setValue(s.mediaByDate !== false).onChange(async (v) => {
      await save('mediaByDate', v);
      if (plugin.index) { await plugin.ready; await plugin.index.clear(); }
    }));
  new Setting(el).setName('Раскладка медиафайлов')
    .setDesc('«Как в архиве»: photos/, video_files/ и т. д. «По годам»: <папка медиа>/2026/имя. «По годам с именем заметки»: <папка медиа>/2026/2026-09-01_12-00-00_001.jpg (как в Media Organizer). Ссылки в заметках подставляются автоматически. Уже лежащие файлы не перезаписываются.')
    .addDropdown((d) => d.addOptions({ keep: 'Как в архиве', year: 'По годам', 'year-rename': 'По годам с именем заметки' }).setValue(s.mediaLayout || 'keep').onChange(async (v) => {
      await save('mediaLayout', v);
      redraw();
    }));
  if ((s.mediaLayout || 'keep') !== 'keep') {
    new Setting(el).setName('Папка для медиа').setDesc('Внутри папки назначения. Пусто — годы прямо в ней.')
      .addText((t) => t.setPlaceholder('media').setValue(s.mediaRoot === undefined ? 'media' : s.mediaRoot).onChange((v) => save('mediaRoot', v.trim())));
  }
  new Setting(el).setName('Конвертировать изображения')
    .setDesc('jpg, png, webp, bmp и avif при копировании перекодируются в выбранный формат. Стикеры не трогаются. Если результат получился больше исходного, файл копируется как есть. Работает через браузерный движок Obsidian, в том числе на телефоне.')
    .addToggle((t) => t.setValue(!!s.convertImages).onChange(async (v) => {
      await save('convertImages', v);
      redraw();
    }));
  if (s.convertImages) {
    new Setting(el).setName('Формат изображений')
      .addDropdown((d) => d.addOptions({ webp: 'WebP', jpeg: 'JPEG', png: 'PNG' }).setValue(s.imageFormat || 'webp').onChange((v) => save('imageFormat', v)));
    new Setting(el).setName('Качество, %').setDesc('1–100. Для PNG не используется.')
      .addText((t) => t.setValue(String(s.imageQuality || 80)).onChange((v) => save('imageQuality', Math.min(100, Math.max(1, parseInt(v, 10) || 80)))));
    new Setting(el).setName('Максимальная сторона, px').setDesc('Ширина и высота не превысят это значение, пропорции сохраняются. 0 — не уменьшать.')
      .addText((t) => t.setValue(String(s.imageMaxSide || 0)).onChange((v) => save('imageMaxSide', Math.max(0, parseInt(v, 10) || 0))));
  }
  const ca = new Setting(el).setName('Свои атрибуты в заметках')
    .setDesc('Добавляются в шапку новых и обновляемых заметок, например «Источник: телеграм». Одна строка в значении даёт обычный атрибут, несколько строк (по элементу на строку) дают список. Одинаковые имена объединяются в список. К заметкам, которые импорт не меняет, атрибуты не добавляются. Back, Next и атрибут с датой задаются отдельно.');
  ca.settingEl.addClass('tgi-attr-setting');
  renderCustomAttrs(ca.controlEl, { app: plugin.app, values: Array.isArray(s.customAttrs) ? s.customAttrs : [], onChange: (v) => save('customAttrs', v) });
  const ia = new Setting(el).setName('Игнорировать атрибуты')
    .setDesc('YAML-атрибуты, которые плагин не добавляет в уже существующие заметки при обновлении и слиянии (например, tags, если вы убрали их намеренно). Атрибуты и так не участвуют в поиске конфликтов: сравнивается только текст. Back и Next расставляет пересчёт ссылок. Начните вводить имя: подсказки берутся из атрибутов ваших заметок.');
  ia.settingEl.addClass('tgi-attr-setting');
  renderAttrPicker(ia.controlEl, { app: plugin.app, values: Array.isArray(s.ignoreAttrs) ? s.ignoreAttrs : [], onChange: (v) => save('ignoreAttrs', v) });
  new Setting(el).setName('Показывать и ваши правки на сравнении')
    .setDesc('Включено: заметка, где вы поменяли текст (а в Telegram он прежний), попадает на вкладку «Конфликты записей» один раз. Выключено: ваша версия молча сохраняется.')
    .addToggle((t) => t.setValue(s.reviewLocalEdits !== false).onChange((v) => save('reviewLocalEdits', v)));
  new Setting(el).setName('Открывать конфликты после импорта').setDesc('Если есть заметки с разным содержимым, окно переключается на их разбор.')
    .addToggle((t) => t.setValue(s.autoOpenReview).onChange((v) => save('autoOpenReview', v)));
  new Setting(el).setName('Проверять каждую заметку на диске')
    .setDesc('По умолчанию заметки и ссылки, не менявшиеся с прошлого импорта (по дате и размеру файла), пропускаются без чтения. Включите, если файлы правят программы, не обновляющие дату изменения.')
    .addToggle((t) => t.setValue(s.verifyAll).onChange((v) => save('verifyAll', v)));
  new Setting(el).setName('Атрибут с датой')
    .setDesc('Имя YAML-атрибута с датой поста в новых заметках. По умолчанию Date. У существующих заметок при пересчёте ссылок прежнее имя Date заменяется настроенным.')
    .addText((t) => t.setPlaceholder('Date').setValue(s.dateAttrName || 'Date').onChange((v) => save('dateAttrName', v.trim().replace(/[:\s]+/g, '_') || 'Date')));
  new Setting(el).setName('Атрибут со ссылкой назад')
    .setDesc('Имя YAML-атрибута, в который при пересчёте пишется ссылка на предыдущую заметку. По умолчанию Back. Прежние Back, Next и Prev заменяются настроенными именами.')
    .addText((t) => t.setPlaceholder('Back').setValue(s.linkPrevName || 'Back').onChange((v) => save('linkPrevName', v.trim().replace(/[:\s]+/g, '_') || 'Back')));
  new Setting(el).setName('Атрибут со ссылкой вперёд')
    .setDesc('Имя YAML-атрибута для ссылки на следующую заметку. По умолчанию Next.')
    .addText((t) => t.setPlaceholder('Next').setValue(s.linkNextName || 'Next').onChange((v) => save('linkNextName', v.trim().replace(/[:\s]+/g, '_') || 'Next')));
  new Setting(el).setName('Пересчитывать все файлы').setDesc('Выключено: файлы, где уже есть Back/Next, пропускаются.')
    .addToggle((t) => t.setValue(s.recalcForce).onChange((v) => save('recalcForce', v)));

  group('Заметки');
  new Setting(el).setName('Порог склейки, секунд')
    .setDesc('Сообщения, идущие подряд с меньшим интервалом, объединяются в один пост. 0: не склеивать.')
    .addText((t) => t.setValue(String(s.mergeThreshold)).onChange((v) => { const n = Number(v); if (Number.isFinite(n) && n >= 0) save('mergeThreshold', n); }));
  new Setting(el).setName('Формат даты в шапке')
    .setDesc('Пусто: «7 сентября 2026, 09:41». Иначе строка вида %d.%m.%Y %H:%M. Поддерживаются %d %m %Y %y %H %M %S %B %b.')
    .addText((t) => t.setPlaceholder('%d.%m.%Y %H:%M').setValue(s.dateFormat).onChange((v) => save('dateFormat', v)));
  new Setting(el).setName('Ключ Яндекс Static Maps')
    .setDesc('Для превью-картинок локаций. Без ключа вместо картинки будет ссылка. Хранится только в data.json плагина.')
    .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.yandexApiKey).onChange((v) => save('yandexApiKey', v.trim())); });

  group('Оформление');
  if (isNative) new Setting(el).setName('Открывать на всю рабочую область').setDesc('Боковые панели сворачиваются, пока открыто окно плагина, и возвращаются при его закрытии. Настоящий полноэкранный режим: кнопка в шапке окна.')
    .addToggle((t) => t.setValue(s.fullscreen !== false).onChange((v) => save('fullscreen', v)));
  new Setting(el).setName('Тема окна импорта').setDesc('Как в Obsidian, тёмная или светлая.')
    .addDropdown((d) => d.addOptions({ auto: 'Как в Obsidian', dark: 'Тёмная', light: 'Светлая' }).setValue(s.theme || 'auto').onChange(async (v) => {
      await save('theme', v);
      plugin.notify();
      const leaf = plugin.app.workspace.getLeavesOfType(require('../constants').VIEW_DASHBOARD)[0];
      if (leaf && leaf.view && leaf.view.applyTheme) { leaf.view.applyTheme(); leaf.view.paintThemeButton(); }
    }));
}

module.exports = { renderSettingsForm };
