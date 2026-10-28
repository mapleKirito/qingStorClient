'use strict';

/**
 * 客户端更新：检查最新版本 → 下载安装包 → 交给系统安装器。
 *
 * 纯 Node 模块，**不 require('electron')**：当前版本、平台、架构、下载目录全部由调用方
 * 传入，这样可以脱离 GUI 用 `node` 直接对着线上服务验证，也便于写单测。
 *
 * 不做静默自动替换：没有代码签名证书，程序替换自己必然被 SmartScreen / Gatekeeper 拦，
 * 体验比现在更差。下载完弹窗引导用户自己运行安装包是唯一靠谱的路径。
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

/** 内置更新服务地址（打包后即生效；联调时可用 QINGSTOR_UPDATE_BASE 覆盖） */
const DEFAULT_UPDATE_BASE = 'https://qingstorclient.myzhouye.com';
const DEFAULT_CHANNEL = 'stable';
const CHANNELS = new Set(['stable', 'dev']);
const CHECK_TIMEOUT_MS = 15000;

/** 渠道中文名，给界面与日志用 */
const CHANNEL_LABELS = { stable: '正式版', dev: '开发版' };

/* ---------------- 环境信息 ---------------- */

function resolveBase(explicit) {
  const raw = String(explicit || process.env.QINGSTOR_UPDATE_BASE || DEFAULT_UPDATE_BASE).trim();
  return raw.replace(/\/+$/, '');
}

function resolveChannel(explicit) {
  const c = String(explicit || process.env.QINGSTOR_UPDATE_CHANNEL || DEFAULT_CHANNEL).trim().toLowerCase();
  return CHANNELS.has(c) ? c : DEFAULT_CHANNEL;
}

/**
 * 更新渠道偏好：落在 userData/update-channel.json。
 *
 * 刻意不放进 config.json（S3 连接配置）——「清除连接配置」不该顺手把用户选的更新渠道重置掉，
 * 反过来改渠道也不该动到连接信息。初始值仍允许 QINGSTOR_UPDATE_CHANNEL 指定，一旦用户
 * 手动切换就以文件为准。
 */
class ChannelStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'update-channel.json');
    this.channel = resolveChannel();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const c = String(raw.channel || '').trim().toLowerCase();
      if (CHANNELS.has(c)) this.channel = c;
    } catch { /* 没有文件或内容坏了，保持默认 */ }
    return this.channel;
  }

  get() {
    return this.channel;
  }

  set(channel) {
    const c = String(channel || '').trim().toLowerCase();
    if (!CHANNELS.has(c)) throw new Error(`不支持的更新渠道：${channel}`);
    this.channel = c;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ channel: c }, null, 2), 'utf8');
    } catch { /* 落盘失败不该让切换失败，本次会话仍然生效 */ }
    return this.channel;
  }
}

/**
 * 「不再提醒此版本」记录：userData/update-muted.json
 *
 * 只记一个版本号：同一个版本被勾过忽略就不再自动弹窗，换新版本号会重新开始提醒。
 * 与 update-channel.json 分开，切换渠道不该顺带清掉用户的忽略选择。
 */
class MuteStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'update-muted.json');
    this.version = '';
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.version = String(raw.version || '').trim();
    } catch { /* 没有文件或内容坏了，视为未忽略任何版本 */ }
    return this.version;
  }

  get() {
    return this.version;
  }

  set(version) {
    this.version = String(version || '').trim();
    this.persist();
    return this.version;
  }

  clear() {
    this.version = '';
    this.persist();
    return this.version;
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ version: this.version }, null, 2), 'utf8');
    } catch { /* 落盘失败只影响下次启动是否再弹，不该阻断当前流程 */ }
  }
}

/** process.platform → 服务端认的 win / mac / linux */
function platformTag(p = process.platform) {
  if (p === 'win32') return 'win';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

/** process.arch → 服务端认的 x64 / arm64 / ia32 / armv7l */
function archTag(a = process.arch) {
  const s = String(a || '').toLowerCase();
  if (s === 'amd64' || s === 'x86_64') return 'x64';
  if (s === 'aarch64') return 'arm64';
  if (s === 'x86' || s === 'i386') return 'ia32';
  if (s === 'arm') return 'armv7l';
  return s;
}

/** 安装包落在 userData/updates/ 下 */
function defaultInstallDir(userDataDir) {
  return path.join(userDataDir, 'updates');
}

/* ---------------- 版本比较 ---------------- */

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/.exec(String(v || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] || '' };
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

/** 与服务端 compareVersion 同一套语义：预发布版恒小于同号正式版（1.2.0-beta < 1.2.0） */
function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePrerelease(x.pre, y.pre);
}

