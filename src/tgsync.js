'use strict';
// Синхронизация с Telegram через API: плагин запускает Python-скрипт tg_export.py (Telethon), тот выгружает чат
// в формат экспорта Telegram Desktop (result.json и медиа), а дальше работает обычный импорт. Только для компьютера.
const { fsx, path } = require('./platform');
const { parseAttributes } = require('./links');

// Есть ли Node (компьютер): на телефоне запустить Python нельзя
const isDesktop = () => { try { return typeof require('child_process').spawn === 'function'; } catch (e) { return false; } };
const IS_WIN = () => process.platform === 'win32';
const nodeOs = () => require('os');
const cp = () => require('child_process');

// Папка настроек вне хранилища: здесь ключи API, сессия (доступ к аккаунту), виртуальное окружение и выгрузка.
// Она не попадает в синхронизацию хранилища (Syncthing и т. п.), поэтому ключи не расходятся по устройствам
let cachedDir = null;
function configDir() {
  if (process.env.TGI_CONFIG_DIR) return process.env.TGI_CONFIG_DIR;
  if (cachedDir) return cachedDir;
  const home = nodeOs().homedir();
  // Первая папка, где можно создавать и писать: ~/.config бывает создан от имени root, тогда берём следующую
  const list = IS_WIN()
    ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'telegram-import')]
    : [path.join(home, '.config', 'telegram-import'), path.join(home, 'Library', 'Application Support', 'telegram-import'), path.join(home, '.local', 'share', 'telegram-import')];
  const fs = require('fs');
  for (const dir of list) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); cachedDir = dir; return dir; } catch (e) { /* пробуем следующую */ }
  }
  cachedDir = list[0];
  return cachedDir;
}
const sessionPath = () => path.join(configDir(), 'session');
const venvDir = () => path.join(configDir(), 'venv');
const venvPython = () => (IS_WIN() ? path.join(venvDir(), 'Scripts', 'python.exe') : path.join(venvDir(), 'bin', 'python'));
const defaultExportDir = () => path.join(configDir(), 'export');

async function loadCreds() {
  try { return JSON.parse(await fsx.readFile(path.join(configDir(), 'credentials.json'), 'utf8')); } catch (e) { return { apiId: '', apiHash: '' }; }
}
async function saveCreds({ apiId, apiHash }) {
  await fsx.mkdir(configDir(), { recursive: true });
  const file = path.join(configDir(), 'credentials.json');
  await fsx.writeFile(file, JSON.stringify({ apiId: String(apiId || '').trim(), apiHash: String(apiHash || '').trim() }), 'utf8');
  try { require('fs').chmodSync(file, 0o600); } catch (e) { /* не везде поддерживается */ }
}
const hasSession = () => fsx.exists(`${sessionPath()}.session`);
async function dropSession() {
  for (const f of [`${sessionPath()}.session`, `${sessionPath()}.session-journal`]) await fsx.unlink(f).catch(() => {});
}

// Запуск и разбор вывода ------------------------------------------------------------------------------------------------

// Запуск короткой команды с жёстким ограничением по времени: по истечении процесс убивается (SIGKILL), а ожидание
// всё равно завершается. Так зависший процесс (например, заглушка python3 на Mac без средств разработчика, которая
// открывает окно установки) не может подвесить плагин. stdin закрыт, чтобы процесс ничего не ждал от нас.
function execOnce(exe, args, timeout = 8000) {
  return new Promise((resolve) => {
    let child;
    let out = '';
    let err = '';
    let finished = false;
    let timer = null;
    const finish = (e) => { if (finished) return; finished = true; clearTimeout(timer); resolve({ err: e, stdout: out, stderr: err }); };
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* уже завершился */ } finish(new Error('превышено время ожидания')); }, timeout);
    try {
      child = cp().spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (e) { finish(e); return; }
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(code ? new Error(`код ${code}`) : null));
  });
}

