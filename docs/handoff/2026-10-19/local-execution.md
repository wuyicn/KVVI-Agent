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

## 批次7：恢复固定CI清单与网络fork来源

- 从23515852逐字恢复CI已引用的 `docs/baselines/README.md` 与 `prd-v1.11-go0.sha256`，没有根据当前文件重新生成历史摘要；7/7 SHA-256匹配，参考c14n协议6/6通过。
- 仅整合fork网络获取源：从产品仓库vendor-dsh分支获取Git对象后检出固定导入SHA，仍叠加当前232文件与8删除；clone/checkout使用参数数组。
- 实际网络 `python3 工具/fork.py --rebuild --upstream git --into <忽略目录>/network-fixed-dsh` 及再次 `--verify` 均exit0，232指纹与8删除匹配。没有推送忽略的vendor或上游仓库。
- MetaSchema结构测试最初因系统Python3.9缺jsonschema失败；在独立Python3.12 venv按现有requirements.lock及哈希安装后，结构6/6通过。冻结清单与依赖版本未改。
- 独立fixed-dsh按现有锁文件离线安装，使用实际pnpm11.7.0，exit0；mode-router/business/publish三包基线6文件81测试通过。这是固定源测试，不是原vendor已更新或试点已部署。
- efde7293的九份Web fixture当前blob已相同，删除核对已有等效测试；原8184报告副本相同，无需覆盖。b146的后台身份/确认与有损装订拒绝仍需继续整合，任务0不关闭。

## 批次8：后台Agent身份与流程逐次确认

- 从b14647a4按行为整合WeakMap/ALS后台身份绑定与workflow_act执行器逐次allowed-once确认，保留当前builder-preview/business-directory/system-context接线；参数、记录、动作、版本及原身份在确认前冻结，迟到确认后复核取消和身份。
- 先导入旧反例，当前实现21项RED；补实现后8文件106/106通过、exit0。测试create现在返回真实SessionCreateValue形状，从Agent registry取Agent并窄化unknown；没有照搬旧implicit-any或把返回值当Agent的断言。HTTP输出测试增加真实Agent/ApprovalService及开放turn，其自动确认仅为传输夹具，不当作人工验收。
- 独立复核未发现增量生产绕过；发现旧包脚本会缩到tools.spec.ts，已恢复整个tests目录，保留model-output.spec.ts默认覆盖。
- 固定pnpm11.7.0离线安装使用frozen-lockfile；锁文件仅新增workspace importer links，外部解析版本未刷新。
- 在独立registered-fork从固定基线及镜像建立可核对Git提交，用现有G2生成器生成242路径指纹；G2登记52条/242路径全匹配；新鲜重建234覆盖+8删除全部匹配。原vendor未改；内层仓库没有向任何remote推送。
- 根host类型检查exit2，共284条诊断；本批两包无诊断。主要是既有Context上的SessionControllerLike/AgentPresetsLike窄声明污染真实服务面；任务11仍须修复，不能将包测试通过写成完整构建通过。
- 未执行真实DeepSeek：当前进程无DEEPSEEK_API_KEY，工作区settings无DeepSeek配置。已向用户询问安全配置位置，继续独立任务；没有读取聊天中的密钥、调用付费模型、更新试点或刷新历史快照。

## 批次9：真实服务类型与契约装订边界

