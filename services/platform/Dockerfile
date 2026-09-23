# KVVI 平台服务进程镜像。
#
# 归属（PRD §4.6.5）：身份层、授权判定、签名模块、发布通道、平台库访问、认证端点。
#
# ★ 本镜像**不安装任何 DSH 包**，这是锚点⑥ 的证据基础：
#   「不加载插件」不是本进程的自律，而是它**没有加载插件的材料**。
#   镜像里没有 @deepseek-ai/*，容器里也解析不到 —— 这可以被外部独立复核。
#
# ★ 签名私钥**不进镜像**（PRD §9.4.1）。本镜像不含任何密钥文件；
#   私钥由运行期挂载或外部 KMS 提供，缺失时 /healthz 的 signingKeyMounted 为 false。
FROM node:24-bookworm-slim

WORKDIR /app
COPY services/platform/package.json ./package.json
COPY services/platform/src/ ./src/

# 无依赖安装步骤 —— 因为就没有依赖。保留这行是为了让「零依赖」这件事
# 在 Dockerfile 里显式可见，而不是靠读者去翻 package.json。
RUN test ! -s package.json || node -e "const p=require('./package.json'); \
  const n=Object.keys(p.dependencies??{}).length+Object.keys(p.devDependencies??{}).length; \
  if(n>0){console.error('平台服务进程不允许有依赖，实际 '+n+' 个');process.exit(1)}"

ENV NODE_ENV=production
ENV KVVI_PLATFORM_PORT=7400
EXPOSE 7400

# 以非 root 运行；node 镜像自带 uid 1000 的 node 用户。
USER node

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:7400/healthz').then(async r=>{const b=await r.json();process.exit(r.ok&&b.pluginsLoaded===0?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
