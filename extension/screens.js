// Раздел «Скриншоты» в левой панели Clodex.
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
const POLL_MS = 4000;
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
    this.view = undefined;
    this.shots = [];
    this.seen = new Set(ctx.globalState.get('screens.seen', []));
    this.thumbDir = path.join(ctx.globalStorageUri.fsPath, 'screens-thumbs');
    fs.mkdirSync(this.thumbDir, { recursive: true });
    this.busy = false;
    this.timer = setInterval(() => this.scan(), POLL_MS);
    ctx.subscriptions.push({ dispose: () => clearInterval(this.timer) });
    this.scan();
  }

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

  async thumb(file, mtimeMs) {
    const out = path.join(this.thumbDir, `${path.basename(file)}.${Math.round(mtimeMs)}.jpg`);
    if (fs.existsSync(out)) return out;
    const r = await run('sips', ['-Z', '520', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', file, '--out', out]);
    return r.ok && fs.existsSync(out) ? out : undefined;
  }

  async scan(force) {
    if (this.busy) return;
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
      files.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const top = files.slice(0, MAX);
      const sig = top.map((f) => f.name + f.mtimeMs).join('|');
      if (!force && sig === this.sig) return;
      this.sig = sig;
      const first = this.shots.length === 0 && this.seen.size === 0;
      for (const f of top) f.thumb = await this.thumb(f.path, f.mtimeMs);
      this.shots = top;
      this.total = files.length;
      if (first) { for (const f of top) this.seen.add(f.path); this.saveSeen(); }
      this.updateBadge();
      this.push();
    } catch (e) {
      this.log.error('скриншоты: ' + (e && e.stack || e));
    } finally {
      this.busy = false;
    }
  }

  unseen() { return this.shots.filter((s) => !this.seen.has(s.path)); }
  saveSeen() {
    const keep = this.shots.map((s) => s.path).filter((p) => this.seen.has(p));
    this.seen = new Set(keep);
    this.ctx.globalState.update('screens.seen', keep);
  }
  updateBadge() {
    if (!this.view) return;
    const n = this.unseen().length;
    this.view.badge = n ? { value: n, tooltip: `Новых скриншотов: ${n}` } : undefined;
  }
  markSeen(p) {
    if (p) this.seen.add(p); else for (const s of this.shots) this.seen.add(s.path);
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
        path: s.path, name: s.name, mtimeMs: s.mtimeMs, ago: now - s.mtimeMs,
        src: w.asWebviewUri(vscode.Uri.file(s.thumb || s.path)).toString(),
        uri: vscode.Uri.file(s.path).toString(),
        isNew: !this.seen.has(s.path),
      })),
    });
  }

  // «В чат»: снимок в буфер обмена, фокус в поле Claude, вставка ⌘V
  async toChat(p) {
    this.markSeen(p);
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
    for (const p of paths) this.seen.add(p);
    this.saveSeen(); this.updateBadge(); this.push();
    await vscode.env.clipboard.writeText(paths.map((p) => this.mention(p)).join(' ') + ' ');
    try { await vscode.commands.executeCommand('claude-vscode.focus'); } catch { }
    await new Promise((r) => setTimeout(r, 450));
    const k = await run('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down']);
    if (!k.ok) vscode.window.showInformationMessage('Ссылки на снимки в буфере обмена — нажмите ⌘V в поле чата.');
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
    const ok = await vscode.window.showWarningMessage(`Убрать «${path.basename(p)}» в Корзину?`, { modal: true }, 'В Корзину');
    if (ok !== 'В Корзину') return;
    await vscode.workspace.fs.delete(vscode.Uri.file(p), { useTrash: true });
    this.scan(true);
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [media, vscode.Uri.file(this.thumbDir), vscode.Uri.file(this.dir())],
    };
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'screens.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'screens.js'));
    const nonce = Math.random().toString(36).slice(2);
    view.webview.html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource}; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<div id="glow"></div>
<div id="top"><span class="title">Скриншоты</span><span id="count" class="count"></span><span class="tools">
<button id="allSeen" class="ib" title="Отметить все просмотренными"><svg viewBox="0 0 16 16"><path d="M1.5 8.5l3 3 5-6M7.5 11.5l1 1 6-7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<button id="folder" class="ib" title="Открыть папку в Finder"><svg viewBox="0 0 16 16"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h5.6c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button>
<button id="refresh" class="ib" title="Обновить"><svg viewBox="0 0 16 16"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.8h-2.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
</span></div>
<div id="grid"></div>
<div id="bar" hidden></div>
<div id="ghost"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async (m) => {
      try {
        if (m.type === 'ready') { this.push(); }
        if (m.type === 'chat') await this.toChat(m.path);
        if (m.type === 'copy') await this.copyPath(m.path);
        if (m.type === 'chatMany') await this.mentionsToChat(m.paths);
        if (m.type === 'copyMany') await this.copyMany(m.paths);
        if (m.type === 'open') await this.open(m.path);
        if (m.type === 'trash') await this.trash(m.path);
        if (m.type === 'refresh') await this.scan(true);
        if (m.type === 'allSeen') this.markSeen();
        if (m.type === 'folder') { fs.mkdirSync(this.dir(), { recursive: true }); await run('open', [this.dir()]); }
      } catch (e) { this.log.error('скриншоты: ' + (e && e.stack || e)); }
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.push(); });
    this.updateBadge();
  }
}

function registerScreens(context, log) {
  const provider = new ScreensView(context, log);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clodex.screens', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('clodex.screens.refresh', () => provider.scan(true)),
    vscode.commands.registerCommand('clodex.screens.focus2', () => vscode.commands.executeCommand('clodex.screens.focus')),
  );
  return provider;
}

module.exports = { registerScreens };
