import { useEffect, useRef, useState } from 'react';
import { Bell, Box, UsersRound, ChartNoAxesCombined, ChevronDown, ChevronRight, CirclePlus, FileText, Folder, LayoutTemplate, ListFilter, MessageSquare, MoreHorizontal, PanelLeft, Pencil, Plus, Puzzle, Search, Send, Settings, Table2, Trash2, X } from 'lucide-react';
import { BusinessColumnResize, BusinessRightbar, useBusinessDock, useViewportWidth } from './dsh/BusinessRightbar.jsx';
import { businessDestination, initialGroupedHubData, removeBusinessGroup, visibleBusinessResources, prototypeReply, roleNames } from './business-hub-data.js';
import './business-hub.css';
import { FusionFields, PreviewForm } from './FusionFields.jsx';
import './fusion.css';


const icons = { form: FileText, dashboard: ChartNoAxesCombined, report: Table2, group: Folder };
const kindNames = { form: '表单', dashboard: '仪表盘', report: '报表', group: '分组' };
const uid = () => crypto.randomUUID();
function Icon({ as: Component, size = 18 }) { return <Component size={size} strokeWidth={1.65} aria-hidden="true"/>; }
function HubDialog({ title, children, onClose, wide = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const controls = () => [...ref.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select,textarea')];
    controls().find(el => el.tagName === 'INPUT')?.focus();
    const handle = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const items = controls(), first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    const dialog = ref.current; dialog.addEventListener('keydown', handle);
    return () => { dialog.removeEventListener('keydown', handle); previous?.isConnected && previous.focus(); };
  }, []);
  return <div className="hub-backdrop"><section ref={ref} className={'hub-dialog' + (wide ? ' fusion-dialog' : '')} role="dialog" aria-modal="true" aria-label={title}><header><div><small className="fusion-eyebrow">{wide ? '业务办理 · 示例数据' : '7506 交互原型'}</small><h2>{title}</h2></div><button aria-label="关闭弹窗" onClick={onClose}><Icon as={X}/></button></header>{children}</section></div>;
}
function AssistantBody({ system, page, selectedRecord, conversation, message, setMessage, sendMessage, openDetails }) {
  return <div className="hub-assistant">
    <div className="hub-context"><Icon as={FileText}/><div><small>{selectedRecord ? '当前记录' : '当前表单'}</small><strong>{selectedRecord?.values.code || selectedRecord?.values.name || page.name}</strong><small>来自 {system.name} · {page.name}</small></div></div>
    <div className="hub-messages" aria-live="polite">{!conversation.length && <p className="hub-muted">{selectedRecord ? '可以问：这单还缺什么信息？' : '可以选中记录提问，或问当前表单有多少条记录。'}</p>}{conversation.map((m, index) => <div key={index}><p className="hub-user-message">{m.question}</p><p className="hub-ai-message">{m.reply}</p></div>)}{selectedRecord && <button onClick={openDetails}>打开记录<Icon as={ChevronRight} size={14}/></button>}</div>
    <form className="hub-chat-input" onSubmit={e => { e.preventDefault(); sendMessage(); }}><textarea aria-label="业务提问" placeholder={selectedRecord ? '针对这条记录提问…' : '针对当前业务提问…'} value={message} onChange={e => setMessage(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendMessage(); } }}/><button className="primary" aria-label="发送业务提问" disabled={!message.trim()}><Icon as={Send}/></button></form>
  </div>;
}
function RecordBody({ row, business, editRecord }) {
  return row ? <div className="hub-record-detail"><h2>记录详情</h2><dl>{business.fields.map(f => <div key={f.id}><dt>{f.name}</dt><dd>{row.values[f.id] || '尚未填写'}</dd></div>)}</dl><button className="primary" onClick={() => editRecord(row)}>修改记录</button></div> : <p>请先选择一条记录。</p>;
}
function FormEntryBody(props) { return <PreviewForm {...props}/>; }
function RecordsEntryBody({ records, business, dock, editRecord }) { return <div className="hub-side-records"><header><h2>{business.formName}列表</h2><button className="primary" onClick={() => editRecord()}><Icon as={Plus} size={14}/>新增</button></header><div className="hub-side-table"><table><thead><tr>{business.fields.map(f=><th key={f.id}>{f.name}</th>)}</tr></thead><tbody>{records.map(row=><tr key={row.id}>{business.fields.map((f,index)=><td key={f.id}>{index===0 ? <button onClick={()=>dock.openRecord(row.id)}>{row.values[f.id] || '查看记录'}</button> : row.values[f.id] || '—'}</td>)}</tr>)}</tbody></table></div>{!records.length && <p className="hub-muted">暂时没有记录，可新增第一条。</p>}<small>共 {records.length} 条记录</small></div>; }

