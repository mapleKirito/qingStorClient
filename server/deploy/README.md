# 部署说明

目标形态：**公网只看到一个更新 API（HTTPS，走你的 nginx），管理端只存在于 SSH 隧道里。**

```
                    公网                        服务器本机               你的电脑
  客户端 ──HTTPS──▶ nginx:443 ──▶ 127.0.0.1:8789 ─┐
                  （只放行 3 个路径）               │  更新 API
                                                   │
   你 ──SSH 隧道───────────────────────────────────┤
      ssh -L 8790:127.0.0.1:8790 ──▶ 127.0.0.1:8790 ─┘  管理端（公网上不存在这个端口）
```

管理端和更新 API 是**两个独立的监听端口**，不是同一个端口按路径分流。这一点很关键：
单端口方案里，套上 nginx 之后所有请求的来源都变成 `127.0.0.1`，"判断是否本机访问"的逻辑直接失效，管理端等于无保护。

---

## 一、本机先跑起来（验证用）

```bash
cd server
node server.js
```

零依赖，不用 `npm install`。启动后控制台会把管理端地址、令牌文件位置、以及该用的 SSH 隧道命令打印出来。

```
  更新 API          http://127.0.0.1:8787/api/releases/latest
  ----------------------------------------------------------------
  管理端            http://127.0.0.1:8788/admin
  管理端绑定        127.0.0.1:8788（仅回环，走 SSH 隧道）
  SSH 隧道          ssh -N -L 8788:127.0.0.1:8788 <user>@<server>
  管理令牌          <项目>/server/data/admin-token.txt
```

浏览器打开 `http://127.0.0.1:8788/admin`，把 `data/admin-token.txt` 里的令牌粘进去。

> 上面是**直接 `node server.js`** 的输出，走的是代码里的默认值 8787/8788。
> 生产部署（Docker / systemd）统一用 `PORT=8789`、`ADMIN_PORT=8790`，
> 目的是避开同机 myApiTools 服务端占用的 8787。下文所有命令都按 8789/8790 写。

> Node 22 会打一条 `ExperimentalWarning: SQLite is an experimental feature`，可以忽略，
> 也可以加 `--no-warnings` 关掉。

---

## 二、裸机部署（systemd）

```bash
# 1. 放到服务器
sudo mkdir -p /opt/qs-update
sudo cp server.js admin.html package.json /opt/qs-update/
sudo mkdir -p /opt/qs-update/data

# 2. 建一个专用系统用户，不让它跑在 root 下
sudo useradd --system --no-create-home --shell /usr/sbin/nologin qsupdate
sudo chown -R qsupdate:qsupdate /opt/qs-update

# 3. systemd 单元
sudo tee /etc/systemd/system/qs-update.service >/dev/null <<'EOF'
[Unit]
Description=qingStorClient Update Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=qsupdate
WorkingDirectory=/opt/qs-update
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

# 更新 API 只监听回环，交给 nginx 反代；管理端同样只监听回环
# 端口避开 8787/8788：同机若已跑着 myApiTools 服务端（占 8787），
# 冲突会让 publicServer 监听失败并直接退出进程。
Environment=HOST=127.0.0.1
Environment=PORT=8789
Environment=ADMIN_HOST=127.0.0.1
Environment=ADMIN_PORT=8790
Environment=DATA_DIR=/opt/qs-update/data
Environment=TRUST_PROXY=1
Environment=PUBLIC_ORIGIN=https://update.example.com
Environment=RELEASE_MAX_MB=300

# 基础加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/qs-update/data
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now qs-update
sudo systemctl status qs-update --no-pager
```

上面 `HOST=127.0.0.1` 意味着**更新 API 也只有本机能连**，公网访问全靠 nginx 反代。
这样即使防火墙配错了，8789 也不会直接暴露在公网。

---

## 三、Docker 部署

服务器上直接构建：

```bash
cd server
docker compose up -d --build

# 首次启动后取管理令牌
docker exec qs-update cat /app/data/admin-token.txt
```

或者拉已经发布好的镜像（更推荐，服务器上不用装构建工具链，也不必把源码放上去）。镜像仓库选 ACR —— 境内 ECS 拉 Docker Hub 经常超时：

```bash
# 在开发机上发布镜像（两家一起推，也可以 --registry acr 只推 ACR）
cd server && ./docker-publish.sh

# 服务器上把 compose 的 build 去掉，换成 image
#   image: registry.cn-hangzhou.aliyuncs.com/myzhouye/qingstorclient-server:1.1.0
docker compose pull && docker compose up -d
```

