import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderOpen, FolderPlus, Pencil, Trash2, X } from 'lucide-react';
function folderCount(workflows, folderId) {
    return workflows.filter((workflow) => workflow.folderId === folderId).length;
}
export function WorkflowFolderNavigator({ folders, workflows, selected, onSelect, onCreateWorkflow, onCreateFolder, onRenameFolder, onDeleteFolder, }) {
    const [dialog, setDialog] = useState(null);
    const [name, setName] = useState('');
    const [targetFolderId, setTargetFolderId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const actionRef = useRef(false);
    const counts = useMemo(() => new Map(folders.map((folder) => [folder.id, folderCount(workflows, folder.id)])), [folders, workflows]);
    const uncategorizedCount = useMemo(() => folderCount(workflows), [workflows]);
    useEffect(() => {
        if (selected === 'all' || selected === 'uncategorized' || folders.some((folder) => folder.id === selected))
            return;
        onSelect('all');
    }, [folders, onSelect, selected]);
    useEffect(() => {
        const closeOnEscape = (event) => {
            if (event.key === 'Escape' && !actionRef.current)
                setDialog(null);
        };
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, []);
    const openDialog = (next) => {
        setDialog(next);
        setName(next.mode === 'rename' ? next.folder.name : '');
        setTargetFolderId('');
        setError('');
    };
    const currentFolderId = selected === 'all' || selected === 'uncategorized' ? undefined : selected;
    const selectedTitle = selected === 'all' ? '全部工作流' : selected === 'uncategorized' ? '未分类' : folders.find((folder) => folder.id === selected)?.name || '全部工作流';
    return (_jsxs("aside", { className: "wf-folder-navigator", "aria-label": "\u5DE5\u4F5C\u6D41\u6587\u4EF6\u5939", children: [_jsxs("div", { className: "wf-folder-navigator__header", children: [_jsx("span", { children: "\u6587\u4EF6\u5939" }), _jsx("button", { type: "button", onClick: () => openDialog({ mode: 'create' }), title: "\u65B0\u5EFA\u6587\u4EF6\u5939", "aria-label": "\u65B0\u5EFA\u6587\u4EF6\u5939", children: _jsx(FolderPlus, { size: 15 }) })] }), _jsxs("div", { className: "wf-folder-mobile-select", children: [_jsx("span", { children: "\u6587\u4EF6\u5939" }), _jsxs("div", { children: [_jsxs("select", { "aria-label": "\u6309\u6587\u4EF6\u5939\u7B5B\u9009\u5DE5\u4F5C\u6D41", value: selected, onChange: (event) => onSelect(event.target.value), children: [_jsxs("option", { value: "all", children: ["\u5168\u90E8\u5DE5\u4F5C\u6D41 (", workflows.length, ")"] }), _jsxs("option", { value: "uncategorized", children: ["\u672A\u5206\u7C7B (", uncategorizedCount, ")"] }), folders.map((folder) => _jsxs("option", { value: folder.id, children: [folder.name, " (", counts.get(folder.id) ?? 0, ")"] }, folder.id))] }), _jsx("button", { type: "button", onClick: () => openDialog({ mode: 'create' }), title: "\u65B0\u5EFA\u6587\u4EF6\u5939", "aria-label": "\u65B0\u5EFA\u6587\u4EF6\u5939", children: _jsx(FolderPlus, { size: 15 }) }), currentFolderId && _jsxs(_Fragment, { children: [_jsx("button", { type: "button", onClick: () => { const folder = folders.find((candidate) => candidate.id === currentFolderId); if (folder)
                                            openDialog({ mode: 'rename', folder }); }, title: "\u91CD\u547D\u540D\u5F53\u524D\u6587\u4EF6\u5939", "aria-label": "\u91CD\u547D\u540D\u5F53\u524D\u6587\u4EF6\u5939", children: _jsx(Pencil, { size: 14 }) }), _jsx("button", { type: "button", onClick: () => { const folder = folders.find((candidate) => candidate.id === currentFolderId); if (folder)
                                            openDialog({ mode: 'delete', folder }); }, title: "\u5220\u9664\u5F53\u524D\u6587\u4EF6\u5939", "aria-label": "\u5220\u9664\u5F53\u524D\u6587\u4EF6\u5939", children: _jsx(Trash2, { size: 14 }) })] })] })] }), _jsxs("div", { className: "wf-folder-navigator__list", children: [_jsxs("button", { type: "button", className: selected === 'all' ? 'is-active' : '', onClick: () => onSelect('all'), children: [_jsx(GridIcon, { active: selected === 'all' }), _jsx("span", { children: "\u5168\u90E8\u5DE5\u4F5C\u6D41" }), _jsx("small", { children: workflows.length })] }), _jsxs("button", { type: "button", className: selected === 'uncategorized' ? 'is-active' : '', onClick: () => onSelect('uncategorized'), children: [_jsx(FolderOpen, { size: 15 }), _jsx("span", { children: "\u672A\u5206\u7C7B" }), _jsx("small", { children: uncategorizedCount })] }), folders.map((folder) => {
                        const active = selected === folder.id;
                        return _jsxs("div", { className: `wf-folder-navigator__item${active ? ' is-active' : ''}`, children: [_jsxs("button", { type: "button", className: "wf-folder-navigator__select", onClick: () => onSelect(folder.id), "aria-pressed": active, children: [_jsx(Folder, { size: 15 }), _jsx("span", { children: folder.name }), _jsx("small", { children: counts.get(folder.id) ?? 0 })] }), _jsxs("span", { className: "wf-folder-navigator__actions", children: [_jsx("button", { type: "button", onClick: () => openDialog({ mode: 'rename', folder }), title: `重命名 ${folder.name}`, "aria-label": `重命名 ${folder.name}`, children: _jsx(Pencil, { size: 13 }) }), _jsx("button", { type: "button", onClick: () => openDialog({ mode: 'delete', folder }), title: `删除 ${folder.name}`, "aria-label": `删除 ${folder.name}`, children: _jsx(Trash2, { size: 13 }) })] })] }, folder.id);
                    })] }), _jsxs("button", { type: "button", className: "wf-folder-navigator__create", onClick: () => onCreateWorkflow(currentFolderId), children: [_jsx(FolderPlus, { size: 15 }), selected === 'all' ? '新建工作流' : `新建到${selectedTitle}`] }), dialog && _jsx("div", { className: "wf-dialog-backdrop", role: "presentation", onMouseDown: (event) => {
                    if (!busy && event.target === event.currentTarget)
                        setDialog(null);
                }, children: _jsxs("section", { className: "wf-credential-dialog wf-folder-dialog", role: "dialog", "aria-modal": "true", "aria-label": dialog.mode === 'create' ? '新建文件夹' : dialog.mode === 'rename' ? '重命名文件夹' : '删除文件夹', children: [_jsxs("header", { children: [_jsxs("div", { children: [_jsx(Folder, { size: 17 }), _jsx("strong", { children: dialog.mode === 'create' ? '新建文件夹' : dialog.mode === 'rename' ? '重命名文件夹' : '删除文件夹' })] }), _jsx("button", { className: "wf-icon-button", disabled: busy, onClick: () => setDialog(null), "aria-label": "\u5173\u95ED", children: _jsx(X, { size: 17 }) })] }), _jsxs("div", { className: "wf-credential-dialog__body", children: [dialog.mode !== 'delete' ? _jsxs("label", { children: [_jsx("span", { children: "\u540D\u79F0" }), _jsx("input", { "aria-label": "\u540D\u79F0", autoFocus: true, maxLength: 80, value: name, onChange: (event) => setName(event.target.value) })] }) : _jsxs(_Fragment, { children: [_jsx("strong", { children: dialog.folder.name }), _jsxs("p", { children: [counts.get(dialog.folder.id) ?? 0, " \u4E2A\u5DE5\u4F5C\u6D41\u4F1A\u79FB\u81F3\u4E0B\u65B9\u76EE\u6807\u3002\u6B64\u64CD\u4F5C\u4E0D\u4F1A\u6539\u53D8\u4EFB\u4F55\u8349\u7A3F\u6216\u5DF2\u53D1\u5E03\u7684\u6267\u884C\u5FEB\u7167\u3002"] }), _jsxs("label", { children: [_jsx("span", { children: "\u79FB\u52A8\u5230" }), _jsxs("select", { "aria-label": "\u79FB\u52A8\u5230", value: targetFolderId, onChange: (event) => setTargetFolderId(event.target.value), children: [_jsx("option", { value: "", children: "\u672A\u5206\u7C7B" }), folders.filter((folder) => folder.id !== dialog.folder.id).map((folder) => _jsx("option", { value: folder.id, children: folder.name }, folder.id))] })] })] }), error && _jsx("p", { className: "wf-wait-dialog__error", role: "alert", children: error })] }), _jsxs("footer", { children: [_jsx("button", { type: "button", disabled: busy, onClick: () => setDialog(null), children: "\u53D6\u6D88" }), _jsx("button", { type: "button", className: dialog.mode === 'delete' ? 'wf-dialog-btn wf-dialog-btn--danger' : 'wf-primary-command', disabled: busy || (dialog.mode !== 'delete' && !name.trim()), onClick: async () => {
                                        if (actionRef.current)
                                            return;
                                        actionRef.current = true;
                                        setBusy(true);
                                        setError('');
                                        try {
                                            if (dialog.mode === 'create') {
                                                const folder = await onCreateFolder(name);
                                                onSelect(folder.id);
                                            }
                                            else if (dialog.mode === 'rename') {
                                                const folder = await onRenameFolder(dialog.folder, name);
                                                if (selected === dialog.folder.id)
                                                    onSelect(folder.id);
                                            }
                                            else {
                                                await onDeleteFolder(dialog.folder, targetFolderId || undefined);
                                                if (selected === dialog.folder.id)
                                                    onSelect(targetFolderId || 'uncategorized');
                                            }
                                            setDialog(null);
                                        }
                                        catch (caught) {
                                            setError(caught instanceof Error ? caught.message : String(caught));
                                        }
                                        finally {
                                            actionRef.current = false;
                                            setBusy(false);
                                        }
                                    }, children: busy ? '正在保存' : dialog.mode === 'create' ? '创建文件夹' : dialog.mode === 'rename' ? '保存名称' : '删除并移动' })] })] }) })] }));
}
function GridIcon({ active }) {
    return active ? _jsx(FolderOpen, { size: 15 }) : _jsx(Folder, { size: 15 });
}
