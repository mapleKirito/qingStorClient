import { fmtBytes, fmtTime, esc, toast, confirmDialog, promptDialog, configDialog, showContextMenu } from './util.js';

const $ = (id) => document.getElementById(id);

const state = {
  version: '',
  configured: false,
  currentDir: '', // 相对前缀的目录 key
  entries: [],    // [{key, name, isDir, size, mtime}]
  selection: new Set(),
  lastIndex: -1,
  loading: false,
  loadSeq: 0,
  panelCollapsed: true,
  tasks: new Map(),
};

/* ================= 目录加载与渲染 ================= */

async function loadDir(dir = state.currentDir, { silent = false } = {}) {
  if (!state.configured) return;
  const seq = ++state.loadSeq;
  if (!silent) {
    state.loading = true;
    $('loadingMask').classList.remove('hidden');
  }
  try {
    const res = await window.bridge.s3.list(dir);
    if (seq !== state.loadSeq) return; // 已切换到其它目录，丢弃过期结果
    state.currentDir = dir;
    state.selection.clear();
    state.lastIndex = -1;
    state.entries = [...res.dirs, ...res.files];
    renderBreadcrumb();
    renderTable();
  } catch (e) {
    if (seq === state.loadSeq) toast('加载目录失败：' + (e.message || e), 'err');
  } finally {
    if (seq === state.loadSeq) {
      state.loading = false;
      $('loadingMask').classList.add('hidden');
    }
  }
}

function renderBreadcrumb() {
  const bc = $('breadcrumb');
  const parts = state.currentDir ? state.currentDir.split('/').filter(Boolean) : [];
  let html = `<span class="crumb" data-dir="">☁ ${esc(bucketLabel())}</span>`;
  let acc = '';
  parts.forEach((p, i) => {
    acc = acc ? acc + '/' + p : p;
    const last = i === parts.length - 1;
    html += `<span class="crumb-sep">/</span><span class="crumb ${last ? 'current' : ''}" data-dir="${esc(acc)}">${esc(p)}</span>`;
  });
  bc.innerHTML = html;
  bc.querySelectorAll('.crumb').forEach((el) => {
    el.addEventListener('click', () => {
      if (!el.classList.contains('current')) loadDir(el.dataset.dir);
    });
  });
}

function bucketLabel() {
  return window.__brand || '未连接';
}

function visibleRows() {
  // Linux 风格：顶部固定 . 与 ..
  const rows = [];
  rows.push({ special: '.', name: '.', isDir: true });
  rows.push({ special: '..', name: '..', isDir: true });
  for (const e of state.entries) rows.push(e);
  return rows;
}

