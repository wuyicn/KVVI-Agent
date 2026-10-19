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

## 批次17：创建字段清单元数据

- 字段清单原只列非HIDDEN声明但未返回当前可见性，UI无法区分READONLY/MASKED，也缺decimal精度和money币种。新增本次授权计算的visibility及precision/scale/currency_mode/currency白名单配置；不展开整份field/type_config，不携带默认值。
- 真实PG新增反例先RED；补VISIBLE/READONLY、精确配置、隐藏字段缺席、正式default及config非白名单键不返回的断言。独立只读复核未发现代码问题，并据建议加强正式default反例。
- 隔离PG17的system-fields/system-api定向回归全部通过，exit0；本批是服务端元数据，创建UI仍在后续接线，不算十类型旅程完成。
- `field-declarations-final.log`：SHA-256 `6d5e02897216cc3ef283aebb2b922f6d8f1cbf9098a2added918a5d10e656b4e`，2389字节。

## 批次18：创建表单十类型转换与权限读取边界

- 保留表单字符串草稿，在BusinessBody/SystemShell调用createRecord前共用coerceCreateData转换。boolean/integer/多选为原生JSON，decimal保精确字符串，money保amount/currency对象，datetime本地输入转换为ISO；非法输入停在客户端并保留草稿。decimal/money控件改text+decimal inputMode，避免浏览器数字控件将大额输入当浮点。
- 字段可见性取当前/fields；缺失、未知mode及重复声明/坏options明确拒绝。SystemShell原先先画表单等权限、权限失败继续编辑，现等授权返回再画，失败显示重试；READONLY/MASKED/SYSTEM锁定且不提交，hidden名称/默认值不进入首屏编辑。
- 转换器反例先RED；独立复核发现optional+nonnullable空输入被误作必填，追加RED后省略此类空值；required仍拒绝，nullable允许的显式空值转null。又复现收集字段与draw分叉：隐藏父节点/值绑定、不渲染子树的字段叶子会提交未显示的草稿。追加两轮RED，现收集仅沿实际渲染的layout子树，值绑定采用同一隐藏判据。
- 最新固定源19文件204/204、host/client根tsc exit0、Node24.20.0/pnpm11.7.0完整build exit0。G2生成243路径/52登记匹配，新鲜重建235覆盖+8删除匹配。
- 真实隔离PG测试实际导入当前客户端values.ts，从当前字段清单取配置，经转换器→授权API适配器→JSONB逐项核对十类型、false、0、null、数组、长decimal和money；record-write-recovery定向18/18、exit0。没有把适配器/组件旅程称为真实浏览器完整端到端。
- 任务4仍未关闭：迟到响应/跨身份、终态、UI与Agent耐久原key及整页刷新恢复待实现。原vendor、已有试点未改，真实DeepSeek仍未执行。

非敏感日志摘要：
- `typed-create-package-final2.log`：SHA-256 `6266275dd42bbfd7809bba9fdbe3cdcc024393149132d9da8241c006e7b67163`，12547字节。
- `typed-create-types-final2.log`：SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，0字节。
- `typed-create-build.log`：SHA-256 `8e0cb7124dd25e30a3a0a4a0b1c0cd8d37231fe29da4c9f19c0c61d09082d0ff`，356123字节。
- `typed-create-g2.log`：SHA-256 `1b91d7ad08c96423debaff7edc7097a78a72d7ddc5c997b260cc599c0b1bb2d9`，423字节。
- `typed-create-rebuild.log`：SHA-256 `ffb13469f22aa36795f2c93b252b355a905d5db8da79c9e5b728ab8e494ae6a1`，440字节。
- `typed-create-real-pg.log`：SHA-256 `b958f0a4748c2694310c4c52e3aed43252bbcb157bf3daa00f7f1eff54c5719d`，2066字节。

## 批次19：客户端原key传输基础

- createRecord/updateRecord新增显式可选key参数，作为idempotency-key header发送；不生成或自动替换调用方原key。ApiResult保留服务器未知结果的idempotencyKey/retryWithSameKey，成功类型声明operationId/auditPending。
- 反例先RED；独立复核发现仅允许可见ASCII会拒绝含内部空格的既有原key，改按服务器trim规范及UTF-8 256字节限，保留内部空格并使用浏览器Headers规则验证。空白整体/换行/超限在fetch前拒绝，避免空header被当成新操作。
- 固定源19文件208/208、host/client根tsc exit0、完整build exit0；G2 243路径/52登记与新鲜235覆盖+8删除重建匹配。
- 本批是可调用传输基础，UI尚未自动生成/持久保存key；原key不会因本提交自动具备刷新或跨登录恢复能力。下一批补身份绑定恢复状态，未知结果不允许无确认地改用新key。

非敏感日志摘要：
- `write-key-api-package-final.log`：SHA-256 `97fb3179c1fdd5ebfa2032392a5ed5f0a5ec091f5c1cbf0f51b16e7c2f1ca951`，12547字节。
- `write-key-api-types-final.log`：SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`，0字节。
- `write-key-api-build.log`：SHA-256 `0cd7c895bd4198ce33e8346e447d0f25d852d46ba9537aaccf6f15f66528ee74`，352868字节。
- `write-key-api-g2.log`：SHA-256 `8caf2fdaa716348d377e061ed19c7f4d8201043b86f262b01f1b468d04d92ff6`，423字节。
- `write-key-api-rebuild.log`：SHA-256 `ffb13469f22aa36795f2c93b252b355a905d5db8da79c9e5b728ab8e494ae6a1`，440字节。

## 批次20：原key受权回执查询

- SQL37将实际写请求字段编码随业务回执同事务保存，不存完整字段值。新增GET /systems/:asset/write-receipt及/records/:id/write-receipt，用header原key按公司/账号/端点查询；与实际写入共用key串行锁。返回已知COMMITTED原结果或UNKNOWN，不调用业务run。
- 重新登录仍由同一账号/公司找回，gateway、当前动作/字段/行范围重验；隐藏字段拒绝不返回字段名。独立复核发现创建回执未检查记录当前行范围，追加真实转交RED反例后使用服务端保存recordId检查，不能从旧回执绕过新范围。
- 缺回执只记UNKNOWN，不能推出失败或许可新key。旧业务回执缺request_fields、旧平台idempotency记录均409要求人工核对，不猜测字段授权。API标识符门禁登记PATCH回执记录段。
- 实际PG复验原结果无重复业务效果、不同账号/公司无结果、PATCH/创建撤字段/动作权限及记录转交拒绝；持有原key锁模拟原写入在途，查询5秒超时保持原key，释放后原写入只执行一次并能恢复原结果。此处未宣称整个鉴权链路全局5秒预算，也未关闭任务1的并发撤权栅栏。
- 定向38/38、exit0；新增动作撤销/跨公司断言后最新完整平台634项：633通过、0失败、1个既有跳过，exit0；隔离runner确认自有集群停止。曾把不存在的schema.test.mjs列入定向命令，该文件未执行；正式schema-guard包含在本次完整回归，不将该拼写计作额外验证。
- [客户端恢复设计](client-write-recovery-design.md)明确后续采用服务端耐久intent，避免浏览器保存业务payload，并规定取消必须写原key tombstone。当前批只交付查询基础，UI journal、取消/确认与Agent接线尚未实现，不能宣称刷新恢复完成。

非敏感日志摘要：
- `write-receipt-lookup-final.log`：SHA-256 `2b75800bf9ab82f182afb049ea4983fb66e35bacc4fbe2f78988378643c63413`，4480字节。
- `platform-write-receipt-full.log`：SHA-256 `020780685401bead4383e0610bd44364edac8a2e167a4c49083879c1557f064b`，64901字节。

## 批次21：服务端耐久写入意图与安全封存

- SQL38新增公司RLS内的record_write_intents，只存身份/端点/gateway/原key/请求摘要/字段编码及状态，不存业务字段值。prepare在写入前耐久保留同身份端点唯一active；GET可由同账号重新登录找回，写入将业务效果、原回执与COMMITTED标记放在同一事务。
- cancel与实际写入共用原key锁：先提交者决定最终为一条已知效果或CANCELED tombstone。ACK只允许已知提交，原回执与tombstone不删、不按年龄过期。prepare/cancel/ACK各自同事务写审计outbox；审计不可用不重跑业务效果。
- 独立复核与反例发现并修正：active期间不同/省略key可绕过；服务端key可被另一账号或接口当legacy key执行；尚未读到intent时超时回显未绑定header。现控制与写入统一actor/endpoint→原key锁序，阻止其他key；保留namespace同时核对owner/gateway及同endpoint真实intent行；未确立耐久key不回显任意header。
- 撤权曾使本人旧active无法cancel/ACK，阻挡后续允许动作。GET受限结果仅返回state/key/resultRestricted，本人可封存未提交元数据或ACK已提交元数据，不返回原result/字段名，取消不回滚已提交效果。字段撤权＋审计不可用的组合反例也先RED：元数据控制不伪装成被拒业务写入，其允许状态变更独立经outbox保留；权限查询失败仍抛错，未被当成可例外。认证、系统入口及gateway门禁保留。
- 19项真实隔离PG定向全部通过，exit0，含12路并发prepare、重新登录、6次取消/写入竞态、实际缺header、跨人/网关/端点/伪造key、控制/marker存储故障完整回滚、prepare COMMIT确认丢失、两种5秒锁超时、审计故障恢复及转交后受限确认。最终完整平台653项：652通过、0失败、1个既有跳过，exit0；runner确认自有集群停止。之前649/652项中间回归不替代此最终源码回归。
- 本批仅完成服务端协议；UI和Agent仍未调用prepare/GET/cancel/ACK，关开Panel与整页刷新完整恢复尚未验收，任务3/4不勾选完成。未部署或迁移已有试点，真实DeepSeek仍未执行。

可复现：显式Node24.20.0与KVVI_TEST_PG_BIN运行隔离runner；定向入口`node --test --test-concurrency=1 services/platform/tests/record-write-intents.test.mjs`；完整入口为services/platform下`node tests/run-isolated.mjs npm test`。

非敏感日志摘要：
- `write-intents-final3.log`：SHA-256 `23e0689a051276c7de61b479d9f2259be14c5278b2f57e71a8d9fca99271ca0a`，2213字节。
- `platform-write-intents-final3-full.log`：SHA-256 `32a5adb9b24386efa773817575226ed6038768d0911e80063ed2823dc90d5868`，66734字节。

## 批次22：客户端耐久意图协议传输与解析

- api.ts新增GET/prepare/cancel/ACK明确接口，create与PATCH端点保持分开、路径编码，控制操作携带原key；不产生业务写入、不本地保存payload或自动铸造替代key。GET接受取消signal。空/非法控制key在fetch前拒绝；控制失败始终保留调用方原key，不能被错误响应hint替换。
- 先RED新增接口，再实现状态联合与严格解析。独立复核重现混合EMPTY/CANCELED/ACK+receipt会被清洗成可继续状态、PATCH结果可以指另一记录；补RED后拒绝互斥组合、受限结果携带receipt、错误成功状态码及规范UUID目标不一致。restricted COMMITTED只能返回元数据。
- 实际导入当前客户端SDK，通过真实授权API及隔离PG执行prepare/写入：数据库已提交后适配器抛出模拟丢失响应，客户端明确UNREACHABLE；重新登录GET找回原key及已知结果，数据库只有一条效果；ACK、仅取消无效果、PATCH版本2均核对。20项真实PG测试通过、exit0；这是适配器故障注入，尚非真实浏览器网络断连旅程。
- 最终固定源19文件211/211、host/client根tsc exit0、Node24.20.0/pnpm11.7.0完整build exit0，252客户端产物。G2 243路径/52登记有效，新鲜固定源重建235覆盖+8删除逐字节一致。最初SDK测试重复使用已消费的Response导致第二次解析失败，已修正夹具每次返回新Response；不据该夹具错误更改产品协议。
- 本批新增平台代码仅测试；平台生产实现仍为批次21最终653项回归版本。UI/Agent尚未调用这些SDK函数，不宣称刷新恢复完成；原vendor及已有试点未改。

非敏感日志SHA-256：
- `write-intent-api-package-final2.log`：`fd18df64fc756783a587bb99bf5f167dff68b7dae9b55d53e30047275c444562`。
- `write-intent-api-types-final2.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `write-intent-api-build-final2.log`：`094477c93a8887ba6e79bff0276fb67c806d8489e17daf9941e85de10a06613f`。
- `write-intent-api-real-pg-final2.log`：`a2148cc29e56f9bd38872cb89c1d7c23c904c26e007d1036a0a83787e7dfecb9`。
- `write-intent-api-g2.log`：`89ca0f204573174aa0a40519b88e1797fa16fafc521bcab7d606ddcbeed95f2d`。
- `write-intent-api-rebuild.log`：`ffb13469f22aa36795f2c93b252b355a905d5db8da79c9e5b728ab8e494ae6a1`。

