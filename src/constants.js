'use strict';

const BUILD = '0.4.4 · 2026-10-22';
const VERSION = '0.4.4';

const VIEW_DASHBOARD = 'telegram-import-dashboard';
const VIEW_REVIEW = 'telegram-import-review';

const DEFAULT_SETTINGS = {
  archiveFolder: '',              // последняя использованная папка с экспортом Telegram (там лежит result.json)
  askArchiveEachTime: true,       // на панели импорта нужно подтвердить папку архива; иначе импорт стартует сразу
  targetFolder: 'Telegram',       // папка в хранилище, куда попадает результат экспорта; пусто = корень хранилища
  recalcFolder: '',               // папка пересчёта ссылок Back/Next; пусто = «<папка назначения>/notes»
  recalcForce: true,              // пересчитывать все файлы, а не только те, где нет Back/Next
  mergeThreshold: 120,            // секунд: сообщения ближе друг к другу склеиваются в один пост (0 — не склеивать)
  dateFormat: '',                 // пусто = «7 сентября 2026, 09:41»; иначе strftime-строка
  yandexApiKey: '',               // ключ Яндекс Static Maps для превью локаций
  preserveEdits: true,            // не затирать ручные правки заметок: слияние и разбор конфликтов
  conflictsFolder: 'merge_conflicts', // папка в хранилище: версии из Telegram для сравнения и отчёт
  sourceKind: 'folder',           // 'folder' — папка с экспортом, 'zip' — ZIP-архив
  copyMedia: true,                // копировать медиафайлы архива в хранилище
  convertTags: true,              // хэштеги Telegram -> теги в шапке заметки
  theme: 'auto',                  // оформление панели: auto (как в Obsidian) | dark | light
  fullscreen: true,               // окно плагина открывается на всю рабочую область: боковые панели сворачиваются
  verifyAll: false,               // читать с диска каждую заметку, даже если она не менялась с прошлого импорта
  reviewLocalEdits: true,         // заметки, где текст правили вы (а в Telegram он прежний), тоже показывать на экране сравнения
  ignoreMediaFormat: true,        // смена формата медиа (png -> webp) не конфликт: берём уже имеющийся файл, ссылки сравниваем без расширения
  ignoreAttrs: [],                // YAML-атрибуты, которые плагин не добавляет в уже существующие заметки (Date, tags и т. п.)
  autoOpenReview: true,           // после импорта сам открывать экран разбора, если есть заметки на сравнении
};

// Почему заметка попала на разбор
const REASONS = {
  'no-history': {
    short: 'Нет записи о прошлом импорте',
    long: 'Заметка с таким именем уже есть в хранилище, текст отличается, а записи о прошлом импорте нет, поэтому неизвестно, кто изменил текст.',
  },
  'local-edit': {
    short: 'Вы изменили текст',
    long: 'Текст заметки отличается от версии из Telegram: вы правили его после прошлого импорта, а в Telegram он не менялся. Выберите, что оставить.',
  },
  'both-changed': {
    short: 'Правки пересекаются',
    long: 'Текст изменили и вы, и Telegram, причём в одних и тех же местах: автоматически объединить нельзя.',
  },
  'both-changed-no-base': {
    short: 'Менялось и у вас, и в Telegram',
    long: 'Текст изменили и вы, и Telegram, а исходной версии для автоматического слияния нет.',
  },
};

module.exports = { VERSION, BUILD, VIEW_DASHBOARD, VIEW_REVIEW, DEFAULT_SETTINGS, REASONS };
