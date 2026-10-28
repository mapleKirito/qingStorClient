'use strict';

/**
 * 存储适配层
 * =================================================================
 * 这里的边界只有一句话：**业务层只知道「相对 key」，不知道存储在哪**。
 *
 *   库里 releases.file_path 永远存相对 key，例如
 *     stable/2.0.1/QingStorClient-Setup-2.0.1-x64.exe
 *
 *   local 驱动把它解析成  $RELEASES_DIR/stable/2.0.1/xxx.exe
 *   s3    驱动把它拼成    s3://<bucket>/<S3_PREFIX>/stable/2.0.1/xxx.exe
 *
 * 前缀只存在于 s3 驱动内部，业务代码拿不到完整 key，也就没有机会漏加前缀。
 * 换 bucket / 换前缀 / 换服务商时，数据库一个字节都不用改，把对象搬过去即可。
 * -----------------------------------------------------------------
 * 统一接口（local 不支持的返回 null / 空实现，由调用方降级）：
 *
 *   name                                'local' | 's3'
 *   put(relKey, absTmpFile, meta)        落地文件，成功后 relKey 可被读取
 *   signedUrl(relKey, opts)              临时下载地址；local 返回 null
 *   remove(relKey)                       删除，不存在不算失败
 *   describe()                           给 health / 管理端看的非敏感信息
 *   ready()                              启动自检，返回 { ok, detail }
 */

/**
 * 相对 key 规范化 + 安全校验。
 *
 * 两件事必须在这里兜住，否则后面全是坑：
 *   1. Windows 上 path.join 会产出反斜杠，写进库再拿到 Linux 容器里就永远 404；
 *   2. key 里出现 `..` 就能逃出存储根（本地逃目录、对象存储写到别人前缀）。
 */
function normalizeKey(input) {
  let key = String(input || '').replace(/\\/g, '/').trim();

  if (!key) throw new Error('存储 key 不能为空');
  if (key.startsWith('/')) throw new Error('存储 key 不能是绝对路径：' + key);
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error('存储 key 含控制字符');

  // 合并连续斜杠、去掉尾部斜杠；保留中间层级
  key = key.replace(/\/{2,}/g, '/').replace(/\/+$/, '');

  for (const seg of key.split('/')) {
    if (seg === '' ) continue;
    if (seg === '.' || seg === '..') throw new Error('存储 key 不能包含 . 或 .. 段：' + key);
  }
  return key;
}

/**
 * 存储前缀规范化。与 key 的区别：允许为空（表示直接用 bucket 根），
 * 但为空必须显式声明，见 s3.js 里的 allowRoot。
 */
function normalizePrefix(input) {
  let p = String(input == null ? '' : input).replace(/\\/g, '/').trim();
  if (!p) return '';
  if (/[\u0000-\u001f\u007f]/.test(p)) throw new Error('S3_PREFIX 含控制字符');
  p = p.replace(/\/{2,}/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  for (const seg of p.split('/')) {
    if (seg === '.' || seg === '..') {
      throw new Error('S3_PREFIX 不能包含 . 或 .. 段：' + p);
    }
  }
  return p;
}

function createStorage(opts) {
  const driver = String((opts && opts.driver) || 'local').trim().toLowerCase();
  if (driver === 'local') {
    return require('./local')({ releasesDir: opts.releasesDir });
  }
  if (driver === 's3') {
    return require('./s3')(opts.s3 || {});
  }
  throw new Error(`不支持的 STORAGE_DRIVER：${driver}（只支持 local / s3）`);
}

module.exports = { createStorage, normalizeKey, normalizePrefix };