// Рабочий ли это Python 3.8+. Возвращает { exe, version } или null
async function probePython(exe) {
  const r = await execOnce(exe, ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'], 8000);
  if (r.err) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout);
  if (!m || Number(m[1]) < 3 || (Number(m[1]) === 3 && Number(m[2]) < 8)) return m ? { exe, version: m[0], tooOld: true } : null;
  return { exe, version: m[0] };
}

// Obsidian запускается не из терминала и часто не видит PATH, поэтому, кроме python3 и python, пробуем типичные места
function pythonCandidates(preferred) {
  const list = [];
  if (preferred && preferred.trim()) list.push(preferred.trim());
  if (IS_WIN()) list.push('py', 'python', 'python3', path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'));
  else {
    list.push('python3', 'python', '/opt/homebrew/bin/python3', '/usr/local/bin/python3');
    // /usr/bin/python3 на Mac без Command Line Tools лишь заглушка, которая открывает окно установки: берём её только если средства есть
    const real = process.platform !== 'darwin' || require('fs').existsSync('/Library/Developer/CommandLineTools/usr/bin/python3') || require('fs').existsSync('/Applications/Xcode.app');
    if (real) list.push('/usr/bin/python3');
  }
  return [...new Set(list)];
}

async function findPython(preferred) {
  let old = null;
  for (const exe of pythonCandidates(preferred)) {
    const r = await probePython(exe);
    if (r && !r.tooOld) return r;
    if (r && r.tooOld && !old) old = r;
  }
  return old ? { ...old, error: `Найден Python ${old.version} (${old.exe}), нужен 3.8 или новее` } : null;
}

// Запускает tg_export.py. opts: { python, script, args, env, onEvent(ev), onAsk(key, prompt) -> Promise<string|null>, isCancelled() }
// Возвращает { code, error, last } (last — последнее событие done)
function runPy(opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cp().spawn(opts.python, ['-u', opts.script, ...opts.args], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', ...(opts.env || {}) }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { resolve({ code: -1, error: String(e.message || e) }); return; }
    let error = null;
    let last = null;
    let tail = '';
    let buf = '';
    let chain = Promise.resolve();
    let killed = false;
    const kill = () => { killed = true; try { child.kill(); } catch (e) { /* уже завершился */ } };
    const timer = opts.isCancelled ? setInterval(() => { if (opts.isCancelled()) kill(); }, 300) : null;

    const handle = async (ev) => {
      if (ev.event === 'error') error = ev.message || 'ошибка';
      if (ev.event === 'done') last = ev;
      if (ev.event === 'ask') {
        let answer = null;
        try { answer = opts.onAsk ? await opts.onAsk(ev.key, ev.prompt) : null; } catch (e) { answer = null; }
        if (answer === null || answer === undefined) { kill(); return; }
        child.stdin.write(`${JSON.stringify(String(answer))}\n`);
        return;
      }
      if (opts.onEvent) opts.onEvent(ev);
    };
    const line = (l) => {
      if (!l.trim()) return;
      let ev = null;
      try { ev = JSON.parse(l); } catch (e) { /* не JSON: просто вывод */ }
      chain = chain.then(() => (ev && ev.event ? handle(ev) : opts.onEvent && opts.onEvent({ event: 'log', level: 'info', message: l }))).catch(() => {});
    };
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', (d) => { tail = (tail + d.toString('utf8')).slice(-1500); });
    child.on('error', (e) => { error = error || String(e.message || e); });
    child.on('close', (code) => {
      if (timer) clearInterval(timer);
      if (buf.trim()) line(buf);
      chain.then(() => resolve({ code, error: error || (code && !killed ? (tail.trim().split('\n').slice(-3).join(' | ') || `Python завершился с кодом ${code}`) : null), last, killed }));
    });
  });
}

// Установка ---------------------------------------------------------------------------------------------------------------

