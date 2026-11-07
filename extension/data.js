// Чтение истории чатов Claude Code и Codex с диска. Без зависимостей от VS Code,
// чтобы можно было проверить из обычного node.
'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const CODEX_INDEX = path.join(HOME, '.codex', 'session_index.jsonl');
const VSCODE_DB = path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'state.vscdb');

const MAX_MSG = 20000;        // символов из одного сообщения в индекс поиска
const MAX_TEXT = 1500000;     // символов на чат в индексе поиска

const ts = (s) => { const t = Date.parse(s); return isNaN(t) ? 0 : t; };
const isQuestion = (t) => /\?[\s*_)»"'`]*$/.test((t || '').trim());

function cleanClaudeUser(t) {
  return t
    .replace(/<(system-reminder|ide_[a-z_]+|local-command-[a-z]+|command-[a-z]+)[^>]*>[\s\S]*?<\/\1>/g, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim();
}

function cleanCodexUser(t) {
  if (!t) return '';
  if (t.startsWith('# AGENTS.md') || t.startsWith('<')) return '';
  const k = t.indexOf('## My request for Codex:');
  if (k >= 0) return t.slice(k + 24).trim();
  if (t.startsWith('# Context from my IDE setup')) return '';
  return t.trim();
}

function newChat(agent, id, file) {
  return {
    key: (agent === 'claude' ? 'c:' : 'x:') + id, agent, id, file,
    title: '', aiTitle: '', customTitle: '', firstUser: '', cwd: '',
    lastTs: 0, lastUserTs: 0, lastAssistantTs: 0, lastAssistantText: '',
    finished: true, text: '', msgCount: 0,
  };
}

function addText(chat, who, t) {
  if (!t || chat.text.length >= MAX_TEXT) return;
  chat.text += (who === 'user' ? '\n» ' : '\n') + t.slice(0, MAX_MSG);
  chat.msgCount++;
}

// ---------- Claude ----------
function parseClaude(content, id, file) {
  const chat = newChat('claude', id, file);
  for (const line of content.split('\n')) {
    if (!line) continue;
    // быстрый отсев тяжёлых служебных строк
    if (line.startsWith('{"type":"api-request') || line.includes('"type":"file-history')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const type = d.type;
    if (type === 'ai-title') { chat.aiTitle = d.aiTitle || chat.aiTitle; continue; }
    if (type === 'custom-title') { chat.customTitle = d.customTitle || d.title || chat.customTitle; continue; }
    if (type === 'summary' && d.summary && !chat.aiTitle) { chat.aiTitle = d.summary; continue; }
    if (type !== 'user' && type !== 'assistant') continue;
    if (d.isSidechain || d.isMeta) continue;
    if (!chat.cwd && d.cwd) chat.cwd = d.cwd;
    if (d.entrypoint === 'sdk-cli') chat.background = true; // запуск `claude -p` без окна (фоновая задача)
    const t = ts(d.timestamp);
    const c = d.message && d.message.content;
    if (type === 'user') {
      let text = '';
      let toolOnly = false;
      if (typeof c === 'string') text = c;
      else if (Array.isArray(c)) {
        toolOnly = c.length > 0 && c.every((b) => b.type === 'tool_result');
        text = c.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      }
      if (toolOnly) { chat.finished = false; if (t) chat.lastTs = Math.max(chat.lastTs, t); continue; }
      text = cleanClaudeUser(text);
      if (!text) continue;
      if (text.startsWith('[Request interrupted')) { chat.finished = true; continue; }
      if (!chat.firstUser) chat.firstUser = text.slice(0, 200);
      chat.lastUserTs = t; chat.lastTs = Math.max(chat.lastTs, t);
      chat.finished = false;
      addText(chat, 'user', text);
    } else {
      const blocks = Array.isArray(c) ? c : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const stop = d.message && d.message.stop_reason;
      if (t) chat.lastTs = Math.max(chat.lastTs, t);
      if (text) {
        chat.lastAssistantTs = t; chat.lastAssistantText = text.slice(-600);
        addText(chat, 'assistant', text);
      }
      chat.finished = stop === 'end_turn' || stop === 'stop_sequence' || (text && !blocks.some((b) => b.type === 'tool_use') && stop !== 'tool_use');
    }
  }
  chat.title = chat.customTitle || chat.aiTitle || chat.firstUser.split('\n')[0].slice(0, 80) || 'Без названия';
  if (chat.background) { // «Ты фоновый агент… по заданию `…/Папка/00_Задание.md`» → «Папка — партия»
    const m = chat.firstUser.match(/заданию `([^`]+)\/00_[^`/]*`/);
    if (m && !chat.customTitle) chat.title = m[1].split('/').pop() + ' — партия';
  }
  return chat;
}

// ---------- Codex ----------
function parseCodex(content, file) {
  let chat = null;
  for (const line of content.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      if (p.parent_thread_id || (p.source && typeof p.source === 'object' && p.source.subagent)) return null; // служебные под-чаты
      chat = newChat('codex', p.id, file);
      chat.cwd = p.cwd || '';
      continue;
    }
    if (!chat) continue;
    const t = ts(d.timestamp);
    if (d.type === 'event_msg') {
      if (p.type === 'task_started') chat.finished = false;
      if (p.type === 'task_complete' || p.type === 'turn_aborted') chat.finished = true;
      continue;
    }
    if (d.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const raw = (p.content || []).map((b) => b.text || '').join('\n');
      if (p.role === 'user') {
        const text = cleanCodexUser(raw);
        if (!text) continue;
        if (!chat.firstUser) chat.firstUser = text.slice(0, 200);
        chat.lastUserTs = t; chat.lastTs = Math.max(chat.lastTs, t);
        addText(chat, 'user', text);
      } else {
        const text = raw.trim();
        if (!text) continue;
        chat.lastAssistantTs = t; chat.lastAssistantText = text.slice(-600);
        chat.lastTs = Math.max(chat.lastTs, t);
        addText(chat, 'assistant', text);
      }
    }
  }
  if (chat) chat.title = chat.firstUser.split('\n')[0].slice(0, 80) || 'Без названия';
  return chat;
}

