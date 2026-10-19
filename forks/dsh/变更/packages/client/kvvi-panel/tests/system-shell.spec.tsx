// @vitest-environment jsdom
/**
 * 「我的系统」的完整回路，用一份脚本化的 `fetch` 走通。
 *
 * ── 这一条测的是**回路**，不是组件 ────────────────────────────────────────
 *
 * 前面两份测试分别测「契约能不能画」和「写出去的东西对不对」。这一份把
 * 平台 API 换成一个**按路径作答的假服务器**，验证员工真正会走的那条路：
 *
 *   进系统 → 系统不能跑时如实说明 → 填单提交 → 看记录 → 打开记录 → 保存
 *
 * ⚠️ 假服务器按**路径**作答，而不是按调用次序：按次序作答的桩会把
 * 「多打了一次请求」和「打错了端点」都变成通过，而这两种都是真问题。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KvviSystemShell } from '../src/client/SystemShell.tsx'
import type { Copy } from '../src/client/FormView.tsx'
import { zh } from '../src/client/locales.ts'
import {businessFetch,entrance} from './record-write-server.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** The dictionary as a plain function, as the slot renderer supplies it. */
const t: Copy = (key, params) => {
  const template = (zh as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/gu, (_, name: string) => String(params[name] ?? ''))
}

interface Answer {
  readonly status?: number
  readonly body: unknown
}

/**
 * A fake platform: one answer per `METHOD path`, plus a request log.
 *
 * The log is the point — a test can then assert **which** endpoint the client
 * used, not merely that something was called.
 */
function platform(routes: Readonly<Record<string, Answer>>): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', businessFetch(async(url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url}`)
    const answer = routes[`${method} ${url}`]
    if (answer === undefined) {
      return Response.json({ error: 'KVVI_UNKNOWN_ROUTE', route: url },{status:404})
    }
    const status = answer.status ?? 200
    return Response.json(answer.body,{status})
  }))
  return { calls }
}

const VIEW = {
  view_code: 'golden_01_form',
  name: '事项登记表单',
  view_type: 'FORM',
  componentsTree: [{
    id: 'root', componentName: 'FormPage', children: [{
      id: 'f1', componentName: 'ShortTextField',
      props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } },
    }],
  }],
}

const RUNTIME = {
  system: { systemId: 's1', assetId: 'golden_01', name: '事项登记', schemaCode: 'golden_01' },
  models: { golden_01: { schema_code: 'golden_01', name: '事项登记', fields: [
    { field_code: 'title', label: '标题', type: 'short_text', visibility: 'VISIBLE' },
  ] } },
  views: { golden_01: VIEW },
  workflows: { golden_01: { states: { submitted: { label: '待审批' } }, transitions: [] } },
}

const SYSTEMS = {
  items: [{
    systemId: 's1', assetId: 'golden_01', name: '事项登记',
    schemaCode: 'golden_01', publishedAt: '2026-09-25T00:00:00Z',
  }],
  companyId: 'c1',
}

/** The routes every "healthy" case shares. */
function healthy(extra: Readonly<Record<string, Answer>> = {}): Record<string, Answer> {
  return {
    'GET /api/v1/systems': { body: SYSTEMS },
    'GET /api/v1/systems/golden_01/runtime': { body: RUNTIME },
    'GET /api/v1/systems/golden_01/fields': { body: { fields: RUNTIME.models.golden_01.fields } },
    'GET /api/v1/systems/golden_01/records': {
      body: { items: [{
        recordId: 'r1', recordNo: 'R000001', rowVersion: 3, state: 'submitted',
        data: { title: '报销' },
      }], fieldVisibility: { title: 'VISIBLE' } },
    },
    'GET /api/v1/systems/golden_01/records/r1': {
      body: {
        recordId: 'r1', recordNo: 'R000001', rowVersion: 3, state: 'submitted',
        data: { title: '报销' }, fieldVisibility: { title: 'VISIBLE' },
      },
    },
    ...extra,
  }
}