function ConfigEntryBody({ business, launchDesign }) { return <><h2>表单设计</h2><p className="hub-muted">{business.fields.map(f => f.name).join(' · ')}</p><button onClick={launchDesign}>修改字段</button></>; }
const bodies = { 'kvvi-prototype/assistant': AssistantBody, 'kvvi-prototype/record': RecordBody, 'kvvi-prototype/form': FormEntryBody, 'kvvi-prototype/records': RecordsEntryBody, 'kvvi-prototype/config': ConfigEntryBody };

function WorkspaceConversation({ system, page, conversation, message, setMessage, sendMessage, dock, newRecord, builder, reviewState, submitReview, launchDesign }) {
  return <div className="hub-workspace-conversation"><header><div className="fusion-workspace-title"><strong>{page.name}</strong><span className="fusion-mode">{builder ? '搭建者模式' : '员工模式'}</span></div><div><button onClick={() => dock.openForm()}>界面预览</button><button onClick={() => dock.openRecords()}>业务记录</button>{builder && <button className="primary" disabled={reviewState === 'pending'} onClick={submitReview}>{reviewState === 'pending' ? '待审核（模拟）' : '提交发布'}</button>}</div></header><nav className="hub-workspace-tabs"><span>对话</span><small>{builder ? '描述需求 → 调整预览 → 提交审核' : '对话协助 · 核对后提交'}</small></nav><div className="hub-workspace-messages">{!conversation.length ? <div className="hub-workspace-hero"><img src="/kvvi-mark.svg" alt=""/><h1>{builder ? '把业务想法，变成可用的系统' : '今天想完成什么？'}</h1><p>{builder ? '在左侧描述需求，在右侧检查表单与操作流程。' : '登记信息、查看记录，或请 AI 协助处理。'}</p><div className="fusion-quick-actions"><button onClick={() => dock.openForm()}>预览当前表单</button><button onClick={builder ? launchDesign : newRecord}>{builder ? '调整表单字段' : '登记新客户'}</button></div><small>此处 AI 为规则演示，不会实际生成系统。</small></div> : conversation.map((m,i) => <div key={i}><p className="hub-user-message">{m.question}</p><p className="hub-ai-message">{m.reply}</p></div>)}</div><div className="hub-workspace-composer"><small>{system.name} · {page.name}</small><form onSubmit={e=>{e.preventDefault();sendMessage();}}><textarea aria-label="工作区会话输入" placeholder={builder ? '描述你想调整的字段、表单或业务流程…' : '描述你需要办理的事项…'} value={message} onChange={e=>setMessage(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();sendMessage();}}}/><div><button type="button" onClick={newRecord}><Icon as={Plus}/>试填表单</button><button className="primary" aria-label="发送会话" disabled={!message.trim()}><Icon as={Send}/></button></div></form></div></div>;
}
export function BusinessHub() {
  const [data, setData] = useState(initialGroupedHubData);
  const [role, setRole] = useState('builder');
  const [systemId, setSystemId] = useState(() => businessDestination(data.systems, role).systemId), [pageId, setPageId] = useState('gad:orders');
  const [workspaceIds, setWorkspaceIds] = useState(['customer:register']);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem('kvvi-hub-sidebar') !== 'collapsed');
  const [pageQuery, setPageQuery] = useState(''), [rowQuery, setRowQuery] = useState(''), [filter, setFilter] = useState('');
  const [groups, setGroups] = useState({'gad:general':true, 'customer:general':true}), [menu, setMenu] = useState(null), [dialog, setDialog] = useState(null), [form, setForm] = useState({});
  const [selected, setSelected] = useState(null), [threads, setThreads] = useState({}), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [toast, setToast] = useState(''), [fullConversation, setFullConversation] = useState(false), [workspaceSession, setWorkspaceSession] = useState('intro');
  const [recordDrafts, setRecordDrafts] = useState({}), [reviews, setReviews] = useState({});
  const timer = useRef(null);
  const builder = role === 'builder' || role === 'owner';
  const system = data.systems.find(s => s.id === systemId);
  const available = visibleBusinessResources(system?.resources || [], builder);
  const page = available.find(r => r.id === pageId) || available.find(r => r.kind !== 'group');
  const recordsKey = `${systemId}/${page?.id}`;
  const records = data.records[recordsKey] || [];
  const selectedRecord = records.find(r => r.id === selected);
  const business = { id: systemId || 'home', name: system?.name || '业务', formName: page?.name || '业务记录', fields: page?.fields || [] };
  const scope = `business-hub-v2:${fullConversation ? 'workspace' : 'business'}:${role}:${systemId || 'home'}:${page?.id || 'empty'}`;
  const { dock, layout } = useBusinessDock(scope, business, builder);
  const [presentation, setPresentation] = useState({ track: false, fullscreen: false });
  const viewportWidth = useViewportWidth();
  const [panelWidths, setPanelWidths] = useState({ business: 360, workspace: 420 });
  const surface = fullConversation ? 'workspace' : 'business';
  const maxPanelWidth = Math.max(280, Math.min(680, viewportWidth - (sidebar ? 230 : 64) - 460));
  const panelWidth = Math.min(panelWidths[surface], maxPanelWidth);
  const chatKey = scope + ':' + (fullConversation ? workspaceSession : selected || 'all');
  const conversation = threads[chatKey] || [];
  useEffect(() => { dock.collapse(); setMessage(''); }, [dock]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    const close = e => { if (!e.target.closest('[data-hub-menu]')) setMenu(null); };
    const escape = e => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, []);
  function notify(text) { setToast(text); clearTimeout(timer.current); timer.current = setTimeout(() => setToast(''), 3500); }
  function closeDialog(discard = false) { if (dialog === 'record' && discard !== true) setRecordDrafts(d => ({...d, [role + ':' + recordsKey + ':' + (form.rowId || 'new')]: structuredClone(form)})); setDialog(null); setError(''); }
  function launch(type, values = {}) { setMenu(null); setForm(values); setError(''); setDialog(type); }
  function toggleSidebar() { setSidebar(v => { localStorage.setItem('kvvi-hub-sidebar', v ? 'collapsed' : 'expanded'); return !v; }); }
  function home(nextRole = role, systems = data.systems) { const next = businessDestination(systems, nextRole, systemId, pageId); setSystemId(next.systemId); setPageId(next.pageId); setSelected(null); setMenu(null); setFullConversation(false); setPageQuery(''); setRowQuery(''); setFilter(''); }
  function enter(next) { setSystemId(next.id); setPageId(businessDestination([next], role, next.id).pageId); setSelected(null); setRowQuery(''); setPageQuery(''); setFilter(''); setMenu(null); setFullConversation(false); }
  function pickPage(next) { setPageId(next.id); if (next.group) setGroups(v => ({...v, [next.group]:true})); setSelected(null); setRowQuery(''); setFilter(''); setMessage(''); setMenu(null); setFullConversation(false); }
  function patchSystem(patch) { setData(d => ({ ...d, systems: d.systems.map(s => s.id === systemId ? { ...s, ...patch } : s) })); }
  function sendMessage() {
    const question = message.trim(); if (!question || !page) return;
    const isForm = fullConversation && /填写|登记|提交|新增/.test(question);
    const reply = isForm ? '表单已打开，请核对后提交。' : prototypeReply(question, selectedRecord, records, page.name);
    if (fullConversation) { if (isForm) dock.openForm(); else if (/查|记录|列表/.test(question)) dock.openRecords(); }
    setThreads(all => ({ ...all, [chatKey]: [...(all[chatKey] || []), { question, reply }] })); setMessage('');
  }
  function editRecord(row) { const key = role + ':' + recordsKey + ':' + (row?.id || 'new'); launch('record', recordDrafts[key] || { rowId: row?.id || null, values: {...(row?.values || Object.fromEntries((page?.fields || []).map(f => [f.id, f.type === 'date' ? '2026-10-09' : f.id === 'owner' ? '陈晓' : f.type === 'select' ? f.options?.[0] || '' : '']))) } }); }
  function save() {
    if (dialog === 'record') {
      const fields = page.fields;
      const missing = fields.find(f => f.required && !String(form.values[f.id] || '').trim());
      if (missing) { setError('请填写' + missing.name); return; }
      if (fields.some(f => f.type === 'number' && form.values[f.id] && (!Number.isFinite(Number(form.values[f.id])) || Number(form.values[f.id]) < 0))) { setError('请填写有效的非负金额'); return; }
      const row = { id: form.rowId || uid(), values: { ...form.values } };
      setData(d => ({ ...d, records: { ...d.records, [recordsKey]: form.rowId ? (d.records[recordsKey] || []).map(r => r.id === row.id ? row : r) : [...(d.records[recordsKey] || []), row] } })); setRecordDrafts(d => { const next = {...d}; delete next[role + ':' + recordsKey + ':' + (form.rowId || 'new')]; return next; }); setSelected(row.id); closeDialog(true); if (fullConversation) dock.openRecords(); notify('记录已保存到示例数据'); return;
    }
    const name = (form.name || '').trim(); if (!name) { setError('请填写名称'); return; }
    if (dialog === 'rename-group') {
      if (system.resources.some(r => r.kind === 'group' && r.name === name && r.id !== form.id)) { setError('已有同名分组'); return; }
      patchSystem({resources:system.resources.map(r => r.id === form.id ? {...r,name} : r)});
    } else if (dialog === 'system' || dialog === 'rename-system') {
      if (data.systems.some(s => s.name === name && s.id !== form.id)) { setError('已有同名业务'); return; }
      if (dialog === 'system') {
        const next = { id: uid(), name, description: form.description || '', published: false, resources: [] };
        setData(d => ({ ...d, systems: [...d.systems, next] })); setWorkspaceIds(ids => [...ids, next.id]); enter(next); notify('业务已创建，接着添加表单');
      } else setData(d => ({ ...d, systems: d.systems.map(s => s.id === form.id ? { ...s, name } : s) }));
    } else if (dialog === 'resource') {
      if (system.resources.some(r => r.name === name)) { setError('已有同名页面'); return; }
      const next = { id: uid(), name, kind: form.kind, group: form.group || null, published: false, fields: form.kind === 'form' ? [{ id: 'name', name: '名称', required: true, type: 'text' }, { id: 'note', name: '备注', type: 'text' }] : [] };
      patchSystem({ resources: [...system.resources, next] });
      if (next.group) setGroups(v => ({...v,[next.group]:true}));
      if (next.kind === 'group') setGroups(v => ({ ...v, [next.id]: true })); else { setPageId(next.id); if (next.group) setGroups(v => ({...v, [next.group]:true})); setSelected(null); setRowQuery(''); setFilter(''); }
      notify(kindNames[next.kind] + '已创建');
    } else if (dialog === 'design') {
      if (form.group) setGroups(v => ({...v, [form.group]:true}));
      setPageQuery('');
      if (system.resources.some(r => r.name === name && r.id !== page.id)) { setError('已有同名页面'); return; }
      if (form.fields.some(f => !f.name.trim()) || new Set(form.fields.map(f => f.name.trim())).size !== form.fields.length) { setError('字段名称不能为空或重复'); return; }
      patchSystem({ resources: system.resources.map(r => r.id === page.id ? { ...r, name, group: form.group || null, fields: form.fields, published: false } : r) }); notify('表单设计已保存为草稿');
    }
    closeDialog();
  }
  function deleteObject() {
    if (form.target === 'group') { setData(d => removeBusinessGroup(d, form.id)); closeDialog(); notify('分组已删除，表单和记录保留在未分组'); return; }
    if (form.target === 'system') { setData(d => ({ ...d, systems: d.systems.filter(s => s.id !== form.id), records: Object.fromEntries(Object.entries(d.records).filter(([key]) => !key.startsWith(form.id + '/'))) })); if (systemId === form.id) home(role, data.systems.filter(s => s.id !== form.id)); }
    else { const removed = new Set([form.id, ...system.resources.filter(r => r.group === form.id).map(r => r.id)]); patchSystem({ resources: system.resources.filter(r => !removed.has(r.id)) }); if (removed.has(pageId)) setPageId(null); setData(d => ({ ...d, records: Object.fromEntries(Object.entries(d.records).filter(([key]) => ![...removed].some(id => key === systemId + '/' + id))) })); }
    closeDialog(); notify('已删除示例内容');
  }
  function openAI() { setFullConversation(false); dock.openAssistant(); }
  function openDetails() { if (selectedRecord) dock.openRecord(selectedRecord.id); }
  function newChat() {
    if (!system || !page) { const s = data.systems.find(s => s.id === 'customer') || data.systems.find(s => builder || s.published); if (s) enter(s); else { notify('请先创建一个业务和表单'); return; } }
    if (page) setWorkspaceIds(ids => ids.includes(page.id) ? ids : [...ids, page.id]);
    setSelected(null); setWorkspaceSession(uid()); setFullConversation(true); dock.collapse(); setMessage('');
  }
  const assistantModel = { system, page, selectedRecord, conversation, message, setMessage, sendMessage, openDetails };
  const visibleRows = records.filter(r => Object.values(r.values).some(v => String(v).includes(rowQuery)) && (!filter || r.values.status === filter));
  const formFields = page?.fields || [];
  const columns = formFields.slice(0, 6);
  const countRows = data.records[`${systemId}/gad:orders`] || records;
  function resourceButton(r) {
    const isGroup = r.kind === 'group';
    const children = available.filter(child => child.group === r.id && (r.name.includes(pageQuery) || child.name.includes(pageQuery)));
    if (isGroup && pageQuery && !r.name.includes(pageQuery) && !children.length) return null;
    return <div key={r.id}><div className="hub-group-row"><button className={'hub-resource ' + (page?.id === r.id ? 'active' : '')} aria-expanded={isGroup ? !!(groups[r.id] || pageQuery) : undefined} onClick={() => isGroup ? setGroups(v => ({ ...v, [r.id]: !v[r.id] })) : pickPage(r)}><Icon as={icons[r.kind]}/><span>{r.name}</span>{isGroup && <Icon as={groups[r.id] ? ChevronDown : ChevronRight} size={14}/>}</button>{isGroup && builder && <div className="hub-menu-anchor" data-hub-menu><button className="hub-group-more" aria-label={'管理分组：' + r.name} onClick={() => setMenu(menu === r.id ? null : r.id)}><Icon as={MoreHorizontal} size={15}/></button>{menu === r.id && <div className="hub-menu"><button onClick={() => launch('resource',{kind:'form',name:'',group:r.id})}>新增表单</button><button onClick={() => launch('rename-group',{id:r.id,name:r.name})}>重命名分组</button><button className="hub-danger" onClick={() => launch('delete',{target:'group',id:r.id,name:r.name})}>删除分组（保留表单）</button></div>}</div>}</div>{isGroup && (groups[r.id] || pageQuery) && <div className="hub-resource-children">{children.map(resourceButton)}{!children.length && <small className="hub-group-empty">暂无表单</small>}</div>}</div>;
  }
  return <>
    <div className="hub-demo"><span>7506 · 融合设计评审</span><div>{Object.entries(roleNames).map(([key, name]) => <button className={role === key ? 'active' : ''} key={key} onClick={() => { setRole(key); setMenu(null); closeDialog(); home(key); }}>{name}</button>)}</div><span>独立原型 · 不影响 7500 · 刷新重置示例</span></div>
    <div className={'hub-frame ' + (!sidebar ? 'hub-collapsed ' : '')} style={{ '--hub-left': sidebar ? '230px' : '64px', '--hub-right': system && presentation.track ? panelWidth + 'px' : '0px' }}>
      <aside className="hub-global"><div className="hub-brand"><img src="/kvvi-mark.svg" alt=""/>{sidebar && <strong>可微科技</strong>}<button aria-label={sidebar ? '收起全局侧栏' : '展开全局侧栏'} onClick={toggleSidebar}><Icon as={PanelLeft}/></button></div><button className="hub-new-chat" title="新会话" onClick={newChat}><Icon as={CirclePlus}/>{sidebar && '新会话'}</button><nav><button className={!fullConversation ? 'active' : ''} title="业务" onClick={() => home()}><Icon as={LayoutTemplate}/>{sidebar && '业务'}</button><button title="插件" onClick={() => launch('plugins')}><Icon as={Puzzle}/>{sidebar && '插件'}</button></nav><div className="hub-workspace-heading">{sidebar ? '工作区' : <Icon as={Folder}/>}</div><div className="hub-workspaces">{available.filter(r => workspaceIds.includes(r.id)).map(r => <div key={r.id}><button title={r.name} onClick={() => { pickPage(r); setFullConversation(true); }}><Icon as={Folder}/>{sidebar && r.name}</button>{sidebar && r.id === "customer:register" && <button className="hub-session" onClick={() => { pickPage(r); setFullConversation(true); }}>客户登记所需填写信息</button>}</div>)}</div><footer><button data-hub-menu title="个人信息与设置" onClick={() => setMenu(menu === 'profile' ? null : 'profile')}><img src="/demo-avatar.png" alt=""/>{sidebar && <strong>陈晓</strong>}</button><button aria-label="公司通知" onClick={() => launch('notifications')}><Icon as={Bell}/></button></footer></aside>
      {system && presentation.track && !presentation.fullscreen && <BusinessColumnResize side="right" width={panelWidth} maxWidth={maxPanelWidth} onResize={next => setPanelWidths(widths => ({ ...widths, [surface]: Math.max(280, Math.min(maxPanelWidth, next)) }))}/>}
      <main className="hub-main">
        {!system ? <div className="hub-empty"><h1>暂无可用业务</h1><p>请联系搭建者发布表单。</p>{builder && <button className="primary" onClick={() => launch('system', {name:'',description:''})}>新建业务</button>}</div> : fullConversation && page ? <WorkspaceConversation {...assistantModel} dock={dock} newRecord={() => editRecord()} builder={builder} reviewState={reviews[recordsKey]} submitReview={() => { setReviews(r => ({...r, [recordsKey]: "pending"})); notify("已模拟提交审核，未发布到 7500"); }} launchDesign={() => launch("design", {name: page.name, group: page.group || '', fields: structuredClone(page.fields)})}/> : <>
          <header className="hub-business-header"><div><h1>业务<small>{builder ? "搭建者模式" : "员工模式"} · {roleNames[role]}</small></h1><p className="hub-muted">按分组管理表单与业务记录</p></div><div className="hub-form-actions">{builder && <><button onClick={() => launch('resource', {kind:'group',name:''})}><Icon as={Folder}/>新增分组</button><button className="primary" onClick={() => launch('resource', {kind:'form',name:'',group:page?.group || ''})}><Icon as={Plus}/>新增表单</button></>}{builder && page?.kind === 'form' && <><button onClick={() => launch('design', { name: page.name, group: page.group || '', fields: structuredClone(page.fields) })}><Icon as={Pencil}/>编辑表单</button><button className="hub-danger" onClick={() => launch('delete', {target:'resource',id:page.id,name:page.name})}><Icon as={Trash2}/>删除表单</button></>}{page && <button className="hub-ai-toggle" aria-pressed={layout.expanded} onClick={() => layout.expanded ? dock.collapse() : openAI()}><Icon as={MessageSquare}/>AI协助</button>}</div></header>
          <div className="hub-business-body"><aside className="hub-local"><div className="hub-local-tools"><div className="hub-search"><Icon as={Search} size={15}/><input aria-label="搜索业务页面" placeholder="搜索表单" value={pageQuery} onChange={e => setPageQuery(e.target.value)}/></div>{builder && <div className="hub-menu-anchor" data-hub-menu><button aria-label="新建业务页面" onClick={() => setMenu(menu === 'resource' ? null : 'resource')}><Icon as={Plus}/></button>{menu === 'resource' && <div className="hub-menu">{Object.entries(kindNames).map(([kind, name]) => <button key={kind} onClick={() => launch('resource', { kind, name: '', group: '' })}><Icon as={icons[kind]}/>{name}</button>)}</div>}</div>}</div><nav aria-label="业务页面目录">{available.filter(r => r.kind === 'group').map(resourceButton)}{available.some(r => !r.group && r.kind !== 'group' && r.name.includes(pageQuery)) && <div className="hub-ungrouped"><small>未分组</small>{available.filter(r => !r.group && r.kind !== 'group' && r.name.includes(pageQuery)).map(resourceButton)}</div>}</nav></aside>
          <section className="hub-work-content">{!page ? <div className="hub-empty"><Icon as={FileText} size={35}/><h2>添加第一张表单</h2><p>表单建好后，就可以登记和查看业务记录。</p>{builder && <button className="primary" onClick={() => launch('resource', { kind: 'form', name: '', group: '' })}>新建表单</button>}</div> : fullConversation ? <><div className="hub-content-heading"><h2>{page.name} · 会话</h2><button onClick={() => setFullConversation(false)}>返回业务页面</button></div><div className="hub-full-chat"><AssistantBody {...assistantModel}/></div></> : <>
            <div className="hub-content-heading"><h2>{page.name}</h2>{builder && <div className="hub-menu-anchor" data-hub-menu><button aria-label="管理当前页面" onClick={() => setMenu(menu === 'page' ? null : 'page')}><Icon as={MoreHorizontal}/></button>{menu === 'page' && <div className="hub-menu">{page.kind === 'form' && <button onClick={() => launch('design', { name: page.name, group: page.group || '', fields: structuredClone(page.fields) })}>修改表单</button>}<button onClick={() => launch('rename-page', { name: page.name })}>重命名页面</button>{!page.published && <button onClick={() => { patchSystem({ resources: system.resources.map(r => r.id === page.id ? { ...r, published: true } : r), published: true }); setMenu(null); notify('示例页面已发布'); }}>发布示例页面</button>}<button className="hub-danger" onClick={() => launch('delete', { target: 'resource', id: page.id, name: page.name })}>删除页面</button></div>}</div>}</div>
            {page.kind === 'form' ? <><div className="hub-table-tools"><button className="primary" onClick={() => editRecord()}><Icon as={Plus}/>新增记录</button><div className="hub-search"><Icon as={Search} size={16}/><input aria-label="搜索当前表单记录" placeholder={'搜索' + page.name} value={rowQuery} onChange={e => setRowQuery(e.target.value)}/></div><div className="hub-menu-anchor" data-hub-menu><button className={filter ? 'active' : ''} onClick={() => setMenu(menu === 'filter' ? null : 'filter')}><Icon as={ListFilter}/>筛选{filter && ' · ' + filter}</button>{menu === 'filter' && <div className="hub-menu">{['', ...new Set(records.map(r => r.values.status).filter(Boolean))].map(status => <button key={status || 'all'} onClick={() => { setFilter(status); setMenu(null); }}>{status || '全部记录'}</button>)}</div>}</div></div><div className="hub-table-scroll"><table className="hub-records-table"><thead><tr><th/><th>{columns[0]?.name}</th>{columns.slice(1).map(f => <th key={f.id}>{f.name}</th>)}<th/></tr></thead><tbody>{visibleRows.map(row => <tr key={row.id} className={row.id === selected ? 'selected' : ''}><td><input type="checkbox" aria-label={'选择记录：' + (row.values[formFields[0]?.id] || row.id)} checked={row.id === selected} onChange={() => { setSelected(selected === row.id ? null : row.id); setMessage(''); }}/></td>{columns.map((f, index) => <td key={f.id}>{index === 0 ? <button className="hub-link" onClick={() => { setSelected(row.id); dock.openRecord(row.id); }}>{row.values[f.id] || '—'}</button> : f.id === 'status' ? <span className={'hub-status ' + (row.values.status === '已发货' ? 'done' : '')}>{row.values.status || '—'}</span> : f.type === 'number' ? Number(row.values[f.id] || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2 }) : row.values[f.id] || '—'}</td>)}<td><button className="hub-edit-row" aria-label={'编辑记录：' + row.values[formFields[0]?.id]} onClick={() => editRecord(row)}><Icon as={Pencil} size={15}/></button></td></tr>)}</tbody></table>{!visibleRows.length && <div className="hub-empty">{records.length ? '没有匹配的记录，可以清除搜索或筛选。' : '还没有记录，可以新增第一条。'}</div>}</div><div className="hub-table-footer"><span>共 {visibleRows.length} 条记录</span>{selectedRecord && <button className="hub-link" onClick={openAI}>针对选中记录提问</button>}<span>1 / 1</span></div></> : <div className="hub-summary"><p className="hub-muted">根据当前业务的报货单示例记录汇总</p>{page.kind === 'dashboard' ? <div className="hub-metrics"><div><small>报货单</small><strong>{countRows.length} 条</strong></div><div><small>待发货</small><strong>{countRows.filter(r => r.values.status === '待发货').length} 条</strong></div><div><small>总金额</small><strong>¥ {countRows.reduce((n, r) => n + (Number(r.values.amount) || 0), 0).toLocaleString('zh-CN')}</strong></div></div> : <table><thead><tr><th>发货状态</th><th>记录数</th><th>金额</th></tr></thead><tbody>{['待发货', '已发货'].map(status => <tr key={status}><td>{status}</td><td>{countRows.filter(r => r.values.status === status).length}</td><td>{countRows.filter(r => r.values.status === status).reduce((n, r) => n + (Number(r.values.amount) || 0), 0).toLocaleString('zh-CN')}</td></tr>)}</tbody></table>}</div>}
          </>}</section></div>
        </>}
      </main>
      {system && page && <BusinessRightbar side="right" key={dock.sessionId} dock={dock} width={panelWidth} viewportWidth={viewportWidth} syncPresentation={setPresentation} model={{ ...assistantModel, business, records, bodies, recordsTitle: page.name + '列表', selectRecord: setSelected, editRecord, launchDesign: () => launch('design', { name: page.name, group: page.group || '', fields: structuredClone(page.fields) }), dock }}/>}
    </div>
    {menu === 'profile' && <div className="hub-profile-menu" data-hub-menu><strong>陈晓 · {roleNames[role]}</strong><button onClick={() => launch('profile')}>个人信息</button><button onClick={() => launch('settings')}><Icon as={Settings}/>设置</button></div>}
    {dialog && <HubDialog wide={dialog === "record"} title={dialog === 'rename-group' ? '重命名分组' : dialog === 'system' ? '新建业务' : dialog === 'rename-system' ? '重命名业务' : dialog === 'rename-page' ? '重命名页面' : dialog === 'resource' ? '新建' + kindNames[form.kind] : dialog === 'record' ? form.rowId ? '修改记录' : '新增记录' : dialog === 'design' ? '设计表单' : dialog === 'delete' ? '删除确认' : ({ notifications: '公司通知', profile: '个人信息', settings: '设置', plugins: '插件' })[dialog]} onClose={closeDialog}>
      {['system', 'rename-system', 'resource', 'design', 'rename-page', 'rename-group'].includes(dialog) && <label>{dialog.includes('system') || dialog === 'system' ? '业务名称' : '名称'}<input aria-label="名称" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })}/></label>}
      {dialog === 'system' && <label>业务说明<textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="这个业务用来做什么？"/></label>}
      {((dialog === 'resource' && form.kind !== 'group') || dialog === 'design') && <label>放入分组<select value={form.group || ''} onChange={e => setForm({ ...form, group: e.target.value })}><option value="">不分组</option>{system.resources.filter(r => r.kind === 'group').map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
      {dialog === 'record' && <div className="fusion-editor"><section><div className="fusion-form-heading"><div><h3>{page.name}</h3><p>填写业务信息，核对后提交。</p></div><span className="fusion-mode">{form.rowId ? '修改中' : '未提交'}</span></div><FusionFields fields={formFields} values={form.values} onChange={(id,value) => { setForm(f => ({...f, values:{...f.values,[id]:value}})); setError(''); }}/><p className="fusion-hint">草稿在本次浏览中保留 · 刷新页面会重置</p></section><aside><h3><Icon as={MessageSquare}/>AI 协助</h3><p className="fusion-hint">当前为规则演示，不会自动填入或提交表单。</p><AssistantBody {...assistantModel}/></aside></div>}
      {dialog === 'design' && <><div className="hub-field-editor">{form.fields.map((f, index) => <div key={f.id}><input aria-label={'字段名称' + (index + 1)} value={f.name} onChange={e => setForm({ ...form, fields: form.fields.map(field => field.id === f.id ? { ...field, name: e.target.value } : field) })}/><span>{({ text: '文本', number: '数字', date: '日期', select: '单选' })[f.type]}</span><label><input type="checkbox" checked={!!f.required} onChange={e => setForm({ ...form, fields: form.fields.map(field => field.id === f.id ? { ...field, required: e.target.checked } : field) })}/>必填</label><button aria-label={'删除字段：' + f.name} disabled={form.fields.length <= 1} onClick={() => setForm({ ...form, fields: form.fields.filter(field => field.id !== f.id) })}><Icon as={Trash2} size={15}/></button></div>)}</div><button onClick={() => setForm({ ...form, fields: [...form.fields, { id: uid(), name: '新字段' + (form.fields.length + 1), type: 'text', required: false }] })}><Icon as={Plus}/>添加字段</button></>}
      {dialog === 'delete' && <p>{form.target === 'group' ? <>删除分组「{form.name}」？其中表单和记录会保留，并移至未分组。</> : <>删除「{form.name}」及其中的示例内容？此操作仅影响当前原型。</>}</p>}
      {dialog === 'notifications' && <p>暂时没有新的公司通知。这里预留公司通知入口。</p>}
      {dialog === 'profile' && <p>陈晓 · 可微科技 · {roleNames[role]}</p>}
      {dialog === 'settings' && <button onClick={() => { toggleSidebar(); closeDialog(); }}>切换全局侧栏展开状态</button>}
      {dialog === 'plugins' && <p>保留 DSH 插件入口，本轮主要体验业务工作台。</p>}
      {error && <p className="hub-error" role="alert">{error}</p>}
      <div className="hub-dialog-actions">{dialog === "record" && <span className="fusion-hint">仅保存到当前原型，不写入正式数据库</span>}<button onClick={closeDialog}>{dialog === "record" ? "保存草稿并关闭" : "取消"}</button>{dialog === 'delete' ? <button className="hub-danger" onClick={deleteObject}>删除示例内容</button> : ['system', 'rename-system', 'resource', 'record', 'design', 'rename-page', 'rename-group'].includes(dialog) && <button className="primary" onClick={() => { if (dialog === 'rename-page') { const name = (form.name || '').trim(); if (!name) { setError('请填写名称'); return; } if (system.resources.some(r => r.name === name && r.id !== page.id)) { setError('已有同名页面'); return; } patchSystem({ resources: system.resources.map(r => r.id === page.id ? { ...r, name } : r) }); closeDialog(); } else save(); }}>{dialog === 'system' ? '创建业务' : dialog === 'resource' ? '创建' + kindNames[form.kind] : dialog === 'record' ? (form.rowId ? '保存修改' : '提交登记') : '保存'}</button>}</div>
    </HubDialog>}
    {toast && <div className="hub-toast" role="status">{toast}</div>}
  </>;
}
