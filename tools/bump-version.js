'use strict';

/**
 * 版本号工具 —— 唯一改版本的入口，同时更新 package.json 与 package-lock.json 两处
 *
 *   npm run version:bump -- show                 查看当前版本
 *   npm run version:bump -- x                    破坏性更新  1.2.3-dev -> 2.0.0-dev
 *   npm run version:bump -- y                    功能更新    1.2.3-dev -> 1.3.0-dev
 *   npm run version:bump -- z                    缺陷修复    1.2.3-dev -> 1.2.4-dev
 *   npm run version:bump -- dev                  递增已有开发号  1.2.3-dev -> 1.2.3-dev.1
 *                                                （对正式版报错，改用 z --dev）
 *   npm run version:bump -- release              去掉 -dev 转正式版  1.2.3-dev.2 -> 1.2.3
 *   npm run version:bump -- set 1.4.0-dev.3      指定精确版本（兜底用）
 *
 * 可选参数：
 *   --dry-run,-n   只打印结果，不写文件
 *   --dev          数字位递增后强制带 -dev 后缀
 *   --no-dev       数字位递增后强制去掉 -dev 后缀
 *   --commit,-c    改完自动提交（默认只改文件，提交由人决定）
 *   --force,-f     跳过分支名与标签的冲突校验
 *
 * 设计要点（对应 docs/VERSIONING.md）：
 * - 数字位递增后**默认保留 dev 状态**：从`1.2.3-dev`跑 z 得到 `1.2.4-dev`，
 *   不会意外把开发版变成正式版；要发布必须显式跑 `release`。
 * - **正式版不许直接跑 dev**：1.2.3 加 -dev 得到的 1.2.3-dev 比正式版更低，
 *   客户端判定「已是最新」，推上去没有任何正式版用户收得到。要从正式版进开发版用 z --dev。
 * - 只改 package-lock.json 里根两处 version，依赖自身的版本号一概不动（正则按缩进+原值精确定位，
 *   不整文件 JSON.stringify，避免 3800 行被重排）。
 * - 正式版发布过标签的号，release 会拒绝（正式版不允许覆盖重发）。
 * - 不做 git tag —— 打标签会触发 CI Release，必须由人确认。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const PKG = path.join(root, 'package.json');
const LOCK = path.join(root, 'package-lock.json');

/* ---------------- 版本号解析（与 electron/update.js、server/server.js 同语义） ---------------- */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

function parseVersion(s) {
  const m = VERSION_RE.exec(String(s || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] || '' };
}

function formatVersion(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.pre ? `${base}-${v.pre}` : base;
}

/** `dev.3` -> `dev`：新增版本号时开发序号从头计，但保留渠道词 */
function channelOf(pre) {
  return String(pre || '')
    .split('.')
    .filter((seg) => seg && !/^\d+$/.test(seg))
    .join('.');
}

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('-')).map((a) => a.replace(/^--?/, '')));
const positional = argv.filter((a) => !a.startsWith('-'));

const has = (...names) => names.some((n) => flags.has(n));
const dryRun = has('dry-run', 'n');
const autoCommit = has('commit', 'c');
const force = has('force', 'f');
const wantDev = has('dev');
const noDev = has('no-dev');

const ACTIONS = ['show', 'x', 'y', 'z', 'dev', 'release', 'set'];

function usage(msg) {
  if (msg) console.error(`✗ ${msg}\n`);
  console.log(`用法：npm run version:bump -- <动作> [参数]

动作：
  show                  查看当前版本
  x                     破坏性更新   x+1，y,z 归零
  y                     功能更新     y+1，z 归零
  z                     缺陷修复     z+1
  dev                   递增已有开发号（1.2.3-dev -> 1.2.3-dev.1 -> 1.2.3-dev.2）
                        对正式版会报错：请改用 z --dev（1.2.3 -> 1.2.4-dev）
  release               去掉 -dev 转正式版（1.2.3-dev.2 -> 1.2.3）
  set <版本号>          指定精确版本（如 set 1.4.0-dev.3）

参数：
  -n, --dry-run         只打印不写文件
      --dev             数字位递增后强制带 -dev
      --no-dev          数字位递增后强制去掉 -dev
  -c, --commit          改完自动提交
  -f, --force           跳过分支名 / 已发布标签的校验

示例：
  npm run version:bump -- z              # 发补丁：0.0.1-dev -> 0.0.2-dev
  npm run version:bump -- release        # 发布：0.0.2-dev -> 0.0.2
  npm run version:bump -- y --dev        # 开新版本：1.0.0 -> 1.1.0-dev
  npm run version:bump -- z --dev        # 从正式版进开发版：1.0.0 -> 1.0.1-dev
  npm run version:bump -- dev            # 本轮第二胎：1.1.0-dev -> 1.1.0-dev.1`);
  process.exit(msg ? 1 : 0);
}