function renderTable() {
  const body = $('tableBody');
  const rows = visibleRows();
  if (state.entries.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <div class="big">🗂</div>
        <div>此目录为空</div>
        <div style="font-size:11.5px">可拖拽文件/文件夹到此处上传，或使用上方按钮</div>
      </div>`;
  } else {
    let html = '';
    rows.forEach((r, idx) => {
      if (r.special) {
        html += `
          <div class="row special" data-idx="${idx}" data-special="${r.special}">
            <label class="cell-check"></label>
            <div class="cell-name">
              <div class="file-ic dir">↩</div>
              <span class="file-name" style="color:var(--dim)">${r.name}</span>
            </div>
            <div class="cell-size"></div>
            <div class="cell-time"></div>
          </div>`;
        return;
      }
      const selected = state.selection.has(r.key);
      const size = r.isDir ? '—' : fmtBytes(r.size);
      const time = r.isDir ? '—' : fmtTime(r.mtime);
      html += `
        <div class="row ${selected ? 'selected' : ''}" data-idx="${idx}" data-key="${esc(r.key)}">
          <label class="cell-check"><input type="checkbox" ${selected ? 'checked' : ''} /></label>
          <div class="cell-name">
            <div class="file-ic ${r.isDir ? 'dir' : 'file'}">${r.isDir ? '📁' : '📄'}</div>
            <span class="file-name" title="${esc(r.name)}">${esc(r.name)}</span>
          </div>
          <div class="cell-size">${size}</div>
          <div class="cell-time">${time}</div>
        </div>`;
    });
    body.innerHTML = html;
  }
  updateStatus();
  updateCheckAll();
}

function rowEntry(idx) {
  const rows = visibleRows();
  return rows[idx] || null;
}

function updateStatus() {
  const total = state.entries.length;
  const sel = state.selection.size;
  const running = [...state.tasks.values()].filter((t) => t.status === 'running' || t.status === 'queued').length;
  $('statLeft').textContent = `${total} 个项目${sel ? ` · 已选 ${sel} 项` : ''}${running ? ` · ${running} 个传输任务进行中` : ''}`;
}

function updateCheckAll() {
  const box = $('checkAll');
  const total = state.entries.length;
  const sel = state.entries.filter((e) => state.selection.has(e.key)).length;
  box.checked = total > 0 && sel === total;
  box.indeterminate = sel > 0 && sel < total;
}

/* ================= 选择与交互 ================= */

function selectOnly(idx) {
  state.selection.clear();
  const r = rowEntry(idx);
  if (r && !r.special) state.selection.add(r.key);
  state.lastIndex = idx;
  renderTable();
}

function toggleSelect(idx) {
  const r = rowEntry(idx);
  if (!r || r.special) return;
  if (state.selection.has(r.key)) state.selection.delete(r.key);
  else state.selection.add(r.key);
  state.lastIndex = idx;
  renderTable();
}

function rangeSelect(idx) {
  const from = Math.min(state.lastIndex < 0 ? idx : state.lastIndex, idx);
  const to = Math.max(state.lastIndex < 0 ? idx : state.lastIndex, idx);
  state.selection.clear();
  for (let i = from; i <= to; i++) {
    const r = rowEntry(i);
    if (r && !r.special) state.selection.add(r.key);
  }
  renderTable();
}

function selectedEntries() {
  return state.entries.filter((e) => state.selection.has(e.key));
}

function enterDir(entry) {
  if (entry.special === '.') return loadDir(state.currentDir);
  if (entry.special === '..') return goUp();
  if (!entry.isDir) return;
  loadDir(entry.key);
}

function goUp() {
  if (!state.currentDir) return toast('已经在根目录', '');
  const parts = state.currentDir.split('/').filter(Boolean);
  parts.pop();
  loadDir(parts.join('/'));
}

/* ================= 操作：上传/下载/删除/新建 ================= */

async function uploadFiles() {
  const r = await window.bridge.dialog.pickFiles();
  if (!r.ok) return;
  await window.bridge.transfer.startUpload({ paths: r.paths, targetDir: state.currentDir, asFolder: false });
  toast(`已加入传输：${r.paths.length} 个文件`, 'ok');
}

async function uploadFolder() {
  const r = await window.bridge.dialog.pickFolder('upload');
  if (!r.ok) return;
  await window.bridge.transfer.startUpload({ paths: [r.path], targetDir: state.currentDir, asFolder: true });
  toast('文件夹已加入传输队列', 'ok');
}

async function downloadSelection(entries) {
  if (!entries.length) return toast('请先选择要下载的项', '');
  const r = await window.bridge.dialog.pickFolder('download');
  if (!r.ok) return;
  const payload = entries.map((e) => ({ key: e.key, isDir: !!e.isDir }));
  await window.bridge.transfer.startDownload({ entries: payload, dest: r.path });
  toast(`已加入传输：下载 ${payload.length} 项`, 'ok');
}

async function deleteSelection(entries) {
  if (!entries.length) return toast('请先选择要删除的项', '');
  const names = entries.slice(0, 5).map((e) => `<strong>${esc(e.name)}</strong>`).join('、');
  const more = entries.length > 5 ? ` 等 ${entries.length} 项` : '';
  const ok = await confirmDialog({
    title: '删除确认',
    text: `确定要删除 ${names}${more} 吗？<br/>文件夹将被<strong>递归删除</strong>，此操作不可恢复。`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    const r = await window.bridge.s3.remove(entries.map((e) => ({ key: e.key, isDir: !!e.isDir })));
    toast(`已删除 ${r.count} 个对象`, 'ok');
    loadDir(state.currentDir, { silent: true });
  } catch (e) {
    toast('删除失败：' + (e.message || e), 'err');
  }
}

async function newFolder() {
  const name = await promptDialog({
    title: '新建文件夹',
    label: '文件夹名称',
    placeholder: '输入名称（支持中文与特殊字符）',
    okText: '创建',
  });
  if (!name) return;
  try {
    const key = state.currentDir ? state.currentDir + '/' + name : name;
    await window.bridge.s3.mkdir(key);
    toast('文件夹已创建', 'ok');
    loadDir(state.currentDir, { silent: true });
  } catch (e) {
    toast('创建失败：' + (e.message || e), 'err');
  }
}

/* ================= 拖拽上传 ================= */

function walkEntry(entry, base) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file((f) => resolve([{ rel: base + entry.name, file: f }]), () => resolve([]));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () => reader.readEntries(async (items) => {
        if (!items.length) {
          const res = await Promise.all(all.map((e) => walkEntry(e, base + entry.name + '/')));
          resolve(res.flat());
          return;
        }
        all.push(...items);
        readBatch();
      }, () => resolve([]));
      readBatch();
    } else resolve([]);
  });
}

async function handleDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = [];
  for (const it of items) {
    const en = it.webkitGetAsEntry && it.webkitGetAsEntry();
    if (en) entries.push(walkEntry(en, ''));
  }
  const groups = (await Promise.all(entries)).flat();
  if (!groups.length) return toast('未识别到可上传内容', '');
  const list = [];
  for (const g of groups) {
    const abs = window.bridge.pathForFile(g.file);
    if (abs) list.push({ abs, rel: g.rel });
  }
  if (!list.length) return toast('无法获取本地路径', 'err');
  await window.bridge.transfer.startUpload({ paths: list, targetDir: state.currentDir, asFolder: false, rawEntries: list });
  toast(`已加入传输：${list.length} 个文件`, 'ok');
}

/* ================= 传输面板 ================= */

const STATUS_TEXT = {
  queued: '排队', running: '传输中', done: '完成', error: '失败', cancelled: '已取消', cancelling: '取消中',
};

function renderTransfers() {
  const listEl = $('transferList');
  const tasks = [...state.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  const active = tasks.filter((t) => t.status === 'running' || t.status === 'queued' || t.status === 'cancelling').length;

  const badge = $('transferBadge');
  badge.textContent = tasks.length;
  badge.className = 'th-badge' + (active ? ' active' : '');

  if (!tasks.length) {
    listEl.innerHTML = '<div style="padding:14px;color:var(--faint);font-size:12px;text-align:center">暂无传输任务</div>';
    return;
  }
  let html = '';
  for (const t of tasks) {
    const detail = t.status === 'error'
      ? esc(t.error || '传输失败')
      : t.status === 'running'
        ? `${esc(t.current || '')} · ${fmtBytes(t.bytesLoaded)}${t.bytesTotal ? ' / ' + fmtBytes(t.bytesTotal) : ''} · 文件 ${t.filesDone}/${t.filesTotal}`
        : t.status === 'done'
          ? `共 ${t.filesTotal} 个文件 · ${fmtBytes(t.bytesTotal)}`
          : '';
    const cancellable = t.status === 'running' || t.status === 'queued';
    html += `
      <div class="task ${t.type} ${t.status}" data-id="${t.id}">
        <div class="task-ic">${t.type === 'upload' ? '⇧' : '⤓'}</div>
        <div class="task-main">
          <div class="task-name">${esc(t.name)}</div>
          <div class="task-detail">${detail}</div>
        </div>
        <div class="task-progress">
          <div class="pbar"><div class="pbar-fill" style="width:${t.pct}%"></div></div>
          <span class="pct">${t.pct}%</span>
        </div>
        <div class="task-status ${t.status}">${STATUS_TEXT[t.status] || t.status}</div>
        ${cancellable ? `<button class="task-cancel" title="取消任务">✕</button>` : '<span style="width:22px"></span>'}
      </div>`;
  }
  listEl.innerHTML = html;
  listEl.querySelectorAll('.task-cancel').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = Number(e.target.closest('.task').dataset.id);
      await window.bridge.transfer.cancel(id);
    });
  });
  updateStatus();
}

function togglePanel(force) {
  const panel = $('transferPanel');
  state.panelCollapsed = force !== undefined ? force : !state.panelCollapsed;
  panel.classList.toggle('collapsed', state.panelCollapsed);
}

/* ================= 右键菜单 ================= */

function rowContextMenu(e, entry) {
  const target = entry.special ? [] : [entry];
  if (!entry.special && !state.selection.has(entry.key)) selectOnly(parseInt(e.target.closest('.row').dataset.idx, 10));
  const sel = entry.special ? [] : selectedEntries();
  const items = [];
  if (sel.length) {
    items.push({ label: '下载…', icon: '⤓', click: () => downloadSelection(sel) });
    items.push({ label: '删除', icon: '✕', danger: true, click: () => deleteSelection(sel) });
    items.push('-');
  }
  if (entry.special === '..') items.push({ label: '返回上一级', icon: '↩', click: goUp });
  if (entry.special === '.') items.push({ label: '刷新', icon: '↻', click: () => loadDir(state.currentDir) });
  if (!entry.special && !entry.isDir) {
    items.push({ label: '复制名称', icon: '⧉', click: () => { navigator.clipboard.writeText(entry.name); toast('已复制名称', 'ok'); } });
  }
  items.push('-');
  items.push({ label: '刷新', icon: '↻', click: () => loadDir(state.currentDir) });
  showContextMenu(e.clientX, e.clientY, items);
}

function emptyContextMenu(e) {
  showContextMenu(e.clientX, e.clientY, [
    { label: '刷新', icon: '↻', click: () => loadDir(state.currentDir) },
    '-',
    { label: '上传文件…', icon: '⤒', click: uploadFiles },
    { label: '上传文件夹…', icon: '⇪', click: uploadFolder },
    { label: '新建文件夹…', icon: '＋', click: newFolder },
  ]);
}

/* ================= 事件绑定 ================= */

function bindEvents() {
  // 工具栏
  $('btnUp').addEventListener('click', goUp);
  $('btnRefresh').addEventListener('click', () => loadDir(state.currentDir));
  $('btnUploadFiles').addEventListener('click', uploadFiles);
  $('btnUploadFolder').addEventListener('click', uploadFolder);
  $('btnNewFolder').addEventListener('click', newFolder);
  $('btnDownload').addEventListener('click', () => downloadSelection(selectedEntries()));
  $('btnDelete').addEventListener('click', () => deleteSelection(selectedEntries()));
  $('btnSettings').addEventListener('click', openSettings);

  // 全选
  $('checkAll').addEventListener('change', () => {
    if ($('checkAll').checked) state.selection = new Set(state.entries.map((e) => e.key));
    else state.selection.clear();
    renderTable();
  });

  // 文件表
  const body = $('tableBody');
  body.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    const entry = rowEntry(idx);
    if (entry && entry.special) return;
    if (e.target.tagName === 'INPUT') {
      toggleSelect(idx);
      return;
    }
    if (e.ctrlKey || e.metaKey) toggleSelect(idx);
    else if (e.shiftKey) rangeSelect(idx);
    else selectOnly(idx);
  });
  body.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    enterDir(rowEntry(parseInt(row.dataset.idx, 10)));
  });
  body.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('.row');
    if (row) rowContextMenu(e, rowEntry(parseInt(row.dataset.idx, 10)));
    else emptyContextMenu(e);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Delete') deleteSelection(selectedEntries());
    else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      state.selection = new Set(state.entries.map((x) => x.key));
      renderTable();
    } else if (e.key === 'Backspace') goUp();
    else if (e.key === 'F5') loadDir(state.currentDir);
  });

  // 拖拽上传
  let dragDepth = 0;
  const fileArea = $('fileArea');
  fileArea.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropOverlay').classList.remove('hidden');
  });
  fileArea.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('dropOverlay').classList.add('hidden');
    }
  });
  fileArea.addEventListener('dragover', (e) => e.preventDefault());
  fileArea.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropOverlay').classList.add('hidden');
    await handleDrop(e.dataTransfer);
  });

  // 传输面板
  $('transferHeader').addEventListener('click', (e) => {
    if (e.target.id === 'btnClearTransfers') return;
    togglePanel();
  });
  $('btnClearTransfers').addEventListener('click', async () => {
    await window.bridge.transfer.clear();
    refreshTransfers();
  });
  window.bridge.transfer.onUpdate((task) => {
    state.tasks.set(task.id, task);
    renderTransfers();
    if (task.status === 'done' && task.type === 'upload') {
      // 上传完成后刷新当前目录（轻量、静默）
      loadDir(state.currentDir, { silent: true });
    }
  });

  // 应用菜单
  window.bridge.onMenu(({ action }) => {
    if (action === 'refresh') loadDir(state.currentDir);
    else if (action === 'upload-files') uploadFiles();
    else if (action === 'upload-folder') uploadFolder();
    else if (action === 'new-folder') newFolder();
    else if (action === 'settings') openSettings();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); loadDir(state.currentDir); }
    if (e.key === 'Escape') { document.getElementById('ctxRoot').innerHTML = ''; }
  });
}

/* ================= 设置与启动 ================= */

async function openSettings() {
  const current = await window.bridge.config.get();
  const result = await configDialog(current, { canCancel: true });
  if (result && result.saved) {
    applyConfig(result.config);
    toast('配置已保存', 'ok');
    loadDir('');
  }
}

function applyConfig(cfg) {
  state.configured = !!cfg;
  window.__brand = cfg ? `${cfg.bucket}${cfg.prefix ? ' / ' + cfg.prefix : ''}` : '未连接';
  $('brandBucket').textContent = window.__brand;
}

async function boot() {
  const info = await window.bridge.info();
  state.version = info.version;
  $('statVersion').textContent = `v${info.version} · Electron ${info.electron}`;
  const cfg = await window.bridge.config.get();
  applyConfig(cfg);
  bindEvents();
  renderTransfers();
  togglePanel(true);

  if (!cfg) {
    // 首次启动：强制完成配置
    const r = await configDialog(null, { canCancel: false });
    if (r && r.saved) {
      applyConfig(r.config);
      loadDir('');
    }
  } else {
    state.configured = true;
    loadDir('');
  }
}

boot();