升级就是 `docker compose pull && docker compose up -d`，`data/` 卷不动。镜像 tag 规则与发布细节见 [server/README.md](../README.md#镜像发布docker-publishsh)。

两个必读的细节：

1. **端口必须是 `127.0.0.1:8789:8789` 这种带前缀的写法。** 写成 `8789:8789` 时 docker 会直接监听 `0.0.0.0`，并且它插入的 iptables 规则优先于 ufw，`ufw deny` 也拦不住 —— 这是 docker 用户最常踩的坑。
2. **容器里 `ADMIN_HOST` 必须设 `0.0.0.0`**，否则端口映射进不来；真正的隔离靠宿主机侧那个 `127.0.0.1` 绑定。同时因为容器内看到的来源是网桥网关而**不是**回环地址，`docker-compose.yml` 里给了 `ADMIN_ALLOW_CIDR=172.16.0.0/12`，否则管理端会一律拒绝。

数据全部在 `server/data` 一个目录里（库 + 安装包 + 令牌），升级只要 `docker compose up -d --build`，卷不动。

---

## 四、nginx 反代

把 `deploy/nginx.conf` 改掉域名和证书路径，放到 `sites-available` 后 `nginx -t && systemctl reload nginx`。

它只放行四个路径，其余返回 404：

| 路径 | 用途 |
| --- | --- |
| `/` | 服务自述（name / version / scope），浏览器敲域名就能确认服务活着 |
| `/api/health` | 给监控探活，额外带发布数量与运行时长 |
| `/api/releases/latest` | 查最新版本 |
| `/api/releases/download/<数字>` | 下载安装包（关缓冲、支持 Range） |

`/` 用的是 `location = /` 精确匹配，优先级高于底部 `location / { return 404; }` —— 这是它能生效的前提。

两个容易出问题的地方，配置里已经处理：

- `client_max_body_size 1m` —— 公网侧没有任何上传需求，故意卡死。发布走的是隧道里的 8790，不受这个限制。
- `proxy_buffering off` —— 否则 nginx 会先把整个安装包收进临时文件再转发，每个下载都在服务器上多写一份 100MB。

**不要给 admin 端口加 location。** 如果有人图省事写了 `location /admin { proxy_pass http://127.0.0.1:8790; }`，就等于把管理端放上公网。服务端会识别 `X-Forwarded-*` 头并拒绝这类请求，但那只是最后一道兜底，不是可以依赖的设计。

---

## 五、日常发布流程（在你的电脑上）

```bash
# 1. 开隧道（保持这个终端窗口不关）
ssh -N -L 8790:127.0.0.1:8790 user@your-server

# 2. 浏览器打开
#    http://127.0.0.1:8790/admin
#    粘贴服务端 data/admin-token.txt 里的令牌

# 3. 上传安装包：选文件 → 「从文件名自动填充」→ 确认版本/平台/架构 → 上传
```

同渠道同版本同平台同架构重复上传会**覆盖**旧记录并删掉旧文件，dev 渠道可以反复重发，不会堆出一串同版本号的垃圾。

不想开浏览器也可以用 curl（`--data-binary @文件` 是必须的，用 `-d` 会把二进制搞坏）：

```bash
TOKEN=$(ssh user@your-server 'cat /opt/qs-update/data/admin-token.txt')
ssh -N -L 8790:127.0.0.1:8790 user@your-server &

curl -X PUT "http://127.0.0.1:8790/api/admin/releases?version=2.0.1&platform=win&arch=x64&channel=stable&notes=fix" \
  -H "X-Admin-Token: $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @dist/QingStorClient-Setup-2.0.1-x64.exe
```

---

## 六、验证

```bash
# 健康检查
curl -s https://update.example.com/api/health

# 查最新版（客户端就是这么调的）
curl -s "https://update.example.com/api/releases/latest?platform=win&arch=x64&current=2.0.0"

# 下载并校验完整性
curl -sO "https://update.example.com/api/releases/download/1"
curl -sI "https://update.example.com/api/releases/download/1" | grep -i x-release-sha256
sha256sum QingStorClient-Setup-2.0.1-x64.exe

# 断点续传
curl -r 0-1023 -o part.bin "https://update.example.com/api/releases/download/1"

# 管理端在公网必须打不开（应该是 404，不是 401、不是 403）
curl -s -o /dev/null -w '%{http_code}\n' https://update.example.com/admin
curl -s -o /dev/null -w '%{http_code}\n' https://update.example.com/api/admin/releases
```

最后两条如果返回的不是 `404`，说明有地方把管理端漏出去了，立刻检查 nginx 的 location。

---

## 七、备份与恢复

要备份的只有 `data/` 一个目录：

```bash
# 库要热备份，别直接 cp .db 文件（WAL 模式下会拷到不完整状态）
sqlite3 data/releases.db ".backup '/backup/releases-$(date +%F).db'"
tar czf /backup/releases-files-$(date +%F).tar.gz -C data releases
```

恢复：把库和 `releases/` 目录放回去，重启服务即可。**管理令牌文件也一起备份**，否则恢复后要用新令牌重新登录。

---

## 八、常见问题

| 现象 | 原因 |
| --- | --- |
| 管理端一直 404 | 没走隧道，或请求带了 `X-Forwarded-*`（被 nginx 转发过）。直接从隧道地址打开，别配反代 |
| 管理端 404，且是 Docker 部署 | `ADMIN_ALLOW_CIDR` 没覆盖实际网桥网段。`docker inspect qs-update --format '{{.NetworkSettings.Gateway}}'` 看一下网关地址，把那一段写进这个变量 |
| 管理端一直 401 | 令牌不对。`cat data/admin-token.txt` 核对；改过 `ADMIN_TOKEN` 环境变量的话以环境变量为准 |
| 上传报 `TOO_LARGE` | 超过 `RELEASE_MAX_MB`，改环境变量重启 |
| 上传报「连接被中断」 | 隧道断了，或用了 `curl -d`（会把二进制改坏，必须 `--data-binary`） |
| 下载很慢、磁盘一直在涨 | nginx 少了 `proxy_buffering off` |
| 客户端拿到 `downloadUrl` 是相对路径 | 没设 `PUBLIC_ORIGIN`。设成 `https://update.example.com` 后返回绝对地址 |
| 统计出来的下载 IP 全是 127.0.0.1 | 反代后面没设 `TRUST_PROXY=1` |
| 提示 SQLite experimental | Node 22 的正常警告，忽略 |
