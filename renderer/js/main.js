import {
  fmtBytes, fmtTime, esc, toast, confirmDialog, promptDialog, configDialog, showContextMenu,
  updateAvailableDialog,
} from './util.js';
import { createTree } from './tree.js';
import { categoryOf, fileIconHtml } from './fileicon.js';

const $ = (id) => document.getElementById(id);

/** 目录树实例，配置就绪后才创建（未连接时无事可列） */
let tree = null;

/** 单页条数：S3 无偏移量，只能游标前进；200 是「一屏多一点」的折中 */
const PAGE_SIZE = 200;
/** 页缓存上限（LRU）：20 页约 4000 条，内存约 2MB，够来回翻 */
const PAGE_CACHE_MAX = 20;

const state = {
  version: '',
  electron: '',
  updateBase: '',
  channel: 'stable',   // 当前更新渠道：stable / dev
  availableVersion: '',
  mutedVersion: '',    // 用户勾过「不再提醒此版本」的版本号
  pendingUpdate: null, // 未完成连接配置时先暂存，配置完再弹
  promptingUpdate: false,
  checkingUpdate: false,
  configured: false,
  currentDir: '', // 相对前缀的目录 key
  search: '',     // 前缀搜索词，空串为浏览模式
  sort: { by: 'name', dir: 'asc' },
  entries: [],    // 当前页 [{key, name, isDir, size, mtime}]
  indexByKey: new Map(),
  selection: new Set(),
  lastIndex: -1,
  page: { index: 0, tokens: [undefined], nextToken: null, hasMore: false },
  pageCache: new Map(), // 'dir\0search\0index' -> 页结果；只存最近 20 页
  loading: false,
  loadSeq: 0,
  panelCollapsed: true,
  tasks: new Map(),
};

/* ================= 分页加载 ================= */

const maskText = () => $('loadingMask').querySelector('.mask-text');

function showMask(text) {
  maskText().textContent = text;
  $('loadingMask').classList.remove('hidden');
}

function hideMask() {
  $('loadingMask').classList.add('hidden');
}

function resetPaging() {
  state.page = { index: 0, tokens: [undefined], nextToken: null, hasMore: false, truncated: false };
}

function pageCacheKey(index) {
  return `${state.currentDir}\u0000${state.search}\u0000${index}`;
}

/** 命中后重新插入，维持 LRU 顺序 */
function cacheGet(key) {
  const hit = state.pageCache.get(key);
  if (!hit) return null;
  state.pageCache.delete(key);
  state.pageCache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  state.pageCache.set(key, value);
  while (state.pageCache.size > PAGE_CACHE_MAX) {
    const oldest = state.pageCache.keys().next().value;
    state.pageCache.delete(oldest);
  }
}

/**
 * 加载某一页。
 * 第 0 页不带 token；后续页的 token 在上一页响应里已经存进 state.page.tokens。
 */
async function loadPage(index, { silent = false } = {}) {
  if (!state.configured) return;
  if (index > 0 && !state.page.tokens[index]) return; // 没有游标说明已到末页
  const seq = ++state.loadSeq;

  if (!silent) {
    state.loading = true;
    showMask(index > 0 ? `正在加载第 ${index + 1} 页…` : '正在加载目录…');
  }

  try {
    let res = cacheGet(pageCacheKey(index));
    if (!res) {
      res = await window.bridge.s3.list(state.currentDir, {
        token: index === 0 ? undefined : state.page.tokens[index],
        maxKeys: PAGE_SIZE,
        search: state.search,
      });
      cacheSet(pageCacheKey(index), res);
    }
    if (seq !== state.loadSeq) return; // 已切到别的目录 / 搜索词，丢弃过期结果

    state.page.index = index;
    state.page.nextToken = res.nextToken || null;
    // IsTruncated 但没有 token 属于服务端异常，别让「下一页」变成点了没反应的死按钮
    state.page.hasMore = !!res.truncated && !!res.nextToken;
    // 搜索模式不分页，但被截断时要说一声，否则用户以为只有这么多
    state.page.truncated = !!res.truncated;
    if (res.nextToken) state.page.tokens[index + 1] = res.nextToken;

    state.selection.clear();
    state.lastIndex = -1;
    // dirs 里带的是 dir:true，统一成 isDir，后续渲染 / 进入目录只认一个字段
    const dirs = (res.dirs || []).map((d) => ({ ...d, isDir: true }));
    const files = (res.files || []).map((f) => ({ ...f, isDir: false }));
    state.entries = [...dirs, ...files];
    applySort();

    renderBreadcrumb();
    renderTable();
    renderPager();
    // 树只跟随高亮，不反向触发导航（避免 loadDir ⇄ 树选中 的循环）
    if (tree) tree.setCurrent(state.currentDir);
  } catch (e) {
    if (seq === state.loadSeq) toast('加载目录失败：' + (e.message || e), 'err');
  } finally {
    if (seq === state.loadSeq) {
      state.loading = false;
      hideMask();
      setSearchBusy(false);
    }
  }
}