/* ---------------- 网络辅助 ---------------- */

/**
 * 更新 API 不做鉴权，客户端不带任何密钥头。
 * 安装包本身不是机密，写在客户端里的密钥也拦不住想提取的人 ——
 * 详见 server/README「为什么公网更新 API 不做鉴权」。
 */
function requestHeaders() {
  return { accept: 'application/json' };
}

/** 把 fetch 的底层错误翻译成用户能看懂的一句话（undici 把真实原因藏在 e.cause 里） */
function describeError(e) {
  const cause = e && e.cause;
  const msg = [
    String((e && e.message) || e || ''),
    String((cause && cause.message) || ''),
    String((cause && cause.code) || (e && e.code) || ''),
  ].join(' ');
  const name = e && e.name;
  if (name === 'TimeoutError' || /timeout/i.test(msg)) return '请求超时，请检查网络后重试';
  if (name === 'AbortError') return '已取消';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return '域名解析失败，请检查网络或 DNS';
  if (/ECONNREFUSED/i.test(msg)) return '连接被拒绝，更新服务可能未启动';
  if (/ECONNRESET|socket hang up/i.test(msg)) return '连接被重置，请稍后重试';
  if (/CERT|self-signed|UNABLE_TO_VERIFY/i.test(msg)) return '证书校验失败（代理或自签证书导致）';
  if (/fetch failed/i.test(msg)) return '网络请求失败，请检查网络或代理设置';
  return String((e && e.message) || e || '未知网络错误');
}

function absoluteUrl(base, u) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return base + (s.startsWith('/') ? s : '/' + s);
}

/* ---------------- 检查更新 ---------------- */

/**
 * GET /api/releases/latest?platform=win&arch=x64&channel=dev&current=1.0.0-dev
 *
 * 永远不抛异常：失败也返回 { ok:false, error }，调用方只管看 ok。
 * 服务端「该渠道没发过包」返回 latest:null / updateAvailable:false，这里照旧透出，
 * 不当成错误 —— 客户端刚上线、服务端还没发包是很正常的状态。
 */
