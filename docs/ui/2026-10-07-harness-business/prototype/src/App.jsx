import { useEffect, useRef, useState } from 'react';
import { BusinessHub } from './BusinessHub.jsx';
import { BuilderPreview } from './BuilderPreview.jsx';
import { BusinessRightbar, BusinessColumnResize, useBusinessDock, useViewportWidth } from './dsh/BusinessRightbar.jsx';
import { recordAddress } from './dsh/business-dock.js';
import { ArrowUp, ArrowRight, ChevronDown, ChevronRight, PanelLeft, PanelRight, Plus, Search, FolderPlus, Folder, Puzzle, Settings, CirclePlus, FileText, List, X, Check, Pencil, ShieldCheck, History, MessageSquare, LayoutTemplate, Bell, UserRound, ChevronUp } from 'lucide-react';

const initial = [
 {id:'customer',name:'客户登记系统',formName:'客户登记',fields:[
  {id:'name',name:'客户名称',required:true,type:'text'}, {id:'contact',name:'联系人',required:true,type:'text'},
  {id:'phone',name:'电话',required:false,type:'text'}, {id:'status',name:'跟进状态',required:true,type:'select',options:['未跟进','跟进中','已成交','已流失']},
  {id:'owner',name:'负责人',required:false,type:'member'}]},
 {id:'leave',name:'请假申请',formName:'请假登记',fields:[
  {id:'kind',name:'请假类型',required:true,type:'select',options:['事假','年假','病假']}, {id:'start',name:'开始日期',required:true,type:'date'},
  {id:'end',name:'结束日期',required:true,type:'date'}, {id:'reason',name:'请假原因',required:false,type:'textarea'}]}
];
const emptyDraft={values:{},editing:null};
const names={employee:'员工',builder:'搭建者',owner:'所有者'};
function I({as:C,size=17}){return <C size={size} strokeWidth={1.6} aria-hidden="true"/>}