/** 换目录：搜索词跟着清掉（跨目录沿用搜索词只会让人困惑） */
async function loadDir(dir = state.currentDir, { silent = false } = {}) {
  if (!state.configured) return;
  const next = String(dir || '');
  const changed = next !== state.currentDir;
  state.currentDir = next;
  if (changed && state.search) {
    state.search = '';
    syncSearchInput();
  }
  await reloadCurrent({ silent });
}

/** 同一目录内重来（刷新 / 改搜索词 / 增删后）：清缓存并回到第 1 页 */
async function reloadCurrent({ silent = false } = {}) {
  state.pageCache.clear();
  resetPaging();
  await loadPage(0, { silent });
}

function goPrevPage() {
  if (state.loading || state.page.index <= 0) return;
  loadPage(state.page.index - 1);
}

function goNextPage() {
  if (state.loading || !state.page.hasMore) return;
  loadPage(state.page.index + 1);
}

/* ================= 排序（仅当前页） ================= */

const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'),
  size: (a, b) => (a.size || 0) - (b.size || 0),
  time: (a, b) => String(a.mtime || '').localeCompare(String(b.mtime || '')),
};

/** 目录恒在前，文件按当前列排序；S3 没有全局排序，这里只作用于本页 */
function applySort() {
  const cmp = SORTERS[state.sort.by] || SORTERS.name;
  const mul = state.sort.dir === 'desc' ? -1 : 1;
  const dirs = state.entries.filter((e) => e.isDir).sort((a, b) => cmp(a, b) * mul);
  const files = state.entries.filter((e) => !e.isDir).sort((a, b) => cmp(a, b) * mul);
  state.entries = [...dirs, ...files];
}

function updateSortIndicators() {
  document.querySelectorAll('.table-head .sortable').forEach((el) => {
    const active = el.dataset.sort === state.sort.by;
    el.classList.toggle('sorted', active);
    const ind = el.querySelector('.sort-ind');
    if (ind) ind.textContent = active ? (state.sort.dir === 'asc' ? '▲' : '▼') : '';
  });
}

/* ================= 面包屑 ================= */

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

/* ================= 列表渲染 ================= */

function rowHtml(r, idx) {
  const selected = state.selection.has(r.key);
  const cat = categoryOf(r.name, !!r.isDir);
  const size = r.isDir ? '—' : fmtBytes(r.size);
  const time = r.isDir ? '—' : fmtTime(r.mtime);
  return `
    <div class="row${selected ? ' selected' : ''}" data-idx="${idx}" data-key="${esc(r.key)}">
      <label class="cell-check"><input type="checkbox"${selected ? ' checked' : ''} /></label>
      <div class="cell-name">
        <div class="file-ic ${cat}">${fileIconHtml(cat)}</div>
        <span class="file-name" title="${esc(r.key)}">${esc(r.name)}</span>
      </div>
      <div class="cell-size">${size}</div>
      <div class="cell-time">${time}</div>
    </div>`;
}

function renderTable() {
  const body = $('tableBody');
  state.indexByKey = new Map();

  if (!state.entries.length) {
    const searching = !!state.search;
    body.innerHTML = `
      <div class="empty-state">
        <div class="big">${fileIconHtml(searching ? 'other' : 'dir')}</div>
        <div>${searching ? `没有以「${esc(state.search)}」开头的对象` : '此目录为空'}</div>
        <div style="font-size:11.5px">${searching ? '不区分大小写，只匹配名称开头（S3 前缀语义），换个开头的几个字试试' : '可拖拽文件/文件夹到此处上传，或使用上方按钮'}</div>
      </div>`;
  } else {
    let html = '';
    state.entries.forEach((r, idx) => {
      state.indexByKey.set(r.key, idx);
      html += rowHtml(r, idx);
    });
    body.innerHTML = html;
  }

  updateSortIndicators();
  updateStatus();
  updateCheckAll();
}

