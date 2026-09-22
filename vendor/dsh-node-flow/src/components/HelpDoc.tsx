/**
 * Usage / help + AI authoring guide for dsh-node-flow.
 *
 * @module components/HelpDoc
 */

import { useEffect, type ReactNode } from 'react'

function Note({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="wf-helpdoc__note">
      <strong>{title}：</strong>
      <span>{children}</span>
    </div>
  )
}

function Warn({ children }: { children: ReactNode }) {
  return <div className="wf-helpdoc__warn">⚠️ {children}</div>
}

function Code({ children }: { children: string }) {
  return <pre className="wf-helpdoc__code">{children}</pre>
}

function THead({ cols }: { cols: string[] }) {
  return (
    <thead>
      <tr>
        {cols.map((c, i) => (
          <th key={i}>{c}</th>
        ))}
      </tr>
    </thead>
  )
}

export function HelpDoc({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return (
    <div className="wf-helpdoc" role="dialog" aria-modal="true" aria-label="生成工作流指南">
      <div className="wf-helpdoc__head">
        <div className="wf-helpdoc__title">工作流生成指南（给 AI / 使用者）</div>
        <button className="wf-helpdoc__close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      <div className="wf-helpdoc__body">
        {/* ---------- 0 快速认识 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>0. 快速认识</h2>
          <p>
            这是一个 <strong>n8n 风格的可视化工作流画布</strong>。工作流 = <b>一批节点</b> + <b>一批连线</b>。数据沿着连线流动：每个节点读取上游结果（变量{' '}
            <code>result</code>）、处理、把结果交给下游。画布手动点 <b>▶ 运行</b> 走「图遍历」；定时任务走宿主的图遍历执行器（行为一致）。
          </p>
          <Note title="给 AI">
            你能直接生成一个 JSON 工作流文档（下面数据结构），或按本文逐节点属性把用户要的流程拼出来。所有 <code>sourceHandle</code>/{' '}
            <code>targetHandle</code> 必须用文档里给的<b>精确字符串</b>，否则连线不生效。
          </Note>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.1 字段映射与样本数据</h2>
          <p>
            HTTP、Agent、Output 和流程控制节点的可映射字段右侧提供 <b>映射</b> 按钮。先在测试输入中粘贴 JSON，或先运行上游节点，再从字段树点击或拖拽字段到当前光标。
          </p>
          <Code>{`模板字段：{{result.user.id}}、{{result.items[0].sku}}
表达式字段：result.user.active、result.items`}</Code>
          <Note title="样本与运行时">
            字段树中的值只用于预览结构；真正运行时，<code>result</code> 始终代表当前节点收到的上游输出。节点测试样本保存在浏览器本地，不进入工作流 JSON 和发布快照。
          </Note>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.1.1 手动运行输入</h2>
          <p>
            在更多操作的 <b>输入 / 输出契约</b> 中声明输入字段后，手动点击运行会先显示类型化输入表单。文本、数字、布尔值、对象、数组和任意 JSON 会在浏览器中先校验，宿主也会在创建运行记录、排队或保存重放快照前再次校验。
          </p>
          <Note title="草稿与发布">
            已启用工作流的手动运行固定使用已发布快照及其输入契约；继续编辑的草稿不会改变生产运行。未启用工作流使用当前草稿契约，便于预览。
          </Note>
          <Warn>运行输入不要包含密码、Token、Cookie、API Key 或项目 Secret。它们应通过“连接”或项目 Secret 注入；敏感输入不会成为可重放输入。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.1.2 运行策略与执行预算</h2>
          <p>
            在编辑器的 <b>更多操作 → 运行策略</b> 中配置根运行并发、最长运行时间和最大执行步数。并发可以允许并行、超过上限时跳过，或将触发请求持久排队；排队运行保留提交时的工作流快照。
          </p>
          <p>
            最长运行时间按活动执行的墙钟时间计算，最大执行步数按节点访问次数计算，循环迭代也会计入。时间上限最多 86400 秒，步骤上限最多 100000 次；留空时间表示不限制，留空步骤使用默认上限。
          </p>
          <Note title="超限与恢复">
            达到预算后运行会标记为“已超限”，并区分“超过运行时限”和“超过执行步数”。服务端保存冻结快照、当前节点输入和 checkpoint；若运行只有一个合法失败点，运行中心会提供“从失败处恢复”。恢复运行重新使用该快照的预算，不会把之前的步骤数累计进去。
          </Note>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.2 HTTP 连接与 OAuth2</h2>
          <p>
            HTTP 节点引用的是主页 <b>连接</b> 中保存的连接 ID，工作流 JSON 不包含密钥。支持 Bearer Token、API Key、Basic Auth 与 OAuth2 Authorization Code；Webhook Secret 专用于入站 HMAC-SHA256 验签。
          </p>
          <Note title="OAuth2 授权步骤">
            新建 OAuth2 连接后，把界面显示的回调 URL 登记到服务商应用；填写授权 URL、Token URL、Client ID/Secret 和 Scopes，再点击“保存并授权”。默认启用 PKCE S256。
          </Note>
          <p>
            Access Token 到期前会自动刷新；若服务商提前返回 <code>401</code>，HTTP 节点会刷新 Token 并只重试一次。连接测试向指定 HTTPS URL发送 <code>GET</code>，只保存健康状态，不保存响应正文。
          </p>
          <Warn>
            授权、Token 和测试 URL必须使用 HTTPS，本机回环地址除外。额外 OAuth2 参数只填写非敏感配置，不要放密码、Token 或私钥。
          </Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.3 Webhook 安全与响应</h2>
          <p>Webhook URL 中的 token 用于定位已发布入口。需要验证调用方时，在主页“连接”中新建 Webhook Secret，并在节点中选择签名 Header。</p>
          <Code>{`signature = HMAC-SHA256(secret, rawRequestBody)
Header: x-dsh-signature-256: sha256=<hex>`}</Code>
          <Note title="签名边界">
            服务端在 JSON 解析和工作流执行前校验原始请求体。签名错误返回 <code>401</code>，不产生运行记录；Secret、签名 Header、认证头和 Cookie 都不会进入下游输入或运行历史。
          </Note>
          <p>成功响应可选择运行摘要 JSON、直接输出，或配置自定义状态码、Headers 和 <code>{'{{result.path}}'}</code> Body 模板。执行失败固定返回 <code>500</code>。</p>
          <p>需要抵御服务商重复投递时，可配置幂等键 Header（例如 <code>Idempotency-Key</code>）。相同工作流、节点、请求方法、幂等键和请求体会在保留期内复用第一次响应；相同键但请求内容不同返回 <code>409</code>，仍在执行中的重复请求也返回 <code>409</code>。缓存响应在主机侧加密保存，保留期为 60 秒到 7 天。</p>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.4 应用连接器</h2>
          <p>“应用连接器”节点提供 GitHub、Slack、Notion、Google Sheets、Gmail、OpenAI、DeepSeek、Jira 等 16 个内置应用。先选应用和动作，再选择主页中保存的连接，并填写动作字段。</p>
          <Note title="字段映射与安全边界">
            动作字段支持 <code>{'{{result.user.id}}'}</code> 等映射。服务端只按注册表中的固定域名与 HTTP 方法发送请求，工作流不能把连接器改成任意 URL；密钥仍只存在主机加密凭据库中。
          </Note>
          <Note title="版本固定与动态选项">
            每个连接器节点会保存精确的 <code>connectorVersion</code>。新版本可与旧版本并存，只有用户显式点击升级才会切换；旧工作流、版本快照、等待运行和定时快照不会静默漂移。部分字段可通过当前加密连接动态加载选项，例如 Slack 频道，同时保留手工 ID 与字段映射。
          </Note>
          <Note title="执行可靠性">
            连接器复用 HTTP 节点的超时、取消、失败重试、检查点和 OAuth2 自动刷新。创建 Issue、发送消息、写入表格等操作具有外部副作用，启用重试时应优先使用服务商支持的幂等键或业务去重字段。
          </Note>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.5 持久 Waitpoint</h2>
          <p>Wait 节点支持延迟、外部回调和人工审批。运行进入等待后会把工作流快照和已完成节点结果写入宿主存储，并释放执行资源；宿主重启后仍会继续调度。</p>
          <Code>{`外部回调：POST /dsh-node-flow/waitpoint-callback
Header: x-dsh-wait-token: <一次性 token>
Body: 后续节点需要的 JSON 或文本`}</Code>
          <Note title="单次消费">
            回调 Token 只在运行中心显式生成时显示一次，磁盘只保存 SHA-256 摘要。审批和回调通过原子领取恢复，同一 Waitpoint 只能成功处理一次。
          </Note>
          <Warn>Wait 不能放进 Loop / While 迭代体；含 Wait 的流程只能有一个触发入口，Wait 前不要使用普通节点并行扇出。</Warn>
          <Note title="子工作流等待">
            子工作流可以包含 Wait。子流程进入等待后，父流程会持久化为 <code>child</code> 等待状态并释放执行资源；子流程恢复、失败或取消后，父流程从调用节点的下游继续一次，不会重复调用子流程。嵌套调用仍固定使用发布快照，并受递归和最大深度限制。
          </Note>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.6 应用事件触发</h2>
          <p>“应用触发器”按 15 秒到 24 小时的间隔轮询已声明事件。当前支持 GitHub 新 Issue、Slack 新消息、Todoist 新任务、Stripe 新事件和 Asana 新项目任务。</p>
          <Note title="基线与去重">
            首次成功轮询只建立已有事件基线，不回放历史数据；之后每个新事件生成独立持久运行。同一响应中的重复键只执行一次，更换连接、项目、频道或事件后会重新建立基线。
          </Note>
          <Note title="持久状态边界">
            宿主只保存调度时间、配置摘要、游标、最近事件键和脱敏错误。API 与 UI 不返回游标、事件键、领取状态、配置摘要或凭据；失败后至少退避 60 秒。
          </Note>
          <Warn>轮询采用至少一次语义。宿主在事件执行后、去重状态提交前异常退出时可能重复投递，包含外部写操作的下游节点应使用幂等键。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.7 项目变量与 Secret</h2>
          <p>主页“变量”集中保存环境地址、功能开关和 Secret。模板字段使用 <code>{'{{vars.API_HOST}}'}</code>，表达式字段使用 <code>vars.ENABLED</code>；字段映射器的“项目变量”来源可以直接插入引用。</p>
          <Code>{`TypeScript: const vars = await dsh.vars()
Python: json.loads(os.environ.get('DSH_VARS', '{}'))`}</Code>
          <Note title="安全边界">普通值可进入所有模板。Secret 只允许在主机侧 Code、HTTP 和 Connector 中解析，不会返回浏览器；Agent、子工作流输入、Output、Webhook 响应和 Wait 超时输出引用 Secret 时会被拒绝。</Note>
          <Warn>运行记录、最终输出、错误和 API 响应会自动把 Secret 原文替换为 <code>[secret]</code>。如果外部系统需要认证，优先使用“连接”而不是把长期 Token 作为项目变量。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.7.1 Data Store</h2>
          <p>Data Store 节点在 DSH 主机上持久保存工作流状态，提供读取、写入、删除和按前缀列出四种操作。数据文件与独立密钥使用 AES-256-GCM 加密，工作流和命名空间彼此隔离。</p>
          <Code>{`操作：get / set / delete / list
键模板：customer:{{result.id}}
值模板：{"status":"{{result.status}}"}
列表前缀：customer:`}</Code>
          <Note title="安全边界">Data Store 值不进入工作流 JSON、浏览器缓存或运行输入；运行记录只保留脱敏后的节点结果。节点必须先保存工作流，启用前还要通过发布校验。</Note>
          <Warn>单个值最多 256 KB，键最多 256 个字符，主机最多保存 10000 个键。Data Store 适合游标、去重键和小型状态，不替代业务数据库。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.8 运行详情与重放</h2>
          <p>主页“运行记录”先显示轻量摘要；点击“详情”才读取节点输入、输出、日志、错误和重试次数。详情不会返回工作流快照、队列载荷、恢复检查点或可重放输入。</p>
          <Note title="不可变重放">
            只有安全输入的已结束手动运行可以重放。重放固定使用当时保存的工作流与子工作流快照，不读取当前草稿；所有外部写操作会再次执行，所以需要明确确认并为下游系统提供幂等键。
          </Note>
          <Warn>输入中含 Token、Authorization、Cookie、Password、Secret 或 API Key 等认证字段时，不会保存为可重放输入，运行详情仍可用于排障。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.9 断点调试</h2>
          <p>在可执行节点的检查器中打开“调试断点”，点击编辑器顶部“调试”后，当前草稿会在断点执行前持久暂停。运行面板提供“继续”“单步”和“结束调试”控制。</p>
          <Note title="调试范围">调试 v1 只接受一个手动 Trigger 和一条线性路径，不支持 Webhook、定时、应用触发器、Wait、条件、循环、扇出或错误分支。调试执行的是当前草稿，不会改变已发布版本。</Note>
          <Warn>调试输入会持久化到暂停状态，因此包含密码、Token、Cookie、API Key 或项目 Secret 的输入会在启动前拒绝。外部副作用节点可能在单步前已经执行，请为写操作配置幂等键。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.10 审计日志</h2>
          <p>主页“审计日志”记录工作流、文件夹、连接、变量、运行与人工审批的控制面操作。可按对象筛选，并用操作名称、目标名称或 ID 搜索最近记录。</p>
          <Note title="记录范围">
            创建、发布、停用、删除、版本恢复、文件夹创建/重命名/删除迁移、工作流移动、连接和变量变更、手动启动、取消、恢复、重放，以及人工审批结果都会留下有界记录。日志只保留最近 1000 条并由 DSH 主机写入，浏览器不会保存副本。
          </Note>
          <Warn>审计日志不是运行详情。它不会保存输入、请求或响应正文、Header、代码、Prompt、输出、日志、堆栈、凭据、Token、密码、Secret 或审批备注；需要排障时使用“运行记录”的按需详情。</Warn>
        </section>

        <section className="wf-helpdoc__section">
          <h2>0.11 文件夹组织</h2>
          <p>主页左侧文件夹用于归类和筛选工作流。可在当前文件夹中创建工作流或模板，也可以从工作流行的“移动到文件夹”操作调整归属。</p>
          <Note title="控制面元数据">
            文件夹归属不在工作流图中，不会改变草稿内容、已发布快照、正在执行的运行、恢复检查点或版本历史。移动只更新工作流列表的归属与控制面版本，生产运行继续使用原有不可变快照。
          </Note>
          <Warn>删除文件夹时必须把其中工作流迁移到另一个文件夹或“未分类”。先同步本地草稿再移动或删除，避免旧浏览器缓存把已更新的归属覆盖回服务端。</Warn>
        </section>

        {/* ---------- 1 数据结构 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>1. 工作流数据结构（JSON）</h2>
          <p>一份文档包含 <code>version</code>、<code>name</code>、<code>nodes[]</code>、<code>edges[]</code>。</p>
          <Code>{`{
  "version": 1,
  "name": "我的工作流",
  "description": "可选",
  "nodes": [
    { "id": "t1", "type": "workflow", "position": { "x": 40, "y": 200 },
      "data": { "kind": "trigger", "label": "入口", "text": "任务内容" },
      "style": { "width": 124, "height": 124 } }
  ],
  "edges": [ { "id": "e1", "source": "t1", "target": "c1" } ]
}`}</Code>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '说明']} />
            <tbody>
              <tr><td><code>version</code></td><td>固定为 <code>1</code>。</td></tr>
              <tr><td><code>name</code></td><td>工作流名，会显示在顶部和定时任务里。</td></tr>
              <tr><td><code>nodes[]</code></td><td>节点数组，每个见下方「节点结构」。</td></tr>
              <tr><td><code>edges[]</code></td><td>连线数组，见「连线规则」。</td></tr>
            </tbody>
          </table>
          <h3>节点结构</h3>
          <Code>{`{
  "id": "唯一id",              // 必须唯一，line/edges 靠它引用
  "type": "workflow",          // 固定
  "position": { "x": 0, "y": 0 },  // 画布坐标，x 越大越靠右
  "data": { "kind": "触发器", "label": "显示名", ... },
  "style": { "width": 124, "height": 124 }  // 按类型对应尺寸
}`}</Code>
          <Warn>
            文档不需要 <code>selected</code> / <code>measured</code> 这些 React Flow 运行时字段，生成了也无妨，但<b>省略即可</b>。<code>style</code> 的宽高按下方「节点尺寸」给，否则连接点会偏。
          </Warn>
          <h3>节点尺寸（style.width/height）</h3>
          <Code>{`trigger/schedule: 224×76
webhook/agent/call-workflow/connector/data-store/wait/code/http/output: 224×82
if: 224×96; switch: 224×124; loop/while: 224×104
note: 240×116`}</Code>
        </section>

        {/* ---------- 2 通用 data 字段 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>2. 通用 <code>data</code> 字段</h2>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '类型', '必填', '作用 / 怎么填']} />
            <tbody>
              <tr><td><code>kind</code></td><td>string</td><td>是</td><td>节点类型，见下。决定这个节点干什么。</td></tr>
              <tr><td><code>label</code></td><td>string</td><td>是</td><td>画布上显示的名字，填一句话。</td></tr>
              <tr><td><code>model</code></td><td>string</td><td>否</td><td>仅 agent：<code>"provider|modelId"</code>，空/缺省 = 沿用当前会话模型。</td></tr>
              <tr><td><code>timeout</code></td><td>string(秒)</td><td>否</td><td>code/agent/http：单次尝试的超时秒数，如 <code>"30"</code>。</td></tr>
              <tr><td><code>onError</code></td><td>string</td><td>否</td><td>code/agent/http/connector/call-workflow：<code>"stop"</code>(默认)、<code>"continue"</code>(失败后传空值) 或 <code>"route"</code>(重试耗尽后走红色 error 端口)。</td></tr>
              <tr><td><code>retryCount</code></td><td>string</td><td>否</td><td>失败后的重试次数，范围 0–10，不包含首次执行。</td></tr>
              <tr><td><code>retryDelay</code></td><td>string(秒)</td><td>否</td><td>第一次重试前的等待时间。</td></tr>
              <tr><td><code>retryBackoff</code></td><td>string</td><td>否</td><td><code>"fixed"</code> 固定间隔，或 <code>"exponential"</code> 指数退避。</td></tr>
              <tr><td><code>notes</code></td><td>string</td><td>否</td><td>备注，不参与执行。</td></tr>
            </tbody>
          </table>
        </section>

        {/* ---------- 3 节点详解 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>3. 每类节点详解（属性怎么填）</h2>

          <h3>3.1 触发器 trigger</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>text</code></td><td>流程入口内容，会作为下游第一个节点的输入。</td><td><code>"请总结AI热点"</code></td></tr>
            </tbody>
          </table>
          <p>只有一个右侧输出口，连到下一个节点的左侧输入口。</p>

          <h3>3.2 定时触发 schedule</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>cron</code></td><td>5 段 cron（分 时 日 月 周），到点由宿主后台执行整条流程。</td><td><code>"30 8 * * *"</code> = 每天08:30</td></tr>
              <tr><td><code>timezone</code></td><td>IANA 时区，预留（当前按宿主本地时区匹配）。</td><td><code>"Asia/Shanghai"</code></td></tr>
              <tr><td><code>text</code></td><td>任务文字，作为流程输入（可选）。</td><td><code>"抓取新闻"</code></td></tr>
            </tbody>
          </table>

          <h3>3.3 应用触发器 connector-trigger</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>connectorId</code></td><td>声明了轮询事件的应用 ID。</td><td><code>"github"</code></td></tr>
              <tr><td><code>connectorVersion</code></td><td>精确连接器版本；发布、运行和轮询基线都按此版本解析。</td><td><code>1</code></td></tr>
              <tr><td><code>connectorTrigger</code></td><td>应用事件 ID。</td><td><code>"new-issue"</code></td></tr>
              <tr><td><code>credentialId</code></td><td>主页加密连接的引用 ID。</td><td><code>"credential-..."</code></td></tr>
              <tr><td><code>pollInterval</code></td><td>轮询秒数，范围 15–86400。</td><td><code>"60"</code></td></tr>
            </tbody>
          </table>
          <p>用户点「保存定时」后到「定时任务」看板管理。cron 校验：<code>分0-59 时0-23 日1-31 月1-12 周0-6</code>。</p>

          <h3>3.4 Agent agent</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>prompt</code></td><td>发给子代理的 system prompt，会拼在「上游输入」之后一起发。</td><td><code>"请总结成一句话"</code></td></tr>
              <tr><td><code>model</code></td><td>模型路由 <code>provider|modelId</code>；缺省=继承。</td><td><code>"deepseek-official|deepseek-chat"</code></td></tr>
              <tr><td><code>timeout</code>/<code>onError</code></td><td>同通用字段。</td><td><code>"60"</code> / <code>"stop"</code></td></tr>
            </tbody>
          </table>
          <Note title="模型从哪来">
            模型下拉数据来自宿主 <code>/models</code>（<code>ctx.llm</code>）。让 AI 别硬编码模型名；要么留空继承、要么用真实存在的 <code>provider|modelId</code>。
          </Note>
          <Note title="子代理能力与记忆">
            Agent 节点会启动一个 <b>真实的 DSH 子代理</b>，它拥有<b>你在 DSH 里的全部能力</b>（各种工具、联网、web 搜索、文件操作等），并继承当前工作区/上下文。
            但注意：<b>子代理不带父代理的对话记忆/上下文</b>——每次只拿到「上游输入 + 你填的 system prompt」。如果需要带上下文/记忆，让 AI 用 <b>code 节点</b> 把关键信息拼进输入传给子代理即可（code 节点什么都能做）。
          </Note>

          <h3>3.5 代码执行 code</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>language</code></td><td>类型 <code>"typescript"</code>(默认) 或 <code>"python"</code>。</td><td><code>"python"</code></td></tr>
              <tr><td><code>code</code></td><td>源码。TypeScript 用 <code>return</code> 返回结果；Python 用 <code>print</code> 输出结果。</td><td>见下</td></tr>
              <tr><td><code>timeout</code>/<code>onError</code></td><td>同通用字段。</td><td><code>"30"</code> / <code>"continue"</code></td></tr>
            </tbody>
          </table>
          <Code>{`// TypeScript：读上游输入
const it = await dsh.input(null)      // 注意必须传参数，写 null
return JSON.stringify({ item: it })`}</Code>
          <Code>{`# Python：读上游输入（环境变量）
import os
s = os.environ.get('DSH_INPUT', '')
print('got:', s)`}</Code>
          <Warn>
            <code>dsh.input()</code> 不带参数会报「binding arguments must be lossless JSON」，<b>必须写</b>{' '}
            <code>await dsh.input(null)</code>。Python 结果通过 stdout 返回；TypeScript 通过 <code>return</code> 返回。
          </Warn>
          <Note title="失败重试、错误分支与恢复点">
            Code、Agent、HTTP、应用连接器和子工作流调用可以配置失败重试。重试全部耗尽后，<code>onError:"route"</code> 会从节点右侧红色 <code>error</code> 端口进入专门的处理分支；<code>stop</code> 保留恢复点，<code>continue</code> 则将空值传给普通下游。
            错误分支只收到脱敏的固定事件：<code>{'{ type: "workflow-node-error", error: { message, nodeId, nodeLabel, nodeKind, attempts, occurredAt } }'}</code>。它不包含上游输入、HTTP 响应体、凭据或堆栈。该节点仍会标为失败，但根运行状态为“错误已处理”，不会产生恢复点；错误分支内的外部写操作同样应使用幂等键。
          </Note>
          <Note title="版本历史与回滚">
            主页工作流行提供版本历史入口。每次创建、保存草稿、发布、停用和回滚都会生成完整快照，可比较任意两个版本的节点、连接、名称与描述变化。“恢复为草稿”保留当前线上快照；“恢复并发布”会立即部署历史图。回滚不会删除后续版本，而是产生新的恢复版本。
          </Note>

          <h3>3.5.1 Data Store data-store</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>storeNamespace</code></td><td>工作流内的隔离命名空间，只允许字母、数字、点、下划线、冒号和短横线。</td><td><code>orders</code></td></tr>
              <tr><td><code>storeOperation</code></td><td><code>get</code>、<code>set</code>、<code>delete</code> 或 <code>list</code>。</td><td><code>set</code></td></tr>
              <tr><td><code>storeKey</code></td><td>get、set、delete 使用的键；支持 <code>{'{{result.path}}'}</code> 和 <code>{'{{vars.NAME}}'}</code>。</td><td><code>customer:42</code></td></tr>
              <tr><td><code>storeValue</code></td><td>仅 set 使用；模板渲染后优先解析为 JSON，再以 AES-256-GCM 加密保存。</td><td>JSON 模板</td></tr>
              <tr><td><code>storePrefix</code></td><td>仅 list 使用；返回当前工作流和命名空间内、以此前缀开头的键。</td><td><code>customer:</code></td></tr>
            </tbody>
          </table>
          <Note title="运行边界">Data Store 必须在已保存的工作流中运行；删除工作流时该工作流的存储记录会一起清理。它适合游标、去重键和小型状态，不提供跨工作流查询，也不替代业务数据库。</Note>

          <h3>3.6 输出 output</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>template</code></td><td>展示模板。用 <code>{'{{result}}'}</code> 引用上游结果；留空=直接显示结果。</td><td><code>"结果: {'{{result}}'}"</code></td></tr>
            </tbody>
          </table>

          <h3>3.7 If if（布尔分流）</h3>
          <p><code>condition</code> 是一个<b>布尔表达式</b>，变量 <code>result</code> = 上游输出。为真走 <code>true</code> 口，为假走 <code>false</code> 口。</p>
          <Note title="为什么表达式要这么写">
            <code>result</code> <b>永远是字符串</b>（上游节点的输出被序列化成文本）。所以要比较数字得先 <code>Number()</code>，要读 JSON 字段得先 <code>JSON.parse()</code>，要判断文本直接用字符串方法。
          </Note>
          <p>常见四种写法（按上游 result 的类型选）：</p>
          <Code>{`// 上游是数字字符串，如 "15" → 用 Number()
Number(result) > 10            // true

// 上游是 JSON 对象字符串，如 {"n":15} → 先 parse 再取字段
Number(JSON.parse(result).n) > 10

// 上游是 agent 输出的一段文本 → 直接字符串方法
result.includes("AI")          // 判断文本里是否含 "AI"

// 上游是 JSON，想按取值精确判断
JSON.parse(result).code === 0  // 天气 code 是否为 0（晴）`}</Code>
          <table className="wf-helpdoc__table">
            <THead cols={['上游 result', '推荐 condition', '为什么']} />
            <tbody>
              <tr><td><code>"15"</code></td><td><code>Number(result) &gt; 10</code></td><td>字符串不能直接比较大小，先转数字。</td></tr>
              <tr><td><code>{'{"n":15}'}</code></td><td><code>Number(JSON.parse(result).n) &gt; 10</code></td><td>先解析成对象，再取字段。</td></tr>
              <tr><td><code>"AI 又升级了"</code></td><td><code>result.includes("AI")</code></td><td>文本判断，直接用字符串方法。</td></tr>
              <tr><td><code>{'{"code":0}'}</code></td><td><code>JSON.parse(result).code === 0</code></td><td>取值做精确比较。</td></tr>
            </tbody>
          </table>
          <p>输出口：<code>true</code>（上）/ <code>false</code>（下）。表达式必须返回布尔值。</p>

          <h3>3.8 Switch switch（多路分流）</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>condition</code></td><td>取值表达式，<code>result</code> = 上游输出，其值用于匹配 case。</td><td><code>result</code></td></tr>
              <tr><td><code>cases</code></td><td>逗号分隔的 case 值，每个对应一个输出口。</td><td><code>"morning, afternoon, evening"</code></td></tr>
            </tbody>
          </table>
          <p>输出口：每个 case + 一个 <code>default</code>（兜底）。不匹配任何 case 走 <code>default</code>。</p>
          <Warn>
            case 是<b>全等字符串</b>比较：switch 会把 <code>condition</code> 算出来的值 <code>String()</code> 后与 case 逐一全等。所以上游值必须和 case 完全一致（如 <code>morning</code> 不能是 <code>Morning</code>）。
          </Warn>

          <h3>3.9 Loop loop（遍历 / 重复）</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>mode</code></td><td><code>"items"</code>(默认, 遍历数组) 或 <code>"count"</code>(固定次数)。</td><td><code>"items"</code></td></tr>
              <tr><td><code>itemsExpr</code></td><td>mode=items 时，从 <code>result</code> 求数组的表达式。</td><td><code>JSON.parse(result)</code></td></tr>
              <tr><td><code>count</code></td><td>mode=count 时的次数（字符串）。</td><td><code>"5"</code></td></tr>
              <tr><td><code>maxIters</code></td><td>硬上限，默认 100，防死循环。</td><td><code>"100"</code></td></tr>
              <tr><td><code>collect</code></td><td>布尔。开=把每轮结果收集成数组交给 <code>done</code>；关=只留最后一轮。</td><td>true</td></tr>
            </tbody>
          </table>
          <p>
            端口：<b>iterate</b>（进 body）、<b>done</b>（全部跑完接后续）、左侧 <b>in</b>（首次进入）、<b>back</b>（body 尾端连回，供迭代回流）。
          </p>
          <Warn>
            loop 只对 <b>body 子图</b>（从 <code>iterate</code> 出发、直到连回 <code>back</code> 的那段）重复执行。把 body 最后一个节点连回 loop 的 <code>back</code> 口，结果才算「本轮返回值」；不连回则会用 body 最后一个节点的输出作为本轮结果。
          </Warn>

          <h3>3.10 While while（条件循环）</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>condition</code></td><td>每轮开始判断，<code>result</code> = 当前累积值；为真继续，为假结束。</td><td><code>result !== "完成"</code></td></tr>
              <tr><td><code>maxIters</code></td><td>硬上限，默认 100。</td><td><code>"100"</code></td></tr>
              <tr><td><code>collect</code></td><td>布尔。开=收集每轮结果成数组。</td><td>true</td></tr>
            </tbody>
          </table>
          <Note title="条件别用数字">
            用字符串/内容判断更稳（如 <code>result !== "完成"</code>）。body 每次改变 <code>result</code>，直到条件为假。
          </Note>

          <h3>3.11 等待 wait</h3>
          <table className="wf-helpdoc__table">
            <THead cols={['字段', '作用', '示例']} />
            <tbody>
              <tr><td><code>waitMode</code></td><td><code>delay</code>、<code>callback</code> 或 <code>approval</code>。</td><td><code>"callback"</code></td></tr>
              <tr><td><code>waitAmount</code>/<code>waitUnit</code></td><td>延迟数值与 <code>seconds/minutes/hours/days</code> 单位。</td><td><code>"5"</code> / <code>"minutes"</code></td></tr>
              <tr><td><code>waitTimeout</code></td><td>回调或审批的可选超时小时数。</td><td><code>"24"</code></td></tr>
              <tr><td><code>waitTimeoutValue</code></td><td>超时后交给下游的模板。</td><td><code>{'{"timedOut":true}'}</code></td></tr>
            </tbody>
          </table>

          <h3>3.12 备注 note</h3>
          <p>纯注释（<code>text</code> 字段），<b>没有连接口</b>，不参与执行。仅 <code>kind:'note'</code> 用 <code>text</code> 存内容，尺寸 240×116。</p>

        </section>

        {/* ---------- 4 连线规则 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>4. 连线规则（source / target + handle）</h2>
          <table className="wf-helpdoc__table">
            <THead cols={['源节点', 'sourceHandle', 'targetHandle', '说明']} />
            <tbody>
              <tr><td>trigger/schedule/wait/code/agent/output/note</td><td>（无）</td><td>（无）</td><td>普通单进单出，直接 source→target。</td></tr>
              <tr><td>code/agent/http/connector/call-workflow（<code>onError:"route"</code>）</td><td><code>"error"</code></td><td>（无）</td><td>重试耗尽后使用红色端口；该连线不会参与正常成功扇出。</td></tr>
              <tr><td>if</td><td><code>"true"</code> 或 <code>"false"</code></td><td>（无）</td><td>按布尔走一路。</td></tr>
              <tr><td>switch</td><td>case 值 或 <code>"default"</code></td><td>（无）</td><td>按值匹配。</td></tr>
              <tr><td>loop / while</td><td><code>"iterate"</code> 或 <code>"done"</code></td><td><code>"in"</code>(首次进入) 或 <code>"back"</code>(body回流)</td><td>见循环端口说明。</td></tr>
            </tbody>
          </table>
          <Code>{`// 普通连线
{ "id": "e1", "source": "t1", "target": "c1" }
// if 的 true 分支
{ "id": "e2", "source": "i1", "target": "a1", "sourceHandle": "true" }
// 可执行节点的错误分支（先在节点中选择 onError:"route"）
{ "id": "e2-error", "source": "http1", "target": "notify1", "sourceHandle": "error" }
// loop: 进 body / body 回流 / 跑完接后续
{ "id": "e3", "source": "l1", "target": "b1", "sourceHandle": "iterate" }
{ "id": "e4", "source": "b1", "target": "l1", "targetHandle": "back" }
{ "id": "e5", "source": "l1", "target": "o1", "sourceHandle": "done" }`}</Code>
        </section>

        {/* ---------- 5 result 语义 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>5. result 变量与数据流</h2>
          <p>每个节点接收上游输出，那个值在表达式里叫 <code>result</code>：</p>
          <ul>
            <li>if/switch 的条件、loop 的 <code>itemsExpr</code>、while 的条件都读 <code>result</code>。</li>
            <li>上游是 JSON 对象字符串 → 用 <code>JSON.parse(result)</code>；是数字字符串 → <code>Number(result)</code>；是普通文本 → 直接字符串操作。</li>
            <li>代码节点读输入：TS <code>await dsh.input(null)</code>；Python <code>os.environ.get('DSH_INPUT')</code>。输出（TS return / Python print）会成为下游的 <code>result</code>。</li>
          </ul>
        </section>

        {/* ---------- 6 坑点清单 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>6. 坑点清单（务必遵守）</h2>
          <ol>
            <li><b>连线 handle 字符串必须精确</b>：if 用 <code>true/false</code>，switch 用 case 或 <code>default</code>，loop/while 用 <code>iterate/done</code> + <code>in/back</code>。</li>
            <li><b>代码读输入必须传参</b>：<code>await dsh.input(null)</code>，否则运行时抛错。</li>
            <li><b>switch 是字符串全等</b>，case 必须和上游值完全一致。</li>
            <li><b>loop/while 一定要设 <code>maxIters</code></b>（默认 100），否则可能死循环。</li>
            <li><b>可执行节点默认失败即停</b>。需要继续时设 <code>onError:"continue"</code>；需要独立补偿/通知时选 <code>onError:"route"</code> 并连接红色 <code>error</code> 端口。切回 stop/continue 后，已存在的 error 连线不会执行。</li>
            <li><b>model 别乱填</b>：格式 <code>provider|modelId</code>，留空 = 继承；否则用真实存在于 <code>/models</code> 的。</li>
            <li><b>节点 id 唯一</b>，边引用要一致；<code>type:"workflow"</code> 固定。</li>
            <li><b>定时任务</b>：存的是你保存那一刻的<b>工作流快照</b>（含分支/循环，宿主导入执行）；按<b>宿主本地时区</b>匹配；<b>宿主进程需存活</b>；<b>错过不补跑</b>。</li>
            <li><b>备注 note 无连接口</b>，别给它连线。</li>
            <li><b>Agent 需宿主有活父 agent</b> 才能委派，否则该步骤失败。</li>
          </ol>
        </section>

        {/* ---------- 7 完整示例 ---------- */}
        <section className="wf-helpdoc__section">
          <h2>7. 完整可复制示例（AI 可照此生成）</h2>
          <p>「定时抓 AI 热点 → 总结 → 输出」（含定时、Python 代码、Agent、输出）：</p>
          <Code>{`{
  "version": 1,
  "name": "定时AI热点简报",
  "nodes": [
    { "id": "s1", "type": "workflow", "position": { "x": 20, "y": 200 },
      "data": { "kind": "schedule", "label": "每日定时", "cron": "30 8 * * *", "text": "抓取今日AI热点并总结" },
      "style": { "width": 124, "height": 124 } },
    { "id": "c1", "type": "workflow", "position": { "x": 220, "y": 200 },
      "data": { "kind": "code", "label": "拉取热点", "language": "python",
        "code": "import json, urllib.request\\nreq = urllib.request.Request('https://aihot.virxact.com/api/v1/items?mode=selected&window=7d&limit=5', headers={'User-Agent':'aihot-skill/1.5.4'})\\nwith urllib.request.urlopen(req, timeout=20) as r:\\n    data = json.load(r)\\nprint('\\\\n'.join((it.get('title','') + ' ' + it.get('summary','')) for it in (data.get('items') or [])))",
        "timeout": "30" },
      "style": { "width": 124, "height": 124 } },
    { "id": "a1", "type": "workflow", "position": { "x": 440, "y": 200 },
      "data": { "kind": "agent", "label": "总结", "prompt": "把下面AI热点整理成简洁中文简报，按重要度排序" },
      "style": { "width": 212, "height": 128 } },
    { "id": "o1", "type": "workflow", "position": { "x": 720, "y": 200 },
      "data": { "kind": "output", "label": "简报", "template": "{{result}}" },
      "style": { "width": 124, "height": 124 } }
  ],
  "edges": [
    { "id": "e1", "source": "s1", "target": "c1" },
    { "id": "e2", "source": "c1", "target": "a1" },
    { "id": "e3", "source": "a1", "target": "o1" }
  ]
}`}</Code>
        </section>
      </div>
    </div>
  )
}
