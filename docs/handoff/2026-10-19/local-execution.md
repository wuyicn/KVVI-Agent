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
