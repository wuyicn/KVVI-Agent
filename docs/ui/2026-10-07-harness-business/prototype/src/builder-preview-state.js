export const initialFields = [
  { id: 'name', name: '店铺名称', type: 'text', required: true },
  { id: 'platform', name: '所属平台', type: 'select', required: true, options: ['淘宝', '天猫', '抖音', '拼多多', '京东', '其他'] },
  { id: 'account', name: '店铺账号', type: 'text', required: true, unique: true },
  { id: 'contact', name: '负责人', type: 'text', required: true },
  { id: 'phone', name: '联系电话', type: 'text', required: true },
  { id: 'opened', name: '开店日期', type: 'date', required: false },
  { id: 'status', name: '经营状态', type: 'select', required: true, options: ['在营', '暂停营业', '已关闭'] },
  { id: 'notes', name: '备注', type: 'textarea', required: false },
];
// Deliberately bounded demo commands, not a model or production compiler.
export function changePreview(fields, text) {
  const match = /^(?:把)?(.+?)(?:改为|设为)(必填|选填)[。！]?$/u.exec(text.trim());
  if (match && fields.some(f => f.name === match[1])) {
    const target = fields.find(f => f.name === match[1]);
    return { fields: fields.map(f => f.id === target.id ? { ...f, required: match[2] === '必填' } : f), changed: [target.id], supported: true };
  }
  if (text.trim() === '新增联系地址' && !fields.some(f => f.id === 'address')) {
    return { fields: [...fields, { id: 'address', name: '联系地址', type: 'text', required: false }], changed: ['address'], supported: true };
  }
  return { fields, changed: [], supported: false };
}
export function checkTrial(fields, values) {
  const errors = {};
  for (const field of fields) {
    const value = String(values[field.id] ?? '').trim();
    if (field.required && !value) errors[field.id] = '请填写' + field.name;
    else if (field.unique && value === 'demo-shop') errors[field.id] = '这个示例账号已登记，请换一个试试';
  }
  return errors;
}
