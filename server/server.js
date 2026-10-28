#!/usr/bin/env node
'use strict';

/**
 * qingStorClient 版本更新服务
 * =================================================================
 * 职责边界（重要）：
 *   ✅ 保存「客户端安装包」元信息与文件本体，对外提供「查最新版 + 下载」两个只读接口
 *   ✅ 提供一个仅本机可访问的管理页（上传 / 列表 / 删除）
 *   ❌ 不同步用户配置，不做账号体系，不代理任何第三方请求
 *
 * -----------------------------------------------------------------
 * 为什么是两个监听端口，而不是一个端口靠路径区分
 * -----------------------------------------------------------------
 * 单端口方案只能靠「判断访问来源 IP 是否回环」来挡管理端：一旦套了 nginx，
 * 所有请求的来源都变成 127.0.0.1，这道判断直接失效，管理端等于裸奔。
 *
 * 所以这里拆成两个独立的 HTTP server：
 *
 *   ┌─ 公网侧（8000/8787）  HOST:PORT
 *   │    只认 /、/api/health、/api/releases/latest、/api/releases/download/:id
 *   │    其余路径（含 /admin、/api/admin/*）一律 404，连存在性都不暴露
 *   │    由 nginx 反代并终止 HTTPS，这就是「对外只暴露更新 API」
 *   │
 *   └─ 管理侧（8788）        ADMIN_HOST:ADMIN_PORT，默认 127.0.0.1
 *        只认 /、/admin、/api/admin/*
 *        绑定在回环地址上 ⇒ 公网、内网、nginx 全都连不上，
 *        唯一入口是 SSH 隧道（见 deploy/README.md）
 *
 * 这是把「对外暴露面」从「靠配置约束」变成「靠 socket 绑定约束」——
 * 配错 nginx 也不会漏，因为那个端口在公网上根本不存在。
 *
 * -----------------------------------------------------------------
 * 环境变量
 * -----------------------------------------------------------------
 * 基本
 *   PORT              公网侧端口，默认 8787
 *   HOST              公网侧绑定地址，默认 0.0.0.0
 *   DATA_DIR          数据根目录，默认 ./data（库、安装包、令牌都在里面）
 *   DB_FILE           数据库文件，默认 $DATA_DIR/releases.db
 *   RELEASES_DIR      安装包目录，默认 $DATA_DIR/releases
 *   PUBLIC_ORIGIN     对外访问前缀（如 https://update.example.com）；
 *                     填了以后 latest 接口返回的 downloadUrl 是绝对地址
 *   TRUST_PROXY       默认 0。部署在 nginx 后面时设 1，否则统计到的
 *                     全是 127.0.0.1，按 IP 限流会把所有人算成同一个
 *
 * 发布
 *   RELEASE_MAX_MB    单包上限（MB），默认 300
 *   RELEASE_CHANNEL   默认渠道，默认 stable
 *
 * 存储
 *   STORAGE_DRIVER    local（默认）| s3。决定**新发布**的包写到哪里；
 *                     存量记录按各自行里的 storage 字段读，不受切换影响
 *   RELEASES_DIR      local 驱动的根目录，默认 $DATA_DIR/releases
 *   S3_ENDPOINT       S3 协议入口，形如 https://s3.<region>.<vendor>
 *                     ⚠ 必须是带 s3 的那个域名；厂商控制台里不带 s3 的原生域名
 *                       只认自家签名格式，AWS SigV4 打过去直接 401
 *   S3_PUBLIC_ENDPOINT 可选。签发下载地址用的公网入口，留空复用 S3_ENDPOINT。
 *                     仅当上传走内网地址、下载需要公网域名时才需要分开配
 *   S3_BUCKET         必填
 *   S3_PREFIX         相对 bucket 的公共前缀，默认要求非空（如 qingstorclient/releases）。
 *                     想让对象落在 bucket 根必须同时设 S3_ALLOW_ROOT=1
 *   S3_REGION         默认 us-east-1。厂商若是自定义 region（如 zw2）照填
 *   S3_ACCESS_KEY / S3_SECRET_KEY   必填
 *   S3_FORCE_PATH_STYLE  默认 true。bucket 出现在路径里；多数国内 S3 网关
 *                        没有 <bucket>.<endpoint> 的泛解析，不能关
 *   S3_SIGN_EXPIRES   预签名有效期（秒），默认 300
 *
 * 管理端
 *   ADMIN_HOST        默认 127.0.0.1。改成 0.0.0.0 会让管理端暴露到网络，
 *                     此时仍有「来源必须是回环 / 受信网段」这道兜底，但强烈不建议改
 *   ADMIN_PORT        默认 8788
 *   ADMIN_TOKEN       显式指定管理令牌
 *   ADMIN_TOKEN_FILE  令牌落盘位置，默认 $DATA_DIR/admin-token.txt（权限 0600）
 *   ADMIN_DISABLED    设 1 则整个管理侧不启动
 *   ADMIN_ALLOW_CIDR  容器部署时用：额外受信网段，逗号分隔（如 172.16.0.0/12）。
 *                     前提是宿主机只把管理端口发布到 127.0.0.1，见 docker-compose.yml
 *
 * 另外：管理侧会拒绝任何带 X-Forwarded-* / X-Real-IP 的请求 —— nginx 转发的
 * 请求必然带这些头，SSH 隧道直连的浏览器不会。所以哪怕有人图省事给 nginx 加了
 * 一条 /admin 的 location，那条路也进不来。
 *
 * 技术上零外部依赖：数据库用 Node 内置 node:sqlite，HTTP 用内置 http，
 * 直接 `node server.js` 就能跑，不需要 npm install。
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createStorage } = require('./storage');

/**
 * 服务端版本号唯一来源是 server/package.json。
 * 不在代码里硬编码字符串 —— 那会和 package.json 各写各的，
 * 最后 /api/health 显示的版本跟仓库里的对不上，谁也说不清哪个是真的。
 *
 * 注意这与**客户端**版本是两回事：客户端版本在仓库根目录 package.json，
 * 也是客户端上报给本服务的 `current` 参数。
 */
const VERSION = require('./package.json').version;

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'releases.db'));
const RELEASES_DIR = path.resolve(process.env.RELEASES_DIR || path.join(DATA_DIR, 'releases'));

const PUBLIC_ORIGIN = String(process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const RELEASE_MAX_MB = Number(process.env.RELEASE_MAX_MB || 300);
const RELEASE_MAX_BYTES = RELEASE_MAX_MB * 1024 * 1024;
const DEFAULT_CHANNEL = String(process.env.RELEASE_CHANNEL || 'stable').trim() || 'stable';

const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8788);
const ADMIN_DISABLED = process.env.ADMIN_DISABLED === '1';
const ADMIN_TOKEN_FILE = path.resolve(
  process.env.ADMIN_TOKEN_FILE || path.join(DATA_DIR, 'admin-token.txt')
);
/**
 * 仅在容器部署时需要：docker 端口映射进来的请求来源是网桥网关（172.17.0.1 之类），
 * 不是回环地址，会被「来源必须回环」这条直接挡掉。
 *
 * 所以这里允许额外声明受信网段。前提是宿主机只把管理端口发布到 127.0.0.1
 * （见 docker-compose.yml），否则等于把管理端开放给内网。
 */
