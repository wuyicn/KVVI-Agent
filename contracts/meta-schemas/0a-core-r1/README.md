# 0A core Meta-Schema r1

本目录是 `0a-core-r1` 的机器契约包。它只属于 Go-0 已允许的 0A 契约试验，不是平台实现、部署、生产验收或任何后续 Go 门禁的证明。所有 CLI 结果固定包含 `release_approved: false`。

2026-09-10 外部审查修复另见 [FIX2 规则与采纳记录](EXTERNAL-REVIEW-FIX2.md)及[本轮验证记录](../../../docs/verification/2026-09-10-0a-meta-schema-external-fix2.md)：补辅助密钥检测、固定可信 Registry 格式集合、纠正编号标签限制和 Business 权限诊断。下述 2026-09-09 报告是历史运行，不证明 FIX2 已通过；当前源码须绑定新 run。深嵌套 M-4 仍是已知未关闭的范围限制，不能声称全输入域一致。

## 当前范围

- `common.schema.json` 导出闭合的 `AssetRef`、`CapabilityRef`、`Audit`、共享标量，以及可组合但不提前闭合的 `RegisteredBase`。三个最终 `RegisteredContract` 以 `unevaluatedProperties: false` 关闭公共与本地字段的并集。
- 三个契约文件的根入口都是 `CompiledDraft`，并导出 `#/$defs/Spec` 和 `#/$defs/RegisteredContract`。
- BusinessSchema 提供十种 v1 类型的封闭结构与静态校验，见 [Business 契约说明](BUSINESS.md)。ViewSchema 提供三类页面、六种安全引用和固定 Fake 注册资产校验，见 [View 契约说明](VIEW.md)。Task4 已组合真实引用解析、摘要复算、作用域、历史身份和依赖正文检查，私有格式与边界见 [CONTEXT.md](CONTEXT.md)。
- AppSpec 九个正文键全部必填；Business/View 可非空，导航必须精确引用成员。automation/integration 固定空；Workflow/Permission 非空可通过结构，但 complete 返回 `DEPENDENCY_VALIDATOR_UNAVAILABLE`。
- `complete` 按 `structure → semantic → references/history` 执行，在首个失败阶段停止。`stage` 报告实际停止阶段；完整成功为 `complete`，仅结构成功为 `structure`，原始协议解析拒绝为 `canonicalization`。共享 harness 比较独立 `expected_stage`，不根据预期推导实际阶段。

## 安装与验证

```sh
npm ci --prefix tools/meta-schema/node --ignore-scripts
python3.11 -m venv .venv
.venv/bin/python -m pip install --require-hashes -r tools/meta-schema/python/requirements.lock
.venv/bin/python tools/meta-schema/verify_bundle.py --suite 0a-core-r1
.venv/bin/python tools/meta-schema/record_evidence.py --suite 0a-core-r1 --verify-current
# 源码需先提交；一次运行包含 unit/tool-fault + 完整共享双 CLI 采集及报告核验
.venv/bin/python tools/meta-schema/record_evidence.py --suite 0a-core-r1 --new-run
```

迭代时可加 `--case-id <id>` 或 `--group <group>` 聚焦运行；省略时仍运行完整清单。每条 case 的两个语言进程并行启动，但独立读取同一份原始字节并分别记录结果。

聚焦命令使用 `.venv/bin/python tests/meta-schema/test_conformance.py --case-id <id>`；仅跑 unit/tool 故障检查使用 `.venv/bin/python tests/meta-schema/run_unit_checks.py`。`--new-run` 已执行一次完整共享采集，无需在同一版本前后重复跑全部 CLI。每个 CLI 保持 15 秒限制，内部 c14n 保持 10 秒限制；CI 的 45 分钟仅为安装与整个作业预算。

## 本次证据与范围

[控制者交付核验](../../../docs/verification/2026-09-09-0a-meta-schema-controller-closeout.md)记录本机完整复验、最终独立修复复审 PASS 及来源摘要。它形成于实现 PR 创建前，服务端 CI 与负责人合并批准以 PR 后续实际记录为准，不由本机通过推定。

