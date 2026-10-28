# QingStorClient

青云对象存储（QingStor / S3 兼容）桌面客户端。网盘式浏览桶内文件与目录，支持多选、文件夹上传/下载、拖拽上传、传输队列与断点取消。

> 当前版本 **0.0.1-dev**（处于 v0.0.x 开发期，只出开发包、不打正式标签）：已从 Python + PyQt 实现整体迁移到 Electron，架构与打包方式对齐 `myApiTools`。

## 功能特性

- 目录浏览：面包屑导航、`.` / `..` 占位行、多选（单击 / Ctrl / Shift / 全选）、右键菜单
- 上传：多选文件、整个文件夹（保留层级）、拖拽文件与文件夹（取真实本地路径）
- 下载：多文件 / 整个目录递归下载，落盘时按平台规则安全转义非法字符
- 传输队列：最多并发 2 个任务，实时进度、逐文件进度、可取消、可清理已完成
- 连接配置：Endpoint / Region / AccessKey / SecretKey / Bucket / 前缀 / 是否校验 SSL，落盘到 `userData/config.json`（密钥 base64 轻混淆，不随仓库分发）

## 技术架构

| 层 | 说明 |
| --- | --- |
| 主进程 `electron/` | CommonJS，负责 S3 访问、配置持久化、传输调度、原生菜单与对话框 |
| 渲染进程 `renderer/` | 原生 ES Module + 原生 CSS，零构建步骤（无 webpack/vite） |
| 进程通信 | `preload.js` 通过 `contextBridge` 暴露最小化 `bridge` API，`contextIsolation: true` / `nodeIntegration: false` |
| 页面加载 | 自定义 `app://bundle` 特权协议，让渲染进程能用原生 ESM（`file://` 下不行） |
| S3 SDK | `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`（分片上传、进度、AbortController 取消） |

```
electron/
  main.js        应用生命周期、窗口、菜单、IPC、app:// 协议
  preload.js     contextBridge 白名单 API
  config.js      配置读写（userData/config.json）
  s3.js          S3 封装：列举/新建/删除/上传/下载/连接测试
  transfers.js   传输队列（并发 2、进度节流推送、取消）
  update.js      版本更新：渠道偏好（stable/dev）、检查最新版、下载安装包（sha256 校验），纯 Node
  names.js       key ↔ 本地路径的可逆转义（Windows 严格 / POSIX 宽松）
renderer/
  index.html     单页外壳
  css/app.css    深色主题
  js/main.js     目录渲染、选择、拖拽、传输面板
  js/util.js     格式化、toast、弹窗、右键菜单
tools/
  run-electron.js  启动器（剥离 ELECTRON_RUN_AS_NODE / NODE_OPTIONS）
  dist-win.ps1     Windows 打包脚本（镜像 + 预解压 Electron + 临时输出目录）
  bump-version.js  版本号工具（npm run version:bump，同步两个文件并自检）
server/              版本更新服务（独立部署，零 npm 依赖，见 server/README.md）
  server.js        更新 API + 管理端，两个监听端口
  admin.html       管理页（上传/列表/删除）
  docker-publish.sh 镜像发布：一次构建，标签自动识别，同时推 Docker Hub 与阿里云 ACR
  docker-publish.ps1  同上，Windows / PowerShell 版（参数一一对应）
  deploy/          nginx 配置、Docker、部署文档
.github/workflows/build.yml  三平台构建与 Release
```

## 本地开发

```bash
npm install
npm start          # 启动应用
npm run smoke      # 冒烟测试：启动 → 加载界面 → 2.5s 后按有无渲染错误决定退出码
```

> 不要直接用 `electron .`。很多宿主环境（IDE 终端、CI、容器）会预设 `ELECTRON_RUN_AS_NODE=1`，这会让 `electron.exe` 退化成普通 Node 进程，报 `Cannot read properties of undefined (reading 'whenReady')`。`npm start` 已通过 `tools/run-electron.js` 剥掉该变量。

## 本地打包（Windows）

```bash
npm run dist:win
```

产物在 `dist/`：

- `QingStorClient-Setup-0.0.1-dev-x64.exe` —— NSIS 安装版（可选安装目录、创建快捷方式）
- `QingStorClient-0.0.1-dev-x64.exe` —— 免安装便携版

为什么不用 `npx electron-builder --win` 直接打：`tools/dist-win.ps1` 解决了两个本地必然会踩的坑。

