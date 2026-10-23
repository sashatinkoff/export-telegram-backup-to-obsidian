'use strict';
// Различия между десктопом и мобильным Obsidian. На десктопе есть Node (fs, path, crypto, zlib), на телефоне и
// планшете его нет: там всё идёт через файловый адаптер хранилища (vault.adapter), а пути считаются от корня хранилища.
// TGI_FORCE_MOBILE=1 (только для тестов в Node) включает путь телефона: адаптер хранилища, свой SHA-1 и DecompressionStream
const FORCE_MOBILE = typeof process !== 'undefined' && !!process.env && process.env.TGI_FORCE_MOBILE === '1';
const tryRequire = (name) => { try { return !FORCE_MOBILE && typeof require === 'function' ? require(name) : null; } catch (e) { return null; } };

const nodeFs = (() => { const m = tryRequire('fs'); return m && m.promises && m.createReadStream ? m : null; })();
const nodePath = tryRequire('path');
const nodeCrypto = (() => { const m = tryRequire('crypto'); return m && m.createHash ? m : null; })();
const nodeZlib = (() => { const m = tryRequire('zlib'); return m && m.inflateRaw ? m : null; })();
const nodeOs = tryRequire('os');

const isNative = !!(nodeFs && nodePath && nodeOs);

// ---------- пути ----------

// Запасной вариант модуля path с прямыми слэшами. Пусто или относительный путь — это путь от корня хранилища.
const parts = (p) => {
  const out = [];
  for (const s of String(p).split(/[\\/]+/)) {
    if (!s || s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); } else out.push(s);
  }
  return out;
};
const posix = {
  sep: '/',
  isAbsolute: (p) => String(p).startsWith('/'),
  normalize: (p) => parts(p).join('/'),
  join: (...a) => parts(a.filter(Boolean).join('/')).join('/'),
  resolve: (...a) => {
    let acc = [];
    for (const seg of a) {
      if (!seg) continue;
      if (posix.isAbsolute(seg)) acc = [];
      acc.push(seg);
    }
    return parts(acc.join('/')).join('/');
  },
  relative: (from, to) => {
    const f = parts(from);
    const t = parts(to);
    let i = 0;
    while (i < f.length && i < t.length && f[i] === t[i]) i++;
    return [...f.slice(i).map(() => '..'), ...t.slice(i)].join('/');
  },
  dirname: (p) => { const a = parts(p); a.pop(); return a.join('/'); },
  basename: (p, ext) => {
    const a = parts(p);
    let b = a.length ? a[a.length - 1] : '';
    if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
    return b;
  },
  extname: (p) => { const b = posix.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
};
const path = nodePath || posix;

// ---------- SHA-1 (на телефоне нет модуля crypto; результат тот же, что у crypto.createHash('sha1')) ----------

function sha1Js(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor((len * 8) / 0x100000000));
  dv.setUint32(total - 4, (len * 8) >>> 0);
  let h0 = 0x67452301; let h1 = 0xefcdab89; let h2 = 0x98badcfe; let h3 = 0x10325476; let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0; let b = h1; let c = h2; let d = h3; let e = h4;
    for (let i = 0; i < 80; i++) {
      let f; let k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; } else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; } else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; } else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rol(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rol(b, 30) >>> 0; b = a; a = t;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, '0')).join('');
}

const sha1Hex = (text) => (nodeCrypto ? nodeCrypto.createHash('sha1').update(text).digest('hex') : sha1Js(text));

// ---------- сжатие ----------

