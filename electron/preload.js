'use strict';

/** 预加载脚本：向渲染进程暴露最小化、语义清晰的 bridge API。 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  info: () => ipcRenderer.invoke('app:info'),

  /** 运行环境标记（冒烟测试用，正常启动为 false） */
  env: { smoke: process.env.QINGSTOR_SMOKE === '1' },

  /** 拖拽上传时把 File 对象转换为本地绝对路径 */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (partial) => ipcRenderer.invoke('config:save', partial),
    clear: () => ipcRenderer.invoke('config:clear'),
  },

  s3: {
    test: (cfg) => ipcRenderer.invoke('s3:test', cfg),
    list: (dir, opts) => ipcRenderer.invoke('s3:list', dir, opts),
    listDirs: (dir) => ipcRenderer.invoke('s3:listDirs', dir),
    mkdir: (dir) => ipcRenderer.invoke('s3:mkdir', dir),
    remove: (entries) => ipcRenderer.invoke('s3:delete', entries),
  },

  uiState: {
    get: () => ipcRenderer.invoke('uiState:get'),
    save: (partial) => ipcRenderer.invoke('uiState:save', partial),
  },

  dialog: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    pickFolder: (purpose) => ipcRenderer.invoke('dialog:pickFolder', purpose),
  },

  shell: {
    reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  },

  transfer: {
    startUpload: (payload) => ipcRenderer.invoke('transfer:startUpload', payload),
    startDownload: (payload) => ipcRenderer.invoke('transfer:startDownload', payload),
    list: () => ipcRenderer.invoke('transfer:list'),
    cancel: (id) => ipcRenderer.invoke('transfer:cancel', id),
    clear: () => ipcRenderer.invoke('transfer:clear'),
    onUpdate: (handler) => {
      const listener = (_e, task) => handler(task);
      ipcRenderer.on('transfer:update', listener);
      return () => ipcRenderer.removeListener('transfer:update', listener);
    },
  },

  update: {
    info: () => ipcRenderer.invoke('update:info'),
    check: () => ipcRenderer.invoke('update:check'),
    channel: () => ipcRenderer.invoke('update:channel'),
    setChannel: (channel) => ipcRenderer.invoke('update:setChannel', channel),
    mutedVersion: () => ipcRenderer.invoke('update:muted'),
    muteVersion: (version) => ipcRenderer.invoke('update:mute', version),
    unmute: () => ipcRenderer.invoke('update:unmute'),
    download: (latest) => ipcRenderer.invoke('update:download', latest),
    cancel: () => ipcRenderer.invoke('update:cancel'),
    install: (filePath) => ipcRenderer.invoke('update:install', filePath),
    reveal: (filePath) => ipcRenderer.invoke('update:reveal', filePath),
    onProgress: (handler) => {
      const listener = (_e, p) => handler(p);
      ipcRenderer.on('update:progress', listener);
      return () => ipcRenderer.removeListener('update:progress', listener);
    },
    onAvailable: (handler) => {
      const listener = (_e, r) => handler(r);
      ipcRenderer.on('update:available', listener);
      return () => ipcRenderer.removeListener('update:available', listener);
    },
    onChannel: (handler) => {
      const listener = (_e, channel) => handler(channel);
      ipcRenderer.on('update:channel', listener);
      return () => ipcRenderer.removeListener('update:channel', listener);
    },
  },

  onMenu: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