1. **EPERM: operation not permitted** —— electron-builder 先解压到 `win-unpacked.tmp` 再重命名，腾讯电脑管家一类的实时防护会短暂占用刚解压的 `.exe/.dll` 句柄导致重命名失败。脚本把已解压好的 Electron 通过 `--config.electronDist=` 注入，让它走 copyDir 分支（无 `.tmp`、无重命名），并且输出到 `%LOCALAPPDATA%\Temp\qingStorClient-dist`，成功后再回拷 `dist/`。
2. **下载超时** —— 脚本内设置 `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` 走 npmmirror。

> `electron-builder.yml` 里**故意不写** `electronDist`：它是全局配置，会同时作用于 mac/linux，而 `node_modules/electron/dist` 只有当前平台的运行时。硬编码会导致 mac 上打 x64 包却塞进 arm64 二进制、CI 三平台各自错乱。本地注入、CI 交给 electron-builder 按平台下载。

mac / linux 打包需在对应系统上执行（`npm run dist:mac` / `dist:linux`），交叉编译不可靠。

## 版本与发布

> 完整规范见 **[docs/VERSIONING.md](docs/VERSIONING.md)**（版本位判定、分支生命周期、标签规则、发版/热修复全流程、检查清单）。本节只做速查，两者冲突时以 `docs/VERSIONING.md` 为准。

版本号写在 `package.json` 的 `version`，Electron 侧通过 `app.getVersion()` 展示在状态栏。**所有触发方式都围绕这一个字段**，不要在别处再维护版本号。

**改版本号用脚本，不要手改文件**（它同步改 `package.json` 与 `package-lock.json` 根两处，写完自检）：

```bash
npm run version:bump -- show       # 当前版本 / 分支 / 是否 dev
npm run version:bump -- x          # 破坏性更新   1.2.3-dev -> 2.0.0-dev
npm run version:bump -- y          # 功能更新     1.2.3-dev -> 1.3.0-dev
npm run version:bump -- z          # 缺陷修复     1.2.3-dev -> 1.2.4-dev
npm run version:bump -- dev        # 开发序号 +1  1.2.3-dev -> 1.2.3-dev.1
npm run version:bump -- release    # 转正式版     1.2.3-dev.1 -> 1.2.3
npm run version:bump -- z --dev    # 从正式版进开发版  1.2.3 -> 1.2.4-dev
```

数字位递增**默认保留 `-dev`**（开发版不会意外变成正式版），发布必须显式跑 `release`；加 `-n` 只看不写，`-c` 改完自动提交。

