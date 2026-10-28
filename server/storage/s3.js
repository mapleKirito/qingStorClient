'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { normalizeKey, normalizePrefix } = require('./index');

/**
 * S3 兼容对象存储驱动（SigV4 手写实现，零依赖）
 * =================================================================
 * 为什么不用 @aws-sdk/client-s3：
 *   本项目刻意保持零依赖（node:sqlite + 内置 http，`node server.js` 直接跑）。
 *   加 SDK 会带进十几个包、镜像大几十 MB，而这里需要的只是 4 次 HMAC 和一个
 *   预签名 GET。正确性用 AWS 官方测试向量验证即可，不需要把整套 SDK 搬进来。
 *
 * 兼容范围：青云 OBS / 阿里 OSS / MinIO / AWS S3 的 S3 兼容网关。
 *
 * -----------------------------------------------------------------
 * 三个必须记住的约束（都是实测出来的，不是推测）
 * -----------------------------------------------------------------
 * 1. endpoint 必须是 S3 协议入口（形如 https://s3.<region>.<vendor>）。
 *    厂商网页控制台里那种不带 s3 的域名是原生 API，只认自家签名格式，
 *    AWS SigV4 打过去直接 401。签名里的 Host 参与计算，也不能签完再换域名。
 *
 * 2. 默认 path-style（bucket 在路径里）。多数厂商的 S3 网关没有
 *    `<bucket>.s3.<region>.<vendor>` 的泛解析，virtual-host 风格 DNS 都解析不了。
 *
 * 3. 预签名只签 GET。该存储对匿名 HEAD 一律 403（连不存在的 key 也是 403），
 *    而 SigV4 签名绑定 HTTP method，GET 的签名不能用于 HEAD。
 *    => 下载侧的 HEAD 必须由服务端用本地库里的元信息自己回答，不 302。
 */

/* ------------------------------------------------------------------ *
 * SigV4 基础件
 * ------------------------------------------------------------------ */

/** RFC3986 编码：encodeURIComponent 放过 !'()*，而 SigV4 要求把它们编码掉 */
function encodeRfc3986(str) {
  return encodeURIComponent(String(str)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** 2026-10-28T07:49:53.123Z → 20261028T074953Z */
function toAmzDate(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secretKey, dateStamp, region) {
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

/** 参数名与值都编码后按名字典序拼接 —— 顺序错了签名必错 */
function canonicalQueryString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join('&');
}

function parseEndpoint(raw, varName) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new Error(`${varName} 不是合法 URL：${raw}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${varName} 只支持 http / https：${raw}`);
  }
  const basePath = u.pathname.replace(/\/+$/, '');
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || '',
    host: u.host, // 签名用的 Host，必须与实际请求头完全一致（含端口）
    basePath, // 少数私有部署会把 S3 挂在子路径下
    origin: `${u.protocol}//${u.host}${basePath}`,
  };
}

/* ------------------------------------------------------------------ *
 * 驱动实现
 * ------------------------------------------------------------------ */
