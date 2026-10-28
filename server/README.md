# 更新服务

qingStorClient 的版本发布与更新检查服务。零外部依赖，`node server.js` 直接跑。

- **对外**只暴露三个只读接口（挂在你的 nginx 后面，走 HTTPS）
- **管理端**单独一个端口，只绑回环，只能通过 SSH 隧道打开
- 数据只有 `data/` 一个目录：SQLite 库 + 安装包本体 + 管理令牌

详细部署步骤见 [deploy/README.md](deploy/README.md)。

---

## 快速开始

```bash
cd server
node server.js
```

```
  qingStorClient 更新服务 v1.1.0
  ------------------------------------------------------------------
  更新 API            http://127.0.0.1:8787/api/releases/latest
  ------------------------------------------------------------------
  管理端              http://127.0.0.1:8788/admin
  管理端绑定          127.0.0.1:8788（仅回环，走 SSH 隧道）
  SSH 隧道            ssh -N -L 8788:127.0.0.1:8788 <user>@<server>
  管理令牌            <项目>/server/data/admin-token.txt
  安装包目录          <项目>/server/data/releases
  数据库              <项目>/server/data/releases.db
  TRUST_PROXY         0（用 socket 地址）
```

浏览器打开 `http://127.0.0.1:8788/admin`，令牌在 `data/admin-token.txt`。

> 上面是直接 `node server.js` 的默认端口。**生产部署统一用 `PORT=8789` / `ADMIN_PORT=8790`**
> （`Dockerfile` 与 `docker-compose.yml` 已按此设好），因为同机上 myApiTools 服务端占着 8787。
> 端口冲突时 `publicServer` 监听失败会直接 `process.exit(1)`，整个容器起不来。

> Node 22 会打一条 `ExperimentalWarning: SQLite is an experimental feature`，忽略即可，或用 `node --no-warnings server.js`。

---

## 为什么是两个端口

| | 公网口（默认 8787） | 管理口（默认 8788） |
| --- | --- | --- |
| 绑定地址 | `0.0.0.0`（nginx 反代） | `127.0.0.1`（仅本机） |
| 认的路径 | `/`、`/api/health`、`/api/releases/latest`、`/api/releases/download/:id` | `/`、`/admin`、`/api/admin/*` |
| 其它路径 | 一律 404 | 一律 404 |
| 谁能访问 | 公网 | 只有 SSH 隧道进来的人 |

单端口方案只能靠"判断来源是不是回环 IP"来保护管理端，一旦套上 nginx，所有请求的来源都变成 `127.0.0.1`，这道判断直接失效。拆成两个监听端口后，公网侧那个端口在物理上就不接受管理请求，`/admin` 返回的 404 和随便一个乱码路径的 404 完全一样，扫描的人连"这里有没有管理端"都判断不出来。

管理侧另外还有两道：

- 拒绝任何带 `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Proto` / `X-Forwarded-Host` 的请求。nginx 转发必然加这些头，SSH 隧道直连的浏览器不会。所以"有人图省事给 nginx 加了一条 `/admin` 的 location"这种误配置也进不来。
- 32 字节随机令牌，用 `crypto.timingSafeEqual` 恒定时间比较。

---

## API 契约

所有响应都是 JSON，`ok: false` 时附带 `error` 与 `code`。

### 1. `GET /`

```json
{ "ok": true, "service": "qingstor-client-update", "name": "qingStorClient 更新服务", "version": "1.1.0", "scope": "仅分发客户端安装包，不提供账号、配置同步与第三方代理", "serverTime": 1793167849698 }
```

服务自述。浏览器直接敲域名就能确认服务活着、版本多少，不必先记住 `/api/health`。

只放身份信息：发布数量与运行时长留在 `/api/health`。管理侧根路径（`127.0.0.1:8790/`）额外返回 `adminPage: "/admin"`。

### 2. `GET /api/health`

