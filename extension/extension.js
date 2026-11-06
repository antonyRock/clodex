'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Scanner, search, isQuestion, loadRegistry, autoGroup, readVsState, HOME } = require('./data.js');

const NO_GROUP = 'Без группы';
// Реестр проектов рабочей папки агента: ярлык ~/Claude_AI ставит комплект установки.
const REGISTRY = path.join(HOME, 'Claude_AI', '03_Проекты', '00_Реестр проектов.md');
// При первом запуске переносится состояние прежней сборки Clodex с другим издателем (<кто-то>.clodex).
const STATE_KEYS = ['initialized', 'seen', 'groupOverride', 'groupAlias', 'dissolved', 'groupOrder', 'collapsed', 'archived', 'titles'];

const WORKING_MS = 3 * 60 * 1000;  // файл менялся недавно и ответа нет — агент работает
const POLL_VISIBLE = 4000;
const POLL_HIDDEN = 20000;

async function migrate(context) {
  if (context.globalState.get('initialized')) return;
  const self = context.extension.id.toLowerCase().replace(/'/g, '');
  const old = await readVsState(`key like '%.clodex' and lower(key) != '${self}'`);
  if (!old || !old.initialized) return;
  for (const k of STATE_KEYS) if (k in old) await context.globalState.update(k, old[k]);
}

async function activate(context) {
  try { await migrate(context); } catch (e) { console.error('Clodex: migrate', e); }
  const provider = new ClodexView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clodex.chats', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('clodex.refresh', () => provider.refresh(true)),
    vscode.commands.registerCommand('clodex.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('clodex.expandAll', () => provider.setAllCollapsed(false)),
    vscode.commands.registerCommand('clodex.collapseAll', () => provider.setAllCollapsed(true)),
    vscode.commands.registerCommand('clodex.markAllRead', () => provider.markAllRead()),
    vscode.commands.registerCommand('clodex.focusSearch', async () => {
      await vscode.commands.executeCommand('clodex.chats.focus');
      provider.post({ type: 'focusSearch' });
    }),
  );
  provider.start();
}

class ClodexView {
  constructor(context) {
    this.ctx = context;
    this.view = null;
    this.chats = [];
    this.byKey = new Map();
    this.cacheFile = path.join(context.globalStorageUri.fsPath, 'cache-v1.json');
    this.scanner = new Scanner(this.loadCache());
    this.scanning = false;
    this.lastQuery = '';
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.status.command = 'clodex.chats.focus';
    context.subscriptions.push(this.status);
  }

  // ---------- состояние Clodex ----------
  get seen() { return this.ctx.globalState.get('seen', {}); }
  get groupOverride() { return this.ctx.globalState.get('groupOverride', {}); }
  async setSeen(key, t) {
    const s = { ...this.seen, [key]: t };
    await this.ctx.globalState.update('seen', s);
  }

  loadCache() {
    try { return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')); } catch { return {}; }
  }
  saveCache() {
    if (!this.scanner.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      const slim = {};
      for (const [k, v] of Object.entries(this.scanner.cache)) {
        slim[k] = { mtime: v.mtime, size: v.size, chat: v.chat ? { ...v.chat, _lower: undefined, _lowerTitle: undefined } : null };
      }
      fs.writeFileSync(this.cacheFile, JSON.stringify(slim));
      this.scanner.dirty = false;
    } catch (e) { console.error('Clodex: cache', e); }
  }

  start() {
    this.refresh(true);
    const tick = () => {
      const visible = this.view && this.view.visible;
      this.timer = setTimeout(async () => { await this.refresh(false); tick(); }, visible ? POLL_VISIBLE : POLL_HIDDEN);
    };
    tick();
    this.ctx.subscriptions.push({ dispose: () => clearTimeout(this.timer) });
    this.ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => this.markActiveTabs()));
    this.ctx.subscriptions.push(vscode.window.onDidChangeWindowState(() => this.markActiveTabs()));
    this.cacheTimer = setInterval(() => this.saveCache(), 30000);
    this.ctx.subscriptions.push({ dispose: () => { clearInterval(this.cacheTimer); this.saveCache(); } });
  }

  async refresh(force) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const before = this.scanner.dirty;
      this.scanner.dirty = false;
      this.chats = await this.scanner.scan();
      const changed = this.scanner.dirty;
      this.scanner.dirty = before || changed;
      this.byKey = new Map(this.chats.map((c) => [c.key, c]));
      this._manualMap = null;
      await this.initSeen();
      this.markActiveTabs(true);
      if (changed || force) this.push();
      else this.updateBadge(); // время «N мин» обновляет сама страница
    } catch (e) {
      console.error('Clodex: scan', e);
    } finally { this.scanning = false; }
  }

  // При первом запуске все чаты считаются прочитанными.
  async initSeen() {
    if (this.ctx.globalState.get('initialized')) return;
    const s = {};
    for (const c of this.chats) s[c.key] = Date.now();
    await this.ctx.globalState.update('seen', s);
    await this.ctx.globalState.update('initialized', true);
  }

  // Чат Claude открыт во вкладке и окно активно — значит, прочитан.
  markActiveTabs(silent) {
    if (!vscode.window.state.focused) return;
    const labels = new Set();
    for (const g of vscode.window.tabGroups.all) {
      const t = g.activeTab;
      if (t && t.input instanceof vscode.TabInputWebview && t.input.viewType.includes('claudeVSCodePanel')) labels.add(t.label);
    }
    if (!labels.size) return;
    const seen = this.seen;
    let upd = false;
    for (const c of this.chats) {
      if (c.agent === 'claude' && labels.has(c.title) && this.isUnread(c, seen)) { seen[c.key] = Date.now(); upd = true; }
    }
    if (upd) this.ctx.globalState.update('seen', seen).then(() => this.push());
  }

  isUnread(c, seen) {
    const s = (seen || this.seen)[c.key] || 0;
    return c.finished && c.lastAssistantTs > s && c.lastAssistantTs >= c.lastUserTs;
  }

  status_(c, seen) {
    const working = !c.finished && Date.now() - (c.mtime || 0) < WORKING_MS;
    if (working) return 'working';
    if (this.isUnread(c, seen)) return 'unread';
    return 'read';
  }

  registry() {
    const file = vscode.workspace.getConfiguration('clodex').get('registryPath') || REGISTRY;
    let m = 0;
    try { m = fs.statSync(file).mtimeMs; } catch {}
    if (!this._reg || this._regM !== m || this._regF !== file) {
      this._reg = loadRegistry(file); this._regM = m; this._regF = file; this._auto = new Map();
    }
    return this._reg;
  }

  get gs() { return this.ctx.globalState; }

  // Итоговая группа: своя группа чата → исходная; удалённая группа → «Без группы»; переименование — через alias.
  groupOf(c) {
    const alias = this.gs.get('groupAlias', {});
    const dissolved = this.gs.get('dissolved', {});
    let g = this.groupOverride[c.key] || this.baseGroup(c);
    for (let i = 0; i < 5 && alias[g]; i++) g = alias[g];
    if (dissolved[g]) g = NO_GROUP;
    return g;
  }

  baseGroup(c) {
    if (c.claudeGroup) return c.claudeGroup;
    const reg = this.registry();
    const ak = c.key + ':' + c.msgCount;
    if (!this._auto.has(ak)) this._auto.set(ak, autoGroup(c, reg));
    const a = this._auto.get(ak);
    if (a) return this.manualFor(a) || a;
    const cwd = c.cwd || '';
    if (/Claude_AI\/?$/.test(cwd)) return 'Без группы';
    if (!cwd || cwd === HOME) return 'Домашняя папка';
    if (!cwd.startsWith(HOME + '/')) return 'Прочее';
    const parts = cwd.slice(HOME.length + 1).split('/');
    if (parts[0] === 'Library') return 'Прочее';
    if (parts[0] === 'Documents' && parts[1]) return parts[1];
    return parts[0];
  }

  // Автогруппа совпадает по словам с ручной («T6D» ⊂ «T6D заведение в контур Банка») — берём ручную.
  manualFor(auto) {
    if (!this._manualMap) this._manualMap = new Map();
    if (this._manualMap.has(auto)) return this._manualMap.get(auto);
    const tok = (s) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2));
    const a = tok(auto);
    let res = '';
    for (const name of new Set(this.chats.map((x) => x.claudeGroup).filter(Boolean))) {
      const m = tok(name);
      const [small, big] = a.size <= m.size ? [a, m] : [m, a];
      if (small.size && [...small].every((w) => big.has(w))) { res = name; break; }
    }
    this._manualMap.set(auto, res);
    return res;
  }

  payload() {
    const seen = this.seen;
    return this.chats.map((c) => ({
      key: c.key, agent: c.agent, title: this.titleOf(c), group: this.groupOf(c),
      ts: c.lastTs, status: this.status_(c, seen),
      waiting: c.finished && c.lastAssistantTs >= c.lastUserTs && isQuestion(c.lastAssistantText),
      archived: this.isArchived(c),
    }));
  }

  titleOf(c) { return this.gs.get('titles', {})[c.key] || c.title; }

  async rename(key) {
    const c = this.byKey.get(key);
    if (!c) return;
    const v = await vscode.window.showInputBox({ prompt: 'Новое название чата (пусто — вернуть исходное)', value: this.titleOf(c) });
    if (v === undefined) return;
    const t = { ...this.gs.get('titles', {}) };
    if (v.trim() && v.trim() !== c.title) t[key] = v.trim(); else delete t[key];
    await this.gs.update('titles', t);
    this.push();
  }

  // Архив Clodex; чаты, скрытые в самом Claude Code, тоже считаются архивом, пока их не вернут.
  isArchived(c) {
    const a = this.gs.get('archived', {});
    return c.key in a ? !!a[c.key] : !!c.archived;
  }
  async setArchived(key, v) {
    await this.gs.update('archived', { ...this.gs.get('archived', {}), [key]: v });
    this.push();
  }

  updateBadge(items) {
    items = items || this.payload();
    const n = items.filter((i) => i.status === 'unread' && !i.archived).length;
    if (this.view) this.view.badge = n ? { value: n, tooltip: `Непрочитанных чатов: ${n}` } : undefined;
    this.status.text = n ? `$(comment-unresolved) ${n}` : '$(comment-discussion)';
    this.status.tooltip = n ? `Clodex: непрочитанных чатов — ${n}` : 'Clodex: всё прочитано';
    this.status.show();
  }

  push() {
    const items = this.payload();
    this.updateBadge(items);
    this.post({ type: 'data', items, collapsed: this.gs.get('collapsed', {}), order: this.gs.get('groupOrder', []) });
    if (this.lastQuery) this.post({ type: 'results', q: this.lastQuery, results: search(this.chats, this.lastQuery, this.gs.get('titles', {})) });
  }

  post(m) { if (this.view) this.view.webview.postMessage(m); }

  async markAllRead() {
    const s = this.seen;
    for (const c of this.chats) s[c.key] = Date.now();
    await this.ctx.globalState.update('seen', s);
    this.push();
  }

  // ---------- действия ----------
  async open(key) {
    const c = this.byKey.get(key);
    if (!c) return;
    await this.setSeen(key, Date.now());
    this.push();
    try {
      if (c.agent === 'claude') {
        await vscode.commands.executeCommand('claude-vscode.editor.open', c.id);
      } else {
        await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://openai.chatgpt/local/${c.id}`));
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Clodex: не удалось открыть чат «${c.title}»: ${e.message || e}`);
    }
  }

  async newChat(agent) {
    if (!agent) {
      const p = await vscode.window.showQuickPick([
        { label: '$(sparkle) Claude', description: 'новый чат Claude Code', id: 'claude' },
        { label: '$(terminal) Codex', description: 'новый чат Codex', id: 'codex' },
      ], { placeHolder: 'С каким агентом начать чат?' });
      if (!p) return;
      agent = p.id;
    }
    try {
      if (agent === 'codex') await vscode.commands.executeCommand('chatgpt.newCodexPanel');
      else await vscode.commands.executeCommand('claude-vscode.newConversation');
    } catch (e) {
      vscode.window.showErrorMessage(`Clodex: не удалось создать чат: ${e.message || e}`);
    }
  }

  async menu(key) {
    const c = this.byKey.get(key);
    if (!c) return;
    const unread = this.isUnread(c);
    const pick = await vscode.window.showQuickPick([
      { label: unread ? '$(check) Отметить прочитанным' : '$(circle-filled) Отметить непрочитанным', id: 'read' },
      { label: '$(edit) Переименовать…', id: 'rename' },
      { label: '$(folder) Перенести в группу…', id: 'group' },
      { label: this.isArchived(c) ? '$(inbox) Вернуть из архива' : '$(archive) В архив', id: 'archive' },
      ...(this.groupOverride[key] ? [{ label: '$(discard) Вернуть исходную группу', id: 'ungroup' }] : []),
      { label: '$(copy) Скопировать название', id: 'copy' },
    ], { placeHolder: this.titleOf(c) });
    if (!pick) return;
    if (pick.id === 'read') await this.setSeen(key, unread ? Date.now() : 0);
    if (pick.id === 'copy') await vscode.env.clipboard.writeText(c.title);
    if (pick.id === 'archive') return this.setArchived(key, !this.isArchived(c));
    if (pick.id === 'rename') return this.rename(key);
    if (pick.id === 'ungroup') {
      const o = { ...this.groupOverride }; delete o[key];
      await this.ctx.globalState.update('groupOverride', o);
    }
    if (pick.id === 'group') {
      const names = [...new Set(this.chats.map((x) => this.groupOf(x)))].sort();
      const g = await vscode.window.showQuickPick(
        [{ label: '$(add) Новая группа…', id: '' }, ...names.map((n) => ({ label: n, id: n }))],
        { placeHolder: `Группа для «${c.title}»` });
      if (!g) return;
      let name = g.id;
      if (!name) name = (await vscode.window.showInputBox({ prompt: 'Название группы' }) || '').trim();
      if (!name) return;
      await this.ctx.globalState.update('groupOverride', { ...this.groupOverride, [key]: name });
    }
    this.push();
  }

  async groupMenu(name) {
    const items = [
      { label: '$(arrow-up) В начало списка', id: 'top' },
      { label: '$(arrow-down) В конец списка', id: 'bottom' },
      { label: '$(edit) Переименовать…', id: 'rename' },
    ];
    if (name !== NO_GROUP) items.push({ label: '$(trash) Удалить группу (чаты останутся — перейдут в «Без группы»)', id: 'del' });
    items.push({ label: '$(archive) Все чаты группы — в архив', id: 'archiveAll' });
    const p = await vscode.window.showQuickPick(items, { placeHolder: `Группа «${name}»` });
    if (!p) return;
    const members = this.chats.filter((c) => this.groupOf(c) === name);
    if (p.id === 'top' || p.id === 'bottom') {
      const cur = this.currentOrder().filter((g) => g !== name);
      await this.gs.update('groupOrder', p.id === 'top' ? [name, ...cur] : [...cur, name]);
    }
    if (p.id === 'rename') {
      const nn = ((await vscode.window.showInputBox({ prompt: 'Новое название группы (существующее — объединит группы)', value: name })) || '').trim();
      if (!nn || nn === name) return;
      await this.gs.update('groupAlias', { ...this.gs.get('groupAlias', {}), [name]: nn });
      const d = { ...this.gs.get('dissolved', {}) }; delete d[nn]; await this.gs.update('dissolved', d);
      await this.gs.update('groupOrder', this.gs.get('groupOrder', []).map((g) => (g === name ? nn : g)));
    }
    if (p.id === 'del') {
      const ok = await vscode.window.showWarningMessage(`Удалить группу «${name}»? Чатов в ней: ${members.length}. Чаты не удаляются — перейдут в «Без группы».`, { modal: true }, 'Удалить группу');
      if (ok !== 'Удалить группу') return;
      // свои группы чатов снимаем, исходную группу помечаем удалённой
      const o = { ...this.groupOverride };
      for (const c of members) if (o[c.key] === name) delete o[c.key];
      await this.gs.update('groupOverride', o);
      await this.gs.update('dissolved', { ...this.gs.get('dissolved', {}), [name]: true });
      await this.gs.update('groupOrder', this.gs.get('groupOrder', []).filter((g) => g !== name));
    }
    if (p.id === 'archiveAll') {
      const a = { ...this.gs.get('archived', {}) };
      for (const c of members) a[c.key] = true;
      await this.gs.update('archived', a);
    }
    this.push();
  }

  // Порядок групп, как он сейчас на экране: сохранённый, затем по свежести, «Без группы» в конце.
  currentOrder() {
    const saved = this.gs.get('groupOrder', []);
    const last = new Map();
    for (const c of this.chats) {
      if (this.isArchived(c)) continue;
      const g = this.groupOf(c);
      last.set(g, Math.max(last.get(g) || 0, c.lastTs));
    }
    const rest = [...last.keys()].filter((g) => !saved.includes(g) && g !== NO_GROUP).sort((a, b) => last.get(b) - last.get(a));
    const out = [...saved.filter((g) => last.has(g)), ...rest];
    if (last.has(NO_GROUP) && !out.includes(NO_GROUP)) out.push(NO_GROUP);
    return out;
  }

  async setAllCollapsed(v) {
    const c = { ...this.gs.get('collapsed', {}) };
    for (const g of this.currentOrder()) c[g] = v;
    await this.gs.update('collapsed', c);
    this.push();
  }

  // ---------- вид ----------
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.css'));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'view.js'));
    const nonce = Math.random().toString(36).slice(2);
    view.webview.html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${css}"></head><body>
<div id="grid"></div>
<div id="top">
  <div class="brand"><span class="word">Clodex</span><span class="sq"></span><span id="sum" class="sum"></span>
    <span class="tools"><button id="expandAll" class="ib" title="Раскрыть все группы"><svg viewBox="0 0 16 16"><path d="M4 4l4 3.5L12 4M4 8.5 8 12l4-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button id="collapseAll" class="ib" title="Свернуть все группы"><svg viewBox="0 0 16 16"><path d="M4 7.5 8 4l4 3.5M4 12l4-3.5 4 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></button></span></div>
  <div class="searchbox"><input id="q" type="search" placeholder="Поиск по тексту чатов…" spellcheck="false">
    <button id="newChat" class="newbtn" title="Новый чат Claude или Codex">＋ Новый чат</button></div>
  <div class="row"><div id="filters"></div></div>
</div>
<div id="list"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'ready') this.push();
      if (m.type === 'open') this.open(m.key);
      if (m.type === 'menu') this.menu(m.key);
      if (m.type === 'groupMenu') this.groupMenu(m.group);
      if (m.type === 'rename') this.rename(m.key);
      if (m.type === 'archive') { const c = this.byKey.get(m.key); if (c) this.setArchived(m.key, !this.isArchived(c)); }
      if (m.type === 'order') { await this.gs.update('groupOrder', m.order); this.push(); }
      if (m.type === 'collapseAll') this.setAllCollapsed(m.value);
      if (m.type === 'new') this.newChat(m.agent);
      if (m.type === 'toggleRead') {
        const c = this.byKey.get(m.key);
        if (c) { await this.setSeen(m.key, this.isUnread(c) ? Date.now() : 0); this.push(); }
      }
      if (m.type === 'collapse') {
        await this.ctx.globalState.update('collapsed', { ...this.ctx.globalState.get('collapsed', {}), [m.group]: m.value });
      }
      if (m.type === 'search') {
        this.lastQuery = m.q;
        this.post({ type: 'results', q: m.q, results: m.q ? search(this.chats, m.q, this.gs.get('titles', {})) : [] });
      }
    });
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(true); });
    this.updateBadge();
  }
}

function deactivate() {}
module.exports = { activate, deactivate, ClodexView };
