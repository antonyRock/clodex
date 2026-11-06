// Страница панели Clodex.
(function () {
  const vscode = acquireVsCodeApi();
  const st = vscode.getState() || {};
  st.filter = st.filter || 'all'; st.q = st.q || '';
  if (!st.agents) st.agents = { claude: true, codex: true };
  const NO_GROUP = 'Без группы';
  let items = [], collapsed = {}, order = [];
  let results = null, resultQ = '';

  const $ = (id) => document.getElementById(id);
  const list = $('list'), q = $('q');
  q.value = st.q;

  const FILTERS = [['all', 'Все'], ['active', 'Активные'], ['recent', 'Последние'], ['unread', 'Не прочитано'], ['waiting', 'Жду ответа'], ['archive', 'Архив']];
  const FILTER_TIP = {
    active: 'Агент работает, ответил, а вы не прочитали, или задал вопрос за последние сутки — как «Active» в Claude Code',
    recent: '40 последних чатов одним списком', unread: 'Агент ответил, а вы не открывали',
    waiting: 'Последний ответ агента — вопрос к вам', archive: 'Чаты, убранные в архив',
  };
  // как «Active» в Claude Code: работает, не прочитан или ждёт ответа (вопрос не старше суток)
  const isActive = (i) => i.status === 'working' || i.status === 'unread' || (i.waiting && Date.now() - i.ts < 864e5);
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
      FILTERS.map(([k, n]) => `<button class="chip ${k === 'active' ? 'act' : ''} ${st.filter === k ? 'on' : ''} ${(k === 'unread' || k === 'active') && cnt[k] ? 'hot' : ''}" data-f="${k}" title="${FILTER_TIP[k] || 'Все чаты по группам'}">${k === 'active' ? BOLT : ''}${n}${cnt[k] ? ` <b>${cnt[k]}</b>` : ''}</button>`).join('') +
      `<span class="sep"></span>` +
      [['claude', 'Claude', 'C'], ['codex', 'Codex', 'X']].map(([k, n, l]) => `<button class="chip small icon ${st.agents[k] ? 'on' : ''}" data-a="${k}" title="${st.agents[k] ? 'Скрыть' : 'Показать'} чаты ${n}"><span class="ag ${k}">${l}</span></button>`).join('');
    $('sum').innerHTML = cnt.unread ? `<span class="pulse"></span>${cnt.unread} не прочитано` : 'всё прочитано';
    $('sum').className = 'sum' + (cnt.unread ? ' hot' : '');
  }

  function row(i, snippet) {
    const tip = i.status === 'unread' ? 'Не прочитан — нажмите, чтобы отметить прочитанным' : i.status === 'working' ? 'Агент работает' : 'Прочитан — нажмите, чтобы вернуть «не прочитано»';
    return `<div class="chat ${i.status} ${i.archived ? 'arch' : ''}" data-k="${esc(i.key)}" title="${esc(i.title)}">
      <span class="dot" data-dot="1" title="${tip}"></span>
      <span class="ag ${i.agent}" title="${i.agent === 'claude' ? 'Чат Claude' : 'Чат Codex'}">${i.agent === 'claude' ? 'C' : 'X'}</span>
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
    const rest = names.filter((g) => !order.includes(g) && g !== NO_GROUP).sort((a, b) => groups.get(b)[0].ts - groups.get(a)[0].ts);
    const out = [...order.filter((g) => groups.has(g)), ...rest];
    if (groups.has(NO_GROUP) && !out.includes(NO_GROUP)) out.push(NO_GROUP);
    return out;
  }

  function render() {
    renderFilters();
    if (results) {
      const map = new Map(results.map((r) => [r.key, r.snippet]));
      const found = items.filter((i) => map.has(i.key) && byAgent(i)).sort((a, b) => b.ts - a.ts);
      list.innerHTML = `<div class="hint">Найдено: ${found.length}</div>` +
        (found.length ? `<div class="card flat">${found.map((i) => row(i, map.get(i.key) || '')).join('')}</div>` : `<div class="empty">Ничего не найдено</div>`);
      return;
    }
    let v = (st.filter === 'archive' ? items.filter((i) => i.archived && byAgent(i)) : live()).sort((a, b) => b.ts - a.ts);
    if (st.filter === 'unread') v = v.filter((i) => i.status === 'unread');
    if (st.filter === 'active') v = v.filter(isActive);
    if (st.filter === 'waiting') v = v.filter((i) => i.waiting);
    if (st.filter === 'recent') v = v.slice(0, 40);
    if (!v.length) {
      const msg = { unread: 'Всё прочитано', waiting: 'Никто не ждёт ответа', archive: 'Архив пуст', active: 'Активных нет: никто не работает, не ждёт и не ответил' }[st.filter] || 'Чатов нет';
      list.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }
    if (st.filter !== 'all' && st.filter !== 'active') { list.innerHTML = `<div class="card flat">${v.map((i) => row(i)).join('')}</div>`; return; }

    const groups = new Map();
    for (const i of v) { if (!groups.has(i.group)) groups.set(i.group, []); groups.get(i.group).push(i); }
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
          <span class="gtime">${ago(arr[0].ts)}</span>
          <button class="ib gmore" data-gmore="1" title="Группа: порядок, переименовать, удалить">${ICON.more}</button>
        </div>
        <div class="gb">${arr.map((i) => row(i)).join('')}</div></div>`;
    }).join('');
  }

  // ---------- нажатия ----------
  document.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f]');
    if (f) { st.filter = f.dataset.f; if (results) { q.value = ''; onSearch(); } save(); render(); return; }
    const a = e.target.closest('[data-a]');
    if (a) {
      const k = a.dataset.a, other = k === 'claude' ? 'codex' : 'claude';
      st.agents[k] = !st.agents[k];
      if (!st.agents[k] && !st.agents[other]) st.agents[other] = true; // хотя бы один агент виден
      save(); render(); return;
    }
    if (e.target.closest('#expandAll')) { vscode.postMessage({ type: 'collapseAll', value: false }); return; }
    if (e.target.closest('#collapseAll')) { vscode.postMessage({ type: 'collapseAll', value: true }); return; }
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
    else vscode.postMessage({ type: 'open', key: k });
  });
  document.addEventListener('contextmenu', (e) => {
    const ch = e.target.closest('.chat');
    if (ch) { e.preventDefault(); vscode.postMessage({ type: 'menu', key: ch.dataset.k }); return; }
    const gh = e.target.closest('.gh');
    if (gh) { e.preventDefault(); vscode.postMessage({ type: 'groupMenu', group: gh.dataset.g }); }
  });
  $('newChat').onclick = () => vscode.postMessage({ type: 'new' });

  // ---------- перетаскивание групп ----------
  let dragG = null;
  list.addEventListener('dragstart', (e) => {
    const gh = e.target.closest('.gh');
    if (!gh) return;
    dragG = gh.dataset.g;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragG);
    gh.parentElement.classList.add('dragging');
  });
  list.addEventListener('dragover', (e) => {
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
    dragG = null;
    list.querySelectorAll('.dragging,.drop-before,.drop-after').forEach((x) => x.classList.remove('dragging', 'drop-before', 'drop-after'));
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
      items = m.items; collapsed = m.collapsed || {}; order = m.order || [];
      if (!dragG) render();
    }
    if (m.type === 'results') {
      if (m.q !== st.q) return;
      results = m.q ? m.results : null; resultQ = m.q; render();
    }
    if (m.type === 'focusSearch') { q.focus(); q.select(); }
  });

  setInterval(() => document.querySelectorAll('[data-ts]').forEach((el) => { el.textContent = ago(+el.dataset.ts); }), 30000);
  vscode.postMessage({ type: 'ready' });
  if (st.q) onSearch();
})();
