// Страница панели Clodex.
(function () {
  const vscode = acquireVsCodeApi();
  window.clodexApi = vscode; // общий для плашки «Скриншоты» (media/screens.js): второй acquireVsCodeApi нельзя
  // любая ошибка панели — в журнал Clodex и текстом на экран, а не пустая панель
  function reportError(msg) {
    try { vscode.postMessage({ type: 'clientError', message: String(msg) }); } catch {}
    const l = document.getElementById('list');
    if (l) l.innerHTML = '<div class="empty">Ошибка Clodex: ' + String(msg).replace(/</g, '&lt;') + '<br>Подробности — «Вид → Вывод → Clodex».</div>';
  }
  window.addEventListener('error', (e) => reportError((e.message || e.error) + ' @' + e.lineno + ':' + e.colno));
  const st = vscode.getState() || {};
  st.filter = st.filter || 'all'; st.q = st.q || '';
  if (!st.agents) st.agents = { claude: true, codex: true };
  // 0.9.56: фильтр «личные / рабочие» — любые сочетания: st.scopes = { work, personal, none } (true — показывать). Раньше был один выбор st.scope.
  if (!st.scopes) {
    const o = st.scope; // перенос старого значения: all | work | personal | none
    st.scopes = o === 'work' || o === 'personal' || o === 'none' ? { work: o === 'work', personal: o === 'personal', none: o === 'none' } : { work: true, personal: true, none: true };
  }
  delete st.scope;
  const scopeAll = () => st.scopes.work && st.scopes.personal && st.scopes.none;
  const NO_GROUP = 'Без группы';
  let items = [], favorites = {}, favChats = {}, collapsed = {}, order = [], icons = {}, customGroups = [], lastAgent = 'claude', installed = { claude: true, codex: true };
  // Открытый чат остаётся в фильтре (даже став прочитанным), пока не откроете другой.
  let sticky = null;
  const keep = (i) => i.key === sticky;
  const agName = (a) => (a === 'claude' ? 'Claude' : 'Codex');
  // Агент для «+» в группе: последний, а если он не установлен — тот, что есть.
  const plusAgent = () => (installed[lastAgent] ? lastAgent : installed.claude ? 'claude' : installed.codex ? 'codex' : '');
  const NOT_INST = (a) => `${a === 'claude' ? 'Claude Code' : 'Codex'} не установлен в VS Code`;
  const badge = (a, tip) => icons[a]
    ? `<span class="ag logo ${a}" title="${tip || ''}">${icons[a]}</span>`
    : `<span class="ag ${a}" title="${tip || ''}">${a === 'claude' ? 'C' : 'X'}</span>`;
  let results = null, resultQ = '';
  let jobs = []; // названия фоновых задач сервера, которые работают сейчас
  let jobPct = []; // их процент (по контрольной точке), null — неизвестен

  const $ = (id) => document.getElementById(id);
  const list = $('list'), q = $('q');
  q.value = st.q;

  // «Последние» убраны, «Все» называются «Недавние»; «Не прочитано» — по клику на счётчик новых в заголовке
  if (st.filter === 'recent') st.filter = 'all';
  const FILTERS = [['all', 'Недавние'], ['fav', 'Избранное'], ['active', 'Активные']]; // четвёртая плитка — «Фильтр» (личные / рабочие); «Жду ответа» и архив — в меню воронки (0.9.46)
  // Значки плиток: у каждого фильтра свой
  const TILE_ICON = {
    all: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2.2 1.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    waiting: '<svg viewBox="0 0 16 16"><path d="M2.5 4.2c0-.9.7-1.6 1.6-1.6h7.8c.9 0 1.6.7 1.6 1.6v5.2c0 .9-.7 1.6-1.6 1.6H7l-3 2.4V11c-.8 0-1.5-.7-1.5-1.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><circle cx="5.6" cy="6.8" r=".9" fill="currentColor"/><circle cx="8" cy="6.8" r=".9" fill="currentColor"/><circle cx="10.4" cy="6.8" r=".9" fill="currentColor"/></svg>',
    disk: '<svg viewBox="0 0 16 16"><path d="M2.6 3.4c0-.5.4-.8.8-.8h7.6l2.4 2.4v7.6c0 .4-.3.8-.8.8H3.4c-.4 0-.8-.4-.8-.8z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 2.8v2.8h5V2.8M5 13.2V9.4h6v3.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.3l3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const FILTER_TIP = {
    active: 'Агент работает, ответил, а вы не прочитали, в чате что-то было за последние 24 часа или вы открывали его за последние 24 часа',
    all: 'Все чаты, свежие сверху', unread: 'Агент ответил, а вы не открывали',
    waiting: 'Последний ответ агента кончается вопросом, а вы после него не писали', archive: 'Чаты, убранные в архив', fav: 'По группам — избранные группы, списком — избранные чаты (звёздочка у группы или у чата). Число — сколько их в текущем виде',
  };
  // Вид каждого фильтра: по группам или списком; повторное нажатие на выбранный фильтр переключает.
  const GROUPED_DEFAULT = { all: true, fav: true, active: true, recent: false, unread: false, waiting: false, archive: false, bg: false };
  if (!st.grouped) st.grouped = { ...GROUPED_DEFAULT, recent: !!st.recentGrouped };
  const isGrouped = (f) => (f in st.grouped ? st.grouped[f] : GROUPED_DEFAULT[f]);
  const VIEW_ICON = {
    groups: '<svg class="vi" viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="4.5" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="12" height="4.5" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    hot: '<svg class="vi" viewBox="0 0 16 16"><path d="M9 1.5 3.5 9H7.7L7 14.5 12.5 7H8.3z" fill="currentColor"/></svg>',
    list: '<svg class="vi" viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };
  // Активные: агент работает, не прочитан или в чате что-то было за последние 2 часа; фоновые — только пока работают
  const ACTIVE_MS = 24 * 3600e3; // «Активные»: последнее сообщение или открытие чата не старше суток
  const HOT_MS = 2 * 3600e3; // «Недавние» третьим нажатием: свежее 2 часов
  // значок Telegram: бумажный самолётик в голубом круге
  const TG_ICON = '<svg class="bico tg" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#2AABEE"/><path fill="#fff" d="M5.4 11.7l11.2-4.3c.5-.2 1 .1.8.9l-1.9 9c-.1.6-.5.8-1 .5l-2.9-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-3 5.4-4.9c.2-.2 0-.3-.3-.1l-6.7 4.2-2.9-.9c-.6-.2-.6-.6.1-.9z"/></svg>';
  const BOT_COOL_MS = 2 * 60e3; // сколько плашка «бот» горит жёлтым после ответа
  const isActive = (i, ms = ACTIVE_MS) => i.status === 'working' || ((!i.background || i.bot) && (i.status === 'unread' || Date.now() - i.ts < ms || (ms === ACTIVE_MS && Date.now() - (i.opened || 0) < ms))); // бот: разговор за 2 часа — тоже активный
  const BOLT = '<svg class="bolt" viewBox="0 0 16 16"><path d="M9.2 1.5 3.5 9h4l-.9 5.5L12.5 7h-4z" fill="currentColor"/></svg>';
  const ICON = {
    cont: '<svg viewBox="0 0 16 16"><path d="M3 8h8M8 4.5L11.5 8 8 11.5M13.5 3.5v9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    archive: '<svg viewBox="0 0 16 16"><path d="M2 3h12v3H2zM3 6v7h10V6M6.5 8.5h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    unarchive: '<svg viewBox="0 0 16 16"><path d="M2 3h12v3H2zM3 6v7h10V6M8 12V8m-2 2 2-2 2 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    pencil: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/></svg>',
    grip: '<svg viewBox="0 0 16 16"><g fill="currentColor"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></g></svg>',
    star: '<svg viewBox="0 0 16 16"><path d="M8 1.9l1.83 3.86 4.22.53-3.1 2.92.8 4.19L8 11.33 4.25 13.4l.8-4.19-3.1-2.92 4.22-.53z" stroke-width="1.15" stroke-linejoin="round"/></svg>',
    chev: '<svg viewBox="0 0 16 16"><path d="M5 6l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const save = () => vscode.setState(st);

  // ---------- тема ----------
  // Clodex всегда в цветах VS Code. Светлая ли тема — сообщает расширение (событие VS Code),
  // без слежения за классами страницы. Кнопка ☀/☾ переключает тему всего VS Code.
  const THEME_ICON = {
    moon: '<svg viewBox="0 0 16 16"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    sun: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="2.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  };
  let isLight = null;
  function applyTheme(light) {
    if (light === isLight) return;
    isLight = light;
    document.body.classList.toggle('light', light);
    document.body.classList.add('auto');
    const btn = document.getElementById('themeBtn');
    if (btn) { btn.innerHTML = light ? THEME_ICON.moon : THEME_ICON.sun; btn.title = light ? 'Включить тёмную тему VS Code' : 'Включить светлую тему VS Code'; }
  }
  // до первого сообщения расширения — по теме, с которой открылась страница (один раз)
  applyTheme(document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light'));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function ago(t) {
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'сейчас';
    if (m < 60) return m + ' мин';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' ч';
    const d = Math.round(h / 24);
    if (d === 1) return 'вчера';
    if (d < 7) return d + ' дн';
    return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
  }
  function mark(s, query) {
    let h = esc(s);
    for (const w of query.toLowerCase().split(/\s+/).filter(Boolean)) {
      const re = new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      h = h.replace(re, (x) => '<mark>' + x + '</mark>');
    }
    return h;
  }

  const inScope = (i) => scopeAll() || !!st.scopes[i.scope || 'none'];
  const byAgent = (i) => !!st.agents[i.agent] && inScope(i);
  const live = () => items.filter((i) => !i.archived && byAgent(i));

  let lastCnt = { archive: 0 };
  // Меню воронки: чьи чаты показывать и архив
  function renderMenu() {
    const row = (k) => `<button class="mi ${st.agents[k] ? 'on' : ''}" data-a="${k}"><span class="ck">${st.agents[k] ? TILE_ICON.check : ''}</span>${badge(k)}<span>${agName(k)}</span></button>`;
    $('agentsMenu').innerHTML = row('claude') + row('codex') + '<div class="msep"></div>'
      + `<button class="mi ${st.filter === 'waiting' ? 'on' : ''}" data-waitmenu="1" title="Последний ответ агента кончается вопросом, а вы после него не писали"><span class="ck">${st.filter === 'waiting' ? TILE_ICON.check : ''}</span><span class="ai">${TILE_ICON.waiting}</span><span>Жду ответа</span><b>${lastCnt.waiting || ''}</b></button>`
      + `<button class="mi ${st.filter === 'archive' ? 'on' : ''}" data-archmenu="1"><span class="ck">${st.filter === 'archive' ? TILE_ICON.check : ''}</span><span class="ai">${TILE_ICON.disk}</span><span>Архив</span><b>${lastCnt.archive || ''}</b></button>`;
  }
  const closeMenu = () => { $('agentsMenu').hidden = true; };
  // Меню «Фильтр» (0.9.46): все / рабочие / личные / без метки — поверх любой плитки
  const SC = { all: 'Все чаты', work: 'Рабочие', personal: 'Личные', none: 'Без метки' };
  const SC_LET = { work: 'Р', personal: 'Л' };
  function renderScopeMenu() {
    const base = items.filter((i) => !i.archived && st.agents[i.agent]);
    const n = { all: base.length, work: base.filter((i) => i.scope === 'work').length, personal: base.filter((i) => i.scope === 'personal').length, none: base.filter((i) => !i.scope).length };
    const isOn = (k) => (k === 'all' ? scopeAll() : !!st.scopes[k]);
    const row = (k) => `<button class="mi ${isOn(k) ? 'on' : ''}" data-scope="${k}"><span class="ck">${isOn(k) ? TILE_ICON.check : ''}</span>${SC_LET[k] ? `<span class="sc sc-${k}">${SC_LET[k]}</span>` : '<span class="sc sc-none">·</span>'}<span>${SC[k]}</span><b>${n[k] || ''}</b></button>`;
    $('scopeMenu').innerHTML = row('all') + '<div class="msep"></div>' + row('work') + row('personal') + row('none')
      + '<div class="mhint">Можно отметить несколько: например «Рабочие» и «Без метки». Метка чата — кнопка Р / Л слева в строке. Без неё чат берёт сферу проекта из реестра.</div>';
  }
  function openScopeMenu() {
    const m = $('scopeMenu'), b = document.querySelector('[data-scopebtn]'), top = $('top');
    if (!m.hidden) { m.hidden = true; return; }
    closeMenu(); renderScopeMenu(); m.hidden = false;
    if (b && top) { const r = b.getBoundingClientRect(), t = top.getBoundingClientRect(); m.style.top = (r.bottom - t.top + 4) + 'px'; m.style.right = Math.max(6, t.right - r.right) + 'px'; }
  }

  // Меню «Размер» (0.8.6): масштаб Clodex и шрифт чатов Claude/Codex (настройка VS Code chat.fontSize)
  let sizes = { zoom: Number(document.documentElement.dataset.zoom) || 1, chatFont: 13, chatDefault: 13 };
  document.documentElement.style.zoom = String(sizes.zoom); // сразу, до первой отрисовки
  function renderSizeMenu() {
    const r = (label, hint, val, key, minus, plus) => `<div class="srow"><div class="sl"><span>${label}</span><small>${hint}</small></div>`
      + `<button class="sb" data-${key}="-1" ${minus ? '' : 'disabled'} title="Меньше">−</button><b class="sv">${val}</b><button class="sb" data-${key}="1" ${plus ? '' : 'disabled'} title="Больше">+</button></div>`;
    const z = Math.round(sizes.zoom * 100);
    $('sizeMenu').innerHTML = r('Список Clodex', 'эта панель', z + '%', 'zm', z > 70, z < 130)
      + r('Текст чатов', 'Claude и Codex', sizes.chatFont, 'cf', sizes.chatFont > 10, sizes.chatFont < 24)
      + '<div class="msep"></div>'
      + `<button class="mi" data-sreset="1" ${z === 100 && sizes.chatFont === sizes.chatDefault ? 'disabled' : ''}><span>Сбросить: 100% и ${sizes.chatDefault}</span></button>`;
  }
  const closeSizeMenu = () => { $('sizeMenu').hidden = true; };
  // ушли из панели (щелчок в чат, редактор, другое окно) — меню закрываются сами (0.8.7)
  window.addEventListener('blur', () => { closeSizeMenu(); closeMenu(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { closeSizeMenu(); closeMenu(); } });
  let lastFilt = '';
  const setH = (el, h) => { if (el.innerHTML !== h) el.innerHTML = h; };
  function renderFilters() {
    const v = live();
    const cnt = {
      unread: v.filter((i) => i.status === 'unread').length,
      waiting: v.filter((i) => i.waiting).length,
      archive: items.filter((i) => i.archived && byAgent(i)).length,
      active: v.filter((i) => isActive(i)).length,
      // Избранное: по группам — число избранных групп, списком — число избранных чатов (0.9.14)
      fav: isGrouped('fav') ? new Set(v.filter((i) => favorites[i.group]).map((i) => i.group)).size : v.filter((i) => favChats[i.key]).length,
    };
    // Плитки одного размера: значок, подпись, число в углу; у выбранной — значок «группы / список» в другом углу
    const tileIcon = (k) => k === 'active' ? BOLT : k === 'fav' ? `<span class="fstar">${ICON.star}</span>` : TILE_ICON[k] || '';
    const FUNNEL = '<svg viewBox="0 0 16 16"><path d="M2.5 3.5h11l-4.2 5v4l-2.6 1.2V8.5z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    const scSel = ['work', 'personal', 'none'].filter((k) => st.scopes[k]);
    const scShort = { work: 'Раб', personal: 'Лич', none: 'без' };
    const scLabel = scopeAll() ? 'Фильтр' : scSel.length === 1 ? SC[scSel[0]] : scSel.map((k) => scShort[k]).join(' + ');
    const scopeTile = `<button class="tile t-scope ${scopeAll() ? '' : 'set'}" data-scopebtn="1" title="${scopeAll() ? 'Фильтр: личные / рабочие чаты' : 'Показаны: ' + scSel.map((k) => SC[k].toLowerCase()).join(' + ') + '. Нажмите — сменить'}"><span class="ti">${FUNNEL}</span><span class="tl">${scLabel}</span></button>`;
    const waitBar = `<div class="archbar"><span class="ai">${TILE_ICON.waiting}</span>Жду ответа <b>${cnt.waiting}</b><button class="ib x" data-archclose="1" title="Закрыть">✕</button></div>`;
    const fhtml =
      FILTERS.map(([k, n]) => `<button class="tile t-${k} ${st.filter === k ? 'on' : ''} ${k === 'unread' && cnt[k] ? 'hot' : ''}" data-f="${k}" title="${(FILTER_TIP[k] || 'Все чаты') + (st.filter === k ? '. Нажмите ещё раз — ' + (k === 'all' ? (st.hot ? 'все чаты по группам' : isGrouped(k) ? 'списком' : 'по группам, только непрочитанные и свежее 2 часов') : isGrouped(k) ? 'списком' : 'по группам') : '')}"><span class="ti">${tileIcon(k)}</span><span class="tl">${n}</span>${cnt[k] ? `<b>${cnt[k]}</b>` : ''}${st.filter === k ? `<span class="mode">${k === 'all' && st.hot ? VIEW_ICON.hot : isGrouped(k) ? VIEW_ICON.groups : VIEW_ICON.list}</span>` : ''}</button>`).join('')
      + scopeTile + (st.filter === 'waiting' ? waitBar : '')
      + (st.filter === 'archive' ? `<div class="archbar"><span class="ai">${TILE_ICON.disk}</span>Архив <b>${cnt.archive}</b><button class="ib" data-f="archive" title="${isGrouped('archive') ? 'Показать списком' : 'Разложить по группам'}">${isGrouped('archive') ? VIEW_ICON.groups : VIEW_ICON.list}</button><button class="ib x" data-archclose="1" title="Закрыть архив">✕</button></div>` : '');
    if (fhtml !== lastFilt) { $('filters').innerHTML = fhtml; lastFilt = fhtml; } // 0.9.54: не пересоздавать плитки без изменений — иначе сбрасывается наведение
    lastCnt = cnt;
    $('sum').innerHTML = cnt.unread ? `<span class="pulse"></span>${cnt.unread} новых` : 'всё прочитано';
    $('sum').title = st.filter === 'unread' ? 'Показаны непрочитанные — нажмите, чтобы вернуться к «Недавним»' : cnt.unread ? `Непрочитанных чатов: ${cnt.unread} — нажмите, чтобы показать только их` : 'Показать непрочитанные';
    $('sum').className = 'sum' + (cnt.unread ? ' hot' : '') + (st.filter === 'unread' ? ' on' : '');
    // «Агент N»: сколько фоновых задач сервера работает сейчас (контрольные точки + фоновые чаты в работе)
    const bgWork = items.filter((i) => i.background && !i.bot && !i.job && i.status === 'working' && !jobs.some((j) => (i.title || '').startsWith(j)));
    const nAgent = jobs.length + bgWork.length;
    const onePct = nAgent === 1 && jobs.length === 1 && jobPct[0] != null ? jobPct[0] : null; // одна задача — показываем её процент
    const bgDay = items.filter((i) => i.background && !i.bot && Date.now() - i.ts < 24 * 3600e3).length;
    const ab = $('agentBadge');
    ab.hidden = !nAgent && !bgDay && st.filter !== 'bg';
    ab.className = 'agentb' + (nAgent ? ' run' : '') + (st.filter === 'bg' ? ' on' : '');
    setH(ab, (nAgent ? '<span class="spin"></span>' : '') + '<span class="bico">🧑‍💻</span>' + (onePct != null ? `агент · ${onePct}%` : nAgent ? `агент ${nAgent}` : 'агент'));
    ab.title = (nAgent ? `На сервере работает фоновых задач: ${nAgent}` + (jobs.length ? ` (${jobs.map((j, k) => j + (jobPct[k] != null ? ` — ${jobPct[k]}%` : '')).join(', ')})` : '') : 'Сейчас на сервере ничего не работает') + (bgDay ? `. Фоновых чатов за сутки: ${bgDay}` : '') + '. Нажмите — что делает агент';
    // «бот»: разговоры с Telegram-ботом. Мигает, пока бот отвечает; клик — только его чаты
    const botAll = items.filter((i) => i.bot);
    const botWork = botAll.filter((i) => i.status === 'working');
    // 2 минуты после ответа — жёлтая: последние правки бота ещё доезжают до Mac
    const botCool = botWork.length ? [] : botAll.filter((i) => Date.now() - i.ts < BOT_COOL_MS);
    const botDay = botAll.filter((i) => Date.now() - i.ts < 24 * 3600e3).length;
    const tb = $('botBadge');
    tb.hidden = !botAll.length;
    tb.className = 'agentb' + (botWork.length ? ' run' : botCool.length ? ' cool' : '') + (st.filter === 'tg' ? ' on' : '');
    setH(tb, (botWork.length ? '<span class="pulse"></span>' : '') + TG_ICON + 'бот');
    const edits = [...new Set((botWork.length ? botWork : botCool).flatMap((i) => i.editing || []))];
    tb.title = (botWork.length
      ? `Telegram-бот сейчас отвечает: «${botWork.map((i) => i.title).join('», «')}».` +
        (!edits.length && botWork.every((i) => i.agent === 'codex') ? '\nCodex правит файлы командами — какие именно, Clodex не видит.' :
        edits.length ? `\nПравит файлы:\n${edits.map((f) => '• ' + f).join('\n')}\nЭти файлы с Mac пока не трогайте — изменения могут затереть друг друга.` : '\nФайлов пока не правил.')
      : botCool.length ? `Telegram-бот ответил ${Math.max(1, Math.round((Date.now() - Math.max(...botCool.map((i) => i.ts))) / 1000))} с назад: «${botCool.map((i) => i.title).join('», «')}». Ещё до 2 минут лучше не ставить задач на те же файлы — его правки доезжают до Mac.` +
        (edits.length ? `\nПравил файлы:\n${edits.map((f) => '• ' + f).join('\n')}` : '')
      : `Telegram-бот сейчас молчит.${botDay ? ` Разговоров за сутки: ${botDay}.` : ''}`) +
      (st.filter === 'tg' ? '\nНажмите — показать все чаты' : '\nНажмите — только чаты бота');
    const hidden = !st.agents.claude || !st.agents.codex;
    $('agentsBtn').classList.toggle('on', hidden || st.filter === 'archive');
    $('agentsBtn').title = (hidden ? `Показаны только чаты ${st.agents.claude ? 'Claude' : 'Codex'}` : 'Фильтр: Claude / Codex') + (st.filter === 'archive' ? '. Открыт архив' : ', архив');
    if (!$('agentsMenu').hidden) renderMenu();
    if (!$('scopeMenu').hidden) renderScopeMenu();
  }

  // Вес чата: сколько токенов перечитывает каждое новое сообщение. Показываем от 100 тыс.
  function weight(i) {
    if (!i.ctx || i.ctx < 100000 || (i.background && !i.bot)) return ''; // у бота вес важен: каждое сообщение перечитывает весь разговор
    const k = Math.round(i.ctx / 1000);
    const cold = Date.now() - i.ts > 3600000;
    const tip = `Контекст ≈ ${k} тыс. токенов: каждое сообщение в этом чате заново обрабатывает всю историю. ` +
      (cold ? 'Чат давно не трогали — кэш остыл, следующее сообщение загрузит историю по полной цене. ' : '') +
      (i.bot ? 'В боте новую тему лучше начинать кнопкой «🆕 Новый чат».' : 'Новую задачу лучше начать в новом чате.');
    return `<span class="wt ${i.ctx >= 200000 ? 'huge' : ''}" title="${tip}">${k}k</span>`;
  }

  const scopeTip = (i) => (i.scope ? `${SC[i.scope].slice(0, -1) + 'й'}${i.scopeAuto ? ' (по проекту)' : ''}. Нажмите — ${i.scope === 'work' ? 'личный' : i.scopeAuto ? 'рабочий' : 'вернуть метку по проекту'}` : 'Без метки. Нажмите — рабочий');
  function row(i, snippet) {
    const tip = i.status === 'unread' ? 'Не прочитан — нажмите, чтобы отметить прочитанным' : i.status === 'working' ? (i.job ? `Идёт фоновая задача: ${i.job.progress || i.job.name}` : 'Агент работает') : 'Прочитан — нажмите, чтобы вернуть «не прочитано»';
    return `<div draggable="true" class="chat ${i.status} ${i.archived ? 'arch' : ''} ${i.key === sticky ? 'current' : ''}" data-k="${esc(i.key)}" title="${esc(i.title)}">
      <span class="dot" data-dot="1" title="${tip}"></span>
      <button class="ib cscope ${i.scope ? 'sc-' + i.scope : ''} ${i.scopeAuto ? 'auto' : ''}" data-cscope="1" title="${scopeTip(i)}">${SC_LET[i.scope] || '·'}</button>
      <span class="t">${resultQ && snippet !== undefined ? mark(i.title, resultQ) : esc(i.title)}${i.waiting ? '<span class="q" title="Агент задал вопрос и ждёт ответа">?</span>' : ''}</span>
      ${i.bot ? `<span class="ag logo tg" title="Разговор с Telegram-ботом">${TG_ICON}</span>` : i.agent === 'claude' ? '' : badge(i.agent, 'Чат ' + agName(i.agent))}
      <button class="ib cstar ${favChats[i.key] ? 'on' : ''}" data-cstar="1" title="${favChats[i.key] ? 'Убрать чат из избранного' : 'Чат в избранное'}">${ICON.star}</button>
      ${weight(i)}
      ${i.job && i.job.pct != null ? `<span class="jp" title="${esc(i.job.name)}: ${esc(i.job.progress)}${i.job.batch ? ', идёт партия ' + i.job.batch : ''}">${i.job.pct}%</span>` : ''}
      <span class="time" data-ts="${i.ts}">${ago(i.ts)}</span>
      <span class="acts">
        ${i.bot ? `<button class="ib cont" data-cont="1" title="Продолжить на Mac: новый чат Claude со ссылкой на этот разговор с ботом. Сам разговор бота не меняется.">${ICON.cont}</button>` : ''}
        ${i.agent === 'claude' && i.ctx >= 100000 && !i.background ? `<button class="ib cont" data-cont="1" title="Продолжить в новом чате: откроется новый чат Claude в этой группе, в поле ввода — текст с отсылкой к этому чату. Проверьте и нажмите Enter.">${ICON.cont}</button>` : ''}
        <button class="ib" data-arch="1" title="${i.archived ? 'Вернуть из архива' : 'В архив'}">${i.archived ? ICON.unarchive : ICON.archive}</button>
        <button class="ib" data-more="1" title="Ещё: группа, прочитано, копировать">${ICON.more}</button>
      </span>
      ${snippet ? `<div class="snip">${mark(snippet, resultQ)}</div>` : ''}
    </div>`;
  }

  // Тот же порядок, что считает расширение: сохранённый, затем по свежести, «Без группы» наверху.
  function groupOrder(groups) {
    const names = [...groups.keys()];
    const t = (g) => (groups.get(g)[0] ? groups.get(g)[0].ts : 0);
    // «Недавние» по группам (0.9.29): ручной порядок не нужен — сверху группа, где последнее сообщение свежее всех
    // (там сейчас идёт переписка); внутри группы чаты и так по свежести. «Без группы» первая.
    if (st.filter === 'all') {
      const rest = names.filter((g) => g !== NO_GROUP).sort((a, b) => t(b) - t(a));
      if (groups.has(NO_GROUP)) rest.unshift(NO_GROUP);
      return rest;
    }
    const rest = names.filter((g) => !order.includes(g) && g !== NO_GROUP).sort((a, b) => t(b) - t(a));
    const out = [...order.filter((g) => groups.has(g) && g !== NO_GROUP), ...rest];
    if (groups.has(NO_GROUP)) out.unshift(NO_GROUP); // «Без группы» всегда первая — чаты, которые ещё не разложены
    return out;
  }

  // Свёрнуты ли все видимые группы — от этого зависит, что делает кнопка «свернуть / раскрыть»
  let shownGroups = [];
  const allFolded = () => shownGroups.length > 0 && shownGroups.every((g) => collapsed[g]);
  const FOLD_ICON = {
    expand: '<svg viewBox="0 0 16 16"><path d="M4 4l4 3.5L12 4M4 8.5 8 12l4-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    collapse: '<svg viewBox="0 0 16 16"><path d="M4 7.5 8 4l4 3.5M4 12l4-3.5 4 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  function updateFold() {
    const b = $('foldAll'); if (!b) return;
    const f = allFolded();
    b.innerHTML = f ? FOLD_ICON.expand : FOLD_ICON.collapse;
    b.title = f ? 'Раскрыть все группы' : 'Свернуть все группы';
    // Кнопка видна всегда; когда чаты показаны списком, групп нет — она неактивна
    b.disabled = !shownGroups.length;
    if (!shownGroups.length) b.title = 'Свернуть / раскрыть группы — доступно, когда чаты показаны по группам';
  }
  // 0.9.50: список обновляется по частям. Раньше каждый опрос данных (раз в 4 с, пока где-то идёт работа) пересоздавал весь список,
  // и кнопки при наведении (звезда, «+», «⋯», архив) исчезали, пока мышь не сдвинется. Теперь заменяются только изменившиеся карточки.
  function setList(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    const next = [...t.content.children];
    const cur = [...list.children];
    next.forEach((n, i) => {
      if (!cur[i]) list.appendChild(n);
      else if (cur[i].outerHTML !== n.outerHTML) list.replaceChild(n, cur[i]);
    });
    for (let i = cur.length - 1; i >= next.length; i--) cur[i].remove();
  }
  function render() { try { render_(); updateFold(); } catch (e) { reportError(e && e.stack || e); } }
  function render_() {
    shownGroups = [];
    renderFilters();
    if (results) {
      const map = new Map(results.map((r) => [r.key, r.snippet]));
      const found = items.filter((i) => map.has(i.key) && byAgent(i)).sort((a, b) => b.ts - a.ts);
      setList(`<div class="hint">Найдено: ${found.length}</div>` +
        (found.length ? `<div class="card flat">${found.map((i) => row(i, map.get(i.key) || '')).join('')}</div>` : `<div class="empty">Ничего не найдено</div>`));
      return;
    }
    let v = (st.filter === 'archive' ? items.filter((i) => i.archived && byAgent(i)) : live()).sort((a, b) => b.ts - a.ts);
    // Избранное: по группам — только избранные группы; списком — только избранные чаты, без групп (0.9.14)
    if (st.filter === 'fav') v = v.filter((i) => isGrouped('fav') ? favorites[i.group] : favChats[i.key]);
    if (st.filter === 'all' && st.hot) v = v.filter((i) => isActive(i, HOT_MS) || keep(i)); // третье нажатие «Недавние»: непрочитанные и свежее 2 часов, по группам
    if (st.filter === 'unread') v = v.filter((i) => i.status === 'unread' || keep(i));
    if (st.filter === 'active') v = v.filter((i) => isActive(i) || keep(i));
    if (st.filter === 'waiting') v = v.filter((i) => i.waiting || keep(i));
    // Партии одной фоновой задачи — отдельные запуски, каждые несколько минут новый. В списке — только последняя;
    // все партии видны в «агент» → «Все фоновые чаты» и в архиве (0.9.10)
    if (st.filter !== 'bg' && st.filter !== 'archive') { const seenJob = new Set(); v = v.filter((i) => !i.jobFolder || (!seenJob.has(i.jobFolder) && seenJob.add(i.jobFolder))); }
    if (st.filter === 'recent') v = v.slice(0, 40);
    if (st.filter === 'bg') v = v.filter((i) => i.background && !i.bot);
    if (st.filter === 'tg') v = v.filter((i) => i.bot);
    if (!v.length) {
      const msg = { unread: 'Всё прочитано', all: st.hot ? 'Нет непрочитанных и свежее 2 часов — нажмите «Недавние» ещё раз' : '', waiting: 'Никто не ждёт ответа', archive: 'Архив пуст', tg: 'Разговоров с ботом нет', fav: isGrouped('fav') ? 'Избранных групп нет — наведите на группу и нажмите звёздочку' : 'Избранных чатов нет — наведите на чат и нажмите звёздочку', active: 'Активных нет: никто не работает, не ответил, и за сутки в чатах ничего не было и вы их не открывали' }[st.filter] || 'Чатов нет';
      setList(`<div class="empty">${msg}</div>`);
      return;
    }
    const grouped = isGrouped(st.filter);
    if (!grouped) { setList(`<div class="card flat">${v.map((i) => row(i)).join('')}</div>`); return; }

    const groups = new Map();
    for (const i of v) { if (!groups.has(i.group)) groups.set(i.group, []); groups.get(i.group).push(i); }
    if (st.filter === 'all') for (const g of customGroups) if (!groups.has(g)) groups.set(g, []); // пустые свои группы — только во «Все»
    shownGroups = [...groups.keys()];
    setList(groupOrder(groups).map((g) => {
      const arr = groups.get(g);
      const un = arr.filter((i) => i.status === 'unread').length;
      const work = arr.some((i) => i.status === 'working');
      const c = !!collapsed[g];
      return `<div class="card group ${c ? 'collapsed' : ''} ${un ? 'has-unread' : ''}" data-g="${esc(g)}">
        <div class="gh" ${st.filter === 'all' ? '' : 'draggable="true"'} data-g="${esc(g)}" title="${st.filter === 'all' ? 'Нажмите — свернуть/раскрыть. Порядок групп — по последней активности.' : 'Нажмите — свернуть/раскрыть. Перетащите — поменять порядок.'}">
          <span class="grip">${ICON.grip}</span>
          <span class="chev">${ICON.chev}</span>
          <span class="gn">${esc(g)}</span>
          ${g !== NO_GROUP ? `<button class="ib gstar ${favorites[g] ? 'on' : ''}" data-gstar="1" title="${favorites[g] ? 'Убрать из избранного' : 'В избранное'}">${ICON.star}</button>` : '<span class="gsp"></span>'}
          ${work ? '<span class="gwork" title="Агент работает"></span>' : ''}
          ${un ? `<span class="gun" title="Непрочитанных: ${un}">${un}</span>` : ''}
          <span class="gtime">${arr[0] ? ago(arr[0].ts) : ''}</span>
          ${plusAgent() ? `<button class="ib gplus" data-gplus="1" title="Новый чат ${agName(plusAgent())} в группе «${esc(g)}»"><svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>${badge(plusAgent())}</button>` : ''}
          ${arr.length ? (st.filter === 'archive'
            ? `<button class="ib garch" data-garch="0" title="Вернуть всю группу «${esc(g)}» из архива (${arr.length})">${ICON.unarchive}</button>`
            : `<button class="ib garch" data-garch="1" title="Всю группу «${esc(g)}» — в архив (${arr.length})">${ICON.archive}</button>`) : ''}
          <button class="ib gmore" data-gmore="1" title="Группа: порядок, переименовать, удалить">${ICON.more}</button>
        </div>
        <div class="gb">${arr.length ? arr.map((i) => row(i)).join('') : '<div class="gempty">Пусто. Перетащите сюда чат мышью — или «⋯» у чата → «Перенести в группу».</div>'}</div></div>`;
    }).join('') + (st.filter === 'all' ? '<button class="addgroup" data-addgroup="1">＋ Новая группа</button>' : ''));
  }

  // ---------- нажатия ----------
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#agentsMenu') && !e.target.closest('#agentsBtn')) closeMenu();
    if (!e.target.closest('#scopeMenu') && !e.target.closest('[data-scopebtn]')) $('scopeMenu').hidden = true;
    if (!e.target.closest('#sizeMenu') && !e.target.closest('#sizeBtn')) closeSizeMenu();
    if (e.target.closest('#sizeBtn')) { const m = $('sizeMenu'); m.hidden = !m.hidden; if (!m.hidden) renderSizeMenu(); return; }
    const zb = e.target.closest('[data-zm]');
    if (zb) { vscode.postMessage({ type: 'zoom', value: Math.round((sizes.zoom + 0.1 * Number(zb.dataset.zm)) * 10) / 10 }); return; }
    const cb = e.target.closest('[data-cf]');
    if (cb) { vscode.postMessage({ type: 'chatFont', value: sizes.chatFont + Number(cb.dataset.cf) }); return; }
    if (e.target.closest('[data-sreset]')) { vscode.postMessage({ type: 'zoom', value: 1 }); vscode.postMessage({ type: 'chatFont', value: null }); return; }
    const f = e.target.closest('[data-f]');
    if (f) {
      if (f.dataset.f === st.filter) {
        // «Недавние»: по группам → списком → по группам только непрочитанные и свежее 2 часов (0.9.30) → снова по группам
        if (st.filter === 'all') { if (!isGrouped('all')) { st.grouped.all = true; st.hot = true; } else if (st.hot) st.hot = false; else st.grouped.all = false; }
        else st.grouped[st.filter] = !isGrouped(st.filter); // повторное нажатие — группы / список
      } else st.hot = false;
      st.filter = f.dataset.f;
      if (results) { q.value = ''; onSearch(); }
      save(); render(); return;
    }
    const a = e.target.closest('[data-a]');
    if (a) {
      const k = a.dataset.a, other = k === 'claude' ? 'codex' : 'claude';
      st.agents[k] = !st.agents[k];
      if (!st.agents[k] && !st.agents[other]) st.agents[other] = true; // хотя бы один агент виден
      save(); render(); return;
    }
    if (e.target.closest('#newGroup') || e.target.closest('[data-addgroup]')) { vscode.postMessage({ type: 'newGroup' }); return; }
    if (e.target.closest('#themeBtn')) { vscode.postMessage({ type: 'toggleVsTheme' }); return; }
    if (e.target.closest('#foldAll')) { vscode.postMessage({ type: 'collapseAll', value: !allFolded() }); return; }
    if (e.target.closest('#botBadge')) { st.filter = st.filter === 'tg' ? 'all' : 'tg'; save(); render(); return; }
    if (e.target.closest('#agentBadge')) { if (st.filter === 'bg') { st.filter = 'all'; save(); render(); } else vscode.postMessage({ type: 'agentJobs' }); return; }
    if (e.target.closest('#sum')) { st.filter = st.filter === 'unread' ? 'all' : 'unread'; if (results) { q.value = ''; onSearch(); } save(); render(); return; }
    if (e.target.closest('#agentsBtn')) { const m = $('agentsMenu'); m.hidden = !m.hidden; if (!m.hidden) renderMenu(); return; }
    if (e.target.closest('[data-archmenu]')) { st.filter = st.filter === 'archive' ? 'all' : 'archive'; if (results) { q.value = ''; onSearch(); } closeMenu(); save(); render(); return; }
    if (e.target.closest('[data-archclose]')) { st.filter = 'all'; save(); render(); return; }
    const gp = e.target.closest('[data-gplus]');
    if (gp) { vscode.postMessage({ type: 'new', agent: 'last', group: gp.closest('.gh').dataset.g }); return; }
    if (e.target.closest('[data-scopebtn]')) { openScopeMenu(); return; }
    const sp = e.target.closest('[data-scope]');
    if (sp) {
      const k = sp.dataset.scope;
      if (k === 'all') st.scopes = { work: true, personal: true, none: true };
      else if (!(st.scopes[k] && !['work', 'personal', 'none'].some((o) => o !== k && st.scopes[o]))) st.scopes[k] = !st.scopes[k]; // последнюю отметку не снять — иначе список пуст
      save(); render(); return; // меню остаётся открытым, чтобы отметить несколько
    }
    if (e.target.closest('[data-waitmenu]')) { st.filter = st.filter === 'waiting' ? 'all' : 'waiting'; if (results) { q.value = ''; onSearch(); } closeMenu(); save(); render(); return; }
    const sc = e.target.closest('[data-cscope]');
    if (sc) {
      e.stopPropagation();
      const k = sc.closest('.chat').dataset.k, it = items.find((x) => x.key === k); if (!it) return;
      // нет метки → рабочий → личный → (своя метка — вернуть по проекту; авто — рабочий)
      const next = !it.scope ? 'work' : it.scope === 'work' ? 'personal' : it.scopeAuto ? 'work' : '';
      vscode.postMessage({ type: 'scope', key: k, value: next });
      items = items.map((x) => (x.key === k ? { ...x, scope: next || x.scope, scopeAuto: !next } : x)); // сразу на экране; при возврате метку по проекту уточнит расширение
      render(); return;
    }
    const cs = e.target.closest('[data-cstar]');
    if (cs) {
      const k = cs.closest('.chat').dataset.k, v = !favChats[k];
      favChats = { ...favChats, [k]: v }; // сразу на экране
      vscode.postMessage({ type: 'favChat', key: k, value: v });
      render();
      if (v) { const b = [...document.querySelectorAll('.chat')].find((c) => c.dataset.k === k)?.querySelector('.cstar'); if (b) b.classList.add('pop'); }
      return;
    }
    const gs = e.target.closest('[data-gstar]');
    if (gs) {
      const g = gs.closest('.gh').dataset.g, v = !favorites[g];
      favorites = { ...favorites, [g]: v }; // сразу на экране, не дожидаясь расширения
      vscode.postMessage({ type: 'favGroup', group: g, value: v });
      render();
      if (v) { const b = [...document.querySelectorAll('.gh')].find((h) => h.dataset.g === g)?.querySelector('.gstar'); if (b) b.classList.add('pop'); }
      return;
    }
    const ga = e.target.closest('[data-garch]');
    if (ga) {
      // только видимые чаты группы (с учётом фильтра Claude/Codex и «Архив»)
      const card = ga.closest('.group');
      const keys = [...card.querySelectorAll('.chat[data-k]')].map((el) => el.dataset.k);
      card.classList.add('leaving');
      setTimeout(() => vscode.postMessage({ type: 'archiveGroup', keys, value: ga.dataset.garch === '1' }), 180);
      return;
    }
    const gm = e.target.closest('[data-gmore]');
    if (gm) { vscode.postMessage({ type: 'groupMenu', group: gm.closest('.gh').dataset.g }); return; }
    const gh = e.target.closest('.gh');
    if (gh) {
      const g = gh.dataset.g; collapsed[g] = !collapsed[g];
      vscode.postMessage({ type: 'collapse', group: g, value: collapsed[g] });
      gh.parentElement.classList.toggle('collapsed', collapsed[g]);
      return;
    }
    const ch = e.target.closest('.chat');
    if (!ch) return;
    const k = ch.dataset.k;
    if (e.target.closest('[data-dot]')) vscode.postMessage({ type: 'toggleRead', key: k });
    else if (e.target.closest('[data-arch]')) { ch.classList.add('leaving'); setTimeout(() => vscode.postMessage({ type: 'archive', key: k }), 180); }
    else if (e.target.closest('[data-more]')) vscode.postMessage({ type: 'menu', key: k });
    else if (e.target.closest('[data-ren]')) vscode.postMessage({ type: 'rename', key: k });
    else if (e.target.closest('[data-cont]')) vscode.postMessage({ type: 'continue', key: k });
    else {
      sticky = k;
      list.querySelectorAll('.chat.current').forEach((x) => x.classList.remove('current'));
      ch.classList.add('current');
      vscode.postMessage({ type: 'open', key: k });
    }
  });
  document.addEventListener('contextmenu', (e) => {
    const ch = e.target.closest('.chat');
    if (ch) { e.preventDefault(); vscode.postMessage({ type: 'menu', key: ch.dataset.k }); return; }
    const gh = e.target.closest('.gh');
    if (gh) { e.preventDefault(); vscode.postMessage({ type: 'groupMenu', group: gh.dataset.g }); }
  });
  document.querySelectorAll('[data-new]').forEach((b) => { b.onclick = () => vscode.postMessage({ type: 'new', agent: b.dataset.new }); });

  // ---------- перетаскивание групп ----------
  let dragG = null, dragK = null;
  list.addEventListener('dragstart', (e) => {
    const chat = e.target.closest('.chat');
    if (chat) { // чат тащат в другую группу
      dragK = chat.dataset.k;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragK);
      chat.classList.add('dragging-chat');
      list.classList.add('chat-drag');
      return;
    }
    const gh = e.target.closest('.gh');
    if (!gh) return;
    dragG = gh.dataset.g;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragG);
    gh.parentElement.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
    if (dragK) {
      const card = e.target.closest('.group');
      list.querySelectorAll('.drop-into').forEach((x) => x !== card && x.classList.remove('drop-into'));
      if (!card) return;
      e.preventDefault();
      card.classList.add('drop-into');
      return;
    }
    if (!dragG) return;
    const card = e.target.closest('.group');
    if (!card || card.dataset.g === dragG) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    list.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    card.classList.add(after ? 'drop-after' : 'drop-before');
  });
  list.addEventListener('drop', (e) => {
    if (dragK) {
      e.preventDefault();
      const card = e.target.closest('.group');
      const it = items.find((i) => i.key === dragK);
      if (card && it && it.group !== card.dataset.g) vscode.postMessage({ type: 'move', key: dragK, group: card.dataset.g });
      endDrag();
      return;
    }
    if (!dragG) return;
    e.preventDefault();
    const card = e.target.closest('.group');
    const names = [...list.querySelectorAll('.group')].map((x) => x.dataset.g).filter((g) => g !== dragG);
    if (card && card.dataset.g !== dragG) {
      let idx = names.indexOf(card.dataset.g);
      if (card.classList.contains('drop-after')) idx++;
      names.splice(idx, 0, dragG);
      order = names;
      vscode.postMessage({ type: 'order', order: names });
    }
    endDrag();
  });
  list.addEventListener('dragend', endDrag);
  function endDrag() {
    dragG = null; dragK = null;
    list.classList.remove('chat-drag');
    list.querySelectorAll('.dragging,.drop-before,.drop-after,.drop-into,.dragging-chat').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into', 'dragging-chat'));
    render();
  }

  // блик за курсором, как в пульте
  list.addEventListener('mousemove', (e) => {
    const c = e.target.closest('.card');
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
    c.style.setProperty('--my', (e.clientY - r.top) + 'px');
  });

  // ---------- поиск ----------
  let timer;
  function onSearch() {
    st.q = q.value.trim(); save();
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!st.q) { results = null; resultQ = ''; render(); }
      vscode.postMessage({ type: 'search', q: st.q });
    }, 180);
  }
  q.addEventListener('input', onSearch);
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; onSearch(); } });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'data') {
      items = m.items; jobs = m.jobs || []; jobPct = m.jobPct || []; favorites = m.favorites || {}; favChats = m.favChats || {}; collapsed = m.collapsed || {}; order = m.order || []; icons = m.icons || {}; customGroups = m.customGroups || []; lastAgent = m.lastAgent || 'claude';
      if (m.installed) installed = m.installed;
      // Если в выключенном фильтре остался единственный включённый агент — показать того, что есть.
      if (!installed.claude && !items.some((i) => i.agent === 'claude')) st.agents.codex = true;
      if (!installed.codex && !items.some((i) => i.agent === 'codex')) st.agents.claude = true;
      document.querySelectorAll('[data-new]').forEach((b) => {
        const a = b.dataset.new;
        b.querySelector('.nbi').innerHTML = badge(a);
        b.disabled = !installed[a];
        b.title = installed[a] ? `Начать новый чат с ${agName(a)}` : NOT_INST(a);
      });
      if (!dragG) render();
    }
    if (m.type === 'agents') { st.agents = m.value; if (!st.agents.claude && !st.agents.codex) st.agents = { claude: true, codex: true }; save(); render(); }
    if (m.type === 'results') {
      if (m.q !== st.q) return;
      results = m.q ? m.results : null; resultQ = m.q; render();
    }
    if (m.type === 'current') { sticky = m.key; if (!dragG) render(); }
    if (m.type === 'theme') applyTheme(!!m.light);
    if (m.type === 'sizes') {
      sizes = { zoom: m.zoom, chatFont: m.chatFont, chatDefault: m.chatDefault };
      document.documentElement.style.zoom = String(m.zoom);
      $('sizeBtn').classList.toggle('on', m.zoom !== 1 || m.chatFont !== m.chatDefault);
      if (!$('sizeMenu').hidden) renderSizeMenu();
    }
    if (m.type === 'focusSearch') { q.focus(); q.select(); }
    if (m.type === 'filter') { st.filter = m.filter; if (results) { q.value = ''; onSearch(); } save(); render(); }
  });

  setInterval(() => { if (items.length) renderFilters(); }, 15000); // жёлтая плашка «бот» гаснет сама
  setInterval(() => document.querySelectorAll('[data-ts]').forEach((el) => { el.textContent = ago(+el.dataset.ts); }), 30000);
  vscode.postMessage({ type: 'ready' });
  if (st.q) onSearch();
})();
