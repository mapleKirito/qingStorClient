'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeKey } = require('./index');

/**
 * 本地文件驱动 —— 行为与 1.2.0 及更早版本完全一致。
 *
 * 目录结构：$RELEASES_DIR/<channel>/<version>/<file>
 * 库里存的 key 用正斜杠，这里再用 path.resolve 落到宿主文件系统，
 * Windows 上也认 `/`，所以两种平台共用同一份库。
 */
module.exports = function createLocal(opts) {
  const releasesDir = path.resolve(opts.releasesDir);

  function absFor(relKey) {
    const key = normalizeKey(relKey);
    const abs = path.resolve(releasesDir, key);
    // 双保险：即使传入被污染的 key，也不允许读到 RELEASES_DIR 之外
    if (abs !== releasesDir && !abs.startsWith(releasesDir + path.sep)) {
      throw new Error('存储 key 逃出了安装包目录：' + relKey);
    }
    return abs;
  }

  return {
    name: 'local',

    /**
     * 把临时文件搬到最终位置。
     * 同盘时 rename 是原子的且不产生额外 IO；跨盘（DATA_DIR 挂在别的卷上）
     * 会 EXDEV，退回 copy + 让调用方删临时文件。
     */
    async put(relKey, tmpFile /*, meta */) {
      const abs = absFor(relKey);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      try {
        fs.renameSync(tmpFile, abs);
      } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(tmpFile, abs);
        try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
      }
      return { key: normalizeKey(relKey), size: fs.statSync(abs).size };
    },

    /** 本地模式没有「临时地址」这个概念，由调用方走流式返回 */
    signedUrl() {
      return null;
    },

    /** 本地模式不能浏览器直传，前端据此回落到「先传到服务器」的老路径 */
    signedPutUrl() {
      return null;
    },

    async stat(relKey) {
      try {
        return { size: fs.statSync(absFor(relKey)).size };
      } catch {
        return null;
      }
    },

    /**
     * 本地文件回读校验。中转上传时 sha256 是边收边算的，用不到这个；
     * 它存在是为了让两个驱动在「重新计算校验值」这件事上接口一致。
     */
    async sha256Of(relKey) {
      const abs = absFor(relKey);
      const hash = crypto.createHash('sha256');
      let size = 0;
      for await (const chunk of fs.createReadStream(abs)) {
        size += chunk.length;
        hash.update(chunk);
      }
      return { sha256: hash.digest('hex'), size };
    },

    async remove(relKey) {
      const abs = absFor(relKey);
      try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
      // 顺手清掉空掉的版本目录；非空或不存在都算正常
      try { fs.rmdirSync(path.dirname(abs)); } catch { /* ignore */ }
      return true;
    },

    describe() {
      return { driver: 'local', root: releasesDir };
    },

    async ready() {
      try {
        fs.mkdirSync(releasesDir, { recursive: true });
        fs.accessSync(releasesDir, fs.constants.W_OK);
        return { ok: true, detail: '目录可写' };
      } catch (e) {
        return { ok: false, detail: '目录不可写：' + e.message };
      }
    },
  };
};