function runCmd(exe, args, onLine, isCancelled) {
  return new Promise((resolve) => {
    let child;
    try {
      child = cp().spawn(exe, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8', PIP_DISABLE_PIP_VERSION_CHECK: '1' }, windowsHide: true });
    } catch (e) { resolve({ code: -1, tail: String(e.message || e) }); return; }
    let tail = '';
    const feed = (d) => { const s = d.toString('utf8'); tail = (tail + s).slice(-1500); s.split(/\r?\n/).filter(Boolean).forEach((l) => onLine && onLine(l)); };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    const timer = isCancelled ? setInterval(() => { if (isCancelled()) { try { child.kill(); } catch (e) { /* уже завершился */ } } }, 300) : null;
    let done = false;
    const end = (code) => { if (done) return; done = true; if (timer) clearInterval(timer); resolve({ code, tail }); };
    child.on('error', (e) => { tail += `${e.code ? `${e.code}: ` : ''}${String(e.message || e)}`; end(-1); });
    child.on('close', (code) => end(code));
  });
}

// Создаёт виртуальное окружение рядом с настройками и ставит туда Telethon (системный Python не трогается)
const accessHint = (e, what) => (e && (e.code === 'EACCES' || e.code === 'EPERM')
  ? `Нет прав на запись: ${e.path || what}. Проверьте владельца папки (в Терминале: ls -ld "${e.path || what}") или удалите её, если она создана от имени root.`
  : String((e && e.message) || e));

async function setupEnv({ preferred, onLog, isCancelled }) {
  const log = (m) => onLog && onLog(m);
  log('Ищу Python…');
  const found = await findPython(preferred);
  if (!found) return { ok: false, error: 'Python не найден. Установите Python 3.8 или новее (см. инструкцию) или укажите путь к нему в настройке «Python».' };
  if (found.error) return { ok: false, error: found.error };
  log(`Найден Python ${found.version}: ${found.exe}`);
  log(`Папка данных: ${configDir()}`);
  try { await fsx.mkdir(configDir(), { recursive: true }); } catch (e) { return { ok: false, error: accessHint(e, configDir()) }; }
  if (!(await fsx.exists(venvPython()))) {
    log('Создаю виртуальное окружение…');
    const r = await runCmd(found.exe, ['-m', 'venv', venvDir()], log, isCancelled);
    if (r.code !== 0) {
      const hint = /ensurepip|venv/i.test(r.tail) ? ' На Linux может понадобиться пакет python3-venv.' : '';
      const perm = /EACCES|EPERM|Permission denied/i.test(r.tail) ? ` Нет прав на запись или запуск: проверьте путь «${found.exe}» и папку ${venvDir()}.` : '';
      return { ok: false, error: `Не удалось создать окружение: ${r.tail.trim().split('\n').slice(-2).join(' ')}.${hint}${perm}` };
    }
  }
  log('Устанавливаю Telethon (может занять минуту)…');
  const r = await runCmd(venvPython(), ['-m', 'pip', 'install', '--upgrade', '--no-cache-dir', 'telethon', 'python-socks[asyncio]', 'qrcode'], log, isCancelled);
  if (r.code !== 0) return { ok: false, error: `Не удалось установить Telethon: ${r.tail.trim().split('\n').slice(-2).join(' ')}` };
  log('Готово');
  return { ok: true, python: venvPython() };
}

// Какой Python использовать: окружение плагина, если оно создано, иначе найденный по настройке/автоопределению
async function resolvePython(preferred) {
  if (await fsx.exists(venvPython())) return { exe: venvPython(), venv: true };
  const f = await findPython(preferred);
  return f && !f.error ? { exe: f.exe, venv: false } : null;
}

async function checkEnv({ preferred, script }) {
  const py = await resolvePython(preferred);
  if (!py) return { ok: false, text: 'Python не найден' };
  const events = [];
  let timedOut = false;
  const started = Date.now();
  const r = await runPy({ python: py.exe, script, args: ['check'], onEvent: (e) => events.push(e), isCancelled: () => { if (Date.now() - started > 20000) { timedOut = true; return true; } return false; } });
  if (timedOut) return { ok: false, text: 'Python не ответил за 20 секунд', python: py.exe };
  const ev = events.find((e) => e.event === 'check');
  if (!ev) return { ok: false, text: r.error || 'Скрипт не ответил', python: py.exe };
  if (!ev.telethon) return { ok: false, text: `Python ${ev.python}: Telethon не установлен`, python: py.exe };
  return { ok: true, text: `Python ${ev.python}, Telethon ${ev.telethon}${py.venv ? ' (окружение плагина)' : ''}`, python: py.exe };
}

// Период ---------------------------------------------------------------------------------------------------------------

const p2 = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
const NOTE_NAME_RE = /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:.](\d{2})[-:.](\d{2})/;

