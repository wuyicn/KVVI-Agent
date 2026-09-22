import { compact, connectorFields as field, defineConnector, formBody, jsonRequest, type ConnectorDefinition, type ConnectorFieldDefinition } from './connectorSdk.js'

function slackResponse(value: unknown): void {
  if (value && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok !== true) {
    const error = 'error' in value ? String((value as { error?: unknown }).error ?? 'unknown_error') : 'unknown_error'
    throw new Error(`Slack API 错误：${error}`)
  }
}

function listAt(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value
  if (!key || !value || typeof value !== 'object') return []
  const nested = (value as Record<string, unknown>)[key]
  return Array.isArray(nested) ? nested : []
}

function objectKey(item: unknown, key: string): string {
  if (!item || typeof item !== 'object') return ''
  const value = (item as Record<string, unknown>)[key]
  return value === undefined || value === null ? '' : String(value)
}

function hasObjectKey(item: unknown, key: string): boolean {
  return Boolean(item && typeof item === 'object' && key in item)
}

function slackChannelField(): ConnectorFieldDefinition {
  return {
    ...field.text('channel', '频道 ID'),
    description: '可从连接动态加载，也可手工填写频道 ID。',
    dynamicOptions: {
      build: () => ({ ...jsonRequest('GET', 'https://slack.com/api/conversations.list?exclude_archived=true&limit=200&types=public_channel%2Cprivate_channel'), validateResponse: slackResponse }),
      extract: (value) => listAt(value, 'channels').flatMap((item) => {
        const id = objectKey(item, 'id')
        const name = objectKey(item, 'name')
        return id ? [{ value: id, label: name ? `#${name}` : id }] : []
      }),
    },
  }
}

