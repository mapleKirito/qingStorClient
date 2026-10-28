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

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (SMOKE) {
      // 冒烟：收集渲染进程错误，2 秒后按有无错误决定退出码
      const errors = [];
      mainWindow.webContents.on('console-message', (_e, level, message) => {
        if (level >= 2) errors.push(message);
      });
      mainWindow.webContents.on('render-process-gone', () => errors.push('renderer gone'));
      mainWindow.webContents.on('did-fail-load', (_e, code, desc) => errors.push(`load failed: ${code} ${desc}`));
      setTimeout(() => {
        if (errors.length) {
          console.error('SMOKE_ERRORS:\n' + errors.join('\n'));
          app.exit(1);
        } else {
          console.log('SMOKE_OK');
          app.exit(0);
        }
      }, 2500);
    }
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

  ipcMain.handle('s3:list', async (_e, dir) => {
    const cfg = requireConfig();
    const client = s3.createClient(cfg);
    return s3.listDir(client, cfg, String(dir || ''));
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