// Дата самой свежей заметки по имени файла (местное время) или null
function newestNoteDate(files) {
  let best = null;
  for (const f of files) {
    const m = NOTE_NAME_RE.exec(path.basename(f));
    if (!m) continue;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (!best || d > best) best = d;
  }
  return best;
}

// Значения атрибута name в шапке заметки (список или одно значение); пусто, если атрибута нет. Регистр имени не важен
function attrValues(text, name) {
  for (const [k, v] of parseAttributes(text.replace(/\r\n/g, '\n'))) {
    if (k.toLowerCase() !== name.toLowerCase()) continue;
    return (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return [];
}

// Самая свежая (по дате в имени файла) заметка, у которой есть атрибут attr = { name, value } с этим значением (без учёта регистра).
// Файлы читаются от новых к старым, только начало (шапка), и до первой подходящей. Возвращает { date, scanned, others }:
// date — Date или null, scanned — сколько заметок просмотрено, others — другие значения этого атрибута, встретившиеся раньше (для подсказки)
async function lastNoteByAttr(files, attr) {
  const dated = [];
  for (const f of files) {
    const m = NOTE_NAME_RE.exec(path.basename(f));
    if (m) dated.push({ f, t: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) });
  }
  dated.sort((a, b) => b.t - a.t);
  const want = String(attr.value).trim().toLowerCase();
  const others = new Set();
  let scanned = 0;
  for (const { f, t } of dated) {
    let text;
    try { text = await fsx.readFile(f, 'utf8'); } catch (e) { continue; }
    scanned++;
    const vals = attrValues(text.slice(0, 4000), attr.name);
    if (vals.some((v) => v.toLowerCase() === want)) return { date: t, scanned, others: [...others] };
    for (const v of vals) if (others.size < 3) others.add(v);
  }
  return { date: null, scanned, others: [...others] };
}

const OVERLAP_MS = 60 * 60 * 1000; // запас назад от последней заметки: её группа сообщений должна прийти целиком
// Границы выгрузки по настройкам: { since, until } в виде строк ГГГГ-ММ-ДДTЧЧ:ММ:СС (местное время) или null
function periodBounds(settings, lastNote) {
  if (settings.tgPeriod === 'range') {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(settings.tgFrom || '') ? `${settings.tgFrom}T00:00:00` : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(settings.tgTo || '') ? `${settings.tgTo}T23:59:59` : null;
    return { since: from, until: to };
  }
  if (settings.tgPeriod === 'all') return { since: null, until: null };
  return { since: lastNote ? localIso(new Date(lastNote.getTime() - OVERLAP_MS)) : null, until: null };
}

module.exports = {
  isDesktop, configDir, sessionPath, venvDir, venvPython, defaultExportDir, loadCreds, saveCreds, hasSession, dropSession,
  attrValues, lastNoteByAttr, probePython, findPython, pythonCandidates, runPy, setupEnv, resolvePython, checkEnv, newestNoteDate, periodBounds, localIso,
};