async function readCodexTitles() {
  const map = {};
  try {
    const content = await fsp.readFile(CODEX_INDEX, 'utf8');
    for (const line of content.split('\n')) {
      if (!line) continue;
      try { const d = JSON.parse(line); if (d.thread_name) map[d.id] = d.thread_name; } catch {}
    }
  } catch {}
  return map;
}

// Значение расширения из базы состояния VS Code (только чтение).
// where — условие SQL на колонку key, например "key='x.y'"; берётся первая подходящая строка.
function readVsState(where) {
  return new Promise((resolve) => {
    if (!fs.existsSync(VSCODE_DB)) return resolve(null);
    execFile('/usr/bin/sqlite3', ['-readonly', VSCODE_DB, `select value from ItemTable where ${where} limit 1`],
      { maxBuffer: 20 * 1024 * 1024, timeout: 5000 }, (err, out) => {
        if (err || !out) return resolve(null);
        try { resolve(JSON.parse(out)); } catch { resolve(null); }
      });
  });
}

// ---------- Группы и архив Claude Code (из базы VS Code, только чтение) ----------
function readClaudeState() {
  return new Promise((resolve) => {
    if (!fs.existsSync(VSCODE_DB)) return resolve({ groups: {}, hidden: new Set() });
    execFile('/usr/bin/sqlite3', ['-readonly', VSCODE_DB, "select value from ItemTable where key='Anthropic.claude-code'"],
      { maxBuffer: 20 * 1024 * 1024, timeout: 5000 }, (err, out) => {
        const groups = {}; let hidden = new Set();
        if (!err && out) {
          try {
            const d = JSON.parse(out);
            for (const [k, v] of Object.entries(d)) {
              if (k.startsWith('sessionGroups:') && Array.isArray(v)) {
                for (const g of v) for (const sid of g.sessionIds || []) groups[sid] = g.name;
              }
            }
            if (Array.isArray(d.hiddenSessionIds)) hidden = new Set(d.hiddenSessionIds);
          } catch {}
        }
        resolve({ groups, hidden });
      });
  });
}

// ---------- Список файлов ----------
async function listFiles() {
  const out = [];
  try {
    for (const dir of await fsp.readdir(CLAUDE_DIR)) {
      const full = path.join(CLAUDE_DIR, dir);
      let names;
      try { names = await fsp.readdir(full); } catch { continue; }
      for (const n of names) if (n.endsWith('.jsonl')) out.push({ agent: 'claude', file: path.join(full, n), id: n.slice(0, -6) });
    }
  } catch {}
  async function walk(d) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.name.endsWith('.jsonl')) out.push({ agent: 'codex', file: f });
    }
  }
  await walk(CODEX_DIR);
  return out;
}

// Сканер с кэшем по размеру и времени изменения файла.
class Scanner {
  constructor(cache) { this.cache = cache || {}; this.dirty = false; }

  async scan() {
    const files = await listFiles();
    const seen = new Set();
    let n = 0;
    for (const f of files) {
      seen.add(f.file);
      let st;
      try { st = await fsp.stat(f.file); } catch { continue; }
      const c = this.cache[f.file];
      if (c && c.mtime === st.mtimeMs && c.size === st.size) { if (c.chat) c.chat.mtime = st.mtimeMs; continue; }
      let content;
      try { content = await fsp.readFile(f.file, 'utf8'); } catch { continue; }
      let chat = f.agent === 'claude' ? parseClaude(content, f.id, f.file) : parseCodex(content, f.file);
      if (chat && !chat.msgCount) chat = null; // пустые чаты не показываем
      if (chat) chat.mtime = st.mtimeMs;
      this.cache[f.file] = { mtime: st.mtimeMs, size: st.size, chat };
      this.dirty = true;
      if (++n % 5 === 0) await new Promise((r) => setImmediate(r)); // не блокировать VS Code
    }
    for (const k of Object.keys(this.cache)) if (!seen.has(k)) { delete this.cache[k]; this.dirty = true; }

    const [titles, state] = await Promise.all([readCodexTitles(), readClaudeState()]);
    const chats = [];
    for (const v of Object.values(this.cache)) {
      const ch = v.chat;
      if (!ch) continue;
      if (ch.agent === 'codex' && titles[ch.id]) ch.title = titles[ch.id];
      ch.claudeGroup = ch.agent === 'claude' ? (state.groups[ch.id] || '') : '';
      ch.archived = ch.agent === 'claude' && state.hidden.has(ch.id);
      chats.push(ch);
    }
    return chats;
  }
}