describe('我的系统', () => {
  it('retries a failed runtime read and renders the real form after recovery', async () => {
    platform(healthy({ 'GET /api/v1/systems/golden_01/runtime': { status: 503, body: { error: 'KVVI_UNREACHABLE' } } }))
    render(<KvviSystemShell copy={t} />)
    fireEvent.click(await screen.findByRole('button', { name: zh['systems.open'] }))
    await screen.findByRole('alert')
    platform(healthy())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByLabelText('title')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('offers a readable failure and retries the systems read without reopening', async () => {
    platform({ 'GET /api/v1/systems': { status: 503, body: { error: 'KVVI_UNREACHABLE' } } })
    render(<KvviSystemShell copy={t} />)
    await screen.findByRole('alert')
    expect(screen.getByRole('alert').textContent).toContain('无法连接服务')
    expect(screen.getByRole('alert').textContent).toContain('KVVI_UNREACHABLE')
    platform(healthy())
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText('事项登记')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('列出已发布的系统，打开后到填单', async () => {
    platform(healthy())
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    // 标签来自模型（标题），不是字段名。
    expect(screen.getByText('标题')).toBeTruthy()
  })

  it('★ U1：首次打开填单，HIDDEN 字段不渲染、也不随表单提交', async () => {
    const withSecret = {
      ...RUNTIME,
      models: { golden_01: { ...RUNTIME.models.golden_01, fields: [
        { field_code: 'title', label: '标题', type: 'short_text', visibility: 'VISIBLE' },
        { field_code: 'secret', label: '密级', type: 'short_text' },
      ] } },
      views: { golden_01: {
        view_code: 'golden_01_form', name: '事项登记表单', view_type: 'FORM',
        componentsTree: [{
          id: 'root', componentName: 'FormPage', children: [
            { id: 'f1', componentName: 'ShortTextField',
              props: { fieldBinding: { type: 'FieldRef', fieldRef: 'title' } } },
            { id: 'f2', componentName: 'ShortTextField',
              props: { fieldBinding: { type: 'FieldRef', fieldRef: 'secret' } } },
          ],
        }],
      } },
    }
    // /fields 只返回本会话能看到的字段 —— secret 是 HIDDEN，被平台滤掉。
    platform(healthy({
      'GET /api/v1/systems/golden_01/runtime': { body: withSecret },
      'GET /api/v1/systems/golden_01/fields': {
        body: { assetId: 'golden_01', fields: [{ field_code: 'title', visibility: 'VISIBLE' }], hiddenFieldCount: 1 },
      },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    expect(screen.queryByLabelText('secret')).toBeNull()
    expect(screen.queryByText('密级')).toBeNull()
  })

  it('★ 系统不能运行时如实说明，而不是画一个空表单', async () => {
    platform({
      'GET /api/v1/systems': { body: SYSTEMS },
      'GET /api/v1/systems/golden_01/runtime': {
        status: 404,
        body: { error: 'KVVI_RUNTIME_CONTRACT_INCOMPLETE', missing: ['workflow-spec'] },
      },
    })
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('KVVI_RUNTIME_CONTRACT_INCOMPLETE')
    })
    expect(screen.queryByLabelText('title')).toBeNull()
  })

  it('★ 读取失败与「还没有系统」是两种状态', async () => {
    platform({ 'GET /api/v1/systems': { status: 403, body: { error: 'KVVI_NOT_ALLOWED' } } })
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByRole('alert')).toBeTruthy() })
    expect(screen.queryByText(zh['systems.empty'])).toBeNull()
  })

  it('★ 提交成功显示记录号', async () => {
    const { calls } = platform(healthy({
      'POST /api/v1/systems/golden_01/records': {
        status: 201, body: { recordId: 'r9', rowVersion: 1, recordNo: 'R000009' },
      },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('title'), { target: { value: '报销' } })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    await waitFor(() => { expect(screen.getByText(/R000009/u)).toBeTruthy() })
    expect(calls).toContain('POST /api/v1/systems/golden_01/records')
  })

  it('★ 提交被拒时显示平台的码', async () => {
    platform(healthy({
      'POST /api/v1/systems/golden_01/records': { status: 403, body: { error: 'KVVI_NOT_ALLOWED' } },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['form.submit'] }))
    await waitFor(() => { expect(screen.getByText(/KVVI_NOT_ALLOWED/u)).toBeTruthy() })
  })

  it('★ 记录列表来自 /records，打开一条要打到那一条的端点', async () => {
    const { calls } = platform(healthy())
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['system.tab.records'] }))
    await waitFor(() => { expect(screen.getByText('R000001')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.title'])).toBeTruthy() })
    expect(calls).toContain('GET /api/v1/systems/golden_01/records/r1')
  })

  it('★ 详情保存带上平台给的版本号', async () => {
    const { calls } = platform(healthy({
      'PATCH /api/v1/systems/golden_01/records/r1': { body: { recordId: 'r1', rowVersion: 4 } },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['system.tab.records'] }))
    await waitFor(() => { expect(screen.getByText('R000001')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.title'])).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('title'), { target: { value: '报销（改）' } })
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.saved'])).toBeTruthy() })

    const spy = vi.mocked(globalThis.fetch)
    const patch = spy.mock.calls.find(c => c[1]?.method === 'PATCH')
    // 不带版本号 = 「最后写入者获胜」，别人的改动会被静默覆盖。
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ data: { title: '报销（改）' }, rowVersion: 3 })
    const save=screen.getByRole('button',{name:zh['detail.save']}) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(spy.mock.calls.filter(call=>call[1]?.method==='PATCH')).toHaveLength(1)
    expect(calls).toContain('PATCH /api/v1/systems/golden_01/records/r1')
  })

  it('★ 冲突时报出平台给的当前版本', async () => {
    platform(healthy({
      'PATCH /api/v1/systems/golden_01/records/r1': {
        status: 409, body: { error: 'KVVI_ROW_VERSION_CONFLICT', currentRowVersion: 9 },
      },
    }))
    render(<KvviSystemShell copy={t} />)
    await waitFor(() => { expect(screen.getByText('事项登记')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['systems.open'] }))
    await waitFor(() => { expect(screen.getByLabelText('title')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['system.tab.records'] }))
    await waitFor(() => { expect(screen.getByText('R000001')).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: zh['list.open'] }))
    await waitFor(() => { expect(screen.getByText(zh['detail.title'])).toBeTruthy() })
    fireEvent.change(screen.getByLabelText('title'), { target: { value: '报销（冲突）' } })
    fireEvent.click(screen.getByRole('button', { name: zh['detail.save'] }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(zh['detail.conflict'].replace('{currentRowVersion}', '9'))
    })
  })
})

it('opens a published system beside the conversation through its injected dock action', async () => {
  platform(healthy())
  const onDock = vi.fn()
  render(<KvviSystemShell copy={t} onDock={onDock} />)
  fireEvent.click(await screen.findByRole('button', { name: '边聊边填' }))
  expect(onDock).toHaveBeenCalledWith(SYSTEMS.items[0], 'form')
  expect(screen.queryByLabelText('title')).toBeNull()
})


it('withholds the first form until field permissions return and refuses a failed read', async () => {
  let finish:(response:Response)=>void=()=>{}
  const fetcher=businessFetch((url:string)=>url.endsWith('/fields')?new Promise<Response>(resolve=>{finish=resolve}):Promise.resolve(Response.json(url.endsWith('/systems')?SYSTEMS:RUNTIME)))
  vi.stubGlobal('fetch',fetcher)
  render(<KvviSystemShell copy={t} />)
  fireEvent.click(await screen.findByRole('button',{name:zh['systems.open']}))
  await waitFor(()=>expect(fetcher.mock.calls.some(([url])=>url.endsWith('/fields'))).toBe(true))
  expect(screen.queryByLabelText('title')).toBeNull()
  finish(Response.json({error:'KVVI_NOT_ALLOWED'},{status:403}))
  expect((await screen.findByRole('alert')).textContent).toContain('KVVI_NOT_ALLOWED')
  expect(screen.queryByLabelText('title')).toBeNull()
})

it('a field without an explicit visibility does not become editable', async () => {
  platform(healthy({'GET /api/v1/systems/golden_01/fields':{body:{fields:[{field_code:'title'}]}}}))
  render(<KvviSystemShell copy={t} />)
  fireEvent.click(await screen.findByRole('button',{name:zh['systems.open']}))
  expect((await screen.findByRole('alert')).textContent).toContain('KVVI_BAD_RESPONSE')
  expect(screen.queryByRole('button',{name:zh['form.submit']})).toBeNull()
  expect(screen.queryByLabelText('title')).toBeNull()
})


it('the legacy shell prepares a durable key before its business create',async()=>{
  const {calls}=platform(healthy({'POST /api/v1/systems/golden_01/records':{status:201,body:{recordId:'r9',rowVersion:1}}}))
  render(<KvviSystemShell copy={t}/>)
  fireEvent.click(await screen.findByRole('button',{name:zh['systems.open']}))
  fireEvent.change(await screen.findByLabelText('title'),{target:{value:'durable'}})
  fireEvent.click(screen.getByRole('button',{name:zh['form.submit']}))
  await waitFor(()=>expect(calls).toContain('POST /api/v1/systems/golden_01/records'))
  const requests=vi.mocked(globalThis.fetch).mock.calls
  const prepare=requests.findIndex(([url,init])=>String(url).endsWith('/write-intent')&&init?.method==='POST')
  const write=requests.findIndex(([url,init])=>String(url).endsWith('/records')&&init?.method==='POST')
  expect(prepare).toBeGreaterThanOrEqual(0);expect(write).toBeGreaterThan(prepare)
  expect(new Headers(requests[write]?.[1]?.headers).get('idempotency-key')).toBe('prepared-1')
})

it('reopening the legacy shell finds a lost result without replay and opens it only explicitly',async()=>{
  const fetcher=businessFetch(async(url,init)=>Response.json(init?.method==='POST'?{recordId:'r1',rowVersion:3,recordNo:'R000001'}
    :healthy()[`GET ${url}`]?.body??{error:'KVVI_UNKNOWN_ROUTE'}))
  vi.stubGlobal('fetch',fetcher);fetcher.loseNextBusinessReply()
  const mounted=render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  fireEvent.change(await screen.findByLabelText('title'),{target:{value:'lost'}})
  fireEvent.click(screen.getByRole('button',{name:zh['form.submit']}))
  await screen.findByText(zh['recovery.uncertain']);mounted.unmount()
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  await screen.findByText(zh['recovery.saved'])
  expect(screen.queryByText(zh['detail.title'])).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.view']}))
  await screen.findByText(zh['detail.title'])
  expect(fetcher.mock.calls.filter(([url,init])=>url.endsWith('/records')&&init?.method==='POST')).toHaveLength(1)
})


it('a lost PATCH is acknowledged before reloading the current server record, never merged from old input',async()=>{
  let row={recordId:'r1',recordNo:'R000001',rowVersion:3,state:'submitted',data:{title:'报销'},fieldVisibility:{title:'VISIBLE'}}
  const fetcher=businessFetch(async(url,init)=>{
    if(init?.method==='PATCH') {row={...row,rowVersion:4,data:{title:'server canonical current'}};return Response.json({recordId:'r1',rowVersion:4})}
    return Response.json(url.endsWith('/records/r1')?row:url.endsWith('/records')?{items:[row],fieldVisibility:row.fieldVisibility}:healthy()[`GET ${url}`]?.body)
  })
  vi.stubGlobal('fetch',fetcher);fetcher.loseNextBusinessReply()
  const mounted=render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  await screen.findByLabelText('title');fireEvent.click(screen.getByRole('button',{name:zh['system.tab.records']}))
  fireEvent.click(await screen.findByRole('button',{name:zh['list.open']}))
  fireEvent.change(await screen.findByLabelText('title'),{target:{value:'old frozen local edit'}})
  fireEvent.click(screen.getByRole('button',{name:zh['detail.save']}))
  await screen.findByText(zh['recovery.uncertain']);mounted.unmount()
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  await screen.findByLabelText('title');fireEvent.click(screen.getByRole('button',{name:zh['system.tab.records']}))
  fireEvent.click(await screen.findByRole('button',{name:zh['list.open']}))
  await screen.findByText(zh['recovery.saved'])
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.acknowledge']}))
  await waitFor(()=>expect(screen.getByLabelText('title')).toHaveProperty('value','server canonical current'))
  expect((screen.getByLabelText('title') as HTMLInputElement).disabled).toBe(false)
  expect(fetcher.mock.calls.filter(([,init])=>init?.method==='PATCH')).toHaveLength(1)
  fireEvent.click(screen.getAllByRole('button',{name:zh['detail.back']})[0]!)
  await screen.findByText('server canonical current')
})

it('a record read completing after Back cannot reopen the old detail',async()=>{
  let finish!:(response:Response)=>void
  const fetcher=businessFetch(async(url)=>url.endsWith('/records/r1')?new Promise<Response>(resolve=>{finish=resolve}):Response.json(healthy()[`GET ${url}`]?.body))
  vi.stubGlobal('fetch',fetcher)
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  await screen.findByLabelText('title');fireEvent.click(screen.getByRole('button',{name:zh['system.tab.records']}))
  fireEvent.click(await screen.findByRole('button',{name:zh['list.open']}))
  await waitFor(()=>expect(finish).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button',{name:zh['detail.back']}))
  finish(Response.json(healthy()['GET /api/v1/systems/golden_01/records/r1']!.body))
  await waitFor(()=>expect(screen.getByText('R000001')).toBeTruthy())
  expect(screen.queryByText(zh['detail.title'])).toBeNull()
})

it('focus revalidation discards the previous identity and rejects its late create completion',async()=>{
  let finish!:(response:Response)=>void
  const fetcher=businessFetch(async(url,init)=>init?.method==='POST'?new Promise<Response>(resolve=>{finish=resolve}):Response.json(healthy()[`GET ${url}`]?.body))
  vi.stubGlobal('fetch',fetcher)
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  fireEvent.change(await screen.findByLabelText('title'),{target:{value:'previous identity'}})
  fireEvent.click(screen.getByRole('button',{name:zh['form.submit']}))
  await waitFor(()=>expect(finish).toBeTypeOf('function'))
  fetcher.setEntrance({companyId:'new-company',userId:'new-user',sessionId:'new-session',gateway:'USER'})
  fireEvent.focus(window)
  await screen.findByRole('button',{name:zh['systems.open']})
  finish(Response.json({recordId:'previous-identity-record',rowVersion:1,recordNo:'OLD-IDENTITY'}))
  await waitFor(()=>expect(fetcher.committedCount()).toBe(1))
  expect(screen.queryByText(/OLD-IDENTITY/u)).toBeNull()
  expect(screen.queryByLabelText('title')).toBeNull()
})


it.each(['form','detail'])('a transient focus identity failure withholds editing and retains the same-session unsaved %s input',async(mode)=>{
  const normal=businessFetch(async(url)=>Response.json(healthy()[`GET ${url}`]?.body))
  let unavailable=false
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>url==='/auth/session'&&unavailable
    ?Promise.resolve(Response.json({error:'KVVI_UNREACHABLE'},{status:503})):normal(url,init)))
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  await screen.findByLabelText('title')
  if(mode==='detail'){
    fireEvent.click(screen.getByRole('button',{name:zh['system.tab.records']}))
    fireEvent.click(await screen.findByRole('button',{name:zh['list.open']}))
    await screen.findByLabelText('title')
  }
  fireEvent.change(screen.getByLabelText('title'),{target:{value:'keep unsaved same session'}})
  unavailable=true;fireEvent.focus(window)
  await screen.findByRole('alert')
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByLabelText('title').closest('[hidden]')?.hasAttribute('inert')).toBe(true)
  unavailable=false;fireEvent.click(screen.getByRole('button',{name:zh['read.retry']}))
  await waitFor(()=>expect(screen.getByRole('textbox')).toHaveProperty('value','keep unsaved same session'))
})


it.each([false,true])('identity revalidation withholds the retained subtree until a response (changed=%s)',async(changed)=>{
  const normal=businessFetch(async(url)=>Response.json(healthy()[`GET ${url}`]?.body))
  let defer=false,finish!:(response:Response)=>void
  vi.stubGlobal('fetch',vi.fn((url:string,init?:RequestInit)=>url==='/auth/session'&&defer
    ?new Promise<Response>(resolve=>{finish=resolve}):normal(url,init)))
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  fireEvent.change(await screen.findByLabelText('title'),{target:{value:'pending identity draft'}})
  defer=true;fireEvent.focus(window)
  await waitFor(()=>expect(finish).toBeTypeOf('function'))
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.getByLabelText('title').closest('[hidden]')?.hasAttribute('inert')).toBe(true)
  defer=false
  if(changed){
    const next={companyId:'other-company',userId:'other-user',sessionId:'other-session',gateway:'USER'}
    normal.setEntrance(next);finish(Response.json(next))
    await screen.findByRole('button',{name:zh['systems.open']})
    expect(screen.queryByLabelText('title')).toBeNull()
  }else{
    finish(Response.json(entrance))
    await waitFor(()=>expect(screen.getByRole('textbox')).toHaveProperty('value','pending identity draft'))
  }
})


it('ACK refreshes a list that was already loaded before the PATCH in the same occurrence',async()=>{
  let row={recordId:'r1',recordNo:'R000001',rowVersion:3,state:'submitted',data:{title:'old list value'},fieldVisibility:{title:'VISIBLE'}}
  const fetcher=businessFetch(async(url,init)=>{
    if(init?.method==='PATCH'){row={...row,rowVersion:4,data:{title:'current after patch'}};return Response.json({recordId:'r1',rowVersion:4})}
    return Response.json(url.endsWith('/records/r1')?row:url.endsWith('/records')?{items:[row],fieldVisibility:row.fieldVisibility}:healthy()[`GET ${url}`]?.body)
  })
  vi.stubGlobal('fetch',fetcher)
  render(<KvviSystemShell copy={t} initialSystem={SYSTEMS.items[0]!}/>)
  await screen.findByLabelText('title');fireEvent.click(screen.getByRole('button',{name:zh['system.tab.records']}))
  await screen.findByText('old list value')
  fireEvent.click(screen.getByRole('button',{name:zh['list.open']}))
  fireEvent.change(await screen.findByLabelText('title'),{target:{value:'local input'}})
  fireEvent.click(screen.getByRole('button',{name:zh['detail.save']}))
  await screen.findByText(zh['detail.saved'])
  fireEvent.click(screen.getByRole('button',{name:zh['recovery.acknowledge']}))
  await waitFor(()=>expect(screen.getByRole('textbox')).toHaveProperty('value','current after patch'))
  fireEvent.click(screen.getAllByRole('button',{name:zh['detail.back']})[0]!)
  await screen.findByText('current after patch')
  expect(screen.queryByText('old list value')).toBeNull()
  expect(fetcher.mock.calls.filter(([,init])=>init?.method==='PATCH')).toHaveLength(1)
})
