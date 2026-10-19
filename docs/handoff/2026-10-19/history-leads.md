# 旧会话线索：缺失实现，不能作当前验收证据

以下来自旧会话保留记录，仅用于避免重复踩坑；没有取回对应源码/包字节。0–2和4普通范围曾被报告验收通过，3A/3C/7A曾被报告局部通过；这些结论不自动授予当前c6fb代码，需重新复验。

- 旧HEAD：53f9e968870a603f3b74d67f2270e42dd6c6189e；旧分支codex/acceptance-remediation-cloud。源码和未提交工作区未找回。
- 旧root续作记录：.superpowers/sdd/acceptance-improvement/root-resume-20261015T1306.md，历史SHA256 ddc88dfe586246561f88855b423d90fb228d96fbd4a531a9284bc512eb7f6b7c，21936B；文件未取回，不能从该hash重建内容。
- 10C实际产品迁入包：/dev/shm/kvvi-task10c-server-product-integration-20261015/task10c-server-product-integration.tar.gz，69753B/46成员，SHA256 74a31c6fb443b326e3f0f474ab5a3706d1b9b30be3bb68ef13f54e1e9d04cf52；旧作者确认没有commit/push或外存上传。
- 10C外部7path候选：67688B/69成员，SHA256 ea4bed772357526cfd49166456c1c5098acd57c86839af42387bea1944066d59；补丁SHA256 41ed0f20f5de4faa892641098477818a84fd6c910db7f3186f1c09feace6c562。
- 10A内部非激活迁入包：/workspace/.kvvi-remediation/task10-reviewed-product-port-20261015/reviewed-product-port.tar.gz，155804B，SHA256 5ce374da07457f305e61b05134e30e2a7d67f91f534b34900e13575ad3b5283c，包未取回；当时没有完成worker/HTTP/cgroup实际资格或安装激活。
- Task9只读CLI候选：98688B，SHA256 cd4f33d0ba37c21bd68c9d856c34363df868f979e1fdcb5e094502f196032e62，包未取回；历史plan/apply返回UNQUALIFIED/EXECUTOR_NOT_CONFIGURED，不是升级切换完成。
- Task4普通验收闭合包：169667B/66成员，SHA256 58aef5273adf2db087015645bc555fd8bcf5a296d737045baf123840277fb41c，包未取回；历史案例包括1POST/1receipt/version1、回复丢失、Bob阻断、Alice新session、整页刷新后原key查回COMMITTED。

旧实现中发现过、重新实现时值得覆盖的具体问题：

1. ROLE功能inventory-ready依赖activated writer时，不能无条件用于全局health，否则普通旧部署不能启动；应在实际功能入口验证。缺提交事实是确定拒绝，SELECT/目录不可用才是服务不可用，不能混报。
2. 审批/pending共享实际ROLE完整引用与当前成员资格；历史workflow要固定历史目录版本，不能拿最新head替代。全局同名ROLE不等于提交人的主管。
3. READ MAC必须绑定实际raw Buffer的method/path/body/audience和当前身份；UTF-8/BOM边界不能在计算摘要前静默改变。
4. 未知提交结果保原key；目录/资格查询失败不能写成确定ABORTED或伪造DENY；长期任务不能靠新key重放。
5. 升级pending重启后可读不等于已经耐久；发RPC/CAS前要完成原文件fsync和目录fsync及身份/字节读回，不能先产生远端head再发现本地不耐久。
6. 组件modelRef使用正式canonical摘要，不把旧sorted row fingerprint冒充官方摘要；所有视图检查在首次INSERT/发布效果之前，批准baseline在实际提交/发布时重验。
7. 组件safeView会丢引用，员工DTO须由server实际binding提供ref；不能让UI从投影后的模型重新造ref，也不能泄漏未投影的模型内容。错误映射只发固定安全码，不发含隐藏字段的detail。
8. 文件锁、维护标记、空cgroup、JSON ready或单元测试桩都不是活的实例、执行资格或部署证明；实现/测试阶段要清楚区分这些证据。

这些线索不许可把缺失功能当成已经实现。原受平台限制的流程不转交模型规避限制；普通产品源码、UI、SQL及隔离维护验证可继续。