## 批次23：身份绑定客户端恢复控制器

- 新record-write.ts实现可订阅状态机；refresh只读，不自动重放。先耐久prepare、再以同key写入；冻结body只存在当前内存，snapshot不包含业务输入，关闭后只能找回服务端元数据。实际成功仍查询原key回执再认定已知提交，peer ACK旧active后也可恢复。取消/ACK明确后停在settled，需重新读取后才能新动作。
- 每个异步阶段读取实际/auth/session，绑定公司/账号/session/gateway；准备期间dispose、目标/身份已切换的迟到响应不会继续发业务写入或通知新界面。新会话新控制器仍能经同一账号的服务端active恢复，不冒充原浏览器session继续执行。
- 先RED缺失控制器和原回执SDK，再实现；定向反例发现可变target被改为另一系统，现复制固定目标。独立复核再复现409经refresh重开旧版本retry、恢复/prepare直接COMMITTED未固定key而在peer ACK后丢结果；均追加RED后修复。originalKey只追踪已观察操作，bodyBoundKey只有已确认PREPARED才能绑定冻结body，不能把prepare失败的新输入配到peer旧intent；业务409保持原拒绝与currentRowVersion，直到明确收尾。坏/null身份响应也已先RED后拒绝，避免未处理异常。
- 15项控制器反例通过。最终固定源20文件227/227、host/client根tsc exit0、完整build exit0。G2 245路径/52登记有效，新鲜重建237覆盖+8删除逐字节一致；固定源基线仍e6a559b，原vendor不改。
- 实际导入当前controller及SDK，经授权API与隔离PG验证提交后丢响应、旧session被拒、新session控制器找回COMMITTED并ACK；prepare已入库后切到另一账号，迟到响应没有业务写入，新账号无active、原账号保留同key可取消。21项真实PG定向通过，exit0，自有集群停止。最新完整平台生产版本回归仍为批次21的653项；本批平台仅新增测试，不虚构已跑655项。
- 本批是控制器与SDK基础，尚未由BusinessBody/SystemShell/Agent调用；可见恢复按钮、整页刷新与HTTP悬挂期限仍待接线/验证，不称完整UI恢复通过。真实浏览器、DeepSeek、现有试点部署均未执行。

非敏感日志SHA-256：
- `write-controller-package-final2.log`：`f566fe44aa22c20920085e8608b46f4fc050c9609e2c5900d2a1a9b9c22f737b`。
- `write-controller-types-final2.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `write-controller-build-final2.log`：`86fa9e55e21bba51d91ff0f77cd2159d245bb5703c6bdee0c543644e23b25297`。
- `write-controller-real-pg-final2.log`：`67ea5f6e29c1fa8acc310c38c9d71c06e55d6690574e62b64f9d0758fc5116d3`。
- `write-controller-g2.log`：`0c085240394f8ff3a2d298b86dcb60cec5ee25183fef34dc355e23426c920571`。
- `write-controller-rebuild.log`：`5b39a5a579a6cc4db8226183a0f78b8e17c055f1756f347b1a83f5acf7cead26`。

## 批次24：客户端HTTP悬挂预算

- 控制器为每次HTTP请求单独设置6500ms等待预算，内部测试可显式选1–30000ms。prepare/业务写/cancel/ACK超时只记UNKNOWN且保留已知原key，客户端未收到HTTP响应时status为0；读取/身份超时拒绝继续。该预算不是整个鉴权/恢复链路的全局预算，也不声称终止服务端事务。
- api.ts显式signal贯通创建、PATCH与控制操作；超时或dispose先解除本次等待再中止HTTP，迟到resolve/reject被原Promise.race接住，不继续状态机。每次请求的timer和master abort listener均在finally清理，后续恢复查询用新的signal。
- 先RED复现hung prepare/write永不结束；实现首轮有局部input遮蔽submit参数，15项回归失败且tsc拒绝，已修正变量名后重新验证。另补读取响应体悬挂、fetch忽略abort时dispose立即解开、迟到拒绝及HTTP未到达状态码反例；19项控制器测试通过。两名独立复核者补验响应体悬挂、默认期限内dispose及无未处理拒绝，未发现新增确定阻断。
- 新建仅监听127.0.0.1随机端口的自有HTTP服务，实际调用认证/API并写入隔离PG；业务COMMIT后故意悬挂HTTP响应。当前controller在600ms试验预算后UNKNOWN，GET原回执确认一条业务效果，ACK后重读EMPTY；释放迟到响应不覆盖ready、不再写业务。服务、HTTP连接与PG均自行收尾，没有使用试点端口或实例。
- 最终客户端20文件231/231、host/client根tsc exit0、完整build exit0；真实PG定向22/22、exit0，含上述真实HTTP旅程。G2 245路径/52登记有效，新鲜重建237覆盖+8删除一致。UI/Agent仍未接入控制器，真实浏览器整页恢复与DeepSeek仍待执行。

非敏感日志SHA-256：
- `write-http-timeout-package-final.log`：`b83db2fcf1b31bbf02cdfef6d16c2e64d344ebc95b87fdac30b5ff9b5347c19f`。
- `write-http-timeout-types-final.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `write-http-timeout-build-final.log`：`c39732cb467e3e2b23f7d4280762f2df3b3b278f7d4c05c13323a935eac4ae10`。
- `write-http-timeout-real-pg-final.log`：`951bcb2aa479f9856a3514d510bb30b395ad562f9b8652a6432a2c14f6af0aec`。
- `write-http-timeout-g2.log`：`81b9a65e8965e2ac7c46a69ff987f4280f7be2da88ed56915f6e574efbccda9a`。
- `write-http-timeout-rebuild.log`：`5b39a5a579a6cc4db8226183a0f78b8e17c055f1756f347b1a83f5acf7cead26`。


## 批次25：BusinessBody可见写入恢复

- 新RecordWriteGuard把真实业务主区与会话右栏的创建/PATCH接入批次23–24控制器；提交先prepare，未知结果显示不确定状态，查询、原操作重试、取消、确认、查看结果均为明确按钮。无已知key时只允许检查，不给无效取消入口；受限回执只显示元数据，不显示表单/结果。新会话通过服务端active找回，不把业务输入存浏览器持久存储。
- Guard以公司/账号/session/gateway身份、asset/record及父读取generation绑定occurrence；effect创建并dispose控制器，StrictMode重放不复用已销毁实例。所有迟到回调重验current；父BusinessContent按身份重建，旧响应不导航、不改新身份草稿。ACK/取消后重读当前projection/fields/record，不将旧PATCH值合并进新记录。
- 新建显式查看与初次成功分开：工作台创建关闭弹窗并刷新列表，恢复结果需点击查看才导航；恢复查看不清新草稿。初次提交及显式retry的已知成功只clearIfUnchanged原提交快照。独立复核先RED复现retry成功遗留旧草稿，修复后增加反例；另复现并修复同scope回调更新仍调用旧函数、未知key显示取消、工作台显式查看未导航等问题。
- 协议感知组件夹具验证prepare先于业务POST、刷新为新store找回已提交、恢复不自动导航、不重复写、切换身份与另一页签新草稿不被清理、迟到PATCH后ACK读取当前版本。身份测试最初立即断言已存在旧DOM，改等待新身份DOM提交后再释放旧响应；保留原跨身份效果断言。最初新行为令6项旧夹具/自动恢复假设失败，已改显式协议交互，未修改成自动重放。
- 最终21文件247/247通过，host/client根tsc exit0，完整build exit0（252客户端产物）。两名独立只读复核，所发现草稿问题已补RED修复。G2 247路径/52登记有效，新鲜固定源239覆盖+8删除逐字节一致；第一次重建未包含尚未暂存的2个新文件而明确失败，纳入Git暂存后以新目录重建通过，不掩盖失败。
- 本批是实际BusinessBody组件接线及jsdom验收；SystemShell旧入口与Agent仍待接线，未执行真实浏览器整页刷新、真实DeepSeek、现有试点部署，不据此勾选任务3/4完成。平台生产代码未改，实际HTTP+PG证据仍为批次24。

非敏感日志SHA-256：
- `business-write-recovery-package-final.log`：`12c9b992c7b9d9d267a3082ee4ab5663d93e382912425cca12c8f63b5fb77d87`。
- `business-write-recovery-types-final.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `business-write-recovery-build-final.log`：`aac3c2448814506975b461fc055e3e7bbaffd16db06d6a720b7694baed3e3f3a`。
- `business-write-recovery-g2.log`：`e2edd1fd35a95409d5c9b3c80f4470f799f53529549c2bb50410be0b6842571c`。
- `business-write-recovery-rebuild-final.log`：`7b047cf4e34c31db4bf0927fb575e3dbc7ed49d79c2f620661ac759b7e8e6fb4`。


## 批次26：旧SystemShell入口接入相同恢复协议

- 旧“我的系统”创建与PATCH均改走RecordWriteGuard，不再直接调用createRecord/updateRecord。已提交PATCH只显示已保存，保持禁用直到明确处理原回执；ACK/取消后重读runtime、字段及当前记录，不把旧冻结输入合并进服务器新版本。创建保留原记录号提示；恢复结果通过明确查看才打开。
- 入口先读实际身份，focus与明确重载重新核对；公司/账号/session/gateway变化按身份key销毁旧Session，初始系统参数不跨身份继承。详情改为独立recordId导航状态+effect读取，列表与详情读取均abort并在回调检查，Back或切换系统后旧结果不能跳回。重载runtime期间停止详情编辑。
- 公共协议感知测试服务器提取到record-write-server.ts，保留跨store回执、故意丢响应、请求起始身份归属及真实原key字段；面板权限夹具也补实际/auth/session，不将未知路由当身份。
- 首先新增prepare先行及重开lostcreate反例，原实现2项失败。实现首轮可选prop显式undefined被exactOptionalPropertyTypes拒绝，已修。独立复核实际重现focus一次503会销毁未提交草稿：补RED后保持同身份子树mounted，错误期hidden并设DOM inert，身份恢复后展示；401/403或新身份销毁旧子树。表单/详情两条瞬断保留均通过。React18不认识JSX boolean inert，类型检查也拒绝；已改ref设置真实DOM属性并增加断言，未放宽类型。
- 最终21文件254/254、host/client根tsc exit0、完整build exit0（252客户端产物）。另覆盖lostPATCH重开→ACK→当前服务端canonical值、记录Back迟到、focus身份变更后旧写迟到。G2 248路径/52登记有效，新鲜重建240覆盖+8删除一致；独立只读审查的输入丢失问题已修复。
- 这是组件+协议夹具证据，非真实浏览器/实际部署验收。Agent、流程及访客仍未接耐久原key协议，终态/确认后修改规则等仍待实现，任务3/4不勾选完成。原vendor和已有试点未改，DeepSeek未执行。

非敏感日志SHA-256：
- `legacy-write-recovery-red.log`：`f8ba3b0d6a3a6329db01052a13eafcd831c6c152f3d40de887b100dc0dd5994e`。
- `legacy-focus-draft-red.log`：`223a410e3715b460ec35fddb47c90b06be3f03b5f7ba3a203ab9ce3a88cfbf1a`。
- `legacy-write-recovery-package-final3.log`：`1da37f518d8c934b12344ee909eff6771d47a886be2be6623284532b73282c53`。
- `legacy-write-recovery-types-final3.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `legacy-write-recovery-build-final3.log`：`a52db02c4994da83210ed0ac8f9dc0f9193731b699d4f92914a21c4890ca2cbf`。
- `legacy-write-recovery-g2.log`：`957753d8019f8c5adbd1af439fe9ca8334fbb47766667d4fc0a194786c276b38`。
- `legacy-write-recovery-rebuild.log`：`9a8c4240570c68ed0f2ea289aafb8e89bbd2d8084aaec5bcc47a859d821c33f0`。


