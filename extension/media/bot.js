// Вкладка «чат с ботом»: получает переписку от расширения и перерисовывает её при каждом обновлении.
(function () {
  const vscode = acquireVsCodeApi();
  const main = document.getElementById('conv');
  const h1 = document.getElementById('title');
  const sub = document.getElementById('sub');
  const opened = new Set(); // какие блоки «шаги агента» раскрыты — не сворачивать при обновлении
  let first = true;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Немного Markdown: заголовки, жирный, `код`. Остальное — как есть (переносы строк сохраняются).
  const md = (t) => esc(t)
    .replace(/^#{1,4}\s+(.+)$/gm, '<span class="h">$1</span>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  const time = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); };
  const day = (s) => { const d = new Date(s); return isNaN(d) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'short' }); };
  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'шаг' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 'шага' : 'шагов');

  function render(d) {
    h1.textContent = d.title;
    sub.innerHTML = `Чат с ботом в Telegram · ${esc(d.agent)} · сообщений: ${d.items.filter((m) => m.who !== 'steps').length}` +
      ` · <span class="live">обновляется само</span>`;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    let lastDay = '', html = '', si = 0;
    for (const m of d.items) {
      const dd = m.ts ? day(m.ts) : '';
      if (dd && dd !== lastDay) { html += `<div class="day">${esc(dd)}</div>`; lastDay = dd; }
      if (m.who === 'steps') {
        const i = si++;
        html += `<details class="steps" data-i="${i}" ${opened.has(i) ? 'open' : ''}><summary>🔧 ${m.list.length} ${plural(m.list.length)} агента</summary><ul>` +
          m.list.map((s) => `<li>${esc(s)}</li>`).join('') + '</ul></details>';
      } else if (m.who === 'me') {
        html += `<div class="msg me"><div class="who">Вы · ${time(m.ts)}</div>` +
          m.notes.map((n) => `<div class="note">${esc(n)}</div>`).join('') +
          (m.files.length ? `<div class="files">📎 ${m.files.map(esc).join(', ')}</div>` : '') +
          (m.text ? md(m.text) : '') + '</div>';
      } else {
        html += `<div class="msg agent"><div class="who">${esc(d.agent)} · ${time(m.ts)}</div>${md(m.text)}</div>`;
      }
    }
    if (d.working) html += '<div class="working">Агент работает…</div>';
    if (!d.items.length) html = '<div class="empty">Сообщений пока нет</div>';
    main.innerHTML = html;
    if (first || atBottom) window.scrollTo(0, document.body.scrollHeight);
    first = false;
  }

  main.addEventListener('toggle', (e) => {
    const el = e.target;
    if (!el.matches || !el.matches('details.steps')) return;
    const i = Number(el.dataset.i);
    if (el.open) opened.add(i); else opened.delete(i);
  }, true);
  document.getElementById('cont').addEventListener('click', () => vscode.postMessage({ type: 'continue' }));
  document.getElementById('proto').addEventListener('click', () => vscode.postMessage({ type: 'protocol' }));
  window.addEventListener('message', (e) => { if (e.data && e.data.type === 'conv') render(e.data); });
  vscode.postMessage({ type: 'ready' });
})();
