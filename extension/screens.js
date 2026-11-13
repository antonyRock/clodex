// «Скриншоты» — выдвижная плашка внизу панели Clodex.
// Снимки с айфона: команды «Скрин в Clodex» / «В Clodex» кладут их в iCloud Drive → Команды → Clodex,
// отсюда они переносятся в папку скриншотов и показываются сеткой миниатюр.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();
const DEFAULT_DIR = path.join(HOME, 'Claude_AI', '06_Загрузки', '05_Скриншоты');
const INBOX = path.join(HOME, 'Library', 'Mobile Documents', 'iCloud~is~workflow~my~workflows', 'Documents', 'Clodex');
const IMAGE = /\.(png|jpe?g|heic|webp|gif)$/i;
const PHOTOS_ORIGINALS = path.join(HOME, 'Pictures', 'Photos Library.photoslibrary', 'originals');
const PHOTO_POLL_MS = 6000;
const POLL_MS = 5000;
const MAX = 60;

function run(cmd, args, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || err || '') }));
  });
}

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

class ScreensView {
  constructor(ctx, log) {
    this.ctx = ctx;
    this.log = log;
    // Пустой виртуальный документ с путём брошенного файла: нужен только чтобы команда Claude
    // «Insert @-Mention» взяла путь. С диска ничего не читается.
    ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('clodex-mention', { provideTextDocumentContent: () => '' }));
    this.view = undefined;
    this.shots = [];
    this.seen = new Set(ctx.globalState.get('screens.seen', []));
    this.thumbDir = path.join(ctx.globalStorageUri.fsPath, 'screens-thumbs');
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.busy = false;
    this.thumbs = new Map(); this.thumbTries = new Map(); this.alias = new Map(); this.rev = new Map();
    this.watchPhotos();
    this.cleanCache();
    this.cleanTimer = setInterval(() => this.cleanCache(), 3600000);
    ctx.subscriptions.push({ dispose: () => clearInterval(this.cleanTimer) });
    this.timer = setInterval(() => { if (this.autoOn()) this.scan(); }, POLL_MS);
    ctx.subscriptions.push({ dispose: () => clearInterval(this.timer) });
    this.scan();
  }

  // Автообновление снимков и фото раз в 5 с — тумблер на плашке «Скриншоты и файлы» (0.9.58: касается только снимков; список чатов обновляется всегда; по умолчанию включено)
  autoOn() { return !!this.ctx.globalState.get('autoRefresh.v2', true); }

  dir() {
    const v = vscode.workspace.getConfiguration('clodex').get('screenshotsDir');
    return v ? v.replace(/^~(?=\/|$)/, HOME) : DEFAULT_DIR;
  }

  // Перенести снимки из iCloud («Команды/Clodex») в папку скриншотов
  async pullInbox() {
    let names;
    try { names = fs.readdirSync(INBOX); } catch { return; }
    const dir = this.dir();
    for (const name of names) {
      const cloud = /^\.(.+)\.icloud$/.exec(name);
      if (cloud) { await run('brctl', ['download', path.join(INBOX, cloud[1])]); continue; }
      if (name.startsWith('.') || !IMAGE.test(name)) continue;
      const from = path.join(INBOX, name);
      let st; try { st = fs.statSync(from); } catch { continue; }
      if (!st.isFile() || Date.now() - st.mtimeMs < 2000) continue; // ещё пишется
      const ext = path.extname(name).toLowerCase() || '.png';
      fs.mkdirSync(dir, { recursive: true });
      let to = path.join(dir, `Скрин_${stamp(st.mtimeMs)}${ext}`);
      if (fs.existsSync(to)) to = path.join(dir, `Скрин_${stamp(st.mtimeMs)}_${Math.random().toString(36).slice(2, 6)}${ext}`);
      try { fs.renameSync(from, to); }
      catch { try { fs.copyFileSync(from, to); fs.unlinkSync(from); } catch (e) { this.log.error('скриншоты: не перенёс ' + name + ': ' + e); } }
    }
  }

  // Новые фото с айфона: iCloud Фото кладёт оригиналы в библиотеку «Фото» на Mac (с 0.9.37).
  // Берём изображения, появившиеся за последние N часов (настройка clodex.photosHours; 0 — выключено).
  // Оригиналы не копируются и не меняются; HEIC для отправки в чат конвертируется в JPEG в кэше.
  async scanPhotos(force) {
    const hours = Number(vscode.workspace.getConfiguration('clodex').get('photosHours', 24));
    if (!(hours > 0)) return [];
    if (!force && this.photos && Date.now() - this.photosAt < PHOTO_POLL_MS) return this.photos;
    this.photosAt = Date.now();
    if (!fs.existsSync(PHOTOS_ORIGINALS)) { this.photos = []; return this.photos; }
    const r = await run('find', [PHOTOS_ORIGINALS, '-type', 'f', '-mmin', '-' + Math.round(hours * 60)], 30000);
    if (!r.ok && !r.stdout) {
      if (!this.photosErr) { this.photosErr = true; this.log.error('фото: библиотека «Фото» недоступна: ' + r.stderr.slice(0, 200)); }
      this.photos = []; return this.photos;
    }
    const out = [];
    for (const p of r.stdout.split('\n')) {
      if (!p || !IMAGE.test(p)) continue;
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (!st.isFile() || Date.now() - st.mtimeMs < 2500) continue; // ещё загружается
      out.push({ name: path.basename(p), path: p, mtimeMs: st.mtimeMs, size: st.size, photo: true });
    }
    this.photos = out;
    return out;
  }

  // JPEG-копии HEIC для отправки в чат делаем уже после показа ленты, чтобы не задерживать миниатюры
  async convertPhotos(list) {
    if (this.converting) return;
    this.converting = true;
    try {
      let changed = false;
      for (const f of list.filter((x) => x.photo)) {
        if (this.alias.has(f.path)) continue;
        const u = await this.usable(f);
        if (u !== f.path) { this.alias.set(f.path, u); this.rev.set(u, f.path); changed = true; }
      }
      if (changed) this.push();
    } catch (e) { this.log.error('фото: ' + e); } finally { this.converting = false; }
  }

  // Файл, который можно отправить в чат: HEIC/WEBP → JPEG в кэше (оригинал не трогаем)
  async usable(f) {
    if (!f.photo || !/\.(heic|webp)$/i.test(f.path)) return f.path;
    // Claude и Codex всё равно уменьшают картинку, поэтому копия не больше 2048 px по длинной стороне (≈0,5 МБ)
    const out = path.join(this.thumbDir, `${path.basename(f.path)}.${Math.round(f.mtimeMs)}.f2k.jpg`);
    if (!fs.existsSync(out)) await run('sips', ['-Z', '2048', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', f.path, '--out', out], 60000);
    return fs.existsSync(out) ? out : f.path;
  }

  // Старый кэш миниатюр и JPEG-копий: файлы старше 3 дней удаляются (при запуске и раз в час)
  cleanCache() {
    try {
      const limit = Date.now() - 3 * 86400000;
      for (const n of fs.readdirSync(this.thumbDir)) {
        const f = path.join(this.thumbDir, n);
        try { const st = fs.statSync(f); if (/\.full\.jpg$/.test(n) || st.mtimeMs < limit) fs.unlinkSync(f); } catch { }
      }
    } catch { }
  }

  // То же, но если JPEG-копии ещё нет (фон не успел) — сделать сейчас, чтобы не открылся «голый» HEIC
  async ensureUse(p) {
    if (this.alias.has(p)) return this.alias.get(p);
    const f = this.shots.find((s) => s.path === p);
    if (f && f.photo) {
      const u = await this.usable(f);
      if (u !== f.path) { this.alias.set(f.path, u); this.rev.set(u, f.path); }
      return u;
    }
    return p;
  }

  // Путь из панели → путь для отправки / открытия
  use(p) { return (this.alias && this.alias.get(p)) || p; }
  orig(p) { return (this.rev && this.rev.get(p)) || p; }

  async thumb(file, mtimeMs) {
    const out = path.join(this.thumbDir, `${path.basename(file)}.${Math.round(mtimeMs)}.jpg`);
    if (fs.existsSync(out)) return out;
    const r = await run('sips', ['-Z', '520', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', file, '--out', out]);
    return r.ok && fs.existsSync(out) ? out : undefined;
  }

  async scan(force) {
    // идёт другой проход — запомнить просьбу «обновить сейчас» и выполнить сразу после него
    if (this.busy) { if (force) this.again = true; return; }
    this.busy = true;
    try {
      await this.pullInbox();
      const dir = this.dir();
      let names = [];
      try { names = fs.readdirSync(dir); } catch { /* папки ещё нет */ }
      const files = [];
      for (const name of names) {
        if (name.startsWith('.') || !IMAGE.test(name)) continue;
        const p = path.join(dir, name);
        try { const st = fs.statSync(p); if (st.isFile()) files.push({ name, path: p, mtimeMs: st.mtimeMs, size: st.size }); } catch { }
      }
      const photos = await this.scanPhotos(force);
      files.push(...photos);
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const top = files.slice(0, MAX);
      const sig = top.map((f) => f.name + f.mtimeMs).join('|');
      // не вышла миниатюра — пробуем снова на следующем проходе (до 5 раз), а не запоминаем поломку
      const retry = top.some((f) => !this.thumbs.get(f.path + f.mtimeMs) && (this.thumbTries.get(f.path + f.mtimeMs) || 0) < 5);
      if (!force && !retry && sig === this.sig) return;
      this.sig = retry ? undefined : sig;
      const first = this.shots.length === 0 && this.seen.size === 0;
      // миниатюры — по 4 сразу
      const queue = top.filter((f) => !this.thumbs.get(f.path + f.mtimeMs));
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let f; (f = queue.shift());) {
          const key = f.path + f.mtimeMs;
          this.thumbTries.set(key, (this.thumbTries.get(key) || 0) + 1);
          const t = await this.thumb(f.path, f.mtimeMs);
          if (t) this.thumbs.set(key, t);
          else if (this.thumbTries.get(key) >= 5) this.log.error('миниатюра не получилась: ' + f.name);
        }
      }));
      for (const f of top) f.thumb = this.thumbs.get(f.path + f.mtimeMs);
      this.shots = top;
      this.convertPhotos(top);
      this.total = files.length;
      if (first) { for (const f of top) this.seen.add(f.path); this.saveSeen(); }
      this.updateBadge();
      this.push();
    } catch (e) {
      this.log.error('скриншоты: ' + (e && e.stack || e));
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; setTimeout(() => this.scan(true), 100); }
    }
  }

  // Новый файл в библиотеке «Фото» → обновить ленту почти сразу (а не ждать опроса)
  watchPhotos() {
    try {
      if (!fs.existsSync(PHOTOS_ORIGINALS)) return;
      let t;
      const w = fs.watch(PHOTOS_ORIGINALS, { recursive: true }, (ev, name) => {
        if (name && !IMAGE.test(String(name))) return;
        clearTimeout(t);
        t = setTimeout(() => { if (this.autoOn()) this.scan(true); }, 1200);
      });
      w.on('error', (e) => this.log.error('фото: слежение за библиотекой остановилось: ' + e));
      this.ctx.subscriptions.push({ dispose: () => { try { w.close(); } catch { } clearTimeout(t); } });
    } catch (e) { this.log.error('фото: слежение не запустилось: ' + e); }
  }

  isPhoto(p) { return p.startsWith(PHOTOS_ORIGINALS + path.sep); }

  unseen() { return this.shots.filter((s) => !this.seen.has(s.path)); }
  saveSeen() {
    const keep = this.shots.map((s) => s.path).filter((p) => this.seen.has(p));
    this.seen = new Set(keep);
    this.ctx.globalState.update('screens.seen', keep);
  }
  updateBadge() { /* счётчик новых — на плашке «Скриншоты» */ }
  markSeen(p) {
    if (p) this.seen.add(this.orig(p)); else for (const s of this.shots) this.seen.add(s.path);
    this.saveSeen(); this.updateBadge(); this.push();
  }

  push() {
    if (!this.view) return;
    const w = this.view.webview;
    const now = Date.now();
    this.view.webview.postMessage({
      type: 'shots',
      dir: this.dir(),
      total: this.total || 0,
      items: this.shots.map((s) => ({
        path: s.path, name: s.name, mtimeMs: s.mtimeMs, ago: now - s.mtimeMs, photo: !!s.photo,
        src: w.asWebviewUri(vscode.Uri.file(s.thumb || s.path)).toString(),
        uri: vscode.Uri.file(this.use(s.path)).toString(),
        isNew: !this.seen.has(s.path),
      })),
    });
  }

  // В какой чат отправлять: по активной вкладке (Codex — вкладка chatgpt.*, Claude — claudeVSCodePanel).
  // Вкладки нет (чат в боковой панели) — последний агент, чей чат открывали через Clodex; иначе Claude.
  targetAgent() {
    const kind = (t) => {
      const v = t && t.input && t.input.viewType ? String(t.input.viewType) : '';
      const u = t && t.input && t.input.uri ? String(t.input.uri) : '';
      if (/claudeVSCodePanel/.test(v)) return 'claude';
      if (/chatgpt|codex/i.test(v) || /^openai-codex:/.test(u)) return 'codex';
      return null;
    };
    const groups = vscode.window.tabGroups;
    const first = kind(groups.activeTabGroup && groups.activeTabGroup.activeTab);
    if (first) return first;
    for (const g of groups.all) { const k = kind(g.activeTab); if (k) return k; }
    const last = globalThis.__clodexLastAgent;
    if (last === 'codex' && vscode.extensions.getExtension('openai.chatgpt')) return 'codex';
    return 'claude';
  }

  // Codex: команда его расширения «Add File to Codex Chat» (chatgpt.addFileToThread) принимает Uri файла.
  async toCodex(paths) {
    let n = 0;
    for (const p of paths) {
      try { await vscode.commands.executeCommand('chatgpt.addFileToThread', vscode.Uri.file(p)); n++; }
      catch (e) { this.log.error('в чат Codex не вышло: ' + (e && e.message || e)); }
    }
    if (!n) { vscode.window.showWarningMessage('Не удалось добавить файл в чат Codex.'); return false; }
    vscode.window.setStatusBarMessage(n === 1 ? '$(check) Файл — в чате Codex' : `$(check) Файлов в чате Codex: ${n}`, 2500);
    return true;
  }

  // «В чат»: Codex — через его команду; Claude — снимок в буфер обмена, фокус в поле Claude, вставка ⌘V
  async toChat(p) {
    this.markSeen(p);
    this.log.info('в чат: ' + p);
    return this.pastePaths([p]);
  }

  // Старый способ (картинка через буфер обмена и ⌘V) — запасной, сейчас не используется
  async toChatImage(p) {
    if (this.targetAgent() === 'codex') return this.toCodex([p]);
    let file = p;
    if (!/\.(png|jpe?g)$/i.test(p)) {
      const out = path.join(this.thumbDir, path.basename(p) + '.png');
      await run('sips', ['-s', 'format', 'png', p, '--out', out]);
      file = out;
    }
    const cls = /\.jpe?g$/i.test(file) ? 'JPEG' : 'PNGf';
    const esc = file.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const c = await run('osascript', ['-e', `set the clipboard to (read (POSIX file "${esc}") as «class ${cls}»)`]);
    if (!c.ok) { await vscode.env.clipboard.writeText(`@"${p}"`); vscode.window.showWarningMessage('Картинку в буфер положить не вышло — скопирован путь. Вставьте в чат ⌘V.'); return; }
    try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { }
    await new Promise((r) => setTimeout(r, 450));
    const k = await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    if (!k.ok) vscode.window.showInformationMessage('Снимок в буфере обмена — нажмите ⌘V в поле чата.');
  }

  mention(p) {
    const rel = vscode.workspace.asRelativePath(vscode.Uri.file(p), false);
    const r = rel === p ? p : rel;
    return /\s/.test(r) ? `@"${r}"` : `@${r}`;
  }

  // Несколько снимков → ссылки @путь в поле чата (через буфер обмена и ⌘V)
  async mentionsToChat(paths) {
    if (!paths || !paths.length) return;
    if (paths.length === 1) return this.toChat(paths[0]);
    for (const p of paths) this.seen.add(this.orig(p));
    this.saveSeen(); this.updateBadge(); this.push();
    this.log.info('в чат (несколько): ' + paths.length);
    return this.pastePaths(paths);
  }

  async copyMany(paths) {
    await vscode.env.clipboard.writeText(paths.join('\n'));
    vscode.window.setStatusBarMessage(`$(check) Скопировано путей: ${paths.length}`, 2500);
  }

  async copyPath(p) {
    this.markSeen(p);
    await vscode.env.clipboard.writeText(p);
    vscode.window.setStatusBarMessage('$(check) Путь скопирован', 2500);
  }

  async open(p) {
    this.markSeen(p);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(p), { preview: true });
  }

  async trash(p) {
    if (this.isPhoto(p)) { vscode.window.showInformationMessage('Фото из библиотеки «Фото» отсюда не удаляются — удаляйте в приложении «Фото».'); return; }
    const ok = await vscode.window.showWarningMessage(`Убрать «${path.basename(p)}» в Корзину?`, { modal: true }, 'В Корзину');
    if (ok !== 'В Корзину') return;
    await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true });
    this.scan(true);
  }

  async trashMany(paths) {
    if (!paths || !paths.length) return;
    if (paths.some((p) => this.isPhoto(p))) {
      paths = paths.filter((p) => !this.isPhoto(p));
      vscode.window.showInformationMessage('Фото из библиотеки «Фото» отсюда не удаляются — они пропущены.');
      if (!paths.length) return;
    }
    if (paths.length === 1) return this.trash(paths[0]);
    const ok = await vscode.window.showWarningMessage(`Убрать ${paths.length} снимков в Корзину?`, { modal: true }, 'В Корзину');
    if (ok !== 'В Корзину') return;
    for (const p of paths) { try { await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true }); } catch (e) { this.log.error('скриншоты: ' + e); } }
    this.scan(true);
  }

  // ---------- файл из Finder брошен на панель → путь в чат Claude (с 0.9.15) ----------
  // Браузерная часть панели знает только имя, размер и время изменения файла.
  // Путь: ссылка file://, если Finder её дал; иначе Spotlight по имени со сверкой размера и времени;
  // иначе обход обычных папок (рабочая, Рабочий стол, Загрузки, Документы, Яндекс Диск).
  async dropFiles(m) {
    this.log.info('перетаскивание: типы ' + JSON.stringify(m.types || []) + ', файлов ' + ((m.files || []).length));
    const found = [];
    const add = (p) => { if (p && !found.includes(p) && fs.existsSync(p)) found.push(p); };
    for (const block of m.uris || []) {
      let lines = String(block).split(/\r?\n/);
      try { const j = JSON.parse(block); if (Array.isArray(j)) lines = j; } catch { }
      for (const s of lines) if (/^file:/.test(String(s).trim())) { try { add(vscode.Uri.parse(String(s).trim()).fsPath); } catch { } }
    }
    const missing = [];
    for (const f of m.files || []) {
      this.log.info('перетаскивание: файл ' + JSON.stringify({ name: f.name, size: f.size, mtime: f.mtime, path: f.path ? 'есть' : 'нет' }));
      if (f.path) { add(f.path); continue; }
      if (found.some((p) => path.basename(p) === f.name)) continue;
      const p = await this.findFile(f);
      if (p) add(p); else missing.push(f.name);
    }
    this.log.info('перетаскивание: найдено ' + JSON.stringify(found) + ', не найдено ' + JSON.stringify(missing));
    if (found.length) await this.pastePaths(found);
    if (missing.length) {
      vscode.window.showWarningMessage(`Не нашёл, где лежит: ${missing.join(', ')}. Выделите файл в Finder и нажмите ⌥⌘C — путь скопируется.`);
    }
  }

  matches(p, f) {
    try {
      const st = fs.statSync(p);
      if (Math.abs(st.mtimeMs - f.mtime) > 2000) return false;
      return st.isDirectory() || st.size === f.size;
    } catch { return false; }
  }

  async findFile(f) {
    const r = await run('mdfind', ['-name', f.name], 8000);
    this.log.info('перетаскивание: Spotlight нашёл с таким именем ' + r.stdout.split('\n').filter((p) => p && path.basename(p) === f.name).length);
    const hits = r.stdout.split('\n').filter((p) => p && path.basename(p) === f.name && this.matches(p, f));
    if (hits.length) return hits[0];
    const roots = [
      ...(vscode.workspace.workspaceFolders || []).map((w) => w.uri.fsPath),
      ...['Desktop', 'Downloads', 'Documents', 'Pictures', 'Yandex.Disk.localized'].map((d) => path.join(HOME, d)),
      path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'),
    ];
    let budget = 60000;
    const walk = (dir, depth) => {
      if (budget <= 0 || depth > 6) return undefined;
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return undefined; }
      budget -= ents.length;
      for (const e of ents) if (e.name === f.name && this.matches(path.join(dir, e.name), f)) return path.join(dir, e.name);
      for (const e of ents) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
        const hit = walk(path.join(dir, e.name), depth + 1);
        if (hit) return hit;
      }
      return undefined;
    };
    for (const r0 of roots) { const hit = walk(r0, 0); if (hit) return hit; }
    return undefined;
  }

  // Путь дописывается в конец того, что уже набрано: фокус в поле Claude, ⌘↓ (в конец), ⌘V.
  // Что было в буфере обмена (текст) — возвращается обратно.
  // Основной способ (с 0.9.19): команда Claude Code «Insert @-Mention Reference». Она берёт файл активного
  // редактора — поэтому на миг открываем пустой виртуальный документ clodex-mention:<путь>
  // (untitled:<путь> VS Code не открывает, если файл есть на диске)
  // (сам файл не читается и не меняется), вызываем команду и закрываем вкладку.
  async pastePaths(paths) {
    if (this.targetAgent() === 'codex') return this.toCodex(paths);
    const rest = [];
    let done = 0;
    for (const p of paths) {
      if (/[#"]/.test(p) || !(await this.mentionViaClaude(p))) rest.push(p); else done++;
    }
    this.log.info(`перетаскивание: через Claude ${done}, клавишами ${rest.length}`);
    if (rest.length) return this.pasteViaKeys(rest);
    vscode.window.setStatusBarMessage(done === 1 ? '$(check) Файл — в чате Claude' : `$(check) Файлов в чате: ${done}`, 2500);
  }

  async mentionViaClaude(p) {
    const uri = vscode.Uri.file(p).with({ scheme: 'clodex-mention' });
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: false });
      await vscode.commands.executeCommand('claude-vscode.insertAtMention');
      for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
        if (t.input && t.input.uri && t.input.uri.toString() === doc.uri.toString()) { try { await vscode.window.tabGroups.close(t, true); } catch { } }
      }
      return true;
    } catch (e) {
      this.log.error('перетаскивание: упоминание через Claude не вышло: ' + (e && e.message || e));
      return false;
    }
  }

  async pasteViaKeys(paths) {
    const text = ' ' + paths.map((p) => (/[\s"'()]/.test(p) ? `"${p}"` : p)).join(' ') + ' ';
    let old;
    try { old = await vscode.env.clipboard.readText(); } catch { }
    await vscode.env.clipboard.writeText(text);
    // После броска из Finder на переднем плане остаётся Finder — ⌘V ушёл бы туда. Сначала вернуть VS Code.
    await run('osascript', ['-e', `tell application id "${vscode.env.appName.includes('Insiders') ? 'com.microsoft.VSCodeInsiders' : 'com.microsoft.VSCode'}" to activate`]);
    await new Promise((r) => setTimeout(r, 250));
    try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { }
    await new Promise((r) => setTimeout(r, 450));
    const k = await run('osascript', ['-e', 'tell application "System Events"\nkey code 125 using command down\nkeystroke "v" using command down\nend tell']);
    this.log.info('перетаскивание: вставка ' + (k.ok ? 'ок' : 'ошибка: ' + k.stderr.slice(0, 300)));
    if (!k.ok) { vscode.window.showInformationMessage('Путь в буфере обмена — нажмите ⌘V в поле чата.'); return; }
    vscode.window.setStatusBarMessage(paths.length === 1 ? '$(check) Путь к файлу — в чате' : `$(check) Путей в чате: ${paths.length}`, 2500);
    if (old) setTimeout(() => { vscode.env.clipboard.writeText(old); }, 900);
  }

  // Раздел живёт внутри панели «Чаты» — выдвижной плашкой снизу (с 0.9.12).
  // Своего раздела VS Code больше нет: его заголовок с галочкой нельзя оформить.
  roots() { return [vscode.Uri.file(this.thumbDir), vscode.Uri.file(this.dir())]; }

  html(webview, media) {
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, 'screens.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, 'screens.js'));
    const big = this.ctx.globalState.get('screens.size', 'small') === 'big';
    const open = this.ctx.globalState.get('screens.open', false);
    const tips = this.ctx.globalState.get('screens.tips', false);
    const auto = this.autoOn();
    return {
      css: `<link rel="stylesheet" href="${css}">`,
      js,
      body: `<div id="shots" class="${big ? 'big' : 'small'}${open ? ' open' : ''}${tips ? ' tips' : ''}${auto ? ' auto' : ''}" tabindex="-1">
<div id="s-head" role="button" tabindex="0" aria-expanded="${open}" title="Скриншоты с айфона — открыть / закрыть. Файл из Finder можно бросить на эту плашку">
<span class="s-ico"><svg viewBox="0 0 16 16"><path d="M2 5.3c0-.8.6-1.4 1.4-1.4h1.7l1-1.4h3.8l1 1.4h1.7c.8 0 1.4.6 1.4 1.4v6.3c0 .8-.6 1.4-1.4 1.4H3.4c-.8 0-1.4-.6-1.4-1.4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="8" cy="8.3" r="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg></span>
<span class="s-title">Скриншоты и файлы</span><span class="s-drop"><svg viewBox="0 0 16 16"><path d="M8 2.5v8M4.8 7.6 8 10.8l3.2-3.2M3 13.5h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>Отпустите файл — путь уйдёт в чат</span>
<span class="s-tools">
<button id="s-help" class="s-ib s-helpb" title="Подсказки — показать / скрыть (по умолчанию скрыты)" aria-label="Подсказки"><svg viewBox="0 0 16 16"><path d="M5.6 10.6C4.4 9.7 3.7 8.4 3.7 7a4.3 4.3 0 1 1 8.6 0c0 1.4-.7 2.7-1.9 3.6v1.2H5.6z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.2 14.2h3.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>

<button id="s-auto" class="s-ib s-sw" role="switch" aria-checked="${auto}" title="Снимки и фото: автообновление раз в 5 с — ${auto ? 'включено' : 'выключено'}. Нажмите, чтобы ${auto ? 'выключить' : 'включить'}" aria-label="Автообновление снимков и фото раз в 5 секунд"><span class="trk"><span class="knob"></span></span></button>
<button id="s-allSeen" class="s-ib" title="Отметить все просмотренными"><svg viewBox="0 0 16 16"><path d="M1.5 8.5l3 3 5-6M7.5 11.5l1 1 6-7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<button id="s-folder" class="s-ib" title="Открыть папку в Finder"><svg viewBox="0 0 16 16"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h5.6c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
<button id="s-refresh" class="s-ib" title="Обновить"><svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
</span>
<span id="s-count" class="s-count"></span>
<span class="s-chev"><svg viewBox="0 0 16 16"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
</div>
<div id="s-body"><div id="s-tips"><div class="s-tip"><span class="ti"><svg viewBox="0 0 16 16"><path d="M4 1.8h5l3.2 3.2v8.2c0 .6-.5 1-1 1H4c-.6 0-1-.4-1-1V2.8c0-.6.4-1 1-1z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 1.8V5h3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></span><span><b>Файл в чат — перетащите.</b> Перетащите файл из Finder на плашку «Скриншоты и файлы» — путь появится в чате.</span></div><div class="s-tip"><span class="ti"><svg viewBox="0 0 16 16"><rect x="1.8" y="3.8" width="12.4" height="8.4" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.6 7h.01M7 7h.01M9.4 7h.01M11.8 7h.01M5 9.8h6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><span><b>Файл в чат — клавишами.</b> Выделите файл в Finder, нажмите <kbd>⌥</kbd><kbd>⌘</kbd><kbd>C</kbd> и вставьте в чат <kbd>⌘</kbd><kbd>V</kbd>.</span></div></div><div id="s-grid"></div><div id="s-bar" hidden></div></div></div>
</div>
<div id="s-ghost"></div>`,
    };
  }

  attach(view) { this.view = view; this.push(); }

  async handle(m) {
    try {
      if (m.type === 'ready') { this.push(); }
      if (m.type === 'dragInfo') this.log.info('перетаскивание снимков из плашки: ' + JSON.stringify(m.uris));
      if (m.type === 'dropLeave') this.log.info('перетаскивание: ушли с панели без броска, событий над панелью ' + m.overs);
      if (m.type === 'dropSeen') this.log.info('перетаскивание над панелью: ' + JSON.stringify(m.types || []));
      if (m.type === 'dropFiles') await this.dropFiles(m);
      if (m.type === 'drawer') await this.ctx.globalState.update('screens.open', !!m.value);
      const useAll = (ps) => Promise.all((ps || []).map((p) => this.ensureUse(p)));
      if (m.type === 'chat') await this.toChat(await this.ensureUse(m.path));
      if (m.type === 'copy') await this.copyPath(await this.ensureUse(m.path));
      if (m.type === 'chatMany') await this.mentionsToChat(await useAll(m.paths));
      if (m.type === 'copyMany') await this.copyMany(await useAll(m.paths));
      if (m.type === 'open') await this.open(await this.ensureUse(m.path));
      if (m.type === 'trash') await this.trash(m.path);
      if (m.type === 'trashMany') await this.trashMany(m.paths);
      if (m.type === 'tips') await this.ctx.globalState.update('screens.tips', !!m.value);
      if (m.type === 'size') await this.ctx.globalState.update('screens.size', m.size === 'big' ? 'big' : 'small');
      if (m.type === 'refresh') await this.scan(true);
      if (m.type === 'auto') {
        await this.ctx.globalState.update('autoRefresh.v2', !!m.value);
        this.log.info('автообновление снимков раз в 5 с: ' + (m.value ? 'включено' : 'выключено'));
        if (m.value) await this.scan(true); // включили — сразу свежие снимки
      }
      if (m.type === 'allSeen') this.markSeen();
      if (m.type === 'folder') { fs.mkdirSync(this.dir(), { recursive: true }); await run('open', [this.dir()]); }
    } catch (e) { this.log.error('скриншоты: ' + (e && e.stack || e)); }
  }
}

function registerScreens(context, log) {
  const provider = new ScreensView(context, log);
  context.subscriptions.push(
    vscode.commands.registerCommand('clodex.screens.refresh', () => provider.scan(true)),
    vscode.commands.registerCommand('clodex.screens.focus2', async () => {
      await vscode.commands.executeCommand('clodex.chats.focus');
      if (provider.view) provider.view.webview.postMessage({ type: 'shotsOpen' });
    }),
  );
  return provider;
}

module.exports = { registerScreens };
