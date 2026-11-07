// Страница панели Clodex.
(function () {
  const vscode = acquireVsCodeApi();
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
  const NO_GROUP = 'Без группы';
  let items = [], collapsed = {}, order = [], icons = {}, customGroups = [], lastAgent = 'claude', installed = { claude: true, codex: true };
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

  const $ = (id) => document.getElementById(id);
  const list = $('list'), q = $('q');
  q.value = st.q;

  const FILTERS = [['all', 'Все'], ['active', 'Активные'], ['recent', 'Последние'], ['unread', 'Не прочитано'], ['waiting', 'Жду ответа'], ['archive', 'Архив']];
  const FILTER_TIP = {
    active: 'Агент работает, ответил, а вы не прочитали, или в чате что-то было за последние 2 часа',
    recent: '40 последних чатов', unread: 'Агент ответил, а вы не открывали',
    waiting: 'Последний ответ агента кончается вопросом, а вы после него не писали', archive: 'Чаты, убранные в архив',
  };
  // Вид каждого фильтра: по группам или списком; повторное нажатие на выбранный фильтр переключает.
  const GROUPED_DEFAULT = { all: true, active: true, recent: false, unread: false, waiting: false, archive: false };
  if (!st.grouped) st.grouped = { ...GROUPED_DEFAULT, recent: !!st.recentGrouped };
  const isGrouped = (f) => (f in st.grouped ? st.grouped[f] : GROUPED_DEFAULT[f]);
  const VIEW_ICON = {
    groups: '<svg class="vi" viewBox="0 0 16 16"><rect x="2" y="2.5" width="12" height="4.5" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="12" height="4.5" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    list: '<svg class="vi" viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  };
  // Активные: агент работает, не прочитан или в чате что-то было за последние 2 часа
  const ACTIVE_MS = 2 * 3600e3;
  const isActive = (i) => i.status === 'working' || i.status === 'unread' || Date.now() - i.ts < ACTIVE_MS;
  const BOLT = '<svg class="bolt" viewBox="0 0 16 16"><path d="M9.2 1.5 3.5 9h4l-.9 5.5L12.5 7h-4z" fill="currentColor"/></svg>';
  const ICON = {
    archive: '<svg viewBox="0 0 16 16"><path d="M2 3h12v3H2zM3 6v7h10V6M6.5 8.5h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    unarchive: '<svg viewBox="0 0 16 16"><path d="M2 3h12v3H2zM3 6v7h10V6M8 12V8m-2 2 2-2 2 2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    pencil: '<svg viewBox="0 0 16 16"><path d="M10.5 2.5l3 3L6 13H3v-3z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    more: '<svg viewBox="0 0 16 16"><circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/></svg>',
    grip: '<svg viewBox="0 0 16 16"><g fill="currentColor"><circle cx="6" cy="4" r="1"/><circle cx="10" cy="4" r="1"/><circle cx="6" cy="8" r="1"/><circle cx="10" cy="8" r="1"/><circle cx="6" cy="12" r="1"/><circle cx="10" cy="12" r="1"/></g></svg>',
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

  const byAgent = (i) => !!st.agents[i.agent];
  const live = () => items.filter((i) => !i.archived && byAgent(i));

  function renderFilters() {
    const v = live();
    const cnt = {
      unread: v.filter((i) => i.status === 'unread').length,
      waiting: v.filter((i) => i.waiting).length,
      archive: items.filter((i) => i.archived && byAgent(i)).length,
      active: v.filter(isActive).length,
    };
    $('filters').innerHTML =
      FILTERS.map(([k, n]) => `<button class="chip ${k === 'active' ? 'act' : ''} ${st.filter === k ? 'on' : ''} ${(k === 'unread' || k === 'active') && cnt[k] ? 'hot' : ''}" data-f="${k}" title="${(FILTER_TIP[k] || 'Все чаты') + (st.filter === k ? '. Нажмите ещё раз — ' + (isGrouped(k) ? 'списком' : 'по группам') : '')}">${k === 'active' ? BOLT : ''}${n}${st.filter === k ? `<span class="mode" title="Сейчас ${isGrouped(k) ? 'по группам' : 'списком'} — нажмите ещё раз, чтобы ${isGrouped(k) ? 'показать списком' : 'разложить по группам'}">${isGrouped(k) ? VIEW_ICON.groups : VIEW_ICON.list}</span>` : ''}${cnt[k] ? ` <b>${cnt[k]}</b>` : ''}</button>`).join('') +
      `<span class="sep"></span>` +
      [['claude', 'Claude', 'C'], ['codex', 'Codex', 'X']].map(([k, n, l]) => {
        // Агент не установлен и его чатов нет — фильтр неактивен.
        const off = !installed[k] && !items.some((i) => i.agent === k);
        return `<button class="chip small icon ${st.agents[k] && !off ? 'on' : ''}" data-a="${k}" ${off ? 'disabled' : ''} title="${off ? NOT_INST(k) : (st.agents[k] ? 'Скрыть' : 'Показать') + ' чаты ' + n}">${badge(k)}</button>`;
      }).join('');
    $('sum').innerHTML = cnt.unread ? `<span class="pulse"></span>${cnt.unread} новых` : 'всё прочитано';
    $('sum').title = cnt.unread ? `Непрочитанных чатов: ${cnt.unread}` : '';
    $('sum').className = 'sum' + (cnt.unread ? ' hot' : '');
  }

  function row(i, snippet) {
    const tip = i.status === 'unread' ? 'Не прочитан — нажмите, чтобы отметить прочитанным' : i.status === 'working' ? 'Агент работает' : 'Прочитан — нажмите, чтобы вернуть «не прочитано»';
    return `<div draggable="true" class="chat ${i.status} ${i.archived ? 'arch' : ''} ${i.key === sticky ? 'current' : ''}" data-k="${esc(i.key)}" title="${esc(i.title)}">
      <span class="dot" data-dot="1" title="${tip}"></span>
      ${badge(i.agent, 'Чат ' + agName(i.agent))}
      <span class="t">${resultQ && snippet !== undefined ? mark(i.title, resultQ) : esc(i.title)}${i.waiting ? '<span class="q" title="Агент задал вопрос и ждёт ответа">?</span>' : ''}</span>
      <span class="time" data-ts="${i.ts}">${ago(i.ts)}</span>
      <span class="acts">
        <button class="ib" data-ren="1" title="Переименовать">${ICON.pencil}</button>
        <button class="ib" data-arch="1" title="${i.archived ? 'Вернуть из архива' : 'В архив'}">${i.archived ? ICON.unarchive : ICON.archive}</button>
        <button class="ib" data-more="1" title="Ещё: группа, прочитано, копировать">${ICON.more}</button>
      </span>
      ${snippet ? `<div class="snip">${mark(snippet, resultQ)}</div>` : ''}
    </div>`;
  }

  // Тот же порядок, что считает расширение: сохранённый, затем по свежести, «Без группы» в конце.
  function groupOrder(groups) {
    const names = [...groups.keys()];
    const t = (g) => (groups.get(g)[0] ? groups.get(g)[0].ts : 0);
    const rest = names.filter((g) => !order.includes(g) && g !== NO_GROUP).sort((a, b) => t(b) - t(a));
    const out = [...order.filter((g) => groups.has(g)), ...rest];
    if (groups.has(NO_GROUP) && !out.includes(NO_GROUP)) out.push(NO_GROUP);
    return out;
  }

  function render() { try { render_(); } catch (e) { reportError(e && e.stack || e); } }
  function render_() {
    renderFilters();
    if (results) {
      const map = new Map(results.map((r) => [r.key, r.snippet]));
      const found = items.filter((i) => map.has(i.key) && byAgent(i)).sort((a, b) => b.ts - a.ts);
      list.innerHTML = `<div class="hint">Найдено: ${found.length}</div>` +
        (found.length ? `<div class="card flat">${found.map((i) => row(i, map.get(i.key) || '')).join('')}</div>` : `<div class="empty">Ничего не найдено</div>`);
      return;
    }
    let v = (st.filter === 'archive' ? items.filter((i) => i.archived && byAgent(i)) : live()).sort((a, b) => b.ts - a.ts);
    if (st.filter === 'unread') v = v.filter((i) => i.status === 'unread' || keep(i));
    if (st.filter === 'active') v = v.filter((i) => isActive(i) || keep(i));
    if (st.filter === 'waiting') v = v.filter((i) => i.waiting || keep(i));
    if (st.filter === 'recent') v = v.slice(0, 40);
    if (!v.length) {
      const msg = { unread: 'Всё прочитано', waiting: 'Никто не ждёт ответа', archive: 'Архив пуст', active: 'Активных нет: никто не работает, не ждёт и не ответил' }[st.filter] || 'Чатов нет';
      list.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    const grouped = isGrouped(st.filter);
    if (!grouped) { list.innerHTML = `<div class="card flat">${v.map((i) => row(i)).join('')}</div>`; return; }

    const groups = new Map();
    for (const i of v) { if (!groups.has(i.group)) groups.set(i.group, []); groups.get(i.group).push(i); }
    if (st.filter === 'all') for (const g of customGroups) if (!groups.has(g)) groups.set(g, []); // пустые свои группы — только во «Все»
    list.innerHTML = groupOrder(groups).map((g) => {
      const arr = groups.get(g);
      const un = arr.filter((i) => i.status === 'unread').length;
      const work = arr.some((i) => i.status === 'working');
      const c = !!collapsed[g];
      return `<div class="card group ${c ? 'collapsed' : ''} ${un ? 'has-unread' : ''}" data-g="${esc(g)}">
        <div class="gh" draggable="true" data-g="${esc(g)}" title="Нажмите — свернуть/раскрыть. Перетащите — поменять порядок.">
          <span class="grip">${ICON.grip}</span>
          <span class="chev">${ICON.chev}</span>
          <span class="gn">${esc(g)}</span>
          ${work ? '<span class="gwork" title="Агент работает"></span>' : ''}
          ${un ? `<span class="gun" title="Непрочитанных: ${un}">${un}</span>` : ''}
          <span class="gtime">${arr[0] ? ago(arr[0].ts) : ''}</span>
          ${plusAgent() ? `<button class="ib gplus" data-gplus="1" title="Новый чат ${agName(plusAgent())} в группе «${esc(g)}»"><svg viewBox="0 0 16 16"><path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>${badge(plusAgent())}</button>` : ''}
          <button class="ib gmore" data-gmore="1" title="Группа: порядок, переименовать, удалить">${ICON.more}</button>
        </div>
        <div class="gb">${arr.length ? arr.map((i) => row(i)).join('') : '<div class="gempty">Пусто. Перетащите сюда чат мышью — или «⋯» у чата → «Перенести в группу».</div>'}</div></div>`;
    }).join('') + (st.filter === 'all' ? '<button class="addgroup" data-addgroup="1">＋ Новая группа</button>' : '');
  }

  // ---------- нажатия ----------
  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (f) {
      if (f.dataset.f === st.filter) st.grouped[st.filter] = !isGrouped(st.filter); // повторное нажатие — группы / список
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
    if (e.target.closest('#expandAll')) { vscode.postMessage({ type: 'collapseAll', value: false }); return; }
    if (e.target.closest('#collapseAll')) { vscode.postMessage({ type: 'collapseAll', value: true }); return; }
    const gp = e.target.closest('[data-gplus]');
    if (gp) { vscode.postMessage({ type: 'new', agent: 'last', group: gp.closest('.gh').dataset.g }); return; }
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
      items = m.items; collapsed = m.collapsed || {}; order = m.order || []; icons = m.icons || {}; customGroups = m.customGroups || []; lastAgent = m.lastAgent || 'claude';
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
    if (m.type === 'results') {
      if (m.q !== st.q) return;
      results = m.q ? m.results : null; resultQ = m.q; render();
    }
    if (m.type === 'current') { sticky = m.key; if (!dragG) render(); }
    if (m.type === 'theme') applyTheme(!!m.light);
    if (m.type === 'focusSearch') { q.focus(); q.select(); }
  });

  setInterval(() => document.querySelectorAll('[data-ts]').forEach((el) => { el.textContent = ago(+el.dataset.ts); }), 30000);
  vscode.postMessage({ type: 'ready' });
  if (st.q) onSearch();
})();
