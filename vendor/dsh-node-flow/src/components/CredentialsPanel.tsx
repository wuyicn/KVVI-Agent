import { useCallback, useEffect, useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Clock3, ExternalLink, KeyRound, Loader2, Pencil, PlugZap, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import type { CredentialHealth, CredentialKind, CredentialSummary, OAuth2ClientAuth } from '../model.js'

type FormState = {
  id?: string
  name: string
  kind: CredentialKind
  headerName: string
  value: string
  username: string
  password: string
  testUrl: string
  authorizationUrl: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  scopes: string
  clientAuth: OAuth2ClientAuth
  usePkce: boolean
  extraAuthParams: string
  extraTokenParams: string
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'bearer',
  headerName: 'X-API-Key',
  value: '',
  username: '',
  password: '',
  testUrl: '',
  authorizationUrl: '',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: '',
  clientAuth: 'body',
  usePkce: true,
  extraAuthParams: '',
  extraTokenParams: '',
}

function kindLabel(kind: CredentialKind): string {
  if (kind === 'bearer') return 'Bearer Token'
  if (kind === 'api-key') return 'API Key'
  if (kind === 'basic') return 'Basic Auth'
  if (kind === 'oauth2') return 'OAuth2'
  return 'Webhook Secret'
}

function healthLabel(status: CredentialHealth | undefined, kind?: CredentialKind): string {
  if (kind === 'webhook-secret') return '密钥已保存'
  if (status === 'authorizing') return '等待授权'
  if (status === 'connected') return '连接正常'
  if (status === 'expiring') return '即将过期'
  if (status === 'expired') return 'Token 已过期'
  if (status === 'error') return '连接异常'
  return '尚未测试'
}

function healthIcon(status: CredentialHealth | undefined) {
  if (status === 'connected') return <CircleCheck size={12} />
  if (status === 'authorizing' || status === 'expiring') return <Clock3 size={12} />
  if (status === 'expired' || status === 'error') return <CircleAlert size={12} />
  return <PlugZap size={12} />
}

function formFromCredential(credential: CredentialSummary): FormState {
  return {
    ...EMPTY_FORM,
    id: credential.id,
    name: credential.name,
    kind: credential.kind,
    headerName: credential.headerName || 'X-API-Key',
    testUrl: credential.testUrl || '',
    authorizationUrl: credential.authorizationUrl || '',
    tokenUrl: credential.tokenUrl || '',
    clientId: credential.clientId || '',
    scopes: credential.scopes || '',
    clientAuth: credential.clientAuth || 'body',
    usePkce: credential.usePkce !== false,
    extraAuthParams: credential.extraAuthParams || '',
    extraTokenParams: credential.extraTokenParams || '',
  }
}

export function CredentialsPanel() {
  const [credentials, setCredentials] = useState<CredentialSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<FormState | null>(null)
  const [actionKey, setActionKey] = useState('')
  const [error, setError] = useState('')
  const actionLock = useRef(false)
  const oauthPopup = useRef<Window | null>(null)
  const oauthPoll = useRef<ReturnType<typeof setInterval> | null>(null)
  const oauthPollBusy = useRef(false)
  const authorizingCredentialId = useRef('')
  const callbackUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/dsh-node-flow/oauth2/callback`

  const load = useCallback(async (showLoading = true): Promise<void> => {
    if (showLoading) setLoading(true)
    try {
      const response = await fetch('/dsh-node-flow/credentials', { cache: 'no-store' })
      const data = await response.json() as { credentials?: CredentialSummary[]; error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      setCredentials(Array.isArray(data.credentials) ? data.credentials : [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (showLoading) setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => () => {
    if (oauthPoll.current) clearInterval(oauthPoll.current)
    oauthPopup.current?.close()
    if (authorizingCredentialId.current) {
      void fetch('/dsh-node-flow/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cancel-authorize', id: authorizingCredentialId.current }),
      }).catch(() => {})
    }
    authorizingCredentialId.current = ''
  }, [])

  useEffect(() => {
    if (!form) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !actionLock.current) setForm(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [form])

  const beginAuthorization = async (credentialId: string, popup: Window): Promise<void> => {
    if (authorizingCredentialId.current) throw new Error('已有 OAuth2 授权窗口正在进行')
    authorizingCredentialId.current = credentialId
    let data: { authorizationUrl?: string; error?: string }
    try {
      const response = await fetch('/dsh-node-flow/oauth2/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: credentialId, callbackUrl }),
      })
      data = await response.json() as { authorizationUrl?: string; error?: string }
      if (!response.ok || !data.authorizationUrl) throw new Error(data.error || `HTTP ${response.status}`)
    } catch (error) {
      authorizingCredentialId.current = ''
      throw error
    }
    oauthPopup.current = popup
    try { popup.opener = null } catch { /* Browser may expose a read-only opener. */ }
    popup.location.replace(data.authorizationUrl)
    if (oauthPoll.current) clearInterval(oauthPoll.current)
    oauthPoll.current = setInterval(() => {
      if (oauthPollBusy.current) return
      oauthPollBusy.current = true
      void (async () => {
        try {
          const statusResponse = await fetch('/dsh-node-flow/credentials', { cache: 'no-store' })
          if (!statusResponse.ok) return
          const statusData = await statusResponse.json() as { credentials?: CredentialSummary[] }
          if (!Array.isArray(statusData.credentials)) return
          const credential = statusData.credentials?.find((candidate) => candidate.id === credentialId)
          if (!credential || credential.status === 'connected' || credential.status === 'error' || popup.closed) {
            if (oauthPoll.current) clearInterval(oauthPoll.current)
            oauthPoll.current = null
            if (popup.closed && credential?.status === 'authorizing') {
              const cancelResponse = await fetch('/dsh-node-flow/credentials', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'cancel-authorize', id: credentialId }),
              })
              const cancelData = await cancelResponse.json() as { credential?: CredentialSummary }
              setError(cancelData.credential?.statusMessage || 'OAuth2 授权窗口已关闭')
            } else if (credential?.status === 'error') setError(credential.statusMessage || 'OAuth2 授权失败')
            else if (credential?.status === 'connected') setError('')
            if (!popup.closed && credential?.status !== 'authorizing') popup.close()
            oauthPopup.current = null
            authorizingCredentialId.current = ''
            await load(false)
          }
        } catch {
          if (popup.closed && oauthPoll.current) {
            clearInterval(oauthPoll.current)
            oauthPoll.current = null
            authorizingCredentialId.current = ''
          }
        } finally {
          oauthPollBusy.current = false
        }
      })()
    }, 1200)
  }

  const save = async (authorizeAfter = false): Promise<void> => {
    if (!form || actionLock.current) return
    const popup = authorizeAfter ? window.open('about:blank', `dsh-oauth2-${form.id || 'new'}`, 'popup,width=720,height=760') : null
    if (authorizeAfter && !popup) {
      setError('浏览器阻止了 OAuth2 授权窗口，请允许弹窗后重试')
      return
    }
    actionLock.current = true
    setActionKey(authorizeAfter ? 'save-authorize' : 'save')
    setError('')
    try {
      const secret = form.kind === 'basic'
        ? (form.username || form.password ? { username: form.username, password: form.password } : undefined)
        : form.kind === 'oauth2'
          ? (form.clientSecret ? { clientSecret: form.clientSecret } : undefined)
          : (form.value ? { value: form.value } : undefined)
      const response = await fetch('/dsh-node-flow/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          credential: {
            id: form.id,
            name: form.name,
            kind: form.kind,
            headerName: form.headerName,
            testUrl: form.testUrl,
            authorizationUrl: form.authorizationUrl,
            tokenUrl: form.tokenUrl,
            clientId: form.clientId,
            scopes: form.scopes,
            clientAuth: form.clientAuth,
            usePkce: form.usePkce,
            extraAuthParams: form.extraAuthParams,
            extraTokenParams: form.extraTokenParams,
            secret,
          },
        }),
      })
      const data = await response.json() as { credential?: CredentialSummary; error?: string }
      if (!response.ok || !data.credential) throw new Error(data.error || `HTTP ${response.status}`)
      setForm(null)
      await load(false)
      if (authorizeAfter && popup) await beginAuthorization(data.credential.id, popup)
    } catch (caught) {
      popup?.close()
      authorizingCredentialId.current = ''
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      actionLock.current = false
      setActionKey('')
      await load(false)
    }
  }

  const authorize = async (credential: CredentialSummary): Promise<void> => {
    if (actionLock.current) return
    const popup = window.open('about:blank', `dsh-oauth2-${credential.id}`, 'popup,width=720,height=760')
    if (!popup) {
      setError('浏览器阻止了 OAuth2 授权窗口，请允许弹窗后重试')
      return
    }
    actionLock.current = true
    setActionKey(`authorize:${credential.id}`)
    setError('')
    try {
      await beginAuthorization(credential.id, popup)
    } catch (caught) {
      popup.close()
      authorizingCredentialId.current = ''
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      actionLock.current = false
      setActionKey('')
      await load(false)
    }
  }

  const testConnection = async (credential: CredentialSummary): Promise<void> => {
    if (actionLock.current) return
    actionLock.current = true
    setActionKey(`test:${credential.id}`)
    setError('')
    try {
      const response = await fetch('/dsh-node-flow/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'test', id: credential.id }),
      })
      const data = await response.json() as { credential?: CredentialSummary; error?: string }
      if (!response.ok || !data.credential) throw new Error(data.error || `HTTP ${response.status}`)
      await load(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      await load(false)
    } finally {
      actionLock.current = false
      setActionKey('')
    }
  }

  const remove = async (credential: CredentialSummary): Promise<void> => {
    if (actionLock.current || !window.confirm(`删除凭据“${credential.name}”？`)) return
    actionLock.current = true
    setActionKey(`delete:${credential.id}`)
    setError('')
    try {
      const response = await fetch('/dsh-node-flow/credentials', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id: credential.id }),
      })
      const data = await response.json() as { error?: string }
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
      await load(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      actionLock.current = false
      setActionKey('')
    }
  }

  return (
    <>
      <header className="wf-page-header">
        <div><h1>连接</h1><p>集中管理出站认证与 Webhook 验签密钥。所有密钥和 OAuth2 Token 只在 DSH 主机加密保存。</p></div>
        <div className="wf-page-header__actions"><button className="wf-primary-command" onClick={() => setForm({ ...EMPTY_FORM })}><Plus size={16} /> 新建连接</button></div>
      </header>
      {error && <div className="wf-credential-error">{error}</div>}
      <div className="wf-credential-list">
        {loading && <div className="wf-dashboard-empty"><Loader2 className="wf-spin" size={24} /><strong>正在加载连接</strong></div>}
        {!loading && credentials.length === 0 && <div className="wf-dashboard-empty"><KeyRound size={25} /><strong>暂无连接</strong><p>创建连接后，可在应用连接器和 HTTP 请求节点中直接引用。</p></div>}
        {credentials.map((credential) => (
          <article key={credential.id}>
            <span className="wf-credential-list__icon"><ShieldCheck size={19} /></span>
            <div className="wf-credential-list__main">
              <strong>{credential.name}</strong>
              <span>{kindLabel(credential.kind)}{credential.headerName ? ` · ${credential.headerName}` : ''}{credential.clientId ? ` · ${credential.clientId}` : ''}</span>
              <span className={`wf-credential-health is-${credential.status || 'untested'}`} title={credential.statusMessage}>{healthIcon(credential.status)} {healthLabel(credential.status, credential.kind)}{credential.expiresAt ? ` · ${new Date(credential.expiresAt).toLocaleString('zh-CN')}` : ''}</span>
              {credential.statusMessage && <small>{credential.statusMessage}</small>}
            </div>
            <time>{new Date(credential.updatedAt).toLocaleString('zh-CN')}</time>
            <div className="wf-credential-actions">
              {credential.kind === 'oauth2' && <button className="wf-icon-button" onClick={() => void authorize(credential)} title="OAuth2 授权" aria-label={`授权 ${credential.name}`}>{actionKey === `authorize:${credential.id}` ? <Loader2 className="wf-spin" size={15} /> : <ExternalLink size={15} />}</button>}
              {credential.kind !== 'webhook-secret' && <button className="wf-icon-button" onClick={() => void testConnection(credential)} title="测试连接" aria-label={`测试 ${credential.name}`}>{actionKey === `test:${credential.id}` ? <Loader2 className="wf-spin" size={15} /> : <PlugZap size={15} />}</button>}
              <button className="wf-icon-button" onClick={() => setForm(formFromCredential(credential))} title="编辑" aria-label={`编辑 ${credential.name}`}><Pencil size={15} /></button>
              <button className="wf-icon-button is-danger" onClick={() => void remove(credential)} title="删除" aria-label={`删除 ${credential.name}`}>{actionKey === `delete:${credential.id}` ? <Loader2 className="wf-spin" size={15} /> : <Trash2 size={15} />}</button>
            </div>
          </article>
        ))}
      </div>
      {form && (
        <div className="wf-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !actionLock.current) setForm(null) }}>
          <section className="wf-credential-dialog" role="dialog" aria-modal="true" aria-label={form.id ? '编辑连接' : '新建连接'}>
            <header><div><KeyRound size={18} /><strong>{form.id ? '编辑连接' : '新建连接'}</strong></div><button className="wf-icon-button" onClick={() => !actionLock.current && setForm(null)} aria-label="关闭"><X size={17} /></button></header>
            <div className="wf-credential-dialog__body">
              <label><span>名称</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <label><span>认证类型</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as CredentialKind })}><option value="bearer">Bearer Token</option><option value="api-key">API Key</option><option value="basic">Basic Auth</option><option value="oauth2">OAuth2 Authorization Code</option><option value="webhook-secret">Webhook Secret (HMAC-SHA256)</option></select></label>
              {form.kind === 'api-key' && <label><span>Header 名称</span><input value={form.headerName} onChange={(event) => setForm({ ...form, headerName: event.target.value })} /></label>}
              {form.kind === 'basic' && <><label><span>用户名</span><input autoComplete="off" value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} /></label><label><span>密码</span><input type="password" autoComplete="new-password" placeholder={form.id ? '留空则保持不变' : ''} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></label></>}
              {(form.kind === 'bearer' || form.kind === 'api-key' || form.kind === 'webhook-secret') && <label><span>{form.kind === 'bearer' ? 'Token' : form.kind === 'api-key' ? 'API Key' : '签名密钥'}</span><input type="password" autoComplete="new-password" minLength={form.kind === 'webhook-secret' ? 16 : undefined} placeholder={form.id ? '留空则保持不变' : form.kind === 'webhook-secret' ? '至少 16 个字符' : ''} value={form.value} onChange={(event) => setForm({ ...form, value: event.target.value })} />{form.kind === 'webhook-secret' && <small>发送方需使用此密钥对原始请求体计算 HMAC-SHA256。</small>}</label>}
              {form.kind === 'oauth2' && <>
                <label><span>回调 URL</span><div className="wf-credential-copy"><input readOnly value={callbackUrl} /><button type="button" onClick={() => void navigator.clipboard.writeText(callbackUrl)}>复制</button></div><small>在 OAuth2 服务商的应用设置中登记此地址。</small></label>
                <label><span>授权 URL</span><input placeholder="https://provider.example.com/oauth/authorize" value={form.authorizationUrl} onChange={(event) => setForm({ ...form, authorizationUrl: event.target.value })} /></label>
                <label><span>Token URL</span><input placeholder="https://provider.example.com/oauth/token" value={form.tokenUrl} onChange={(event) => setForm({ ...form, tokenUrl: event.target.value })} /></label>
                <label><span>Client ID</span><input autoComplete="off" value={form.clientId} onChange={(event) => setForm({ ...form, clientId: event.target.value })} /></label>
                <label><span>Client Secret</span><input type="password" autoComplete="new-password" placeholder={form.id ? '留空则保持不变' : ''} value={form.clientSecret} onChange={(event) => setForm({ ...form, clientSecret: event.target.value })} /></label>
                <label><span>Scopes</span><input placeholder="read write offline_access" value={form.scopes} onChange={(event) => setForm({ ...form, scopes: event.target.value })} /></label>
                <div className="wf-field-row">
                  <label><span>客户端认证</span><select value={form.clientAuth} onChange={(event) => setForm({ ...form, clientAuth: event.target.value as OAuth2ClientAuth })}><option value="body">请求体</option><option value="basic">Basic Header</option><option value="none">公开客户端</option></select></label>
                  <label className="wf-credential-check"><input type="checkbox" checked={form.usePkce} onChange={(event) => setForm({ ...form, usePkce: event.target.checked })} /><span>启用 PKCE S256</span></label>
                </div>
                <details className="wf-credential-advanced"><summary>高级 OAuth2 参数</summary><label><span>额外授权参数 JSON</span><textarea rows={3} placeholder={'{"prompt":"consent"}'} value={form.extraAuthParams} onChange={(event) => setForm({ ...form, extraAuthParams: event.target.value })} /></label><label><span>额外 Token 参数 JSON</span><textarea rows={3} placeholder={'{"audience":"api"}'} value={form.extraTokenParams} onChange={(event) => setForm({ ...form, extraTokenParams: event.target.value })} /></label></details>
              </>}
              {form.kind !== 'webhook-secret' && <label><span>连接测试 URL</span><input placeholder="https://api.example.com/me" value={form.testUrl} onChange={(event) => setForm({ ...form, testUrl: event.target.value })} /><small>使用当前认证发送 GET 请求，仅记录状态，不保存响应内容。</small></label>}
            </div>
            <footer>
              <button onClick={() => setForm(null)} disabled={Boolean(actionKey)}>取消</button>
              {form.kind === 'oauth2' && <button className="wf-dialog-btn--secondary" onClick={() => void save(true)} disabled={Boolean(actionKey) || !form.name.trim()}>{actionKey === 'save-authorize' ? <Loader2 className="wf-spin" size={15} /> : <RefreshCw size={15} />} 保存并授权</button>}
              <button className="wf-primary-command" onClick={() => void save(false)} disabled={Boolean(actionKey) || !form.name.trim()}>{actionKey === 'save' ? <Loader2 className="wf-spin" size={15} /> : <ShieldCheck size={15} />}{actionKey === 'save' ? '保存中' : '保存连接'}</button>
            </footer>
          </section>
        </div>
      )}
    </>
  )
}
