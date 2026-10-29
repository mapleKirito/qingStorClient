'use strict';

const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { ConfigStore } = require('./config');
const { UiStateStore } = require('./uistate');
const { TransferManager } = require('./transfers');
const names = require('./names');
const s3 = require('./s3');
const update = require('./update');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://bundle`;

// 冒烟测试：关硬件加速 + 数据目录隔离到临时位置，启动后自动退出
const SMOKE = process.env.QINGSTOR_SMOKE === '1';
if (SMOKE) {
  app.disableHardwareAcceleration();
  app.setPath('userData', path.join(require('node:os').tmpdir(), `qingstor-smoke-${process.pid}`));
}

const configStore = new ConfigStore(app.getPath('userData'));
const channelStore = new update.ChannelStore(app.getPath('userData'));
const muteStore = new update.MuteStore(app.getPath('userData'));
const uiStateStore = new UiStateStore(app.getPath('userData'));
const transfers = new TransferManager();
let mainWindow = null;

/* ---------------- 自定义协议：渲染进程用原生 ES Module ---------------- */
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      let pathname = decodeURIComponent(url.pathname || '/');
      if (!pathname || pathname === '/') pathname = '/index.html';
      const resolved = path.normalize(path.join(RENDERER_DIR, pathname));
      if (!resolved.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
      const ext = path.extname(resolved).toLowerCase();
      const body = await fs.promises.readFile(resolved);
      return new Response(body, {
        headers: { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' },
      });
    } catch (e) {
      return new Response(`Not found: ${e.message}`, { status: 404 });
    }
  });
}

/* ---------------- 冒烟测试 ---------------- */

// 渲染进程错误（console error 级、加载失败、渲染进程崩溃）都算失败
const smokeErrors = [];

/**
 * 在渲染进程里跑的断言集。
 *
 * 不依赖真实 bucket：渲染层在 QINGSTOR_SMOKE=1 时暴露 window.__smoke，
 * 这里直接注入假目录，验证图标映射、选择态增量更新、分页条、排序、空态。
 * 这样「大目录优化」这类重构也能在没有网络和凭据的情况下冒烟。
 */
