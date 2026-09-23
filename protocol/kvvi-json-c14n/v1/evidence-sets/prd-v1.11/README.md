# `kvvi-json-c14n/v1` PRD v1.11 参考一致性套件

本目录是 PRD v1.11 的版本化 Go-0 参考证据集。它从原始 JSON 文本开始，使用 Python 与 Node.js 两套相互独立的实现验证同一份机器向量；它不是 KVVI 平台生产运行时。目录名 `prd-v1.11` 只表示证据修订，规范化 profile 仍固定为 `kvvi-json-c14n/v1`。

PRD v1.10 对应的 C1–C6/N1–N5 原始证据集保留在 `protocol/kvvi-json-c14n/v1/` 根部且不再修改。

## 文件

- `vectors.json`：本证据集的唯一共享输入，含 C1–C7 正向向量和 N1–N10 负向向量。
- `python/kvvi_json_c14n.py`：Python 标准库 JSON 解码钩子、十进制词法精确整数判断与独立序列化实现；不依赖二进制浮点或 `Decimal` 指数范围。
- `node/kvvi-json-c14n.mjs`：Node.js 递归下降 JSON 解析器、`BigInt` 与独立序列化实现；不调用 `JSON.parse`，以保留重复键和数值词法信息。
- `tests/test_conformance.py`：黑盒启动两个独立进程，比较规范化文本、UTF-8 字节、SHA-256、固定错误码及跨语言结果。

新增边界固定为：UTF-8 BOM、`NaN`、`Infinity`、`-Infinity` 返回 `CANON_JSON_INVALID`；数学零不受指数长度影响；非零巨大正指数返回 `CANON_NUMBER_OUT_OF_RANGE`。

## 一键复验

在项目根目录执行：

```bash
python3 protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/tests/test_conformance.py
```

退出码必须为 `0`，并显示 6 个测试全部 `OK`。测试内部会运行 7×2 组正向实现验证、10×2 组负向实现验证和 17 组跨语言结果比较。

## CLI 契约

两种实现均从标准输入读取 UTF-8 JSON 文本，并通过必填参数指定 profile：

```bash
python3 protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/python/kvvi_json_c14n.py --profile kvvi-json-c14n/v1 < input.json
node protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/node/kvvi-json-c14n.mjs --profile kvvi-json-c14n/v1 < input.json
```

成功时退出码为 `0`，输出一个 JSON 对象，包含 `canonical`、`canonical_utf8_hex` 和带 `sha256:` 前缀的 `digest`。协议拒绝时退出码为 `2`，只输出 `status=error` 与固定 `error_code`，不产生规范化结果或摘要。

## 证据边界

本套件证明：文档中的 `kvvi-json-c14n/v1` 对 C1–C7、N1–N10 可被两种独立语言实现，并得到一致字节、摘要和拒绝结果。它不证明未列入共享向量的无限输入空间，也不证明平台 Meta-Schema、真实运行时集成、数据库迁移、部署或阶段 0 已完成；0A 仍必须让真实平台实现消费本证据集的同一份 `vectors.json` 并进入 CI。