// Распаковка deflate без заголовка: Node zlib или встроенный в браузер DecompressionStream (iOS 16.4+, Android WebView 80+)
async function inflateRaw(bytes) {
  if (nodeZlib) {
    return new Promise((resolve, reject) => nodeZlib.inflateRaw(bytes, (e, out) => (e ? reject(e) : resolve(out))));
  }
  if (typeof DecompressionStream === 'undefined') throw new Error('Этот телефон не умеет распаковывать ZIP: обновите систему или распакуйте архив на компьютере');
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

// ---------- файлы ----------

let adapter = null; // vault.adapter (нужен на телефоне)
let pluginDirRel = ''; // папка плагина внутри хранилища
const init = (app, manifestDir) => { adapter = app.vault.adapter; pluginDirRel = manifestDir || ''; };

const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
const lastName = (p) => p.split('/').filter(Boolean).pop() || '';
const ap = (p) => (p === '' || p === '.' ? '/' : String(p).replace(/\\/g, '/'));

// Описание файла как у fs.stat
const statLike = (s) => ({
  size: s.size || 0,
  mtimeMs: s.mtime || 0,
  mtime: new Date(s.mtime || 0),
  atime: new Date(s.mtime || 0),
  isFile: () => s.type === 'file',
  isDirectory: () => s.type === 'folder',
});

const mobileFs = {
  async readFile(p) {
    const st = await adapter.stat(ap(p));
    if (!st || st.type !== 'file') throw enoent(p);
    return adapter.read(ap(p));
  },
  async readBytes(p) {
    const st = await adapter.stat(ap(p));
    if (!st || st.type !== 'file') throw enoent(p);
    return new Uint8Array(await adapter.readBinary(ap(p)));
  },
  async mkdir(p) {
    const segs = parts(p);
    let cur = '';
    for (const s of segs) {
      cur = cur ? `${cur}/${s}` : s;
      if (!(await adapter.exists(cur))) { try { await adapter.mkdir(cur); } catch (e) { if (!(await adapter.exists(cur))) throw e; } }
    }
  },
  async writeFile(p, data) {
    const dir = posix.dirname(p);
    if (dir && !(await adapter.exists(dir))) await mobileFs.mkdir(dir);
    if (typeof data === 'string') await adapter.write(ap(p), data);
    else await adapter.writeBinary(ap(p), data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  },
  async readdir(p, opts) {
    const st = await adapter.stat(ap(p));
    if (!st || st.type !== 'folder') throw enoent(p);
    const l = await adapter.list(ap(p));
    const names = [...l.folders.map((f) => ({ name: lastName(f), dir: true })), ...l.files.map((f) => ({ name: lastName(f), dir: false }))];
    if (opts && opts.withFileTypes) return names.map((n) => ({ name: n.name, isDirectory: () => n.dir, isFile: () => !n.dir }));
    return names.map((n) => n.name);
  },
  async stat(p) {
    if (p === '' || p === '.') return statLike({ type: 'folder', mtime: 0, size: 0 });
    const st = await adapter.stat(ap(p));
    if (!st) throw enoent(p);
    return statLike(st);
  },
  async exists(p) { return p === '' ? true : adapter.exists(ap(p)); },
  async unlink(p) { await adapter.remove(ap(p)); },
  async rmdir(p) {
    const l = await adapter.list(ap(p));
    if (l.files.length || l.folders.length) throw Object.assign(new Error('ENOTEMPTY'), { code: 'ENOTEMPTY' });
    await adapter.rmdir(ap(p), false);
  },
  async rm(p) {
    if (!(await adapter.exists(ap(p)))) return;
    const st = await adapter.stat(ap(p));
    if (st && st.type === 'folder') await adapter.rmdir(ap(p), true); else await adapter.remove(ap(p));
  },
  async rename(a, b) {
    if (await adapter.exists(ap(b))) await adapter.remove(ap(b));
    await adapter.rename(ap(a), ap(b));
  },
  async copyFile(from, to) {
    if (await adapter.exists(ap(to))) throw Object.assign(new Error(`EEXIST: ${to}`), { code: 'EEXIST' });
    const dir = posix.dirname(to);
    if (dir && !(await adapter.exists(dir))) await mobileFs.mkdir(dir);
    await adapter.copy(ap(from), ap(to));
  },
  async utimes() { /* адаптер не умеет менять дату файла */ },
  async makeTemp(prefix) {
    const dir = posix.join(pluginDirRel, `${prefix}${Date.now().toString(36)}`);
    await mobileFs.mkdir(dir);
    return dir;
  },
};

const nodeFsx = nodeFs ? {
  readFile: (p) => nodeFs.promises.readFile(p, 'utf8'),
  readBytes: (p) => nodeFs.promises.readFile(p),
  mkdir: (p) => nodeFs.promises.mkdir(p, { recursive: true }),
  writeFile: async (p, data) => {
    try {
      await nodeFs.promises.writeFile(p, data, typeof data === 'string' ? 'utf8' : undefined);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      await nodeFs.promises.mkdir(nodePath.dirname(p), { recursive: true });
      await nodeFs.promises.writeFile(p, data, typeof data === 'string' ? 'utf8' : undefined);
    }
  },
  readdir: (p, opts) => nodeFs.promises.readdir(p, opts),
  stat: (p) => nodeFs.promises.stat(p),
  exists: (p) => nodeFs.promises.access(p).then(() => true, () => false),
  unlink: (p) => nodeFs.promises.unlink(p),
  rmdir: (p) => nodeFs.promises.rmdir(p),
  rm: (p) => nodeFs.promises.rm(p, { recursive: true, force: true }),
  rename: (a, b) => nodeFs.promises.rename(a, b),
  copyFile: (a, b) => nodeFs.promises.copyFile(a, b, nodeFs.constants.COPYFILE_EXCL),
  utimes: (p, a, m) => nodeFs.promises.utimes(p, a, m),
  makeTemp: (prefix) => nodeFs.promises.mkdtemp(nodePath.join(nodeOs.tmpdir(), prefix)),
} : null;

const fsx = isNative ? nodeFsx : mobileFs;

// Базовый путь хранилища: на десктопе абсолютный, на телефоне пустой (все пути от корня хранилища)
const vaultBase = (app) => (isNative && app.vault.adapter.getBasePath ? app.vault.adapter.getBasePath() : '');

module.exports = { isNative, nodeFs, path, posix, sha1Hex, sha1Js, inflateRaw, fsx, init, vaultBase };