## 批次27：身份检查等待期隔离与确认后的列表重读

- 第二名独立复核在批次26提交后指出：focus检查开始至响应返回间，旧身份内容尚未隐藏；并且PATCH ACK只重读详情，已加载列表不刷新。分别新增延迟身份响应（同身份/新身份）及同occurrence预加载列表→PATCH→ACK→返回列表反例。
- checking从请求开始即隐藏并设置DOM inert，保留已挂载输入到身份确认；同身份恢复原值，不同身份销毁。ACK/取消重载同时递增列表读取序号。身份测试2项先RED；第一次lostPATCH重开用例的列表已是新值，不能证明旧列表缺陷，因此另补同一次打开内预加载旧列表的用例，在隔离构建源暂去掉列表刷新这一行时明确RED，再恢复实际源码通过。
- 最终21文件257/257，host/client根tsc exit0，完整build exit0（252产物），G2 248路径/52登记、新鲜240覆盖+8删除一致。不新增自动业务写入，不部署试点。真实浏览器与剩余验收仍未执行。

非敏感日志SHA-256：
- `legacy-checking-list-red.log`：`6e750ecb8c05bb0dee06314d2c3958e487a9f1289f4730300fa06ddacdbd34db`。
- `legacy-preloaded-list-red.log`：`d741bec2911600a7fe2bf552d6cc9a4a690091f644a3a78ac2ccc8bb26c85c24`。
- `legacy-checking-list-package-final.log`：`3f83e20f793d8f260a256d8924ba081e538e8d7e2373f72ed6f7212055940718`。
- `legacy-checking-list-types-final.log`：`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
- `legacy-checking-list-build-final.log`：`1f185d7d9ec3a5a9b808189741dbba31e94306cd22c765104ea21e7d5cf5dab6`。
- `legacy-checking-list-g2.log`：`8998762eb35572304ce24a585304135cb47e301aa37ad8bbfff69a9343a3607b`。
- `legacy-checking-list-rebuild.log`：`9a8c4240570c68ed0f2ea289aafb8e89bbd2d8084aaec5bcc47a859d821c33f0`。


## 批次28：公共记录层执行流程状态写入边界

- 新record-state.mjs沿既有contractAt/latestContract读取并校验摘要，以记录自己的workflow_version及当前state判定，不静默退回新版本。refs.updateRecord在FOR UPDATE和rowVersion核对后检查；terminal任意修改拒绝，未知状态/缺历史版本/坏定义拒绝。命令在风险审批前预检同规则，真正写入仍锁内重验，R3批准不能替代基础状态规则。
- 字段变更只允许真实initial状态（不硬编码状态码叫draft）；非initial非terminal返回KVVI_RECORD_CHANGE_APPROVAL_REQUIRED。审批申请/批准/执行闭环仍待做，本批只阻止未经批准的直接字段修改。空流程/旧无流程只识别既有draft，不把任意字符串视为可写。
- 独立复核两条绕过均先RED：空数组/标量data按Object.keys判空而实际JSONB拼接会改变结构；普通command patch.state可先重置初始态再改字段。现recordData统一要求对象，API/commands/refs create/update均拒绝数组、标量和null根值，字段值中的合法null仍支持；普通命令没有可信transitionAction不能改state。可信流程在记录锁内按实际pinned契约、当前owner/state与FLOW权限重新judge并核对目标状态，旧step预检保留。
- 真实PG覆盖API/command/direct终态拒绝且data/version不变、未知/丢版本、新版改变terminal不影响老记录、自定义collecting初始态正向、空/非空数组/字符串/null/0/false反例、重置状态两步绕过、合法submit、目标替换、实际行锁等待后409。最终定向system-api+diff 29/29、exit0；之前三文件60/60为中间版本证据，不替代最终回归。
- 首次完整平台6项失败来自旧恢复夹具的draft定义缺必需terminal布尔值，补为false；第二次完整663项仅旧差分错误码失败，新预检提前于legacy非法动作诊断。保留旧非法迁移诊断顺序后，仍由权威状态检查拒绝任何假迁移放行，未改旧断言。最终完整平台663项：662通过、0失败、1既有跳过，exit0；隔离PG确认停止。两名只读复核确认绕过已关闭。前端/固定fork未变，本批未重复无关构建。
- 设计见record-state-design.md。流程事件/独立审计耐久原key、非初始变更审批、组织与真实浏览器等仍未完成，任务3/4/8不勾选。未部署、迁移或重启已有试点；再次仅输出配置存在/键非空布尔值，指定kvvi.env仍没有非空DEEPSEEK_API_KEY，真实DeepSeek未执行。

非敏感日志SHA-256：
- `record-state-red.log`：`d72a6d75ebb9714f34639ee3700030d309560709ceb9d5ee45e08c48e9adcf13`。
- `record-state-bypass-red.log`：`127d460fe112db6b490eb17bed670f3d9420753dd9eb1b70141ce05777129c3b`。
- `record-state-final-focused.log`：`2a981fa4af55834b228b7a29be61298604489fbd982383b3203299b0e497f5d1`。
- `record-state-platform-full-final2.log`：`aad9a940ce7cd3ca86fa4f076dea8bbdd86178285fd1f6f69416968d7a873e90`。


## 批次29：访客实际写入的授权前置条件

- 修签发资格只查formCode而未查实际schemaCode，现两处分别核对create；当前访客提交只支持create，签发与使用都拒绝其他动作绑定。ttl与max_submissions要求有限正整数并限制到PG integer范围；字段绑定要求非空、不重复字符串，根data沿统一recordData校验。
- 不再信调用方input.scope或把实际写入上下文强制为COMPANY；签发/提交从平台重新派生scopeContext，按schema本身与*合并的数据档位判，实际create使用同一当前scope。当前字段权限在写入时再检查，签发后变READONLY仍拒绝，不依赖测试手工抬授权版本才生效。
- 初始4个反例先RED，再27/27通过；增加伪COMPANY scope、无实际资源DATA档位反例。独立复核重现resolveOwnership=A而稍后scopeContext=B导致按B落库却返回A；真实PG在两读间受控变更membership的反例先RED（Missing expected rejection），现写入前比较dept/shop一致性，否则KVVI_ROW_SCOPE_MISMATCH且无业务效果。
- 最终完整平台670项：669通过、0失败、1既有跳过，exit0，自有PG确认停止；此前669项通过为最后归属修复前的中间版本，不替代最终结果。独立只读审查的归属窗口已补实库反例与修复。
- 本批只是S9所需授权前置修复，访客用量仍是业务库先创建、平台后计数，尚未实现原key、业务侧原子用量与跨库耐久投影；不能声称max1并发或崩溃一致已经通过。真实访客HTTP/UI入口、DeepSeek及现有试点部署未执行，任务7不勾选。

非敏感日志SHA-256：
- `visitor-prerequisites-red.log`：`9fb2537de7355b87ca73c2fa5e49e9721e8eddc37c60017e8de3efd45ade88c1`。
- `visitor-ownership-window-red.log`：`bb2a3771122b7c87a9831837d637b78f410c5cb920a43ddbd7eb3d6d111f4866`。
- `visitor-prerequisites-platform-final.log`：`59fc990592dab715fb83f092b708f2f9712fba03c268c5288f52d76c197bd4ba`。

批次29证据补正：047c1030保存账本时完整进程仍在运行，原日志摘要取自未结束文件。现已实际收到exit0，核对最终670项（669通过、0失败、1既有跳过）及PG停止，再以最终日志字节重算以上SHA-256；源码未变。本补正不沿用提前写入时的证据判断。


## 批次30：访客业务侧额度与投影账本基础

- SQL39新增公司FORCE RLS的visitor_submissions，以及专用private schema内的全局admissions/config。私有owner无LOGIN/SUPERUSER/BYPASSRLS，不授runtime表读写、CREATE或成员身份；仅USAGE+指定admit函数EXECUTE。public blanket grant不跨入私有schema，schema owner也明确固定。
- admit固定安全search_path，VOLATILE/PARALLEL UNSAFE，拒绝非READ COMMITTED与公司/issuer GUC错配。source→company→link统一锁序，锁后独立查询和clock_timestamp，保持跨公司source计数；永久link用量和滚动link/source/company额度分开检查，固定issuer/max/binding/expiry不可被后续请求扩大。原始token及业务字段值不入全局表。
- 延迟复合外键绑定admission/公司journal与同公司、issuer、operation回执，journal关联记录也绑定同公司。writeOperation显式BEGIN READ COMMITTED，并给run传稳定operationId；额度、创建、journal、原回执与audit payload可在同一个client事务落地。默认准入关闭，本批只由自有新PG夹具管理员明确启用验证。
- 新增13项真实PG基础测试：同key恢复不二次消费、不同key并发容量、跨公司source实际等锁后提交拒绝/回滚放行、排队到期、缺回执不能COMMIT、根权限/隔离级别拒绝、元数据不可扩大、projection存储故障使记录/receipt/额度/序号全部回滚、公司journal RLS、关闭新准入仍可找回已知原回执、重跑provision/migrate不扩权限或重置admissions。两名独立只读复核未发现本批确定阻断。
- 最终完整平台683项：682通过、0失败、1既有跳过，exit0，runner确认PG停止。12项定向为最终第13项迁移重跑加入前的中间证据；完整回归包含第13项。最终日志在进程退出后才计算摘要。
- 本批未接入submitAsVisitor，旧访客提交仍未获得原子额度保护，不能声称S9关闭；跨库投影补投、原key外部协议、存量可信切换、HTTP/UI与真实浏览器后续继续。private准入默认关闭，不把普通布尔开关当旧writer栅栏，也未操作已有试点。设计及官方PG17语义来源见visitor-submission-design.md。

非敏感日志SHA-256：
- `visitor-admission-red.log`：`0fb3c60491591f1002a160ae74a590c6e92bab48b801cf2087eb63fc4e840676`。
- `visitor-admission-green3.log`：`e98cf0503bdd114d68e965428b1a01b78e3b7cffbe8578c84b40f4a610c3bbc0`。
- `visitor-admission-platform-full.log`：`90c3f81f988862762593350c7d826eb22ef24cbf100f1977f323fa72f9f67628`。


## 批次31：访客签名协议与原子提交模块

- SQL40新增永久legacy-unknown默认，不回填新协议；v2签入公司/issuer/max/protocol，使用时完整核登记正文与token摘要。本人吊销增加issuer谓词。8项签名/登记/吊销反例先RED，38项定向通过；独立复核指出“v2已可旧式消费”资格窗口，故未单独提交协议版本，一并接入以下原子路径。中间691项回归不是最终源码验收。
- submitAsVisitor要求调用者预先生成随机UUID原key，统一大小写并使用隔离namespace，复用writeOperation稳定回执。配额、真实发布初态/流程版本、事务取号、createRecord、公司提交账本、原响应与audit payload使用同一client；旧create→平台counter→event→audit串行路径移除。默认准入关闭即拒绝新效果，已有原key恢复不重复消费；平台计数满额不阻挡原回执恢复。
- 初始6个原子反例先RED，maxN不同key并发、同key并发、正文冲突、实际COMMIT后丢确认、journal故障回滚记录/receipt/额度/取号、全新Node进程原key恢复、audit不可达后恢复均有真实PG证据。旧访客fixture现在发布六份真实契约并由夹具管理员明确启用隔离库准入；每次旧用例调用的随机key由测试调用方预先生成，生产服务没有自动生成替代key。
- 两名独立复核指出quota重验之后仍可能等form/unique/sequence。真实PG持锁→请求确实等待→吊销→放锁的3个反例先RED；createRecord可信beforeInsert在取号后立即做最终重验，失败完整回滚。另有转出当前行范围仍泄露原回执recordId、await后原input源信息变化导致投影来源不一致的RED，均修复。额度等锁期间撤销/到期、来源格式拒绝也有正反向覆盖。
- 最终定向55项全通过。最终完整平台708项：707通过、0失败、1既有跳过，exit0，runner确认自有PG停止；摘要均在最终进程退出后计算。完整命令：`cd services/platform && env PATH=/Users/wuyi-macs/.local/opt/node-v24.20.0/bin:/Users/wuyi-macs/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin KVVI_TEST_PG_BIN=/opt/homebrew/opt/postgresql@17/bin node tests/run-isolated.mjs npm test`。
- 此批仅模块原子提交；成功明确projectionPending=true，后台计数/事件补投下批继续。平台吊销与business COMMIT仍没有跨库原子性，不夸大已知锁后重验；旧writer栅栏/历史基线、HTTP/UI/真实浏览器、DeepSeek和现有试点部署均未执行。任务7及整体12项不勾选。

非敏感日志SHA-256：
- `visitor-protocol-red.log`：`0e9ce08f8a5fe7aa23b2f570c96c323d92bd8f6f7925d68ce6b01479dbb22f0b`。
- `visitor-atomic-red.log`：`27bdb7330499ef0fc470f92b8a998da144c33658dd4cd3f5f19cde0716a05654`。
- `visitor-receipt-scope-red.log`：`7c8afb3929e1eeb6f6c021922f1c0f6dd3897c55ee9040aa3d5efbf710c1f325`。
- `visitor-insert-waits-red.log`：`4138bba0848ee45e68603cec4cdefb9f3e74effa9b95691e58468b2b5e14a993`。
- `visitor-atomic-final-focused2.log`：`84121a79ac203b521665a22b33cb887b7964cf4d98054860a205e2ca84bd92f1`。
- `visitor-atomic-platform-full.log`：`30792b8e2d9bfc6ec7840e967a40ba2380acc13ba5d8f5d5dbc3d1d0911e1a46`。


## 批次32：访客跨库幂等投影与后台恢复

- SQL41平台独立receipt按company/operationId去重，规范payload摘要拒绝不同内容复用，counter/原时刻SUBMITTED事件与receipt同平台事务；business marker后置。submit原业务已确定时投影故障返回projectionPending，不伪装业务失败，不再执行createRecord来修补；恢复原key也可补投。
- 新worker先短业务事务领取、持久attempts/backoff，然后释放business连接再访问platform；各query、checkout受预算约束，COMMIT确认不明由receipt判断。平台成功但marker失败只修marker；并发重复不会多加counter/event。平台过期/吊销不抹掉已提交效果。后台每10秒运行，health返回pending数或null，关停清除新增timer。
- 14项投影PG专测覆盖receipt INSERT失败、event trigger失败使receipt/counter回滚、实际COMMIT成功后丢回复、marker trigger失败、原key恢复、撤销后已提交投影、跨公司RLS、pool耗尽/连接释放、row lock timeout、冲突payload、backoff/batch限制、并发补投、全新平台进程自动补投并结束自有进程。与访客既有用例合计69项定向全通过。
- 独立复核发现先全公司扫描时B超时会丢弃已取得A任务。两公司真实账本+后公司统计timeout注入反例先RED；改为持久cursor逐公司轮转，推进后查询、找到即投递，全量统计失败只返回null。游标不因单公司故障回退。两名只读复核的去重、连接、关停发现已处理；最末统计有独立最多5秒，投递最多5秒，不声称整个flush只有5秒。
- 最终完整平台722项：721通过、0失败、1既有跳过，exit0，自有PG确认停止，最终日志摘要在退出后计算。完整命令与批次31相同，最终日志名见下；本批未改DSH，不重复宣称浏览器或构建验收。
- S9仍缺可信停旧writer/历史额度基线与安全启用、访客HTTP/UI及真实浏览器，平台撤权与business COMMIT的跨库序列化亦未完成；已有试点未部署/迁移/重启，private准入仍默认关闭。整体12项不勾选。

非敏感日志SHA-256：
- `visitor-projection-red.log`：`e0c26822bcb0c06ec8f123ad8e77303a8a06ef98f34a8f854d881330fea8a53c`。
- `visitor-projection-progress-red.log`：`3de9aa6da2bdbe5b38666e2db0758b40368d792346bf7f0873cc556cafa15cb2`。
- `visitor-projection-final-focused2.log`：`596fb9206d71472e404ff2c01218ce2c8d75a8a0438ef1fa2007b4903cc60fef`。
- `visitor-projection-platform-full.log`：`fee44218877825f4e667412459fc3dc5c620bef058eb8a823fe0d600a07bc0e9`。


## 批次33：访客原key只读结果恢复

- 新增lookupVisitorSubmission，不要求保留或重发业务data。公司/issuer/endpoint从已验签且登记一致的链接派生，原UUID规范化；调用既有readWriteOperation，原错误key改回外部UUID，未知/不同链接原key只给UNKNOWN同key提示。COMMITTED返回元数据白名单，剔除正文、ownership、traceability与字段名。
- 读取回执前重新校验stored request_fields的当前权限、当前记录RLS与schema，隐藏字段拒绝统一403不带字段code；提交重放的记录可见检查也补同schema谓词。recordRejections作为内部helper选项让lookup完全无events追加；写路径仍正常记录拒绝。lookup不调用writeOperation、审计追加或投影补投。
- 初始6项恢复用例因缺函数先RED，随后23项恢复+原子定向通过；最终9项恢复专测含正常已提交/未知/跨链接、隐藏字段不泄露、转出行范围、吊销、准入关闭且投影pending、撤掉提交/投影表INSERT UPDATE权限仍可读、拒绝查询不追加事件、实际同key事务锁约5秒超时后仅保留外部原key且释放锁后恢复。该预算证据仅是回执读取/锁等待，未把授权平台读取总旅程虚称5秒。只读源码复核未发现本批确定阻断。
- 最终完整平台731项：730通过、0失败、1既有跳过，exit0，runner确认自有PG停止；最终进程退出后计算以下摘要。完整命令与批次31相同。
- 此为模块恢复能力，尚无访客HTTP/UI/真实浏览器旅程；存量切换、跨库撤权序列化、真实DeepSeek与其他12项仍需继续，已有试点未部署或启用准入。

非敏感日志SHA-256：
- `visitor-recovery-red.log`：`8bd0b0f189331e02dd415111b4afccce28c8438e2baa77b31aa32bbe9070ec3a`。
- `visitor-recovery-final-focused.log`：`80cf6054f4ef1c5d481cce8eb563901723b502ce1ddea5a3465961d80ccc0cd7`。
- `visitor-recovery-platform-full.log`：`690f3db83fd23db6990a31b618c520b464dcdf92342b3140bf7a6674dd731e85`。


## 批次34：真实访客HTTP提交与只读恢复

- 平台认领/visitor命名空间，登录门/运行时代理前精确处理POST /visitor/submit与/visitor/receipt；其它路径404、其它方法405，无匿名列表/候选/账号查询。JSON正文白名单分别token+data、token，原key只取Idempotency-Key头；不使用cookie/Bearer/runtime身份，不接受body公司/来源或双key。64KiB、JSON content-type、query拒绝、no-store/nosniff/no-referrer覆盖错误响应。
- source取实际socket remoteAddress，忽略代理身份头，IPv4映射地址归一。适配只做格式与领域码映射，权限/模型/原key语义仍归visitor/createRecord；不反射SQL、业务正文、token或错误detail字段。已确定业务成功但投影pending仍为201。
- 两项真实HTTP初始RED为303登录重定向、命名空间未认领；修后13项通过。独立复核另重现畸形header=null误500与WebSocket Upgrade转发visitor路径。两条真实反例再RED（500≠401、101≠404），现验签拒绝非对象header/body及错误typ，Upgrade拒绝平台owned路径；带真实有效浏览器cookie的runtime /socket实际101作正向对照，visitor原始Upgrade返回404且上游计数不增。
- 最终15项真实PG+自有平台HTTP专测全通过，包含max1并发、原生字段、同key冲突/恢复、假来源头、无效签名、主体额外字段、JSON/大小/cache边界、吞掉已提交HTTP回复后原key只读找回、UNKNOWN以及默认关闭准入503且无效果。自有平台、伪runtime与吞回复代理均结束；没有以mock fetch取代HTTP旅程。
- 最终完整平台746项：745通过、0失败、1既有跳过，exit0，自有PG确认停止；摘要在进程退出后计算。完整命令与批次31相同。本批未运行DSH/GUI构建，不将HTTP通过冒称浏览器或产品表单验收。
- 另仅输出布尔复查指定~/Library/Application Support/KVVI-Agent-Pilot/kvvi.env：文件存在、没有非空DEEPSEEK_API_KEY，当前命令环境亦无该键；未取证实际runtime进程环境，未重启试点或输出任何密钥值，真实DeepSeek仍未执行。
- 访客签发/分享产品入口、表单UI/真实浏览器、签发数量并发、可信切换与历史额度、跨库授权变更序列化等后续继续；整体12项仍不勾选。

非敏感日志SHA-256：
- `visitor-http-red.log`：`fe7acc544af4256006c44a979822d071ff86dc0c8d802100151bef5ea8975b59`。
- `visitor-http-boundaries-red.log`：`e31b6d39aecb661e1dfd921816b55a0e0abe91fee7b56805268ee4fdbe932ffd`。
- `visitor-http-final-focused2.log`：`9c1677ca8b9e38c586edf60b6482ac949471e8081377987617ce46a830fbd309`。
- `visitor-http-platform-full.log`：`cbace9ec0cb9b4fe241274a0f8f868c0a780b77a5b85d85cffa14e4cd9a7397f`。


## 批次35：签发额度串行化与登记事件原子性

- issueLink在同平台READ COMMITTED事务按company→issuer锁序取得咨询锁，再重读当前issuer、FORM/字段/资源scope与唯一membership，issuer/membership FOR SHARE；签名登记与ISSUED同事务，TTL和issued_at均用获得锁后的数据库clock_timestamp，ISSUED时间与登记相同。存摘要，不存可还原token。
- scopeContext/effectivePolicies/canAct/fieldVisibility可借用同一个事务client；既有调用默认pool行为不变，借入不另checkout、不释放。该路径不再loadSession占第二个pool连接，避免32个请求占满等待锁的8连接后持锁者再等pool。原授权判据复用，不复制第二份权限SQL。
- 5个受控反例先RED：同issuer32成功>20，公司窗口199后4并发都成功>1，ISSUED事件故障留下1登记，排队权限缺乏真实锁重验。修后通过；自查补issued_at默认now为锁前事务时间的第6个RED，改为锁后DB时间并与事件一致后通过。VisitorError的REJECTED在事务回滚释放后追加，成功事件故障整体回滚；没有将错误mask为已签发。
- 最终59项定向全通过，完整平台752项：751通过、0失败、1既有跳过，exit0，runner确认自有PG停止；日志在最终退出后计算摘要。独立只读源码/借入client探针未发现本批新阻断，未代替实库回归。完整命令与批次31相同。
- 本批仍是签发模块一致性，不是签发/分享产品UI或浏览器验收。签发回复丢失处置、存量可信切换/历史基线、跨库授权变更序列化与整体12项继续；现有试点未操作、private准入仍默认关闭。

非敏感日志SHA-256：
- `visitor-issuance-controlled-red.log`：`0403190715fa9353c844507ca36009ee0f775e705dcd58e4451b993ded6db042`。
- `visitor-issuance-time-red.log`：`e8bce18c359d5fd2b74759acfd58d291b0d4b0198cc706831ef53c7bd5f47254`。
- `visitor-issuance-final-focused.log`：`2cb9a3b1f3b693db1c80ad92016772be014df125444e82e784bf758f51663195`。
- `visitor-issuance-platform-full.log`：`288413c91537e5dfb8d4bf9703bb67d3e5cc553f2269b821f3274917d7727102`。


## 批次36：正式目录可复用的规范化协议基础

- 新增无I/O的canonical.mjs，从冻结Node参考提取原parser/整数token/Unicode/UTF-8键序/摘要算法，暴露canonicalizeJson与严格canonicalizeBytes。原始bytes先BOM/UTF8，再profile检查；拒绝重复解码键、孤立代理、非整数和超安全范围token，避免JSON.parse提前丢失信息。冻结参考、向量及contracts.mjs旧存储digest均未改，不把旧digest提升为正式AssetRef。
- 既有Fake resolver的contentDigest改用同一进程内算法，保留其已解析JSON对象边界与fake_assets查找，未将Fake变为可信生产目录。CI新增22项协议模块定向测试；独立复核确认核心算法逐段一致，并发现双非法输入错误优先级差异，组合反例先RED再修复，复核重跑闭合。
- 最终22项定向全通过，冻结参考6项通过；双语言完整1049份语料全部匹配字面判据（各运行Node/Python），未刷新历史证据快照。初次语料运行误用无jsonschema的裸Python3.12而出现执行错误，已终止该自有进程（143），改用既有按requirements.lock安装的schema-venv完整重跑，最终exit0、208.016秒；不将初次错误当实现RED。
- 修正后的最终完整平台774项：773通过、0失败、1既有跳过，实际exit0、runner确认自有PG停止，139.495秒。完整命令同批次31，最终日志如下；先前完整轮虽774项通过，但不作为错误优先级修正后的最终证据。
- 另按用户后续信息只读核验指定试点run/runtime.pid：存活同用户的登记进程实际脚本位于.worktrees/grouped-business/vendor/dsh/apps/cli/lib/bin.js，缺新式identity sidecar；按内核起始身份前后相同核验该进程及DSH子进程（仅发现登记CLI），ps环境读取成功但无DEEPSEEK_API_KEY键。只输出布尔和脚本路径，无密钥值，未重启/迁移/部署。不能据此声称其他未识别进程的模型配置或真实DeepSeek验收。
- 本批只建立可导入协议基础；正式目录/共享生产resolver、完整模型身份存储、发布/runtime/蓝图/UI与产物绑定后续继续，设计见production-registry-design.md，任务10/11与整体12项均不勾选。

非敏感日志SHA-256：
- `canonical-module-red.log`：`ac1936456890c71465349f6ca2420c2aefc3ebad19eff9c5c73e8ea2277dcbf0`。
- `canonical-error-order-red.log`：`d349af5edfbebec3ad1ab2c976c65c66c8b9e1708389abc14347ffb52bb44e7d`。
- `canonical-module-final.log`：`cd3e4a2a7c23549a48521e03fa01ab7f389903fded8ea4613f9716752ec784c8`。
- `canonical-reference-conformance.log`：`ab2830201761cf82f0a3181478dac377fe81724f786dd0b8842193983e768d9b`。
- `canonical-meta-corpus-final.log`：`33352c1bcac4fdab149e4d464d138652cf0b17b6e8b44797244fa9ccd6478dea`。
- `canonical-platform-final.log`：`769a3920ec20f104d6935eec2e464636926d26d2439b6f004c7345a939268d3b`。


## 批次37：中立静态组件目录与双语言受控加载

- 新增contracts/component-catalog/v1独立目录与schema，完整PLATFORM_CONTROL/kvvi-platform/kvvi_react_core/v1引用，app/module为null，content的kvvi-json-c14n/v1摘要为sha256:0760cf6a0bf6446506f8cde8f2ce44d4ccdbcb9fa69fc9a3bb8d1367963e5a7a。目录18项仅实际静态能力：3根、Section/Grid、10字段、3值；未执行props、Table/4按钮、condition/loop/actions/queries/i18n明确不支持。真实React18.3.1身份，不冒用vue_element_approved/no-renderer。
- Node/Python固定安装根加载同一JSON/schema，完整8字段精确比较；完整性验证器不授上传文档信任。Node深冻结返回对象，Python每次返回新对象，调用者不能污染后续读取。原始bytes先严格c14n再parse，未知props schema关键词由共享子集拒绝，拒绝远程/导入ref。sourceFiles5核心+integrationWitnesses3接线见证，逻辑路径相对DSH根；只核显式源码清单，不声称传递闭包、依赖许可审计或bundle资格。
- 初始缺模块先RED；复核补出Python忽略未知Schema关键词而Node拒绝，反例先RED再用同一schema子集收敛。另一复核指出BOM/非法UTF8错误代码及Python不可序列化ref异常差异；先RED后统一为CATALOG_DOCUMENT_INVALID / CATALOG_REFERENCE_MISMATCH，独立重跑7项目录测试闭合。
- 最终协议22+目录7共29项定向通过，包含完整ref缺/多字段、Fake/篡改/重复/未知组件/危险路径、真实props Schema验证、十字段type绑定、目录返回隔离、自有安装复制件缺失/软链接/过大/Schema软链接两语言code断言、自有源码目录改字节/缺失/软链接拒绝。fixed-dsh与registered-fork8文件实际摘要匹配，独立只读亦核对overlay8文件；没有重新构建或声称产物已含目录。CI加入目录测试，Python使用已有requirements.lock依赖。
- 最终完整平台781项：780通过、0失败、1既有跳过，实际exit0、138.995秒，runner确认自有PG停止，之后才计算最终日志摘要。完整命令同批次31；本批未改既有Fake语义、冻结语料/参考、DSH源码或已有试点。
- PUBLISHED表示本目录资产注册内容，不能替代消费者迁移/审批/部署。本批发布/runtime/蓝图/UI尚未接入目录，模型完整身份存储、共用节点/引用判据与生成副本/构建发行绑定继续；旧视图不得自动改latest或补伪身份，同版本目录不得由更新器覆盖。整体12项不勾选。

非敏感日志SHA-256：
- `component-catalog-red.log`：`6a0b83265b27cc70e8f2640205d1eb75d6d58e58cd2f50eb0fa8183317159acc`。
- `component-catalog-schema-parity-red.log`：`4eb33513dfac9756fd7554f3d9484c53d3868f9234b4b3a4bea588c84e0ad21e`。
- `component-catalog-errors-red.log`：`0ab6337934ecfc69b5d3c1ca058d595db741c72edc908bbf951871094bba22c1`。
- `component-catalog-final-focused.log`：`ed85ef54d7c73ae95f82734004e4d74d55f24975ae97176bb9c755a40e2706b1`。
- `component-catalog-source-qualification.log`：`36309f0a693b743d7106b987300aa01b2a8dc27139bacfa8a10a39c6dc7ab92a`。
- `component-catalog-platform-full.log`：`9d025998ca51cc61560778d968685d19a1b6bfaa3b6294385803cb3bfe70fc07`。


## 批次38：双语言共用静态树与字段引用规则

- 抽出Node view_tree.mjs与Python view_tree.py：checkViewTree/check_view_tree复用原树walker的结构预算、secret、节点ID、props实际Schema、绑定位置、字段类型、父子/数量、动作/loop与locale规则；FieldRef存在性抽到view_bindings的fieldReferenceErrors/field_reference_errors。Fake wrapper保留原fixture/精确解析要求与最终能力引用检查，实际调用同一core；未构造Fake上下文为正式目录开后门。
- 根判据是内部allowRoot函数：默认保留Fake空allowedParents语义，正式v1的显式$root在调用处适配。core不解析模型/目录引用，不授信modelFields/删除历史，不代表批准；正式wrapper还必须拒绝目录未支持的condition/queries/i18n等并使用可信完整ref与已知历史。未补造旧记录app/module、UUID或PUBLISHED元数据。
- 缺helper初始RED后跨语言定向绿；自查组合“非法locale+未知字段”发现提前提取FieldRef会改变原跳过行为，补组合RED再将locale检查一起放入core、保持VIEW_PROP_INVALID先阻断动态遍历。最终6项定向全通过：实际18项/FORM LIST DETAIL、根约定、字段不存在/类型错配/ignored props、父子/页类型/未知按钮、重复与已删ID、结构/501节点预算以及该组合次序。两语言诊断逐项相同，正文未被修改。
- 独立只读复核报告：此前5组定向通过，并把276个现有带context View语料与HEAD旧wrapper/旧bindings仅内存对拍，诊断/顺序/抛错无差异；此为复核探针，不代替下述完整新鲜语料结果。未改变冻结输入或字面预期/历史证据。
- 最终1049份双语言Meta-Schema语料全部匹配，实际exit0、207.205秒；最终完整平台787项：786通过、0失败、1既有跳过，exit0、160.751秒，runner确认自有PG停止。所有最终进程退出后才计算日志SHA。完整平台命令同批次31，语料命令：`env PATH=/Users/wuyi-macs/.local/opt/node-v24.20.0/bin:/Users/wuyi-macs/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin PYTHONDONTWRITEBYTECODE=1 .local-remediation-evidence/schema-venv/bin/python tests/meta-schema/test_conformance.py`。
- 本批未改DSH/目录版本/产物，也未接发布/runtime；真实模型登记、不可变映射与来源、生产完整ref resolver和wrapper继续。整体12项与任务10仍不勾选。

非敏感日志SHA-256：
- `view-tree-red.log`：`750212b7385444a58bce5e3897dcdac5bb3b48805da7c2c736d8ce91a1113e58`。
- `view-tree-precedence-red.log`：`f2b995d672fdd117eb6b554774a9e070dd3d6cf6e1bc47450183417d146ba765`。
- `view-tree-final-focused.log`：`0e91278937b3dbf5064ca1ba2b79715f0bee75408d1595dea3a3a36fde0a3c59`。
- `view-tree-meta-corpus.log`：`5153d9c064630799a086dcf2478ad2e713d92e023aee685114a1a543c0085ccf`。
- `view-tree-platform-full.log`：`a71f9ba5bd0c46e23c71b715d8ecafd90f17b29b5a3738649dc8591e723cdf76`。


## 批次39：生产静态视图校验与内部登记解析契约

- 新增Node production_view.mjs与Python production_view.py的factory/check。factory只接收服务端装配的可执行resolvePublishedBusiness；check原始bytes先按官方c14n判据解析，使用固定安装目录和共用树core，拒绝未支持的queries/i18n/condition/loop/actions。原始输入和trustedContext在第一次await前隔离，不接受正文自带snapshot/批准标志/目录路径。
- 服务端上下文必须含VIEW_SCHEMA完整六分量身份、实际计划/激活模型的完整八字段expectedBusinessRef及已知deletedNodeIds；公司/app/module、asset/version/digest精确绑定，不猜同名、UUID别名或latest。resolver私有结果核对ref、登记身份→schema_id/schema_code映射、真实发布/审批记录标识、冻结registered形状与生命周期、profile和重算正文摘要；该metadata仅是内部契约，resolver仍须实际查验来源与正文，不能由上传内容拼成。
- 冻结公共RegisteredContract不加私有app/module字段；external asset_id可不同于schema_code和服务端UUID。旧published_contracts缺身份/来源不得自动补造。报告始终validationScope=STATIC_VIEW_AND_REFERENCE、releaseApproved=false；本批无真实SQL来源适配器、发布/runtime接线或部署，受控resolver夹具不冒充审批证据。
- 初始缺模块RED；补Python布尔true与整数1比较反例先RED，再用严格协议比较。独立复核补出Unicode空白trim/strip差异和损坏bundle抛错问题，均先RED：history ID改用冻结公共ViewNode.id schema、私有record_id固定ASCII规则，public check统一关闭报告且不泄露cause/安装路径。复制安装fixture先有效bundle作对照，再missing/tampered；另测异步等待期间原始bytes/context被改不影响此次判据。首次定向中的只读目录夹具误改已冻结ref导致错误，修复测试复制后重跑，不计为产品缺陷。
- 最终11项双语言定向全部通过，exit0、27.893秒。独立复核分别重跑11项与相关3项，确认发现闭环，无本批新增确定阻断。最终完整平台798项：797通过、0失败、1既有跳过，实际exit0、184.228秒，runner确认自有PG停止。完整命令同批次31；最终退出后才计算以下摘要。CI加入此定向文件。冻结参考/语料及DSH未改，1049语料的最近新鲜完整结果为批次38，未声称本批重跑。
- 真实登记映射/不可变来源、prepare/final publish/runtime接线及其余12项继续；整体任务仍不勾选。DeepSeek仍缺本机可用凭据，未执行真实模型验收。

非敏感日志SHA-256：
- `production-view-red.log`：`d9527b1bd4baad3d73b26016cd9730b50364c7d62f51d905d62f791a6909abaf`。
- `production-view-scalar-red.log`：`411fc4f71c24c116e485c2237bcaeb3365251868fef38ab3bdd9a76024182b10`。
- `production-view-boundaries-red.log`：`7bfe36edec320fd44cb68980c5aed62609991084f4b75d99125f4cb46788d338`。
- `production-view-boundaries-green.log`：`4d68198cf0e75046b090be5083d52fde3edd64c2102bf16221ea8d06844a409c`。
- `production-view-final-focused.log`：`26ce3d6a8fd7a1d66680522e26d4b7c3fbeda1c292e0a4749f114522a1cd4365`。
- `batch39-platform-final.log`：`a0b88814ac59ca1c4d967701979feb746d90f6aaa45f9bf4a0f95471690795db`。


## 批次40：不可变业务模型身份预留

- 新增SQL42 private schema/NOLOGIN owner与business_identities，TENANT/company/app/module/BUSINESS_SCHEMA/asset_id映射数据库default生成UUID与不可变schema_code。nullable分量保留，与字符串null不同；同namespace code不可复用，同身份重试保留初次UUID/创建人/会话/DB clock时间/trace。内部SHA256索引桶不是公开c14n/spec摘要，命中后逐项比较原值，支持超长StableId而不依赖btree文本长度。
- 私有表不受public blanket grant影响，平台角色无表读写/CREATE/SET ROLE，只获具体函数EXECUTE；FORCE RLS限制owner按transaction company读取，immutable statement trigger拒绝UPDATE/DELETE/TRUNCATE。SQL函数仅证明company/user/session GUC调用一致，不能独立证明最终用户授权；无外部HTTP/AI入口，不声称app/module完整scope策略已实现。
- Node内部reserveBusinessIdentity在任何await前复制ctx/参数，拒绝省略分量或伪造UUID/version/lifecycle等额外字段，namespace来自服务端计划而非code猜测。先获namespace锁，再锁当前user/session/membership，并在借入同一client上重用实际Builder资格。loadSession/isDirectoryBuilder/requireDirectoryBuilder最小增加可选client，避免32并发持连接时嵌套checkout；等待撤权后必须拒绝，标准users→sessions撤销与本批锁序一致。
- 初始缺模块RED后8项真PG通过；扩展测试曾多写一个括号导致语法错误，修正后再跑，不计为产品RED。自查孤立代理被pg传输替换成UFFFD而产生身份混淆，真实反例先RED，再用官方c14n拒绝非法Unicode，并明确拒绝PG text不能表达的NUL；合法UFFFD正对照不误拒。
- 独立复核指出42 DDL COMMIT后、迁移器另写ledger前中断的窗口，保留实际身份行仅删42账本再迁移先RED（schema already exists）。修为schema/table IF NOT EXISTS、owner/ACL/RLS重置、policy/trigger事务内重建、functions OR REPLACE；重放不改身份数据。独立复核分别重跑12项及迁移窄用例，确认原阻断闭环，无新增确定阻断。
- 最终12项真PG定向全通过，exit0、11.277秒：32同身份并发、12不同asset争code、公司/app/module/null、超长ID、code漂移、伪元数据、员工/跨公司/结束/过期会话、user锁与namespace锁后实际撤权、缺/错GUC、私有直写与不可变、事务回滚、owner RLS、正常增量及缺ledger重放。迁移测试先造真实legacy发布行，不以空表证明不回填。
- 最终完整平台810项：809通过、0失败、1既有跳过，实际exit0、199.139秒；runner确认自有PG停止，所有最终退出后才计算以下摘要。完整命令同批次31，定向通过run-isolated.mjs运行business-identity.test.mjs。没有改变既有试点、DSH或正式目录版本。
- 本批仅身份预留，不存spec、不分配发布版本，也不返回PUBLISHED/批准。真实版本正文/审批来源、生产resolver与发布/runtime接线、固定fork完整源码/构建收据/打包资格及其他12项继续；所有整体任务仍不勾选。

非敏感日志SHA-256：
- `business-identity-red.log`：`6634028cfe48c602ac55478120f55fb73b8f5b77d2517add6a6d9b90aaac817d`。
- `business-identity-unicode-red.log`：`ed3bbc0454aeda84d853bf62c82743d9cb2eee268ae6083642d327c0965ad081`。
- `business-identity-migration-gap-red.log`：`20f49160d46e29e05df79490f2975efb8a835dd4c5db962003e69a1aed0ceaf9`。
- `business-identity-final-focused2.log`：`c3d032e647ed20b88631e9102579ab8da82d0f6550a783d5e592c2a158f16096`。
- `batch40-platform-final.log`：`feef347d43d7c516fb154b73ec0055b9a2864fa6aac92dcc51afb87564be94cb`。


## 批次41：固定fork完整声明源码清单核验

- 新增只读工具/lib/runtime_source.py，固定指纹完整baseline e6a559b1550f5bee359cffc514f6a498710d0697，Git禁用replace objects，以NUL分隔ls-tree取12072条（12048普通、9可执行、15链接）；叠加132新增/108覆盖/8删除，预期12196条。基线按原始Git blob hash、overlay按已登记SHA256，所有预期项先核，不能被输出忽略规则跳过。可执行位本批不鉴定。
- 普通文件及父目录不允许symlink，链接按固定blob原始target字节并核目标留在清单/根内；15个相对链接中的.claude/skills目录别名不递归，其真实目标源码独立核。删除用lexists，broken link亦拒绝。然后扫描额外项，只从已匹配package.json、tsconfig显式outDir、prebuilds清单导出依赖/输出排除，精确列excludedUnqualified；不执行源中脚本、不加载源码依赖、不借.gitignore放宽。声明输出/依赖并未获得产物资格。
- 初始缺模块先RED，7组fixture绿；独立复核实测补循环target的RuntimeError、非对象配置的AttributeError、.git FIFO三个反例先RED，修为固定SOURCE_LINK_UNAVAILABLE / SOURCE_BUILD_LAYOUT_UNSUPPORTED与元数据类型拒绝。最终10组分别在Python3.12和系统3.9.6全通过，均实际exit0；独立两人亦重跑10项闭环。CI加入同一unittest。源清单选定根需管理员控制，不声称原子树快照或抗并发目录攻击。
- 最终实际fixed-dsh只读核验exit1、12193/12196，正确保留3个SOURCE_DIGEST_MISMATCH：apps/desktop/scripts/node-bin/node.cmd（94字节/3个CRLF，blob91字节/LF）、apps/desktop/scripts/windows-sign.cmd（995字节/17个CRLF，blob978字节/LF）、packages/tool/kvvi-business/package.json（scripts与outer overlay不同，非仅换行）。未修改该目录、未放宽字节规则，也不能把其先前构建结果称合格发行源码；因为未全部匹配，此次没有继续到它的输出排除扫描。
- 另在自有canonical-source-2abj9z7w参考目录，从禁replace的固定Git cat-file原始blob分批导出（非checkout/archive EOL转换），应用已验SHA的240 overlay与8删除；实际最终12196/12196、exit0、0错误/0排除，inventoryDigest sha256:e5bd0355fdf46668f7df25509a2c2ea48dfc75623a2ad49d9975fe3ebac99b9e。独立复核重新核对同摘要。该参考树没有构建产物，不是原built树修复/部署或发行验收。
- 更正本批前的只读口头判断：rg未包含ignored文件而漏看fixed-dsh/.dsh-build/client-build-environment.json。实际直接读取并调用上游readClientBuildRecord成功，252客户端产物摘要e0f13ae686f10844d746733c9e06a877c81e9a036cc03bd0a98ee8baa9778f7b仍匹配；registered-fork无收据。它未绑定本批完整源清单、host产物与打包，不能覆盖上述3处源码差异。
- 工具报告只为DECLARED_SOURCE_INVENTORY、releaseApproved=false。失败inventoryDigest仅覆盖匹配子集，不是整树资格。固定源码重建接线/实际完整重构建、显式runtime-source打包、目录/host/收据/解包服务身份继续。本批未改平台/DSH/试点；最近平台全回归为批次40的810项，不冒称本批重跑。整体12项仍未完成。

最终非敏感日志SHA-256（均实际退出后计算）：
- `runtime-source-red.log`：`ce1fb62fa3b7a78e059fceff50faff496baba36c954e01ef1e35f9cfb8fa9595`。
- `runtime-source-boundaries-red2.log`：`4dacdbd4bd77f45856acca6a148d7416772dde5cd0b9ff8b5b532f452dd5ccfc`。
- `runtime-source-final-unit.log`：`6eca4f5012d6a8987ead5eba6d93c63b759274db17ef48b71855bf3f5e79a44f`。
- `runtime-source-python39.log`：`3433635765e32e7fb02fd2e11a6ecb5bec430b0ff175d2be9756cde0d7ba4f97`。
- `runtime-source-final-built-rejected.json`：`11b3f7fecd4f166c0a55be75ad517a8d24bd11e760d1f10afe22cef2cf9a06d7`。
- `runtime-source-final-canonical.json`：`27e9f25b1970e6fb91ece1755b564b8ae8392555bfa829c313ee842bcebb9b2f`。


## 批次42：固定Git blob原字节重建

- 新增raw_git_source.py，两条pristine来源共用禁replace的ls-tree/cat-file分批导出，按Git blob header/长度/SHA1验证原字节；local读现有对象，git来源在临时对象目录clone --no-checkout后仅取固定baseline，不再archive/checkout触发EOL转换。只往自有staging写，文件644/755、链接最后建立并解析留在stage内，成功后替换新或空目标；非空/末级link目标拒绝且保留。
- source inventory私有_git最小增加input_bytes与120秒调用预算；初版错误复用旧参数产生TypeError，随后macOS /var→/private/var路径别名误拒合法链接，均由正例失败定位修正。模块初始缺失先RED。未以这些失败或早轮结果当最终通过，最终记录如下。
- 独立复核用自有Git mktree重现APFS上A.txt/a.txt静默覆盖及clone TimeoutExpired越出bool接口；新反例先RED。文件改为O_EXCL/O_NOFOLLOW独占创建，再核stage实际全部路径及目录拼写集合，拒绝Src/one与src/two、Unicode等价目录等无文件碰撞的合并。clone的OSError/SubprocessError统一False并清理临时对象；目标权限/rename失败则固定RAW_SOURCE_EXPORT_FAILED，stage清理、空目标不变。
- 最终18项在Python3.12与系统3.9.6分别全部通过，exit0（1.837秒/2.170秒），独立两人亦重跑18项闭环，无新增阻断。覆盖eol=crlf属性仍输出固定LF、755/链接文本、非空/链接目标保护、缺base/unsafe link不发布半套、replace忽略、local pristine与本地clone模拟git来源、rename故障及上述FS/超时边界。受控超时夹具预期输出KVVI_FORK_CLONE_FAILED，不是最终运行失败；没有在此声称真实网络clone通过。CI扩充同一测试入口。
- 最终实际在新自有raw-rebuild-kb2jqs9a从registered-fork对象重建，240覆盖/8删除G2通过；完整source checker 12196/12196、exit0、无错误，inventoryDigest仍sha256:e5bd0355fdf46668f7df25509a2c2ea48dfc75623a2ad49d9975fe3ebac99b9e。print的os.walk基线12071文件不计一个目录symlink，完整12196判据含链接，未缺源项。此为最终修正后新重建，不覆盖原fixed-dsh、registered-fork、canonical-source或试点。
- 该新树尚无依赖安装/完整构建或bundle。下一步按锁安装和全构建，随后显式runtime-source发行与源码/host/client/目录/收据绑定；旧built树三处差异仍未自动改。平台代码未改，最近全平台仍批次40的810项。整体12项不勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `raw-source-red.log`：`1961b695a833a865afaa3689bd5e2de01ea87da7b77a9ea52bca8fdf77dbe5f5`。
- `raw-source-alias-timeout-red.log`：`81160118ae79e78afc23bcb38df62d83a4b5b07c718631ea693897f357ead7c1`。
- `raw-source-final-unit2.log`：`210fd23b08e7f7ca084565310c4bb0b926103376b838c91f2daf8bc31b8caebe`。
- `raw-source-final-python39-2.log`：`e53bcdd71fa88bf778c3f3185d6125f7d35a82d96cb6c4af6d3352425ea811fb`。
- `raw-source-final-rebuild.log`：`00c6053b53c73278d72ad1bef1c692f257ec7a0d2afc0d3ffcc2c296a9cdfa4c`。
- `raw-source-final-qualified.json`：`27e9f25b1970e6fb91ece1755b564b8ae8392555bfa829c313ee842bcebb9b2f`。


## 批次43：新源码完整构建与构建后边界复验

- 在raw-rebuild-kb2jqs9a用Node24.20.0/固定pnpm11.7.0执行install --frozen-lockfile --offline，exit0（8.4秒）。GIT_CEILING_DIRECTORIES阻止父仓库发现，DSH_CLIENT_COMMIT_HASH显式绑定固定forkHead 8920b8094ed26cc89922334c835a1e58119b2a6c。安装阶段dsh bin尚未构建的警告不作运行资格；随后完整pnpm run build exit0，native、host/client tsc/tsdown、web Vite均完成，最后写252项收据。
- 实际调用上游readClientBuildRecord重hash，匹配commit8920b80/version0.1.6-alpha.2（2个公开环境值），产物摘要985ecc71bbb10cddb314fa9f3f2fd5d50af62c3a60bfe3dd0fde827f77916cb8；8文件qualifyComponentAdapter通过，但仅explicit-source-inventory-only，不代表UI已消费目录。
- 首次postbuild源码12196项全字节匹配，但拒绝额外native/system/.release空容器。已核build.ts:76–90只移除mkdtemp子目录；新Git fixture先RED后仅允许精确空容器，残留/隐藏子项、link或同名文件仍拒绝，不宽泛忽略.release。scandir短路ResourceWarning按复核意见改with关闭。最终19项在3.12/系统3.9.6以-W error::ResourceWarning全通过、exit0（2.287/2.316秒）；两位独立19项及额外边界亦闭环。
- 新构建目录客户端vitest 21文件257项、host mode-router/business/publish adapters 8文件110项均全通过、exit0（5.95/2.80秒）。客户端夹具仍有既有sessions service unavailable控制台栈，构建有大chunk/plugin timing与插件迁移提示；不声称无控制台错误、真实会话/浏览器或模型通过。
- 最后全部测试退出后再次核源码与收据：12196/12196、0错误、632依赖/输出排除，source digest仍e5bd0355fdf46668f7df25509a2c2ea48dfc75623a2ad49d9975fe3ebac99b9e；收据/8文件仍匹配。local-build-observation.json存锁摘要、4个host入口anchor和native摘要；取证脚本初次误把CLI bin当main而停止，已按实际package.json的bin.dsh读取。anchor不是完整host表，client252也不覆盖全部native/目录消费者。
- 不改原built或试点；无真实DeepSeek、认证浏览器/干净用户macOS、打包或部署。最近平台全回归仍批次40的810项。打包器只读复核另重现失败build毁旧archive、check不核tar实际内容等P1；后续先修输出保留/隔离自测，再归档完整性及显式source/收据接线，整体12项不勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `raw-qualified-install-offline.log`：`16191c848a6380e98c4b8cac7909b50d2038a46c4f633c0d1cd15031a7ad9a48`。
- `raw-qualified-full-build.log`：`f7afbeb5297cf76b9f983897dcb9bbff273ecaa9b238c94df01614497c53e85b`。
- `raw-qualified-client-tests.log`：`dd69aef384dd4639b4ace0d31efce543b17dc241bdbd5ed95c5bc01530e9b697`。
- `raw-qualified-host-tests.log`：`2889e15b376727253afdd84b7f18a200594dbbbaa4a070c5aea6d663975c9cf4`。
- `raw-qualified-after-tests-source.json`：`ae5045a593e9353737d485fb1e3f302d8f4509e3d4f4a281cfa2d94aad978c39`。
- `raw-qualified-after-tests-client.json`：`152d1e8697367f23a023ba564e0ab0498aa0ff226ee47d7b4c129b54844a28a4`。
- `native-empty-container-red.log`：`fab2ad0430e611f354107c7ca0d42dad3aff3742a754ad908fde8702eccf7d12`。
- `native-empty-container-final-unit2.log`：`29908cc09770c6e5b526a1603ad7edceba7612d66d734f00695605fc7ed4f7c8`。
- `native-empty-container-python39-2.log`：`d3477112acb614505b0da3e010b3bcfd3810aaf50a6b4a1edf1a8a98cc9fcc9a`。


## 批次44：发行失败保留旧包与隔离破坏测试

- 新增package_outputs：同输出目录私有candidate完成tar/清单后才发布，扫描与tar写入取同一次body。缺必需项、FORBIDDEN、tar/清单失败保留旧pair；OS锁串行本工具build/check，旧pair备份与固定journal先于rename，第二rename或进程中断在下一次本工具调用恢复。回滚自身失败保留journal和旧副本；先验全部恢复路径/类型/摘要/当前字节，拒绝意外外部修改。只保证受控进程中断恢复，不声称两文件对外部读取原子或断电耐久。
- self-test改为新模块+合成最小仓库/包，所有破坏仅自有临时资产；原包、清单与server.mjs的bytes/mtime保持，无真实包亦可跑。未执行真实发行目录build/check/self-test，也未更新试点。
- 原8组先RED（4失败/4错误），最初8组修复通过后补真实锁冲突、丢失第二rename确认、回滚故障/损坏backup与一次读取快照。独立复核再复现candidate普通文件验证过晚、APFS case/Unicode输出别名覆盖、嵌套JSON异常及FIFO锁FD泄漏；反例先RED后前移类型验证、目标FS独占创建实测别名、固定恢复错误和仅已锁定才unlock/独立close。二轮复核另发现输出可别名内部journal而被删，新反例先RED后对NFC+casefold后的保留前缀保守拒绝，覆盖内部锁/journal/candidate命名空间。嵌套深度最终10000覆盖Python3.12，早期1500不足以令该版本红；FIFO测试按实际FD关闭验证，避免把临时名称probe的close次数误算为泄漏。
- 最终16组在Python3.12/系统3.9.6分别全通过、exit0（5.495/5.598秒），-W error::ResourceWarning；两位只读复核分别15/15与最终16/16闭环，无新增阻断；CI加入同入口。平台未改，最近全平台仍批次40的810项。清单所述tar实际正文/类型/路径与全集校验、显式runtime-source及完整产物/目录收据绑定仍待后续，不把此批当发行或12项验收。
- 用户再次提到安全配置路径后，仅输出布尔重新读取指定kvvi.env及登记DSH进程环境，文件存在、键仍非空缺失，登记进程内核身份前后稳定、环境可读但无非空DEEPSEEK_API_KEY；没有输出值或重启进程，真实模型仍未执行。

最终非敏感日志SHA-256（实际退出后计算）：
- `package-preservation-red.log`：`a79576f61b38b451e6008efe65a076851ad05095eccac660e29e606a14947c50`。
- `package-review-red.log`：`5b1bedad38d4223d47392fc88b3ac13eec4d9ad28b2b2c3619eea1d9ea450fbe`。
- `package-journal-nesting-red.log`：`d3b69c2ddd6f96856957f28b0b47b4e0ea72bdc4af118cc0c2f93a145e65dd01`。
- `package-preservation-final312.log`：`d3f95274da58ff9f01a6d100d3e0a00c0ae8795df3217efbfb70f28e69d252e6`。
- `package-preservation-final39.log`：`d92fd079a7a587d097d2ddc89571eb83a4a73319ca8b962e3c7bd4d7f0d5f108`。
- `package-control-alias-red.log`：`42a6061a792c443fbca7dc25c84c2e35e3194628b1464078922c5e6fb4a8c206`。
- `package-preservation-final312-2.log`：`5cee0b4a34dbbc6e05eb0ef87a512e8f2877b80007186f603738139ff6b19325`。
- `package-preservation-final39-2.log`：`a2db70f82a49b999eb26ee8146c2311a92a706eafcc72fcc88d6096b90f148ab`。


## 批次45：归档实际内容与当前源逐项一致

- 新增package_inventory，格式升为kvvi-macos-pilot/v2（旧v1固定拒绝）：file以path/type/mode/bytes/SHA256，symlink以path/type/mode/原始target记录；内外清单同一canonical typed rows摘要。check实际读tar每一成员，唯一/安全路径、精确全集、正规文件/链接类型、模式/固定owner/mtime/device字段、实际body或linktext必须等于清单，再与当前collect快照逐行一致。清单摘要不是签名，当前源一致性也不证明固定Git来源/完整构建。
- build通过lstat+NOFOLLOW/NONBLOCK+前后fstat/lstat稳定读源，扫描与归档body一次读取；手工TarInfo避免hardlink隐式折叠；目录symlink纳入而不跟随，链接必须在包内有真实可达目标，循环/断链/外逃拒绝。docs/操作手册.md升为必需regular文件；全部candidate完成后自检实际归档才publish。原包保护/隔离self-test继续保留。
- 10组新反例先RED（16失败/2错误）；类型/正文/危险路径/重复/内外清单/模式/链接变化修复后26组通过。追加PAX扩展属性、第一零头之后隐藏第二tar、gzip缺尾均真实RED；现在只允许与最终字段一致的path/linkpath扩展，检查规范tar零padding并将gzip读至CRC/footer。mtime改写再RED后固定0。畸形/深嵌套/重复键JSON均固定错误，UTF8和16MiB上限。
- 两位独立复核同报先normpath后link导致外逃；先RED后改为deque按原始路径组件展开link再处理后续..，每步根/存在/类型检查，最多64次展开。安全alias/../data用系统/usr/bin/tar在自有目录实解通过。另chmod000实证os.walk静默丢源先RED，onerror改为抛出、build失败保留旧pair。一次新增测试插入位置错误导致NameError，已纠正并重新完整运行，不计为实现通过证据。
- 最终包30组+源/原字节导出19组，合计49项，在Python3.12/系统3.9.6均全通过exit0（8.068/8.270秒），-W error::ResourceWarning；日志末KVVI_FORK_CLONE_FAILED为已有受控超时反例。独立30/30闭环；CI加入inventory套件。冻结7文件摘要全部通过。平台未改，最近全平台仍批次40的810项。
- 全部在自有合成仓库/包测试，未生成、覆盖或验收真实发行包，未动试点；显式runtime-source与固定完整源/host/native/client/目录/generated收据接线继续下一批。整体12项不勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `package-inventory-red.log`：`bc727ba1939c058cb22b1d981f9eed46d37098477eae5410641d0db087771318`。
- `package-tail-pax-red.log`：`af6c0b00cbd262dfb6d0d31838a923d1b19ec87241f84dc7327fa2386d754f41`。
- `package-symlink-components-red.log`：`cbf4a2ba65f39a0fcf2354386343a50dd131d2681c31a9e8a36e281456ef7706`。
- `package-unreadable-red.log`：`dea897bfa4c3f5be83c3b4f0a6aa441f25328a1f967738904cc417d89ace5b51`。
- `package-metadata-red.log`：`0e7196c2b982b22e157a6d52552d9bdb0a6b34e5de23251747afb1ac0d6b9ce9`。
- `package-inventory-final312.log`：`c1a3b4595dc85760d07e310afd7571f4cf9b4114b65601965cd9d63eac8e525d`。
- `package-inventory-final39.log`：`c39862a50438f84e7bc90ba496747c5ff7eae7d8ec8869895cfb75042bc3868c`。


## 批次46：显式runtime-source与所有调用路径接线

- build/check/collect/count/packages_missing_main/CLI统一显式绝对RUNTIME_SOURCE，vendor/dsh只作包内目标名。缺选择/相对/不存在/末级link含尾斜线/bytes值拒绝并保留旧pair；argparse互斥build/check/self-test，不再子串选动作。self-test构造独立显式source，不读调用方runtime。G9、完整采集及append/refresh-stage11均显式传相同source，其他证据verify/阶段8–10调用保持功能；没有执行任何真实采集、旅程或历史替换。
- 初7组先RED（11失败/1错误），后逐步补metadata/main边界。pjson元数据只能是collect已收regular，深JSON/顶层重复/畸形固定失败；source包的nested dependencies按Node标准语义处理，与严格发行清单区分（只读实证固定上游llm-retry的同值重复依赖项，不改源）。入口声明路径必须实际随包，拒本机absolute、父级、未收node_modules经realpath指向已收文件。所有main后缀参与，根JSON workspaces与pnpm packages plain列表并集包括vendor/native/benchmarks；新语法不猜，固定失败，尚不验证完整exports/依赖闭包。
- 独立复核补absolute已收入口、excluded依赖别名、vendor/.cjs/.mjs覆盖缺口；均有自有fixture和反例，修正后闭环。另root含node_modules字样或glob字符不可绕扫，受限YAML只认空白引导#，extras#hidden先RED后不再截成另一目录。
- 带空格source需要shlex.join记录；复核发现中文脚本quote与旧G6-G9子串判命令冲突。4读端自有证据先RED，再shlex.split精确argv：G6–8精确3项，G9精确5项含绝对runtime-source；echo前缀、额外参数、破引号、None均拒，不执行记录字符串。G6–8旧无quote记录仍通过；历史证据未改。新helper依赖纳入未来G9源摘要名单。
- 最终包/选择/证据命令49组+源/原字节导出19组共68项，在Python3.12/系统3.9.6均全通过exit0（8.953/9.451秒），-W error::ResourceWarning；CI加入同入口。末尾clone错误仍是受控故障反例。两位独立最终19项及49项分别确认当前修正；平台未改，最近全平台仍批次40的810项。
- 实际raw-rebuild-kb2jqs9a仅只读collect/main/count，16042条、2091 runtime JS、main缺失0。最初误将所有pjson nested重复也按发行清单拒而报PACKAGE_INVENTORY_INVALID，已按source/manifest不同语义修正并复查；不改变固定源字节。未在真实目录build/check/self-test，不生成发行包，不迁移/重启/部署试点。完整固定来源/构建/目录绑定仍下一批，12项不勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `package-selection-red.log`：`a1b5859e3c9e8cc55c944aa7192d640eab7c97aed0ddf49eb051713979b52069`。
- `package-selection-boundaries-red.log`：`00cc6cd1079070368d59b3879eafe6b17255f75e2916a60b538fe1c09195dae2`。
- `package-selection-metadata-red.log`：`61bada9190f9fbe4cc4660444d4186349596eec30beac449249c5a1dad4e8569`。
- `package-portable-main-red.log`：`dbdd152597f0d6a2569519945d482d3aa3a814f3ac6b00f456a170a096668472`。
- `package-workspace-main-red.log`：`a8d753dfc5bf12e1d92563a05acdffd29eccc25554d4460186a0deec9c7bc984`。
- `package-source-metadata-semantics-red.log`：`cc7cff5fd2aa38dc73fd0302be144acf4d156b9f448862d9826eb260069a1968`。
- `package-evidence-selection-red.log`：`b993efb3b61f30660d9c887a1cd881caa07fd37140e89b54f665007c8851c446`。
- `package-workspace-hash-red.log`：`702f4e87b1989412860eb0d9de6a9802b8573760586b95df455629d5969b190c`。
- `package-evidence-argv-red.log`：`435e7c397a1bfd2a90c3fe6d653e19447fffb3cd7aca039b6c842fc19025a398`。
- `package-selection-final312-2.log`：`a5574c293d56c23f31b7c4d648323faccd034a55ee4e16ec65c51e09f392e27f`。
- `package-selection-final39-2.log`：`db0a46017391105f7a14303b1adffbd7da2ada3d6dba21abc1152b31520f903b`。
- `package-selection-readonly-fresh.json`：`168c2caf762f78de5bd0f72d31046f8b60483c85351db6d1c7af9def21a2580b`。


## 批次47：固定完整源码资格记录接口

- 新增package_provenance，复用完整declared source checker，将仓库工具指定的可信overlay manifest原字节SHA256、固定baseline与完整inventory profile/digest/count绑定为FIXED_DECLARED_SOURCE记录。manifest前后重新稳定读取，完整valid且count/profile/digest符合才返回；失败固定code，无部分inventoryDigest/sourceEntryCount。CLI使用-m，固定仓库指纹路径，不暴露业务输入选择manifest。
- 记录始终releaseApproved:false，excludedUnqualified保留原632路径范围，limitations明确exec位/依赖/build/client receipt/catalog consumption/release acceptance均未鉴定；不是构建或发行凭证。尚未接入packager/G9；后续接candidate前后和内外清单。
- 原6真实Git夹具缺模块先RED、实现后通过，覆盖原始manifest绑定、完整源篡改无partial资格、输出变化不冒充源变化、坏/深JSON/重复键/link/缺Git对象、显式root及校验间manifest变化。独立复核指出snapshot无界读后才限制manifest；128MiB sparse+reader guard先RED，snapshot增加可选max_bytes，在fd身份核对后先拒超限size、最多read(limit+1)，provenance初读/复读及source metadata均传16MiB。第7组含首读和sourcechecker后增长双阶段，普通source文件读取不改。
- 最终7新组+既有68共75项，Python3.12/系统3.9.6均全通过exit0（9.543/10.054秒），-W error::ResourceWarning；clone失败行仍为受控反例。独立复核分别7项与56项闭环，无新增阻断；CI加入同入口。平台未改，最近全平台仍批次40的810项。
- 实际最终只读CLI：raw-rebuild-kb2jqs9a exit0，12196条、632未鉴定排除，digest e5bd0355fdf46668f7df25509a2c2ea48dfc75623a2ad49d9975fe3ebac99b9e，manifest raw SHA256 bc7fce56dc0b16c307fddcc549f77a6d12388181af1a0d62800f77d7c5571dbc；原fixed-dsh exit1，仅FIXED_SOURCE_REJECTED、无部分资格字段。两树与试点均未写入、打包或部署，12项不勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `package-provenance-red.log`：`090bce077a16c007950be37f38e0aa53717626bc373b4ea5c818568ba7c30a19`。
- `package-provenance-bounded-red.log`：`1bbdeb114bcb36940407fcad2b65251d57fcafab5677f53710b81761d1fefc01`。
- `package-provenance-final312.log`：`dcf27741b989d335bc42bc4f49e06dd2068499f8e7d9ef3ed55adcbc134b8f0c`。
- `package-provenance-final39.log`：`ce2619f2ddce74255e7b60b482d54dcfc32f93b0edda68ba48d70d5df33c7ee6`。
- `package-provenance-fresh-final.json`：`643d3a133e240eafe5edbad41ff45da05098e99ffdd7263a0b2e94736931c63a`。
- `package-provenance-legacy-final.json`：`5f2ed90e1b92a113b7204ff66d646f70436be7308f7a246b0cf00974867a2aa4`。


## 批次48：固定源码绑定最终候选与G9

- 发行格式升为kvvi-macos-pilot/v3，旧v1/v2拒绝；build/check及G9采集/append/refresh均要求显式runtime-source与git-objects，可信G2路径由仓库工具固定。candidate前后完整源码资格相同，内外manifest绑定同一sourceQualification；记录仍releaseApproved:false，依赖、exec位、build、client receipt、目录消费与发行验收仍未鉴定。
- 完整source checker新增仅成功时可选私有sourceInventory，provenance显式传出sourceRows供内部绑定，不将12196行表扩充到发行manifest。校验表的完整count、排序、唯一安全路径/type/hash及canonical摘要后，最终candidate中所有declared source的type/实际body或linktext SHA必须匹配；按打包策略必收源项不得遗漏，新增runtime路径仅限明确未鉴定输出排除范围。
- 初5组先RED（5失败/1错误）。两位独立复核先后实证source临时改字节/漏收后恢复、metadata临时移除main、workspace glob暂漏、最终candidate暂缺generated main仍可发布；分别补真实反例先RED，再将正文/集合/元数据绑定同一可信表，从表枚举workspace，最终入口检查使用candidate行集。追加目录link伪装main的RED后，复用逐组件链接解析，只接受在candidate内最终解析到regular file的入口；指向已打包普通文件的link正例保留。
- G9记录精确7 argv，两个显式目录均必需，证据reader仍仅解析不执行；self-test创建自己的Git对象、G2及最小runtime，调用方资产不参与。CLI/证据/CI同步；未执行真实collector、真实发行build/check/self-test或历史证据刷新。
- 最终8模块联合92项在Python3.12/系统3.9.6以-W error::ResourceWarning全部通过、exit0（22.799/23.497秒）；两位只读复核分别最新91/91和最终92/92闭环，未发现新增阻断。clone错误行仍是受控timeout反例预期。冻结7文件摘要全通过。平台未改，最近全平台仍批次40的810项。
- 实际新树仅只读source/candidate快照绑定：12196源项全部匹配，collect16045项，其中2868 runtime输出仍未鉴定，main缺失0，source digest e5bd0355fdf46668f7df25509a2c2ea48dfc75623a2ad49d9975fe3ebac99b9e。没有生成包、覆盖输出、重启/部署试点或真实模型验收；完整构建/目录收据继续下一批，整体12项仍不勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `package-source-gate-red.log`：`6142ed72a14ab92a262a4e91191a8a9e543e9482afd92381adae53d72c6784c9`。
- `package-source-aba-red.log`：`3ebf215df1d496084299680bf4f902fb596a85852b9a372d93114c689d601b02`。
- `package-source-omission-red.log`：`309e006e3461900cf556117315b9f39ef8ec97dedb3fa6a2e5db8e7be09c8dc5`。
- `package-source-metadata-aba-red.log`：`d8a9c959c43056727370a015dba2edeba818e6fa3cca7e0738263c1f5491d006`。
- `package-source-main-sets-red.log`：`ba6537f77832e214e7ab026981f69cd60c0a589189f62f172839120088f88404`。
- `package-candidate-main-type-red.log`：`97a3320cd095c3dc8fe4e10b3583e246d404478b1dd93326b61408b4a72e7293`。
- `package-source-gate-final312-2.log`：`e441765cc41005eeee6e78218968717ae7333f8b495fab3e60897b9312c46033`。
- `package-source-gate-final39-2.log`：`ef391a99faa8d76e4069229ebf6e2d71868346a8d7a575b725c45e4a90782484`。
- `package-source-row-binding-fresh-final2.json`：`601c564e9183ae934467e3643b70a5f97ad598a06505ffb1eec31a78de799701`。


## 批次49：固定源客户端收据完整性只读接口

- 新增package_client，先完整source资格与私有表，再从同一G2原SHA所绑定fork_head和同sourceRows SHA的根package.json version形成唯一两个公开环境值。固定.dsh-build/client-build-environment.json稳定有界读取，严格格式/类型/重复键/安全整数与摘要；失败固定CLIENT_RECEIPT_REJECTED，无部分source/artifact资格或原始环境值回显。
- 精确复现上游五模式，按JavaScript UTF16排序、UTF8路径字节长度及正文长度分帧计算摘要；digest与typed rows来自同次snapshot，第二轮路径集合/rows/digest相同，receipt三读原bytes一致，完整source binding前后相同。只读API可显式给私有clientRows，默认不输出全表。匹配产物/目录/祖先link拒绝，未匹配文档filelink不读正文。
- 初11组缺模块先RED，独立复核再发现dot路径与Unicode数字语义差异；实际首次观测也因固定packages/CLAUDE.md文档link过严拒绝。增加正反夹具后glob轮先RED（5失败/1错误），版本真实Git反例先RED(valid:true)；按Node默认dot:false与ASCII版本修正，保留web dist内node_modules及client..js，真实Node独立8项集合/framing摘要与Python一致。新增源metadata临时变化及产物枚举期间新增反例，始终无部分资格。
- 最终17新组+provenance/source/raw-export27组共44项，双Python3.12/系统3.9.6 -W error::ResourceWarning全通过、exit0（4.477/4.773秒）；两位只读复核独立34项/15项及额外集合漂移实验闭环，无新增阻断。CI加入客户端入口；末尾clone故障行仍受控timeout反例。既有packager源码未改，不重复声称92项是本批最终命令。
- 实际只读raw-rebuild-kb2jqs9a通过，252项/摘要985ecc71bbb10cddb314fa9f3f2fd5d50af62c3a60bfe3dd0fde827f77916cb8，与既有上游收据相同；原fixed-dsh因source不符exit1固定拒绝。此接口仍releaseApproved:false，明确build-causality、host-native-outputs等未鉴定，不证明预期组件齐全或构建历史。尚未接packager候选；完整host/native及受控重建因果/目录消费继续。未生成真实包、部署/重启试点或模型验收，12项未勾选。

最终非敏感日志SHA-256（实际退出后计算）：
- `package-client-red.log`：`54c5636996ce78d967cf273e00cdc2323a51a4f1702a288cdd72600af0efc377`。
- `package-client-glob-red.log`：`bac77a3d7b47ee10294a9aec0c44977f467a0e1ddb6eba63c52957eb77db20d5`。
- `package-client-ascii-version-red.log`：`d167281fefe666f87d9fc4db80a20d04f21260bbcaa13c0f6d3b5200f5bb539a`。
- `package-client-final312-2.log`：`62d86fd952875587540d0e89ba868ee60575ca3a0a63827947fc51b52450c07d`。
- `package-client-final39-2.log`：`209304277056b648f1f4fffdb8d52372eb9978da4c132ae0dfe8f2ac0a56d44e`。
- `package-client-fresh-final.json`：`7946864f4831b18b5229aef20435c7ec08c3c0ff50e5e31cc1a05cc94644375c`。
- `package-client-legacy-final.json`：`cbed0bafd87fb4284b9f30d8f4eadc5eac7f6fbbd4d8f5c7bd688a474e0c5a6c`。