/* ---------------- git 辅助 ---------------- */
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return String(r.stdout || '').trim();
}

function currentBranch() {
  return git(['rev-parse', '--abbrev-ref', 'HEAD']) || '';
}

function tagExists(tag) {
  return git(['tag', '-l', tag]) === tag;
}

/* ---------------- 读取当前版本 ---------------- */
let pkgText;
try {
  pkgText = fs.readFileSync(PKG, 'utf8');
} catch {
  console.error(`✗ 找不到 ${PKG}`);
  process.exit(1);
}
const pkg = JSON.parse(pkgText);
const current = String(pkg.version || '');
const cur = parseVersion(current);
if (!cur) {
  console.error(`✗ package.json 里的 version 不是合法版本号：${JSON.stringify(current)}`);
  process.exit(1);
}

/* ---------------- 计算目标版本 ---------------- */
const action = positional[0] || 'show';

if (!ACTIONS.includes(action)) usage(`未知动作「${action}」`);
if (action === 'show') {
  console.log(`当前版本：${current}`);
  const br = currentBranch();
  if (br) console.log(`当前分支：${br}`);
  console.log(`dev 渠道：${cur.pre ? '是' : '否（正式版）'}`);
  process.exit(0);
}

let next;
let verb;

if (action === 'set') {
  const raw = positional[1];
  const v = parseVersion(raw);
  if (!v) usage(`版本号格式不对：${JSON.stringify(raw || '')}（应形如 1.2.3 或 1.2.3-dev.1）`);
  next = formatVersion(v);
  verb = '指定版本';
} else if (action === 'dev') {
  if (!cur.pre) {
    // 正式版加 -dev 会变成更低的版本（1.0.0-dev < 1.0.0），客户端永远不会认作升级
    const bumped = `${cur.major}.${cur.minor}.${cur.patch + 1}-dev`;
    console.error(`✗ 当前是正式版 ${current}，直接加 -dev 会得到 ${current}-dev，比现在还低，客户端不会提示更新。`);
    console.error(`  要开下一轮开发请递增版本号：npm run version:bump -- z --dev   → ${bumped}`);
    process.exit(1);
  }
  {
    const segs = cur.pre.split('.');
    const last = segs[segs.length - 1];
    if (/^\d+$/.test(last)) {
      segs[segs.length - 1] = String(Number(last) + 1);
      next = `${cur.major}.${cur.minor}.${cur.patch}-${segs.join('.')}`;
      verb = '开发序号 +1';
    } else {
      next = `${cur.major}.${cur.minor}.${cur.patch}-${cur.pre}.1`;
      verb = '开发序号起步';
    }
  }
} else if (action === 'release') {
  if (!cur.pre) {
    usage(`当前已是正式版 ${current}，无需 release；要再发一版请用 z（补丁）或 y（功能）`);
  }
  next = `${cur.major}.${cur.minor}.${cur.patch}`;
  verb = '转正式版';
} else {
  // x / y / z
  const v = { major: cur.major, minor: cur.minor, patch: cur.patch, pre: cur.pre };
  if (action === 'x') {
    v.major += 1;
    v.minor = 0;
    v.patch = 0;
  } else if (action === 'y') {
    v.minor += 1;
    v.patch = 0;
  } else {
    v.patch += 1;
  }
  // 默认保留 dev 状态；--dev / --no-dev 可强制
  const ch = channelOf(cur.pre);
  const keepDev = noDev ? false : wantDev ? true : Boolean(ch);
  v.pre = keepDev ? ch || 'dev' : '';
  next = formatVersion(v);
  verb =
    action === 'x' ? '破坏性更新（x+1）' : action === 'y' ? '功能更新（y+1）' : '缺陷修复（z+1）';
}