[当前最终修复作者记录](../../../docs/verification/2026-09-09-0a-meta-schema-final-fix.md)、[FIX1 历史记录](../../../docs/verification/2026-09-09-0a-meta-schema-fix1.md)与[初次历史记录](../../../docs/verification/2026-09-08-0a-meta-schema-implementation.md)区分来源提交、作者本机验证、独立任务评审、CI 配置与尚待服务端执行的检查。方案为已批准并合并的 [PR #2](https://github.com/wuyicn/KVVI-Builder/pull/2)，实现另行提交 PR，合并仍需负责人新的明确批准。

`tests/meta-schema/expected-inventory.json` 独立固定每个 case 的编号和完整字面预期摘要，以及 unit 方法清单；`coverage.json` 对应 57 个有 S/L 部分的条款组；`coverage-audit.json` 列出封闭位置、数量/长度边界、十类型、三页面及错误码的具体 witness。C03、C07、C08、C09、B22、A07 的运行时责任逐行保留；B16、V15、A08、E04 不计本批实现通过率。原文示例与 Fake 重绑示例保持两个独立用途。

正式 run 存于 `evidence/meta-schema/0a-core-r1/<run-id>/`：`report.json` 保存输入/上下文前后哈希、原始 stdout、退出码、阶段、两语言诊断、工具版本、源码与锁文件绑定；`report.sha256` 是外置报告摘要。`source.bundle` 自包含地保留精确源码提交及其可达历史，SHA-256 写入报告。核验在临时 bare 仓库离线检查唯一 HEAD、对象完整性、完整源码路径集合和当前文件字节；不向当前仓库导入对象，也不依赖 squash 后的祖先关系。新 run 拒绝覆盖已存在目录，失败或部分目录不能成为当前通过证据。

`current.json` 只指向最终当前源码绑定的 run；历史 run 保留但不代表当前源码通过。源码、fixtures、预期、Schema、manifest、上下文格式、锁或 CI 变更后必须先新建源码提交，再新增 run。说明文档和证据的后续提交仅在所有已绑定源码字节仍相同时可核验。

实际 loader 与 standalone preflight 均检查固定四资源、manifest/源绑定、严格 JSON、未知 keyword/format/ref、重复 ID 和真实引擎自校验。CLI 内部只在单次同步调用中复用已核验 bundle；下一次调用重新读取。用于参数声明的 Ajv fragment probe 保持单独引擎，既有 `strictTypes:false` 窄例外不会进入主校验器。

FIX1 进一步让真实 Ajv 编译所有未用及嵌套 `$defs`，不只编译根入口；`$ref` 的完整 fragment 保留并核验，不会在第二个 `#` 截断。合法定义及完整转义指针对照与实际双 CLI 故障检查独立保存。

最终整分支修复将同一完整定义预检责任补齐到可信 Registry 的四个 Schema 槽；已有 View 草案要求精确删除历史；参数投影按一次调用内的精确 Schema 身份复用隔离引擎，保留下一调用重验；View 扫描采用独立裁定的固定字符/词界/位置表。证据按源码锁文件记录全部 6 Python + 6 Node 实际依赖并检查完整成员与版本类型，历史报告不要求等同复验机器环境。独立审查原文与完整 19 条裁定（含两项证据收口裁定）保留在作者记录的来源链接中。

Node 依赖锁定 Ajv 8.20.0 / ajv-formats 3.0.1；Python 直接及传递依赖均固定版本并记录正式分发包哈希。加载器只使用 `manifest.json` 登记的本地资源，不请求网络。校验器及 bundle 自检调用子进程时默认 10 秒超时；Node c14n 输出缓冲为 16 MiB，覆盖批准的 1 MiB View 正文及规范化包装。超时、缓冲溢出或其他运行时资源故障输出 JSON 执行失败并退出 1，不伪装成协议拒绝。

## CLI

两个独立进程使用相同的公开参数和 stdin 原始字节协议：

```text
--contract business-schema/v1|view-schema/lce-safe-v1|app-spec/v1alpha1
--entry compiled-draft|spec|registered
--checks structure|complete
--context <trusted-fake-context.json>  # complete 时需要
```

Node 入口为 `tools/meta-schema/node/cli.mjs`，Python 入口为 `tools/meta-schema/python/cli.py`。成功退出 0，实例/协议拒绝退出 2，依赖文件、上下文文件或进程异常退出 1。`input_sha256` 总是 stdin 原始字节摘要；规范化和校验不改写输入。
未知参数、重复参数、缺值和非法固定值在两端均输出 `CLI_ARGUMENT_INVALID` 并退出 1；公开 CLI 不接受自选定义或 Schema 路径。

## 模块接口

Python 使用 snake_case：

```text
structure.validate_structure(contract, entry, value, bundle_dir=...)
structure.validate_definition(definition, value, bundle_dir=...)
semantic.validate_semantic(contract, entry, value, context)
semantic.validate_business(spec, context, path_prefix)
semantic.validate_view(spec, context, path_prefix)
semantic.validate_app(spec, context, path_prefix)
references.validate_references(contract, entry, value, context)
diagnostics.diagnostic(code, path)
diagnostics.sorted_unique(errors)
```

Node 对应 camelCase：

```text
structure.validateStructure(contract, entry, value, bundleDir)
structure.validateDefinition(definition, value, bundleDir)
semantic.validateSemantic(contract, entry, value, context)
semantic.validateBusiness(spec, context, pathPrefix)
semantic.validateView(spec, context, pathPrefix)
semantic.validateApp(spec, context, pathPrefix)
references.validateReferences(contract, entry, value, context)
diagnostics.diagnostic(code, path)
diagnostics.sortedUnique(errors)
```

所有校验函数返回已去重、按 UTF-8 路径和错误码排序的诊断数组。结构引擎拒绝与诊断归一相互独立：底层引擎判定失败时数组保证至少一条诊断；`anyOf/oneOf` 失败保留组合器所在字段路径，仅在已有更具体的独立子路径错误时抑制父级级联。`validate_definition` / `validateDefinition` 仅供共享导出定义的定向测试和内部消费，不扩张公开 CLI 的信任入口。引用阶段发现的依赖正文结构或静态错误按依赖路径报告，实际阶段为 `references`，不与当前正文静态错误混合。

共享 cases 每条必须有唯一 `id`、`groups`、`input`、`contract`、`entry`、`checks`、`expected_stage`、可选 `context` 和手工字面 `expected`；`expected` 同时固定 `suite_revision/entry/checks`、退出码、有效性和诊断。黑盒要求实际 runner 与 outcome 的键都恰为 `python,node`，分别运行两个语言进程并核对原始输入摘要和文件不变性；每个 runner 默认 15 秒超时，超时归为 harness `RunnerFailure`。两实现同时给出同一个错误结果不等于符合期望。

Common 的日期 `format` 使用两引擎显式注册的 D03 profile：真实 Gregorian 日历、年份 0001–9999、ASCII 数字、秒 00–59、可选非空小数及明确时区。审计 Schema 另限定大写 `T/Z`；不接受闰秒、无时区、Unicode 数字或尾随换行。Python 不再依赖可选安装包决定是否执行 date-time；Digest 同时固定长度 71，消除 Python `$` 可匹配尾随 LF 的差异。两端均使用真实 Draft 2020-12 引擎。
