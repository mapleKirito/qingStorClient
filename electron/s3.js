'use strict';

/**
 * S3 兼容存储客户端封装（青云对象存储走 S3 协议，path-style 寻址）。
 * 全部操作在主进程执行，渲染进程通过 IPC 调用。
 */

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {
  S3Client,
  ListObjectsV2Command,
  HeadBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const names = require('./names');

/** 根据配置创建 S3Client。 */
function createClient(cfg) {
  const endpoint = String(cfg.endpoint || '').trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error('Endpoint 必须以 http:// 或 https:// 开头');
  }
  const requestHandler = cfg.verifySSL === false
    ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) }
    : undefined;
  return new S3Client({
    endpoint,
    region: cfg.region || 'us-east-1',
    credentials: { accessKeyId: cfg.accessKey || '', secretAccessKey: cfg.secretKey || '' },
    forcePathStyle: true,
    requestHandler,
  });
}

/** 规范化 S3 错误信息。 */
function errMsg(e) {
  const meta = e && e.$metadata ? ` (HTTP ${e.$metadata.httpStatusCode})` : '';
  const name = e && e.name ? e.name + ': ' : '';
  return name + (e && e.message ? e.message : String(e)) + meta;
}

/** 测试连接：HeadBucket，失败时退回 ListObjectsV2 以给出更明确的错误。 */
async function testConnection(cfg) {
  const client = createClient(cfg);
  try {
    await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    return { ok: true, message: '连接成功' };
  } catch (headErr) {
    // 某些兼容实现不支持 HeadBucket（405/501），用列举兜底验证凭据
    try {
      const res = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
      const withPrefix = cfg.prefix ? `（前缀 ${cfg.prefix}）` : '';
      return { ok: true, message: `连接成功${withPrefix}，桶内对象 ${res.KeyCount ?? 0}+` };
    } catch (listErr) {
      return { ok: false, message: errMsg(listErr.name === 'NotFound' ? headErr : listErr) };
    }
  }
}

/**
 * 列举一个「目录」的**一页**（游标分页）。
 *
 * 返回 { dirs: [{name, key, dir}], files: [{name, key, size, mtime}], truncated, nextToken }
 *
 * 为什么必须分页：ListObjectsV2 一次最多 1000 条，旧实现 do...while 一路翻到底，
 * 10 万对象的目录要发上百次请求；现在只发一次，翻页由调用方带着 nextToken 继续。
 * S3 没有偏移量，只能「下一页」，后退靠调用方缓存已取到的页。
 *
 * search 走服务端 Prefix（等价 LIKE '关键词%'）：能命中尚未加载的页，零内存成本，
 * 但**搜不到名字中间包含关键词的对象** —— S3 协议本身不提供该能力。
 */
async function listDir(client, cfg, dir, { token, maxKeys = 200, search = '' } = {}) {
  const base = names.dirKey(cfg.prefix);
  const dirPrefix = base + names.dirKey(dir); // dir 为相对路径（'' 表示根）
  const keyword = String(search || '').trim();
  const prefix = keyword ? dirPrefix + keyword : dirPrefix;
  const limit = Math.min(1000, Math.max(1, Math.round(Number(maxKeys) || 200)));

  const res = await client.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: prefix,
    Delimiter: '/',
    MaxKeys: limit,
    ContinuationToken: token || undefined,
  }));

  const dirs = [];
  for (const cp of res.CommonPrefixes || []) {
    const rel = names.stripPrefix(cp.Prefix, cfg.prefix).replace(/\/+$/, '');
    const name = names.basename(rel);
    if (name) dirs.push({ name, key: rel, dir: true });
  }

  const files = [];
  for (const obj of res.Contents || []) {
    if (obj.Key === prefix) continue; // 目录占位对象自身
    const rel = names.stripPrefix(obj.Key, cfg.prefix);
    if (rel === '' || rel.endsWith('/')) continue;
    const name = names.basename(rel);
    if (!name) continue;
    files.push({
      name,
      key: rel,
      size: obj.Size || 0,
      mtime: obj.LastModified ? obj.LastModified.toISOString() : '',
    });
  }

  const sortName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  return {
    dirs: dirs.sort(sortName),
    files: files.sort(sortName),
    truncated: !!res.IsTruncated,
    nextToken: res.IsTruncated ? (res.NextContinuationToken || '') : '',
  };
}

/**
 * 前缀搜索（严格遵循 S3 的 Prefix 语义）。
 *
 * S3 的 Prefix 是**字节精确**匹配，接口没有 case-insensitive 开关。曾经用「原样/全小写/
 * 全大写/首字母大写」四个变体并发绕过，但只要服务的实际行为与假设有偏差，就会出现
 * 「看起来能搜到一半、另一半搜不到」这种更难解释的结果，而且请求量翻倍。既然接口本身
 * 不支持，就不在客户端造兼容：`zj` 只匹配 `zj`，不匹配 `ZJ` / `Zj`。
 *
 * 与 listDir 的区别：
 * - 不分页。一次最多取 maxKeys 条，搜索本来就该靠加长前缀收窄，而不是翻页；
 *   返回的 nextToken 恒为空，由渲染层把分页条收起来。
 * - 命中范围就是「当前目录下以关键词开头的项」，不做二次过滤（Prefix 已经把范围收窄，
 *   再按 name 复核只会把关键词含 / 的跨层查询误杀）。
 */