async function checkForUpdates(opts = {}) {
  const base = resolveBase(opts.base);
  const channel = resolveChannel(opts.channel);
  const platform = platformTag(opts.platform);
  const arch = archTag(opts.arch);
  const current = String(opts.current || '').trim();
  const timeoutMs = Number(opts.timeoutMs) || CHECK_TIMEOUT_MS;

  const baseResult = { base, channel, platform, arch, current, latest: null, updateAvailable: false };

  let url;
  try {
    url = new URL(base + '/api/releases/latest');
    url.searchParams.set('platform', platform);
    url.searchParams.set('arch', arch);
    url.searchParams.set('channel', channel);
    if (current) url.searchParams.set('current', current);
  } catch {
    return { ...baseResult, ok: false, error: `更新服务地址不合法：${base}` };
  }

  let resp;
  try {
    resp = await fetch(url, {
      headers: requestHeaders(),
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ...baseResult, ok: false, error: describeError(e) };
  }

  let body;
  try {
    body = await resp.json();
  } catch {
    return {
      ...baseResult,
      ok: false,
      error: resp.ok ? '更新服务返回了非 JSON 内容' : `更新服务返回 HTTP ${resp.status}`,
    };
  }

  if (!resp.ok || !body || body.ok === false) {
    const msg = (body && (body.message || body.error)) || `更新服务返回 HTTP ${resp.status}`;
    return { ...baseResult, ok: false, error: String(msg) };
  }

  const rawLatest = body.latest || null;
  const latest = rawLatest
    ? {
        id: rawLatest.id,
        channel: rawLatest.channel || channel,
        version: String(rawLatest.version || '').trim(),
        platform: rawLatest.platform || platform,
        arch: rawLatest.arch || arch,
        fileName: String(rawLatest.fileName || '').trim(),
        size: Number(rawLatest.size) || 0,
        sha256: String(rawLatest.sha256 || '').trim().toLowerCase(),
        notes: String(rawLatest.notes || '').trim(),
        publishedAt: Number(rawLatest.publishedAt) || 0,
        downloadUrl: absoluteUrl(base, rawLatest.downloadUrl),
      }
    : null;

  // 服务端已经判过新旧，但客户端再按同一套语义算一次：
  // 服务端字段缺失 / 老版本服务端 / 代理改包时，仍然得到正确结论。
  let updateAvailable = false;
  if (latest && current) updateAvailable = compareVersion(latest.version, current) > 0;
  else if (latest) updateAvailable = body.updateAvailable === true;

  return {
    ok: true,
    base,
    channel,
    platform,
    arch,
    current,
    latest,
    upToDate: latest ? !updateAvailable : true,
    updateAvailable,
    checkedAt: Number(body.checkedAt) || Date.now(),
  };
}

/* ---------------- 下载安装包 ---------------- */

/** 文件名属于不可信输入：只取 basename 并剔掉路径分隔符、控制字符与引号 */
function safeFileName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["'`<>|:*?]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 120);
}

function fallbackFileName(latest) {
  const ext = latest.platform === 'win' ? '.exe' : latest.platform === 'mac' ? '.dmg' : '.AppImage';
  return `QingStorClient-${latest.version}-${latest.platform}-${latest.arch}${ext}`;
}

/**
 * 下载安装包到 dir，边下边算 sha256，与 latest.sha256 比对。
 *
 * 先写 `.part`，校验通过才改名 —— 半截文件绝不会以正式名留在磁盘上，
 * 否则用户双击一个未下载完的 exe 只会看到「文件损坏」。
 *
 * 进度回调 onProgress({ received, total, pct })，节流到 ~200ms 一次。
 */
async function downloadInstaller(opts = {}) {
  const latest = opts.latest;
  if (!latest || !latest.downloadUrl) {
    return { ok: false, error: '缺少安装包下载地址' };
  }
  const dir = opts.dir;
  if (!dir) return { ok: false, error: '缺少下载目录' };

  const fileName = safeFileName(latest.fileName) || fallbackFileName(latest);
  const finalPath = path.join(dir, fileName);
  const partPath = `${finalPath}.part`;
  const expected = String(latest.sha256 || '').trim().toLowerCase();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  fs.mkdirSync(dir, { recursive: true });

  let resp;
  try {
    resp = await fetch(latest.downloadUrl, {
      headers: requestHeaders(),
      redirect: 'follow',
      signal: opts.signal || AbortSignal.timeout(Number(opts.timeoutMs) || 30 * 60 * 1000),
    });
  } catch (e) {
    return { ok: false, error: describeError(e), filePath: null };
  }

  if (!resp.ok || !resp.body) {
    return { ok: false, error: `下载失败：HTTP ${resp.status}`, filePath: null };
  }

  const total = Number(resp.headers.get('content-length')) || Number(latest.size) || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partPath);
  let received = 0;
  let lastEmit = 0;

  try {
    for await (const chunk of resp.body) {
      received += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
      const now = Date.now();
      if (onProgress && now - lastEmit >= 200) {
        lastEmit = now;
        onProgress({ received, total, pct: total ? Math.min(100, Math.round((received / total) * 100)) : 0 });
      }
    }
    out.end();
    await finished(out);
  } catch (e) {
    try { out.destroy(); } catch { /* 忽略 */ }
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
    const aborted = (opts.signal && opts.signal.aborted) || (e && e.name === 'AbortError');
    return { ok: false, error: aborted ? '已取消' : describeError(e), filePath: null };
  }

  const actual = hash.digest('hex');
  if (expected && actual !== expected) {
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
    return { ok: false, error: `校验失败：sha256 不一致（期望 ${expected.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`, filePath: null };
  }
  if (total && received !== total) {
    await fs.promises.rm(partPath, { force: true }).catch(() => {});
    return { ok: false, error: `下载不完整：${received}/${total} 字节`, filePath: null };
  }

  try {
    await fs.promises.rm(finalPath, { force: true });
    await fs.promises.rename(partPath, finalPath);
  } catch (e) {
    return { ok: false, error: '安装包落盘失败：' + (e.message || e), filePath: null };
  }

  onProgress && onProgress({ received, total: total || received, pct: 100 });
  return { ok: true, filePath: finalPath, fileName, size: received, sha256: actual, version: latest.version };
}

module.exports = {
  DEFAULT_UPDATE_BASE,
  DEFAULT_CHANNEL,
  CHANNELS,
  CHANNEL_LABELS,
  ChannelStore,
  MuteStore,
  resolveBase,
  resolveChannel,
  platformTag,
  archTag,
  defaultInstallDir,
  parseVersion,
  compareVersion,
  checkForUpdates,
  downloadInstaller,
};