const ADMIN_ALLOW_CIDR = String(process.env.ADMIN_ALLOW_CIDR || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const IS_INIT_ONLY = process.argv.includes('--init-only');

/* ------------------------------------------------------------------ *
 * 存储
 *
 * 库里 releases.file_path 永远存**相对 key**，例如
 *   stable/2.0.1/QingStorClient-Setup-2.0.1-x64.exe
 * 前缀（S3_PREFIX）只在 s3 驱动内部拼接，业务代码拿不到完整 key，
 * 也就没有机会漏加前缀。换 bucket / 换前缀时数据库一个字节都不用改。
 * ------------------------------------------------------------------ */
const STORAGE_DRIVER = String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();
const TMP_DIR = path.join(DATA_DIR, 'tmp');

/**
 * local 实例无条件创建 —— 即便当前驱动是 s3，库里也可能还留着切换前的
 * local 记录。下载按行里的 storage 字段分流，存量包不会因为切换驱动而失效。
 */
const LOCAL_STORAGE = createStorage({ driver: 'local', releasesDir: RELEASES_DIR });

const STORAGE = (() => {
  if (STORAGE_DRIVER === 'local') return LOCAL_STORAGE;
  try {
    return createStorage({
      driver: STORAGE_DRIVER,
      releasesDir: RELEASES_DIR,
      s3: {
        endpoint: process.env.S3_ENDPOINT,
        publicEndpoint: process.env.S3_PUBLIC_ENDPOINT,
        region: process.env.S3_REGION,
        bucket: process.env.S3_BUCKET,
        accessKey: process.env.S3_ACCESS_KEY,
        secretKey: process.env.S3_SECRET_KEY,
        prefix: process.env.S3_PREFIX,
        // 默认 path-style：多数国内 S3 网关没有 <bucket>.<endpoint> 的泛解析
        forcePathStyle: String(process.env.S3_FORCE_PATH_STYLE || 'true') !== 'false',
        signExpires: process.env.S3_SIGN_EXPIRES,
        allowRoot: String(process.env.S3_ALLOW_ROOT || '') === '1',
      },
    });
  } catch (e) {
    // 静态配置错误（缺 bucket / 缺密钥 / 前缀非法）不该带着跑：
    // 这种状态上传必然全失败，早退出比线上发现早。
    console.error('[storage] 存储配置错误，拒绝启动：' + e.message);
    process.exit(1);
  }
})();

/**
 * 按记录行取驱动。
 * 返回 null 表示「这一行要的对象存储，当前进程没配」——比如从 s3 切回 local
 * 启动，库里仍有 s3 记录。此时明确报错，而不是去本地目录找文件后报 410。
 */
function storageFor(name) {
  if (name === 's3') return STORAGE.name === 's3' ? STORAGE : null;
  return LOCAL_STORAGE;
}

/** 启动自检结果。连通性问题不退出（详见启动段），但要能被 health / 管理端看见 */
let storageStatus = { ok: null, detail: '尚未自检' };

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RELEASES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * 管理令牌
 *
 * 只存在于环境变量或权限 0600 的文件里，绝不写进数据库。
 * 这样数据库泄露 ≠ 管理端泄露；反过来删库也不影响登录管理端。
 * ------------------------------------------------------------------ */
const adminToken = (() => {
  if (ADMIN_DISABLED) return '';
  const fromEnv = String(process.env.ADMIN_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(ADMIN_TOKEN_FILE)) {
      const saved = fs.readFileSync(ADMIN_TOKEN_FILE, 'utf8').trim();
      if (saved) return saved;
    }
    const generated = crypto.randomBytes(32).toString('base64url');
    fs.mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_TOKEN_FILE, generated + '\n', { mode: 0o600 });
    // writeFileSync 的 mode 只在新建时生效；文件已存在（比如上次留下 0644）不会被收紧，
    // 所以显式再 chmod 一次。Windows 上 mode 不生效，只能靠目录 ACL，属平台限制。
    try { fs.chmodSync(ADMIN_TOKEN_FILE, 0o600); } catch { /* Windows / 无权限，忽略 */ }
    return generated;
  } catch (e) {
    console.error('[admin] 管理令牌初始化失败，管理端将不启动：', e.message);
    return '';
  }
})();

const ADMIN_ENABLED = !ADMIN_DISABLED && !!adminToken;
const ADMIN_TOKEN_FROM_ENV = !!String(process.env.ADMIN_TOKEN || '').trim();