function rowEntry(idx) {
  return state.entries[idx] || null;
}

function updateStatus() {
  const total = state.entries.length;
  const sel = state.selection.size;
  const running = [...state.tasks.values()].filter((t) => t.status === 'running' || t.status === 'queued').length;
  const parts = [];
  if (state.search) parts.push(`搜索「${state.search}」`);
  parts.push(`第 ${state.page.index + 1} 页 · 本页 ${total} 项`);
  if (state.page.hasMore) parts.push('还有更多');
  if (sel) parts.push(`已选 ${sel} 项`);
  if (running) parts.push(`${running} 个传输任务进行中`);
  $('statLeft').textContent = parts.join(' · ');
}

function updateCheckAll() {
  const box = $('checkAll');
  const total = state.entries.length;
  const sel = state.entries.filter((e) => state.selection.has(e.key)).length;
  box.checked = total > 0 && sel === total;
  box.indeterminate = sel > 0 && sel < total;
}

function renderPager() {
  const pager = $('pager');
  if (state.search) {
    // 搜索结果不分页：游标只能一路往后翻，而搜索该做的是加长前缀收窄范围
    pager.classList.remove('hidden');
    pager.classList.add('search-mode');
    const n = state.entries.length;
    $('pageLabel').textContent = n === 0
      ? '无匹配'
      : `匹配 ${n} 项${state.page.truncated ? '（已截断，加长前缀收窄）' : ''}`;
    return;
  }
  pager.classList.remove('search-mode');
  const show = state.page.index > 0 || state.page.hasMore;
  pager.classList.toggle('hidden', !show);
  $('pageLabel').textContent = `第 ${state.page.index + 1} 页`;
  $('btnPrevPage').disabled = state.page.index <= 0;
  $('btnNextPage').disabled = !state.page.hasMore;
}

/* ================= 选择（增量更新，不整表重绘） ================= */

/** 只改目标行的 class 与勾选框：大目录下点一下就整表 innerHTML 会明显卡顿 */
function repaintKeys(keys) {
  const body = $('tableBody');
  for (const key of keys) {
    const idx = state.indexByKey.get(key);
    if (idx === undefined) continue;
    const row = body.querySelector(`.row[data-idx="${idx}"]`);
    if (!row) continue;
    const selected = state.selection.has(key);
    row.classList.toggle('selected', selected);
    const box = row.querySelector('input[type="checkbox"]');
    if (box) box.checked = selected;
  }
  updateCheckAll();
  updateStatus();
}

function selectOnly(idx) {
  const prev = [...state.selection];
  state.selection.clear();
  const r = rowEntry(idx);
  if (r) state.selection.add(r.key);
  state.lastIndex = idx;
  repaintKeys(prev.concat(r ? [r.key] : []));
}

function toggleSelect(idx) {
  const r = rowEntry(idx);
  if (!r) return;
  if (state.selection.has(r.key)) state.selection.delete(r.key);
  else state.selection.add(r.key);
  state.lastIndex = idx;
  repaintKeys([r.key]);
}

function rangeSelect(idx) {
  const from = Math.min(state.lastIndex < 0 ? idx : state.lastIndex, idx);
  const to = Math.max(state.lastIndex < 0 ? idx : state.lastIndex, idx);
  const prev = [...state.selection];
  state.selection.clear();
  const range = [];
  for (let i = from; i <= to; i++) {
    const r = rowEntry(i);
    if (r) { state.selection.add(r.key); range.push(r.key); }
  }
  repaintKeys(prev.concat(range));
}

function selectedEntries() {
  return state.entries.filter((e) => state.selection.has(e.key));
}

function selectAll(checked) {
  const prev = [...state.selection];
  if (checked) state.selection = new Set(state.entries.map((e) => e.key));
  else state.selection.clear();
  repaintKeys(prev.concat(state.entries.map((e) => e.key)));
}

