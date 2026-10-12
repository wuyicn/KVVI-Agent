export const roleNames = { builder: '搭建者', employee: '员工', owner: '所有者' };
export function businessDestination(systems, role, systemId, pageId) {
  const builder = role === 'builder' || role === 'owner';
  const visible = systems.filter(s => builder || s.published);
  const system = visible.find(s => s.id === systemId) || visible[0];
  const pages = (system?.resources || []).filter(r => r.kind !== 'group' && (builder || r.published));
  const page = pages.find(r => r.id === pageId) || pages.find(r => r.id === 'orders') || pages.find(r => r.kind === 'form') || pages[0];
  return { systemId: system?.id || null, pageId: page?.id || null };
}
export const orderFields = [
  { id: 'code', name: '报货编号', required: true, type: 'text' },
  { id: 'customer', name: '客户', required: true, type: 'text' },
  { id: 'status', name: '发货状态', required: true, type: 'select', options: ['待发货', '已发货'] },
  { id: 'amount', name: '总金额', required: true, type: 'number' },
  { id: 'date', name: '订单日期', required: true, type: 'date' },
  { id: 'products', name: '产品明细', type: 'text' },
  { id: 'phone', name: '联系电话', type: 'text' },
  { id: 'address', name: '收货地址', type: 'text' },
];
const basicFields = [{ id: 'name', name: '名称', required: true, type: 'text' }, { id: 'note', name: '备注', type: 'text' }];
const customerFields = [
  { id: 'name', name: '客户名称', required: true, type: 'text' },
  { id: 'contact', name: '联系人', required: true, type: 'text' },
  { id: 'phone', name: '电话', type: 'text' },
  { id: 'status', name: '跟进状态', required: true, type: 'select', options: ['初次接洽', '跟进中', '已成交', '已流失'] },
  { id: 'owner', name: '负责人', type: 'text' },
  { id: 'note', name: '备注', type: 'text' },
];
const resource = (id, name, kind = 'form', group = null, fields = basicFields) => ({ id, name, kind, group, fields, published: true });
export function initialHubData() {
  const orders = [
    ['B2026100801', '恒远商贸', '待发货', '4500', '2026-10-08', '户外方桌 · 2项'],
    ['B2026100702', '木禾空间', '已发货', '7600', '2026-10-07', '桌椅组合 · 3项'],
    ['B2026100603', '新城建材', '已发货', '3200', '2026-10-06', '户外椅 · 2项'],
    ['B2026100504', '山河广场', '待发货', '8900', '2026-10-05', '长桌组合 · 4项'],
    ['B2026100405', '蓝海贸易', '已发货', '6800', '2026-10-04', '遮阳伞 · 2项'],
    ['B2026100306', '万家生活', '待发货', '2300', '2026-10-03', '折叠椅 · 2项'],
  ].map((values, index) => ({ id: `order-${index + 1}`, values: Object.fromEntries(orderFields.slice(0, 6).map((f, i) => [f.id, values[i]])) }));
  return {
    systems: [
      { id: 'gad', name: 'GAD STUDIO', description: '销售与订单管理', published: true, resources: [
        resource('dashboard', '销售数据看板', 'dashboard'), resource('products', '产品目录'), resource('customers', '客户信息'),
        resource('orders', '报货单', 'form', null, orderFields), resource('sales', '销售订单'),
        resource('finance', '财务室', 'group'), resource('invoice', '开票申请', 'form', 'finance'), resource('monthly', '月度销售报表', 'report', 'finance'),
        resource('supply', '供应链中心', 'group'), resource('logistics', '物流发货单', 'form', 'supply'), resource('after', '售后服务', 'form', 'supply'),
        resource('returns', '退货退款', 'form', 'supply'), resource('shipping-report', '发货报表', 'report', 'supply'),
      ] },
      { id: 'customer', name: '客户登记系统', description: '客户信息登记与跟进', published: true, resources: [resource('register', '客户登记表', 'form', null, customerFields), resource('followup', '客户跟进表')] },
      { id: 'visitor', name: '访客登记', description: '访客信息登记', published: false, resources: [{ ...resource('visitors', '访客登记表'), published: false }] },
    ], records: { 'gad/orders': orders },
  };
}
export function contents(resources) {
  return [['form', '张表单'], ['dashboard', '个仪表盘'], ['report', '张报表']]
    .map(([kind, unit]) => { const n = resources.filter(r => r.kind === kind).length; return n ? n + unit : ''; }).filter(Boolean).join(' · ') || '还没有表单';
}
// A single prototype business space. Namespaced IDs preserve each form's records.
export function initialGroupedHubData() {
  const source = initialHubData();
  const names = { gad: '销售管理', customer: '客户管理', visitor: '访客管理' };
  const resources = source.systems.flatMap(s => [
    { id: s.id + ':general', name: names[s.id], kind: 'group', group: null, published: s.published, fields: [] },
    ...s.resources.map(r => ({ ...r, id: s.id + ':' + r.id,
      group: r.kind === 'group' ? null : s.id + ':' + (r.group || 'general'),
      published: s.published && r.published })),
  ]);
  return { systems: [{ id: 'business', name: '业务', published: true, resources }],
    records: Object.fromEntries(Object.entries(source.records).map(([key, rows]) => ['business/' + key.replace('/', ':'), rows])) };
}
export function removeBusinessGroup(data, groupId) {
  return { ...data, systems: data.systems.map(s => ({ ...s, resources: s.resources
    .filter(r => !(r.kind === 'group' && r.id === groupId))
    .map(r => r.group === groupId ? { ...r, group: null } : r) })) };
}
export function visibleBusinessResources(resources, builder) {
  if (builder) return resources;
  return resources.filter(r => r.kind === 'group'
    ? resources.some(child => child.group === r.id && child.kind !== 'group' && child.published)
    : r.published);
}
export function prototypeReply(question, record, records, resourceName) {
  if (record && /缺|信息|地址|电话/.test(question)) {
    const missing = ['address', 'phone'].filter(id => !record.values[id]);
    return missing.length ? '还没有' + missing.map(id => id === 'address' ? '收货地址' : '联系电话').join('和') + '，可以打开记录补充。' : '这条记录已填写收货地址和联系电话。';
  }
  if (/多少|统计|汇总|金额/.test(question)) return `${resourceName}有 ${records.length} 条记录` + (records.some(r => 'amount' in r.values) ? `，总金额 ${records.reduce((n, r) => n + (Number(r.values.amount) || 0), 0).toLocaleString('zh-CN')} 元。` : '。');
  return record ? `已选中「${record.values.code || record.values.name}」。可以查看详情或打开记录修改。` : `当前是「${resourceName}」。可以新增记录，或选中一条记录后继续提问。`;
}
