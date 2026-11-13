// Плашка «Скриншоты» внизу панели Clodex: нажатие — выдвигается сетка миниатюр, ещё нажатие — прячется.
// Внутри: выделение нескольких, перетаскивание в чат Claude, кнопки действий.
// Живёт на одной странице с чатами (view.js), поэтому все id — с приставкой s-, классы — свои.
(function () {
  const api = window.clodexApi;
  if (!api) return;
  const post = (m) => api.postMessage({ type: 'scr', m });
  const root = document.getElementById('shots');
  const head = document.getElementById('s-head');
  const grid = document.getElementById('s-grid');
  const count = document.getElementById('s-count');
  const bar = document.getElementById('s-bar');
  if (!root || !grid) return;
  const ICON = {
    copy: '<svg viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.5 10.5h-.3A1.2 1.2 0 0 1 2 9.3V3.2C2 2.5 2.5 2 3.2 2h6.1c.7 0 1.2.5 1.2 1.2v.3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
    photo: '<svg viewBox="0 0 16 16"><rect x="4.2" y="1.5" width="7.6" height="13" rx="1.8" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
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

  // ---------- открыть / закрыть ----------
  let seenTimer = null;
  // Плашка раскрыта и снимки на виду — через секунду считаем их просмотренными, счётчик «+N» сбрасывается
  function scheduleSeen() {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => { if (root.classList.contains('open')) post({ type: 'allSeen' }); }, 1200);
  }
  function setOpen(v) {
    root.classList.toggle('open', v);
    if (v) scheduleSeen();
    head.setAttribute('aria-expanded', String(v));
    if (!v && sel.size) { sel.clear(); paintSel(); }
    post({ type: 'drawer', value: v });
  }
  head.addEventListener('click', (e) => {
    if (e.target.closest('.s-tools')) return;
    setOpen(!root.classList.contains('open'));
  });
  head.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === head) { e.preventDefault(); setOpen(!root.classList.contains('open')); }
  });

  let items = [];
  const sel = new Set();   // выбранные пути
  let anchor = -1;         // для выделения диапазона с Shift

  function picked() { return items.filter((i) => sel.has(i.path)); }

  function paintSel() {
    grid.querySelectorAll('.s-card').forEach((c) => {
      const it = items[+c.dataset.i];
      c.classList.toggle('on', !!it && sel.has(it.path));
    });
    const n = sel.size;
    root.classList.toggle('selecting', n > 0);
    // нижняя плашка есть всегда (с 0.9.41), чтобы интерфейс не прыгал при выборе
    const off = n === 0 ? ' disabled' : '';
    bar.hidden = false;
    bar.innerHTML = (n ? '<span class="hint">Перетащите в чат с&nbsp;<b>Shift</b></span>' : '<span class="hint idle">Выберите фото. Несколько — с&nbsp;<b>Shift</b> или&nbsp;<b>⌘</b></span>') +
      '<button data-sb="chat" class="go"' + off + '>В чат</button>' +
      '<button data-sb="copy" title="Скопировать пути"' + off + '>' + ICON.copy + '</button>' +
      '<button data-sb="trash" title="В Корзину"' + off + '>' + ICON.trash + '</button>' +
      '<button data-sb="clear" title="Снять выделение"' + off + '>✕</button>';
  }

  function render(m) {
    items = m.items;
    for (const p of [...sel]) if (!items.some((i) => i.path === p)) sel.delete(p);
    const fresh = items.filter((i) => i.isNew).length;
    // 0.9.51: один счётчик — сколько новых снимков пришло, пока их не посмотрели; общее число убрано
    count.innerHTML = fresh ? '<span class="new">+' + fresh + '</span>' : '';
    if (fresh && root.classList.contains('open')) scheduleSeen();
    root.classList.toggle('fresh', fresh > 0);
    root.classList.toggle('empty', !items.length);
    if (!items.length) {
      grid.innerHTML = '<div class="s-empty"><b>Пока пусто.</b> Как сюда попадают снимки — нажмите значок лампочки.</div>';
      paintSel();
      return;
    }
    let html = ''; let lastDay = '';
    items.forEach((it, i) => {
      const day = dayLabel(it.mtimeMs);
      if (day !== lastDay) { html += '<div class="s-day">' + esc(day) + '</div>'; lastDay = day; }
      html += '<div class="s-card" draggable="true" data-i="' + i + '" title="' + esc(it.name) + '\nНажмите — выбрать (⌘ — ещё, Shift — диапазон), двойное нажатие — открыть.\nПеретащите в чат с Shift.">' +
        '<img src="' + esc(it.src) + '" alt="" loading="lazy" draggable="false">' +
        '<span class="s-tick">' + ICON.check + '</span>' +
        '<div class="s-acts"><button class="go" data-sa="chat" title="Вставить снимок в чат Claude">В чат</button>' +
        '<button data-sa="open" title="Открыть">' + ICON.open + '</button>' +
        '<button data-sa="copy" title="Скопировать путь">' + ICON.copy + '</button>' +
        (it.photo ? '' : '<button data-sa="trash" title="В Корзину">' + ICON.trash + '</button>') + '</div>' +
        '<div class="s-meta">' + (it.isNew ? '<span class="sq"></span>' : '') + (it.photo ? '<span class="ph" title="Фото из библиотеки «Фото» (iPhone)">' + ICON.photo + '</span>' : '') + esc(ago(it.ago)) + '</div></div>';
    });
    if (m.total > items.length) html += '<div class="s-more">Показаны последние ' + items.length + ' из ' + m.total + ' — остальные в папке</div>';
    grid.innerHTML = html;
    paintSel();
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.s-card'); if (!card) return;
    const i = +card.dataset.i; const it = items[i]; if (!it) return;
    const b = e.target.closest('button');
    if (b) { post({ type: b.dataset.sa, path: it.path }); return; }
    if (e.target.closest('.s-tick') || e.metaKey || e.ctrlKey) {
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
  // Колесо мыши листает строку вправо-влево
  grid.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && grid.scrollWidth > grid.clientWidth) { grid.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });

  // Не загрузилась миниатюра — один повтор с другой меткой, потом заглушка
  grid.addEventListener('error', (e) => {
    const img = e.target; if (!img || img.tagName !== 'IMG') return;
    if (!img.dataset.retry) { img.dataset.retry = '1'; setTimeout(() => { img.src = img.src.split('?')[0] + '?r=' + Date.now(); }, 600); }
    else img.classList.add('broken');
  }, true);
  grid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.s-card'); if (!card || e.target.closest('button')) return;
    const it = items[+card.dataset.i]; if (it) post({ type: 'open', path: it.path });
  });

  // Перетаскивание: чат Claude читает «resourceurls» — список file:// ссылок — и вставляет @путь на каждый
  grid.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.s-card'); if (!card) return;
    const it = items[+card.dataset.i]; if (!it) return;
    if (!sel.has(it.path)) { sel.clear(); sel.add(it.path); paintSel(); }
    const list = picked();
    const uris = list.map((x) => x.uri);
    post({ type: 'dragInfo', uris });
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('resourceurls', JSON.stringify(uris));
    e.dataTransfer.setData('application/vnd.code.uri-list', uris.join('\r\n'));
    e.dataTransfer.setData('text/uri-list', uris.join('\r\n'));
    e.dataTransfer.setData('text/plain', list.map((x) => x.path).join('\n'));
    const ghost = document.getElementById('s-ghost');
    ghost.textContent = list.length === 1 ? '1 снимок' : list.length + ' ' + (list.length < 5 ? 'снимка' : 'снимков');
    e.dataTransfer.setDragImage(ghost, 12, 12);
    root.classList.add('dragging');
  });
  grid.addEventListener('dragend', () => root.classList.remove('dragging'));

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b || b.disabled) return;
    const paths = picked().map((x) => x.path);
    if (b.dataset.sb === 'clear') { sel.clear(); paintSel(); return; }
    if (b.dataset.sb === 'chat') post({ type: 'chatMany', paths });
    if (b.dataset.sb === 'copy') post({ type: 'copyMany', paths });
    if (b.dataset.sb === 'trash') post({ type: 'trashMany', paths });
  });
  // правый клик по плашке не должен открывать меню чатов
  root.addEventListener('contextmenu', (e) => e.stopPropagation());

  // Клавиши — только когда мышь или фокус на плашке, чтобы не мешать поиску по чатам
  let hot = false;
  root.addEventListener('pointerenter', () => { hot = true; });
  root.addEventListener('pointerleave', () => { hot = false; });
  document.addEventListener('keydown', (e) => {
    const inShots = hot || root.contains(document.activeElement);
    if (!inShots || !root.classList.contains('open')) return;
    if (/^(INPUT|TEXTAREA)$/.test((document.activeElement || {}).tagName || '')) return;
    if (e.key === 'Escape') { if (sel.size) { sel.clear(); paintSel(); } else setOpen(false); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') { e.preventDefault(); items.forEach((i) => sel.add(i.path)); paintSel(); }
  });

  // Размер миниатюр: мелкие (по умолчанию) или крупные; выбор хранит расширение
  const sizeBtn = document.getElementById('s-size');
  if (sizeBtn) sizeBtn.onclick = () => {
    const big = !root.classList.contains('big');
    root.classList.toggle('big', big);
    root.classList.toggle('small', !big);
    sizeBtn.title = big ? 'Мелкие миниатюры' : 'Крупные миниатюры';
    post({ type: 'size', size: big ? 'big' : 'small' });
  };
  // Подсказки: кнопка-лампочка в шапке; при пустой плашке видны всегда
  const helpBtn = document.getElementById('s-help'); if (helpBtn) helpBtn.onclick = () => {
    const v = !root.classList.contains('tips');
    root.classList.toggle('tips', v);
    post({ type: 'tips', value: v });
  };
  // Тумблер автообновления раз в 5 с (по умолчанию выключен): включён — панель сама обновляется, выключен — только по кнопке «Обновить»
  const autoBtn = document.getElementById('s-auto'); if (autoBtn) autoBtn.onclick = () => {
    const v = !root.classList.contains('auto');
    root.classList.toggle('auto', v);
    autoBtn.setAttribute('aria-checked', String(v));
    autoBtn.title = 'Снимки и фото: автообновление раз в 5 с — ' + (v ? 'включено' : 'выключено') + '. Нажмите, чтобы ' + (v ? 'выключить' : 'включить');
    post({ type: 'auto', value: v });
  };
  // Нажатие мимо плашки (по списку чатов) — плашка уезжает вниз, место не занимает
  document.addEventListener('mousedown', (e) => {
    if (root.classList.contains('open') && !root.contains(e.target)) setOpen(false);
  });
  document.getElementById('s-refresh').onclick = () => post({ type: 'refresh' });
  document.getElementById('s-folder').onclick = () => post({ type: 'folder' });
  document.getElementById('s-allSeen').onclick = () => post({ type: 'allSeen' });

  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'shots') render(m);
    if (m.type === 'shotsOpen') setOpen(true);
  });
  post({ type: 'ready' });
})();