function Modal({title,onClose,children,wide=false}){
 const ref=useRef(null),close=useRef(onClose);close.current=onClose;
 useEffect(()=>{const previous=document.activeElement,dialog=ref.current;
  const controls=()=>[...dialog.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')];
  const all=controls();(all.find(el=>el.tagName!=='BUTTON')||all[0])?.focus();
  const keys=e=>{if(e.key==='Escape'){e.preventDefault();close.current()}if(e.key==='Tab'){const items=controls(),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};
  dialog.addEventListener('keydown',keys);return()=>{dialog.removeEventListener('keydown',keys);if(previous?.isConnected)previous.focus()};
 },[]);
 return <div className="modal-backdrop"><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className={'modal '+(wide?'wide':'')}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭弹窗" onClick={onClose}><I as={X}/></button></header>{children}</section></div>;
}
function Fields({business,draft,setValue,prefix}){
 return <div className="field-grid">{business.fields.map(f=><label key={f.id} htmlFor={prefix+'-'+f.id} className={f.type==='textarea'?'full':''}><span>{f.name}{f.required&&<b className="required">*</b>}</span>{f.type==='select'?<select id={prefix+'-'+f.id} aria-label={f.name} aria-required={f.required} value={draft.values[f.id]||''} onChange={e=>setValue(f.id,e.target.value)}><option value="">请选择</option>{draft.values[f.id]&&!f.options.includes(draft.values[f.id])&&<option>{draft.values[f.id]}</option>}{f.options.map(o=><option key={o}>{o}</option>)}</select>:f.type==='textarea'?<textarea id={prefix+'-'+f.id} aria-label={f.name} aria-required={f.required} rows={3} value={draft.values[f.id]||''} placeholder="补充说明" onChange={e=>setValue(f.id,e.target.value)}/>:<input id={prefix+'-'+f.id} aria-label={f.name} aria-required={f.required} type={f.type==='date'?'date':'text'} inputMode={f.id==='phone'?'tel':undefined} disabled={f.type==='member'} value={f.type==='member'?'陈晓':draft.values[f.id]||''} placeholder={f.type==='member'?'':'请输入'+f.name} onChange={e=>setValue(f.id,e.target.value)}/>}</label>)}</div>;
}
function BusinessForm({business,draft,setValue,submit,notify,error,prefix='page',compact=false}){
 return <><div className="form-title"><div><h2>{draft.editing?'修改记录':business.formName}</h2><p>{draft.editing?'核对修改内容后保存。':'填写信息，核对后提交。'}</p></div><span className="tag">{draft.editing?'修改中':'未提交'}</span></div><Fields {...{business,draft,setValue,prefix}}/>{error&&<p role="alert" className="error">{error}</p>}<div className={'form-actions '+(compact?'compact':'')}><button onClick={()=>notify('草稿已保留，切换页面可继续填写')}>保存草稿</button><button className="primary" onClick={submit}>{draft.editing?'保存修改':'提交登记'}</button></div></>;
}
// Business-only extensions: the DSH sidebar supplies tab chrome and layout.
function DockForm({business,formProps,submit,tab,setTab,dock}){
 return <div className="dock-form-layout"><div className="dock-content-heading"><span className="breadcrumb">{business.name}</span><button className="text-button" onClick={()=>{setTab('form');dock.collapse()}}>完整页面<I as={ArrowRight} size={14}/></button></div><BusinessForm {...formProps} prefix={'dock-'+tab.id} submit={()=>submit(tab.id)} compact/></div>;
}
function DockRecords({business,records,recordsTitle,tab,selectRecord,openForm}){
 const [query,setQuery]=useState('');
 const visible=records.filter(row=>Object.values(row.values).some(v=>String(v).includes(query)));
 return <><div className="form-title"><div><span className="breadcrumb">{business.name}</span><h2>{recordsTitle}</h2></div><span className="tag">{records.length} 条</span></div>
  <input aria-label="搜索侧栏记录" placeholder="搜索当前业务记录" value={query} onChange={e=>setQuery(e.target.value)}/>
  <div className="dock-record-list">{visible.map(row=><button key={row.id} aria-label={'打开记录：'+row.values[business.fields[0]?.id]} onClick={()=>{selectRecord(row.id);tab.actions.openResource(recordAddress(row.id))}}><div><strong>{row.values[business.fields[0]?.id]}</strong><span>{business.fields.slice(1,3).map(f=>row.values[f.id]||'—').join(' · ')}</span></div><I as={ChevronRight}/></button>)}</div>
  {!visible.length&&<p className="muted dock-empty">{records.length?'没有匹配的记录。':'还没有提交记录。'}</p>}
  <button className="primary" onClick={()=>{tab.actions.openTab('kvvi-form');openForm('keep')}}><I as={Plus}/>填写登记表</button></>;
}
function DockRecord({business,row,tab,openForm}){
 if(!row)return <><h2>记录暂不可用</h2><p className="muted dock-empty">这条记录不在当前示例数据中。刷新会重置示例记录，面板布局仍会保留。</p><button onClick={()=>tab.actions.openTab('kvvi-records',{replaceTab:true})}>查看当前业务记录</button></>;
 return <><span className="breadcrumb">{business.name}</span><h2>{row.values[business.fields[0]?.id]}</h2><dl className="record-details">{business.fields.map(f=><div key={f.id}><dt>{f.name}</dt><dd>{row.values[f.id]||'—'}</dd></div>)}</dl><button className="primary" onClick={()=>{openForm('prepare',row);tab.actions.openTab('kvvi-form')}}><I as={Pencil}/>修改这条记录</button></>;
}
function DockConfig({business,setTab,dock}){
 return <><span className="breadcrumb">{business.name}</span><h2>业务配置</h2><dl className="record-details">{business.fields.map(f=><div key={f.id}><dt>{f.name}</dt><dd>{f.required?'必填':'选填'}</dd></div>)}</dl><button className="primary" onClick={()=>{setTab('config');dock.collapse()}}>打开配置页面<I as={ArrowRight}/></button></>;
}
const dockBodies={'kvvi-prototype/form':DockForm,'kvvi-prototype/records':DockRecords,'kvvi-prototype/record':DockRecord,'kvvi-prototype/config':DockConfig};

const initialNotices = [
 {id:'registration',title:'客户登记填写提醒',body:'登记客户前，请核对客户名称和联系人，避免信息重复或遗漏。',read:false},
 {id:'announcement',title:'公司通知将在这里集中查看',body:'后续可在这里接收公司公告和业务提醒。这条通知仅用于体验消息展示，不代表公司已发送通知。',read:false}
];
function AccountArea({role,onOpen,notices,setNotices}){
 const [open,setOpen]=useState(null),[detail,setDetail]=useState(null);
 const ref=useRef(null),profile=useRef(null),bell=useRef(null),popover=useRef(null);
 const unread=notices.filter(n=>!n.read).length,notice=notices.find(n=>n.id===detail);
 useEffect(()=>setOpen(null),[role]);
 useEffect(()=>{
  if(!open)return;
  popover.current?.querySelector('button')?.focus();
  const outside=e=>{if(!ref.current?.contains(e.target))setOpen(null)};
  const escape=e=>{if(e.key==='Escape'){e.preventDefault();setOpen(null);(open==='profile'?profile:bell).current?.focus()}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)};
 },[open,detail]);
 function toggle(next){setDetail(null);setOpen(open===next?null:next)}
 function launch(next){setOpen(null);profile.current?.focus();onOpen(next)}
 function read(next){setNotices(all=>all.map(n=>n.id===next?{...n,read:true}:n));setDetail(next)}
 return <div ref={ref} className="account-area" onBlur={e=>{if(e.relatedTarget&&!e.currentTarget.contains(e.relatedTarget))setOpen(null)}}>
  {open&&<section ref={popover} id="account-popover" role="dialog" aria-label={open==='profile'?'个人菜单':'公司通知'} className={'account-popover '+(open==='notifications'?'notifications-popover':'')}>
   {open==='profile'?<><div className="profile-menu-heading"><img src="/demo-avatar.png" alt=""/><div><strong>陈晓</strong><span>可微科技 · {names[role]}</span></div></div><div className="account-menu-items"><button onClick={()=>launch('profile')}><I as={UserRound}/>个人信息<I as={ChevronRight} size={15}/></button><button onClick={()=>launch('settings')}><I as={Settings}/>设置<I as={ChevronRight} size={15}/></button></div></>
   :<><header className="notifications-heading">{detail?<button className="text-button" onClick={()=>setDetail(null)}><I as={ChevronRight} size={15}/>返回通知</button>:<h2>公司通知<span className="tag">示例</span></h2>}<button className="icon-button" aria-label="关闭通知" onClick={()=>{setOpen(null);bell.current?.focus()}}><I as={X}/></button></header>{notice?<article className="notice-detail"><span className="breadcrumb">可微科技 · 示例通知</span><h3>{notice.title}</h3><p>{notice.body}</p><span className="notice-read">已读</span></article>:<><div className="notification-summary"><span>{unread?unread+' 条未读':'全部已读'}</span><button className="text-button" disabled={!unread} onClick={()=>{setNotices(all=>all.map(n=>({...n,read:true})));popover.current?.querySelector('.notifications-heading button')?.focus()}}>全部标为已读</button></div><div className="notice-list">{notices.map(n=><button key={n.id} aria-label={'查看通知：'+n.title} className={n.read?'read':'unread'} onClick={()=>read(n.id)}><div><strong>{n.title}</strong><p>{n.body}</p><span>{n.read?'已读':'未读'} · 示例通知</span></div><I as={ChevronRight} size={15}/></button>)}</div><p className="notifications-note">仅演示展示方式，尚未接入公司通知。</p></>}</>}
  </section>}
  <div className="account-footer"><button ref={profile} className={'profile-trigger '+(open==='profile'?'active':'')} aria-label="陈晓，打开个人菜单" aria-haspopup="dialog" aria-expanded={open==='profile'} aria-controls={open==='profile'?'account-popover':undefined} onClick={()=>toggle('profile')}><img src="/demo-avatar.png" alt="陈晓的示例头像"/><strong>陈晓</strong><I as={ChevronUp} size={15}/></button><button ref={bell} className={'notification-trigger '+(open==='notifications'?'active':'')} aria-label={'公司通知，'+(unread?unread+'条未读':'全部已读')} aria-haspopup="dialog" aria-expanded={open==='notifications'} aria-controls={open==='notifications'?'account-popover':undefined} onClick={()=>toggle('notifications')}><I as={Bell} size={21}/>{unread>0&&<span className="notification-badge" aria-hidden="true">{unread}</span>}</button></div>
 </div>;
}
export function App(){ return new URLSearchParams(location.search).has('builder-preview') ? <BuilderPreview/> : <BusinessHub/>; }
export function HarnessDemo(){
 const [role,setRole]=useState('employee'),[systems,setSystems]=useState(initial),[published,setPublished]=useState(Object.fromEntries(initial.map(b=>[b.id,b])));
 const [id,setId]=useState('customer'),[tab,setTab]=useState('chat'),[sidebar,setSidebar]=useState(true),[dialog,setDialog]=useState(null);
 const [drafts,setDrafts]=useState({}),[recordsById,setRecords]=useState({}),[threads,setThreads]=useState({}),[sessions,setSessions]=useState({});
 const [input,setInput]=useState(''),[search,setSearch]=useState(''),[selected,setSelected]=useState(null),[error,setError]=useState(''),[toast,setToast]=useState('');
 const [editor,setEditor]=useState(null),[newName,setNewName]=useState(''),[pending,setPending]=useState({}),[approval,setApproval]=useState({});
 const [notices,setNotices]=useState(initialNotices);
 const chatRef=useRef(null),timer=useRef(null);
 const builder=role==='builder',business=(!builder&&published[id])||systems.find(b=>b.id===id),draft=drafts[id]||emptyDraft,records=recordsById[id]||[];
 const session=sessions[id]||'intro',key=role+':'+id+':'+session,messages=threads[key]||[];
 const viewportWidth=useViewportWidth();
 const {dock,layout}=useBusinessDock('kvvi-prototype:'+key,business,builder);
 const [presentation,setPresentation]=useState({shown:false,track:false,fullscreen:false});
 const [requestedWidth,setRequestedWidth]=useState(420);
 const leftWidth=!sidebar?0:viewportWidth<=600?68:viewportWidth<=1150?210:viewportWidth>=1600?260:242;
 const maxWidth=Math.max(280,viewportWidth-leftWidth-280);
 const panelWidth=Math.min(Math.max(280,requestedWidth),maxWidth);
 const resizePanel=width=>setRequestedWidth(Math.min(Math.max(280,width),maxWidth));
 const title=session==='intro'?(id==='customer'?'客户登记所需填写信息':business.formName+'说明'):'新会话';
 const tabs=[['chat','对话'],['form',business.formName],['records',id==='customer'?'客户记录':id==='leave'?'申请记录':'业务记录'],...(builder?[['config','业务配置']]:[]),...(role==='owner'?[['manage','业务管理']]:[])];
 const currentRecord=records.find(r=>r.id===selected),summary=business.fields.filter(f=>f.type!=='member');
 useEffect(()=>{if(messages.length&&chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight},[key,messages.length]);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 function notify(text){setToast(text);clearTimeout(timer.current);timer.current=setTimeout(()=>setToast(''),3500)}
 function addMessage(user,reply,action=null,recordId=null){setThreads(t=>({...t,[key]:[...(t[key]||[]),{user,reply,action,recordId}]}))}
 function setValue(field,value){setDrafts(all=>({...all,[id]:{...draft,values:{...draft.values,[field]:value}}}));setError('')}
 function switchBusiness(next){setId(next);setTab('chat');setDialog(null);setInput('');setSearch('');setSelected(null);setError('')}
 function switchRole(next){setRole(next);setTab('chat');setDialog(null);setInput('');setError('');if(next==='employee'&&!published[id])setId('customer')}
 function newChat(){setSessions(s=>({...s,[id]:'new-'+Date.now()}));setTab('chat');setInput('');setSelected(null)}
 function updateBusiness(patch){setSystems(all=>all.map(b=>b.id===id?{...b,...patch}:b))}
 function openForm(where='modal',row=null,options={}){if(row)setDrafts(all=>({...all,[id]:{values:{...row.values},editing:row.id}}));setError('');if(where==='modal')setDialog('form');else if(where==='panel'){dock.openForm(options);setTab('chat')}else if(where!=='prepare'&&where!=='keep')setTab('form')}
 function openRecord(recordId,options={}){setSelected(recordId);dock.openRecord(recordId,options)}
 function submit(sourceTabId){
  const missing=business.fields.find(f=>f.required&&f.type!=='member'&&!String(draft.values[f.id]||'').trim());if(missing){setError('请填写'+missing.name);return}
  if(id==='leave'&&draft.values.start>draft.values.end){setError('结束日期不能早于开始日期');return}
  const values=Object.fromEntries(business.fields.map(f=>[f.id,f.type==='member'?'陈晓':String(draft.values[f.id]||'').trim()]));
  const row={id:draft.editing||'record-'+Date.now(),values};
  setRecords(all=>({...all,[id]:draft.editing?(all[id]||[]).map(r=>r.id===draft.editing?row:r):[...(all[id]||[]),row]}));
  addMessage(null,(draft.editing?'已更新':'已保存')+'「'+values[business.fields[0].id]+'」。','record',row.id);
  setDrafts(all=>({...all,[id]:emptyDraft}));setSelected(row.id);setDialog(null);setError('');if(tab==='form')setTab('records');if(typeof sourceTabId==='string')dock.openRecord(row.id,{replaceTab:sourceTabId});notify('示例记录已保存');
 }
 function send(value=input){
  if(!value.trim())return;setInput('');
  if(builder&&/增加|添加/.test(value)&&value.includes('备注')){if(!business.fields.some(f=>f.id==='note'))updateBusiness({fields:[...business.fields,{id:'note',name:'备注',type:'textarea',required:false}]});addMessage(value,'表单已包含「备注」，可以打开配置查看。','config');return}
  if(id==='customer'&&/改|更新/.test(value)&&/跟进|状态/.test(value)){
   const statusField=business.fields.find(f=>f.id==='status');const next=statusField?.options?.find(option=>value.includes(option));
   if(!currentRecord){addMessage(value,'请先从客户记录里选中要修改的客户。','records');setTab('records');return}
   if(next){setDrafts(all=>({...all,[id]:{values:{...currentRecord.values,status:next},editing:currentRecord.id}}));addMessage(value,'已准备好修改，请核对后保存。','edit');dock.openForm();setTab('chat');setError('');return}
   addMessage(value,'可以打开这条记录修改跟进状态。','record',currentRecord.id);return;
  }
  if(/登记|填写|提交|请假/.test(value)){
   if(id==='customer'){const name=value.includes('青禾')?'青禾设计':value.match(/(?:登记客户|客户名称[：:]?|公司[：:]?)\s*([^，,。\s]+)/)?.[1],contact=value.match(/联系人[：:]?\s*([^，,。\s]+)/)?.[1],phone=value.match(/1\d{10}/)?.[0];setDrafts(all=>({...all,[id]:{...draft,values:{...draft.values,...(name?{name}:{}),...(contact?{contact}:{}),...(phone?{phone}:{}),status:draft.values.status||(business.fields.find(f=>f.id==='status')?.options?.[0]||'')}}}))}
   addMessage(value,'登记表已打开，请核对后提交。','form');openForm();return;
  }
  if(/查|记录|多少/.test(value)){addMessage(value,records.length?'找到 '+records.length+' 条示例记录。':'暂时没有已提交的记录。','records');setTab('records');return}
  addMessage(value,builder?'可以打开业务配置调整字段，或试试「增加备注字段」。':'这版可体验填写表单和查看记录。',builder?'config':'form');
 }
 function act(m){if(m.action==='form')openForm();if(m.action==='edit'){dock.openForm();setTab('chat')}if(m.action==='records')setTab('records');if(m.action==='config')setTab('config');if(m.action==='record'){openRecord(m.recordId);setTab('chat')}}
 function editField(f={name:'',type:'text',required:false}){setEditor({...f,optionsText:(f.options||[]).join('\n')});setError('');setDialog('field')}
 function saveField(){
  const name=editor.name.trim();if(!name){setError('请填写字段名称');return}if(business.fields.some(f=>f.name===name&&f.id!==editor.id)){setError('已有同名字段');return}
  const options=editor.optionsText.split('\n').map(s=>s.trim()).filter(Boolean);if(editor.type==='select'&&(!options.length||new Set(options).size!==options.length)){setError('请填写选项，每行一个，不能重复');return}
  const field={id:editor.id||'field-'+Date.now(),name,type:editor.type,required:editor.required,...(editor.type==='select'?{options}:{})};
  updateBusiness({fields:editor.id?business.fields.map(f=>f.id===editor.id?field:f):[...business.fields,field]});addMessage(null,'已'+(editor.id?'更新':'添加')+'「'+name+'」。','config');setDialog(null);setEditor(null);setError('');notify('表单配置已更新');
 }
 function createBusiness(){const name=newName.trim();if(!name)return;const next={id:'business-'+Date.now(),name,formName:name,fields:[{id:'name',name:'名称',required:true,type:'text'},{id:'note',name:'备注',required:false,type:'textarea'}]};setSystems(all=>[...all,next]);setNewName('');switchBusiness(next.id);setTab('config')}
 const formProps={business,draft,setValue,submit,notify,error};
 const closeModal=()=>{setDialog(null);setError('')};
 return <><div className="demo-bar"><span>交互原型 · 示例数据</span><div aria-label="原型身份演示">{Object.entries(names).map(([value,label])=><button key={value} className={role===value?'active':''} onClick={()=>switchRole(value)}>体验{label}</button>)}</div><span className="demo-note">示例数据刷新重置 · 面板布局保留</span></div><div className={'shell '+(!sidebar?'sidebar-hidden ':'')+(presentation.track?'panel-open':'')} style={{'--dock-track':presentation.track?panelWidth+'px':'0px','--prototype-left':leftWidth+'px'}}>
  {sidebar&&<aside className="sidebar"><div className="brand"><img src="/kvvi-mark.svg" alt=""/><strong>可微科技</strong><button aria-label="收起侧边栏" className="icon-button" onClick={()=>setSidebar(false)}><I as={PanelLeft}/></button></div><button className="new-chat" onClick={newChat}><I as={CirclePlus}/>新会话</button><nav className="global-navigation" aria-label="全局功能"><button className="nav-plain" onClick={()=>setDialog('business-menu')}><I as={LayoutTemplate}/>业务</button><button className="nav-plain" onClick={()=>setDialog('plugins')}><I as={Puzzle}/>插件</button></nav><div className="workspace-heading"><span>工作区</span><div><button className="icon-button" aria-label="选择业务" onClick={()=>setDialog('business-menu')}><I as={Search}/></button>{builder&&<button className="icon-button" aria-label="新建业务" onClick={()=>setDialog('new')}><I as={FolderPlus}/></button>}</div></div><nav className="workspace-navigation" aria-label="业务与会话">{systems.filter(b=>role!=='employee'||published[b.id]).map(b=><div className="workspace-group" key={b.id}><button className={'workspace-name '+(id===b.id?'current':'')} onClick={()=>switchBusiness(b.id)}><I as={Folder}/><span>{b.name}</span>{!published[b.id]&&<small>草稿</small>}</button>{id===b.id&&<div className="session-list"><button className={session==='intro'?'selected':''} onClick={()=>{setSessions(s=>({...s,[id]:'intro'}));setTab('chat')}}>{b.id==='customer'?'客户登记所需填写信息':b.formName+'说明'}</button>{session!=='intro'&&<button className="selected" onClick={()=>setTab('chat')}>新会话</button>}</div>}</div>)}</nav><AccountArea role={role} onOpen={setDialog} notices={notices} setNotices={setNotices}/></aside>}
  <main className="main"><header className="top-header"><div className="conversation-name">{!sidebar&&<button className="icon-button" aria-label="展开侧边栏" onClick={()=>setSidebar(true)}><I as={PanelLeft}/></button>}<strong>{title}</strong><span className="mode-label"><I as={ShieldCheck}/>{business.name} · {names[role]}</span></div><button className={'icon-button '+(layout.expanded?'selected-control':'')} aria-label={layout.expanded?'收起业务面板':'打开业务面板'} onClick={dock.toggle}><I as={PanelRight}/></button></header><div className="tabs-row"><div role="tablist" aria-label="当前业务功能">{tabs.map(([value,label])=><button key={value} role="tab" aria-selected={tab===value} className={tab===value?'active':''} onClick={()=>{setTab(value);setError('')}}>{label}</button>)}</div><button className="advanced-button" onClick={()=>setDialog('more')}>更多<I as={ChevronDown} size={14}/></button></div>
   {tab==='chat'?<div className={'chat-view '+(session!=='intro'&&!messages.length?'empty-chat':'')}><div className="messages" ref={chatRef}>
    {session==='intro'&&<div className="intro-thread"><div className="user-row"><div className="user-bubble">{business.formName}需要填写哪些信息？</div></div><div className="assistant-row"><p>{builder?'表单已准备好，可在「业务配置」调整。':'填写以下 '+summary.length+' 项，必填项已标出。'}</p><table className="field-summary"><thead><tr><th>字段</th><th>是否必填</th><th>说明</th></tr></thead><tbody>{summary.map(f=><tr key={f.id}><td>{f.name}</td><td>{f.required?'必填':'选填'}</td><td>{f.type==='select'?f.options.join(' / '):f.type==='date'?'日期':f.type==='textarea'?'补充说明':'文本'}</td></tr>)}</tbody></table><div className="response-actions"><button onClick={()=>openForm()}><I as={Plus}/>打开登记表</button><button onClick={()=>setTab('records')}>查看记录<I as={ArrowRight}/></button>{builder&&<button onClick={()=>setTab('config')}>调整字段<I as={Pencil}/></button>}</div></div></div>}
    {session!=='intro'&&!messages.length&&<div className="hero"><div><img src="/kvvi-mark.svg" alt=""/><h1>让每一笔业务都有据可查</h1></div><p>当前业务：{business.name}</p></div>}
    {messages.map((m,i)=><div className="message-pair" key={i}>{m.user&&<div className="user-row"><div className="user-bubble">{m.user}</div></div>}<div className="assistant-row"><p>{m.reply}</p>{m.action&&<button className="inline-action" onClick={()=>act(m)}>{({form:'打开登记表',records:'查看记录',config:'查看业务配置',record:'查看这条记录',edit:'查看修改'})[m.action]}<I as={ArrowRight} size={15}/></button>}</div></div>)}
   </div><div className="composer-container"><div className="composer-context"><I as={Folder} size={14}/><span>{business.name}{currentRecord?' · '+currentRecord.values[business.fields[0].id]:''}</span><button className="context-action" onClick={()=>openForm()}><I as={Plus} size={14}/>登记</button><button className="context-action" onClick={()=>openForm('panel')}><I as={PanelRight} size={14}/>边聊边填</button></div><form className="composer" onSubmit={e=>{e.preventDefault();send()}}><textarea aria-label="告诉业务助手" placeholder={builder?'描述业务需求，例如：增加一个备注字段…':id==='customer'?'例如：登记客户青禾设计，联系人王女士…':'描述你需要办理的事项…'} value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();send()}}}/><div className="composer-bottom"><button type="button" className="icon-button" aria-label="打开登记表" onClick={()=>openForm()}><I as={Plus}/></button><span><I as={ShieldCheck} size={14}/>{builder?'搭建当前业务':'按业务权限办理'}</span><button className="send" aria-label="发送" disabled={!input.trim()}><I as={ArrowUp} size={20}/></button></div></form></div></div>
   :<div className="business-page">
    {tab==='form'&&<div className="form-page"><div className="page-heading"><span className="breadcrumb">{business.name}</span><button className="text-button" onClick={()=>openForm('panel')}>边聊边填<I as={PanelRight}/></button></div><BusinessForm {...formProps}/></div>}
    {tab==='records'&&<><div className="page-heading"><div><span className="breadcrumb">{business.name}</span><h1>{id==='customer'?'客户记录':id==='leave'?'申请记录':'业务记录'}<span className="count">{records.length}</span></h1></div><button className="primary" onClick={()=>{setDrafts(all=>({...all,[id]:emptyDraft}));openForm()}}><I as={Plus}/>新增记录</button></div><div className="list-toolbar"><div className="search-box"><I as={Search}/><input aria-label="搜索记录" value={search} placeholder="搜索当前业务记录" onChange={e=>setSearch(e.target.value)}/></div><span className="muted">陈晓负责的示例记录</span></div>{records.length?<div className="records-table"><table><thead><tr>{business.fields.slice(0,4).map(f=><th key={f.id}>{f.name}</th>)}<th/></tr></thead><tbody>{records.filter(r=>Object.values(r.values).some(v=>String(v).includes(search))).map(r=><tr key={r.id} className={selected===r.id?'selected-row':''}>{business.fields.slice(0,4).map(f=><td key={f.id}>{r.values[f.id]||'—'}</td>)}<td><button className="text-button" aria-label={'查看'+r.values[business.fields[0].id]} onClick={()=>{openRecord(r.id)}}>查看<I as={ChevronRight} size={15}/></button></td></tr>)}</tbody></table>{!records.some(r=>Object.values(r.values).some(v=>String(v).includes(search)))&&<div className="no-match">没有匹配的记录，换个关键词试试。</div>}</div>:<div className="empty-state"><I as={List} size={32}/><h2>还没有提交记录</h2><p>可以直接填写，也可以让会话帮你整理。</p><button onClick={()=>openForm()}>填写第一条记录<I as={ArrowRight}/></button></div>}</>}
    {tab==='config'&&builder&&<><div className="page-heading"><div><span className="breadcrumb">{business.name}</span><h1>业务配置</h1></div><button className="primary" onClick={()=>setDialog('publish')}>提交发布</button></div><div className="config-title"><h2>{business.formName}</h2><span className="tag">{JSON.stringify(business)===JSON.stringify(published[id])?'已发布':'草稿'}</span></div><div className="config-fields">{business.fields.map(f=><button className="config-field" key={f.id} onClick={()=>editField(f)}><div><strong>{f.name}</strong><span>{({text:'文本',date:'日期',select:'单选',member:'默认当前员工',textarea:'多行文本'})[f.type]} · {f.required?'必填':'选填'}</span></div><I as={Pencil}/></button>)}</div><div className="config-actions"><button onClick={()=>editField()}><I as={Plus}/>添加字段</button><button onClick={()=>setTab('form')}><I as={FileText}/>试填表单</button></div><div className="configuration-foot"><I as={ShieldCheck}/>员工使用已发布版本；草稿修改提交后由所有者审批。</div></>}
    {tab==='manage'&&role==='owner'&&<><div className="page-heading"><div><span className="breadcrumb">{business.name}</span><h1>业务管理</h1></div></div><div className="manage-section"><h2>发布审批</h2>{pending[id]?<div className="approval-row"><div><strong>{pending[id].formName} · 配置更新</strong><p>{pending[id].fields.length} 个字段，等待所有者审批</p></div><button className="primary" onClick={()=>setDialog('approve')}>查看并审批</button></div>:<p className="muted">{approval[id]?'本次示例发布已批准。':'目前没有待审批的发布。'}</p>}</div><div className="manage-section"><h2>成员与使用范围</h2><div className="member-row"><div><strong>陈晓</strong><p>员工 · 查看和编辑本人负责的记录</p></div><span className="tag">示例授权</span></div><p className="muted small">这里只展示管理位置，真实成员和权限尚未接入。</p></div></>}
   </div>}
  </main>
  <BusinessRightbar key={dock.sessionId} dock={dock} width={panelWidth} viewportWidth={viewportWidth} syncPresentation={setPresentation}
   model={{business,draft,records,recordsTitle:tabs.find(([value])=>value==='records')[1],bodies:dockBodies,
    formProps,submit,openForm,openRecord,selectRecord:setSelected,setTab,dock}}/>
  {presentation.track&&!presentation.fullscreen&&<BusinessColumnResize width={panelWidth} maxWidth={maxWidth} onResize={resizePanel}/>}
 </div>
 {dialog==='form'&&<Modal title={draft.editing?'修改记录':business.formName} onClose={closeModal} wide><div className="modal-business">{business.name}<button className="text-button" onClick={()=>{setDialog(null);setTab('form')}}>在完整页面填写<I as={ArrowRight}/></button></div><BusinessForm {...formProps} prefix="modal"/></Modal>}
 {dialog==='field'&&<Modal title={editor.id?'修改字段':'添加字段'} onClose={closeModal}><label>字段名称<input value={editor.name} onChange={e=>setEditor({...editor,name:e.target.value})}/></label><label>填写方式<select aria-label="填写方式" value={editor.type} disabled={editor.type==='member'} onChange={e=>setEditor({...editor,type:e.target.value})}><option value="text">文本</option><option value="select">单选</option><option value="textarea">多行文本</option><option value="date">日期</option>{editor.type==='member'&&<option value="member">默认当前员工</option>}</select></label><label className="checkbox-label"><input type="checkbox" checked={editor.required} onChange={e=>setEditor({...editor,required:e.target.checked})}/>必填</label>{editor.type==='select'&&<label>选项<textarea aria-label="选项" rows={4} value={editor.optionsText} placeholder="每行一个选项" onChange={e=>setEditor({...editor,optionsText:e.target.value})}/></label>}{error&&<p role="alert" className="error">{error}</p>}<div className="form-actions"><button onClick={closeModal}>取消</button><button className="primary" onClick={saveField}>保存字段</button></div></Modal>}
 {dialog==='new'&&<Modal title="新建业务" onClose={closeModal}><p className="muted">创建后，在会话里描述需求或直接调整表单。</p><label>业务名称<input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="例如：供应商登记"/></label><div className="form-actions"><button className="primary" disabled={!newName.trim()} onClick={createBusiness}>开始搭建</button></div></Modal>}
 {dialog==='publish'&&<Modal title="提交发布草案" onClose={closeModal}><p>将「{business.formName}」的配置交给所有者审批。</p><div className="review-summary"><strong>{business.formName}</strong><span>{business.fields.length} 个字段</span></div><p className="muted small">这是发布流程演示，不会发布真实业务。</p><div className="form-actions"><button onClick={closeModal}>继续调整</button><button className="primary" onClick={()=>{setPending(all=>({...all,[id]:structuredClone(business)}));setApproval(all=>({...all,[id]:false}));setDialog(null);notify('示例草案已提交，可切换所有者查看审批')}}>提交草案</button></div></Modal>}
 {dialog==='approve'&&pending[id]&&<Modal title="审批业务发布" onClose={closeModal}><div className="review-summary"><strong>{pending[id].formName}</strong><span>{pending[id].fields.length} 个字段</span></div><ul className="approval-fields">{pending[id].fields.map(f=><li key={f.id}>{f.name}<span>{f.required?'必填':'选填'}</span></li>)}</ul><p className="muted small">示例审批，不会影响正式业务。</p><div className="form-actions"><button onClick={()=>{setPending(all=>({...all,[id]:null}));setDialog(null);notify('示例草案已退回')}}>退回调整</button><button className="primary" onClick={()=>{setPublished(all=>({...all,[id]:pending[id]}));setPending(all=>({...all,[id]:null}));setApproval(all=>({...all,[id]:true}));setDialog(null);notify('示例审批通过')}}>批准发布</button></div></Modal>}
 {dialog==='profile'&&<Modal title="个人信息" onClose={closeModal}><div className="profile-menu-heading"><img src="/demo-avatar.png" alt="陈晓的示例头像"/><div><strong>陈晓</strong><span>当前原型身份</span></div></div><dl className="record-details"><div><dt>姓名</dt><dd>陈晓</dd></div><div><dt>公司</dt><dd>可微科技</dd></div><div><dt>身份</dt><dd>{names[role]}</dd></div></dl><p className="muted small">这里使用示例个人信息，正式信息由登录账号提供。</p></Modal>}
 {['plugins','settings','more','business-menu'].includes(dialog)&&<Modal title={({plugins:'插件',settings:'设置',more:'更多','business-menu':'我的业务'})[dialog]} onClose={closeModal}>{dialog==='business-menu'?<div className="business-picker">{systems.filter(b=>role!=='employee'||published[b.id]).map(b=><button key={b.id} onClick={()=>switchBusiness(b.id)}><I as={Folder}/>{b.name}<I as={ChevronRight}/></button>)}</div>:dialog==='more'?<><button className="menu-row" onClick={()=>{setDialog(null);notify('原型没有工具轨迹，正式接入后在此查看')}}><I as={History}/>轨迹<span>高级查看</span></button><button className="menu-row" onClick={()=>{setDialog(null);newChat()}}><I as={MessageSquare}/>新建当前业务会话</button></>:<p className="muted">{dialog==='plugins'?'保留 Harness 的插件入口；业务办理使用顶部页签和右侧面板。':'账号、通知与界面偏好将在这里统一管理。'}</p>}</Modal>}
 {toast&&<div role="status" className="toast"><I as={Check}/>{toast}</div>}
 </>;
}