/* ------------------------------------------------------------------ *
 * 数据库
 *
 * 只有两张表：releases（发布记录）与 audit（管理操作留痕）。
 * 参考项目里的 users / tokens / entities / rev_counter 是给它那套
 * 「请求配置云同步」用的，qingStorClient 的配置只存本机 userData，
 * 不涉及云同步，所以整套账号与同步接口都砍掉了。
 * ------------------------------------------------------------------ */
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS releases (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    channel       TEXT    NOT NULL,
    version       TEXT    NOT NULL,
    platform      TEXT    NOT NULL,
    arch          TEXT    NOT NULL,
    file_name     TEXT    NOT NULL,
    file_path     TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    sha256        TEXT    NOT NULL,
    notes         TEXT,
    downloads     INTEGER NOT NULL DEFAULT 0,
    published_at  INTEGER NOT NULL,
    published_ip  TEXT,
    -- 这条包存在哪里。历史记录一律 local，允许与当前 STORAGE_DRIVER 不同，
    -- 这样切换驱动时存量包仍然可下载（按行走各自的驱动）
    storage       TEXT    NOT NULL DEFAULT 'local'
  );

  CREATE UNIQUE INDEX IF NOT EXISTS uq_releases_key
    ON releases (channel, version, platform, arch);
  CREATE INDEX IF NOT EXISTS idx_releases_channel
    ON releases (channel, platform, arch);

  CREATE TABLE IF NOT EXISTS audit (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,
    action  TEXT    NOT NULL,
    detail  TEXT,
    ip      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit (at);
`);

/**
 * 老库迁移。CREATE TABLE IF NOT EXISTS 不会给已存在的表补列，
 * 所以 storage 列要单独检查后 ALTER。
 */
const releaseColumns = db.prepare('PRAGMA table_info(releases)').all();
if (!releaseColumns.some((c) => c.name === 'storage')) {
  db.exec("ALTER TABLE releases ADD COLUMN storage TEXT NOT NULL DEFAULT 'local'");
  console.log('[migrate] releases 新增 storage 列，存量记录标记为 local');
}

/**
 * 历史脏数据修复：1.2.0 及更早版本用 path.join(channel, version) 生成 file_path，
 * 在 Windows 上会写成 `stable\2.0.1\xxx.exe`。反斜杠一旦进库，拿到 Linux 容器里
 * 就永远找不到文件（且 s3 的对象 key 会变成一个带反斜杠的怪名字）。
 * 这里统一改成正斜杠 —— 幂等，重复执行无副作用。
 */
try {
  db.exec(
    "UPDATE releases SET file_path = REPLACE(file_path, char(92), '/') " +
    'WHERE instr(file_path, char(92)) > 0'
  );
  const n = Number(db.prepare('SELECT changes() AS n').get().n || 0);
  if (n) console.log(`[migrate] 修正 ${n} 条记录的 file_path 路径分隔符`);
} catch (e) {
  console.error('[migrate] 修正 file_path 失败（不影响启动）：', e.message);
}

const stmt = {
  insertRelease: db.prepare(`
    INSERT INTO releases (channel, version, platform, arch, file_name, file_path, size, sha256, notes, downloads, published_at, published_ip, storage)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `),
  overwriteRelease: db.prepare(`
    UPDATE releases SET file_name = ?, file_path = ?, size = ?, sha256 = ?, notes = ?, published_at = ?, published_ip = ?, storage = ?
    WHERE id = ?
  `),
  findReleaseById: db.prepare('SELECT * FROM releases WHERE id = ?'),
  findReleaseByKey: db.prepare(
    'SELECT * FROM releases WHERE channel = ? AND version = ? AND platform = ? AND arch = ?'
  ),
  listReleasesByChannel: db.prepare('SELECT * FROM releases WHERE channel = ?'),
  listReleases: db.prepare('SELECT * FROM releases ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?'),
  countReleases: db.prepare('SELECT COUNT(*) AS n FROM releases'),
  totalBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM releases'),
  bumpDownloads: db.prepare('UPDATE releases SET downloads = downloads + 1 WHERE id = ?'),
  deleteRelease: db.prepare('DELETE FROM releases WHERE id = ?'),
  insertAudit: db.prepare('INSERT INTO audit (at, action, detail, ip) VALUES (?, ?, ?, ?)'),
  listAudit: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?'),
};

if (IS_INIT_ONLY) {
  console.log('[init] 数据库已就绪：' + DB_FILE);
  const sd = STORAGE.describe();
  console.log(
    '[init] 存储驱动：' + sd.driver +
    (sd.driver === 's3' ? ` · ${sd.bucket}/${sd.prefix} @ ${sd.endpoint}` : ' · ' + sd.root)
  );
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */
function send(res, status, obj, extraHeaders) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-server-version': VERSION,
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function fail(res, status, message, code) {
  send(res, status, { ok: false, error: message, code: code || null });
}

/** 统一的 404：不区分「路径不存在」与「被策略拦下」，避免暴露管理端是否存在 */
function notFound(res) {
  fail(res, 404, 'Not Found', 'NOT_FOUND');
}

function socketIp(req) {
  let ip = (req.socket && (req.socket.remoteAddress || '')) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';
  return ip;
}

/**
 * 参与限流与审计的客户端 IP。
 * 只有显式 TRUST_PROXY=1 才采信 X-Forwarded-For —— 反代后面必须开，
 * 否则所有请求都被算成 nginx 的地址，按 IP 限流会变成「全局限流」。
 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.startsWith('::ffff:') ? xff.slice(7) : xff;
  }
  return socketIp(req);
}

function isLoopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.');
}

/** 极简 CIDR 判断，只处理 IPv4。用于 ADMIN_ALLOW_CIDR，够用且不必引依赖 */
function ipInCidr(ip, cidr) {
  const parts = String(cidr).split('/');
  if (parts.length !== 2) return false;
  const base = parts[0].trim();
  const bits = Number(parts[1]);
  const v4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  if (!v4.test(String(ip)) || !v4.test(base)) return false;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s) => s.split('.').reduce((a, b) => ((a << 8) + Number(b)) >>> 0, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return ((toInt(ip) & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
}

/* 限流：固定窗口计数，够用且无外部依赖 */
const rateBuckets = new Map();
function tooManyRequests(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  if (rateBuckets.size > 20000) {
    for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
  }
  return b.count > max;
}

/** 恒定时间比较（先比长度，长度不同直接返回，避免 timingSafeEqual 抛错） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * 版本号解析：x.y.z，可选 -pre 后缀，允许前导 v。
 * 返回 null 表示不是合法版本号。
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

/**
 * 预发布标识符比较（按 SemVer 2.0 第 11 条）：
 *   - 按 '.' 切段后逐段比，数字段按数值比（dev.9 < dev.10），字母段按 ASCII 比
 *   - 数字段优先级低于字母段（1.0.0-1 < 1.0.0-alpha）
 *   - 前缀全等时，段数少的更小（1.0.0-dev < 1.0.0-dev.1）
 *
 * 为什么不能直接 `x.pre < y.pre`：那是字符串比较，'dev.10' < 'dev.9' 会成立，
 * 开发迭代到第 10 个版本号时客户端会误判「已是最新」，静默收不到更新。
 */
function comparePrerelease(a, b) {
  const xa = String(a).split('.');
  const xb = String(b).split('.');
  const len = Math.max(xa.length, xb.length);
  for (let i = 0; i < len; i += 1) {
    const sa = xa[i];
    const sb = xb[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    if (sa === sb) continue;
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const d = Number(sa) - Number(sb);
      if (d !== 0) return d < 0 ? -1 : 1;
      continue;
    }
    if (na !== nb) return na ? -1 : 1;
    return sa < sb ? -1 : 1;
  }
  return 0;
}

/**
 * a 比 b 新返回 >0，相同返回 0，更旧返回 <0。
 * 任一侧非法时返回 0（「无法比较」按相等处理：宁可不提示更新，也不误报）。
 */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  // 预发布版永远小于同号正式版：1.2.0-beta < 1.2.0
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePrerelease(x.pre, y.pre);
}

/** 平台与架构归一化，容忍客户端传 windows / darwin / x86_64 这类写法 */
const PLATFORM_ALIASES = {
  win: 'win', win32: 'win', windows: 'win',
  mac: 'mac', darwin: 'mac', osx: 'mac', macos: 'mac',
  linux: 'linux',
};
const ARCH_ALIASES = {
  x64: 'x64', x86_64: 'x64', amd64: 'x64',
  arm64: 'arm64', aarch64: 'arm64',
  ia32: 'ia32', x86: 'ia32', i386: 'ia32',
  armv7l: 'armv7l', arm: 'armv7l',
};
const PLATFORMS = new Set(['win', 'mac', 'linux']);
const ARCHES = new Set(['x64', 'arm64', 'ia32', 'armv7l']);

function normalizePlatform(v) {
  const s = String(v || '').trim().toLowerCase();
  return PLATFORM_ALIASES[s] || s;
}
function normalizeArch(v) {
  const s = String(v || '').trim().toLowerCase();
  return ARCH_ALIASES[s] || s;
}

/**
 * 落盘文件名清洗：只取 basename，剔掉路径分隔符、控制字符与引号。
 * 客户端给的文件名属于不可信输入，绝不能直接拼进文件路径。
 */
function sanitizeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["'`<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120);
}

