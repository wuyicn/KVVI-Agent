# 员工会话修复与本地联测

业主已批准先修后测。范围：完整返回平台已授权的数据、可靠匹配系统名称与编码、简短业务回复；不扩大权限，不自动写业务记录。

## 执行清单

- [x] 在独立 fork-fix / codex/employee-conversation 中增加真实 Loader→工具结果回归，先记录失败。
- [x] 修复结果渲染，增加公司系统目录只读工具，更新员工提示与配套文档。
- [x] 针对测试、构建、只读独立审查；保存镜像并重建核验。
- [x] 同步已验证源码与产物，更新本地试点并用真实模型只读复测，交给业主测试。

## 记录

- BASE：外层 9a8bb26；fork 22407d2。复用前轮隔离 clone，主工作区运行服务保持原状态至验证后。
- Ruling：系统定位复用现有公司范围 GET /systems，仅返回 name/assetId；目录不等于读写授权，记录与字段继续由原端点判断。
- Ruling：界面上的模型/缓存/上下文等高级控件本轮暂不改，先处理会话根因；运行性能以真实复测区分调用数量、模型等待及用户确认等待。
- Ruling：真实试点仅查数据，写入/版本/流程回归使用隔离 HTTP 夹具；保留原会话。

- Task 1：新增 13 条真实 Loader→签名 HTTP→工具 content 回归，初跑 9 failed / 4 passed（七个渲染丢信息、目录缺失、工具生命周期清单缺失）。夹具 record_list 最初错误嵌入详情 fieldVisibility，按实际列表契约修正，不改产品 schema。
- Task 2：32 条工具测试（含新增13）+ 6条 preset shipped-root 均通过；完整 build exit 0，修正测试的 exactOptionalPropertyTypes 声明；最后人类可读工具卡标题改动后 host build exit 0。
- Task 2：新增 keyless authored 会话（复用实际员工 persona，真实 CLI/Loader/HTTP/工具管线），built refresh 后 replay 4/4（场景+pin/输入/监听guard）。对实际工具结果及单调用追加独立断言，不能以固定模型回复掩盖工具失败。
- Ruling：source 模式新场景失败 Cannot read properties of undefined (reading prepare)；同环境既有 bash-tool-turn 对照同错。实际试点使用 built 入口，采用 built replay 验证本轮；不把 source 对照失败记为本轮绿灯，不扩大修复范围。

- Task 3：fork 提交 11ea6c2，经 staged lint/whitespace/vendor manifest；原工作区同一提交完整构建 exit 0。同步 fetch 返回 0，但历史坏对象 ref 给诊断；未改无关旧 refs。
- Live（首轮）：staff-view 新会话问可填信息，目录+字段 2 次调用，界面7秒，中文字段/必填/枚举完整；同会话按记录号读取，1次调用，界面3秒，四项真实值可见，无技术解释。仅读取，无业务写入。
- Ruling：真实记录回复末尾多了一句只读权限说明，不影响用户的读请求；继续收紧 persona 成功读取不附权限说明（已观察到 UX 反例），显式刷新本场景prompt金标准，4/4 replay + 38/38 针对测试再次通过。
- Task 3：最终 fork bb090de / tree a2babd530e93fd33f81d7730b1ee36349c99e008；原工作区再次完整构建 exit 0（代码与产物均为最终版本）。G2 146路径/36登记，export 138 在场+8删除，最终独立rebuild/verify通过。

- Independent review：发现并关闭 Important（HIDDEN 字段名称经 visibility map 泄露至模型）。真实字符串 visibility 夹具补两种 record tool 反例，先红2/13；canonical value 层过滤后绿，最终业务34+preset6+mode11=51/51。保留 MASKED/READONLY/VISIBLE、版本、签名和单调用；平台其他调用方的 visibility 元信息不在本次修复范围。
- Final verification：fork 6d0052f / tree eb23cba401ac49457a2b8a1391dd6a81d47587f5；两处完整构建 exit0，built 新场景及守卫4/4；G2 146/36、138在场+8删除，独立重建/verify通过。正常提交钩子全部通过，无推送或主干合并。
- Live（中轮）：字段2次/6秒；记录1次/108秒、简短四行结果。会话事件表明 tool/call→result 38ms，后续模型流 TRANSPORT 中断，约100秒后重试1次；不把该等待归于工具，不承诺所有轮次秒回。记录无实际联系方式，仅保存脱敏计时摘要。

- Final live：更新并重启本地试点6d0052f，新会话 staff-view 字段2次调用/6秒、记录1次/4秒，四项业务结果完整；无技术解释、权限尾句或额外新建邀请。实际会话包含最终persona结束规则，无业务写入，保留旧会话；最终字段截图与脱敏计时已保存，供业主接续测试。