```json
{ "ok": true, "service": "qingstor-client-update", "version": "1.1.0", "releases": 12, "uptime": 3600, "checkedAt": 1793097689079 }
```

给 nginx / 监控探活用。带发布数量与运行时长，用来判断库是否读得动；不含平台、架构、版本号等任何可推断业务的信息。

### 3. `GET /api/releases/latest`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `platform` | 否 | `win` / `mac` / `linux`，也接受 `windows`、`darwin`、`osx` 等别名。不传＝不限平台 |
| `arch` | 否 | `x64` / `arm64` / `ia32` / `armv7l`，也接受 `x86_64`、`amd64`、`aarch64` 等别名。不传＝不限架构 |
| `channel` | 否 | 默认 `stable` |
| `current` | 否 | 客户端当前版本，如 `2.0.0`。传了才会判断要不要更新 |

```json
{
  "ok": true,
  "channel": "stable",
  "current": "2.0.0",
  "latest": {
    "id": 1,
    "channel": "stable",
    "version": "2.0.1",
    "platform": "win",
    "arch": "x64",
    "fileName": "QingStorClient-Setup-2.0.1-x64.exe",
    "size": 87885824,
    "sha256": "6ab6acad...",
    "notes": "修复下载崩溃",
    "downloads": 42,
    "publishedAt": 1793097698738,
    "downloadUrl": "https://update.example.com/api/releases/download/1"
  },
  "upToDate": false,
  "updateAvailable": true,
  "channelCount": 3,
  "checkedAt": 1793097704963
}
```

几个刻意的设计：

- **查不到版本不算错**。该渠道还没发布过任何东西时返回 `latest: null`、`upToDate: true`。客户端刚上线、服务端还没发包时不应该报错。
- **`upToDate` 可能是 `null`**。不传 `current` 时服务端不知道你在哪个版本，只如实回答"最新是哪个"，不猜。
- **版本比较不用 SQL**。版本号是文本，`'1.10.0' < '1.9.0'` 按字典序成立但语义是错的，所以是全量取回逐条比较。发布量级几十条，没有性能问题。
- **预发布版恒小于同号正式版**：`2.1.0-beta.1 < 2.1.0`。所以 dev 渠道发 beta 不会被同号正式版顶掉，也不会顶掉 stable。
- `downloadUrl` 是相对路径，设了 `PUBLIC_ORIGIN` 后变成绝对地址。

### 4. `GET /api/releases/download/:id`

流式返回安装包，`Content-Type: application/octet-stream`。

响应头带元信息，客户端下载完可以直接核对：

```
x-release-version: 2.0.1
x-release-platform: win
x-release-arch: x64
x-release-sha256: 6ab6acad...
accept-ranges: bytes
content-disposition: attachment; filename="QingStorClient-Setup-2.0.1-x64.exe"; filename*=UTF-8''...
```

支持 `Range`（断点续传）：正常返回 `206 Partial Content` + `content-range`，越界返回 `416`。这条对 80MB 以上的安装包很关键，弱网断一次不用从头再来。

文件丢失返回 `410 Gone`（不是 404）—— 库里还有记录但磁盘上没了，这种情况要跟"记录不存在"区分开，管理端才知道要重新发布。

### 管理端接口（仅管理口）

都需要 `X-Admin-Token` 头。

| 方法与路径 | 作用 |
| --- | --- |
| `GET /admin` | 管理页（不需要令牌，页面里再输） |
| `GET /api/admin/whoami` | 服务端配置自检：版本、目录、上限、令牌来源 |
| `GET /api/admin/releases` | 列表 + 总数 + 总占用 + 渠道清单 |
| `PUT /api/admin/releases?version=&platform=&arch=&channel=&notes=&name=` | 发布，body 是安装包原始字节 |
| `DELETE /api/admin/releases/:id` | 删除记录并删掉磁盘文件 |
| `GET /api/admin/audit` | 最近的发布/删除/被拒记录 |

