/** `kvviPanel` namespace dictionaries. */

/** Dictionary namespace owned by the KVVI business panel. */
export const NS = 'kvviPanel'

/**
 * Error codes the renderer shows verbatim.
 *
 * ⚠️ These are **not** translated: they are the machine-readable reason a
 * contract could not be drawn, and an operator searching a bug report needs the
 * same string the code carries. The human sentence travels next to them, in the
 * dictionary.
 */
export const NOT_REGISTERED = 'KVVI_COMPONENT_NOT_REGISTERED'
export const WRONG_VIEW_TYPE = 'KVVI_COMPONENT_WRONG_VIEW_TYPE'
export const FIELD_UNBOUND = 'KVVI_COMPONENT_FIELD_UNBOUND'
export const QUERY_UNSUPPORTED = 'KVVI_TABLE_QUERY_UNSUPPORTED'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.title': '业务',
  'panel.close': '关闭',
  'panel.aria': 'KVVI 业务面板',
  'panel.loading': '读取中…',
  'panel.detail': '面板是附加信息。取不到时只会少显示内容，不影响对话与其他操作。',

  'systems.title': '我的系统',
  'systems.hint': '本公司已发布的业务系统',
  'systems.empty': '本公司还没有已发布的业务系统',
  'systems.failed': '读取失败：{detail}',
  'systems.open': '打开',

  'system.back': '返回系统列表',
  'system.tab.form': '填单',
  'system.tab.records': '记录',
  'system.unrunnable': '这个系统现在不能运行：{detail}',
  'system.missingContracts': '缺少契约：{missing}',
  'system.fieldUnbound': '视图引用了模型里没有的字段：{fields}',

  'form.submit': '提交',
  'form.submitting': '提交中…',
  'form.created': '已提交，记录号 {recordNo}',
  'form.failed': '提交失败：{detail}',
  'form.empty': '这个表单没有可填写的字段',
  'form.required': '必填',
  'form.readonly': '只读',

  'list.title': '记录',
  'list.empty': '还没有记录',
  'list.open': '打开',
  'list.refresh': '刷新',
  'list.failed': '读取失败：{detail}',
  'list.columns': '字段',

  'detail.title': '记录详情',
  'detail.back': '返回记录列表',
  'detail.version': '版本 {rowVersion}',
  'detail.save': '保存',
  'detail.saved': '已保存',
  'detail.failed': '保存失败：{detail}',
  'detail.conflict': '这条记录已被别人改过（当前版本 {currentRowVersion}），请刷新后重试',
  'detail.noSuchRecord': '这条记录不存在，或者你无权查看',
  'detail.state': '状态',

  'blocked.title': '这个界面无法显示',
  'blocked.notRegistered': '契约用了渲染器不认识的组件：{name}',
  'blocked.wrongViewType': '组件 {name} 不能用在 {viewType} 视图里',
  'blocked.unbound': '组件 {name} 没有绑定字段',
  'blocked.queryUnsupported': '组件 {name} 需要查询接口（{queryCode}），平台还没有这个端点',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<KvviKey, string> = {
  'panel.title': 'Business',
  'panel.close': 'Close',
  'panel.aria': 'KVVI business panel',
  'panel.loading': 'Loading…',
  'panel.detail': 'This panel is supplementary. When it cannot load, only its content is missing; the conversation is unaffected.',

  'systems.title': 'My systems',
  'systems.hint': 'Business systems published by this company',
  'systems.empty': 'This company has no published business systems yet',
  'systems.failed': 'Could not load: {detail}',
  'systems.open': 'Open',

  'system.back': 'Back to systems',
  'system.tab.form': 'Fill in',
  'system.tab.records': 'Records',
  'system.unrunnable': 'This system cannot run right now: {detail}',
  'system.missingContracts': 'Missing contracts: {missing}',
  'system.fieldUnbound': 'The view references fields the model does not declare: {fields}',

  'form.submit': 'Submit',
  'form.submitting': 'Submitting…',
  'form.created': 'Submitted, record number {recordNo}',
  'form.failed': 'Submit failed: {detail}',
  'form.empty': 'This form has no fillable field',
  'form.required': 'Required',
  'form.readonly': 'Read-only',

  'list.title': 'Records',
  'list.empty': 'No records yet',
  'list.open': 'Open',
  'list.refresh': 'Refresh',
  'list.failed': 'Could not load: {detail}',
  'list.columns': 'Fields',

  'detail.title': 'Record detail',
  'detail.back': 'Back to records',
  'detail.version': 'Version {rowVersion}',
  'detail.save': 'Save',
  'detail.saved': 'Saved',
  'detail.failed': 'Save failed: {detail}',
  'detail.conflict': 'Someone else changed this record (current version {currentRowVersion}). Reload and retry.',
  'detail.noSuchRecord': 'This record does not exist, or you may not read it',
  'detail.state': 'State',

  'blocked.title': 'This interface cannot be displayed',
  'blocked.notRegistered': 'The contract names a component the renderer does not carry: {name}',
  'blocked.wrongViewType': 'Component {name} cannot be used in a {viewType} view',
  'blocked.unbound': 'Component {name} has no field binding',
  'blocked.queryUnsupported': 'Component {name} needs a query endpoint ({queryCode}), which the platform does not serve yet',
}

/** Key domain of the `kvviPanel` namespace (zh is the source of truth). */
export type KvviKey = keyof typeof zh