function enterDir(entry) {
  if (!entry || !entry.isDir) return;
  loadDir(entry.key);
}

function goUp() {
  if (!state.currentDir) return toast('已经在根目录', '');
  const parts = state.currentDir.split('/').filter(Boolean);
  parts.pop();
  loadDir(parts.join('/'));
}

/* ================= 搜索 ================= */

/**
 * 搜索框 → 服务端前缀查询，三条规矩：
 * 1. 空闲 500ms 才发请求；走输入法时（composition 期间）一个字母都不发，
 *    否则每敲一下拼音都会拿半截词去查一次，列表跟着闪。
 * 2. 失焦时**取消**挂起的查询：用户点列表说明他要操作眼前这份列表，
 *    这时候突然重排是最坏的时机。
 * 3. 搜索期间的重新加载不盖遮罩（silent），只在搜索框上转个小圈。
 */
const SEARCH_DELAY = 500;
let searchTimer = null;
let composing = false;

function setSearchBusy(busy) {
  const box = $('searchInput').closest('.tb-search');
  if (box) box.classList.toggle('searching', !!busy);
}

function syncSearchInput() {
  const input = $('searchInput');
  // 组词中回写 value 会把输入法的候选状态顶掉
  if (!composing && input.value !== state.search) input.value = state.search;
  $('btnSearchClear').classList.toggle('hidden', !state.search);
}

function cancelScheduledSearch() {
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
}

function scheduleSearch(value) {
  cancelScheduledSearch();
  const text = String(value == null ? '' : value);
  $('btnSearchClear').classList.toggle('hidden', !text);
  searchTimer = setTimeout(() => {
    searchTimer = null;
    applySearch(text);
  }, SEARCH_DELAY);
}

function applySearch(value) {
  const next = String(value || '').trim();
  if (next === state.search) return;
  state.search = next;
  syncSearchInput();
  if (!state.configured) return; // 还没连上，没有列表可搜
  setSearchBusy(true);
  reloadCurrent({ silent: true });
}

function clearSearch() {
  if (!state.search && !$('searchInput').value) return;
  cancelScheduledSearch();
  $('searchInput').value = '';
  $('btnSearchClear').classList.add('hidden');
  applySearch('');
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
    reloadCurrent({ silent: true });
    if (tree) tree.refresh(state.currentDir);
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
    reloadCurrent({ silent: true });
    if (tree) tree.refresh(state.currentDir);
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
  if (!entry) return;
  if (!state.selection.has(entry.key)) selectOnly(parseInt(e.target.closest('.row').dataset.idx, 10));
  const sel = selectedEntries();
  const items = [
    { label: '下载…', icon: '⤓', click: () => downloadSelection(sel) },
    { label: '删除', icon: '✕', danger: true, click: () => deleteSelection(sel) },
  ];
  if (!entry.isDir) {
    items.push('-');
    items.push({ label: '复制名称', icon: '⧉', click: () => { navigator.clipboard.writeText(entry.name); toast('已复制名称', 'ok'); } });
    items.push({ label: '复制完整路径', icon: '⌘', click: () => { navigator.clipboard.writeText(entry.key); toast('已复制路径', 'ok'); } });
  }
  items.push('-');
  items.push({ label: '刷新', icon: '↻', click: () => reloadCurrent() });
  showContextMenu(e.clientX, e.clientY, items);
}