发布接口的几个细节：

- **body 是原始字节流，不是 multipart。** 零依赖下手写 boundary 切分容易出错，而"原始字节流 + query 带元信息"更直白，还能边收边算 sha256。用 curl 时必须 `--data-binary`，`-d` 会把二进制改坏。
- **文件名走 `name` 参数、base64url 编码。** 中文名直接塞 URL 或 Header 都会乱码。服务端会做往返校验，传明文也能正确识别。
- **同一「渠道+版本+平台+架构」重复发布＝覆盖**，旧文件同时删除。所以 dev 渠道可以无脑重发，不会堆出一串同版本号的垃圾记录。
- **超限不 destroy 请求。** 超过 `RELEASE_MAX_MB` 后继续把 body 读完再回 413，直接 destroy 会让客户端只看到"连接被重置"，拿不到状态码。
- 没有提供"改说明"、"改版本号"的接口：要改就是重发，覆盖语义已经覆盖了这个需求。

---

## 为什么公网更新 API 不做鉴权

默认不校验，理由：

1. **安装包不是机密。** 它最终要装到用户机器上，任何拿到它的人本来就该能装。
2. **写在客户端里的密钥没有防护作用。** Electron 包里翻出一个 `X-Api-Key` 只是几分钟的事，加了会让人误以为"已经保护起来了"。
3. **真正需要防护的是"谁能发布"，不是"谁能下载"。** 发布口在隧道后面 + 32 字节令牌 + 限流，这才是攻击面所在。

> 早先还有一个可选的 `UPDATE_API_KEY` / `X-Api-Key` 开关，**已移除**。原因不只是"没多大用"：
> 客户端的密钥来源是环境变量，打包后双击启动根本读不到，服务端一旦开启，所有已发布的客户端
> 会在下次检查更新时全部 401，而用户没有任何自助修复的办法。真要控制未授权下载，用对象存储的
> 预签名 URL（短 TTL、每次现签、无法长期复用），不要加静态密钥。

公网侧另有按 IP 的限流：查询 300 次/分钟，下载 60 次/分钟。目的是防扫描和防被当免费 CDN 刷，不是为了挡正常用户。

---

## 数据目录

```
server/data/
├── releases.db          SQLite（WAL 模式，会有 -wal / -shm 两个伴生文件）
├── admin-token.txt      管理令牌，权限 0600（Windows 上 mode 不生效，靠目录 ACL）
└── releases/            安装包本体
    ├── stable/2.0.1/QingStorClient-Setup-2.0.1-x64.exe
    └── dev/2.1.0-beta.1/QingStorClient-2.1.0-beta.1-mac-arm64.dmg
```

按 `渠道/版本/文件名` 分目录，`file_path` 在库里只存相对路径。下载时会二次校验解析结果仍在 `RELEASES_DIR` 内 —— 即使库被外部改脏，也读不出目录之外的文件。

备份只需要 `data/` 这一个目录。库要用 `sqlite3 .backup` 热备，WAL 模式下直接 `cp` 会拷到不完整状态（见 deploy/README.md）。

---

## 镜像发布（`docker-publish.sh` / `docker-publish.ps1`）

一次构建，同时推 Docker Hub 与阿里云 ACR。ACR 在境内 ECS 上能稳定拉取，Docker Hub 经常超时，所以两边各推一份。

```bash
cd server

./docker-publish.sh --dry-run        # 先看将要打的 tag 和推送地址，什么都不动
./docker-publish.sh                  # 构建 + 两家都推
./docker-publish.sh --registry acr   # 只推 ACR
./docker-publish.sh --login          # 先登录再推（两家依次提示输入）
./docker-publish.sh --no-push        # 只构建并打 tag，不推送（本地验证 / 配合 compose）
```

Windows 上用同目录的 PowerShell 版，参数一一对应（`--dry-run` → `-DryRun`，`--registry` → `-Registry`）：