const nextParsed = parseVersion(next);
if (!nextParsed) {
  console.error(`✗ 计算结果不合法：${next}`);
  process.exit(1);
}
if (next === current) {
  console.log(`· 版本号未变化：${current}`);
  process.exit(0);
}

/* ---------------- 校验 ---------------- */
const warnings = [];
const errors = [];

// 1) 版本号只能递增（set 除外，允许降级做回滚）
if (action !== 'set') {
  const cmp = compareVersion(next, current);
  if (cmp <= 0) errors.push(`目标版本 ${next} 不高于当前 ${current}`);
}

function compareVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] - y[k];
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return comparePrerelease(x.pre, y.pre);
}

/** SemVer 2.0 第 11 条：数字段按数值比较，数字段优先级低于字母段 */
function comparePrerelease(a, b) {
  const as = String(a).split('.');
  const bs = String(b).split('.');
  for (let i = 0; i < Math.max(as.length, bs.length); i += 1) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) - Number(y);
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

// 2) 分支名与版本前两位一致（docs/VERSIONING.md 9.1 约束 3）
const branch = currentBranch();
const bm = /^ver\/(\d+)\.(\d+)$/.exec(branch);
if (bm) {
  const same = Number(bm[1]) === nextParsed.major && Number(bm[2]) === nextParsed.minor;
  if (!same) {
    const msg =
      `当前在版本线 ${branch}，但目标版本是 ${next}（前两位 ${nextParsed.major}.${nextParsed.minor}）\n` +
      `  版本线只能承载自己 x.y 的版本；开新版本请先回 main 再拉 ver/${nextParsed.major}.${nextParsed.minor}`;
    if (force) warnings.push(msg);
    else errors.push(msg);
  }
}

// 3) 正式版不允许覆盖重发（docs/VERSIONING.md 第 4 节）
if (!nextParsed.pre) {
  if (tagExists(`v${next}`)) {
    const msg = `标签 v${next} 已存在：正式版不允许覆盖重发（已装该版的用户 current==latest，永远收不到新包）。要再发一版请把版本号提到更高的 z`;
    if (force) warnings.push(msg);
    else errors.push(msg);
  }
}

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error('\n未做任何修改。确认要这样做请加 --force。');
  process.exit(1);
}

/* ---------------- 写入 ---------------- */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 只替换根两处 version，依赖自身的版本号一律不动 */
function patchLock(text, from, to) {
  let out = text;
  let hits = 0;
  // 顶层：2 空格缩进
  const topRe = new RegExp(`(\\n {2}"version": )"${escapeRe(from)}"`);
  if (topRe.test(out)) {
    out = out.replace(topRe, `$1"${to}"`);
    hits += 1;
  }
  // packages[""]：6 空格缩进（依赖条目也是 6 空格，但值不同，靠原值精确匹配）
  const pkgRe = new RegExp(`(\\n {6}"version": )"${escapeRe(from)}"`);
  if (pkgRe.test(out)) {
    out = out.replace(pkgRe, `$1"${to}"`);
    hits += 1;
  }
  return { text: out, hits };
}

const nextPkgText = pkgText.replace(
  /("version"\s*:\s*)"[^"]*"/,
  `$1"${next}"`
);

