'use strict';
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Scanner, search, isQuestion, loadRegistry, autoGroup, readVsState, HOME, claudeTranscript } = require('./data.js');

const NO_GROUP = 'Без группы';
const BG_GROUP = 'Фоновые'; // сессии `claude -p` (ночные задачи сервера)
// Реестр проектов рабочей папки агента: ярлык ~/Claude_AI ставит комплект установки.
const REGISTRY = path.join(HOME, 'Claude_AI', '03_Проекты', '00_Реестр проектов.md');
// При первом запуске переносится состояние прежней сборки Clodex с другим издателем (<кто-то>.clodex).
const STATE_KEYS = ['initialized', 'seen', 'groupOverride', 'groupAlias', 'dissolved', 'groupOrder', 'collapsed', 'archived', 'titles', 'favorites', 'favChats', 'manualUnread'];

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

let log = { info() {}, error() {} };
const AGENT_EXT = { claude: 'anthropic.claude-code', codex: 'openai.chatgpt' };

async function activate(context) {
  log = vscode.window.createOutputChannel('Clodex', { log: true });
  context.subscriptions.push(log);
  log.info('Clodex ' + (context.extension && context.extension.packageJSON.version) + ' запускается');
  try { await migrate(context); } catch (e) { console.error('Clodex: migrate', e); }
  const provider = new ClodexView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('clodex.chats', provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('clodex.refresh', () => provider.refresh(true)),
    vscode.commands.registerCommand('clodex.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('clodex.newGroup', () => provider.newGroup()),
    vscode.commands.registerCommand('clodex.toggleTheme', () => provider.toggleVsTheme()),
    vscode.commands.registerCommand('clodex.expandAll', () => provider.setAllCollapsed(false)),
    vscode.commands.registerCommand('clodex.collapseAll', () => provider.setAllCollapsed(true)),
    vscode.commands.registerCommand('clodex.markAllRead', () => provider.markAllRead()),
    vscode.commands.registerCommand('clodex.focusSearch', async () => {
      await vscode.commands.executeCommand('clodex.chats.focus');
      provider.post({ type: 'focusSearch' });
    }),
  );
  // Агента установили или удалили — обновить кнопки панели без перезапуска.
  context.subscriptions.push(vscode.extensions.onDidChange(() => { provider._icons = null; provider.push(); }));
  provider.start();
  log.info('Clodex запущен');
}

class ClodexView {
  constructor(context) {
    this.ctx = context;
    this.view = null;
    this.chats = [];
    this.byKey = new Map();
    this.cacheFile = path.join(context.globalStorageUri.fsPath, 'cache-v4.json');
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
  // Ручная метка «не прочитано»: держится, пока чат не откроют снова (через Clodex или переключившись на его вкладку).
  get manualUnread() { return this.ctx.globalState.get('manualUnread', {}); }
  async setRead(key, read) {
    const m = { ...this.manualUnread };
    if (read) delete m[key]; else m[key] = Date.now();
    await this.ctx.globalState.update('manualUnread', m);
    await this.setSeen(key, read ? Date.now() : 0);
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
    this.ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => { this.markActiveTabs(); this.postCurrent(); }));
    this.ctx.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(() => this.postCurrent()));
    this.ctx.subscriptions.push(vscode.window.onDidChangeWindowState(() => this.markActiveTabs()));
    this.ctx.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => this.postTheme()));
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
      await this.placePending();
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

  // Подсветка «текущего чата» = активная вкладка Claude Code. Вкладка не Claude (файл, Codex) — подсветку не трогаем.
  postCurrent(force) {
    const g = vscode.window.tabGroups.activeTabGroup;
    const t = g && g.activeTab;
    if (!t || !(t.input instanceof vscode.TabInputWebview) || !t.input.viewType.includes('claudeVSCodePanel')) return;
    const c = (this.chats || []).filter((x) => x.agent === 'claude' && x.title === t.label)
      .sort((a, b) => (b.mtime || 0) - (a.mtime || 0))[0];
    if (c && (force || c.key !== this._current)) {
      const switched = this._current && c.key !== this._current;
      this._current = c.key; this.post({ type: 'current', key: c.key });
      if (switched && vscode.window.state.focused && c.key in this.manualUnread) this.setRead(c.key, true).then(() => this.push());
    }
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
    const manual = this.manualUnread;
    let upd = false;
    for (const c of this.chats) {
      if (c.agent === 'claude' && labels.has(c.title) && !(c.key in manual) && this.isUnread(c, seen)) { seen[c.key] = Date.now(); upd = true; }
    }
    if (upd) this.ctx.globalState.update('seen', seen).then(() => this.push());
  }

  isUnread(c, seen) {
    if (c.background) return false; // фоновые не шумят «непрочитанным»
    if (c.key in this.manualUnread) return true;
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
    if (c.background) return BG_GROUP;
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
      archived: this.isArchived(c), background: !!c.background, ctx: c.ctx || 0,
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
    this.post({ type: 'data', items, collapsed: this.gs.get('collapsed', {}), order: this.gs.get('groupOrder', []), icons: this.agentIcons(), installed: this.installed(), customGroups: this.customGroups, favorites: this.gs.get('favorites', {}), favChats: this.gs.get('favChats', {}), lastAgent: this.gs.get('lastAgent', 'claude') });
    if (this.lastQuery) this.post({ type: 'results', q: this.lastQuery, results: search(this.chats, this.lastQuery, this.gs.get('titles', {})) });
    if (!this._currentSent) { this._currentSent = true; this.postCurrent(true); } // один раз после первой загрузки
  }

  post(m) { if (this.view) this.view.webview.postMessage(m); }

  // Какие агенты установлены в VS Code. Нет расширения — его кнопки в панели неактивны.
  installed() {
    return {
      claude: !!vscode.extensions.getExtension(AGENT_EXT.claude),
      codex: !!vscode.extensions.getExtension(AGENT_EXT.codex),
    };
  }

  // Агент не установлен — сказать об этом и предложить найти его в магазине расширений.
  async notInstalled(agent) {
    const name = agent === 'codex' ? 'Codex' : 'Claude Code';
    const go = await vscode.window.showWarningMessage(`Clodex: ${name} не установлен в VS Code.`, 'Найти в расширениях');
    if (go) await vscode.commands.executeCommand('workbench.extensions.search', AGENT_EXT[agent]);
  }

  // Логотипы агентов берутся из установленных расширений Claude Code и Codex — в Clodex их нет.
  agentIcons() {
    if (this._icons) return this._icons;
    const src = { claude: [AGENT_EXT.claude, 'resources/claude-logo.svg'], codex: [AGENT_EXT.codex, 'resources/blossom-white.svg'] };
    const out = {};
    for (const [agent, [id, rel]] of Object.entries(src)) {
      try {
        const ext = vscode.extensions.getExtension(id);
        if (!ext) continue;
        let svg = fs.readFileSync(path.join(ext.extensionPath, rel), 'utf8');
        svg = svg.replace(/<\?xml[^>]*>/g, '').replace(/<title>[\s\S]*?<\/title>/g, '')
          .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '')
          .replace(/\s(width|height|style)="[^"]*"/g, '');
        if (agent === 'codex') svg = svg.replace(/fill="white"/g, 'fill="currentColor"');
        if (/^\s*<svg[\s\S]*<\/svg>\s*$/.test(svg)) out[agent] = svg.trim();
      } catch {}
    }
    return (this._icons = out);
  }

  async markAllRead() {
    const s = this.seen;
    for (const c of this.chats) s[c.key] = Date.now();
    await this.ctx.globalState.update('seen', s);
    await this.ctx.globalState.update('manualUnread', {});
    this.push();
  }

  // ---------- действия ----------
  async open(key) {
    const c = this.byKey.get(key);
    if (!c) return;
    await this.setRead(key, true);
    this.push();
    if (c.background) return this.openTranscript(c);
    if (!this.installed()[c.agent]) return this.notInstalled(c.agent);
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

  // Фоновый чат: Claude Code его не показывает — открываем протокол (Markdown) и обновляем при повторном клике.
  async openTranscript(c) {
    try {
      const content = fs.readFileSync(c.file, 'utf8');
      const dir = path.join(this.ctx.globalStorageUri.fsPath, 'transcripts');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${c.id}.md`);
      fs.writeFileSync(file, claudeTranscript(content, this.titleOf(c)));
      await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(file));
    } catch (e) {
      vscode.window.showErrorMessage(`Clodex: не удалось открыть протокол «${c.title}»: ${e.message || e}`);
    }
  }

  // group — создать чат сразу в группе: первый новый чат этого агента за 3 минуты попадёт туда
  async newChat(agent, group) {
    const inst = this.installed();
    if (!inst.claude && !inst.codex) {
      vscode.window.showWarningMessage('Clodex: не установлен ни Claude Code, ни Codex — новый чат создать нельзя.');
      return;
    }
    if (agent === 'last') {
      agent = this.gs.get('lastAgent', 'claude');
      if (!inst[agent]) agent = inst.claude ? 'claude' : 'codex';
    }
    if (!agent) {
      const opts = [
        { label: '$(sparkle) Claude', description: 'новый чат Claude Code', id: 'claude' },
        { label: '$(terminal) Codex', description: 'новый чат Codex', id: 'codex' },
      ].filter((o) => inst[o.id]);
      const p = opts.length === 1 ? opts[0] : await vscode.window.showQuickPick(opts, { placeHolder: 'С каким агентом начать чат?' });
      if (!p) return;
      agent = p.id;
    }
    if (!inst[agent]) return this.notInstalled(agent);
    await this.gs.update('lastAgent', agent);
    if (group) this.pending = { group, agent, t: Date.now(), known: new Set(this.chats.map((c) => c.key)) };
    this.push();
    try {
      if (agent === 'codex') await vscode.commands.executeCommand('chatgpt.newCodexPanel');
      else await vscode.commands.executeCommand('claude-vscode.newConversation');
    } catch (e) {
      vscode.window.showErrorMessage(`Clodex: не удалось создать чат: ${e.message || e}`);
    }
  }

  // Продолжить тяжёлый чат в новом: новый чат Claude в той же группе, в поле ввода — фраза с отсылкой к старому.
  // Текст не отправляется сам: человек проверяет и жмёт Enter.
  continuePrompt(c) {
    const k = Math.round((c.ctx || 0) / 1000);
    const one = (t) => (t || '').replace(/\s+/g, ' ').trim();
    // Обрезка по границе фразы/слова, без кусков слов («…чу проверить»)
    const head = (t, n) => { t = one(t); if (t.length <= n) return t; const cut = t.slice(0, n); const i = cut.lastIndexOf(' '); return (i > n * 0.6 ? cut.slice(0, i) : cut) + '…'; };
    const tailOf = (t, n) => {
      t = one(t); if (t.length <= n) return t;
      const cut = t.slice(-n);
      const m = cut.match(/[.!?»)]\s+(?=[А-ЯЁA-Z«*\d])/);
      if (m && m.index < n * 0.5) return '…' + cut.slice(m.index + m[0].length);
      const i = cut.indexOf(' ');
      return '…' + (i >= 0 && i < 40 ? cut.slice(i + 1) : cut);
    };
    const q = head(c.lastUserText, 300);
    const a = tailOf(c.lastAssistantText, 300);
    // Коротко: CLAUDE.md подгружается сам, вес чата агенту не нужен
    return `Продолжение чата «${this.titleOf(c)}» (название может быть неточным).` +
      (q ? `\nПоследний вопрос: «${q}»` : '') +
      (a ? `\nКонец ответа: «${a}»` : '') +
      `\nНе хватит контекста — журнал проекта, потом конец старого чата: ${c.file}`;
  }

  async continueChat(key) {
    const c = this.byKey.get(key);
    if (!c) return;
    if (c.agent !== 'claude') {
      vscode.window.showInformationMessage('Clodex: продолжить в новом чате пока можно только для Claude — для Codex способ передать стартовый текст не найден.');
      return;
    }
    if (!this.installed().claude) return this.notInstalled('claude');
    const prompt = this.continuePrompt(c);
    await this.gs.update('lastAgent', 'claude');
    this.pending = { group: this.groupOf(c), agent: 'claude', t: Date.now(), known: new Set(this.chats.map((x) => x.key)) };
    this.push();
    try {
      // claude-vscode.editor.open(sessionId, initialPrompt): без sessionId — новый чат, текст встаёт в поле ввода
      await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, prompt);
      log.info('продолжение в новом чате: ' + c.key);
    } catch (e) {
      await vscode.env.clipboard.writeText(prompt);
      try { await vscode.commands.executeCommand('claude-vscode.newConversation'); } catch {}
      vscode.window.showWarningMessage('Clodex: не удалось вписать текст в новый чат — он скопирован, вставьте Cmd+V.');
      log.error('продолжение в новом чате: ' + (e.message || e));
    }
  }

  async menu(key) {
    const c = this.byKey.get(key);
    if (!c) return;
    const unread = this.isUnread(c);
    const pick = await vscode.window.showQuickPick([
      { label: unread ? '$(check) Отметить прочитанным' : '$(circle-filled) Отметить непрочитанным', id: 'read' },
      ...(c.agent === 'claude' && !c.background ? [{ label: '$(arrow-right) Продолжить в новом чате', description: c.ctx ? `сейчас ~${Math.round(c.ctx / 1000)} тыс. токенов` : '', id: 'continue' }] : []),
      { label: '$(edit) Переименовать…', id: 'rename' },
      { label: '$(folder) Перенести в группу…', id: 'group' },
      { label: this.isArchived(c) ? '$(inbox) Вернуть из архива' : '$(archive) В архив', id: 'archive' },
      ...(this.groupOverride[key] ? [{ label: '$(discard) Вернуть исходную группу', id: 'ungroup' }] : []),
      { label: '$(copy) Скопировать название', id: 'copy' },
    ], { placeHolder: this.titleOf(c) });
    if (!pick) return;
    if (pick.id === 'read') await this.setRead(key, unread);
    if (pick.id === 'copy') await vscode.env.clipboard.writeText(c.title);
    if (pick.id === 'archive') return this.setArchived(key, !this.isArchived(c));
    if (pick.id === 'rename') return this.rename(key);
    if (pick.id === 'continue') return this.continueChat(key);
    if (pick.id === 'ungroup') {
      const o = { ...this.groupOverride }; delete o[key];
      await this.ctx.globalState.update('groupOverride', o);
    }
    if (pick.id === 'group') {
      const names = [...new Set([...this.chats.map((x) => this.groupOf(x)), ...this.customGroups])].sort();
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

  isLightTheme() {
    const k = vscode.window.activeColorTheme.kind;
    return k === vscode.ColorThemeKind.Light || k === vscode.ColorThemeKind.HighContrastLight;
  }
  postTheme() { this.post({ type: 'theme', light: this.isLightTheme() }); }

  // Переключает тему всего VS Code (то же, что Cmd+K Cmd+T): светлая ↔ тёмная из настроек Clodex.
  async toggleVsTheme() {
    const cfg = vscode.workspace.getConfiguration('clodex');
    const next = this.isLightTheme() ? (cfg.get('darkTheme') || 'Dark Modern') : (cfg.get('lightTheme') || 'Light Modern');
    log.info('тема VS Code → ' + next);
    try {
      await vscode.workspace.getConfiguration('workbench').update('colorTheme', next, vscode.ConfigurationTarget.Global);
    } catch (e) {
      vscode.window.showErrorMessage(`Clodex: не удалось включить тему «${next}»: ${e.message || e}`);
    }
  }

  get customGroups() { return this.gs.get('customGroups', []); }

  async placePending() {
    const p = this.pending;
    if (!p) return;
    if (Date.now() - p.t > 3 * 60 * 1000) { this.pending = null; return; }
    const fresh = this.chats.find((c) => !p.known.has(c.key) && c.agent === p.agent);
    if (!fresh) return;
    this.pending = null;
    await this.gs.update('groupOverride', { ...this.groupOverride, [fresh.key]: p.group });
    log.info(`новый чат положен в группу «${p.group}»`);
    this.push();
  }

  async newGroup() {
    const name = ((await vscode.window.showInputBox({ prompt: 'Название новой группы', placeHolder: 'Например: Отпуск, Inpas, Сайт' })) || '').trim();
    if (!name) return;
    const exists = this.customGroups.includes(name) || this.chats.some((c) => this.groupOf(c) === name);
    if (exists) { vscode.window.showInformationMessage(`Группа «${name}» уже есть.`); return; }
    await this.gs.update('customGroups', [...this.customGroups, name]);
    const d = { ...this.gs.get('dissolved', {}) }; delete d[name]; await this.gs.update('dissolved', d);
    await this.gs.update('groupOrder', [name, ...this.currentOrder().filter((g) => g !== name)]);
    this.push();
  }

  async moveToGroup(key, name) {
    if (!this.byKey.has(key) || !name) return;
    if (name === NO_GROUP) {
      const o = { ...this.groupOverride }; delete o[key];
      await this.gs.update('groupOverride', o);
      const c = this.byKey.get(key);
      if (this.groupOf(c) !== NO_GROUP) await this.gs.update('groupOverride', { ...o, [key]: NO_GROUP });
    } else {
      await this.gs.update('groupOverride', { ...this.groupOverride, [key]: name });
      const d = { ...this.gs.get('dissolved', {}) }; delete d[name]; await this.gs.update('dissolved', d);
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
    if (this.chats.some((c) => this.groupOf(c) === name && this.isArchived(c))) items.push({ label: '$(inbox) Вернуть всю группу из архива', id: 'unarchiveAll' });
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
      await this.gs.update('customGroups', [...new Set(this.customGroups.map((g) => (g === name ? nn : g)))]);
      const f = { ...this.gs.get('favorites', {}) };
      if (f[name]) { delete f[name]; f[nn] = true; await this.gs.update('favorites', f); }
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
      await this.gs.update('customGroups', this.customGroups.filter((g) => g !== name));
      const f = { ...this.gs.get('favorites', {}) }; delete f[name]; await this.gs.update('favorites', f);
    }
    if (p.id === 'archiveAll' || p.id === 'unarchiveAll') {
      const a = { ...this.gs.get('archived', {}) };
      for (const c of members) a[c.key] = p.id === 'archiveAll';
      await this.gs.update('archived', a);
    }
    this.push();
  }

  // Порядок групп, как он сейчас на экране: сохранённый, затем по свежести, «Без группы» наверху.
  currentOrder() {
    const saved = this.gs.get('groupOrder', []);
    const last = new Map();
    for (const c of this.chats) {
      if (this.isArchived(c)) continue;
      const g = this.groupOf(c);
      last.set(g, Math.max(last.get(g) || 0, c.lastTs));
    }
    for (const g of this.customGroups) if (!last.has(g)) last.set(g, 0);
    const rest = [...last.keys()].filter((g) => !saved.includes(g) && g !== NO_GROUP).sort((a, b) => last.get(b) - last.get(a));
    const out = [...saved.filter((g) => last.has(g) && g !== NO_GROUP), ...rest];
    if (last.has(NO_GROUP)) out.unshift(NO_GROUP); // «Без группы» всегда первая — чаты, которые ещё не разложены
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
  <div class="brand"><span class="word">Clodex</span><span class="sq"></span><button id="sum" class="sum"></button>
    <span class="tools"><button id="newGroup" class="ib" title="Создать новую группу"><svg viewBox="0 0 16 16"><path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.4 1.5h5.6c.7 0 1.2.5 1.2 1.2v6.1c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 7v4M6 9h4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button><button id="themeBtn" class="ib" title="Светлая / тёмная тема VS Code"></button><button id="foldAll" class="ib"></button><button id="agentsBtn" class="ib" title="Чьи чаты показывать: Claude / Codex"><svg viewBox="0 0 16 16"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg></button></span></div>
  <div class="searchbox"><input id="q" type="search" placeholder="Поиск по тексту чатов…" spellcheck="false"><button class="nb claude" data-new="claude" title="Новый чат с Claude"><svg class="pl" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span class="nbi"><span class="ag claude">C</span></span></button><button class="nb codex" data-new="codex" title="Новый чат с Codex"><svg class="pl" viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span class="nbi"><span class="ag codex">X</span></span></button></div>
  <div class="row"><div id="filters"></div></div>
</div>
<div id="list"></div>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'ready') { log.info('панель открыта'); this.postTheme(); this.push(); }
      if (m.type === 'toggleVsTheme') this.toggleVsTheme();
      if (m.type === 'clientError') { log.error('ошибка в панели: ' + m.message); }
      if (m.type === 'open') this.open(m.key);
      if (m.type === 'menu') this.menu(m.key);
      if (m.type === 'groupMenu') this.groupMenu(m.group);
      if (m.type === 'rename') this.rename(m.key);
      if (m.type === 'continue') this.continueChat(m.key);
      if (m.type === 'newGroup') this.newGroup();
      if (m.type === 'move') this.moveToGroup(m.key, m.group);
      if (m.type === 'favChat') {
        const f = { ...this.gs.get('favChats', {}) };
        if (m.value) f[m.key] = true; else delete f[m.key];
        await this.gs.update('favChats', f); this.push();
      }
      if (m.type === 'favGroup') {
        const f = { ...this.gs.get('favorites', {}) };
        if (m.value) f[m.group] = true; else delete f[m.group];
        await this.gs.update('favorites', f); this.push();
      }
      if (m.type === 'archiveGroup') {
        const a = { ...this.gs.get('archived', {}) };
        for (const k of m.keys || []) if (this.byKey.has(k)) a[k] = !!m.value;
        await this.gs.update('archived', a); this.push();
      }
      if (m.type === 'archive') { const c = this.byKey.get(m.key); if (c) this.setArchived(m.key, !this.isArchived(c)); }
      if (m.type === 'order') { await this.gs.update('groupOrder', m.order); this.push(); }
      if (m.type === 'collapseAll') this.setAllCollapsed(m.value);
      if (m.type === 'agentsMenu') {
        const opts = ['claude', 'codex'].map((k) => ({ label: k === 'claude' ? 'Claude' : 'Codex', key: k, picked: !!(m.agents || {})[k] }));
        const sel = await vscode.window.showQuickPick(opts, { canPickMany: true, placeHolder: 'Чьи чаты показывать' });
        if (sel) view.webview.postMessage({ type: 'agents', value: { claude: sel.some((o) => o.key === 'claude'), codex: sel.some((o) => o.key === 'codex') } });
      }
      if (m.type === 'new') this.newChat(m.agent, m.group);
      if (m.type === 'toggleRead') {
        const c = this.byKey.get(m.key);
        if (c) { await this.setRead(m.key, this.isUnread(c)); this.push(); }
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
