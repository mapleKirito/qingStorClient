'use strict';

/** 预加载脚本：向渲染进程暴露最小化、语义清晰的 bridge API。 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  info: () => ipcRenderer.invoke('app:info'),

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
    list: (dir) => ipcRenderer.invoke('s3:list', dir),
    mkdir: (dir) => ipcRenderer.invoke('s3:mkdir', dir),
    remove: (entries) => ipcRenderer.invoke('s3:delete', entries),
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

  onMenu: (handler) => {
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
