# qingStorClient 更新服务
# 零 npm 依赖：数据库用 Node 内置 node:sqlite，HTTP 用内置 http
FROM node:22-alpine

WORKDIR /app

# 只有三个文件，没有 node_modules，镜像极小
COPY package.json server.js admin.html ./

# 数据目录：SQLite 库 + 安装包本体 + 管理令牌，全部挂这里
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# 端口故意不用 8787/8788：同机上可能已经跑着别的服务（如 myApiTools
# 的服务端占用 8787），撞了以后 publicServer 起不来会直接 exit。
# server.js 里的代码默认值保持 8787/8788，部署时统一由这里覆盖。
ENV NODE_ENV=production \
    PORT=8789 \
    HOST=0.0.0.0 \
    ADMIN_PORT=8790 \
    ADMIN_HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    RELEASE_MAX_MB=300 \
    RELEASE_CHANNEL=stable \
    TRUST_PROXY=1

# 8789 = 更新 API（由 nginx 反代）
# 8790 = 管理端（宿主机只允许发布到 127.0.0.1，走 SSH 隧道）
EXPOSE 8789 8790

# 用 process.env.PORT 而不是写死端口，改端口时健康检查跟着走，
# 否则改了 PORT 而忘记改这里，容器会一直 unhealthy。
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8789)+'/api/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