```powershell
cd server

.\docker-publish.ps1 -DryRun         # 只出计划
.\docker-publish.ps1                  # 构建 + 两家都推
.\docker-publish.ps1 -Registry acr    # 只推 ACR
.\docker-publish.ps1 -NoPush          # 只构建，本地起容器验证
```

两个脚本行为等价，`.ps1` 多一层兜底：**docker 不在 PATH 里时会去 Docker Desktop 的默认安装目录找 `docker.exe`**。Windows 上最常见的失败原因就是这个——装了 Docker Desktop 但没重开终端，`docker` 敲不出来。

`.ps1` 在 Windows 上另有三处实测踩过的坑，已内置处理：

| 现象 | 原因 | 现状 |
|---|---|---|
| `术语 'C:\...\docker.exe C:\...\docker' 不会被识别` | 机器上有两份 docker 时 `Get-Command` 返回**数组**，`& $数组` 被拼成一个带空格的假路径 | 收集候选 → 只留真实存在的 `.exe` → 去重 → 逐个 `docker info` 试到能连上引擎 |
| 报「Docker 引擎没在运行」但 `docker -v` 正常 | `docker -v` 只证明 CLI 装好，不代表 Docker Desktop 的守护进程起来了 | 报错里直接说明这一点；启动 Docker Desktop 后再跑 |
| 一行 `$ docker build …` 之后静默几十秒，然后报「docker build 失败」，但镜像其实已经构建出来了 | docker 的 stdout 留在 PowerShell 管道里，被调用方的 `$code =` 当成返回值吞掉；退出码判断变成数组比较恒为真 | 输出逐行 `Write-Host`（`2>&1` 合并 stderr，buildkit 的进度就是走 stderr），函数只返回 int 退出码；`docker push` 同样改成边推边显示 |

默认仓库地址（命名空间与地域同参考项目 myApiTools）：

```text
Docker Hub : myzhouye/qingstorclient-server
阿里云 ACR : registry.cn-hangzhou.aliyuncs.com/myzhouye/qingstorclient-server
```

仓库名故意与参考项目的 `myapitools-server` 不同 —— 镜像内容不一样，同名会把它覆盖掉。要临时换仓库用环境变量：

```bash
HUB_REPO=someone/qs-server \
ACR_REPO=registry.cn-beijing.aliyuncs.com/someone/qs-server \
./docker-publish.sh
```

首次推送 ACR 前需确认两件事（与参考项目相同）：

```bash
# 1. ACR 控制台里 myzhouye 命名空间已创建（个人版要先建命名空间，再建仓库）
# 2. 登录。账号是阿里云账号全名，密码是 ACR 的「固定密码」或临时 token
docker login registry.cn-hangzhou.aliyuncs.com
```

只用 Docker Hub 的话 `docker login` 不需要带域名。

**tag 自动识别**，不用手工指定：

| 情形 | 打的 tag |
| --- | --- |
| HEAD 上有 `server-v1.2.0` 标签，且与 `package.json` 一致 | `1.2.0` + `latest` |
| 没有服务端标签（客户端 `v*` 标签不算） | 用 `package.json` 的 `version`，规则同上 |
| 版本含 `-`（如 `2.1.0-beta.1`） | 只打 `2.1.0-beta.1`，**不动 `latest`** |
| 加 `--floating` | 正式版额外打 `1.2` 与 `1` |
| 加 `--tag dev` | 额外再打一个 `dev` |

服务端标签必须带 `server-v` 前缀，例如 `git tag server-v1.1.0`。**不要用裸 `v1.1.0`** —— 客户端发版也打 `v*`，两套版本号（客户端 0.0.x-dev / 服务端 1.1.0）共用同一个标签空间，混用会导致脚本读到客户端的版本号再与服务端 `package.json` 比对，直接报错退出。