// Поиск: все слова запроса должны встретиться в названии или тексте.
function search(chats, q, titles = {}) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const res = [];
  for (const ch of chats) {
    const title = titles[ch.key] || ch.title;
    if (!ch._lower || ch._lowerTitle !== title) { ch._lower = (title + '\n' + ch.text).toLowerCase(); ch._lowerTitle = title; }
    if (!words.every((w) => ch._lower.includes(w))) continue;
    const i = ch._lower.indexOf(words[0]);
    const tl = title.length + 1;
    let snippet = '';
    if (i >= tl) {
      const s = Math.max(tl, i - 60);
      snippet = (s > tl ? '…' : '') + (title + '\n' + ch.text).slice(s, i + 120).replace(/\s+/g, ' ').trim() + '…';
    }
    res.push({ key: ch.key, snippet });
  }
  return res;
}

// ---------- Автогруппы по реестру проектов ----------
// Строка реестра: | код | название | сфера | статус | папка | цель (… Признаки: a, b, c.) | …
function loadRegistry(file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of content.split('\n')) {
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length < 8 || !/^[a-z0-9]+$/.test(cells[1]) || cells[1] === 'Код') continue;
    const [, code, fullName, , status, , goal] = cells;
    if (status === 'завершён') continue;
    const name = fullName.replace(/^Облачный агент:.*/, 'Облачный агент').split(/ — |: /)[0].trim();
    const words = new Set();
    const m = goal.match(/Признаки:([^|]*)/);
    if (m) for (const w of m[1].split(/[,;]/)) {
      for (const part of w.replace(/[«»"`.]/g, '').split(/\s*\/\s*|\s*\(\s*|\s*\)\s*/)) {
        const t = part.trim();
        if (t.length >= 3 && !/^уточнить/.test(t)) words.add(t);
      }
    }
    if (name.length >= 3) words.add(name);
    // русскому слову разрешаем падежное окончание до 3 букв: «Telegram-бота», «сторожа»
    const res = [...words].map((w) => new RegExp('(?<![\\p{L}\\p{N}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
      (/[а-яё]$/i.test(w) && w.length >= 4 ? '[а-яё]{0,3}' : '') + '(?![\\p{L}\\p{N}])', 'iu'));
    out.push({ code, name, res });
  }
  return out;
}

// Проект с наибольшим числом совпадений: название чата весит втрое больше начала переписки.
function autoGroup(chat, registry) {
  if (!registry.length) return '';
  const head = chat.text.slice(0, 4000);
  let best = '', bestScore = 0;
  for (const p of registry) {
    let s = 0;
    for (const re of p.res) { if (re.test(chat.title)) s += 3; if (re.test(head)) s += 1; }
    if (s > bestScore) { bestScore = s; best = p.name; }
  }
  return bestScore >= 2 ? best : '';
}

// Читаемый протокол фонового чата (`claude -p`): Claude Code такие чаты не открывает.
function claudeTranscript(content, title) {
  const out = [`# ${title}`, ''];
  const cut = (t, n) => (t.length > n ? t.slice(0, n) + ' …' : t);
  const time = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('ru-RU'); };
  for (const line of content.split('\n')) {
    if (!line || line.startsWith('{"type":"api-request')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if ((d.type !== 'user' && d.type !== 'assistant') || d.isSidechain) continue;
    const c = d.message && d.message.content;
    const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        const t = d.type === 'user' ? cleanClaudeUser(b.text) : b.text.trim();
        if (!t) continue;
        out.push('', d.type === 'user' ? `## 🧑 Задание · ${time(d.timestamp)}` : `### 🤖 Агент · ${time(d.timestamp)}`, '', t, '');
      } else if (b.type === 'tool_use') {
        const i = b.input || {};
        const arg = i.command || i.file_path || i.pattern || i.path || i.url || i.description || JSON.stringify(i);
        out.push(`- 🔧 **${b.name}** \`${cut(String(arg).replace(/\s+/g, ' '), 300).replace(/`/g, "'")}\``);
      } else if (b.type === 'tool_result') {
        const r = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : '';
        if (b.is_error) out.push(`  - ⚠️ ${cut(r.replace(/\s+/g, ' '), 300)}`);
      }
    }
  }
  return out.join('\n') + '\n';
}

module.exports = { Scanner, search, isQuestion, loadRegistry, autoGroup, readVsState, HOME, claudeTranscript };