- 移除mode-router对Context.sessionController/agentPresets的窄全局重声明，引用真实服务类型与对应项目；create保留真实请求字段并构造SessionId。根host类型检查由284条诊断降为0，`pnpm exec tsc -b tsconfig.host.json --pretty false` exit0。
- CLI与Agent均拒绝多份非工具契约并列出文件，工具契约全部装订；拒绝契约内及被排除子树中的符号链接。新增反例先RED，含排除子树循环链接、全局路径排序。
- 独立复核另复现非BMP文件名排序差异、CLI根符号链接尾斜杠绕过；追加反例先RED，再统一UTF-8字节排序及规范化根路径。Python/实际TS对拍12/12、三包8文件110/110、exit0；没有以拒绝多视图冒称多视图已实现，也没有宣称覆盖目录并发替换的TOCTOU。
- `pnpm run build`最初因默认Node24.19.0不带Node-API头文件在native阶段失败；明确PATH选择已安装的Node24.20.0后，最终完整构建exit0（native→host/client库→Web，252个client产物）。没有改依赖版本、刷新历史快照或部署试点。
- 现有G2生成器使用隔离registered-fork生成242路径指纹，登记52条全有效；新鲜绝对路径重建234覆盖+8删除全部匹配，exit0。相对--into重建会因cwd不一致失败，已记录待修，未把它算成成功。
- 同期在新建隔离PG17集群重跑p1-blockers/publish-atomicity/field-write-consistency：12/12、exit0。只证明当前这些反例；任务1/2的并发及撤权扩展、任务3的耐久审计与原key恢复仍未关闭。
- 用户提供的kvvi.env路径存在，关联runtime运行，但只读键名检查未发现DEEPSEEK_API_KEY；不打印配置值，不重启试点，真实模型仍未执行。

本批可复现命令（所有DSH命令均在新建固定源副本执行）：

```sh
KVVI_PUBLISH_TEST_RUNTIME=<固定源绝对路径> python3 -m unittest 工具.test_publish_contracts
pnpm exec tsc -b tsconfig.host.json --pretty false
pnpm exec vitest run packages/host/kvvi-mode-router/tests packages/tool/kvvi-business/tests packages/tool/kvvi-publish/tests
# PATH首项为已安装的Node24.20.0/bin，pnpm实际11.7.0
pnpm run build
python3 工具/fork.py --rebuild --into <新的绝对路径>
KVVI_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin node services/platform/tests/run-isolated.mjs node --test --test-concurrency=1 services/platform/tests/p1-blockers.test.mjs services/platform/tests/publish-atomicity.test.mjs services/platform/tests/field-write-consistency.test.mjs
```

非敏感本地日志摘要（原始日志保留在忽略目录，不作为唯一证据）：

- `contracts-python-green.log`：SHA-256 `fb4f9aa8879de210e18f3e3bedae7d73c00bdeb624b61e619d22b469952a5614`，111字节。
- `runtime-contracts-typecheck.log`：SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，0字节。
- `runtime-contracts-green.log`：SHA-256 `da08e79eb73f8a2acc53921f5024d6382ff6437a2dfc43c9b2eebbb1229bde17`，949字节。
- `full-build-final.log`：SHA-256 `6f76476dac6895d2de007d77b4073486750d6b8fe52e377af0af3caed9b07807`，352804字节。
- `contracts-g2.log`：SHA-256 `61029deaffe9ca8282dca037170e05eeac125381f820c7010f3eff1d08c7bc96`，423字节。
- `contracts-rebuild.log`：SHA-256 `cb6ae68661832a91373f9b415ac267b85446e272b60a99985b17a137ddffe74e`，440字节。
- `security-publish-fields-current.log`：SHA-256 `040b1056941e13f76f8468b0095af90219d101ccbe8baabeab47d5a99f725e0d`，1620字节。

## 批次10：独立审计库幂等追加基础