function emptyContextMenu(e) {
  showContextMenu(e.clientX, e.clientY, [
    { label: '返回上一级', icon: '↩', disabled: !state.currentDir, click: goUp },
    '-',
    { label: '刷新', icon: '↻', click: () => reloadCurrent() },
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
  $('btnRefresh').addEventListener('click', () => reloadCurrent());
  $('btnUploadFiles').addEventListener('click', uploadFiles);
  $('btnUploadFolder').addEventListener('click', uploadFolder);
  $('btnNewFolder').addEventListener('click', newFolder);
  $('btnDownload').addEventListener('click', () => downloadSelection(selectedEntries()));
  $('btnDelete').addEventListener('click', () => deleteSelection(selectedEntries()));
  $('btnSettings').addEventListener('click', openSettings);

  // 分页
  $('btnPrevPage').addEventListener('click', goPrevPage);
  $('btnNextPage').addEventListener('click', goNextPage);

  // 搜索：空闲 500ms 生效，输入法组词期间不触发，回车立即生效，Esc 清空，失焦取消
  const input = $('searchInput');
  input.addEventListener('compositionstart', () => {
    composing = true;
    cancelScheduledSearch();
  });
  input.addEventListener('compositionend', () => {
    composing = false;
    scheduleSearch(input.value);
  });
  input.addEventListener('input', () => {
    if (composing) return; // 拼音还没上屏，这时候的值是半成品
    scheduleSearch(input.value);
  });
  input.addEventListener('blur', () => {
    // 失焦不补发：否则「打完字顺手点文件」会变成一次意外重排
    cancelScheduledSearch();
    setSearchBusy(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      cancelScheduledSearch();
      applySearch(input.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      clearSearch();
    }
  });
  $('btnSearchClear').addEventListener('click', () => { clearSearch(); input.focus(); });

  // 列头排序（仅当前页）
  document.querySelectorAll('.table-head .sortable').forEach((el) => {
    el.addEventListener('click', () => {
      const by = el.dataset.sort;
      if (state.sort.by === by) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
      else { state.sort.by = by; state.sort.dir = 'asc'; }
      applySort();
      renderTable();
    });
  });

  // 全选
  $('checkAll').addEventListener('change', () => selectAll($('checkAll').checked));

  // 文件表
  const body = $('tableBody');
  body.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    if (!rowEntry(idx)) return;
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
      selectAll(true);
    } else if (e.key === 'Backspace') goUp();
    else if (e.key === 'F5') reloadCurrent();
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
    // 主进程只清已结束的任务，本地映射同步剔除，否则列表会一直挂着旧条目
    for (const [id, t] of [...state.tasks]) {
      if (t.status === 'done' || t.status === 'error' || t.status === 'cancelled') state.tasks.delete(id);
    }
    renderTransfers();
  });
  window.bridge.transfer.onUpdate((task) => {
    state.tasks.set(task.id, task);
    renderTransfers();
    if (task.status === 'done' && task.type === 'upload') {
      // 上传完成后刷新当前页（轻量、静默）
      reloadCurrent({ silent: true });
      if (tree) tree.refresh(state.currentDir);
    }
  });

  // 应用菜单
  window.bridge.onMenu(({ action }) => {
    if (action === 'refresh') reloadCurrent();
    else if (action === 'upload-files') uploadFiles();
    else if (action === 'upload-folder') uploadFolder();
    else if (action === 'new-folder') newFolder();
    else if (action === 'settings') openSettings();
    else if (action === 'check-update') checkUpdates();
  });

  // 版本号可点击：检查更新 / 下载已发现的新版本
  $('statVersion').addEventListener('click', () => checkUpdates());
  // 渠道徽标可点击：切换 stable / dev
  $('statChannel').addEventListener('click', openChannelMenu);

  // 菜单里切换渠道后主进程会广播，这里同步界面并重查
  window.bridge.update.onChannel((ch) => {
    if (!ch || ch === state.channel || ch === switchingChannel) return;
    applyChannel(ch);
    toast(`已切换到${CHANNEL_LABELS[ch] || ch}渠道，正在检查更新…`, 'ok');
    checkUpdates();
  });

  // 启动后主进程静默探测到新版本：弹窗提示（已请求静默的版本除外）
  window.bridge.update.onAvailable((r) => { handleAvailableUpdate(r); });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); reloadCurrent(); }
    if (e.key === 'Escape') { document.getElementById('ctxRoot').innerHTML = ''; }
  });
}

/* ================= 版本更新 ================= */

function setVersionText(text) {
  $('statVersion').textContent = text;
}

const CHANNEL_LABELS = { stable: '正式版', dev: '开发版' };
let switchingChannel = null;

function renderChannelBadge() {
  const el = $('statChannel');
  el.textContent = state.channel === 'dev' ? 'dev' : 'stable';
  el.classList.toggle('dev', state.channel === 'dev');
  el.title = `更新渠道：${CHANNEL_LABELS[state.channel] || state.channel}（点击切换）`;
}

