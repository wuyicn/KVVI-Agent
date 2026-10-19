# 访客HTTP接线计划（批次34）

前置为批次31–33的签名链接、业务原子提交、耐久投影与只读原key恢复。该批只交付真实HTTP适配和旅程证据，不替代访客表单UI、签发/分享产品入口或浏览器验收。

- 平台认领`/visitor/`，在登录门/运行时代理之前处理；精确POST `/visitor/submit`与`/visitor/receipt`。其余路径/方法不提供数据，也不转发给DSH。两个端点不使用账号cookie、用户Bearer或内部runtime上下文授权，只接受签名链接能力。
- JSON正文分别为`{token,data}`和`{token}`；原随机UUID放`Idempotency-Key`头，拒绝正文额外字段/重复身份来源。保持原key，错误不生成替代key或反射内部namespace。64KiB上限、JSON content-type、no-store/nosniff/no-referrer；token不放query，不回显token或请求正文。
- 公司/issuer/绑定继续由visitor模块重验。sourceIp取实际TCP remoteAddress，不信请求体或X-Forwarded-For；未配置可信反向代理时，代理/NAT可能共享来源额度，不自行猜信任边界。字段类型继续由已发布模型与createRecord验证，适配不另做一份授权规则。
- 稳定领域码映射：格式400、无效签名401、吊销/授权拒绝403、原key冲突409、额度429、切换/服务不可用503，未知内部错误500且不暴露底层message/SQL/字段正文。已提交但projection pending仍为业务成功；只读恢复UNKNOWN保留原key。
- RED真实独立PG+自有平台HTTP进程，再正/负向验证：无需账号cookie的有效签名提交、无效token、缺/坏key、额外身份字段、类型校验、同key恢复/改正文冲突、max1不同key并发、来源不信代理头、真实HTTP回复丢失后的原key只读恢复、未知路径不落运行时、JSON/体积边界、cache头。
- 不自动部署或启用现有试点；私有准入仍默认关闭。HTTP通过后仍须完成可信存量切换/历史窗口、产品签发和访客UI、真实浏览器，才能评估S9关闭。

## 批次34结果

已接两个POST端点，业务成功返回201及原key；receipt返回COMMITTED/UNKNOWN或当前授权拒绝，两个入口均在登录门/DSH代理前处理。严格JSON对象、允许字段白名单、64KiB、Idempotency-Key、query拒绝、真实TCP来源与私有缓存头已实测。cookie/Bearer不能替代链接能力，X-Forwarded-For/X-Real-IP不能扩大或改变source；来源为IPv4映射IPv6时统一成IPv4地址。

独立复核发现header=null的畸形token误500，以及带真实有效浏览器cookie的WebSocket Upgrade能把visitor路径转发到runtime。两条真实HTTP反例先RED；验签现在检查header/body对象及typ，升级处理器解析pathname后对所有平台owned路径拒绝转发，普通runtime /socket升级仍有实际101正向对照。

15项专测全部通过：匿名签名写入及原key读取、命名空间归属、无效签名/缺key、身份和source额外字段拒绝、实际已发布模型原生类型校验、原key重放/正文冲突、max1不同key并发、来源头不受信任、JSON/体积/query/method及cache边界、真实HTTP代理吞掉已提交回复后只读恢复、UNKNOWN原key、关闭切换门禁无业务效果、畸形token、原始Upgrade不转发。完整平台746项：745通过、1既有跳过、0失败。自有平台/上游/吞回复代理均结束，runner确认隔离PG停止。没有签发/分享产品界面、访客表单页或浏览器证据，不关闭S9。
