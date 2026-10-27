'use strict';
// Конвейер импорта: файлы архива -> заметки -> ссылки Back/Next -> сравнение заметок с одинаковыми именами.
const { fsx, path } = require('./platform');
const { TelegramConverter } = require('./converter');
const { copyArchive } = require('./media');
const { planMedia } = require('./mediaplan');
const { convertOptions } = require('./imageconv');
const { recalcLinks } = require('./links');
const { NoteSync } = require('./sync');
const { countContent, chatInfo } = require('./scan');
const zip = require('./zip');
const { getGate } = require('./util');
const { mapPool, tick, resolveInVault, toKey, sha, recalcRel } = require('./util');

const NOTE_CONCURRENCY = 16;

const emptyStats = () => ({
  notes: { total: 0, written: 0, unchanged: 0, kept: 0, merged: 0, review: 0 },
  files: { copied: 0, skipped: 0, errors: 0, bytes: 0 },
  links: { changed: 0, total: 0 },
});

// Папка для пересчёта ссылок должна существовать
async function resolveRecalcDir(vaultBase, settings) {
  const dir = resolveInVault(vaultBase, recalcRel(settings), 'Папка для пересчёта ссылок');
  if (!(await fsx.exists(dir))) throw new Error(`Нет папки для пересчёта ссылок: ${dir}`);
  return dir;
}

