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
 * 列举一个「目录」。
 * 返回 { dirs: [{name, key}], files: [{name, key, size, mtime}] }，均为相对 basePrefix 的路径。
 */
async function listDir(client, cfg, dir) {
  const base = names.dirKey(cfg.prefix);
  const prefix = base + names.dirKey(dir); // dir 为相对路径（'' 表示根）
  const dirs = new Map();
  const files = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const cp of res.CommonPrefixes || []) {
      const rel = names.stripPrefix(cp.Prefix, cfg.prefix).replace(/\/+$/, '');
      const name = names.basename(rel);
      if (name) dirs.set(rel, { name, key: rel, dir: true });
    }
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
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  const sortName = (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN');
  return { dirs: [...dirs.values()].sort(sortName), files: files.sort(sortName) };
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
  listAll,
  deleteKeys,
  deleteDir,
  mkdir,
  uploadFile,
  downloadFile,
  errMsg,
};
