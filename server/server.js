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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RELEASES_DIR, { recursive: true });

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
    published_ip  TEXT
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

const stmt = {
  insertRelease: db.prepare(`
    INSERT INTO releases (channel, version, platform, arch, file_name, file_path, size, sha256, notes, downloads, published_at, published_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `),
  overwriteRelease: db.prepare(`
    UPDATE releases SET file_name = ?, file_path = ?, size = ?, sha256 = ?, notes = ?, published_at = ?, published_ip = ?
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
  console.log('[init] 安装包目录：' + RELEASES_DIR);
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
  // 管理侧根路径额外给出入口提示：从隧道里敲根路径之后，知道下一步该点哪
  if (isAdmin) info.adminPage = '/admin';
  send(res, 200, info);
}

/** GET /api/health —— 给 nginx / 监控探活用，带发布数量与运行时长（用来判断库是否读得动） */
function handleHealth(req, res) {
  send(res, 200, {
    ok: true,
    service: 'qingstor-client-update',
    version: VERSION,
    releases: stmt.countReleases.get().n,
    uptime: Math.round(process.uptime()),
    checkedAt: Date.now(),
  });
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

/** GET /api/releases/download/:id —— 流式返回安装包，支持 Range */
function handleReleaseDownload(req, res, id) {
  const row = stmt.findReleaseById.get(id);
  if (!row) return fail(res, 404, '安装包不存在', 'NOT_FOUND');

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

  const baseHeaders = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-disposition':
      `attachment; filename="${asciiFileName(row.file_name)}"; ` +
      `filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    'x-release-version': row.version,
    'x-release-platform': row.platform,
    'x-release-arch': row.arch,
    'x-release-sha256': row.sha256,
    'cache-control': 'no-store',
  };

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

  const relDir = path.join(channel, version);
  const relPath = path.join(relDir, safeName);
  const absDir = path.join(RELEASES_DIR, relDir);
  const absPath = path.join(RELEASES_DIR, relPath);

  // 先按 Content-Length 拦一道：正常上传都会带这个头，能不读 body 就拒掉
  const declaredLen = Number(req.headers['content-length'] || 0);
  if (declaredLen > RELEASE_MAX_BYTES) {
    return fail(res, 413, `安装包超过上限 ${RELEASE_MAX_MB} MB`, 'TOO_LARGE');
  }

  fs.mkdirSync(absDir, { recursive: true });

  /**
   * 上传失败时的收尾：删掉半截文件，再尝试删掉空目录。
   * 目录可能本来就有（覆盖发布），所以 rmdir 失败是正常情况，直接忽略。
   * 不清理的话，每次失败的上传都会在 releases 下留一个空的版本目录。
   */
  const discardPartial = () => {
    try { fs.rmSync(absPath, { force: true }); } catch { /* ignore */ }
    try { fs.rmdirSync(absDir); } catch { /* 非空或不存在，忽略 */ }
  };

  const hash = crypto.createHash('sha256');
  const ws = fs.createWriteStream(absPath);
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

  let id;
  if (existing) {
    // 同一个「渠道+版本+平台+架构」重复发布按覆盖处理，顺手删掉旧文件，
    // 免得反复重发把磁盘堆满 —— 这也是自建服务比 GitHub Release 好用的地方：
    // dev 渠道可以无脑重发，不会留下十几个同版本号的垃圾。
    if (existing.file_path !== relPath) {
      try { fs.rmSync(path.resolve(RELEASES_DIR, existing.file_path), { force: true }); } catch { /* ignore */ }
    }
    stmt.overwriteRelease.run(safeName, relPath, size, sha256, notes || existing.notes, now, ip, existing.id);
    id = existing.id;
  } else {
    const r = stmt.insertRelease.run(
      channel, version, platform, arch, safeName, relPath, size, sha256, notes || null, now, ip
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
    releasesDir: RELEASES_DIR,
    releases: stmt.listReleases.all(limit, offset).map(releaseRowToJson),
  });
}

function adminDeleteRelease(req, res, id) {
  const row = stmt.findReleaseById.get(id);
  if (!row) return fail(res, 404, '发布记录不存在', 'NOT_FOUND');

  stmt.deleteRelease.run(id);
  const abs = path.resolve(RELEASES_DIR, row.file_path);
  try { fs.rmSync(abs, { force: true }); } catch { /* ignore */ }
  // 顺手清掉空掉的版本目录，失败无所谓
  try { fs.rmdirSync(path.dirname(abs)); } catch { /* ignore */ }

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
    });
  }

  if (p === '/api/admin/releases') {
    if (req.method === 'GET' || req.method === 'HEAD') return adminListReleases(req, res, url.searchParams);
    // PUT 是语义正确的写法；同时接受 POST，因为不少工具（Postman、各种 HTTP 库）
    // 默认就是 POST，硬性拒绝只会让人以为接口坏了
    if (req.method === 'PUT' || req.method === 'POST') return adminUploadRelease(req, res, url);
    return fail(res, 405, '该接口只接受 GET / PUT（也接受 POST）', 'BAD_METHOD');
  }

  const m = /^\/api\/admin\/releases\/(\d+)$/.exec(p);
  if (m && req.method === 'DELETE') return adminDeleteRelease(req, res, Number(m[1]));

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
  line('安装包目录', RELEASES_DIR);
  line('数据库', DB_FILE);
  line('TRUST_PROXY', TRUST_PROXY ? '1（采信 X-Forwarded-For）' : '0（用 socket 地址）');
  console.log('  ' + '-'.repeat(66));
  console.log('');
}

publicServer.on('error', (e) => {
  console.error(`[public] 监听 ${HOST}:${PORT} 失败：`, e.message);
  process.exit(1);
});

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
    });
    adminServer.listen(ADMIN_PORT, ADMIN_HOST, banner);
  } else {
    banner();
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
