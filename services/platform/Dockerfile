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

WORKDIR /app/services/platform
COPY services/platform/package.json services/platform/package-lock.json ./
# 依赖在**构建期**安装，而不是把开发机上的 node_modules 拷进镜像：
# 拷贝法在干净克隆上必然失败（node_modules 不入库），
# 而且会让「镜像里有什么」取决于构建那台机器的状态。
RUN npm ci --omit=dev --no-audit --no-fund
COPY services/platform/src/ ./src/
COPY services/platform/sql/ ./sql/
# Share the frozen pure value/calendar functions without installing the full authoring toolchain.
COPY tools/meta-schema/node/values.mjs tools/meta-schema/node/safe_pattern.mjs /app/tools/meta-schema/node/
# 开发工具（造演示账号）。它**不在** `src/`，这是刻意的：
# `工具/check_publish_channel.py` 静态核查「`src/` 里只有发布通道能写 policies」，
# 而种子脚本要插 `policies` 的固定装置 —— 放进 `src/` 就会被正确地报成旁路。
# 我们删的是「它在产品代码路径上」这个事实，不是给检查器加白名单。
COPY services/platform/dev/ ./dev/

# ⚠️ 归一化权限。**这不是可有可无的美化**：`COPY` 会保留源文件的权限位，
# 而不同机器上的 umask 不同 —— 源文件若是 0600，容器里就是 root 拥有的 0600，
# 以 uid 1000 运行的 `USER node` 读不到它，启动时报
# `EACCES: permission denied, open '/app/src/auth.mjs'` 然后无限重启。
# 那个报错看起来像代码 bug，实际是构建机的 umask 泄漏进了镜像。
# 镜像的可运行性不该取决于构建机的 umask，所以在这里抹平。
RUN chmod -R a+rX ./src ./sql ./dev ./node_modules /app/tools/meta-schema/node

# 阶段四起本进程需要一个数据库驱动（`pg`）—— 它要访问平台库。
#
# ⚠️ 这里把原先的「零依赖」断言**收窄为「零 DSH 依赖」**，并把理由写清楚：
# 原断言用「依赖数为 0」当「不加载插件」的**代理**，而代理比被代理的性质更严 ——
# 严到会把一个纯数据库驱动也挡在外面。真正的性质是**镜像里没有可加载的插件材料**，
# 所以下面直接断言那一条（依赖声明 + 装机结果两处都查），
# 而不是继续用一个更严但不相干的代理。
RUN node -e "const p=require('./package.json'); \
  const all=[...Object.keys(p.dependencies??{}),...Object.keys(p.devDependencies??{})]; \
  const dsh=all.filter(n=>n.startsWith('@deepseek-ai/')); \
  if(dsh.length){console.error('平台服务进程不得依赖 DSH 包，实际 '+dsh.join(', '));process.exit(1)}; \
  const {readdirSync,existsSync}=require('node:fs'); \
  for(const dir of ['node_modules','node_modules/@deepseek-ai']) \
    if(existsSync(dir)&&readdirSync(dir).some(n=>n.startsWith('@deepseek-ai')||dir.endsWith('@deepseek-ai'))) \
      {console.error('镜像里出现了 DSH 包：'+dir);process.exit(1)}; \
  console.log('无 DSH 依赖，装机树内亦无 DSH 包')"

ENV NODE_ENV=production
ENV KVVI_PLATFORM_PORT=7400
EXPOSE 7400

# 以非 root 运行；node 镜像自带 uid 1000 的 node 用户。
USER node

HEALTHCHECK --interval=5s --timeout=3s --start-period=3s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:7400/healthz').then(async r=>{const b=await r.json();process.exit(r.ok&&b.pluginsLoaded===0?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