服务端标签与 `package.json` 不一致时脚本**直接报错退出**，避免出现「标签写着 1.2.0、镜像却是 1.1.0」。

其它常用选项：

```bash
./docker-publish.sh --platform linux/amd64,linux/arm64   # 多架构（buildx，构建即推送）
./docker-publish.sh --no-build                            # 不构建，重推本地已有镜像
./docker-publish.sh --force                               # 同版本已存在时直接覆盖
./docker-publish.sh --no-cache --pull                     # 干净构建
```

同版本已存在时的默认行为：正式版停下来问你（升 patch / 升 minor / 手工输入 / 强制覆盖 / 中止），预发布版直接覆盖。`--yes` 用于 CI，遇到冲突判失败而不是替你覆盖。

> **`data/` 绝不会进镜像。** `Dockerfile` 用的是精确 `COPY`（只拷三个文件），`server/.dockerignore` 又挡了一层，因为 `data/` 里放着 `admin-token.txt` 和用户上传的安装包 —— 这两样进镜像就是事故。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 公网侧端口。**Docker/systemd 部署用 `8789`**（镜像已设），避开同机 myApiTools 占用的 8787 |
| `HOST` | `0.0.0.0` | 公网侧绑定地址。裸机放 nginx 后面时可以设 `127.0.0.1`，让端口连内网都不暴露 |
| `DATA_DIR` | `./data` | 数据根目录 |
| `DB_FILE` | `$DATA_DIR/releases.db` | 数据库 |
| `RELEASES_DIR` | `$DATA_DIR/releases` | 安装包目录 |
| `PUBLIC_ORIGIN` | 空 | 如 `https://update.example.com`，用于生成绝对 `downloadUrl`。留空则 `downloadUrl` 只返回相对路径 `/api/releases/download/12`，由调用方自己拼域名 |
| `TRUST_PROXY` | `0` | nginx 后面设 `1`，否则统计到的全是 `127.0.0.1` |
| `RELEASE_MAX_MB` | `300` | 单包上限 |
| `RELEASE_CHANNEL` | `stable` | 默认渠道 |
| `ADMIN_HOST` | `127.0.0.1` | 管理侧绑定地址，**不建议改** |
| `ADMIN_PORT` | `8788` | 管理侧端口。**Docker/systemd 部署用 `8790`**（镜像已设） |
| `ADMIN_TOKEN` | 空 | 显式指定令牌，优先于文件 |
| `ADMIN_TOKEN_FILE` | `$DATA_DIR/admin-token.txt` | 令牌文件 |
| `ADMIN_DISABLED` | — | 设 `1` 则管理侧不启动 |
| `ADMIN_ALLOW_CIDR` | 空 | 容器部署用，额外受信网段 |

---

## 客户端怎么接（已接入）

客户端已按下面这套接好，实现在 [`../electron/update.js`](../electron/update.js)，公网地址内置为 `https://qingstorclient.myzhouye.com`（`QINGSTOR_UPDATE_BASE` 可覆盖）。界面右下角可切换 `stable` / `dev` 渠道，切换后按对应 `channel` 重新查一次，偏好存 `userData/update-channel.json`。服务端这边不需要任何改动：

1. `electron/update.js`：`GET /api/releases/latest?platform=&arch=&current=`，`updateAvailable` 为真就下载 `downloadUrl`，边下边算 sha256，与 `latest.sha256` 比对，不一致就删掉重下。
2. 下载到 `app.getPath('userData')/updates/`，用 `.part` 临时文件，下完再改名。
3. **不做静默自动升级。** 没有代码签名证书，程序替换自己必然被 SmartScreen / Gatekeeper 拦，体验会更糟。正确做法是下载完弹窗"立即安装"，交给系统安装器。
4. `platform` 用 `process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'`，`arch` 用 `process.arch`，服务端两个字段都接受别名。

mac 的 arm64 与 x64 是两份包，客户端必须传对 `arch`，否则会下到跑不起来的架构。