const SMOKE_SCRIPT = `(async () => {
  const out = [];
  const add = (name, ok, detail) => out.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const $ = (id) => document.getElementById(id);
  const sm = window.__smoke;
  add('渲染层模块加载', !!sm && !!window.bridge);
  if (!sm) return out;

  add('基础容器齐备', [$('treeBody'), $('breadcrumb'), $('searchInput'), $('pager'), $('tableBody'), $('checkAll')].every(Boolean));

  const names = ['照片.PNG', '片子.mp4', '歌.mp3', '报告.docx', '预算.xlsx', '汇报.pptx', '说明.pdf', '包.zip', 'main.js', 'readme.md', 'setup.exe', '字体.ttf', '神秘文件.xyz'];
  const expect = ['dir', 'image', 'video', 'audio', 'doc', 'sheet', 'slide', 'pdf', 'archive', 'code', 'text', 'exe', 'font', 'other'];
  const entries = [{ name: '资料', key: '资料', isDir: true }].concat(names.map((n, i) => ({
    name: n, key: n, size: (i + 1) * 1024, mtime: '2026-10-28T08:00:00.000Z', isDir: false,
  })));
  sm.inject(entries);

  const rows = document.querySelectorAll('#tableBody .row');
  add('行渲染数量', rows.length === entries.length, rows.length + '/' + entries.length);

  const cats = Array.prototype.map.call(document.querySelectorAll('#tableBody .file-ic'), (el) => el.className.replace('file-ic ', ''));
  add('图标类别映射', JSON.stringify(cats) === JSON.stringify(expect), cats.join(','));

  const uses = Array.prototype.map.call(document.querySelectorAll('#tableBody .file-ic use'), (u) => (u.getAttribute('href') || '').replace('#', ''));
  add('SVG 图标引用齐全', uses.length === entries.length && uses.every((id) => !!document.getElementById(id)), uses.length + ' 个引用');

  const before = document.querySelectorAll('#tableBody .row')[1];
  sm.selectOnly(1);
  const after = document.querySelectorAll('#tableBody .row')[1];
  add('选择态增量更新（节点复用）', before === after && after.classList.contains('selected'), before === after ? '复用既有节点' : '节点被整表重建');

  const all = $('checkAll');
  all.checked = true;
  all.dispatchEvent(new Event('change'));
  add('全选', document.querySelectorAll('#tableBody .row.selected').length === entries.length, document.querySelectorAll('#tableBody .row.selected').length + ' 行选中');

  document.querySelector('.table-head .cell-name').click();
  add('列头排序切换', sm.state.sort.dir === 'desc', 'sort=' + sm.state.sort.by + ':' + sm.state.sort.dir);

  sm.setPage(2, true);
  add('分页条出现', !$('pager').classList.contains('hidden'));
  add('页码显示第 3 页', $('pageLabel').textContent.indexOf('3') >= 0, $('pageLabel').textContent);
  add('下一页可用', $('btnNextPage').disabled === false);
  add('上一页可用', $('btnPrevPage').disabled === false);

  sm.setPage(0, false);
  add('单页时分页条隐藏', $('pager').classList.contains('hidden'));

  sm.setSearch('报告');
  add('搜索词回填输入框', $('searchInput').value === '报告', $('searchInput').value);
  add('搜索模式收起翻页按钮', $('pager').classList.contains('search-mode') && !$('pager').classList.contains('hidden'));
  add('搜索结果显示匹配数', /^匹配 \\d+ 项/.test($('pageLabel').textContent), $('pageLabel').textContent);
  sm.setSearch('');
  add('清空搜索恢复分页条', !$('pager').classList.contains('search-mode'));

  sm.inject([]);
  add('空目录占位', !!document.querySelector('#tableBody .empty-state'));

  // 收尾恢复一份有内容的列表，方便 --shot 截图核对图标与分页条
  sm.inject(entries);
  sm.setPage(2, true);
  const modalRoot = document.getElementById('modalRoot');
  if (modalRoot) modalRoot.innerHTML = '';

  // 更新弹窗：文案与按钮要对齐参考项目（单弹窗内嵌进度、下载完直接唤起安装器）
  sm.openUpdateMock();
  const modal = modalRoot.querySelector('.modal');
  add('更新弹窗已打开', !!modal);
  const titleEl = modal && modal.querySelector('.modal-title');
  add('弹窗标题正确', !!titleEl && titleEl.textContent.trim() === '发现新版本', titleEl ? titleEl.textContent.trim() : '');
  const mainBtn = modal && modal.querySelector('#updGo');
  add('主按钮为「下载并安装」', !!mainBtn && mainBtn.textContent.trim() === '下载并安装', mainBtn ? mainBtn.textContent.trim() : '');
  add('有「跳过此版本」', !!modal && !!modal.querySelector('#updSkip'));
  add('进度区默认隐藏', !!modal && modal.querySelector('#updProgress').hidden);
  const hintEl = modal && modal.querySelector('.hint');
  const hintText = hintEl ? hintEl.textContent : '';
  add('提示不再提「安全提示」', hintText.indexOf('代码签名') < 0 && hintText.indexOf('安全提示') < 0, hintText.slice(0, 28) + '…');

  return out;
})()`;