- 新增SQL35操作回执与audit_append_once；同操作ID绑定全部实际审计参数。回执与哈希链条目在同一审计库事务提交，与既有append共用链锁；重复返回原hash，改参数/账号/公司明确拒绝。原无operationId入口保持原语义。
- 真实隔离PG先重现同ID返回不同hash、16路并发追加16条、改变内容仍放行及缺回执表等失败；修复后审计/结构定向26项，25通过、1个既有跳过，exit0。额外注入receipt存储失败，证明链条目也回滚。
- 独立复核发现既有provision仍授audit角色public CREATE、新SQL提交后账本未记时不能重跑；收紧provision/grantAudit到USAGE且撤销CREATE，新DDL可重入。新增真实CREATE FUNCTION被拒、模拟SQL已提交但账本未记后的迁移重跑，原回执与hash保留。
- PostgreSQL的DO INSTEAD NOTHING规则会在权限检查前将UPDATE/DELETE改成空操作；测试核对实际权限为false且内容不变，没有把“不抛异常”误读为可以篡改。
- 当前仅交付审计库基础与[后续设计](write-recovery-design.md)，业务写入、原key恢复、commands/流程/访客和UI仍待接线。没有宣称跨库原子事务或离线审计签名缓冲已完成。

## 批次11：创建/PATCH业务回执与原key恢复

- 新增SQL36：公司/账号/规范化端点/key唯一回执，保存请求摘要、原响应、服务端operationId、原审计payload及投递进度。业务记录、单号序列、回执在同一business事务提交；原key不按24小时过期自动重做，同key改payload拒绝409。历史平台回执没有摘要，明确拒绝再次写入，保留人工核对需求。
- refs读写、runtimeProjection及表单生命周期支持显式复用同一client，原调用方式保留。首次并发回归发现嵌套借连接耗尽池等待，已定位到投影另开business连接并修正；修正后12路同key只有一条效果。PATCH回放在当前动作/字段/行范围检查之后、旧rowVersion重新执行之前；大写UUID与属性顺序变化仍命中原操作。
- 审计不可用时已知business提交返回原结果及auditPending；业务回执存储失败则业务行和序列全部回滚。COMMIT已成功但确认丢失的真实事务反例返回503/KVVI_OPERATION_OUTCOME_UNKNOWN和原key，重连后同key找回原结果。新session重试仍投递原session审计payload；换账号/公司、动作撤权均不得读回别人的回执。
- 原审计已提交但marker更新失败的真实触发器反例，按原operationId重投仍只留一条审计。后台使用独立timer和有限批量；重试时间持久化并退避。真实新平台进程自动重投已保存回执，并可在healthz观察pending计数；测试只启动自有临时服务及集群。
- 独立复核真实复现audit池8连接占满时，旧query_timeout不覆盖checkout；补统一5秒deadline（连接/SQL/行锁/审计/marker），迟到连接不用即归还，SKIP LOCKED立即返回pending，审计网络I/O期间不持有business连接。枚举查询也纳入deadline，真实表级锁超时后可再次运行。
- 完整平台首轮595项：592通过、2个新增测试失败、1个既有跳过；失败均为测试使用repo相对路径，npm工作目录下子进程找不到源码。修为基于import.meta.url的绝对路径后重跑：597项，596通过、0失败、1个既有跳过，exit0。runner与npm子进程明确使用Node24.20.0，PG17.11。
- `python3 -m unittest discover -s distribution/tests`：167/167、exit0。非敏感命令、输入文件与日志摘要另存[本批验证记录](verification-write-recovery.json)。
- 任务3仍未关闭：commands、流程、访客尚未接入本回执；UI/Agent的身份绑定原key持久保存属于任务4，仍需实现。撤销与写入并发的完整栅栏、离线签名审计批次也未完成。旧回执人工恢复路径另需交付，不建议用新key覆盖未知历史结果。

## 批次12：fork重建目标路径

- 批次9已记录的相对目标路径失败已单独修复。使用自有临时Git基线，实际复现相对路径、空格路径、中文空格路径三种失败，再将local导出改为独立参数数组及临时归档，不经shell拼接；rebuild入口规范化绝对目标路径。
- `python3 -m unittest 工具.test_fork_paths`：1项测试含3个子场景全部通过，exit0；`python3 工具/fork.py --rebuild --into '.local-remediation-evidence/relative fork rebuilt'`：234覆盖与8删除全部匹配当前242路径指纹，exit0。原vendor及其remote未改。

## 批次13：详情dirty PATCH与无操作保存

