'use strict';

/**
 * 对象存储 key 与本地文件系统路径之间的安全转换（自 Python 版移植）。
 *
 * 对象 key 段可含任意字符，而本地（尤其 Windows）文件名有诸多限制；
 * 这里做**可逆**百分号编码，保证上传/下载来回不丢失信息。
 *
 * 编码按平台自适应：
 * - Windows：严格规则（非法字符、控制字符、结尾空格/点、保留名）；
 * - macOS / Linux：宽松规则，仅编码 '%' 与 NUL，尽量保留原生文件名。
 * 解码侧始终统一，因此任一平台下载的文件都能正确还原为远程 key。
 */

const WIN_UNSAFE = new Set('\\/:*?"<>|');
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function isWindows() {
  return process.platform.startsWith('win');
}

function isReserved(name) {
  const base = name.split('.', 1)[0].toUpperCase();
  return RESERVED.has(base);
}

const hex = (code) => '%' + code.toString(16).toUpperCase().padStart(2, '0');

/** 单个 key 段 -> 本地安全文件名（可逆）。strict 省略时按当前平台。 */
function encodeSegment(seg, strict) {
  if (seg === '') return seg;
  if (strict === undefined) strict = isWindows();

  let out = '';
  if (!strict) {
    // POSIX：仅 NUL 与 '%' 需编码
    for (const ch of seg) {
      if (ch === '%') out += '%25';
      else if (ch.charCodeAt(0) === 0) out += '%00';
      else out += ch;
    }
    return out;
  }

  // Windows 严格规则
  for (const ch of seg) {
    const code = ch.charCodeAt(0);
    if (ch === '%') out += '%25';
    else if (WIN_UNSAFE.has(ch) || code < 0x20) out += hex(code);
    else out += ch;
  }
  // 结尾空格/点：逐字符编码
  const m = out.match(/[ .]+$/);
  if (m) {
    out = out.slice(0, m.index) + [...m[0]].map((c) => hex(c.charCodeAt(0))).join('');
  }
  // 保留名：编码首字符使其不再是保留名且可逆
  if (out && isReserved(out)) {
    out = hex(out.charCodeAt(0)) + out.slice(1);
  }
  return out;
}

/** 本地安全文件名 -> key 段（平台无关，统一解码）。 */
function decodeSegment(seg) {
  return seg.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** 用 '/' 拼接 key 段，自动去掉空段与多余斜杠。 */
function joinKey(...parts) {
  const cleaned = [];
  for (const p of parts) {
    if (p === null || p === undefined) continue;
    for (const seg of String(p).split('/')) {
      if (seg !== '') cleaned.push(seg);
    }
  }
  return cleaned.join('/');
}

function splitKey(key) {
  return String(key || '').split('/').filter((s) => s !== '');
}

/** 父目录 key（不含末尾斜杠），根返回空串。 */
function parentKey(key) {
  const parts = splitKey(key);
  return parts.slice(0, -1).join('/');
}

function basename(key) {
  const parts = splitKey(key);
  return parts.length ? parts[parts.length - 1] : '';
}

/** 去掉 key 的 prefix 部分，返回相对路径。 */
function stripPrefix(key, prefix) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  if (p && key.startsWith(p + '/')) return key.slice(p.length + 1);
  if (p && key === p) return '';
  return key;
}

/** 给相对路径补上 prefix。 */
function addPrefix(rel, prefix) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  const r = String(rel || '').replace(/^\/+|\/+$/g, '');
  return p ? joinKey(p, r) : r;
}

const path = require('node:path');

/** 对象 key（相对 prefix）映射到本地安全路径。 */
function keyToLocalPath(key, localRoot) {
  const parts = splitKey(key).map((p) => encodeSegment(p));
  return parts.length ? path.join(localRoot, ...parts) : localRoot;
}

/** 本地路径（在 localRoot 之下）映射回对象 key（含 prefix）。 */
function localPathToKey(localPath, localRoot, prefix) {
  const rel = path.relative(localRoot, localPath);
  const segs = rel.split(/[\\/]/).filter((s) => s && s !== '.');
  return addPrefix(segs.map(decodeSegment).join('/'), prefix);
}

/** 规范化目录 key：确保以 '/' 结尾（空串表示根）。 */
function dirKey(key) {
  const k = joinKey(key);
  return k ? k + '/' : '';
}

module.exports = {
  encodeSegment,
  decodeSegment,
  joinKey,
  splitKey,
  parentKey,
  basename,
  stripPrefix,
  addPrefix,
  keyToLocalPath,
  localPathToKey,
  dirKey,
};