async function searchDir(client, cfg, dir, keyword, { maxKeys = 200 } = {}) {
  const base = names.dirKey(cfg.prefix);
  const dirPrefix = base + names.dirKey(dir);
  const kw = String(keyword || '').trim();
  const limit = Math.min(1000, Math.max(1, Math.round(Number(maxKeys) || 200)));

  const res = await client.send(new ListObjectsV2Command({
    Bucket: cfg.bucket,
    Prefix: dirPrefix + kw,
    Delimiter: '/',
    MaxKeys: limit,
  }));

  const dirs = [];
  const files = [];
  for (const cp of res.CommonPrefixes || []) {
    const rel = names.stripPrefix(cp.Prefix, cfg.prefix).replace(/\/+$/, '');
    const name = names.basename(rel);
    if (name) dirs.push({ name, key: rel, dir: true });
  }
  for (const obj of res.Contents || []) {
    const rel = names.stripPrefix(obj.Key, cfg.prefix);
    if (rel === '' || rel.endsWith('/')) continue;
    const name = names.basename(rel);
    if (!name) continue;
    files.push({
      name,
      key: rel,
      size: obj.Size || 0,
      mtime: obj.LastModified ? obj.LastModified.toISOString() : '',
    });
  }

  const sortName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  return {
    dirs: dirs.sort(sortName),
    files: files.sort(sortName),
    truncated: !!res.IsTruncated,
    nextToken: '',
  };
}

/**
 * 只列举子目录（供左侧目录树使用）。
 * 不返回文件 —— 树只需要一层目录名，把文件也拉回来在万级目录下是纯浪费。
 * 单层目录超过 maxKeys 时置 truncated，由调用方决定怎么提示。
 */
async function listDirs(client, cfg, dir, { maxKeys = 500 } = {}) {
  const prefix = names.dirKey(cfg.prefix) + names.dirKey(dir);
  const dirs = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: token,
      MaxKeys: maxKeys,
    }));
    for (const cp of res.CommonPrefixes || []) {
      const rel = names.stripPrefix(cp.Prefix, cfg.prefix).replace(/\/+$/, '');
      const name = names.basename(rel);
      if (name) dirs.push({ name, key: rel });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token && dirs.length < maxKeys);

  const sortName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  return { dirs: dirs.sort(sortName), truncated: !!token || dirs.length > maxKeys };
}

/** 递归列举前缀下所有对象 key（相对 basePrefix），用于文件夹删除/统计。 */
async function listAll(client, cfg, dir) {
  const prefix = names.dirKey(cfg.prefix) + names.dirKey(dir);
  const keys = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const obj of res.Contents || []) keys.push(names.stripPrefix(obj.Key, cfg.prefix));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** 批量删除（每批最多 1000 个）。 */
async function deleteKeys(client, cfg, keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((k) => ({ Key: names.addPrefix(k, cfg.prefix) }));
    if (!batch.length) continue;
    await client.send(new DeleteObjectsCommand({ Bucket: cfg.bucket, Delete: { Objects: batch, Quiet: true } }));
  }
  return keys.length;
}

/** 删除目录（含占位符）与其下全部对象。 */
async function deleteDir(client, cfg, dir) {
  const keys = await listAll(client, cfg, dir);
  keys.push(dir); // 目录占位符本身
  return deleteKeys(client, cfg, keys);
}

/** 新建目录：写入零字节占位对象。 */
async function mkdir(client, cfg, dir) {
  const key = names.dirKey(cfg.prefix) + names.dirKey(dir);
  if (!key) return;
  await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: '' }));
}

/**
 * 上传单个文件（lib-storage 分片，支持进度与取消）。
 * rel 为相对 basePrefix 的目标 key；localPath 为本地文件。
 */
async function uploadFile(client, cfg, localPath, rel, { onProgress, signal } = {}) {
  const key = names.addPrefix(rel, cfg.prefix);
  const stat = await fs.promises.stat(localPath);
  const body = fs.createReadStream(localPath);
  const upload = new Upload({
    client,
    params: { Bucket: cfg.bucket, Key: key, Body: body },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
  });
  if (signal) {
    signal.addEventListener('abort', () => upload.abort(), { once: true });
  }
  if (onProgress) {
    upload.on('httpUploadProgress', (p) => {
      onProgress({ loaded: p.loaded ?? 0, total: stat.size });
    });
  }
  await upload.done();
  return { key: rel, size: stat.size };
}

/** 下载单个对象到本地文件（流式，支持进度与取消）。 */
async function downloadFile(client, cfg, rel, localPath, { onProgress, signal } = {}) {
  const key = names.addPrefix(rel, cfg.prefix);
  const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), {
    abortSignal: signal,
  });
  const total = res.ContentLength ?? 0;
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  const out = fs.createWriteStream(localPath);
  let loaded = 0;
  let lastEmit = 0;
  await new Promise((resolve, reject) => {
    res.Body.on('data', (chunk) => {
      loaded += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastEmit > 120) {
        lastEmit = now;
        onProgress({ loaded, total });
      }
    });
    res.Body.pipe(out);
    res.Body.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
  if (onProgress) onProgress({ loaded, total });
  return { key: rel, path: localPath, size: loaded };
}

module.exports = {
  createClient,
  testConnection,
  listDir,
  searchDir,
  listDirs,
  listAll,
  deleteKeys,
  deleteDir,
  mkdir,
  uploadFile,
  downloadFile,
  errMsg,
};