module.exports = function createS3(cfg) {
  /* ---- 静态配置校验：配错就别启动，免得跑起来才发现全是 403 ---- */
  const bucket = String(cfg.bucket || '').trim();
  if (!bucket) throw new Error('STORAGE_DRIVER=s3 时必须配置 S3_BUCKET');

  const accessKey = String(cfg.accessKey || '').trim();
  const secretKey = String(cfg.secretKey || '').trim();
  if (!accessKey || !secretKey) {
    throw new Error('STORAGE_DRIVER=s3 时必须配置 S3_ACCESS_KEY 与 S3_SECRET_KEY');
  }

  const region = String(cfg.region || '').trim() || 'us-east-1';

  const endpoint = parseEndpoint(cfg.endpoint || '', 'S3_ENDPOINT');
  // 上传走 endpoint（可以是内网地址省流量），签下载地址走 publicEndpoint。
  // 两者 Host 不同时，预签名必须用 publicEndpoint 的 Host 参与计算，
  // 否则客户端拿到的是一个签名对不上公网 Host 的 URL。
  const publicEndpoint = String(cfg.publicEndpoint || '').trim()
    ? parseEndpoint(cfg.publicEndpoint, 'S3_PUBLIC_ENDPOINT')
    : endpoint;

  const prefix = normalizePrefix(cfg.prefix);
  const allowRoot = cfg.allowRoot === true || cfg.allowRoot === '1' || cfg.allowRoot === 1;
  if (!prefix && !allowRoot) {
    throw new Error('S3_PREFIX 不能为空。确实要写到 bucket 根，请显式设 S3_ALLOW_ROOT=1');
  }

  // 默认 path-style。virtual-host 需要 `<bucket>.<endpoint>` 有泛解析，
  // 大部分国内 S3 兼容网关没有，所以默认关掉。
  const pathStyle = cfg.forcePathStyle !== false && cfg.forcePathStyle !== 'false' && cfg.forcePathStyle !== 0;

  const signExpires = Math.min(Math.max(Number(cfg.signExpires || 300) || 300, 1), 604800);
  const timeoutMs = Math.min(Math.max(Number(cfg.timeoutMs || 120000) || 120000, 5000), 3600000);

  /**
   * 时钟注入点。生产永远走 Date.now()；
   * 唯一用途是拿 AWS 官方测试向量做签名校验（那里时间戳是固定的 20130524T000000Z）。
   */
  const nowFn = typeof cfg.now === 'function' ? cfg.now : () => new Date();

  /** 相对 key + 前缀 → 对象存储里的完整 key（前缀只在这里出现） */
  function fullKey(relKey) {
    const k = normalizeKey(relKey);
    return prefix ? `${prefix}/${k}` : k;
  }

  /** 完整 key → 已编码的请求路径（含 bucket，path-style） */
  function objectPath(completeKey) {
    const segs = completeKey.split('/').filter(Boolean).map(encodeRfc3986);
    if (pathStyle) return `${endpoint.basePath}/${encodeRfc3986(bucket)}/${segs.join('/')}`;
    return `${endpoint.basePath}/${segs.join('/')}`;
  }

  /** path-style 用 endpoint 的 Host；virtual-host 要把 bucket 前缀加上 */
  function requestHost(ep) {
    return pathStyle ? ep.host : `${bucket}.${ep.host}`;
  }

  /**
   * 对外可访问的基地址。
   * virtual-host 模式下 Host 里含 bucket，所以不能直接用 endpoint.origin，
   * 否则签出来的 URL 少了 bucket 前缀，虽然签名本身是对的，但访问到的是另一个对象。
   */
  function originOf(ep) {
    return `${ep.protocol}//${requestHost(ep)}`;
  }

  function buildUrl(ep, encodedPath) {
    return `${originOf(ep)}${encodedPath}`;
  }

  /** 底层请求：返回 { status, headers, body }，非 2xx 由调用方判定 */
  function send({ method, ep, encodedPath, headers, body, bodyStream }) {
    return new Promise((resolve, reject) => {
      const urlStr = buildUrl(ep, encodedPath);
      const lib = ep.protocol === 'https:' ? https : http;
      let req;
      try {
        req = lib.request(
          {
            protocol: ep.protocol,
            hostname: ep.hostname,
            port: ep.port || undefined,
            method,
            path: encodedPath, // 已编码，交给 http 原样发出，禁止二次编码
            headers,
            timeout: timeoutMs,
          },
          (res) => {
            // 错误体通常只有几百字节，读前 8KB 足够定位问题
            const chunks = [];
            let n = 0;
            res.on('data', (c) => {
              if (n < 8192) { chunks.push(c); n += c.length; }
            });
            res.on('end', () => {
              resolve({
                status: res.statusCode || 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
            res.on('error', reject);
          }
        );
      } catch (e) {
        return reject(e);
      }

      req.on('error', (e) => reject(new Error(`${method} ${urlStr} 失败：${e.message}`)));
      req.on('timeout', () => req.destroy(new Error(`${method} ${urlStr} 超时（${timeoutMs}ms 无数据）`)));

      if (bodyStream) {
        bodyStream.on('error', (e) => req.destroy(e));
        bodyStream.pipe(req);
      } else {
        req.end(body || undefined);
      }
    });
  }

  function describeTarget(res) {
    const peek = String(res.body || '').replace(/\s+/g, ' ').slice(0, 300);
    return `HTTP ${res.status}${peek ? ' · ' + peek : ''}`;
  }

  /* ---- 预签名 GET ---- */
  function signedUrl(relKey, opts) {
    const key = fullKey(relKey);
    const encodedPath = objectPath(key);
    const expires = Math.min(
      Math.max(Number((opts && opts.expires) || signExpires) || signExpires, 1),
      604800
    );

    const now = nowFn();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;

    const params = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${accessKey}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expires),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalQuery = canonicalQueryString(params);

    // 关键：这里用的 Host 必须是**客户端实际访问**的那个（publicEndpoint）
    const canonicalHeaders = `host:${requestHost(publicEndpoint)}\n`;
    const canonicalRequest = [
      'GET',
      encodedPath,
      canonicalQuery,
      canonicalHeaders,
      'host',
      'UNSIGNED-PAYLOAD', // 预签名不允许对 body 做哈希（客户端不会再发一次）
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = hmac(
      signingKey(secretKey, dateStamp, region),
      stringToSign
    ).toString('hex');

    return `${originOf(publicEndpoint)}${encodedPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  /* ---- PUT 的签名头（流式与 Buffer 共用） ---- */
  function putHeaders(relKey, size, payloadHash, contentType) {
    const key = fullKey(relKey);
    const encodedPath = objectPath(key);

    const now = nowFn();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const host = requestHost(endpoint);

    const headers = {
      host,
      'content-type': contentType,
      'content-length': String(size),
      'x-amz-content-sha256': payloadHash, // 整个 body 的 SHA256，必须真实
      'x-amz-date': amzDate,
    };

    // canonicalHeaders：名字小写并按字母序，值去首尾空格、内部连续空格压成一个
    const canonicalHeaders =
      `content-type:${contentType}\n` +
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT',
      encodedPath,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = hmac(
      signingKey(secretKey, dateStamp, region),
      stringToSign
    ).toString('hex');

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { encodedPath, headers };
  }

  /* ---- DELETE 的签名头 ---- */
  function deleteHeaders(relKey) {
    const key = fullKey(relKey);
    const encodedPath = objectPath(key);
    const emptyHash = sha256Hex('');

    const now = nowFn();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const host = requestHost(endpoint);

    const headers = {
      host,
      'x-amz-content-sha256': emptyHash,
      'x-amz-date': amzDate,
    };

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${emptyHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'DELETE',
      encodedPath,
      '',
      canonicalHeaders,
      signedHeaders,
      emptyHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = hmac(
      signingKey(secretKey, dateStamp, region),
      stringToSign
    ).toString('hex');

    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { encodedPath, headers };
  }

  return {
    name: 's3',

    /**
     * 上传临时文件。流式发送，不进内存 —— 300MB 的包不能整块读。
     * 调用方负责保证 meta.sha256 与文件内容一致：它既是校验值也是签名值。
     */
    async put(relKey, tmpFile, meta) {
      const m = meta || {};
      const st = fs.statSync(tmpFile);
      const size = Number.isFinite(m.size) ? m.size : st.size;
      if (size !== st.size) {
        throw new Error(`临时文件大小不一致（声明 ${size}，实际 ${st.size}）`);
      }
      const payloadHash = m.sha256 || sha256Hex(fs.readFileSync(tmpFile));
      const contentType = m.contentType || 'application/octet-stream';

      const { encodedPath, headers } = putHeaders(relKey, size, payloadHash, contentType);
      const res = await send({
        method: 'PUT',
        ep: endpoint,
        encodedPath,
        headers,
        bodyStream: fs.createReadStream(tmpFile),
      });

      if (res.status < 200 || res.status >= 300) {
        throw new Error('对象存储拒绝写入：' + describeTarget(res));
      }
      return { key: fullKey(relKey), size, etag: res.headers.etag || null };
    },

    signedUrl,

    async remove(relKey) {
      const { encodedPath, headers } = deleteHeaders(relKey);
      const res = await send({ method: 'DELETE', ep: endpoint, encodedPath, headers });
      // 404 表示对象本来就不在，删除的语义已经满足
      if (res.status >= 200 && res.status < 300) return true;
      if (res.status === 404) return true;
      throw new Error('对象存储拒绝删除：' + describeTarget(res));
    },

    describe() {
      return {
        driver: 's3',
        bucket,
        prefix: prefix || '(bucket 根)',
        endpoint: originOf(endpoint),
        publicEndpoint: originOf(publicEndpoint),
        region,
        pathStyle,
        signExpires,
      };
    },

    /**
     * 启动自检：真的写一个探针对象再删掉。
     * 只做 HeadBucket 是不够的 —— 很多配置只授了读权限，等到第一次上传安装包
     * 才 403，白等一次几百 MB。这里的判据就是「能不能写」。
     */
    async ready() {
      const probeKey = '.healthcheck';
      const body = Buffer.from(`qingstor-client-update ${Date.now()}`, 'utf8');
      try {
        const { encodedPath, headers } = putHeaders(probeKey, body.length, sha256Hex(body), 'text/plain');
        const put = await send({ method: 'PUT', ep: endpoint, encodedPath, headers, body });
        if (put.status < 200 || put.status >= 300) {
          return { ok: false, detail: '写入探针失败：' + describeTarget(put) };
        }
        try {
          await this.remove(probeKey);
        } catch {
          // 删不掉不影响服务可用性，只是留个几十字节的垃圾
        }
        return { ok: true, detail: `已写入探针 ${fullKey(probeKey)}` };
      } catch (e) {
        return { ok: false, detail: e.message };
      }
    },
  };
};
