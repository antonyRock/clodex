// Страница раздела «Скриншоты»: сетка миниатюр, выделение нескольких, перетаскивание в чат Claude.
(function () {
  const vscode = acquireVsCodeApi();
  const grid = document.getElementById('grid');
  const count = document.getElementById('count');
  const bar = document.getElementById('bar');
  const ICON = {
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 10.5h-.3A1.2 1.2 0 0 1 2 9.3V3.2C2 2.5 2.5 2 3.2 2h6.1c.7 0 1.2.5 1.2 1.2v.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    trash: '<svg viewBox="0 0 16 16"><path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.3c.1.7.6 1.2 1.3 1.2h4c.7 0 1.2-.5 1.3-1.2l.7-8.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    open: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return 'только что';
    const m = Math.round(s / 60);
    if (m < 60) return m + ' мин';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' ч';
    return Math.round(h / 24) + ' дн';
  }
  function dayLabel(ms) {
    const d = new Date(ms); const t = new Date();
    const key = (x) => x.getFullYear() + '-' + x.getMonth() + '-' + x.getDate();
    const y = new Date(t); y.setDate(t.getDate() - 1);
    if (key(d) === key(t)) return 'Сегодня';
    if (key(d) === key(y)) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  let items = [];
  const sel = new Set();   // выбранные пути
  let anchor = -1;         // для выделения диапазона с Shift

  function picked() { return items.filter((i) => sel.has(i.path)); }

  function paintSel() {
    grid.querySelectorAll('.card').forEach((c) => {
      const it = items[+c.dataset.i];
      c.classList.toggle('on', !!it && sel.has(it.path));
    });
    const n = sel.size;
    document.body.classList.toggle('selecting', n > 0);
    bar.hidden = n === 0;
    if (n) {
      bar.innerHTML = '<span class="n">' + n + '</span><span class="hint">Перетащите в чат с&nbsp;<b>Shift</b></span>' +
        '<button data-b="chat" class="chat">В чат</button>' +
        '<button data-b="copy" title="Скопировать пути">' + ICON.copy + '</button>' +
        '<button data-b="clear" title="Снять выделение">✕</button>';
    }
  }

  function render(m) {
    items = m.items;
    for (const p of [...sel]) if (!items.some((i) => i.path === p)) sel.delete(p);
    const fresh = items.filter((i) => i.isNew).length;
    count.innerHTML = (m.total ? m.total : '') + (fresh ? '<span class="new">+' + fresh + '</span>' : '');
    if (!items.length) {
      grid.innerHTML = '<div class="empty"><b>Пока пусто.</b><br>Дважды стукните по задней крышке айфона — снимок появится здесь через несколько секунд.<br><br>Выделите снимки и перетащите в чат Claude с зажатым <b>Shift</b> — вставятся ссылки на файлы.</div>';
      paintSel();
      return;
    }
    let html = ''; let lastDay = '';
    items.forEach((it, i) => {
      const day = dayLabel(it.mtimeMs);
      if (day !== lastDay) { html += '<div class="day">' + esc(day) + '</div>'; lastDay = day; }
      html += '<div class="card" draggable="true" data-i="' + i + '" title="' + esc(it.name) + '\nНажмите — выбрать (⌘ — ещё, Shift — диапазон), двойное нажатие — открыть.\nПеретащите в чат с Shift.">' +
        '<img src="' + esc(it.src) + '" alt="" loading="lazy" draggable="false">' +
        '<span class="tick">' + ICON.check + '</span>' +
        '<div class="acts"><button class="chat" data-a="chat" title="Вставить снимок в чат Claude">В чат</button>' +
        '<button data-a="open" title="Открыть">' + ICON.open + '</button>' +
        '<button data-a="copy" title="Скопировать путь">' + ICON.copy + '</button>' +
        '<button data-a="trash" title="В Корзину">' + ICON.trash + '</button></div>' +
        '<div class="meta">' + (it.isNew ? '<span class="sq"></span>' : '') + esc(ago(it.ago)) + '</div></div>';
    });
    if (m.total > items.length) html += '<div class="more">Показаны последние ' + items.length + ' из ' + m.total + ' — остальные в папке</div>';
    grid.innerHTML = html;
    paintSel();
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    const i = +card.dataset.i; const it = items[i]; if (!it) return;
    const b = e.target.closest('button');
    if (b) { vscode.postMessage({ type: b.dataset.a, path: it.path }); return; }
    if (e.target.closest('.tick') || e.metaKey || e.ctrlKey) {
      if (sel.has(it.path)) sel.delete(it.path); else sel.add(it.path);
      anchor = i;
    } else if (e.shiftKey && anchor >= 0) {
      const [a, z] = anchor < i ? [anchor, i] : [i, anchor];
      for (let k = a; k <= z; k++) sel.add(items[k].path);
    } else {
      const only = sel.size === 1 && sel.has(it.path);
      sel.clear(); if (!only) sel.add(it.path);
      anchor = i;
    }
    paintSel();
  });
  grid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card'); if (!card || e.target.closest('button')) return;
    const it = items[+card.dataset.i]; if (it) vscode.postMessage({ type: 'open', path: it.path });
  });

  // Перетаскивание: чат Claude читает «resourceurls» — список file:// ссылок — и вставляет @путь на каждый
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.card'); if (!card) return;
    const it = items[+card.dataset.i]; if (!it) return;
    if (!sel.has(it.path)) { sel.clear(); sel.add(it.path); paintSel(); }
    const list = picked();
    const uris = list.map((x) => x.uri);
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('resourceurls', JSON.stringify(uris));
    e.dataTransfer.setData('application/vnd.code.uri-list', uris.join('\r\n'));
    e.dataTransfer.setData('text/uri-list', uris.join('\r\n'));
    e.dataTransfer.setData('text/plain', list.map((x) => x.path).join('\n'));
    const ghost = document.getElementById('ghost');
    ghost.textContent = list.length === 1 ? '1 снимок' : list.length + ' ' + (list.length < 5 ? 'снимка' : 'снимков');
    e.dataTransfer.setDragImage(ghost, 12, 12);
    document.body.classList.add('dragging');
  });
  grid.addEventListener('dragend', () => document.body.classList.remove('dragging'));

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const paths = picked().map((x) => x.path);
    if (b.dataset.b === 'clear') { sel.clear(); paintSel(); return; }
    if (b.dataset.b === 'chat') vscode.postMessage({ type: 'chatMany', paths });
    if (b.dataset.b === 'copy') vscode.postMessage({ type: 'copyMany', paths });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { sel.clear(); paintSel(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); items.forEach((i) => sel.add(i.path)); paintSel(); }
  });

  document.getElementById('refresh').onclick = () => vscode.postMessage({ type: 'refresh' });
  document.getElementById('folder').onclick = () => vscode.postMessage({ type: 'folder' });
  document.getElementById('allSeen').onclick = () => vscode.postMessage({ type: 'allSeen' });

  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'shots') render(e.data); });
  vscode.postMessage({ type: 'ready' });
})();