**`dev` 动作只递增已有开发号**，对正式版会报错——`1.2.3` 加 `-dev` 得到的 `1.2.3-dev` 比正式版还低，客户端判定「已是最新」，推上去没人收得到。要从正式版进下一轮开发，用 `z --dev`（或 `y --dev` / `x --dev`）。完整规则见 [`docs/VERSIONING.md`](docs/VERSIONING.md#15-改版本号的操作规程)。

### 版本阶段与分支约定（v0.0.x 开发期）

当前版本是 `0.0.1-dev`，属于 **v0.0.x 开发期**。这个阶段的规则和正式版不一样：

| | v0.0.x 开发期（现在） | 正式版（以后） |
| --- | --- | --- |
| 版本号 | `0.0.x-dev`，当前 `0.0.1-dev`（z 当开发迭代号用） | `x.y.z`，如 `1.0.0` |
| 分支 | **无版本分支**：直接提交 `main`，本机手动构建 | `ver/<x.y>`，如 `ver/1.0`（不带 patch） |
| 打标签 | **不打**，没有正式发布计划 | 打 `v*` 标签 → 自动 Release |
| 下发渠道 | 服务端 `channel=dev` | 服务端 `channel=stable` |

几条配套约定：

- **同版本反复重发是允许的**。服务端对「渠道 + 版本 + 平台 + 架构」采用覆盖语义，所以开发期改完直接重发 `0.0.1-dev` 即可，不必为了重发去 bump 版本号；要区分「第几次构建」再加序号（`0.0.1-dev.1`、`-dev.2`……，序号无上限）。
- **开发包进服务端要打 `channel=dev`**，客户端把右下角渠道徽标切到「开发版」才能收到（默认是 `stable`）。
- **别随手打 `v*` 标签**。CI 的守卫要求标签名去掉 `v` 后与 `version` 严格相等，`0.0.1-dev` 要打就得打成 `v0.0.1-dev`；而且一旦打标签就会触发 Release，与「v0.0.x 不正式发布」冲突。
- 客户端 `parseVersion` / 服务端 `parseVersion` 都认带 `-pre` 后缀的版本，预发布段按 SemVer 2.0 逐段比较（数字段按数值比，`dev.9 < dev.10`），预发布版恒小于同号正式版。

### 三档触发规则

| 动作 | 产物性质 | 结果 |
| --- | --- | --- |
| 推 `v*` 标签（如 `v1.0.0`） | **正式包** | 三平台构建 → 自动创建 GitHub Release，安装包直接挂在页面上 |
| 推 `ver/**` 分支（如 `ver/1.0`） | **开发包** | 三平台构建 → 只留在 Actions artifacts（保留 14 天），不发 Release |
| 手动 Run workflow | **开发包** | 同上，适合验证任意提交而不污染版本历史 |

开发包和正式包用的是同一份 `electron-builder.yml`、同一条构建命令，区别只在**有没有创建 Release**——判定条件就是 `release` job 的 `if: startsWith(github.ref, 'refs/tags/')`。所以开发包验证通过后再打标签，行为完全可预期。

### 正式发版

> v0.0.x 开发期**不执行这一节**（不打标签）。以下是将来有正式发布计划时的流程。

```bash
# 0. 前置：功能已冻结，开发包在目标平台验证通过
# 1. 在版本线上把版本号定为正式版（只去掉 -dev 后缀，不升位）
git checkout ver/1.0
npm run version:bump -- release          # 1.0.0-dev -> 1.0.0
git commit -am "chore(release): 1.0.0"
git push origin ver/1.0

# 2. 打标签并推送（这一步才真正触发发布，CI 会校验 tag 与 version 严格相等）
git tag -a v1.0.0 -m "QingStorClient 1.0.0"
git push origin v1.0.0

# 3. 合并进 main，让 main 永远等于最新正式版
git checkout main && git pull
git merge --no-ff ver/1.0
git push origin main

# 4. 校验 tag 已进入 main
git merge-base --is-ancestor v1.0.0 main && echo OK

# 5. Release 出包 → 下载 → 上传更新服务 stable 渠道
# 6. 版本线保留，后续 z 补丁（1.0.1）继续在同一条分支上做，分支名不变
#    （前提：该线仍是最新版本线；一旦开了 ver/1.1，1.0 即终止维护，不再出补丁）
```

- 标签名含 `-`（如 `v1.1.0-beta.1`）自动标记为 prerelease，不会顶掉 `latest`
- CI 有版本守卫：标签名去掉 `v` 后必须严格等于 `package.json` 的 `version`，不一致直接失败（避免「v1.0.0 的 Release 里挂着 1.0.0-dev 的包」）
- `version` 里带 `-dev.N` / `-beta.N` 后缀时，产物文件名也会带上，方便区分开发版与正式版
- **正式版发出去就不能覆盖重发**（老用户 `current == latest`，永远收不到），有问题只能升 z 发新版本
- **只给当前最新版本线打标签**：旧版本线一旦被下一个 `x.y` 取代就终止维护，不再出补丁、不再打任何 `v*` 标签

### 开新版本 / 打开发包（不占版本号）

```bash
# 1. 定目标版本：加功能 → y+1；破坏性变更 → x+1；z 从 0 起
# 2. 从 main 拉版本线（分支名只带 x.y，不带 patch）
git checkout main && git pull
git checkout -b ver/1.1
# 3. 版本号改成 x.y.0-dev（脚本同步 package.json 与 package-lock.json）
npm run version:bump -- y --dev          # 1.0.0 -> 1.1.0-dev
git commit -am "chore: 开启 1.1.0 开发"
# 4. 推送触发构建，产物在 Actions 页面下载
git push -u origin ver/1.1
```

开发期内版本号不用动：同一目标版本反复构建都用 `1.0.0-dev`，需要区分构建轮次再加序号（`1.0.0-dev.1`）。临时功能分支用 `feat/`、`fix/`、`chore/` 前缀，推送不触发构建，完成后再合进版本线。

**同一时刻只维护一条版本线。** `ver/1.1` 一旦创建，`ver/1.0` 就终止维护——不删、历史保留，但不再接收提交、不出补丁、不打标签。缺陷修复永远落在当前最新的 `ver/x.y` 上；老用户报的旧版本问题，先在新版本确认，仍存在就按 `z+1` 修在新版本里。详细理由与禁止事项见 [`docs/VERSIONING.md` 第 5.5 节](docs/VERSIONING.md)。

**当前 `0.0.1-dev` 是初始开发版，不走上面这条路径。** 它直接住在 `main` 上：没有版本分支、不推 CI、不打标签，产物在**本机手动构建**：

```bash
npm run dist:win      # Windows：NSIS 安装版 + 便携版
npm run dist:mac      # macOS
npm run dist:linux    # Linux
```

产物落在 `dist/`，文件名带版本号（`QingStorClient-Setup-0.0.1-dev-x64.exe`、`QingStorClient-0.0.1-dev-x64.exe`），可直接分发给测试，或上传更新服务 `dev` 渠道。等出现第一个正式版本计划时，才从 `main` 拉 `ver/x.y` 按上面的流程走，详见 [`docs/VERSIONING.md` 1.3.1](docs/VERSIONING.md)。

## 版本更新服务（`server/`）

除了 GitHub Release，仓库里还带了一个自建的更新服务，用于「渠道隔离 + 同版本可覆盖重发 + sha256 校验」这三件 GitHub Release 做不了的事。零 npm 依赖，`node server.js` 直接跑，部署细节见 [server/README.md](server/README.md) 与 [server/deploy/README.md](server/deploy/README.md)。

它的核心设计是**两个独立监听端口**，而不是一个端口按路径分流：

| | 公网口（默认 8787 / 部署 8789） | 管理口（默认 8788 / 部署 8790） |
| --- | --- | --- |
| 绑定 | `0.0.0.0`，由 nginx 反代并终止 HTTPS | `127.0.0.1`，只能走 SSH 隧道 |
| 路径 | `/`、`/api/health`、`/api/releases/latest`、`/api/releases/download/:id` | `/`、`/admin`、`/api/admin/*` |
| 其余 | 一律 404 | 一律 404 |

单端口方案只能靠"判断来源是不是回环 IP"保护管理端，一上 nginx 所有请求来源都变成 `127.0.0.1`，这道判断直接失效。拆成两个端口后，公网侧在物理上就不接受管理请求。

安装包默认存在 `server/data/releases`（`local` 驱动）。也可以设 `STORAGE_DRIVER=s3` 切到对象存储：本地只留版本索引，下载时 302 跳到短时预签名地址（默认 5 分钟）。两种驱动可以共存——每条记录自带 `storage` 字段，切换后存量包仍按各自的位置下载。配置与权限建议见 [server/README.md](server/README.md) 的「对象存储」一节。

日常发布：

```bash
# 1. 在自己的电脑上开隧道（公网没有任何入口能到管理端）
ssh -N -L 8790:127.0.0.1:8790 user@your-server

# 2. 浏览器打开 http://127.0.0.1:8790/admin，粘贴服务端 data/admin-token.txt 里的令牌
# 3. 选安装包 → 从文件名自动填充版本/平台/架构 → 上传
```

客户端已经接入这个服务，更新服务的公网地址**内置在客户端里**：

> `electron/update.js` → `DEFAULT_UPDATE_BASE = 'https://qingstorclient.myzhouye.com'`
>
> 联调别的环境时不用改代码，设 `QINGSTOR_UPDATE_BASE` 环境变量即可覆盖；渠道默认 `stable`，可在客户端界面里切换（见下方[渠道切换](#渠道切换stable--dev)），也可用 `QINGSTOR_UPDATE_CHANNEL` 指定初始值。更新 API 不做鉴权，客户端不带任何密钥头。

接口形态（客户端发出的请求就是这一条）：

```bash
curl "https://qingstorclient.myzhouye.com/api/releases/latest?platform=win&arch=x64&channel=dev&current=0.0.1-dev"
# → { "updateAvailable": true, "latest": { "version": "0.0.2-dev", "sha256": "...", "downloadUrl": "..." } }
```

客户端的更新行为：

| 时机 | 行为 |
| --- | --- |
| 启动后约 6 秒 | 静默探一次，**只有发现新版**才在状态栏标 `v0.0.1-dev → v0.0.2-dev 可更新` 并轻提示；网络不通则一声不响 |
| 点右下角版本号 / 菜单「帮助 → 检查更新…」 | 主动检查，失败会明确报错 |
| 发现新版 | 弹窗展示版本号、大小、更新时间与发版说明，由用户决定是否下载 |
| 下载 | 落到 `userData/updates/<渠道>/`，先写 `.part`，边下边算 sha256，与接口返回的 `sha256` 比对通过才改名；可取消、进度实时 |
| 下载完成 | **不静默替换自己**，弹窗询问是否立即运行安装程序（无签名，程序替换自己必被 SmartScreen / Gatekeeper 拦） |

平台与架构取自 `process.platform` / `process.arch`，自动归一化成服务端认的 `win|mac|linux` 与 `x64|arm64|ia32|armv7l`。mac 的 arm64 与 x64 是两份包，传错架构会下载到跑不起来的安装包，所以这两个参数不做兜底猜测。

### 渠道切换（stable / dev）

服务端按 `channel` 隔离两条渠道，客户端自己就能切：

| 入口 | 说明 |
| --- | --- |
| 状态栏渠道徽标 | 右下角 `stable` / `dev` 小徽标，点一下弹出两条渠道，当前项打勾 |
| 菜单「帮助 → 更新渠道」 | 与徽标同一份状态，radio 勾选 |

切换之后：

- **立刻按新渠道重新检查一次**，状态栏的版本提示、`可更新` 标记全部换成该渠道的结果，旧渠道的「可更新」状态不会残留；
- 偏好写在 `userData/update-channel.json`，与 S3 连接配置（`config.json`）分开——「清除连接配置」不会把渠道重置，改渠道也不会动连接信息；
- 安装包按渠道分目录：`userData/updates/stable/`、`userData/updates/dev/`，两条渠道的同号包不会互相覆盖；
- 初始值可由 `QINGSTOR_UPDATE_CHANNEL` 指定，用户手动切换后以文件为准。

> dev 渠道发 `2.1.0-dev.3` 会被同号正式版顶掉吗？不会。版本比较沿用服务端语义：**预发布版恒小于同号正式版**（`2.1.0-dev.3 < 2.1.0`），但高于低号正式版（`2.1.0-dev.3 > 2.0.0`）。所以 dev 包能正常提示更新，也抢不走 stable 的版本；渠道隔离本身由 `channel` 参数完成。

## 跨平台产物

| 平台 | 产物 | 说明 |
| --- | --- | --- |
| Windows x64 | `.exe`（安装版 / 便携版） | 未签名，首次运行 SmartScreen 提示点「更多信息 → 仍要运行」 |
| macOS x64 + arm64 | `.dmg` × 2 | 未签名未公证，首次打开被 Gatekeeper 拦截，见下方[对应章节](#macos-安装包首次打开被拦gatekeeper) |
| Linux x64 | `.AppImage` / `.deb` | AppImage 需 `chmod +x`；deb 用 `sudo apt install ./xxx.deb` |

## macOS 安装包首次打开被拦（Gatekeeper）

**现象**：从浏览器下载 DMG，把 `.app` 拖进「应用程序」后双击，弹出「无法验证开发者」，只有「移到废纸篓」和「取消」两个按钮，**右键「打开」也绕不过**。

**原因**：两件事叠加，缺一不可解。

1. 打包侧没有任何 Apple 开发者证书 —— `build.yml` 里 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`、`electron-builder.yml` 里 `mac.identity: null`，所以 App 既没有 Developer ID 签名，也没有经过 Apple 公证（notarization）。
2. 下载侧 —— 浏览器下载的文件带 `com.apple.quarantine` 隔离属性，macOS 对「已隔离 + 未签名/未公证」的应用直接拒绝启动。

这是 Gatekeeper 的正常行为，不是安装包损坏。

**放行（二选一，一次即可）**：

```bash
xattr -cr /Applications/QingStorClient.app
```

或：系统设置 → 隐私与安全性 → 底部点「仍要打开」。

**Windows 对照**：Windows 侧是同一类限制的弱化版 —— 未签名触发 SmartScreen「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可，不像 macOS 那样需要命令行。

**彻底解决**（可选，需要付费 Apple Developer Program）：在 CI 里注入 `CSC_LINK` / `CSC_KEY_PASSWORD` 做 Developer ID 签名，再用 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 走 notarize，用户下载后即开即用。

## 已知边界

- **无代码签名**：mac 未公证、Windows 未签名，用户首次打开需手动放行，详见 [macOS 安装包首次打开被拦（Gatekeeper）](#macos-安装包首次打开被拦gatekeeper)
- **无自定义应用图标**：沿用 Electron 默认图标。放置 `build/icon.ico`（Windows）、`build/icon.icns`（macOS）、`build/icon.png`（Linux，512×512 以上）后重新打包即自动生效，无需改配置
- **不支持交叉编译**：mac / linux 包必须在对应系统或 GitHub Actions 上构建
- **不做静默自动升级**：客户端已能从自建更新服务检查并下载新版本（见[版本更新服务](#版本更新服务-server)），但不会自行替换程序文件——无代码签名，静默替换必被 SmartScreen / Gatekeeper 拦。下载完由用户确认后运行安装程序


## 数据存放位置

配置保存在 Electron 的 `userData` 目录：

- Windows：`%APPDATA%\qingstor-client\config.json`
- macOS：`~/Library/Application Support/qingstor-client/config.json`
- Linux：`~/.config/qingstor-client/config.json`

删除该文件等同于「忘记所有连接配置」。

## License

MIT
