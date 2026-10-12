# PRD v1.11 / Go-0 校验来源

`prd-v1.11-go0.sha256` 恢复 CI 已引用、但并入时遗漏的清单。七项摘要逐字取自历史提交 `e7d5d78dc7cb820ee4f00f4bf05c0408bbd105b7` 的 `contracts/契约资产清单.sha256`：PRD v1.11 正文、证据集索引，以及 v1.11 参考证据集的说明、两个实现、测试与向量。来源与并入过程见 [`contracts/来源与指纹.md`](../../contracts/来源与指纹.md)。这些摘要没有按当前工作区重新生成；恢复时已逐项核对当前文件与历史记录一致。

在仓库根目录运行：

```bash
sha256sum -c docs/baselines/prd-v1.11-go0.sha256
python3 protocol/kvvi-json-c14n/v1/evidence-sets/prd-v1.11/tests/test_conformance.py
```

摘要检查固定来源文件，协议测试验证两种实现的行为。二者都保留在原 CI 工作流中；清单恢复不改变冻结对象，也不替代 MetaSchema 或完整 Agent 的运行验收。需要修改冻结对象时，应按其评审与版本化流程建立后继证据集，保留原清单。
