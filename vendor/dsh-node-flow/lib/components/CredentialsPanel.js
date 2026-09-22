import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useCallback, useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Clock3, ExternalLink, KeyRound, Loader2, Pencil, PlugZap, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
const EMPTY_FORM = {
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
};
function kindLabel(kind) {
    if (kind === 'bearer')
        return 'Bearer Token';
    if (kind === 'api-key')
        return 'API Key';
    if (kind === 'basic')
        return 'Basic Auth';
    if (kind === 'oauth2')
        return 'OAuth2';
    return 'Webhook Secret';
}
function healthLabel(status, kind) {
    if (kind === 'webhook-secret')
        return '密钥已保存';
    if (status === 'authorizing')
        return '等待授权';
    if (status === 'connected')
        return '连接正常';
    if (status === 'expiring')
        return '即将过期';
    if (status === 'expired')
        return 'Token 已过期';
    if (status === 'error')
        return '连接异常';
    return '尚未测试';
}
function healthIcon(status) {
    if (status === 'connected')
        return _jsx(CircleCheck, { size: 12 });
    if (status === 'authorizing' || status === 'expiring')
        return _jsx(Clock3, { size: 12 });
    if (status === 'expired' || status === 'error')
        return _jsx(CircleAlert, { size: 12 });
    return _jsx(PlugZap, { size: 12 });
}
function formFromCredential(credential) {
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
    };
}
export function CredentialsPanel() {
    const [credentials, setCredentials] = useState([]);
    const [loading, setLoading] = useState(true);
    const [form, setForm] = useState(null);
    const [actionKey, setActionKey] = useState('');
    const [error, setError] = useState('');
    const actionLock = useRef(false);
    const oauthPopup = useRef(null);
    const oauthPoll = useRef(null);
    const oauthPollBusy = useRef(false);
    const authorizingCredentialId = useRef('');
    const callbackUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/dsh-node-flow/oauth2/callback`;
    const load = useCallback(async (showLoading = true) => {
        if (showLoading)
            setLoading(true);
        try {
            const response = await fetch('/dsh-node-flow/credentials', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            setCredentials(Array.isArray(data.credentials) ? data.credentials : []);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            if (showLoading)
                setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    useEffect(() => () => {
        if (oauthPoll.current)
            clearInterval(oauthPoll.current);
        oauthPopup.current?.close();
        if (authorizingCredentialId.current) {
            void fetch('/dsh-node-flow/credentials', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'cancel-authorize', id: authorizingCredentialId.current }),
            }).catch(() => { });
        }
        authorizingCredentialId.current = '';
    }, []);
    useEffect(() => {
        if (!form)
            return;
        const closeOnEscape = (event) => {
            if (event.key === 'Escape' && !actionLock.current)
                setForm(null);
        };
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, [form]);
    const beginAuthorization = async (credentialId, popup) => {
        if (authorizingCredentialId.current)
            throw new Error('已有 OAuth2 授权窗口正在进行');
        authorizingCredentialId.current = credentialId;
        let data;
        try {
            const response = await fetch('/dsh-node-flow/oauth2/start', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ id: credentialId, callbackUrl }),
            });
            data = await response.json();
            if (!response.ok || !data.authorizationUrl)
                throw new Error(data.error || `HTTP ${response.status}`);
        }
        catch (error) {
            authorizingCredentialId.current = '';
            throw error;
        }
        oauthPopup.current = popup;
        try {
            popup.opener = null;
        }
        catch { /* Browser may expose a read-only opener. */ }
        popup.location.replace(data.authorizationUrl);
        if (oauthPoll.current)
            clearInterval(oauthPoll.current);
        oauthPoll.current = setInterval(() => {
            if (oauthPollBusy.current)
                return;
            oauthPollBusy.current = true;
            void (async () => {
                try {
                    const statusResponse = await fetch('/dsh-node-flow/credentials', { cache: 'no-store' });
                    if (!statusResponse.ok)
                        return;
                    const statusData = await statusResponse.json();
                    if (!Array.isArray(statusData.credentials))
                        return;
                    const credential = statusData.credentials?.find((candidate) => candidate.id === credentialId);
                    if (!credential || credential.status === 'connected' || credential.status === 'error' || popup.closed) {
                        if (oauthPoll.current)
                            clearInterval(oauthPoll.current);
                        oauthPoll.current = null;
                        if (popup.closed && credential?.status === 'authorizing') {
                            const cancelResponse = await fetch('/dsh-node-flow/credentials', {
                                method: 'POST',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ action: 'cancel-authorize', id: credentialId }),
                            });
                            const cancelData = await cancelResponse.json();
                            setError(cancelData.credential?.statusMessage || 'OAuth2 授权窗口已关闭');
                        }
                        else if (credential?.status === 'error')
                            setError(credential.statusMessage || 'OAuth2 授权失败');
                        else if (credential?.status === 'connected')
                            setError('');
                        if (!popup.closed && credential?.status !== 'authorizing')
                            popup.close();
                        oauthPopup.current = null;
                        authorizingCredentialId.current = '';
                        await load(false);
                    }
                }
                catch {
                    if (popup.closed && oauthPoll.current) {
                        clearInterval(oauthPoll.current);
                        oauthPoll.current = null;
                        authorizingCredentialId.current = '';
                    }
                }
                finally {
                    oauthPollBusy.current = false;
                }
            })();
        }, 1200);
    };
    const save = async (authorizeAfter = false) => {
        if (!form || actionLock.current)
            return;
        const popup = authorizeAfter ? window.open('about:blank', `dsh-oauth2-${form.id || 'new'}`, 'popup,width=720,height=760') : null;
        if (authorizeAfter && !popup) {
            setError('浏览器阻止了 OAuth2 授权窗口，请允许弹窗后重试');
            return;
        }
        actionLock.current = true;
        setActionKey(authorizeAfter ? 'save-authorize' : 'save');
        setError('');
        try {
            const secret = form.kind === 'basic'
                ? (form.username || form.password ? { username: form.username, password: form.password } : undefined)
                : form.kind === 'oauth2'
                    ? (form.clientSecret ? { clientSecret: form.clientSecret } : undefined)
                    : (form.value ? { value: form.value } : undefined);
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
            });
            const data = await response.json();
            if (!response.ok || !data.credential)
                throw new Error(data.error || `HTTP ${response.status}`);
            setForm(null);
            await load(false);
            if (authorizeAfter && popup)
                await beginAuthorization(data.credential.id, popup);
        }
        catch (caught) {
            popup?.close();
            authorizingCredentialId.current = '';
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            actionLock.current = false;
            setActionKey('');
            await load(false);
        }
    };
    const authorize = async (credential) => {
        if (actionLock.current)
            return;
        const popup = window.open('about:blank', `dsh-oauth2-${credential.id}`, 'popup,width=720,height=760');
        if (!popup) {
            setError('浏览器阻止了 OAuth2 授权窗口，请允许弹窗后重试');
            return;
        }
        actionLock.current = true;
        setActionKey(`authorize:${credential.id}`);
        setError('');
        try {
            await beginAuthorization(credential.id, popup);
        }
        catch (caught) {
            popup.close();
            authorizingCredentialId.current = '';
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            actionLock.current = false;
            setActionKey('');
            await load(false);
        }
    };
    const testConnection = async (credential) => {
        if (actionLock.current)
            return;
        actionLock.current = true;
        setActionKey(`test:${credential.id}`);
        setError('');
        try {
            const response = await fetch('/dsh-node-flow/credentials', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'test', id: credential.id }),
            });
            const data = await response.json();
            if (!response.ok || !data.credential)
                throw new Error(data.error || `HTTP ${response.status}`);
            await load(false);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
            await load(false);
        }
        finally {
            actionLock.current = false;
            setActionKey('');
        }
    };
    const remove = async (credential) => {
        if (actionLock.current || !window.confirm(`删除凭据“${credential.name}”？`))
            return;
        actionLock.current = true;
        setActionKey(`delete:${credential.id}`);
        setError('');
        try {
            const response = await fetch('/dsh-node-flow/credentials', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id: credential.id }),
            });
            const data = await response.json();
            if (!response.ok)
                throw new Error(data.error || `HTTP ${response.status}`);
            await load(false);
        }
        catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        }
        finally {
            actionLock.current = false;
            setActionKey('');
        }
    };
    return (_jsxs(_Fragment, { children: [_jsxs("header", { className: "wf-page-header", children: [_jsxs("div", { children: [_jsx("h1", { children: "\u8FDE\u63A5" }), _jsx("p", { children: "\u96C6\u4E2D\u7BA1\u7406\u51FA\u7AD9\u8BA4\u8BC1\u4E0E Webhook \u9A8C\u7B7E\u5BC6\u94A5\u3002\u6240\u6709\u5BC6\u94A5\u548C OAuth2 Token \u53EA\u5728 DSH \u4E3B\u673A\u52A0\u5BC6\u4FDD\u5B58\u3002" })] }), _jsx("div", { className: "wf-page-header__actions", children: _jsxs("button", { className: "wf-primary-command", onClick: () => setForm({ ...EMPTY_FORM }), children: [_jsx(Plus, { size: 16 }), " \u65B0\u5EFA\u8FDE\u63A5"] }) })] }), error && _jsx("div", { className: "wf-credential-error", children: error }), _jsxs("div", { className: "wf-credential-list", children: [loading && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(Loader2, { className: "wf-spin", size: 24 }), _jsx("strong", { children: "\u6B63\u5728\u52A0\u8F7D\u8FDE\u63A5" })] }), !loading && credentials.length === 0 && _jsxs("div", { className: "wf-dashboard-empty", children: [_jsx(KeyRound, { size: 25 }), _jsx("strong", { children: "\u6682\u65E0\u8FDE\u63A5" }), _jsx("p", { children: "\u521B\u5EFA\u8FDE\u63A5\u540E\uFF0C\u53EF\u5728\u5E94\u7528\u8FDE\u63A5\u5668\u548C HTTP \u8BF7\u6C42\u8282\u70B9\u4E2D\u76F4\u63A5\u5F15\u7528\u3002" })] }), credentials.map((credential) => (_jsxs("article", { children: [_jsx("span", { className: "wf-credential-list__icon", children: _jsx(ShieldCheck, { size: 19 }) }), _jsxs("div", { className: "wf-credential-list__main", children: [_jsx("strong", { children: credential.name }), _jsxs("span", { children: [kindLabel(credential.kind), credential.headerName ? ` · ${credential.headerName}` : '', credential.clientId ? ` · ${credential.clientId}` : ''] }), _jsxs("span", { className: `wf-credential-health is-${credential.status || 'untested'}`, title: credential.statusMessage, children: [healthIcon(credential.status), " ", healthLabel(credential.status, credential.kind), credential.expiresAt ? ` · ${new Date(credential.expiresAt).toLocaleString('zh-CN')}` : ''] }), credential.statusMessage && _jsx("small", { children: credential.statusMessage })] }), _jsx("time", { children: new Date(credential.updatedAt).toLocaleString('zh-CN') }), _jsxs("div", { className: "wf-credential-actions", children: [credential.kind === 'oauth2' && _jsx("button", { className: "wf-icon-button", onClick: () => void authorize(credential), title: "OAuth2 \u6388\u6743", "aria-label": `授权 ${credential.name}`, children: actionKey === `authorize:${credential.id}` ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(ExternalLink, { size: 15 }) }), credential.kind !== 'webhook-secret' && _jsx("button", { className: "wf-icon-button", onClick: () => void testConnection(credential), title: "\u6D4B\u8BD5\u8FDE\u63A5", "aria-label": `测试 ${credential.name}`, children: actionKey === `test:${credential.id}` ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(PlugZap, { size: 15 }) }), _jsx("button", { className: "wf-icon-button", onClick: () => setForm(formFromCredential(credential)), title: "\u7F16\u8F91", "aria-label": `编辑 ${credential.name}`, children: _jsx(Pencil, { size: 15 }) }), _jsx("button", { className: "wf-icon-button is-danger", onClick: () => void remove(credential), title: "\u5220\u9664", "aria-label": `删除 ${credential.name}`, children: actionKey === `delete:${credential.id}` ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(Trash2, { size: 15 }) })] })] }, credential.id)))] }), form && (_jsx("div", { className: "wf-dialog-backdrop", role: "presentation", onMouseDown: (event) => { if (event.target === event.currentTarget && !actionLock.current)
                    setForm(null); }, children: _jsxs("section", { className: "wf-credential-dialog", role: "dialog", "aria-modal": "true", "aria-label": form.id ? '编辑连接' : '新建连接', children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(KeyRound, { size: 18 }), _jsx("strong", { children: form.id ? '编辑连接' : '新建连接' })] }), _jsx("button", { className: "wf-icon-button", onClick: () => !actionLock.current && setForm(null), "aria-label": "\u5173\u95ED", children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [_jsxs("label", { children: [_jsx("span", { children: "\u540D\u79F0" }), _jsx("input", { autoFocus: true, value: form.name, onChange: (event) => setForm({ ...form, name: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u8BA4\u8BC1\u7C7B\u578B" }), _jsxs("select", { value: form.kind, onChange: (event) => setForm({ ...form, kind: event.target.value }), children: [_jsx("option", { value: "bearer", children: "Bearer Token" }), _jsx("option", { value: "api-key", children: "API Key" }), _jsx("option", { value: "basic", children: "Basic Auth" }), _jsx("option", { value: "oauth2", children: "OAuth2 Authorization Code" }), _jsx("option", { value: "webhook-secret", children: "Webhook Secret (HMAC-SHA256)" })] })] }), form.kind === 'api-key' && _jsxs("label", { children: [_jsx("span", { children: "Header \u540D\u79F0" }), _jsx("input", { value: form.headerName, onChange: (event) => setForm({ ...form, headerName: event.target.value }) })] }), form.kind === 'basic' && _jsxs(_Fragment, { children: [_jsxs("label", { children: [_jsx("span", { children: "\u7528\u6237\u540D" }), _jsx("input", { autoComplete: "off", value: form.username, onChange: (event) => setForm({ ...form, username: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u5BC6\u7801" }), _jsx("input", { type: "password", autoComplete: "new-password", placeholder: form.id ? '留空则保持不变' : '', value: form.password, onChange: (event) => setForm({ ...form, password: event.target.value }) })] })] }), (form.kind === 'bearer' || form.kind === 'api-key' || form.kind === 'webhook-secret') && _jsxs("label", { children: [_jsx("span", { children: form.kind === 'bearer' ? 'Token' : form.kind === 'api-key' ? 'API Key' : '签名密钥' }), _jsx("input", { type: "password", autoComplete: "new-password", minLength: form.kind === 'webhook-secret' ? 16 : undefined, placeholder: form.id ? '留空则保持不变' : form.kind === 'webhook-secret' ? '至少 16 个字符' : '', value: form.value, onChange: (event) => setForm({ ...form, value: event.target.value }) }), form.kind === 'webhook-secret' && _jsx("small", { children: "\u53D1\u9001\u65B9\u9700\u4F7F\u7528\u6B64\u5BC6\u94A5\u5BF9\u539F\u59CB\u8BF7\u6C42\u4F53\u8BA1\u7B97 HMAC-SHA256\u3002" })] }), form.kind === 'oauth2' && _jsxs(_Fragment, { children: [_jsxs("label", { children: [_jsx("span", { children: "\u56DE\u8C03 URL" }), _jsxs("div", { className: "wf-credential-copy", children: [_jsx("input", { readOnly: true, value: callbackUrl }), _jsx("button", { type: "button", onClick: () => void navigator.clipboard.writeText(callbackUrl), children: "\u590D\u5236" })] }), _jsx("small", { children: "\u5728 OAuth2 \u670D\u52A1\u5546\u7684\u5E94\u7528\u8BBE\u7F6E\u4E2D\u767B\u8BB0\u6B64\u5730\u5740\u3002" })] }), _jsxs("label", { children: [_jsx("span", { children: "\u6388\u6743 URL" }), _jsx("input", { placeholder: "https://provider.example.com/oauth/authorize", value: form.authorizationUrl, onChange: (event) => setForm({ ...form, authorizationUrl: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "Token URL" }), _jsx("input", { placeholder: "https://provider.example.com/oauth/token", value: form.tokenUrl, onChange: (event) => setForm({ ...form, tokenUrl: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "Client ID" }), _jsx("input", { autoComplete: "off", value: form.clientId, onChange: (event) => setForm({ ...form, clientId: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "Client Secret" }), _jsx("input", { type: "password", autoComplete: "new-password", placeholder: form.id ? '留空则保持不变' : '', value: form.clientSecret, onChange: (event) => setForm({ ...form, clientSecret: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "Scopes" }), _jsx("input", { placeholder: "read write offline_access", value: form.scopes, onChange: (event) => setForm({ ...form, scopes: event.target.value }) })] }), _jsxs("div", { className: "wf-field-row", children: [_jsxs("label", { children: [_jsx("span", { children: "\u5BA2\u6237\u7AEF\u8BA4\u8BC1" }), _jsxs("select", { value: form.clientAuth, onChange: (event) => setForm({ ...form, clientAuth: event.target.value }), children: [_jsx("option", { value: "body", children: "\u8BF7\u6C42\u4F53" }), _jsx("option", { value: "basic", children: "Basic Header" }), _jsx("option", { value: "none", children: "\u516C\u5F00\u5BA2\u6237\u7AEF" })] })] }), _jsxs("label", { className: "wf-credential-check", children: [_jsx("input", { type: "checkbox", checked: form.usePkce, onChange: (event) => setForm({ ...form, usePkce: event.target.checked }) }), _jsx("span", { children: "\u542F\u7528 PKCE S256" })] })] }), _jsxs("details", { className: "wf-credential-advanced", children: [_jsx("summary", { children: "\u9AD8\u7EA7 OAuth2 \u53C2\u6570" }), _jsxs("label", { children: [_jsx("span", { children: "\u989D\u5916\u6388\u6743\u53C2\u6570 JSON" }), _jsx("textarea", { rows: 3, placeholder: '{"prompt":"consent"}', value: form.extraAuthParams, onChange: (event) => setForm({ ...form, extraAuthParams: event.target.value }) })] }), _jsxs("label", { children: [_jsx("span", { children: "\u989D\u5916 Token \u53C2\u6570 JSON" }), _jsx("textarea", { rows: 3, placeholder: '{"audience":"api"}', value: form.extraTokenParams, onChange: (event) => setForm({ ...form, extraTokenParams: event.target.value }) })] })] })] }), form.kind !== 'webhook-secret' && _jsxs("label", { children: [_jsx("span", { children: "\u8FDE\u63A5\u6D4B\u8BD5 URL" }), _jsx("input", { placeholder: "https://api.example.com/me", value: form.testUrl, onChange: (event) => setForm({ ...form, testUrl: event.target.value }) }), _jsx("small", { children: "\u4F7F\u7528\u5F53\u524D\u8BA4\u8BC1\u53D1\u9001 GET \u8BF7\u6C42\uFF0C\u4EC5\u8BB0\u5F55\u72B6\u6001\uFF0C\u4E0D\u4FDD\u5B58\u54CD\u5E94\u5185\u5BB9\u3002" })] })] }), _jsxs("footer", { children: [_jsx("button", { onClick: () => setForm(null), disabled: Boolean(actionKey), children: "\u53D6\u6D88" }), form.kind === 'oauth2' && _jsxs("button", { className: "wf-dialog-btn--secondary", onClick: () => void save(true), disabled: Boolean(actionKey) || !form.name.trim(), children: [actionKey === 'save-authorize' ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(RefreshCw, { size: 15 }), " \u4FDD\u5B58\u5E76\u6388\u6743"] }), _jsxs("button", { className: "wf-primary-command", onClick: () => void save(false), disabled: Boolean(actionKey) || !form.name.trim(), children: [actionKey === 'save' ? _jsx(Loader2, { className: "wf-spin", size: 15 }) : _jsx(ShieldCheck, { size: 15 }), actionKey === 'save' ? '保存中' : '保存连接'] })] })] }) }))] }));
}