function openChannelMenu() {
  const r = $('statChannel').getBoundingClientRect();
  const items = ['stable', 'dev'].map((ch) => ({
    label: `${CHANNEL_LABELS[ch]}（${ch}）`,
    icon: state.channel === ch ? '✓' : '·',
    click: () => switchChannel(ch),
  }));
  // 状态栏在底部，菜单要往上弹
  showContextMenu(r.left, Math.max(6, r.top - 88), items);
}

/** 切换渠道：主进程负责落盘与重建菜单，这里清掉旧渠道的「可更新」状态并立即按新渠道重查 */
async function switchChannel(ch) {
  if (!ch || ch === state.channel) return;
  switchingChannel = ch;
  try {
    const r = await window.bridge.update.setChannel(ch);
    if (!r || !r.ok) {
      toast('切换渠道失败：' + ((r && r.error) || '未知错误'), 'err');
      return;
    }
    applyChannel(r.channel);
    toast(`已切换到${CHANNEL_LABELS[r.channel] || r.channel}渠道，正在检查更新…`, 'ok');
    await checkUpdates();
  } finally {
    switchingChannel = null;
  }
}

function applyChannel(ch) {
  if (!ch) return;
  state.channel = ch;
  state.availableVersion = '';
  renderChannelBadge();
  renderVersionLabel();
}

function renderVersionLabel() {
  const el = $('statVersion');
  if (state.availableVersion) {
    el.textContent = `v${state.version} → v${state.availableVersion} 可更新`;
    el.title = '点击查看更新';
    el.classList.add('has-update');
  } else {
    el.textContent = `v${state.version}${state.electron ? ` · Electron ${state.electron}` : ''}`;
    el.title = '点击检查更新';
    el.classList.remove('has-update');
  }
}

/**
 * 检查更新。
 * silent=true 用于启动后的自动探测：只在状态栏留痕，不弹窗、不报错。
 */
async function checkUpdates({ silent = false } = {}) {
  if (state.checkingUpdate) return;
  state.checkingUpdate = true;
  if (!silent) setVersionText('检查更新中…');

  let r;
  try {
    r = await window.bridge.update.check();
  } catch (e) {
    r = { ok: false, error: e.message || String(e) };
  } finally {
    state.checkingUpdate = false;
  }

  if (!r || !r.ok) {
    renderVersionLabel();
    if (!silent) toast('检查更新失败：' + ((r && r.error) || '未知错误'), 'err');
    return;
  }

  state.availableVersion = r.updateAvailable && r.latest ? r.latest.version : '';
  renderVersionLabel();

  if (!state.availableVersion) {
    if (!silent) toast(`已是最新版本 v${state.version}`, 'ok');
    return;
  }
  await promptUpdate(r.latest);
}

/**
 * 启动探测命中新版本。
 * 三种情况不弹：连接还没配好（否则和首次配置弹窗叠在一起）、用户勾过「不再提醒此版本」、
 * 已经有弹窗在处理（避免慢网络下重复推两条事件弹两次）。
 */
async function handleAvailableUpdate(r) {
  const latest = r && r.latest;
  if (!latest || !latest.version) return;

  state.availableVersion = latest.version;
  renderVersionLabel();

  if (!state.configured) {
    state.pendingUpdate = latest;
    return;
  }
  if (state.mutedVersion && state.mutedVersion === latest.version) {
    toast(`发现新版本 v${latest.version}（本版本已忽略提醒，点右下角版本号可查看）`, '');
    return;
  }
  await promptUpdate(latest);
}

/**
 * 发现新版本 → 交给弹窗走完「下载 → 唤起安装器」。
 * 无论是否忽略过，手动点版本号走这里都会弹（忽略只作用于启动自动提醒）。
 */
async function promptUpdate(latest) {
  if (!latest || !latest.version || state.promptingUpdate) return;
  state.promptingUpdate = true;

  let downloaded = null;
  let result;
  try {
    result = await updateAvailableDialog({
      current: state.version,
      latest,
      actions: {
        download: async () => {
          const res = await window.bridge.update.download(latest);
          if (res && res.ok) downloaded = res;
          return res;
        },
        install: async () => {
          if (!downloaded) return { ok: false, error: '还没有下载好的安装包' };
          return window.bridge.update.install(downloaded.filePath);
        },
        reveal: () => window.bridge.update.reveal(downloaded && downloaded.filePath),
        cancel: () => window.bridge.update.cancel(),
        skip: async () => {
          try {
            state.mutedVersion = await window.bridge.update.muteVersion(latest.version);
            toast(`已跳过 v${latest.version}，出现更新的版本时还会提示`, '');
          } catch { /* 落盘失败只影响下次是否再弹 */ }
        },
      },
    });
  } finally {
    state.promptingUpdate = false;
  }

  // 安装包已经落到本地，状态栏不必再挂着「可更新」
  if (downloaded) {
    state.availableVersion = '';
    renderVersionLabel();
  }
  return result;
}