export const BUILTIN_CONNECTORS: ConnectorDefinition[] = [
  defineConnector({
    id: 'github', name: 'GitHub', description: 'Issue、评论与仓库自动化', category: '开发', color: '#24292f', origins: ['https://api.github.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'GitHub Token 或 OAuth2 连接',
    actions: [
      { id: 'create-issue', label: '创建 Issue', description: '在仓库中创建 Issue', fields: [field.text('owner', '仓库所有者'), field.text('repo', '仓库名'), field.text('title', '标题'), field.area('body', '正文', false), field.json('labels', '标签 JSON', false, '["bug"]')], build: (c) => jsonRequest('POST', `https://api.github.com/repos/${c.path('owner')}/${c.path('repo')}/issues`, compact({ title: c.value('title'), body: c.optional('body'), labels: c.json('labels') }), { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }) },
      { id: 'add-comment', label: '添加 Issue 评论', description: '向 Issue 或 PR 添加评论', fields: [field.text('owner', '仓库所有者'), field.text('repo', '仓库名'), field.text('issueNumber', 'Issue 编号'), field.area('body', '评论内容')], build: (c) => jsonRequest('POST', `https://api.github.com/repos/${c.path('owner')}/${c.path('repo')}/issues/${c.path('issueNumber')}/comments`, { body: c.value('body') }, { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }) },
    ],
    triggers: [
      { id: 'new-issue', label: '新 Issue', description: '检测仓库中新创建或更新的 Issue', fields: [field.text('owner', '仓库所有者'), field.text('repo', '仓库名')], build: (c) => jsonRequest('GET', c.query(`https://api.github.com/repos/${c.path('owner')}/${c.path('repo')}/issues`, { state: 'all', sort: 'updated', direction: 'desc', per_page: 30 }), undefined, { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }), extract: (value) => ({ items: listAt(value).filter((item) => !hasObjectKey(item, 'pull_request')) }), key: (item) => objectKey(item, 'id') },
    ],
  }),
  defineConnector({
    id: 'slack', name: 'Slack', description: '发送消息与读取频道历史', category: '协作', color: '#4a154b', origins: ['https://slack.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'Slack Bot Token 或 OAuth2 连接',
    actions: [
      { id: 'post-message', label: '发送消息', description: '向频道或私聊发送消息', fields: [slackChannelField(), field.area('text', '消息内容'), field.text('threadTs', '线程时间戳', false)], build: (c) => ({ ...jsonRequest('POST', 'https://slack.com/api/chat.postMessage', compact({ channel: c.value('channel'), text: c.value('text'), thread_ts: c.optional('threadTs') })), validateResponse: slackResponse }) },
      { id: 'list-history', label: '读取频道历史', description: '读取频道最近消息', fields: [slackChannelField(), field.number('limit', '数量', '20', 1, 100)], build: (c) => ({ ...jsonRequest('GET', c.query('https://slack.com/api/conversations.history', { channel: c.value('channel'), limit: c.integer('limit') })), validateResponse: slackResponse }) },
    ],
    triggers: [
      { id: 'new-message', label: '新频道消息', description: '检测频道中新出现的消息', fields: [slackChannelField()], build: (c) => ({ ...jsonRequest('GET', c.query('https://slack.com/api/conversations.history', { channel: c.value('channel'), limit: 50 })), validateResponse: slackResponse }), extract: (value) => ({ items: listAt(value, 'messages') }), key: (item) => objectKey(item, 'ts') },
    ],
  }),
  defineConnector({
    id: 'openai', name: 'OpenAI', description: 'Responses 与 Embeddings API', category: 'AI', color: '#10a37f', origins: ['https://api.openai.com'], credentialKinds: ['bearer'], authHint: 'OpenAI API Key 的 Bearer Token 连接',
    actions: [
      { id: 'create-response', label: '创建 Response', description: '调用 Responses API 生成结果', fields: [field.defaultText('model', '模型', 'gpt-5-mini'), field.defaultArea('input', '输入', '{{result}}'), field.area('instructions', '系统指令', false)], build: (c) => jsonRequest('POST', 'https://api.openai.com/v1/responses', compact({ model: c.value('model'), input: c.value('input'), instructions: c.optional('instructions') })) },
      { id: 'create-embedding', label: '创建 Embedding', description: '将文本转换为向量', fields: [field.defaultText('model', '模型', 'text-embedding-3-small'), field.defaultArea('input', '输入', '{{result}}')], build: (c) => jsonRequest('POST', 'https://api.openai.com/v1/embeddings', { model: c.value('model'), input: c.value('input') }) },
    ],
  }),
  defineConnector({
    id: 'deepseek', name: 'DeepSeek', description: '对话补全与模型列表', category: 'AI', color: '#4d6bfe', origins: ['https://api.deepseek.com'], credentialKinds: ['bearer'], authHint: 'DeepSeek API Key 的 Bearer Token 连接',
    actions: [
      { id: 'chat-completion', label: '创建对话补全', description: '调用 DeepSeek Chat Completions', fields: [field.defaultText('model', '模型', 'deepseek-chat'), field.defaultJson('messages', '消息 JSON', '[{"role":"user","content":"{{result}}"}]')], build: (c) => jsonRequest('POST', 'https://api.deepseek.com/chat/completions', { model: c.value('model'), messages: c.json('messages') }) },
      { id: 'list-models', label: '列出模型', description: '读取可用模型', fields: [], build: () => jsonRequest('GET', 'https://api.deepseek.com/models') },
    ],
  }),
  defineConnector({
    id: 'anthropic', name: 'Anthropic', description: 'Messages 与模型 API', category: 'AI', color: '#d97757', origins: ['https://api.anthropic.com'], credentialKinds: ['api-key'], credentialHeaderName: 'x-api-key', authHint: 'API Key 连接，Header 名称必须为 x-api-key',
    actions: [
      { id: 'create-message', label: '创建消息', description: '调用 Claude Messages API', fields: [field.defaultText('model', '模型', 'claude-sonnet-4-5'), field.number('maxTokens', '最大 Token', '1024', 1, 8192), field.defaultJson('messages', '消息 JSON', '[{"role":"user","content":"{{result}}"}]')], build: (c) => jsonRequest('POST', 'https://api.anthropic.com/v1/messages', { model: c.value('model'), max_tokens: c.integer('maxTokens'), messages: c.json('messages') }, { 'anthropic-version': '2023-06-01' }) },
      { id: 'list-models', label: '列出模型', description: '读取可用 Claude 模型', fields: [field.number('limit', '数量', '20', 1, 100)], build: (c) => jsonRequest('GET', c.query('https://api.anthropic.com/v1/models', { limit: c.integer('limit') }), undefined, { 'anthropic-version': '2023-06-01' }) },
    ],
  }),
  defineConnector({
    id: 'notion', name: 'Notion', description: '创建页面与查询数据库', category: '协作', color: '#2f3437', origins: ['https://api.notion.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'Notion Integration Token 或 OAuth2 连接',
    actions: [
      { id: 'create-page', label: '创建数据库页面', description: '在数据库中创建页面', fields: [field.text('databaseId', '数据库 ID'), field.json('properties', '属性 JSON', true, '{"Name":{"title":[{"text":{"content":"{{result.title}}"}}]}}')], build: (c) => jsonRequest('POST', 'https://api.notion.com/v1/pages', { parent: { database_id: c.value('databaseId') }, properties: c.json('properties') }, { 'notion-version': '2022-06-28' }) },
      { id: 'query-database', label: '查询数据库', description: '按过滤条件查询页面', fields: [field.text('databaseId', '数据库 ID'), field.json('filter', '过滤器 JSON', false, '{}'), field.number('pageSize', '数量', '20', 1, 100)], build: (c) => jsonRequest('POST', `https://api.notion.com/v1/databases/${c.path('databaseId')}/query`, compact({ filter: c.json('filter'), page_size: c.integer('pageSize') }), { 'notion-version': '2022-06-28' }) },
    ],
  }),
  defineConnector({
    id: 'airtable', name: 'Airtable', description: '读取与写入表格记录', category: '数据', color: '#0768f8', origins: ['https://api.airtable.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'Airtable Personal Access Token 或 OAuth2 连接',
    actions: [
      { id: 'create-record', label: '创建记录', description: '向表中写入一条记录', fields: [field.text('baseId', 'Base ID'), field.text('tableId', 'Table ID 或名称'), field.json('fields', '字段 JSON', true, '{"Name":"{{result.name}}"}')], build: (c) => jsonRequest('POST', `https://api.airtable.com/v0/${c.path('baseId')}/${c.path('tableId')}`, { records: [{ fields: c.json('fields') }] }) },
      { id: 'list-records', label: '读取记录', description: '读取表中的记录', fields: [field.text('baseId', 'Base ID'), field.text('tableId', 'Table ID 或名称'), field.number('maxRecords', '最大数量', '20', 1, 100), field.text('filter', '过滤公式', false)], build: (c) => jsonRequest('GET', c.query(`https://api.airtable.com/v0/${c.path('baseId')}/${c.path('tableId')}`, { maxRecords: c.integer('maxRecords'), filterByFormula: c.optional('filter') })) },
    ],
  }),
  defineConnector({
    id: 'google-sheets', name: 'Google Sheets', description: '读取与追加单元格', category: '数据', color: '#188038', origins: ['https://sheets.googleapis.com'], credentialKinds: ['oauth2', 'bearer'], authHint: 'Google OAuth2 连接，需 Sheets 权限',
    actions: [
      { id: 'append-values', label: '追加行', description: '向范围末尾追加多行数据', fields: [field.text('spreadsheetId', '表格 ID'), field.defaultText('range', '范围', 'Sheet1!A:D'), field.json('values', '二维数组 JSON', true, '[["{{result.name}}","{{result.email}}"]]')], build: (c) => jsonRequest('POST', c.query(`https://sheets.googleapis.com/v4/spreadsheets/${c.path('spreadsheetId')}/values/${c.path('range')}:append`, { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }), { values: c.json('values') }) },
      { id: 'get-values', label: '读取范围', description: '读取指定单元格范围', fields: [field.text('spreadsheetId', '表格 ID'), field.defaultText('range', '范围', 'Sheet1!A:D')], build: (c) => jsonRequest('GET', `https://sheets.googleapis.com/v4/spreadsheets/${c.path('spreadsheetId')}/values/${c.path('range')}`) },
    ],
  }),
  defineConnector({
    id: 'gmail', name: 'Gmail', description: '发送邮件与查询邮件', category: '协作', color: '#ea4335', origins: ['https://gmail.googleapis.com'], credentialKinds: ['oauth2', 'bearer'], authHint: 'Google OAuth2 连接，需 Gmail 权限',
    actions: [
      { id: 'send-raw', label: '发送 MIME 邮件', description: '发送 Base64URL 编码的 RFC 2822 邮件', fields: [field.area('raw', 'Base64URL MIME 内容', true, '{{result.raw}}')], build: (c) => jsonRequest('POST', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { raw: c.value('raw') }) },
      { id: 'list-messages', label: '查询邮件', description: '按 Gmail 搜索语法查询邮件', fields: [field.text('query', '搜索条件', false, 'is:unread'), field.number('maxResults', '数量', '20', 1, 100)], build: (c) => jsonRequest('GET', c.query('https://gmail.googleapis.com/gmail/v1/users/me/messages', { q: c.optional('query'), maxResults: c.integer('maxResults') })) },
    ],
  }),
  defineConnector({
    id: 'hubspot', name: 'HubSpot', description: '联系人创建与 CRM 搜索', category: '销售', color: '#ff7a59', origins: ['https://api.hubapi.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'HubSpot Private App Token 或 OAuth2 连接',
    actions: [
      { id: 'create-contact', label: '创建联系人', description: '创建 CRM 联系人', fields: [field.json('properties', '属性 JSON', true, '{"email":"{{result.email}}","firstname":"{{result.name}}"}')], build: (c) => jsonRequest('POST', 'https://api.hubapi.com/crm/v3/objects/contacts', { properties: c.json('properties') }) },
      { id: 'search-contacts', label: '搜索联系人', description: '使用 HubSpot 搜索请求', fields: [field.json('filterGroups', '过滤组 JSON', true, '[{"filters":[{"propertyName":"email","operator":"EQ","value":"{{result.email}}"}]}]'), field.number('limit', '数量', '20', 1, 100)], build: (c) => jsonRequest('POST', 'https://api.hubapi.com/crm/v3/objects/contacts/search', { filterGroups: c.json('filterGroups'), limit: c.integer('limit') }) },
    ],
  }),
  defineConnector({
    id: 'jira', name: 'Jira Cloud', description: '创建与搜索 Jira Issue', category: '开发', color: '#1868db', origins: ['https://api.atlassian.com'], credentialKinds: ['oauth2', 'bearer'], authHint: 'Atlassian OAuth2 连接与 Cloud ID',
    actions: [
      { id: 'create-issue', label: '创建 Issue', description: '在 Jira Cloud 项目中创建 Issue', fields: [field.text('cloudId', 'Cloud ID'), field.text('projectKey', '项目 Key'), field.defaultText('issueType', 'Issue 类型', 'Task'), field.text('summary', '标题'), field.json('description', 'ADF 描述 JSON', false, '{}')], build: (c) => jsonRequest('POST', `https://api.atlassian.com/ex/jira/${c.path('cloudId')}/rest/api/3/issue`, { fields: compact({ project: { key: c.value('projectKey') }, issuetype: { name: c.value('issueType') }, summary: c.value('summary'), description: c.json('description') }) }) },
      { id: 'search-issues', label: '搜索 Issue', description: '使用 JQL 搜索 Issue', fields: [field.text('cloudId', 'Cloud ID'), field.area('jql', 'JQL'), field.number('maxResults', '数量', '20', 1, 100)], build: (c) => jsonRequest('POST', `https://api.atlassian.com/ex/jira/${c.path('cloudId')}/rest/api/3/search/jql`, { jql: c.value('jql'), maxResults: c.integer('maxResults') }) },
    ],
  }),
  defineConnector({
    id: 'todoist', name: 'Todoist', description: '创建与读取任务', category: '效率', color: '#e44332', origins: ['https://api.todoist.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'Todoist API Token 或 OAuth2 连接',
    actions: [
      { id: 'create-task', label: '创建任务', description: '创建新的 Todoist 任务', fields: [field.text('content', '任务内容'), field.area('description', '描述', false), field.text('projectId', '项目 ID', false), field.text('dueString', '自然语言日期', false, 'tomorrow at 9am')], build: (c) => jsonRequest('POST', 'https://api.todoist.com/rest/v2/tasks', compact({ content: c.value('content'), description: c.optional('description'), project_id: c.optional('projectId'), due_string: c.optional('dueString') })) },
      { id: 'list-tasks', label: '读取任务', description: '读取活跃任务', fields: [field.text('projectId', '项目 ID', false), field.text('filter', '过滤器', false)], build: (c) => jsonRequest('GET', c.query('https://api.todoist.com/rest/v2/tasks', { project_id: c.optional('projectId'), filter: c.optional('filter') })) },
    ],
    triggers: [
      { id: 'new-task', label: '新任务', description: '检测新出现的未完成任务', fields: [field.text('projectId', '项目 ID', false)], build: (c) => jsonRequest('GET', c.query('https://api.todoist.com/rest/v2/tasks', { project_id: c.optional('projectId') })), extract: (value) => ({ items: listAt(value) }), key: (item) => objectKey(item, 'id') },
    ],
  }),
  defineConnector({
    id: 'stripe', name: 'Stripe', description: '客户与支付数据操作', category: '支付', color: '#635bff', origins: ['https://api.stripe.com'], credentialKinds: ['bearer'], authHint: 'Stripe Secret Key 的 Bearer Token 连接',
    actions: [
      { id: 'create-customer', label: '创建客户', description: '创建 Stripe Customer', fields: [field.text('email', '邮箱', false), field.text('name', '姓名', false), field.area('description', '描述', false)], build: (c) => ({ method: 'POST', url: 'https://api.stripe.com/v1/customers', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: formBody({ email: c.optional('email'), name: c.optional('name'), description: c.optional('description') }), responseMode: 'json' }) },
      { id: 'list-customers', label: '读取客户', description: '读取最近客户', fields: [field.number('limit', '数量', '10', 1, 100), field.text('email', '邮箱', false)], build: (c) => jsonRequest('GET', c.query('https://api.stripe.com/v1/customers', { limit: c.integer('limit'), email: c.optional('email') })) },
    ],
    triggers: [
      { id: 'new-event', label: '新事件', description: '检测 Stripe 账户中新生成的事件', fields: [], build: () => jsonRequest('GET', 'https://api.stripe.com/v1/events?limit=50'), extract: (value) => ({ items: listAt(value, 'data') }), key: (item) => objectKey(item, 'id') },
    ],
  }),
  defineConnector({
    id: 'discord', name: 'Discord', description: '发送与读取频道消息', category: '协作', color: '#5865f2', origins: ['https://discord.com'], credentialKinds: ['api-key'], credentialHeaderName: 'Authorization', authHint: 'API Key 连接，Header 名称为 Authorization，值填写 Bot <token>',
    actions: [
      { id: 'post-message', label: '发送频道消息', description: '向 Discord 频道发送消息', fields: [field.text('channelId', '频道 ID'), field.area('content', '消息内容')], build: (c) => jsonRequest('POST', `https://discord.com/api/v10/channels/${c.path('channelId')}/messages`, { content: c.value('content') }) },
      { id: 'list-messages', label: '读取频道消息', description: '读取频道最近消息', fields: [field.text('channelId', '频道 ID'), field.number('limit', '数量', '20', 1, 100)], build: (c) => jsonRequest('GET', c.query(`https://discord.com/api/v10/channels/${c.path('channelId')}/messages`, { limit: c.integer('limit') })) },
    ],
  }),
  defineConnector({
    id: 'microsoft-teams', name: 'Microsoft Teams', description: '通过 Microsoft Graph 操作频道消息', category: '协作', color: '#6264a7', origins: ['https://graph.microsoft.com'], credentialKinds: ['oauth2', 'bearer'], authHint: 'Microsoft OAuth2 连接，需 Graph Teams 权限',
    actions: [
      { id: 'post-channel-message', label: '发送频道消息', description: '向 Teams 频道发送消息', fields: [field.text('teamId', 'Team ID'), field.text('channelId', 'Channel ID'), field.area('content', '消息内容'), { id: 'contentType', label: '内容类型', type: 'select', defaultValue: 'text', options: [{ value: 'text', label: '纯文本' }, { value: 'html', label: 'HTML' }] }], build: (c) => jsonRequest('POST', `https://graph.microsoft.com/v1.0/teams/${c.path('teamId')}/channels/${c.path('channelId')}/messages`, { body: { contentType: c.value('contentType'), content: c.value('content') } }) },
      { id: 'list-channel-messages', label: '读取频道消息', description: '读取 Teams 频道消息', fields: [field.text('teamId', 'Team ID'), field.text('channelId', 'Channel ID')], build: (c) => jsonRequest('GET', `https://graph.microsoft.com/v1.0/teams/${c.path('teamId')}/channels/${c.path('channelId')}/messages`) },
    ],
  }),
  defineConnector({
    id: 'asana', name: 'Asana', description: '创建任务与读取项目任务', category: '效率', color: '#f06a6a', origins: ['https://app.asana.com'], credentialKinds: ['bearer', 'oauth2'], authHint: 'Asana Personal Access Token 或 OAuth2 连接',
    actions: [
      { id: 'create-task', label: '创建任务', description: '在工作区或项目中创建任务', fields: [field.text('workspace', 'Workspace GID'), field.text('name', '任务名称'), field.area('notes', '描述', false), field.text('project', 'Project GID', false), field.text('assignee', 'Assignee GID', false)], build: (c) => jsonRequest('POST', 'https://app.asana.com/api/1.0/tasks', { data: compact({ workspace: c.value('workspace'), name: c.value('name'), notes: c.optional('notes'), projects: c.optional('project') ? [c.optional('project')] : undefined, assignee: c.optional('assignee') }) }) },
      { id: 'list-project-tasks', label: '读取项目任务', description: '读取项目中的任务', fields: [field.text('project', 'Project GID'), field.number('limit', '数量', '20', 1, 100)], build: (c) => jsonRequest('GET', c.query(`https://app.asana.com/api/1.0/projects/${c.path('project')}/tasks`, { limit: c.integer('limit') })) },
    ],
    triggers: [
      { id: 'new-project-task', label: '新项目任务', description: '检测项目中新增的任务', fields: [field.text('project', 'Project GID')], build: (c) => jsonRequest('GET', c.query(`https://app.asana.com/api/1.0/projects/${c.path('project')}/tasks`, { limit: 50 })), extract: (value) => ({ items: listAt(value, 'data') }), key: (item) => objectKey(item, 'gid') },
    ],
  }),
]