/**
 * 文件名传递：管理页把文件名 base64url 编码后放进 query。
 *
 * 但 Buffer.from(v, 'base64url') 对任何输入都不抛错 —— 非法字符被静默忽略，
 * 明文文件名会被解成一堆乱码字节。于是「直接调接口按常理传明文名」得到的结果是：
 * 发布成功、返回 200、文件名却是一串乱码，一个错都不报，而兜底名也轮不到
 * （乱码是非空的）。所以这里做往返校验：
 *
 *   1. 只含 base64url 字符集，否则判定为明文；
 *   2. 解出来再编码必须与原文逐字相同；
 *   3. 解出来必须是可打印文本（无控制字符）。
 *
 * 三条都满足才认为是编码形式，否则原样当作文件名。
 */
function decodeFileName(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(v)) return v;      // 含 . / 空格等 → 一定是明文
  try {
    const buf = Buffer.from(v, 'base64url');
    if (buf.toString('base64url') !== v) return v;                // 不是规范 base64url
    const text = buf.toString('utf8');
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) return v;     // 解出来不是可打印文本
    return text;
  } catch {
    return v;
  }
}

/** Content-Disposition 里的 ASCII 兜底名（中文名走 filename*） */
function asciiFileName(name) {
  return String(name || 'download.bin').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

/** 按平台给个默认扩展名，避免省略 name 时产出没有后缀的文件 */
function defaultFileName(version, platform, arch) {
  const ext = platform === 'win' ? '.exe' : platform === 'mac' ? '.dmg' : '.AppImage';
  return `QingStorClient-${version}-${platform}-${arch}${ext}`;
}

function audit(req, action, detail) {
  try {
    stmt.insertAudit.run(Date.now(), action, detail || null, clientIp(req));
  } catch (e) {
    console.error('[admin] 审计写入失败：', e.message);
  }
}

/**
 * 被拒绝的请求做去重审计：按 动作+IP 每分钟只落一条。
 * 否则远程扫描能把 audit 表灌爆（限流之外的第二层保护）。
 */
const auditDenyMarks = new Map();
function auditDenied(req, action, detail) {
  const key = `${action}|${socketIp(req)}`;
  const now = Date.now();
  if ((auditDenyMarks.get(key) || 0) > now - 60_000) return;
  auditDenyMarks.set(key, now);
  audit(req, action, detail);
  if (auditDenyMarks.size > 5000) {
    for (const [k, t] of auditDenyMarks) if (t < now - 300_000) auditDenyMarks.delete(k);
  }
}

/* ------------------------------------------------------------------ *
 * 发布记录
 * ------------------------------------------------------------------ */
function releaseRowToJson(row) {
  const rel = `/api/releases/download/${row.id}`;
  return {
    id: row.id,
    channel: row.channel,
    version: row.version,
    platform: row.platform,
    arch: row.arch,
    fileName: row.file_name,
    size: row.size,
    sha256: row.sha256,
    notes: row.notes || '',
    downloads: row.downloads,
    publishedAt: row.published_at,
    storage: row.storage || 'local',
    downloadUrl: PUBLIC_ORIGIN ? PUBLIC_ORIGIN + rel : rel,
  };
}

/**
 * 取某渠道 + 平台 + 架构下的最新版本。
 *
 * 不能交给 SQL 排序 —— 版本号是文本，'1.10.0' < '1.9.0' 按字典序成立但语义是错的。
 * 发布量级只有几十条，全量取回逐条 compareVersion 完全无压力。
 */
function pickLatestRelease(channel, platform, arch) {
  let best = null;
  for (const row of stmt.listReleasesByChannel.all(channel)) {
    if (platform && row.platform !== platform) continue;
    if (arch && row.arch !== arch) continue;
    if (!best || compareVersion(row.version, best.version) > 0) best = row;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * 公网侧：更新 API
 * ------------------------------------------------------------------ */

/**
 * GET / —— 服务自述。公网根路径与管理侧根路径都返回它。
 *
 * 为什么不和 /api/health 合并成同一个分支（参考项目 myApiTools 是合并的）：
 * 那边没有独立的探活语义，`/` 就是它的健康检查入口；这里两者职责不同 ——
 *   /api/health  给监控用，带 releases 数量与 uptime；
 *   /            给人用，只放身份信息。
 * 把 releases 数量放到公网，等于让人能推断你一共发过多少个包，没必要。
 *
 * scope 是刻意写的：扫描器看到「不存用户数据、不代理请求」，继续试探的价值就低了。
 */
function handleServiceInfo(req, res, isAdmin) {
  const info = {
    ok: true,
    service: 'qingstor-client-update',
    name: 'qingStorClient 更新服务',
    version: VERSION,
    scope: '仅分发客户端安装包，不提供账号、配置同步与第三方代理',
    serverTime: Date.now(),
  };
  // 管理侧根路径额外给出入口提示与存储位置：从隧道里敲根路径之后，
  // 既知道下一步点哪，也能立刻确认「现在包到底写在哪」
  if (isAdmin) {
    info.adminPage = '/admin';
    info.storage = STORAGE.describe();
  }
  send(res, 200, info);
}

/** GET /api/health —— 给 nginx / 监控探活用，带发布数量与运行时长（用来判断库是否读得动） */
function handleHealth(req, res) {
  const payload = {
    ok: true,
    service: 'qingstor-client-update',
    version: VERSION,
    releases: stmt.countReleases.get().n,
    // 只暴露驱动名。加这个字段是为了让「以为切到对象存储、实际还在写本地盘」
    // 这种认知错位无处藏身 —— 浏览器敲一下 health 就能确认。bucket、端点、
    // 密钥一概不进公网响应。
    storage: STORAGE.name,
    uptime: Math.round(process.uptime()),
    checkedAt: Date.now(),
  };
  // 自检失败要让监控看得见；失败详情只留在管理端与日志里
  if (storageStatus.ok === false) payload.storageOk = false;
  send(res, 200, payload);
}

/** GET /api/releases/latest?platform=win&arch=x64&channel=stable&current=2.0.0 */
function handleReleaseLatest(req, res, query) {
  const platform = normalizePlatform(query.get('platform'));
  const arch = normalizeArch(query.get('arch'));
  const channel = String(query.get('channel') || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  const current = String(query.get('current') || '').trim();

  if (platform && !PLATFORMS.has(platform)) {
    return fail(res, 400, '不支持的平台：' + platform, 'BAD_PLATFORM');
  }
  if (arch && !ARCHES.has(arch)) {
    return fail(res, 400, '不支持的架构：' + arch, 'BAD_ARCH');
  }

  const best = pickLatestRelease(channel, platform, arch);
  if (!best) {
    // 这个渠道还没发布过任何版本，对客户端来说就是「已是最新」，不是错误
    return send(res, 200, {
      ok: true,
      channel,
      current: current || null,
      latest: null,
      upToDate: true,
      updateAvailable: false,
      checkedAt: Date.now(),
    });
  }

  // 客户端没报当前版本时，只如实回答「最新是哪个」，不做新旧判断
  const upToDate = current ? compareVersion(best.version, current) <= 0 : null;
  return send(res, 200, {
    ok: true,
    channel,
    current: current || null,
    latest: releaseRowToJson(best),
    upToDate,
    updateAvailable: upToDate === false,
    channelCount: stmt.listReleasesByChannel.all(channel).length,
    checkedAt: Date.now(),
  });
}

/**
 * 解析 Range 头，支持断点续传（100MB 的安装包在弱网下经常断）。
 * 返回 { start, end } / { invalid: true } / null（无 Range 或格式不认识）
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;

  let start;
  let end;
  if (!hasStart) {
    // bytes=-N：最后 N 字节
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return { invalid: true };
    start = Math.max(size - n, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
    if (end >= size) end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true };
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/**
 * 下载计数：只在「真正下载」时 +1。
 *   - HEAD 只是探测元信息，不算一次下载；
 *   - Range 从 0 开始算一次，从中途续传不再累加，
 *     否则一个断点续传十次的下载会被记成十一次下载。
 */
function bumpDownloads(req, id, rangeStart) {
  if (req.method !== 'GET') return;
  if (rangeStart > 0) return;
  try { stmt.bumpDownloads.run(id); } catch { /* 计数失败不该影响下载 */ }
}

/** 下载响应的公共头，local 与 s3 两条路径共用 */
function downloadHeaders(row) {
  return {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-disposition':
      `attachment; filename="${asciiFileName(row.file_name)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    'x-release-version': row.version,
    'x-release-platform': row.platform,
    'x-release-arch': row.arch,
    'x-release-sha256': row.sha256,
    'x-release-storage': row.storage || 'local',
    'cache-control': 'no-store',
  };
}

/**
 * 对象存储分支：GET 返 302 到短时预签名地址，HEAD 由本地库直接回答。
 *
 * 为什么不把预签名地址放进 downloadUrl 让客户端直接用：
 *   那个链接会出现在弹窗、复制按钮、聊天记录里，几分钟后就过期。
 *   downloadUrl 永远指向本服务的 /api/releases/download/:id，
 *   预签名只在收到这次 GET 的瞬间生成，TTL 可以压到 5 分钟，泄露面最小。
 */
function downloadFromObjectStorage(req, res, row) {
  const target = storageFor('s3');
  if (!target) {
    return fail(
      res, 503,
      '该安装包存放在对象存储，但当前服务未配置 STORAGE_DRIVER=s3',
      'STORAGE_NOT_CONFIGURED'
    );
  }

  // HEAD 必须由服务端自己回答：匿名 HEAD 在该存储上一律 403（连不存在的 key 也是），
  // 而 SigV4 签名绑定 method，GET 的签名不能用于 HEAD。size / sha256 本地库里都有。
  if (req.method === 'HEAD') {
    res.writeHead(200, { ...downloadHeaders(row), 'content-length': row.size });
    return res.end();
  }

  let url;
  try {
    url = target.signedUrl(row.file_path);
  } catch (e) {
    console.error('[download] 生成预签名地址失败：', e.message);
    return fail(res, 502, '生成下载地址失败：' + e.message, 'SIGN_FAILED');
  }
  if (!url) return fail(res, 500, '当前存储驱动不支持临时下载地址', 'STORAGE_UNSUPPORTED');

  bumpDownloads(req, row.id, 0);
  // 302 响应体为空。no-store 很关键：任何中间层缓存了这张带过期签名的跳转都很难查
  res.writeHead(302, {
    location: url,
    'cache-control': 'no-store',
    'x-release-version': row.version,
    'x-release-sha256': row.sha256,
    'x-release-storage': 's3',
  });
  res.end();
}

/** 本地磁盘分支：流式返回，支持 Range（断点续传） */
function downloadFromLocalDisk(req, res, row) {
  const full = path.resolve(RELEASES_DIR, row.file_path);
  // 双保险：即使库被外部改脏，也不允许把 RELEASES_DIR 之外的文件读出去
  if (full !== RELEASES_DIR && !full.startsWith(RELEASES_DIR + path.sep)) {
    return fail(res, 500, '安装包路径非法', 'BAD_PATH');
  }

  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return fail(res, 410, '安装包文件已丢失，请在管理端重新发布', 'GONE');
  }

  const baseHeaders = downloadHeaders(row);

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const range = parseRange(rangeHeader, st.size);
    if (range && range.invalid) {
      res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${st.size}` });
      return res.end();
    }
    if (range) {
      bumpDownloads(req, row.id, range.start);
      res.writeHead(206, {
        ...baseHeaders,
        'content-length': range.end - range.start + 1,
        'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
      });
      if (req.method === 'HEAD') return res.end();
      const s = fs.createReadStream(full, { start: range.start, end: range.end });
      s.on('error', () => res.destroy());
      return s.pipe(res);
    }
  }

  bumpDownloads(req, row.id, 0);
  res.writeHead(200, { ...baseHeaders, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(full);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** GET /api/releases/download/:id —— 按记录行里的 storage 分流 */
function handleReleaseDownload(req, res, id) {
  const row = stmt.findReleaseById.get(id);
  if (!row) return fail(res, 404, '安装包不存在', 'NOT_FOUND');
  return row.storage === 's3'
    ? downloadFromObjectStorage(req, res, row)
    : downloadFromLocalDisk(req, res, row);
}

/* ------------------------------------------------------------------ *
 * 管理侧
 * ------------------------------------------------------------------ */
let adminHtmlCache = null;
function serveAdminPage(res) {
  try {
    if (adminHtmlCache === null) {
      adminHtmlCache = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    }
  } catch (e) {
    return fail(res, 500, '管理页面文件缺失：' + e.message);
  }
  const body = Buffer.from(adminHtmlCache, 'utf8');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    // 管理页不该被任何页面嵌入，也不该往外发 Referer
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'",
  });
  res.end(body);
}

/**
 * 管理端来源校验。两道判据：
 *
 *   1. socket 地址必须是回环 —— 有人把 ADMIN_HOST 改成 0.0.0.0 时靠这条兜底；
 *   2. 请求不能带反代痕迹头 —— nginx 转发的请求必然被加上 X-Forwarded-*，
 *      而通过 SSH 隧道直连的浏览器不会带。所以「有人图省事给 nginx 加了一条
 *      /admin 的 location」这种误配置会被这条直接拦掉：那条路上一进 nginx
 *      就带上了转发头，服务端立刻拒绝。
 *
 * 两条都过不去的情况下返回统一的 404，不暴露这里存在管理端。
 */
const PROXY_TRACE_HEADERS = ['x-forwarded-for', 'x-real-ip', 'x-forwarded-proto', 'x-forwarded-host'];

function adminSourceAllowed(req) {
  if (PROXY_TRACE_HEADERS.some((h) => req.headers[h])) return false;
  const ip = socketIp(req);
  if (isLoopback(ip)) return true;
  return ADMIN_ALLOW_CIDR.some((c) => ipInCidr(ip, c));
}

function adminTokenMatches(req) {
  const given = String(req.headers['x-admin-token'] || '').trim();
  if (!given || !adminToken) return false;
  return safeEqual(given, adminToken);
}

/**
 * PUT /api/admin/releases?version=&platform=&arch=&channel=&notes=[&name=]
 * body 就是安装包的原始字节流。
 *
 * 不用 multipart/form-data，是因为零依赖下手写 boundary 切分容易出错，
 * 而「原始字节流 + query 带元信息」在自用场景下更直白，还能边收边算 sha256。
 */
async function adminUploadRelease(req, res, url) {
  const q = url.searchParams;
  const version = String(q.get('version') || '').trim();
  const channel = String(q.get('channel') || DEFAULT_CHANNEL).trim() || DEFAULT_CHANNEL;
  const platform = normalizePlatform(q.get('platform'));
  const arch = normalizeArch(q.get('arch'));
  const notes = String(q.get('notes') || '').slice(0, 20000);

  if (!parseVersion(version)) {
    return fail(res, 400, '版本号必须形如 1.2.3（可带 -beta.1 之类的预发布后缀）', 'BAD_VERSION');
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(channel)) {
    return fail(res, 400, '渠道名只能是小写字母、数字和 . _ -', 'BAD_CHANNEL');
  }
  if (!PLATFORMS.has(platform)) {
    return fail(res, 400, '平台必须是 win / mac / linux 之一', 'BAD_PLATFORM');
  }
  if (!ARCHES.has(arch)) {
    return fail(res, 400, '架构必须是 x64 / arm64 / ia32 / armv7l 之一', 'BAD_ARCH');
  }

  const declared = decodeFileName(q.get('name'));
  const safeName =
    sanitizeFileName(declared) || defaultFileName(version, platform, arch);

  // key 一律用正斜杠拼接。path.join 在 Windows 上会产出 `stable\2.0.1\x.exe`，
  // 反斜杠一旦进库，拿到 Linux 容器或对象存储里就永远找不到（1.2.0 遗留的真实隐患）。
  const relPath = [channel, version, safeName].join('/');
  // 先落临时文件：对象存储的 SigV4 要求请求头里带整包 SHA256，
  // 而签名必须在发请求之前完成 —— 所以哈希得先算完，只能两遍 IO。
  const tmpFile = path.join(TMP_DIR, `up-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.part`);

  // 先按 Content-Length 拦一道：正常上传都会带这个头，能不读 body 就拒掉
  const declaredLen = Number(req.headers['content-length'] || 0);
  if (declaredLen > RELEASE_MAX_BYTES) {
    return fail(res, 413, `安装包超过上限 ${RELEASE_MAX_MB} MB`, 'TOO_LARGE');
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  /**
   * 上传失败时的收尾：删掉半截的临时文件。
   * 正式位置由存储驱动负责 —— 形态是本地文件还是对象存储都不知道，
   * 所以业务层只管临时文件，失败的半截数据永远进不了 releases 目录。
   */
  const discardPartial = () => {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  };

  const hash = crypto.createHash('sha256');
  const ws = fs.createWriteStream(tmpFile);
  let size = 0;
  let tooBig = false;
  let failure = null;

  try {
    await new Promise((resolve, reject) => {
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > RELEASE_MAX_BYTES) {
          // 超限后不再落盘，但要把剩余数据读完才回 413：
          // 直接 destroy 会把响应一起掐断，客户端只能看到「连接被重置」，
          // 拿不到状态码，也就不知道是超限。
          tooBig = true;
          return;
        }
        hash.update(chunk);
        // 磁盘慢时暂停请求流，避免整包堆在内存里
        if (!ws.write(chunk)) {
          req.pause();
          ws.once('drain', () => req.resume());
        }
      });
      req.on('end', resolve);
      req.on('error', reject);
      req.on('aborted', () => reject(Object.assign(new Error('上传中断'), { status: 499 })));
      ws.on('error', reject);
    });
  } catch (e) {
    failure = e;
  }

  // 无论成功与否都要等写流真正关闭：Windows 上句柄没释放就删不掉半截文件
  const closed = new Promise((resolve) => {
    if (ws.closed) return resolve();
    ws.once('close', resolve);
    setTimeout(resolve, 5000);
  });
  if (failure || tooBig) {
    try { ws.destroy(); } catch { /* ignore */ }
  } else {
    ws.end();
  }
  await closed;

  if (failure) {
    discardPartial();
    return fail(res, failure.status || 500, '上传失败：' + failure.message, 'UPLOAD_FAILED');
  }
  if (tooBig) {
    discardPartial();
    return fail(res, 413, `安装包超过上限 ${RELEASE_MAX_MB} MB`, 'TOO_LARGE');
  }
  if (!size) {
    discardPartial();
    return fail(res, 400, '上传内容为空', 'EMPTY_BODY');
  }

  const sha256 = hash.digest('hex');
  const now = Date.now();
  const ip = clientIp(req);
  const existing = stmt.findReleaseByKey.get(channel, version, platform, arch);

  /**
   * 顺序不能反：先把对象写进存储，成功后才动数据库。
   * 反过来会出现「库里有记录、对象不存在」——客户端看到有新版本，下载却 404，
   * 而且从管理端看不出问题。失败就宁可不写库，让这次发布整体失败。
   */
  try {
    await STORAGE.put(relPath, tmpFile, { size, sha256, contentType: 'application/octet-stream' });
  } catch (e) {
    discardPartial();
    console.error('[upload] 写入存储失败：', e.message);
    return fail(res, 502, '写入存储失败：' + e.message, 'STORAGE_WRITE_FAILED');
  }
  // local 驱动是 rename（临时文件已被移走），s3 驱动需要这里收拾；
  // force 删除对不存在的文件无副作用
  try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }

  /**
   * 覆盖发布：新对象就位之后再清理旧对象。
   * 同一个「渠道+版本+平台+架构」重复发布按覆盖处理 —— 这是自建服务比
   * GitHub Release 好用的地方：dev 渠道可以无脑重发，不会堆十几个同版本垃圾。
   * 指向同一个存储的同一个 key 时不用删（刚写的那个就是它）。
   */
  if (existing) {
    const oldStorage = existing.storage || 'local';
    const oldPath = String(existing.file_path || '').replace(/\\/g, '/');
    const sameTarget = oldStorage === STORAGE.name && oldPath === relPath;
    if (!sameTarget) {
      const oldStore = storageFor(oldStorage);
      if (oldStore) {
        try { await oldStore.remove(oldPath); }
        catch (e) { console.error('[upload] 清理旧对象失败（不影响本次发布）：', e.message); }
      } else {
        console.warn(
          `[upload] 旧记录存放在 ${oldStorage}，当前未配置该驱动，旧对象未清理：${oldPath}`
        );
      }
    }
  }

  let id;
  if (existing) {
    stmt.overwriteRelease.run(
      safeName, relPath, size, sha256, notes || existing.notes, now, ip, STORAGE.name, existing.id
    );
    id = existing.id;
  } else {
    const r = stmt.insertRelease.run(
      channel, version, platform, arch, safeName, relPath, size, sha256, notes || null, now, ip, STORAGE.name
    );
    id = Number(r.lastInsertRowid);
  }

  audit(req, existing ? 'release.overwrite' : 'release.publish',
    `${channel}/${version} ${platform}-${arch} ${safeName} (${size} 字节)`);

  return send(res, existing ? 200 : 201, {
    ok: true,
    replaced: !!existing,
    release: releaseRowToJson(stmt.findReleaseById.get(id)),
  });
}