/* ================= 设置与启动 ================= */

async function openSettings() {
  const current = await window.bridge.config.get();
  const result = await configDialog(current, { canCancel: true });
  if (result && result.saved) {
    applyConfig(result.config);
    toast('配置已保存', 'ok');
    // bucket / prefix 可能变了，树的缓存整体作废
    if (tree) tree.refresh('');
    await loadDir('');
    await flushPendingUpdate();
  }
}

/** 连接配置完成后，补弹启动时因未配置而压住的新版本提示 */
async function flushPendingUpdate() {
  if (!state.pendingUpdate) return;
  const latest = state.pendingUpdate;
  state.pendingUpdate = null;
  if (state.mutedVersion === latest.version) return;
  await promptUpdate(latest);
}

function applyConfig(cfg) {
  state.configured = !!cfg;
  window.__brand = cfg ? `${cfg.bucket}${cfg.prefix ? ' / ' + cfg.prefix : ''}` : '未连接';
  $('brandBucket').textContent = window.__brand;
}

async function initTree() {
  if (tree) return;
  tree = createTree({
    panel: $('treePanel'),
    body: $('treeBody'),
    splitter: $('treeSplitter'),
    expandBtn: $('btnTreeExpand'),
    collapseBtn: $('btnTreeCollapse'),
    refreshBtn: $('btnTreeRefresh'),
    onOpen: (key) => loadDir(key),
  });
  await tree.init();
}

async function boot() {
  const info = await window.bridge.info();
  state.version = info.version;
  state.electron = info.electron;
  state.updateBase = info.updateBase || '';
  state.channel = info.updateChannel || 'stable';
  renderChannelBadge();
  renderVersionLabel();
  renderPager();
  try {
    state.mutedVersion = (await window.bridge.update.mutedVersion()) || '';
  } catch { /* 读不到就按未忽略处理 */ }

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
      state.configured = true;
      await initTree();
      await loadDir('');
      await flushPendingUpdate();
    }
  } else {
    state.configured = true;
    await initTree();
    await loadDir('');
  }
}

/**
 * 冒烟测试钩子：仅 QINGSTOR_SMOKE=1 时存在。
 * 让主进程能在没有 bucket 的情况下注入假目录，验证图标、选择态、分页条等渲染逻辑。
 */
if (window.bridge.env && window.bridge.env.smoke) {
  window.__smoke = {
    state,
    inject(entries) {
      state.configured = true;
      state.currentDir = '';
      state.search = '';
      resetPaging();
      state.selection.clear();
      state.lastIndex = -1;
      state.entries = entries || [];
      state.pageCache.clear();
      renderBreadcrumb();
      renderTable();
      renderPager();
    },
    selectOnly,
    setPage(index, hasMore) {
      state.page.index = index;
      state.page.hasMore = !!hasMore;
      renderPager();
    },
    setSearch(v) {
      state.search = String(v || '');
      syncSearchInput();
      renderPager();
    },
    /**
     * 冒烟用：把「发现新版本」弹窗按真实参数打开，用来核对文案与按钮流转。
     * 不传真实 actions —— 冒烟只验界面，不真的下载。
     */
    openUpdateMock() {
      updateAvailableDialog({
        current: '0.0.1-dev.1',
        latest: {
          version: '1.0.0-dev',
          channel: 'dev',
          platform: 'win',
          arch: 'x64',
          size: 87765432,
          publishedAt: new Date('2026-10-28T09:26:00Z').toISOString(),
          notes: '新增左侧目录树、文件类型图标、大目录分页与前缀搜索。',
        },
        actions: { download: () => ({ ok: false, error: 'smoke' }) },
      });
    },
  };
}

boot();
