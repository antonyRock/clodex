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
    lastTs: 0, lastUserTs: 0, lastAssistantTs: 0, lastAssistantText: '', lastUserText: '',
    finished: true, text: '', msgCount: 0,
    ctx: 0, // размер контекста на последнем шаге агента, токенов (сколько перечитывает каждое новое сообщение)
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
      chat.lastUserTs = t; chat.lastTs = Math.max(chat.lastTs, t); chat.lastUserText = text.slice(0, 600);
      chat.finished = false;
      addText(chat, 'user', text);
    } else {
      const blocks = Array.isArray(c) ? c : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const stop = d.message && d.message.stop_reason;
      if (t) chat.lastTs = Math.max(chat.lastTs, t);
      const u = d.message && d.message.usage;
      if (u) chat.ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (text) {
        chat.lastAssistantTs = t; chat.lastAssistantText = text.slice(-1200);
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
      if (p.source === 'exec' || p.originator === 'codex_exec') chat.background = true; // `codex exec` без окна (сервер, бот)
      continue;
    }
    if (!chat) continue;
    const t = ts(d.timestamp);
    if (d.type === 'event_msg') {
      if (p.type === 'task_started') chat.finished = false;
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) chat.ctx = p.info.last_token_usage.input_tokens || chat.ctx;
      if (p.type === 'task_complete' || p.type === 'turn_aborted') chat.finished = true;
      continue;
    }
    if (d.type === 'response_item' && p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const raw = (p.content || []).map((b) => b.text || '').join('\n');
      if (p.role === 'user') {
        const text = cleanCodexUser(raw);
        if (!text) continue;
        if (!chat.firstUser) {
          chat.firstUser = text.slice(0, 200);
          if (chat.background) chat.bgTitle = codexJobTitle(text);
        }
        chat.lastUserTs = t; chat.lastTs = Math.max(chat.lastTs, t); chat.lastUserText = text.slice(0, 600);
        addText(chat, 'user', text);
      } else {
        let text = raw.trim();
        if (!text) continue;
        if (chat.background) text = codexResultText(text) || text;
        chat.lastAssistantTs = t; chat.lastAssistantText = text.slice(-1200);
        chat.lastTs = Math.max(chat.lastTs, t);
        addText(chat, 'assistant', text);
      }
    }
  }
  if (chat) chat.title = chat.bgTitle || chat.firstUser.split('\n')[0].slice(0, 80) || 'Без названия';
  return chat;
}

// «…партию №0012…\n# Полный смысловой разбор ChatGPT — поручение…» → «Полный смысловой разбор ChatGPT — партия 0012»
function codexJobTitle(text) {
  const head = text.slice(0, 3000);
  const h = head.match(/^#\s+(.+?)(?:\s+—\s+.*)?$/m);
  const n = head.match(/парти[юяи]\s*№\s*(\d+)/i);
  if (!h && !n) return '';
  return (h ? h[1].trim() : 'Фоновая задача') + (n ? ' — партия ' + n[1] : '');
}

// Итог фоновой партии приходит машинным JSON — показываем его по-человечески.
function codexResultText(text) {
  if (!text.startsWith('{')) return '';
  let r;
  try { r = JSON.parse(text); } catch { return ''; }
  if (!r || typeof r !== 'object') return '';
  const out = [];
  if (r.status) out.push(r.status === 'batch_complete' ? '✅ Партия выполнена' : `Статус: ${r.status}`);
  if (r.summary) out.push(String(r.summary));
  const nums = [];
  if (Array.isArray(r.complete_segment_ids)) nums.push(`фрагментов: ${r.complete_segment_ids.length}`);
  if (r.facts_added != null) nums.push(`факт-записей: +${r.facts_added}`);
  if (r.culture_added) nums.push(`культура: +${r.culture_added}`);
  if (Array.isArray(r.equipment_cards_updated) && r.equipment_cards_updated.length) nums.push(`карточек оборудования: ${r.equipment_cards_updated.length}`);
  if (nums.length) out.push(nums.join(' · '));
  if (Array.isArray(r.changed_files) && r.changed_files.length) out.push('Изменены файлы:\n' + r.changed_files.map((f) => `- ${f}`).join('\n'));
  return out.join('\n\n');
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

// Читаемый протокол фонового чата Codex (`codex exec`): задание (сокращённо), что агент писал, какие команды запускал, итог.
function codexTranscript(content, title) {
  const out = [`# ${title}`, ''];
  const cut = (t, n) => (t.length > n ? t.slice(0, n) + ' …' : t);
  const time = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleString('ru-RU'); };
  const cmdOf = (input) => {
    const m = String(input || '').match(/cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return String(input || '');
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  };
  for (const line of content.split('\n')) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'response_item') continue;
    const p = d.payload || {};
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const raw = (p.content || []).map((b) => b.text || '').join('\n');
      if (p.role === 'user') {
        const t = cleanCodexUser(raw);
        if (!t) continue;
        const short = t.length > 1500 ? t.slice(0, 1500) + `\n\n*…задание сокращено: всего ${t.length.toLocaleString('ru-RU')} знаков (инструкция и текст фрагментов).*` : t;
        out.push('', `## 🧑 Задание · ${time(d.timestamp)}`, '', short, '');
      } else {
        const t = codexResultText(raw.trim()) || raw.trim();
        if (t) out.push('', `### 🤖 Агент · ${time(d.timestamp)}`, '', t, '');
      }
    } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      let arg = p.type === 'custom_tool_call' ? cmdOf(p.input) : p.arguments;
      if (p.type === 'function_call') { try { const a = JSON.parse(p.arguments); arg = a.cmd || a.command || p.arguments; } catch {} }
      if (Array.isArray(arg)) arg = arg.join(' ');
      const first = String(arg).split('\n').slice(0, 2).join(' ⏎ ');
      out.push(`- 🔧 \`${cut(first.replace(/\s+/g, ' '), 300).replace(/`/g, "'")}\``);
    }
  }
  return out.join('\n') + '\n';
}

// Фоновые задачи по контрольным точкам (`*Контрольная точка.json`), которые синхронизируются с сервера.
// Работает, если статус «running»/«в работе» и файл менялся недавно — так зависшая задача не светится вечно.
const JOB_FRESH_MS = 20 * 60 * 1000;
function listJobs(root) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name.startsWith('99_') || e.name === '10_Документы' || e.name === 'node_modules') continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); continue; }
      if (!/Контрольная точка\.json$/.test(e.name)) continue;
      let d, st;
      try { st = fs.statSync(f); d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
      const status = String(d.status || '');
      const fresh = Date.now() - st.mtimeMs < JOB_FRESH_MS;
      const running = /^(running|в работе)$/i.test(status) && fresh;
      const name = path.basename(dir).replace(/^\d+_/, '');
      const total = d.queue_total || 0, done = d.segments_done || 0;
      const progress = total && done ? `${done.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')} (${Math.floor(done * 100 / total)}%)` : (d.batches_done ? `партий: ${d.batches_done}` : '');
      const logs = ['03_Ход разбора.md'].map((n) => path.join(dir, n)).filter((x) => fs.existsSync(x));
      out.push({ name, dir, file: f, status, running, mtime: st.mtimeMs, progress, batch: d.pending_batch || null, log: logs[0] || f });
    }
  };
  walk(root, 0);
  return out;
}

module.exports = { Scanner, search, isQuestion, loadRegistry, autoGroup, readVsState, HOME, claudeTranscript, codexTranscript, listJobs };