async function runSmokeChecks() {
  let checks = [];
  try {
    checks = await mainWindow.webContents.executeJavaScript(SMOKE_SCRIPT, true);
  } catch (e) {
    smokeErrors.push('执行冒烟脚本失败：' + (e.message || e));
  }
  if (!Array.isArray(checks)) checks = [];

  // 主进程侧：S3 的 Prefix 是字节精确匹配，大小写只能靠多变体覆盖，验证变体生成
  const kwVariants = typeof s3.caseVariants === 'function' ? s3.caseVariants('zj') : [];
  checks.push({
    name: '搜索词大小写变体',
    ok: ['zj', 'ZJ', 'Zj'].every((v) => kwVariants.indexOf(v) >= 0),
    detail: kwVariants.join(','),
  });
  const cnVariants = typeof s3.caseVariants === 'function' ? s3.caseVariants('报告') : [];
  checks.push({
    name: '中文关键词不放大请求数',
    ok: cnVariants.length === 1,
    detail: cnVariants.join(','),
  });

  // 可选：把断言后的界面截下来，人工核对图标 / 分页条的视觉效果
  if (process.env.QINGSTOR_SMOKE_SHOT === '1') {
    try {
      // 等一帧：清掉弹窗后立刻截图会拿到旧画面
      await new Promise((r) => setTimeout(r, 500));
      const img = await mainWindow.webContents.capturePage();
      const shot = path.join(require('node:os').tmpdir(), 'qingstor-smoke.png');
      fs.writeFileSync(shot, img.toPNG());
      console.log('SMOKE_SHOT: ' + shot);
    } catch (e) {
      console.warn('截图失败：' + (e.message || e));
    }
  }

  for (const c of checks) {
    console.log(`${c.ok ? '  ok  ' : ' FAIL '} ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  if (failed || smokeErrors.length) {
    if (smokeErrors.length) console.error('SMOKE_ERRORS:\n' + smokeErrors.join('\n'));
    console.error(`SMOKE_FAILED: ${failed} 项断言失败 / ${smokeErrors.length} 条运行时错误`);
    app.exit(1);
  } else {
    console.log(`SMOKE_OK: ${checks.length} 项断言全部通过`);
    app.exit(0);
  }
}

/** 挂冒烟采集：错误收集 + 页面加载完成后跑断言 */
function attachSmoke(win) {
  const wc = win.webContents;
  wc.on('console-message', (_e, level, message) => {
    if (level >= 2) smokeErrors.push(message);
  });
  wc.on('render-process-gone', () => smokeErrors.push('renderer gone'));
  wc.on('did-fail-load', (_e, code, desc) => smokeErrors.push(`load failed: ${code} ${desc}`));
  wc.once('did-finish-load', () => setTimeout(runSmokeChecks, 1500));
}

/* ---------------- 窗口 ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#14161b',
    title: 'QingStorClient',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: !SMOKE,
    },
  });

  if (SMOKE) attachSmoke(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  return mainWindow;
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (payload) => mainWindow && mainWindow.webContents.send('menu', payload);
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '刷新', accelerator: 'F5', click: () => send({ action: 'refresh' }) },
        { label: '上传文件…', accelerator: 'CmdOrCtrl+U', click: () => send({ action: 'upload-files' }) },
        { label: '上传文件夹…', accelerator: 'CmdOrCtrl+Shift+U', click: () => send({ action: 'upload-folder' }) },
        { label: '新建文件夹…', accelerator: 'CmdOrCtrl+N', click: () => send({ action: 'new-folder' }) },
        { type: 'separator' },
        isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
      ],
    },
    { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }] },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新界面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '连接设置…', click: () => send({ action: 'settings' }) },
        { label: '检查更新…', click: () => send({ action: 'check-update' }) },
        {
          label: '更新渠道',
          submenu: [
            { label: '正式版（stable）', type: 'radio', checked: channelStore.get() === 'stable', click: () => setUpdateChannel('stable') },
            { label: '开发版（dev）', type: 'radio', checked: channelStore.get() === 'dev', click: () => setUpdateChannel('dev') },
          ],
        },
        { type: 'separator' },
        {
          label: '关于',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 QingStorClient',
              message: `QingStorClient v${app.getVersion()}`,
              detail: `青云对象存储桌面客户端（S3 协议）\nElectron ${process.versions.electron} · Node ${process.versions.node}`,
              buttons: ['好'],
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 更新：检查 / 下载 / 安装 ---------------- */

const updateState = { checking: false, downloading: false, abort: null };

function updateRoot() {
  return update.defaultInstallDir(app.getPath('userData'));
}

/** 安装包按渠道分目录（updates/stable、updates/dev），两个渠道的同号包不会互相覆盖 */
function updateDir(channel) {
  return path.join(updateRoot(), update.resolveChannel(channel || channelStore.get()));
}

async function checkUpdate() {
  if (updateState.checking) return { ok: false, error: '正在检查更新，请稍候' };
  updateState.checking = true;
  try {
    return await update.checkForUpdates({ current: app.getVersion(), channel: channelStore.get() });
  } finally {
    updateState.checking = false;
  }
}

/** 切换渠道：落盘 → 重建菜单（radio 勾选要跟着变）→ 通知界面重新检查 */
function setUpdateChannel(channel) {
  const c = channelStore.set(channel);
  // 放到下一个 tick 重建菜单：避免在菜单自身的事件处理里销毁当前菜单
  setImmediate(() => buildMenu());
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:channel', c);
  return c;
}

async function downloadUpdate(latest) {
  if (updateState.downloading) return { ok: false, error: '已有安装包正在下载' };
  updateState.downloading = true;
  updateState.abort = new AbortController();
  const notify = (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:progress', p);
  };
  try {
    return await update.downloadInstaller({ latest, dir: updateDir(latest.channel), signal: updateState.abort.signal, onProgress: notify });
  } finally {
    updateState.downloading = false;
    updateState.abort = null;
  }
}

/** 启动后静默探一次：有新版才提示，网络不通就一声不响（不打扰用户） */
async function silentCheckUpdate() {
  const r = await checkUpdate().catch(() => null);
  if (r && r.ok && r.updateAvailable && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:available', r);
  }
}

/* ---------------- IPC ---------------- */
function requireConfig() {
  if (configStore.isEmpty) throw new Error('尚未配置连接，请先在设置中填写');
  return configStore.data;
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    userData: app.getPath('userData'),
    configured: !configStore.isEmpty,
    updateBase: update.resolveBase(),
    updateChannel: channelStore.get(),
  }));

  ipcMain.handle('config:get', () => configStore.data);
  ipcMain.handle('config:save', (_e, partial) => {
    const cfg = configStore.save(partial || {});
    global.__qingCfg = cfg;
    return cfg;
  });
  ipcMain.handle('config:clear', () => {
    configStore.clear();
    global.__qingCfg = null;
    return { ok: true };
  });

  // 连接测试（使用传入配置，不落盘）
  ipcMain.handle('s3:test', async (_e, cfg) => s3.testConnection(cfg));

  // 分页列举：带游标 / 页大小 / 前缀搜索词，单次请求，不再一路翻到底
  ipcMain.handle('s3:list', async (_e, dir, opts) => {
    const cfg = requireConfig();
    const client = s3.createClient(cfg);
    const o = opts || {};
    // 带搜索词走大小写不敏感的多变体前缀查询；普通浏览还是原来的游标分页
    if (o.search) {
      return s3.searchDir(client, cfg, String(dir || ''), o.search, { perVariant: o.maxKeys });
    }
    return s3.listDir(client, cfg, String(dir || ''), o);
  });

  // 目录树只拉子目录，不拉文件
  ipcMain.handle('s3:listDirs', async (_e, dir) => {
    const cfg = requireConfig();
    const client = s3.createClient(cfg);
    return s3.listDirs(client, cfg, String(dir || ''));
  });

  // 界面状态（树宽度 / 折叠 / 展开节点）
  ipcMain.handle('uiState:get', () => uiStateStore.data);
  ipcMain.handle('uiState:save', (_e, partial) => uiStateStore.save(partial || {}));

  ipcMain.handle('s3:mkdir', async (_e, dir) => {
    const cfg = requireConfig();
    const client = s3.createClient(cfg);
    await s3.mkdir(client, cfg, String(dir || ''));
    return { ok: true };
  });

  ipcMain.handle('s3:delete', async (_e, entries) => {
    const cfg = requireConfig();
    const client = s3.createClient(cfg);
    let count = 0;
    for (const en of entries || []) {
      if (en.isDir) count += await s3.deleteDir(client, cfg, en.key);
      else count += await s3.deleteKeys(client, cfg, [en.key]);
    }
    return { ok: true, count };
  });

  // ---- 文件对话框 ----
  ipcMain.handle('dialog:pickFiles', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return { ok: false };
    return { ok: true, paths: res.filePaths };
  });

  ipcMain.handle('dialog:pickFolder', async (e, purpose) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: purpose === 'upload' ? '选择要上传的文件夹' : '选择保存位置',
      properties: ['openDirectory'],
    });
    if (res.canceled) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  });

  ipcMain.handle('shell:reveal', (_e, p) => {
    if (p && fs.existsSync(p)) shell.showItemInFolder(p);
    else shell.openPath(p || app.getPath('downloads'));
    return { ok: true };
  });

  // ---- 传输管理 ----
  const pathMod = path;

  ipcMain.handle('transfer:startUpload', (_e, { paths, targetDir, asFolder, rawEntries }) => {
    requireConfig();
    const entries = [];
    let name;
    if (rawEntries && rawEntries.length) {
      // 拖拽上传：调用方已给出 { abs, rel }（rel 为相对当前目录的路径）
      for (const it of rawEntries) entries.push({ abs: it.abs, rel: it.rel });
      name = `上传 ${entries.length} 个文件（拖拽）`;
    } else if (asFolder) {
      const root = paths[0];
      const base = pathMod.basename(root);
      const walk = (dir, relBase) => {
        for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = pathMod.join(dir, it.name);
          const rel = names.joinKey(relBase, it.name);
          if (it.isDirectory()) walk(abs, rel);
          else if (it.isFile()) entries.push({ abs, rel });
        }
      };
      walk(root, base);
      name = `上传文件夹 ${base}`;
    } else {
      for (const p of paths) entries.push({ abs: p, rel: pathMod.basename(p) });
      name = entries.length === 1 ? `上传 ${pathMod.basename(paths[0])}` : `上传 ${entries.length} 个文件`;
    }
    const dest = String(targetDir || '');
    const withDir = entries.map((it) => ({ abs: it.abs, rel: names.joinKey(dest, it.rel) }));
    return transfers.createTask('upload', name, withDir, dest);
  });

  ipcMain.handle('transfer:startDownload', (_e, { entries, dest }) => {
    requireConfig();
    const list = entries || [];
    const label = list.length === 1
      ? `下载 ${names.basename(list[0].key)}`
      : `下载 ${list.length} 项`;
    return transfers.createTask('download', label, list, dest);
  });

  ipcMain.handle('transfer:list', () => transfers.list());
  ipcMain.handle('transfer:cancel', (_e, id) => transfers.cancel(id));
  ipcMain.handle('transfer:clear', () => transfers.clearFinished());

  // ---- 更新 ----
  ipcMain.handle('update:info', () => ({
    base: update.resolveBase(),
    channel: channelStore.get(),
    channelLabel: update.CHANNEL_LABELS[channelStore.get()] || channelStore.get(),
    channels: [...update.CHANNELS],
    platform: update.platformTag(),
    arch: update.archTag(),
    current: app.getVersion(),
    dir: updateDir(),
  }));

  ipcMain.handle('update:check', () => checkUpdate());

  ipcMain.handle('update:channel', () => ({ channel: channelStore.get() }));

  // 「不再提醒此版本」：只记版本号，换版本自动重新提醒
  ipcMain.handle('update:muted', () => muteStore.get());
  ipcMain.handle('update:mute', (_e, version) => muteStore.set(version));
  ipcMain.handle('update:unmute', () => muteStore.clear());

  ipcMain.handle('update:setChannel', (_e, channel) => {
    try {
      return { ok: true, channel: setUpdateChannel(channel) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle('update:download', (_e, latest) => {
    if (!latest || !latest.downloadUrl) return { ok: false, error: '缺少安装包信息' };
    return downloadUpdate(latest);
  });

  ipcMain.handle('update:cancel', () => {
    if (updateState.abort) updateState.abort.abort();
    return { ok: true };
  });

  // 只允许启动「下载目录内」的安装包：渲染进程传来的路径属于不可信输入
  ipcMain.handle('update:install', async (_e, filePath) => {
    const root = path.resolve(updateRoot());
    const target = path.resolve(String(filePath || ''));
    const rel = path.relative(root, target);
    if (!target || rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, error: '安装包路径非法' };
    }
    if (!fs.existsSync(target)) return { ok: false, error: '安装包不存在，请重新下载' };
    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('update:reveal', (_e, filePath) => {
    const root = path.resolve(updateRoot());
    const target = path.resolve(String(filePath || ''));
    const rel = path.relative(root, target);
    if (!target || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: '路径非法' };
    if (fs.existsSync(target)) shell.showItemInFolder(target);
    else shell.openPath(root);
    return { ok: true };
  });
}

/* ---------------- 生命周期 ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    configStore.load();
    channelStore.load();
    muteStore.load();
    uiStateStore.load();
    global.__qingCfg = configStore.isEmpty ? null : configStore.data;
    registerAppProtocol();
    registerIpc();
    buildMenu();
    transfers.attachWindow(createWindow());
    // 启动后静默探一次更新（冒烟测试不联网）
    if (!SMOKE) setTimeout(() => { silentCheckUpdate(); }, 6000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) transfers.attachWindow(createWindow());
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