function adminListReleases(req, res, query) {
  const limit = Math.min(Math.max(Number(query.get('limit') || 200) || 200, 1), 500);
  const offset = Math.max(Number(query.get('offset') || 0) || 0, 0);
  send(res, 200, {
    ok: true,
    serverVersion: VERSION,
    total: stmt.countReleases.get().n,
    totalBytes: stmt.totalBytes.get().n,
    maxMb: RELEASE_MAX_MB,
    defaultChannel: DEFAULT_CHANNEL,
    publicOrigin: PUBLIC_ORIGIN || null,
    channels: [...new Set(stmt.listReleases.all(500, 0).map((r) => r.channel))],
    storage: STORAGE.describe(),
    storageStatus,
    releasesDir: RELEASES_DIR,
    releases: stmt.listReleases.all(limit, offset).map(releaseRowToJson),
  });
}

async function adminDeleteRelease(req, res, id) {
  const row = stmt.findReleaseById.get(id);
  if (!row) return fail(res, 404, '发布记录不存在', 'NOT_FOUND');

  const target = storageFor(row.storage || 'local');
  if (!target) {
    return fail(
      res, 503,
      `该记录存放在 ${row.storage}，当前服务未配置该驱动，无法删除对象`,
      'STORAGE_NOT_CONFIGURED'
    );
  }

  /**
   * 先删对象、再删库。对象删不掉就不动库 —— 否则会留下一条指向空对象的记录，
   * 客户端拿到 410，而管理端列表看起来一切正常，很难定位。
   */
  try {
    await target.remove(row.file_path);
  } catch (e) {
    console.error('[delete] 删除存储对象失败：', e.message);
    return fail(res, 502, '删除存储对象失败：' + e.message, 'STORAGE_DELETE_FAILED');
  }

  stmt.deleteRelease.run(id);

  audit(req, 'release.delete', `${row.channel}/${row.version} ${row.platform}-${row.arch} ${row.file_name}`);
  send(res, 200, { ok: true, deleted: releaseRowToJson(row) });
}

