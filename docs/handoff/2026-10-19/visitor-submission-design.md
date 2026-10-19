# 访客S9耐久提交实施计划

依据PRD §3.5与任务3/7。批次29只交付授权前置修复；以下原子提交/恢复仍待实现，不能勾选S9。

1. 新协议链接明确签入protocol与maxSubmissions，数据库默认永远legacy-unknown，不把存量链接批量改为新协议。max1/maxN均要求调用者首次提交前持有随机原key；同key同body回原回执，改body冲突，不同key受独立链接总额限制。不能用每次自动UUID或按payload合并来冒充原key。
2. 复用writeOperation的business事务、稳定operationId、原响应和audit outbox，endpoint包含linkId，gateway为VISITOR且actor为签发人。run接到同一client与operationId：额度接纳、createRecord、公司内提交账本、回执与审计payload一起提交。使用既有事务取号，移除VIS+Date.now。授权重验不检查已满额平台投影，否则会挡住已提交原key的合法恢复。
3. 公司账本FORCE RLS；跨公司source额度由专用NOLOGIN/NOSUPERUSER/NOBYPASSRLS owner的私有schema维护，只授runtime一个SECURITY DEFINER admission函数。runtime不可读写私有表、CREATE私有对象或SET ROLE owner；public的blanket grant不得波及私有schema。源key不含company，保持现有跨公司语义，原始token/业务字段不入全局表。
4. 固定READ COMMITTED，函数VOLATILE/PARALLEL UNSAFE且固定安全search_path/完整限定对象名；先取额度锁，再独立查询读取新快照，锁后用数据库clock_timestamp确定接纳窗口和到期，拒绝其他隔离级别。锁序在writeOperation actor/endpoint→key之后，统一source→company→link，然后进入form/unique/序号锁。用量随外层事务回滚，不按平台投影时间计数。初版不清理永久link用量。
5. 平台submissions与SUBMITTED事件是投影：业务事务保留稳定submissionId及投影payload；平台同事务按submissionId去重后更新计数/事件；业务marker另行确认。投影COMMIT丢确认、marker失败、审计故障均只补投，不再执行业务。后台领取/重试有持久退避及等待预算，网络I/O前释放业务连接。
6. 迁移需区分全新数据库资格与存量切换。存量旧效果可能没有平台计数/事件，不可按零或仅平台计数初始化。存量旧链接应明确拒绝新效果并重新签发；历史source/company窗口同样不能凭空清零。没有可信停旧writer/在途事务终结及历史baseline，须保持切换门禁关闭；可信停止时刻T0后至少等待当前window，或执行可证明的保守对账。标志文件/普通JSON不能充当旧writer栅栏。已有试点不自动迁移、停服务或启用。
7. 先RED实际签名链接与PG：max1/maxN不同key并发、同key并发、改payload、实际COMMIT丢回复、receipt/usage存储失败回滚、跨公司source等待锁后COMMIT/ROLLBACK、排队到期/撤权、投影故障/COMMIT丢确认/marker失败、审计失败恢复、新进程原key恢复与后台补投。再分别做HTTP与浏览器入口接线验收，模块测试不冒称产品入口旅程。

后续验收范围按下列各批记录区分。存量可信切换执行器、后台投影、访客HTTP/UI入口与真实浏览器仍未完成，不得写S9关闭。


## 基础批次30实施范围

SQL39提供private admission与public公司投影账本，默认enabled=false；本批没有给submitAsVisitor接线，也没有实现部署切换授权。固定元数据包括issuer/max/binding/expiry，link lifetime与滚动link/source/company额度均在锁后按数据库接纳时刻检查；跨公司source key不含company。公司/actor/operation外键延迟到回执写入后，projection record外键绑定同公司。

writeOperation明确READ COMMITTED，并将本次稳定operationId传给run(client, {operationId})。私有owner不授LOGIN/SUPERUSER/BYPASSRLS，runtime仅USAGE与指定函数EXECUTE；配置及全局表不可读写。现有public blanket grant不影响私有schema。测试可以在自有新集群中由admin明确启用，不能据此声称现有部署已安全切换。

实现参考及复核：[PG17安全函数](https://www.postgresql.org/docs/17/sql-createfunction.html)、[VOLATILE快照](https://www.postgresql.org/docs/17/xfunc-volatility.html)、[事务隔离](https://www.postgresql.org/docs/17/transaction-iso.html)。资格以实际PG并发/ACL/回滚测试为准。

## 原子模块批次31

SQL40使新列永久默认legacy-unknown；仅新签发明确写kvvi-visitor/v2并将protocol、maxSubmissions、companyId、issuerUserId及已有绑定完整签入。使用时还核对登记token摘要和完整签名正文，不批量升级旧链接。本人吊销条件限制到issuer；同公司同事无权代为吊销。协议中间实现曾在自有隔离测试里走旧路径，独立复核指出资格窗口，因此未单独提交或部署该版本；最终提交中v2直接走默认关闭的SQL39准入，不能绕回旧平台计数路径。

每次业务操作必须由调用者预先持有随机UUID v4原key，统一小写，并隔离到visitor.v1命名空间。writeOperation的endpoint包含linkId、actor为issuer、gateway=VISITOR。准入、真实已发布系统的初态/流程版本、事务取号、记录、公司投影账本、回执与audit payload同一business事务；不再使用VIS+Date.now或平台submissions作效果准入。请求data与token/source快照保持一致，错误返回外部原key。

配额锁后重验，createRecord另提供可信服务端beforeInsert钩子，在form/unique/sequence等已知等待完成后重验链接、当前权限、字段与归属，撤销即整单回滚；原回执恢复也按当前RLS检查原记录，转出可见范围则不暴露recordId。这是已知排队窗口的重验证据，不代表平台吊销与business COMMIT具备跨库原子性；并发授权变更的整体序列化仍属任务1后续验收。

当前成功响应明确projectionPending=true；稳定operationId及metadata投影payload已耐久保存，但后台补投尚未实现。平台submissions/SUBMITTED暂不更新，不把业务再次执行作为补投方式。旧writer可信栅栏、历史窗口基线及现有部署启用仍未实现，private配置默认关闭。HTTP、访客UI、浏览器旅程及实际部署未执行。
