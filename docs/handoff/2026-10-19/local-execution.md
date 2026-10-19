# 本地整改执行账本（2026-10-19）

依据：[交接](../../交接-本地Codex-2026-10-19.md)、[12项清单](remaining-tasks.md)、冻结 PRD v2.16、补充需求 v1.1。起点为远端交接分支，工作分支 `codex/local-remediation-20261019`。接手时外层与忽略的 `vendor/dsh` 工作区均干净；没有丢弃或覆盖本地改动。现有试点不自动部署。

## 需求与执行映射

| 项 | 需求依据 | 实施/验证落点 | 状态 |
|---|---|---|---|
| 0 | 交接§1/§3；补充§13 | 分叉逐项比较、固定源、隔离PG、fork重建 | 进行中 |
| 1 | PRD§2.5/§9.6.7/§9.9 | refs/authorization/admin-api；实际PG/API串系统、自授权、撤权 | 待复验 |
| 2 | PRD§9.6；补充§7.3 | publish-api/publish；审批绑定内容、原子回滚、多系统并发 | 进行中 |
| 3 | PRD§2.5.2/§9.11.2 | refs/commands/system-api/audit；字段规则、原key持久恢复 | 待整改 |
| 4 | PRD§5.4；补充§8 | kvvi-panel；字段投影、十类型、dirty patch、身份绑定恢复 | 待整改 |
| 5 | PRD§5.3–5.5/Q16 | 五Skills、模板、蓝图、组织映射、真实DeepSeek DSH | 待整改 |
| 6 | 补充§9.1–9.5/G9 | distribution；配置/进程/备份恢复/卸载 | 待整改 |
| 7 | PRD访客与契约边界 | visitor/契约扫描/固定依赖；签名链接并发 | 待整改 |
| 8 | 补充§7.2/§8/G8；Q16 | workflow/待办/组织/aggregate与UI | 待整改 |
| 9 | 补充§9.4/§9.5 | upgrade；支持矩阵、停写、三库迁移与恢复 | 待整改 |
| 10 | PRD§9.10；补充§10/G10 | 离线签名扩展、组件来源、多模型多视图、子表/附件、长任务 | 待整改 |
| 11 | 补充§12–13/G7–G10 | 完整构建、发行包与指纹、真实UI/模型/macOS干净用户 | 待执行 |

以上状态不代表12项完成。每个子项需要当前提交、命令、结果和反例，不继承历史通过数。

## 环境与基线

- Node：默认24.19.0；明确选用 `/Users/wuyi-macs/.local/opt/node-v24.20.0/bin/node`（24.20.0）。Python 3.9.6。全局pnpm11.25.0，DSH固定声明11.7.0，后续构建须核对固定执行器。
- PG：`/opt/homebrew/opt/postgresql@17/bin/postgres --version` → 17.11。没有PG18执行器，不主张17→18已支持。
- 隔离基线：在 `services/platform` 执行 `KVVI_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin /Users/wuyi-macs/.local/opt/node-v24.20.0/bin/node tests/run-isolated.mjs npm test` → exit0，571项中570通过、1跳过、0失败。只创建并停止runner自己的临时集群，不继承试点DSN。日志保留在本地忽略目录 `.local-remediation-evidence/platform-baseline.log`；发布证据需另存非敏感摘要与SHA。
- 两线共同祖先 `0ae8e21b`；原验收线独有23515852、efde7293、b14647a4、8184df26。已发现当前缺少b14647a4的发布内容摘要与执行身份连续性保护，逐项整合，不整树覆盖。

## 执行规则

- 沿用交接指定的依赖顺序，主代理单一写入，独立代理只读审查；测试先重现反例再修复。
- 本地分支原地续作是交接§2指定路径；不额外重建/覆盖已有vendor checkout，构建使用另建固定源副本。
- 分批记录结果并提交推送到本续作分支；暂存检查排除凭据、会话、数据库与原始敏感日志。
- 真实DeepSeek、干净macOS用户、真实UI及跨实例恢复各自取证；缺环境继续独立工作，并保留未执行状态。

## 批次1：恢复发布内容摘要保护