function adminListAudit(req, res, query) {
  const limit = Math.min(Math.max(Number(query.get('limit') || 100) || 100, 1), 500);
  send(res, 200, {
    ok: true,
    entries: stmt.listAudit.all(limit).map((r) => ({
      id: r.id, at: r.at, action: r.action, detail: r.detail || '', ip: r.ip || '',
    })),
  });
}

/* ------------------------------------------------------------------ *
 * 路由分发
 * ------------------------------------------------------------------ */
function handlePublic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // 管理端路径在公网侧一律 404 —— 不暴露存在性
  if (p === '/admin' || p === '/admin/' || p.startsWith('/api/admin')) {
    return notFound(res);
  }

  const ip = clientIp(req);
  if (tooManyRequests(`pub:${ip}`, 300, 60_000)) {
    return fail(res, 429, '请求过于频繁，请稍后再试', 'RATE_LIMITED');
  }

  // 根路径自述：浏览器敲域名时能确认服务活着、版本多少，不必先记住 /api/health。
  // 只放身份信息，具体的发布数量与运行时长留在 /api/health。
  if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleServiceInfo(req, res, false);
  }

  if (p === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleHealth(req, res);
  }

  if (!p.startsWith('/api/releases')) return notFound(res);

  if (p === '/api/releases/latest' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleReleaseLatest(req, res, url.searchParams);
  }

  const m = /^\/api\/releases\/download\/(\d+)$/.exec(p);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    // 下载单独限流：单包上百 MB，不该跟查最新版共用一个桶
    if (tooManyRequests(`dl:${ip}`, 60, 60_000)) {
      return fail(res, 429, '下载请求过于频繁，请稍后再试', 'RATE_LIMITED');
    }
    return handleReleaseDownload(req, res, Number(m[1]));
  }

  return notFound(res);
}