const hasLock = fs.existsSync(LOCK);
let nextLockText = '';
if (hasLock) {
  const raw = fs.readFileSync(LOCK, 'utf8');
  const lockJson = JSON.parse(raw);
  // 以 package.json 为准，但定位 lock 里的旧值必须用 lock 自己的版本（两文件可能已经不同步）
  const lockFrom = String(lockJson.version || '');
  const lockPkgFrom = String(lockJson.packages?.['']?.version || '');
  if (lockFrom !== current || lockPkgFrom !== current) {
    warnings.push(
      `package-lock.json 的版本（${lockFrom || '空'} / packages[""] ${lockPkgFrom || '空'}）` +
        `与 package.json（${current}）不一致，已一并改成 ${next}；建议随后 npm install 复核`
    );
  }
  // 两处旧值可能不同步，分别用自己的旧值定位
  let patched = patchLock(raw, lockFrom, next);
  if (patched.hits < 2 && lockPkgFrom && lockPkgFrom !== lockFrom) {
    const second = patchLock(patched.text, lockPkgFrom, next);
    patched = { text: second.text, hits: patched.hits + second.hits };
  }
  nextLockText = patched.text;
  if (patched.hits !== 2) {
    console.error(
      `✗ package-lock.json 只匹配到 ${patched.hits} 处 version（应为 2 处），已中止，未修改任何文件。\n` +
        `  顶层=${JSON.stringify(lockFrom)}，packages[""]=${JSON.stringify(lockPkgFrom)}。\n` +
        '  lock 结构可能变了：请手动改 package-lock.json 根两处，或删掉它重新 npm install。'
    );
    process.exit(1);
  }
}

// 写前先自检：解析结果必须正确，避免写出坏文件
const checkPkg = JSON.parse(nextPkgText);
if (checkPkg.version !== next) {
  console.error(`✗ 自检失败：package.json 解析出 ${checkPkg.version}，期望 ${next}`);
  process.exit(1);
}
if (hasLock) {
  const checkLock = JSON.parse(nextLockText);
  if (checkLock.version !== next || checkLock.packages?.['']?.version !== next) {
    console.error('✗ 自检失败：package-lock.json 根两处 version 不一致');
    process.exit(1);
  }
}

const arrow = `${current}  →  ${next}`;
if (dryRun) {
  console.log(`(dry-run) ${verb}`);
  console.log(`  ${arrow}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  console.log('  未写入任何文件');
  process.exit(0);
}

fs.writeFileSync(PKG, nextPkgText);
if (hasLock) fs.writeFileSync(LOCK, nextLockText);

/* ---------------- 结果 ---------------- */
console.log(`✓ ${verb}`);
console.log(`  ${arrow}`);
console.log(`  文件：package.json、package-lock.json（根两处）`);
if (branch) console.log(`  分支：${branch}`);
for (const w of warnings) console.log(`  ! ${w}`);

// 后续动作提示
const line = console.log;
line('');
if (nextParsed.pre) {
  const xy = `${nextParsed.major}.${nextParsed.minor}`;
  const isInitial = nextParsed.major === 0 && nextParsed.minor === 0;
  line('  开发版下一步：');
  if (isInitial) {
    // 0.0.x 是初始开发版：不建版本线、不推 CI，直接在 main 上手动构建（docs/VERSIONING.md 1.3.1）
    line('    初始开发版阶段：不建版本线、不推 CI，提交后在 main 上手动构建');
    line('    npm run dist:win');
  } else {
    if (!bm) line(`    git checkout -b ver/${xy} && git push -u origin ver/${xy}    # 触发开发包构建`);
    else line(`    git push origin ${branch}    # 触发开发包构建`);
    line('    npm run dist:win    # 或本机手动构建');
  }
} else {
  line('  正式版下一步：');
  line(`    git add package.json package-lock.json && git commit -m "chore(release): ${next}"`);
  line(`    git tag -a v${next} -m "QingStorClient ${next}"`);
  line(`    git push origin ${branch || 'main'} v${next}    # 推送并打标签 → CI 出 Release`);
  if (bm) {
    line(`    git checkout main && git merge --no-ff ${branch}    # main 保持最新正式版`);
  } else {
    line('    （已在 ' + (branch || 'main') + '，无需合并；确认 tag 落在该分支上）');
  }
  line('    上传安装包到更新服务 stable 渠道');
}

if (autoCommit) {
  console.log('');
  const msg = nextParsed.pre ? `chore(version): ${next}` : `chore(release): ${next}`;
  const files = hasLock ? ['package.json', 'package-lock.json'] : ['package.json'];
  const add = spawnSync('git', ['add', ...files], { cwd: root, stdio: 'inherit' });
  if (add.status !== 0) process.exit(add.status || 1);
  const commit = spawnSync('git', ['commit', '-m', msg], { cwd: root, stdio: 'inherit' });
  process.exit(commit.status || 0);
}
