'use strict';

/**
 * 传输管理器：上传/下载任务队列（后台异步执行，不阻塞界面）。
 * - 最多并发 2 个任务，任务内文件顺序传输；
 * - 进度通过 'transfer:update' 推送给渲染进程；
 * - 支持取消、清理已完成任务。
 */

const fs = require('node:fs');
const path = require('node:path');
const names = require('./names');
const s3 = require('./s3');

const MAX_CONCURRENT = 2;
const EMIT_INTERVAL = 150;

let nextId = 1;

class TransferManager {
  constructor() {
    this.tasks = new Map(); // id -> task
    this.win = null; // BrowserWindow，用于推送进度
  }

  attachWindow(win) {
    this.win = win;
  }

  emit(task) {
    // 进行中状态节流推送，终态立即推送
    const now = Date.now();
    if (['running', 'queued', 'cancelling'].includes(task.status)) {
      if (task._lastEmit && now - task._lastEmit < EMIT_INTERVAL) return;
      task._lastEmit = now;
    } else {
      task._lastEmit = 0;
    }
    if (!this.win || this.win.isDestroyed()) return;
    this.win.webContents.send('transfer:update', this.snapshot(task));
  }

  snapshot(task) {
    const { id, type, name, status, filesDone, filesTotal, bytesLoaded, bytesTotal, current, error, createdAt } = task;
    const pct = bytesTotal > 0
      ? Math.min(100, Math.round((bytesLoaded / bytesTotal) * 100))
      : filesTotal > 0
        ? Math.round((filesDone / filesTotal) * 100)
        : status === 'done' ? 100 : 0;
    return { id, type, name, status, filesDone, filesTotal, bytesLoaded, bytesTotal, current, error, createdAt, pct };
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt).map((t) => this.snapshot(t));
  }

  /** 递归收集本地目录下所有文件（返回 {abs, rel} 列表）。 */
  walkLocal(rootDir) {
    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile()) out.push({ abs, rel: path.relative(rootDir, abs).replace(/\\/g, '/') });
      }
    };
    walk(rootDir);
    return out;
  }

  createTask(type, name, entries, dest) {
    const task = {
      id: nextId++,
      type, // 'upload' | 'download'
      name,
      status: 'queued',
      entries, // [{local?, key?, rel?}] 具体语义见 run
      dest,
      filesDone: 0,
      filesTotal: entries.length,
      bytesLoaded: 0,
      bytesTotal: 0,
      current: '',
      error: '',
      controllers: [],
      createdAt: Date.now(),
    };
    this.tasks.set(task.id, task);
    this.emit(task);
    this.pump();
    return this.snapshot(task);
  }

  pump() {
    const running = [...this.tasks.values()].filter((t) => t.status === 'running').length;
    let slots = MAX_CONCURRENT - running;
    for (const t of this.tasks.values()) {
      if (slots <= 0) break;
      if (t.status === 'queued') {
        t.status = 'running';
        slots--;
        this.emit(t);
        this.run(t).catch(() => { /* run 内部已处理 */ });
      }
    }
  }

  async run(task) {
    const client = s3.createClient(global.__qingCfg);
    try {
      if (task.type === 'upload') await this.runUpload(task, client);
      else await this.runDownload(task, client);
      if (task.status === 'running') {
        task.status = 'done';
        task.current = '';
        this.emit(task);
      }
    } catch (e) {
      if (task.status === 'cancelling' || e.name === 'AbortError' || /aborted/i.test(e.message || '')) {
        task.status = 'cancelled';
      } else {
        task.status = 'error';
        task.error = s3.errMsg(e);
      }
      task.current = '';
      this.emit(task);
    } finally {
      task.controllers = [];
      this.pump();
    }
  }

  async runUpload(task, client) {
    for (const item of task.entries) {
      if (task.status !== 'running') return;
      // item: { abs, rel } rel 为相对目标目录的 key
      const stat = await fs.promises.stat(item.abs);
      task.bytesTotal += stat.size;
      task.current = item.rel;
      this.emit(task);
      const ctrl = new AbortController();
      task.controllers.push(ctrl);
      await s3.uploadFile(client, global.__qingCfg, item.abs, item.rel, {
        signal: ctrl.signal,
        onProgress: ({ loaded }) => {
          // 以「当前文件已完成字节」叠加其余文件体量，避免重复计数
          task.bytesLoaded = task.bytesTotal - stat.size + loaded;
          this.emit(task);
        },
      });
      task.filesDone++;
      task.bytesLoaded = task.bytesTotal;
      this.emit(task);
    }
  }

  async runDownload(task, client) {
    // task.entries: [{ key, isDir }]；dest 为本地目标目录
    const files = [];
    for (const entry of task.entries) {
      if (entry.isDir) {
        const keys = await s3.listAll(client, global.__qingCfg, entry.key);
        for (const k of keys) {
          if (k !== '' && !k.endsWith('/')) files.push(k);
        }
      } else {
        files.push(entry.key);
      }
    }
    task.filesTotal = Math.max(files.length, 1);
    this.emit(task);

    for (const rel of files) {
      if (task.status !== 'running') return;
      const localPath = names.keyToLocalPath(rel, task.dest);
      task.current = names.basename(rel);
      this.emit(task);
      const ctrl = new AbortController();
      task.controllers.push(ctrl);
      const before = task.bytesLoaded;
      await s3.downloadFile(client, global.__qingCfg, rel, localPath, {
        signal: ctrl.signal,
        onProgress: ({ loaded }) => {
          task.bytesLoaded = before + loaded;
          this.emit(task);
        },
      });
      task.filesDone++;
      this.emit(task);
    }
  }

  cancel(id) {
    const task = this.tasks.get(id);
    if (!task) return { ok: false };
    if (task.status === 'running') {
      task.status = 'cancelling';
      for (const c of task.controllers) {
        try { c.abort(); } catch { /* 忽略 */ }
      }
    } else if (task.status === 'queued') {
      task.status = 'cancelled';
      this.emit(task);
    }
    return { ok: true };
  }

  clearFinished() {
    const removed = [];
    for (const [id, t] of this.tasks) {
      if (['done', 'error', 'cancelled'].includes(t.status)) {
        removed.push(id);
        this.tasks.delete(id);
      }
    }
    return { ok: true, removed: removed.length };
  }
}

module.exports = { TransferManager };