/**
 * async handler 的兜底。
 * 上传/删除现在会 await 存储驱动，异常不会再被同步 try/catch 抓住，
 * 不加这层就是 unhandledRejection —— 进程可能直接挂，而客户端只看到连接被重置。
 */
function guardAsync(res, p) {
  return Promise.resolve(p).catch((e) => {
    console.error('[admin] 异步处理未捕获异常：', e);
    if (!res.headersSent) fail(res, 500, '服务端内部错误', 'INTERNAL');
    else res.destroy();
  });
}

function handleAdminSide(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // 管理侧根路径：隧道开好后直接敲 127.0.0.1:8790 也能看到入口，不必记 /admin
  if (p === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
    return handleServiceInfo(req, res, true);
  }

  if ((p === '/admin' || p === '/admin/') && (req.method === 'GET' || req.method === 'HEAD')) {
    return serveAdminPage(res);
  }

  if (!p.startsWith('/api/admin/')) return notFound(res);

  // 第一道：来源必须是回环。即便有人把 ADMIN_HOST 改成 0.0.0.0，这里仍然拦得住
  if (!adminSourceAllowed(req)) {
    auditDenied(req, 'admin.deny.source', `来源 ${socketIp(req)} 访问 ${p}`);
    return notFound(res);
  }

  const ip = socketIp(req);
  if (tooManyRequests(`admin:${ip}`, 120, 60_000)) {
    return fail(res, 429, '管理端请求过于频繁', 'RATE_LIMITED');
  }

  // 第二道：令牌
  if (!adminTokenMatches(req)) {
    auditDenied(req, 'admin.deny.token', `令牌不符，访问 ${p}`);
    return fail(res, 401, '管理令牌无效', 'UNAUTHORIZED');
  }

  if (p === '/api/admin/whoami') {
    return send(res, 200, {
      ok: true,
      serverVersion: VERSION,
      tokenFromEnv: ADMIN_TOKEN_FROM_ENV,
      tokenFile: ADMIN_TOKEN_FROM_ENV ? null : ADMIN_TOKEN_FILE,
      releasesDir: RELEASES_DIR,
      dbFile: DB_FILE,
      maxMb: RELEASE_MAX_MB,
      defaultChannel: DEFAULT_CHANNEL,
      publicOrigin: PUBLIC_ORIGIN || null,
      storage: STORAGE.describe(),
      storageStatus,
    });
  }

  if (p === '/api/admin/releases') {
    if (req.method === 'GET' || req.method === 'HEAD') return adminListReleases(req, res, url.searchParams);
    // PUT 是语义正确的写法；同时接受 POST，因为不少工具（Postman、各种 HTTP 库）
    // 默认就是 POST，硬性拒绝只会让人以为接口坏了
    if (req.method === 'PUT' || req.method === 'POST') {
      return guardAsync(res, adminUploadRelease(req, res, url));
    }
    return fail(res, 405, '该接口只接受 GET / PUT（也接受 POST）', 'BAD_METHOD');
  }

  const m = /^\/api\/admin\/releases\/(\d+)$/.exec(p);
  if (m && req.method === 'DELETE') {
    return guardAsync(res, adminDeleteRelease(req, res, Number(m[1])));
  }

  if (p === '/api/admin/audit' && req.method === 'GET') {
    return adminListAudit(req, res, url.searchParams);
  }

  return notFound(res);
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
const publicServer = http.createServer((req, res) => {
  try {
    handlePublic(req, res);
  } catch (e) {
    console.error('[public] 未捕获异常：', e);
    if (!res.headersSent) fail(res, 500, '服务端内部错误', 'INTERNAL');
    else res.destroy();
  }
});

let adminServer = null;

/**
 * 控制台对齐：中文在终端里占两列，但 JS 的 length 只算 1，
 * 直接用 padEnd 排出来的表格是歪的。这里按显示宽度补齐。
 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}
function padDisplay(s, width) {
  let out = s;
  let w = displayWidth(s);
  while (w < width) { out += ' '; w += 1; }
  return out;
}

function banner() {
  const pubHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  const line = (k, v) => console.log('  ' + padDisplay(k, 20) + v);
  console.log('');
  console.log('  qingStorClient 更新服务 v' + VERSION);
  console.log('  ' + '-'.repeat(66));
  line('更新 API', `http://${pubHost}:${PORT}/api/releases/latest`);
  console.log('  ' + '-'.repeat(66));
  if (ADMIN_ENABLED) {
    const adminHost = ADMIN_HOST === '0.0.0.0' ? '127.0.0.1' : ADMIN_HOST;
    line('管理端', `http://${adminHost}:${ADMIN_PORT}/admin`);
    line('管理端绑定', `${ADMIN_HOST}:${ADMIN_PORT}（仅回环，走 SSH 隧道）`);
    line('SSH 隧道', `ssh -N -L ${ADMIN_PORT}:127.0.0.1:${ADMIN_PORT} <user>@<server>`);
    line('管理令牌', ADMIN_TOKEN_FROM_ENV ? '来自环境变量 ADMIN_TOKEN' : ADMIN_TOKEN_FILE);
  } else {
    line('管理端', '已关闭');
  }
  const sd = STORAGE.describe();
  if (sd.driver === 's3') {
    line('存储驱动', `s3 · ${sd.bucket}/${sd.prefix}`);
    line('对象存储', sd.endpoint + (sd.publicEndpoint !== sd.endpoint ? `  →  ${sd.publicEndpoint}` : ''));
    line('预签名 TTL', `${sd.signExpires}s`);
  } else {
    line('存储驱动', 'local');
    line('安装包目录', sd.root);
  }
  line('数据库', DB_FILE);
  line('TRUST_PROXY', TRUST_PROXY ? '1（采信 X-Forwarded-For）' : '0（用 socket 地址）');
  console.log('  ' + '-'.repeat(66));
  console.log('');
}

/** 清理上次进程崩溃留下的半截上传文件（只动 24 小时前的，避免误删正在传的） */
function cleanupTmpDir() {
  try {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const name of fs.readdirSync(TMP_DIR)) {
      if (!name.endsWith('.part')) continue;
      const p = path.join(TMP_DIR, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * 存储自检。连通性失败**不退出进程**：
 * 静态配置错误在创建驱动时已经 exit(1)，而「bucket 一时连不上」如果也退出，
 * 容器会反复重启 —— 连查版本接口都没了，客户端从「能查到更新但下载失败」
 * 退化成「检查更新直接报错」，反而更糟。
 * 所以这里只告警并置状态，由 /api/health 的 storageOk 暴露给监控。
 */
async function runStorageSelfCheck() {
  try {
    storageStatus = await STORAGE.ready();
  } catch (e) {
    storageStatus = { ok: false, detail: e.message };
  }
  if (storageStatus.ok) {
    console.log('[storage] 自检通过：' + STORAGE.name + ' · ' + storageStatus.detail);
  } else {
    console.error(
      '[storage] 自检失败（服务继续运行，但上传/下载可能不可用）：' + storageStatus.detail
    );
  }
}

publicServer.on('error', (e) => {
  console.error(`[public] 监听 ${HOST}:${PORT} 失败：`, e.message);
  process.exit(1);
});

/**
 * 启动信息只打一次。管理端端口被占用时 listen 的成功回调不会触发，
 * 如果不在这里兜一下，控制台会一片空白，看起来像是启动卡住了。
 */
let startupLogged = false;
function logStartup() {
  if (startupLogged) return;
  startupLogged = true;
  banner();
  runStorageSelfCheck();
}

cleanupTmpDir();

publicServer.listen(PORT, HOST, () => {
  if (ADMIN_ENABLED) {
    adminServer = http.createServer((req, res) => {
      try {
        handleAdminSide(req, res);
      } catch (e) {
        console.error('[admin] 未捕获异常：', e);
        if (!res.headersSent) fail(res, 500, '服务端内部错误', 'INTERNAL');
        else res.destroy();
      }
    });
    adminServer.on('error', (e) => {
      // 管理端起不来不该拖死更新 API：公网侧照常服务，只是没法发新版
      console.error(`[admin] 监听 ${ADMIN_HOST}:${ADMIN_PORT} 失败，管理端不可用：`, e.message);
      adminServer = null;
      logStartup();
    });
    adminServer.listen(ADMIN_PORT, ADMIN_HOST, logStartup);
  } else {
    logStartup();
  }
});

function shutdown(sig) {
  console.log(`\n[server] 收到 ${sig}，正在关闭…`);
  const close = (s) => new Promise((r) => (s ? s.close(() => r()) : r()));
  Promise.all([close(publicServer), close(adminServer)]).then(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  // 长连接（正在下载的安装包）可能不响应 close，给 5 秒兜底
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
