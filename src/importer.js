'use strict';
// Конвейер импорта: файлы архива -> заметки -> ссылки Back/Next -> сравнение заметок с одинаковыми именами.
const { fsx, path } = require('./platform');
const { TelegramConverter, normalizeCustomAttrs, attrLines, effectiveAttrs } = require('./converter');
const { addAttrsToText, skipReason } = require('./addattrs');
const { parseDate } = require('./util');
const { copyArchive } = require('./media');
const { planMedia } = require('./mediaplan');
const { DEFAULT_SETTINGS } = require('./constants');
const { convertOptions } = require('./imageconv');
const { recalcLinks, getLinkNames, collectMarkdownFiles } = require('./links');
const { NoteSync } = require('./sync');
const { countContent, chatInfo } = require('./scan');
const zip = require('./zip');
const { getGate } = require('./util');
const { mapPool, tick, resolveInVault, toKey, sha, recalcRel } = require('./util');

const NOTE_CONCURRENCY = 16;

const emptyStats = () => ({
  notes: { total: 0, written: 0, unchanged: 0, kept: 0, merged: 0, review: 0, attrs: 0 },
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
    customAttrs: effectiveAttrs(settings),
  });
  // Выгрузка из API обрезана по краям периода: первая (и последняя при заданном конце) группа сообщений может быть неполной
  const loadPosts = () => {
    let list = converter.getPosts(json);
    if (env.dropFirst) list = list.slice(1);
    if (env.dropLast) list = list.slice(0, -1);
    return list;
  };
  let posts = loadPosts();
  const convert = convertOptions(settings);
  const layout = settings.mediaLayout || 'keep';
  log(`Раскладка медиа: ${{ keep: 'как в архиве', year: 'по годам', 'year-rename': 'по годам с именем заметки' }[layout] || layout}`);
  log(convert ? `Конвертация изображений: ${convert.format}, качество ${convert.quality}${convert.maxSide ? `, до ${convert.maxSide} px` : ''}` : 'Конвертация изображений: выключена');
  const reshape = layout !== 'keep' || !!convert;

  // ---- 1. файлы архива -> хранилище
  if (settings.copyMedia === false) {
    stage('copy', { state: 'skipped', label: '' });
    log('Копирование медиафайлов отключено в настройках');
  } else {
    stage('copy', { state: 'running', done: 0, total: 0, label: 'просмотр папок…' });
    log(`Архив: ${env.source ? env.source.path : archiveFolder}`);
    const plan = reshape ? planMedia(posts, { layout, root: settings.mediaRoot, convert, folders: Object.assign({}, DEFAULT_SETTINGS.mediaFolders, settings.mediaFolders) }) : null;
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
      posts = loadPosts();
    }
  }
  if (stats.files.skipped && reshape) log('«Без изменений» — это файлы, которые уже есть в хранилище (по имени, по дате в имени или с тем же содержимым): они не перезаписываются, не переименовываются и не конвертируются', 'info');
  log(`Файлы: скопировано ${stats.files.copied}, без изменений ${stats.files.skipped}${stats.files.errors ? `, ошибок ${stats.files.errors}` : ''}`);
  if (stats.files.converted) log(`Конвертировано изображений: ${stats.files.converted}, сэкономлено ${(stats.files.saved / 1048576).toFixed(1)} МБ`);
  if (stats.files.errors) log(`Ошибок копирования: ${stats.files.errors} (подробности в консоли разработчика)`, 'error');

  // ---- 2. result.json -> заметки
  stage('notes', { state: 'running', done: 0, total: 0, label: 'подготовка заметок…' });
  meta = { chat: chatInfo(json), content: countContent(json).counts, messages: (json.messages || []).length };
  await tick();

  stats.notes.total = posts.length;
  stage('notes', { total: posts.length, label: '' });

  // Всё, что влияет на шапку: при смене этих настроек заметки перепроверяются, а не пропускаются по отпечатку
  const attrSig = JSON.stringify([converter.customAttrs, (settings.ignoreAttrs || []).map((k) => String(k).toLowerCase()).sort(), settings.convertTags !== false, getLinkNames().date, 'attrs-v1']);
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
        rawHash: sha(JSON.stringify(post) + attrSig),
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
  n.attrs = sync.attrsAdded;
  log(`Заметки: записано ${n.written}, без изменений ${n.unchanged}, ваши правки сохранены ${n.kept}, объединено ${n.merged}, на сравнение ${n.review}${n.attrs ? `; атрибуты дополнены у ${n.attrs}` : ''}`);

  // ---- 3. ссылки Back/Next
  stage('links', { state: 'running', done: 0, total: 0, label: '' });
  const recalcDir = await resolveRecalcDir(vaultBase, settings);
  const rs = await recalcLinks(recalcDir, {
    force: settings.recalcForce,
    cache: linkCache(env),
    exclude: [resolveInVault(vaultBase, settings.conflictsFolder || 'merge_conflicts', 'Папка конфликтов')],
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
    exclude: [resolveInVault(vaultBase, settings.conflictsFolder || 'merge_conflicts', 'Папка конфликтов')],
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

// Только добавить свои атрибуты (настройка «Свои атрибуты в заметках») в уже существующие заметки.
// Ничего не создаёт, не копирует и не меняет в тексте. mode: 'json' — заметки, чьи даты есть в result.json
// (по каждому сообщению, поэтому неполный JSON не мешает), 'all' — все заметки папки назначения
async function runAddAttrs(env) {
  const { vaultBase, settings, json, mode } = env;
  const hooks = env.hooks || {};
  const stage = (name, patch) => { if (hooks.stage) hooks.stage(name, patch); };
  const log = (message, level = 'info') => { if (hooks.log) hooks.log(message, level); };
  const stats = emptyStats();
  const items = attrLines(normalizeCustomAttrs(effectiveAttrs(settings)));
  const target = resolveInVault(vaultBase, settings.targetFolder, 'Папка назначения');
  if (!(await fsx.exists(target))) throw new Error(`Нет папки назначения: ${target}`);
  const ignore = new Set((settings.ignoreAttrs || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean));

  stage('links', { state: 'running', done: 0, total: 0, label: 'поиск заметок…' });
  let files = await collectMarkdownFiles(target, [resolveInVault(vaultBase, settings.conflictsFolder || 'merge_conflicts', 'Папка конфликтов')]);
  const total = files.length;
  if (mode !== 'all') {
    if (!json) throw new Error('Нет result.json: выберите экспорт Telegram');
    // Заметка узнаётся по дате и времени в имени файла (допускаются суффиксы, «_» или «T» вместо пробела, «:» и «.» вместо «-»)
    const p2 = (n) => String(n).padStart(2, '0');
    const keys = new Set();
    for (const m of json.messages || []) {
      if (!m.date) continue;
      const dt = parseDate(m.date);
      keys.add(`${dt.y}-${p2(dt.mo)}-${p2(dt.d)}_${p2(dt.H)}-${p2(dt.M)}-${p2(dt.S)}`);
    }
    const nameKey = (name) => {
      const m = /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:.](\d{2})[-:.](\d{2})/.exec(name);
      return m ? `${m[1]}-${m[2]}-${m[3]}_${m[4]}-${m[5]}-${m[6]}` : null;
    };
    const matched = files.filter((f) => keys.has(nameKey(path.basename(f))));
    log(`В JSON сообщений с датой: ${keys.size}; заметок в «${path.relative(vaultBase, target) || '/'}»: ${total}; совпало по дате: ${matched.length}`);
    if (!matched.length) {
      const sample = [...keys].slice(0, 2).join(', ');
      const have = files.slice(0, 3).map((f) => path.basename(f)).join(', ');
      log(`Совпадений нет. Ожидаются имена вида «${sample.replace(/_/, ' ')}» (ГГГГ-ММ-ДД ЧЧ-ММ-СС.md). В папке, например: ${have || 'пусто'}. Проверьте «Папку назначения» в настройках.`, 'warn');
    }
    files = matched;
  } else log(`Заметок в папке назначения: ${total}`);

  let done = 0;
  let changed = 0;
  const skipped = { exists: 0, ignored: 0, reserved: 0 };
  const example = {};
  await mapPool(files, 16, async (file) => {
    const text = await fsx.readFile(file, 'utf8');
    const out = addAttrsToText(text, items, ignore);
    if (out !== null) { await fsx.writeFile(file, out, 'utf8'); changed++; } else {
      const why = skipReason(text, items, ignore);
      if (why) {
        skipped[why.reason]++;
        if (!example[why.reason]) example[why.reason] = `${path.basename(file)}${why.line ? `: «${why.line.trim()}»` : ''}`;
      }
    }
    done++;
    if (done % 50 === 0 || done === files.length) stage('links', { done, total: files.length, label: path.basename(file) });
  }, env.isCancelled);
  stats.links = { changed, total: files.length };
  if (hooks.stats) hooks.stats(stats);
  const cancelled = env.isCancelled && env.isCancelled();
  stage('links', { state: cancelled ? 'cancelled' : 'done', done, total: files.length, label: '' });
  if (skipped.exists) log(`Атрибут уже есть в ${skipped.exists} заметках, например ${example.exists}`, 'warn');
  if (skipped.ignored) log(`Пропущено ${skipped.ignored} заметок: атрибут «${items.map((i) => i.name).join(', ')}» в списке «Игнорировать атрибуты»`, 'warn');
  if (skipped.reserved) log(`Пропущено ${skipped.reserved} заметок: имя атрибута совпадает с датой, Back или Next`, 'warn');
  log(`Атрибуты добавлены в ${changed} из ${files.length} найденных заметок${changed === 0 && files.length ? ' (в них уже есть эти атрибуты или они в списке игнорируемых)' : ''}`);
  return { status: cancelled ? 'cancelled' : 'ok', stats, pending: env.review.count };
}

module.exports = { runAddAttrs, runImport, runRecalc, finishReview, emptyStats };