- 按行为单独整合原验收线 `b14647a4` 的发布摘要及4条测试，保留当前的系统策略归属、发布事务和business-build-intent接线。
- RED：在隔离PG运行 `node --test services/platform/tests/publish-api.test.mjs`，视图、模型、显示名/schemaCode变化三条测试均因旧草案被复用（200而非201）失败；相同内容复用正向对照通过。
- GREEN：隔离runner运行publish-api、publish-atomicity、p1-blockers三文件，26/26通过，exit0。覆盖内容改变不复用旧审批、相同内容复用、S3契约写入失败完整回滚和S4系统策略共存。
- 全平台回归：隔离runner `npm test`，575项中574通过、0失败、1跳过，exit0。保留的跳过项是 `响应已经开始写之后再出错 → 断开连接，不改状态码（尚无稳定装置）`，没有当作通过。
- 固定fork独立重建：`python3 工具/fork.py --rebuild --into <忽略目录>/fixed-dsh`，固定基线12071文件、232覆盖、8删除，232/240指纹和8/8删除匹配，exit0；原vendor工作区未改动。尚未构建客户端或部署。
- 任务2仍未整体关闭：审批后资格变更、多系统并发及完整实际版本核验继续单独验证。

## 批次2：只读运维计划与实例配置（D4/D5/D6）

- 新增7条CLI/配置测试。先复现start计划被就绪检查阻挡、stop计划AttributeError、runtime_port缺失、launchd忽略JSON、安装不保存自定义runtime端口；再修复。
- `ProcessPlan.describe()`只展示home、端口与步骤，不输出环境变量；start --plan不做执行前的就绪检查、不创建实例。
- 配置优先级明确为显式JSON > launchd/进程环境 > 目标home已安装kvvi.env > 默认值；home与三个端口贯通配置、启动、就绪检查和plist，安装保存runtime端口。launchd仍只生成plist，本轮未安装/注册LaunchAgent。
- 发行清单补入 `docs/操作手册.md`。这只是修复包源选择，最终发行包及包内文件另验。
- `python3 -m unittest distribution.tests.test_cli_configuration distribution.tests.test_supervisor distribution.tests.test_pg distribution.tests.test_preflight distribution.tests.test_backup_restore distribution.tests.test_install_skill` → 127/127，exit0；使用临时目录、自有子进程/集群。新测最初因其临时release_root没有签名模块失败，改为真实只读release_root与临时home后通过；未修改产品来绕过该错误。
- 同期新增的停止失败/恢复返回码反例已RED，保留在下一批修复，任务6不关闭。PG PID身份/子进程、备份凭据、真实源目标恢复、干净用户launchd继续待验。

## 批次2独立复核与修正

- 只读复核发现低优先级的非法端口仍能阻断有效JSON、自定义PG端口与已安装DSN可能不一致、preflight未探测自定义runtime端口。新增反例均先RED，再修复；安装计划同时展示runtime端口。
- 配置逐键先选择最高优先级，再解析；CLI传入PG端口，`start_plan`在迁移前拒绝已安装PG端口/DSN不一致（`KVVI_INSTANCE_PORT_MISMATCH`），不会自行改写或迁移旧集群。
- preflight使用解析后的三个端口，真实临时监听socket可被检测并报告。
- 配置/运维已有范围回归由127增至130项，130/130、exit0。自定义restore重启端口将在下一批与失败保持停机一起修复；故批次2不单独构成完整D5验收。

## 批次3：恢复/卸载失败时停止后续动作

- RED：停止返回失败或抛异常仍继续恢复/删除、非零空stderr/信号退出被判成功、部分恢复失败后CLI重启、重启失败仍报成功均已重现。
- `_restore_failed`现在对任何非零失败；pg_restore使用单库事务与exit-on-error，超时/执行异常结构化报告。三库不冒称一个原子事务；第二库失败时报告第一库已完成。
- 恢复与卸载要求停止回调明确返回True或`{ok:true}`，没有停止确认或失败不解包/删除。CLI检查应用停止与purge时的集群停止结果；恢复失败保持停机，成功恢复但重启失败返回失败，自定义runtime/PG端口保留。
- 恢复在目标home的 `.kvvi-recovery/restore-*.json` fsync保存阶段、当前数据库、已完成步骤、归档摘要和失败码。中断中的RUNNING记录不解释成成功；这不是自动续跑执行器。解包使用本次独有临时目录，清理只处理本次目录。
- `python3 -m unittest discover -s distribution/tests` → 149/149，exit0；新增CLI编排测试明确使用stub，仅证明调度边界，真实PG测试仍是隔离同集群恢复，不能代替独立源/目标。
- 未关闭：PID身份与完整进程树、launchd停写协调、凭据归档边界、跨实例身份/审计连续性、升级执行器及干净用户旅程。

