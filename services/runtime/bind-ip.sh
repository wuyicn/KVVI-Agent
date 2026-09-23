#!/bin/sh
# 打印本容器在 kvvi_control 网络里的 IPv4 地址。
#
# 抽成独立脚本是因为**两个地方需要同一个答案**：entrypoint 用它绑定，
# 健康检查用它探测。各自算一遍的后果是探针去探一个没人监听的地址 ——
# 表现为容器健康检查永远红，而服务其实是好的。
set -eu
node -e "
const os = require('os')
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs ?? []) {
    if (a.family === 'IPv4' && !a.internal) { console.log(a.address); process.exit(0) }
  }
}
process.exit(1)
"
