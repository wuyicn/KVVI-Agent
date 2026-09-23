# KVVI Agent 运行时进程镜像。
#
# 归属（PRD §4.6.5）：Agent Loop、Skill 执行、插件宿主。**加载插件。**
#
# ★ 为什么在容器内 pnpm install，而不是 COPY 宿主机的 node_modules：
#   宿主机的 .pnpm 里是 darwin-arm64 原生模块（sharp / fsevents / oxlint），
#   Linux 容器加载会失败。复制一个「看起来装好了」的 node_modules 进来，
#   失败会推迟到运行期的某个具体功能上，比构建期失败难查得多。
#
# ★ 但 lib/ 与 dist/ 直接复用宿主机的构建产物 —— 那些是平台无关的，
#   在容器里重建一次完整 pnpm build 约需 20 分钟，没有收益。
FROM node:24-bookworm-slim

RUN corepack enable

WORKDIR /dsh
COPY vendor/dsh/ /dsh/

# corepack 按 package.json 的 packageManager 字段选 pnpm 版本。
RUN pnpm install --frozen-lockfile

COPY services/runtime/entrypoint.sh /usr/local/bin/kvvi-runtime-entrypoint
RUN chmod +x /usr/local/bin/kvvi-runtime-entrypoint

ENV NODE_ENV=production
ENV DSH_HOME=/data
ENV KVVI_RUNTIME_PORT=7401
EXPOSE 7401

# 会话数据卷。刻意**不与平台服务进程共享** —— PRD §4.6.5 部署基线要求
# 「无共享可写文件系统」；共享卷会让一条进程间越权路径重新出现。
VOLUME ["/data"]

# 以非 root 运行。数据卷归 node 用户所有，故先建目录再降权。
RUN mkdir -p /data && chown -R node:node /data
USER node

# 健康检查探测 DSH web 自身，而不是另起一个自证端点：
# 自证端点活着不等于服务活着。
#
# ★ 判据是 `status < 500`，不是 `r.ok`。
#   DSH web 自带 token 认证，无凭据时一切路径都返回 **401**
#   （实测：/ 与 /index.html → 401；/api → 401 "unauthorized"）。
#   那说明服务**正在正常处理请求**，只是探针没带凭据 —— 这恰恰是健康。
#   用 `r.ok` 会让一个完全正常的服务永远被判不健康，
#   而这种假红会训练人忽略健康检查，比没有还坏。
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:7401/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/kvvi-runtime-entrypoint"]