- 先以6个失败断言复现：保存携带未变字段、原值恢复后仍写、缺失策略可编辑、不可变字段仅在发送时剔除却仍可编辑。详情现在只提交VISIBLE且MUTABLE的实际变化；no-op/revert禁用保存且不回调，HIDDEN/缺失策略不显示编辑器，CREATE_ONLY/SYSTEM/READONLY/MASKED锁定。
- SystemShell保存成功同时合并本次data与新rowVersion，使再次保存相同内容不再发PATCH；增加真实组件回路断言。旧“无改动也要保存”测试改为先修改字段，保留MASKED/HIDDEN排除、版本冲突及原类型不被连带写入的验证目标。
- 独立只读复核未发现增量问题。固定源`pnpm exec vitest run packages/client/kvvi-panel/tests`：18文件186/186、exit0；`pnpm exec tsc -b tsconfig.host.json tsconfig.client.json --pretty false`：exit0；明确Node24.20.0的完整`pnpm run build`：exit0。
- G2由隔离registered-fork生成，242路径/52登记匹配；新鲜重建234覆盖+8删除匹配。原vendor不变，试点未部署。
- 任务4仍未关闭：十类型编辑（尤其decimal/money精确结构）、未知/非法值拒绝、终态规则、迟到响应与身份绑定持久原key仍待实现。组件测试不冒称真实浏览器/数据库端到端验收。

## 批次14：后端十类型落值校验

- 在refs共用的field-rules接入闭合十类型校验，API/内部create/update均拒绝未知类型与不合法的原生JSON值，不把字符串布尔、截断整数、浮点decimal/money或逗号字符串数组强转为有效值。decimal保留精确十进制字符串，money保留amount/currency对象并复用现有ledger币种/标度规则；不以本批替代任务10的生产类型注册表绑定。
- 12条类型单测先RED；增加真实PG API十类型创建、更新与反例，直接核对JSONB中的false、0、数组、null、长decimal及money对象。非法更新后rowVersion不变。旧夹具的person/缺type改为正式文本类型，money标量改为冻结契约规定的对象；内部undefined属性按JSON编码的省略语义处理，不放宽真实JSON类型。
- 独立复核指出decimal缺省18/2与年0判据分叉；增加反例并直接复用冻结校验器的fitsDecimal/decimalParts/validDate/validDatetime，不另维护日期和精度算法。纯函数与消费布局32/32，exit0；最新完整平台611项：610通过、0失败、1个既有跳过，exit0。
- 容器源布局调整为/app/services/platform，明确只复制values.mjs/safe_pattern.mjs两个纯工具依赖；独立临时消费布局在没有仓库的目录中实际加载通过。Docker CLI存在但daemon未运行，真实镜像构建未执行，不冒称容器资格通过；没有启动daemon或现有服务。
- UI目前仍需接线：新增编辑器反例已重现现有parseFloat/parseInt的精度和截断问题，尚未计入本后端提交，也没有将后端拒绝称为完整十类型编辑完成。

## 批次15：详情十类型编辑

- 先以编辑器反例重现parseInt截断、decimal/money浮点化；详情改用原生boolean/integer、精确decimal字符串及money对象，多选使用真实multiple select。未知类型锁定并提示，非法输入不触发保存；补decimal默认18/2、币种标度、停用选项、日期/时间及null检查。
- datetime以本地控件显示、改变后转带时区ISO；未改动的原值（包括null、时区和高精度时间）不进入PATCH。记录切换仅使用当前recordId草稿。CREATE_ONLY/SYSTEM等既有锁定与dirty/no-op规则保留。
- 新增验证先RED；独立复核再发现过量小数与24点时间仍放行，追加反例后修正。全包首轮193项有1失败，为旧业务页夹具缺type造成预期保存被拒；补正式short_text。纯测试归属改为.client.spec.ts，避免将client API引进host类型程序。
- 独立复核另实际重现A→B仅查看→A时旧草稿复活并绑定新版本；补RED反例后在切换时清掉旧编辑。最终固定源19文件195/195、exit0；host/client根类型检查exit0；Node24.20.0、实际pnpm11.7.0完整构建exit0。G2生成243路径/52登记匹配，新鲜重建235覆盖+8删除逐字节匹配；原vendor和试点未改。
- 本批是详情组件与固定源构建，尚非完整十类型验收：创建表单转型、身份绑定耐久原key、迟到响应/终态及真实浏览器到数据库旅程仍待接线。真实DeepSeek凭据尚未确认可用，未执行模型验收。

