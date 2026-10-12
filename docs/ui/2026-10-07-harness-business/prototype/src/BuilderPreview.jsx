import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ChevronRight, FileText, Folder, MessageSquare, PanelLeft, ShieldCheck } from 'lucide-react';
import { initialFields, changePreview, checkTrial } from './builder-preview-state.js';
import './builder-preview.css';

export function BuilderPreview() {
  const [fields, setFields] = useState(initialFields);
  const [values, setValues] = useState({ status: '在营' });
  const [errors, setErrors] = useState({});
  const [changed, setChanged] = useState([]);
  const [input, setInput] = useState('');
  const [tab, setTab] = useState('preview');
  const [permission, setPermission] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState('');
  const conversation = useRef(null);
  const [messages, setMessages] = useState([
    { role: 'user', text: '我想管理各个平台的店铺。登记店铺名称、平台、账号、负责人、电话和开店日期，同一个账号不能重复登记。' },
    { role: 'assistant', text: '店铺登记表已放在右侧。你可以直接试填，也可以告诉我哪里要改。使用范围确认后，再检查并提交。' },
  ]);
  useEffect(() => { conversation.current?.scrollTo({ top: conversation.current.scrollHeight }); }, [messages]);
  function modify(text) {
    if (!text.trim()) return;
    const next = changePreview(fields, text);
    setMessages(all => [...all, { role: 'user', text }, { role: 'assistant', text: next.supported ? '预览已更新，改动处已标出来。请再核对一下。' : '这版交互演示还不能理解这项修改。可以试试下方的示例建议；没有更改表单。' }]);
    if (next.supported) { setFields(next.fields); setChanged(next.changed); setConfirmed(false); setErrors({}); setNotice(''); }
    setInput('');
  }
  function trial() {
    const next = checkTrial(fields, values);
    setErrors(next);
    setNotice(Object.keys(next).length ? '请检查标出的填写项。' : '试填检查通过。这里只使用示例数据，没有保存业务记录。');
  }
  return <div className="bp-app">
    <aside className="bp-nav">
      <a className="bp-brand" href="/">‹‹ <strong>可微科技</strong><PanelLeft size={16}/></a>
      <a className="bp-new" href="/">＋ 返回业务</a>
      <a className="bp-nav-item" href="/"><FileText size={17}/>业务</a>
      <div className="bp-nav-caption">工作区</div>
      <div className="bp-folder"><Folder size={16}/>店铺管理</div>
      <div className="bp-selected"><span/>搭建店铺登记表</div>
      <div className="bp-folder"><Folder size={16}/>客户登记系统</div>
      <div className="bp-nav-note">现有业务和记录保留不变</div>
      <div className="bp-person"><b>B</b><span>搭建者<small>可微科技</small></span></div>
    </aside>
    <main className="bp-main">
      <header className="bp-header"><div><span className="bp-breadcrumb">店铺管理 <ChevronRight size={13}/></span><strong>搭建店铺登记表</strong></div><span className="bp-demo">交互预览 · 未连接真实审批</span></header>
      <div className="bp-mobile-tabs"><button aria-pressed={tab === 'preview'} onClick={() => setTab('preview')}>表单预览</button><button aria-pressed={tab === 'chat'} onClick={() => setTab('chat')}>搭建对话</button></div>
      <div className="bp-workspace" data-mobile-tab={tab}>
        <section className="bp-chat" aria-label="搭建对话">
          <div className="bp-chat-heading"><MessageSquare size={18}/><strong>一起完善表单</strong><span>交互演示</span></div>
          <div ref={conversation} className="bp-messages" aria-live="polite">{messages.map((message, index) => <div key={index} className={'bp-message ' + message.role}>{message.role === 'assistant' && <b className="bp-ai">K</b>}<p>{message.text}</p></div>)}<div className="bp-ready"><span/><span>{confirmed ? '当前预览已确认（演示）' : '预览可试填，等待你核对'}</span></div></div>
          <div className="bp-composer-wrap"><span className="bp-suggestion-label">可以试着这样修改</span><div className="bp-suggestions"><button disabled={confirmed} onClick={() => modify('把联系电话改为选填')}>电话改为选填</button><button disabled={confirmed} onClick={() => modify('新增联系地址')}>新增联系地址</button></div>
            {confirmed && <button className="bp-continue" onClick={() => { setConfirmed(false); setNotice(''); }}>继续修改草稿</button>}
            <form className="bp-composer" onSubmit={e => { e.preventDefault(); modify(input); }}><textarea aria-label="描述表单修改" disabled={confirmed} value={input} onChange={e => setInput(e.target.value)} placeholder="告诉我哪里要改，例如：把联系电话改为选填" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); modify(input); } }}/><div><span>只讨论业务，过程由后台处理</span><button className="bp-send" aria-label="发送修改建议" disabled={!input.trim() || confirmed}><ArrowUp size={19}/></button></div></form>
            <small className="bp-disclaimer">当前仅演示列出的修改，不会调用真实 AI。</small>
          </div>
        </section>
        <section className="bp-preview" aria-label="表单预览">
          <div className="bp-preview-heading"><div><span className="bp-eyebrow">表单预览</span><h1>店铺登记表</h1><p>先试填看看，有哪里不合适，直接在左侧告诉我。</p></div><span className="bp-state">{confirmed ? '已确认 · 演示' : '草稿'}</span></div>
          <div className="bp-preview-scroll">
            <article className="bp-card">
              <div className="bp-card-title"><div className="bp-form-icon"><FileText size={23}/></div><div><h2>店铺信息</h2><p>带 <span className="bp-required">*</span> 为必填项</p></div><span>{fields.length} 项信息</span></div>
              <div className="bp-fields">{fields.map(field => <label key={field.id} className={(field.type === 'textarea' ? 'bp-full ' : '') + (changed.includes(field.id) ? 'bp-changed' : '')}>
                <span>{field.name}{field.required && <b className="bp-required"> *</b>}{changed.includes(field.id) && <em>刚刚调整</em>}</span>
                {field.type === 'select' ? <select aria-label={field.name} aria-required={field.required} aria-invalid={!!errors[field.id]} value={values[field.id] || ''} onChange={e => setValues(v => ({ ...v, [field.id]: e.target.value }))}><option value="">请选择</option>{field.options.map(option => <option key={option}>{option}</option>)}</select>
                  : field.type === 'textarea' ? <textarea aria-label={field.name} value={values[field.id] || ''} placeholder="其他需要说明的内容" rows={3} onChange={e => setValues(v => ({ ...v, [field.id]: e.target.value }))}/>
                  : <input aria-label={field.name} aria-required={field.required} aria-invalid={!!errors[field.id]} type={field.type} placeholder={field.id === 'account' ? '例如：my-shop' : '请输入' + field.name} value={values[field.id] || ''} onChange={e => setValues(v => ({ ...v, [field.id]: e.target.value }))}/>}
                {field.unique && <small>相同店铺账号不能重复登记</small>}
                {errors[field.id] && <small className="bp-error">{errors[field.id]}</small>}
              </label>)}</div>
              <div className="bp-trial"><span>试填不会保存业务记录。重复示例账号：demo-shop</span><button onClick={trial}>检查试填</button></div>
            </article>
            <section className="bp-permissions"><ShieldCheck size={19}/><div><h3>谁可以使用</h3><p>登记人员可填写和修改，查看人员仅查看。这是示例范围，不会改变真实权限。</p><label><input type="checkbox" checked={permission} onChange={e => { setPermission(e.target.checked); setConfirmed(false); }}/><span>已核对这个示例使用范围</span></label></div></section>
          </div>
          <footer className="bp-confirm"><div><strong>{confirmed ? '当前预览已确认' : permission ? '请核对表单后确认' : '还需确认使用范围'}</strong><small>确认后交给所有者审批，不会直接发布</small></div><button className="bp-primary" disabled={!permission || confirmed || !!input.trim()} onClick={() => { setConfirmed(true); setNotice('演示：已确认当前预览。没有提交真实审批，也没有发布。'); }}><Check size={16}/>{confirmed ? '已确认（演示）' : '确认提交（演示）'}</button></footer>
        </section>
      </div>
      {notice && <div className="bp-notice" role="status"><span>{notice}</span><button onClick={() => setNotice('')} aria-label="关闭提示">×</button></div>}
    </main>
  </div>;
}
