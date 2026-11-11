// Бросить файл из Finder на любое место панели Clodex → его путь дописывается в поле чата Claude.
// Здесь только приём: имена, размеры, время изменения и ссылки file://, если Finder их дал.
// Путь ищет расширение (screens.js → dropFiles): браузерная часть полного пути не знает.
(function () {
  const api = window.clodexApi;
  if (!api) return;
  const post = (m) => api.postMessage({ type: 'scr', m });

  const ov = document.createElement('div');
  ov.id = 'dropov';
  ov.innerHTML = '<div class="dz"><svg viewBox="0 0 24 24"><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    + '<b>Отпустите файл</b><span>ссылка появится в чате Claude</span></div>';
  document.body.appendChild(ov);

  // Только файлы снаружи. Свои перетаскивания (чаты, снимки из плашки) не трогаем.
  const isFiles = (e) => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  let hideT = 0;
  const shots = document.getElementById('shots');
  // Есть плашка — подсвечиваем её (там и написано «Отпустите файл»); нет — общий оверлей, как раньше.
  const mark = (on) => { (shots || ov).classList.toggle(shots ? 'dropping' : 'on', on); };
  const show = () => { mark(true); clearTimeout(hideT); hideT = setTimeout(() => mark(false), 700); };
  const hide = () => { clearTimeout(hideT); mark(false); };

  let told = false;
  let overs = 0;
  window.addEventListener('dragenter', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    if (!told) { told = true; post({ type: 'dropSeen', types: Array.from(e.dataTransfer.types || []) }); }
    show();
  }, true);
  window.addEventListener('dragover', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    overs++;
    show();
  }, true);
  window.addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    hide(); told = false; overs = 0;
    const dt = e.dataTransfer;
    const uris = [];
    for (const t of ['text/uri-list', 'application/vnd.code.uri-list', 'resourceurls']) {
      try { const v = dt.getData(t); if (v) uris.push(v); } catch { /* нет такого типа */ }
    }
    const files = Array.from(dt.files || []).map((f) => ({ name: f.name, size: f.size, mtime: f.lastModified, path: f.path || '' }));
    post({ type: 'dropFiles', files, uris, types: Array.from(dt.types || []) });
  }, true);
  // Ушли с панели без броска — записать, сколько было событий «над панелью» (для разбора, почему не сработало)
  window.addEventListener('dragleave', (e) => {
    if (!isFiles(e) || e.relatedTarget) return;
    if (e.clientX > 0 && e.clientY > 0 && e.clientX < innerWidth && e.clientY < innerHeight) return;
    hide();
    post({ type: 'dropLeave', overs });
    told = false; overs = 0;
  }, true);
})();