非敏感日志摘要：
- `typed-detail-package-final.log`：SHA-256 `806a72c6101a3f5de1d8b4ae5cb5584e859a448376d6089409e3eba3de7b18f4`，12547字节。
- `typed-detail-types-final.log`：SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，0字节。
- `typed-detail-build-final.log`：SHA-256 `7e03f3744b36b28d3c763bda4eb9e92a7a2a0fee662835f0dbdc2a3d004c6138`，352493字节。
- `typed-detail-g2-final.log`：SHA-256 `7e57358d193bdf8a986a5c2c5a0f1ec5329148fd8548bd84a82bbf81ec2071bd`，423字节。
- `typed-detail-rebuild-final.log`：SHA-256 `ffb13469f22aa36795f2c93b252b355a905d5db8da79c9e5b728ab8e494ae6a1`，440字节。

## 批次16：隔离测试库失败与取消收尾

- 真实自有PG探针先复现start实际成功、控制命令返回42后测试库遗留运行；初始化与启动原在finally外。统一外层收尾，取消不依赖start确认标志；仅操作本次mkdtemp明确创建的数据目录。工具初始化/启动/停止有预算，测试命令保留自身退出码。
- SIGINT/SIGTERM结束当前自有进程组，失败/普通退出也回收测试命令同组子进程；工具命令不套普通测试退出清组规则。fast stop失败保留错误并确认实际状态，必要时immediate fallback；停止/诊断失败不报成功。
- 独立复核补出initdb错误日志丢失、普通exit43遗留同组子进程两处增量，均追加真实反例。分阶段日志存在数据目录旁的独立目录；诊断不可写时继续stop且非0退出。保留原隔离目标门禁，不放宽到任意目录。
- 中间日志布局曾引入子目录，完整回归先被既有目标门禁拒绝，后在macOS触发UNIX socket路径过长；已恢复短数据目录，旁置日志。最初取消反例暴露旧runner遗留测试子进程，已按生成脚本与自有临时路径确认并终止；最终反例使用有限寿命子进程及finally清理。
- 最终13项真实PG17.11定向测试全部通过；最新完整平台625项，624通过、0失败、1个既有跳过，exit0；runner确认自身测试集群停止。覆盖初始化失败、启动前失败/启动成功确认丢失、测试错误/缺失命令、stop确认丢失/fast失败、日志错误、初始化/启动/执行取消、顽固及普通退出遗留子进程。
- 本批修的是测试runner，不能据此关闭任务6的launchd/真实三库恢复或任务9升级执行器；脱离测试进程组的任意daemon不在本批回收证明内。没有重启或部署试点。

可复现命令：

```sh
KVVI_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin node --test --test-concurrency=1 services/platform/tests/runner-lifecycle.test.mjs
# services/platform目录，显式Node24.20.0 PATH
KVVI_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin node tests/run-isolated.mjs npm test
```

非敏感日志摘要：
- `runner-lifecycle-final5.log`：SHA-256 `565d992db39603dcc50f5468e2f7962641d52460b768de8df9781fab2f7cd0d8`，1268字节。
- `platform-runner-final3-full.log`：SHA-256 `17e0311ae88f75fbfc68da996e39249077d6db7e7985ab8ba30668f1668503cd`，63869字节。
