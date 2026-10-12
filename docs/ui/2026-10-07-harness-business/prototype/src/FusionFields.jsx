import { LockKeyhole, ShieldCheck } from 'lucide-react';

export function FusionFields({ fields, values = {}, onChange, preview = false }) {
  return <div className="fusion-fields">{fields.map((f, index) => <label key={f.id} className={index === 0 || f.id === 'note' ? 'fusion-full' : ''}>
    <span>{f.name}{f.required && <em aria-hidden="true"> *</em>}{f.id === 'owner' && <LockKeyhole size={13}/>}</span>
    {f.type === 'select' ? <select aria-label={f.name} required={!!f.required} disabled={preview} value={values[f.id] || ''} onChange={e => onChange(f.id, e.target.value)}><option value="">请选择{f.name}</option>{f.options.map(o => <option key={o}>{o}</option>)}</select>
      : f.id === 'note' ? <textarea aria-label={f.name} disabled={preview} value={values[f.id] || ''} placeholder="补充需求、沟通情况…" onChange={e => onChange(f.id, e.target.value)}/>
      : <input aria-label={f.name} required={!!f.required} readOnly={f.id === 'owner'} disabled={preview} type={f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'} min={f.type === 'number' ? 0 : undefined} value={values[f.id] || ''} placeholder={'请输入' + f.name} onChange={e => onChange(f.id, e.target.value)}/>}
    {f.id === 'owner' && <small>默认当前员工 · 原型示例，不代表真实授权</small>}
  </label>)}</div>;
}

export function PreviewForm({ business, editRecord }) {
  return <div className="fusion-preview"><div className="fusion-eyebrow">界面预览</div><h2>{business.formName}</h2><p className="hub-muted">检查字段与布局，不会写入业务数据。</p><FusionFields fields={business.fields} preview/><p className="fusion-hint"><ShieldCheck size={16}/>静态预览 · 未连接真实发布</p><button onClick={() => editRecord()}>试填示例表单</button></div>;
}
