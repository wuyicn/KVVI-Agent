#!/bin/bash
# 只读的环境检查。**不改动任何东西。**
#
# 这是永远的第一步：一个必然失败的安装会让用户等十分钟才看到错误。
set -eu
source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

# 固定为 --json：调用方（人或模型）拿到的是结构化结果，
# 不需要解析中文段落，也就不需要为了让人读懂而改这里的措辞。
run_admin preflight --json