// env: { vaultBase, settings, source: { kind: 'folder'|'zip', path }, prescan, index, originals, review, hooks, isCancelled }
// hooks: stage(name, patch), log(message, level), stats(stats)
// ZIP сначала распаковывается во временную папку (она удаляется после импорта)
async function runImport(env) {
  const { source, prescan } = env;
  if (!source || !source.path) throw new Error('Укажите папку или ZIP-архив с экспортом Telegram');
  if (source.kind !== 'zip') return runImportFrom({ ...env, archiveFolder: source.path, json: prescan && prescan.json });

  const hooks = env.hooks || {};
  const stage = (name, patch) => { if (hooks.stage) hooks.stage(name, patch); };
  stage('unpack', { state: 'running', done: 0, total: 0, label: 'чтение каталога ZIP…' });
  const entries = (prescan && prescan.zipInfo && prescan.zipInfo.entries) || await zip.listZip(source);
  const found = zip.findResult(entries);
  if (!found) throw new Error('В ZIP-архиве нет result.json');
  const tmp = await fsx.makeTemp('telegram-import-');
  try {
    if (hooks.log) hooks.log(`ZIP распаковывается во временную папку ${tmp}`);
    await zip.extractZip(source, entries, found.prefix, tmp, {
      onProgress: (done, total, label) => stage('unpack', { done, total, label }),
      isCancelled: env.isCancelled,
      gate: getGate(),
    });
    if (env.isCancelled && env.isCancelled()) {
      stage('unpack', { state: 'cancelled' });
      return { status: 'cancelled', stats: emptyStats(), pending: env.review.count, meta: null };
    }
    stage('unpack', { state: 'done', label: '' });
    return await runImportFrom({ ...env, archiveFolder: tmp, json: prescan && prescan.json });
  } finally {
    await fsx.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runImportFrom(env) {
  const { vaultBase, settings, archiveFolder, index, originals, review } = env;
  const hooks = env.hooks || {};
  const isCancelled = env.isCancelled || (() => false);
  const stage = (name, patch) => { if (hooks.stage) hooks.stage(name, patch); };
  const log = (message, level = 'info') => { if (hooks.log) hooks.log(message, level); };
  const stats = emptyStats();
  const pushStats = () => { if (hooks.stats) hooks.stats(stats); };
  let meta = null;
  const result = (status) => ({ status, stats, pending: review.count, meta });

  if (!archiveFolder) throw new Error('Укажите папку с архивом Telegram');
  const jsonPath = path.join(archiveFolder, 'result.json');
  if (!(await fsx.exists(jsonPath))) throw new Error(`В папке архива нет result.json: ${archiveFolder}`);
  const target = resolveInVault(vaultBase, settings.targetFolder, 'Папка назначения');
  resolveInVault(vaultBase, settings.conflictsFolder || 'merge_conflicts', 'Папка конфликтов');

  // ---- 0. result.json читаем сразу: от него зависит раскладка медиа
  let json = env.json;
  if (!json) {
    const raw = await fsx.readFile(jsonPath, 'utf8');
    json = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  }
  const converter = new TelegramConverter({
    yandexApiKey: settings.yandexApiKey,
    dateFormat: settings.dateFormat,
    threshold: Math.max(0, Number(settings.mergeThreshold) || 0),
    convertTags: settings.convertTags !== false,
  });
  let posts = converter.getPosts(json);
  const convert = convertOptions(settings);
  const layout = settings.mediaLayout || 'keep';
  const reshape = layout !== 'keep' || !!convert;

  // ---- 1. файлы архива -> хранилище
  if (settings.copyMedia === false) {
    stage('copy', { state: 'skipped', label: '' });
    log('Копирование медиафайлов отключено в настройках');
  } else {
    stage('copy', { state: 'running', done: 0, total: 0, label: 'просмотр папок…' });
    log(`Архив: ${env.source ? env.source.path : archiveFolder}`);
    const plan = reshape ? planMedia(posts, { layout, root: settings.mediaRoot, convert }) : null;
    stats.files = await copyArchive(archiveFolder, target, {
      onProgress: (done, total, label) => { stage('copy', { done, total, label }); stats.files = { ...stats.files }; },
      isCancelled,
      plan,
      convert,
    });
    pushStats();
    if (isCancelled()) { stage('copy', { state: 'cancelled' }); log('Остановлено на этапе копирования файлов', 'warn'); return result('cancelled'); }
    stage('copy', { state: 'done', label: '' });
    const resolved = stats.files.resolved;
    delete stats.files.resolved; // Map не нужен в статистике и истории
    if (reshape && resolved) {
      // ссылки в заметках должны вести на файлы под их итоговыми именами
      converter.setMediaNames(resolved);
      posts = converter.getPosts(json);
    }
  }
  log(`Файлы: скопировано ${stats.files.copied}, без изменений ${stats.files.skipped}${stats.files.errors ? `, ошибок ${stats.files.errors}` : ''}`);
  if (stats.files.converted) log(`Конвертировано изображений: ${stats.files.converted}, сэкономлено ${(stats.files.saved / 1048576).toFixed(1)} МБ`);
  if (stats.files.errors) log(`Ошибок копирования: ${stats.files.errors} (подробности в консоли разработчика)`, 'error');

  // ---- 2. result.json -> заметки
  stage('notes', { state: 'running', done: 0, total: 0, label: 'подготовка заметок…' });
  meta = { chat: chatInfo(json), content: countContent(json).counts, messages: (json.messages || []).length };
  await tick();

  stats.notes.total = posts.length;
  stage('notes', { total: posts.length, label: '' });

  const sync = new NoteSync({ index, originals, review, preserve: settings.preserveEdits, fullScan: !!settings.verifyAll, ignoreAttrs: settings.ignoreAttrs, reviewEdits: settings.reviewLocalEdits !== false });
  let done = 0;
  try {
    await mapPool(posts, NOTE_CONCURRENCY, async (post, i) => {
      const prev = i > 0 ? posts[i - 1].fileName : null;
      const next = i < posts.length - 1 ? posts[i + 1].fileName : null;
      const file = path.join(target, converter.getRelativePath(post));
      const status = await sync.sync({
        file,
        key: toKey(vaultBase, file),
        links: { prev, next },
        rawHash: sha(JSON.stringify(post)),
        build: () => converter.buildNote(post, prev, next),
      });
      stats.notes[status]++;
      done++;
      if (done % 25 === 0 || done === posts.length) { stage('notes', { done, label: post.fileName }); pushStats(); }
    }, isCancelled);
  } finally {
    if (settings.preserveEdits) await index.save(); // сохраняем и при сбое: прогресс не теряется
    await review.store.save();
  }
  if (isCancelled()) { stage('notes', { state: 'cancelled' }); log('Остановлено на этапе заметок', 'warn'); return result('cancelled'); }
  stage('notes', { state: 'done', done: posts.length, label: '' });
  const n = stats.notes;
  log(`Заметки: записано ${n.written}, без изменений ${n.unchanged}, ваши правки сохранены ${n.kept}, объединено ${n.merged}, на сравнение ${n.review}`);

  // ---- 3. ссылки Back/Next
  stage('links', { state: 'running', done: 0, total: 0, label: '' });
  const recalcDir = await resolveRecalcDir(vaultBase, settings);
  const rs = await recalcLinks(recalcDir, {
    force: settings.recalcForce,
    cache: linkCache(env),
    onProgress: (d, t, label) => stage('links', { done: d, total: t, label }),
    isCancelled,
  });
  if (settings.preserveEdits) await index.save();
  stats.links = { changed: rs.changed, total: rs.total };
  pushStats();
  if (isCancelled()) { stage('links', { state: 'cancelled' }); log('Остановлено на этапе пересчёта ссылок', 'warn'); return result('cancelled'); }
  stage('links', { state: 'done', done: rs.total, total: rs.total, label: '' });
  log(`Ссылки Back/Next: обновлено ${rs.changed} из ${rs.total}`);

  // ---- 4. заметки с одинаковыми именами и разным текстом
  await finishReview(env, stage, log);
  return result('ok');
}

// Кэш состояния файлов для пересчёта ссылок (только при включённом сбережении правок и без полной проверки)
function linkCache(env) {
  const { index, settings, vaultBase } = env;
  if (!index || !settings.preserveEdits || settings.verifyAll) return null;
  return {
    lookup: (file) => index.linkInfo(toKey(vaultBase, file)),
    store: (file, st, sig) => index.setLinkInfo(toKey(vaultBase, file), st, sig),
  };
}

// Сверяет очередь разбора: убирает согласованные заметки и обновляет отчёт в папке конфликтов
async function finishReview(env, stage, log) {
  const { review } = env;
  stage('review', { state: 'running', done: 0, total: review.count, label: '' });
  const settled = await review.reconcile((done, total) => stage('review', { done, total }));
  await review.writeReport((done, total) => stage('review', { done, total }));
  await review.store.save();
  stage('review', { state: 'done', done: review.count, total: review.count, label: '' });
  if (settled) log(`Автоматически согласовано заметок: ${settled}`);
  log(review.count ? `На сравнении заметок: ${review.count}` : 'Конфликтов нет: все заметки с одинаковыми именами совпадают по содержимому');
}

// Только пересчёт ссылок Back/Next
async function runRecalc(env) {
  const { vaultBase, settings, review } = env;
  const hooks = env.hooks || {};
  const stage = (name, patch) => { if (hooks.stage) hooks.stage(name, patch); };
  const log = (message, level = 'info') => { if (hooks.log) hooks.log(message, level); };
  const stats = emptyStats();

  stage('links', { state: 'running', done: 0, total: 0, label: '' });
  const recalcDir = await resolveRecalcDir(vaultBase, settings);
  const rs = await recalcLinks(recalcDir, {
    force: settings.recalcForce,
    cache: linkCache(env),
    onProgress: (d, t, label) => stage('links', { done: d, total: t, label }),
    isCancelled: env.isCancelled,
  });
  if (settings.preserveEdits && env.index) await env.index.save();
  stats.links = { changed: rs.changed, total: rs.total };
  if (hooks.stats) hooks.stats(stats);
  const cancelled = env.isCancelled && env.isCancelled();
  stage('links', { state: cancelled ? 'cancelled' : 'done', done: rs.total, total: rs.total, label: '' });
  log(`Ссылки Back/Next: обновлено ${rs.changed} из ${rs.total}`);
  return { status: cancelled ? 'cancelled' : 'ok', stats, pending: review.count };
}

module.exports = { runImport, runRecalc, finishReview, emptyStats };
