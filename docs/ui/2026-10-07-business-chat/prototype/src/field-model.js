// Prototype field settings remain scoped to each business.
export function fieldDefinition(system, name, index) {
  const options = name.includes('类型') ? ['事假', '年假', '病假']
    : name.includes('状态') ? ['初次接洽', '跟进中', '已成交'] : [];
  return {
    origin: name,
    required: index < 2,
    type: name === '负责人' ? 'member'
      : options.length ? 'select'
      : ['备注', '请假原因'].includes(name) ? 'textarea' : 'text',
    options,
    ...system.fieldSettings?.[name],
  };
}
export function renameValue(values, from, to) {
  if (!values || from === to || !Object.hasOwn(values, from)) return values;
  const { [from]: value, ...rest } = values;
  return { ...rest, [to]: value };
}