## 批次4：归档边界和目标凭据保留

- 新增6条归档实测，先重现递归凭据泄漏、自定义home内输出/历史备份被收录、旧包覆盖目标kvvi.env、特殊文件可解包、内层坏包在停机后才发现；另加输出位于home祖先时不能漏备整个home的反例。
- 已知实例凭据、secrets/pgdata/run/log/backups/recovery目录、`.env*`及私钥类文件逐层排除；按真实路径排除自定义输出，保留同级正常状态文件。备份暂存使用本次独有目录，避免删除别人的 `.staging`。
- 内层归档在停止服务和导库前完整只读校验；禁止穿越、链接、重复目标、设备/FIFO和目标路径符号链接。恢复旧包时跳过受保护实例凭据，保留目标kvvi.env与密钥，不影响正常运行状态文件恢复。
- `python3 -m unittest discover -s distribution/tests` → 155/155，exit0。此处证明已知产品凭据路径边界，不承诺任意客户业务文件里不会手工写入敏感信息。
- 任务6仍待PID起始身份/子进程、launchd停写、独立源目标三库及干净用户验收。

## 批次5：升级/回滚未知状态拒绝

- RED：没有执行器的MajorUpgradePlan.apply仍返回ok:true；账本连接失败、空输出及非法JSON均被当作零迁移，CLI允许回滚。
- 现在无执行器明确返回 `KVVI_UPGRADE_EXECUTOR_UNAVAILABLE`，不动数据库；账本未知返回 `KVVI_MIGRATION_LEDGER_UNAVAILABLE`、exit2，禁止把未知当成可以回滚。
- `python3 -m unittest discover -s distribution/tests` → 162/162，exit0（包括同期尚在独立复核的PID身份测试）；本批提交仅包含upgrade/rollback及对应反例。
- 任务9仍未实现完整升级旅程。PG17→18未取得支持资格，本机也没有PG18执行器；没有将拒绝执行的保护宣称为升级完成。

## 批次6：PID起始身份和可观察子进程

- PID解析拒绝空值、0、1、负数与非十进制；真实活进程缺少身份或身份不匹配不发停止信号、不删记录。身份绑定home、releaseRoot、program、UID、PGID及内核起始标识（Darwin微秒时间，Linux启动ID与start ticks）。Darwin结构依据本机SDK的sys/proc_info.h核对。
- `_spawn`保存0600身份文件、拒绝覆盖活跃/未知实例记录、关闭父侧日志句柄；start观察不再把僵尸当活进程。stop确认自身进程组及已观察到的另session子进程退出后才清记录。
- 独立审查发现并复现：内核读取EACCES被当成退出、root先退出不能证明另session子已退出、SIGTERM处理器改变PGID可逃过等待。已以反例修复：unknown拒绝；开始stop时root已退出保留记录报`KVVI_PROCESS_EXIT_UNCONFIRMED`；子身份比较只含不可变的PID/UID/startIdentity。
- 新增invalid/legacy PID、真实身份不符、真实结束、重复spawn、内核EACCES、root先退、另session子进程及SIGTERM内换session等测试。PGID反例另以恢复旧的全字典比较执行一次，确实RED，正常实现GREEN。
- 全distribution回归：`python3 -m unittest discover -s distribution/tests` → 167/167，exit0（含同期归档复核修正）。
- 边界：瞬时子树快照不是持续托管监督。root已退出的记录现在保守拒绝自动处理，需要后续可审查的恢复路径；launchd协调、快照之后新生并脱离的子进程及完整停写栅栏仍未关闭。未操作已有试点，全部动态进程测试为自有临时子进程。

## 批次4独立复核与修正

- 独立复核用临时包复现：停止回调替换原归档路径，恢复会使用未验证的B而非已验证的A；内层普通文件a与a/b结构冲突直到导库后才失败。
- 先复制到0700私有目录下的0600快照，再让校验、预检、解包及receipt摘要全部使用同一份字节。即使原路径/内容在停止回调中改变，仍恢复A，receipt也绑定A。
- 预检新增成员父路径类型冲突与现存目标父文件检查，全部在stop/导库前拒绝。
- 上述两条反例先RED；全distribution167/167、exit0。没有更改历史备份或现有实例。
