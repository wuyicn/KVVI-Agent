import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * Scheduled-task board — lists every saved schedule (cron workflow). Lets the
 * user view the latest run result for the current workflow, run once
 * immediately, or cancel a schedule.
 *
 * @module components/ScheduleBoard
 */
import { useEffect, useState } from 'react';
import { useCanvasStore } from '../store/canvas.js';
export function ScheduleBoard({ workflowId, onClose, onViewRun, }) {
    const [schedules, setSchedules] = useState([]);
    const [runs, setRuns] = useState([]);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState('');
    const refresh = async () => {
        setLoading(true);
        setErr('');
        try {
            const [sRes, rRes] = await Promise.all([
                fetch('/dsh-node-flow/schedules').then((r) => r.json().catch(() => ({}))),
                fetch('/dsh-node-flow/runs').then((r) => r.json().catch(() => ({}))),
            ]);
            setSchedules(sRes.schedules ?? []);
            setRuns(rRes.runs ?? []);
        }
        catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => {
        void refresh();
    }, []);
    useEffect(() => {
        const closeOnEscape = (event) => {
            if (event.key === 'Escape' && !loading)
                onClose();
        };
        document.addEventListener('keydown', closeOnEscape);
        return () => document.removeEventListener('keydown', closeOnEscape);
    }, [loading, onClose]);
    const latestRun = (id) => runs.find((r) => r.scheduleId === id);
    const visibleSchedules = workflowId
        ? schedules.filter((schedule) => schedule.id.startsWith(`workflow:${workflowId}:`))
        : schedules;
    const view = (s) => {
        const store = useCanvasStore.getState();
        const run = latestRun(s.id);
        if (!run) {
            setErr('该定时任务还没有运行结果。');
            return;
        }
        const belongsToCurrent = workflowId
            ? s.id.startsWith(`workflow:${workflowId}:`)
            : s.doc?.name === store.workflowName;
        if (!belongsToCurrent) {
            setErr('该定时任务属于其他工作流，请先从主页打开对应工作流。');
            return;
        }
        const currentNodeIds = new Set(store.nodes.map((node) => node.id));
        const at = new Date().toLocaleTimeString();
        let applied = 0;
        for (const node of store.nodes)
            store.updateNodeData(node.id, { lastRun: undefined });
        for (const n of run.nodes) {
            if (!currentNodeIds.has(n.id))
                continue;
            store.updateNodeData(n.id, {
                lastRun: { input: '', logs: n.logs ?? [], value: n.output, error: n.error, errorHandled: n.errorHandled, at, duration: n.ms },
            });
            applied += 1;
        }
        if (applied === 0) {
            setErr('运行记录与当前工作流版本不匹配。');
            return;
        }
        onClose();
        onViewRun?.();
    };
    const runOnce = async (s) => {
        setLoading(true);
        setErr('');
        try {
            const res = await fetch('/dsh-node-flow/schedule', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'run', id: s.id }),
            });
            const data = (await res.json().catch(() => ({})));
            if (!res.ok)
                setErr(data.error ?? '运行失败');
            await refresh();
        }
        catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
        finally {
            setLoading(false);
        }
    };
    const cancel = async (s) => {
        if (!window.confirm(`确定取消定时任务“${s.name}”吗？`))
            return;
        setLoading(true);
        setErr('');
        try {
            const res = await fetch('/dsh-node-flow/schedule', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'clear', id: s.id }),
            });
            const data = (await res.json().catch(() => ({})));
            if (!res.ok)
                setErr(data.error ?? '取消失败');
            await refresh();
        }
        catch (e) {
            setErr(e instanceof Error ? e.message : String(e));
        }
        finally {
            setLoading(false);
        }
    };
    return (_jsxs("div", { className: "wf-schedule-board", role: "dialog", "aria-modal": "true", "aria-label": "\u5B9A\u65F6\u4EFB\u52A1", children: [_jsxs("div", { className: "wf-schedule-board__head", children: [_jsx("div", { className: "wf-schedule-board__title", children: "\u5B9A\u65F6\u4EFB\u52A1" }), _jsx("button", { className: "wf-schedule-board__close", onClick: onClose, "aria-label": "\u5173\u95ED", children: "\u2715" })] }), _jsxs("div", { className: "wf-schedule-board__body", children: [_jsx("button", { className: "wf-btn", onClick: () => void refresh(), disabled: loading, children: "\u21BB \u5237\u65B0" }), err && _jsx("div", { className: "wf-schedule-board__err", children: err }), visibleSchedules.length === 0 && !loading && _jsx("div", { className: "wf-schedule-board__empty", children: "\u5F53\u524D\u5DE5\u4F5C\u6D41\u8FD8\u6CA1\u6709\u5B9A\u65F6\u4EFB\u52A1\u3002\u6DFB\u52A0 Schedule \u8282\u70B9\u5E76\u542F\u7528\u5DE5\u4F5C\u6D41\u540E\u4F1A\u663E\u793A\u5728\u8FD9\u91CC\u3002" }), visibleSchedules.map((s) => {
                        const run = latestRun(s.id);
                        const completed = run?.status === 'ok' || run?.status === 'handled';
                        const statusLabel = run?.status === 'ok'
                            ? '成功'
                            : run?.status === 'handled'
                                ? '错误已处理'
                                : run?.status === 'running'
                                    ? '运行中'
                                    : run?.status === 'cancelled'
                                        ? '已取消'
                                        : run?.status === 'interrupted'
                                            ? '已中断'
                                            : '失败';
                        return (_jsxs("div", { className: "wf-schedule-board__item", children: [_jsxs("div", { className: "wf-schedule-board__line", children: [_jsx("span", { className: "wf-schedule-board__name", children: s.name }), _jsx("code", { className: "wf-schedule-board__cron", children: s.cron })] }), _jsxs("div", { className: "wf-schedule-board__line wf-schedule-board__meta", children: [_jsxs("span", { children: ["\u65F6\u533A\uFF1A", s.timezoneLabel ?? s.timezone ?? '系统时区'] }), _jsxs("span", { children: ["\u4E0B\u6B21\u89E6\u53D1\uFF1A", s.nextFire ?? '—'] }), _jsxs("span", { children: ["\u4E0A\u6B21\u89E6\u53D1\uFF1A", s.lastFired ?? '—'] }), _jsxs("span", { className: run && !completed ? 'wf-schedule-board__bad wf-schedule-board__bad--err' : 'wf-schedule-board__bad', children: ["\u6700\u8FD1\u8FD0\u884C\uFF1A", run ? `${statusLabel}${run.failed ? `（${run.failed} 失败）` : ''}${run.handledErrors ? `（${run.handledErrors} 已处理）` : ''}` : '—'] })] }), s.configurationError && _jsxs("div", { className: "wf-schedule-board__err", children: ["\u8BA1\u5212\u914D\u7F6E\u65E0\u6548\uFF1A", s.configurationError] }), _jsxs("div", { className: "wf-schedule-board__actions", children: [_jsx("button", { className: "wf-btn", onClick: () => view(s), disabled: !run, children: "\u67E5\u770B\u7ED3\u679C" }), _jsx("button", { className: "wf-btn", onClick: () => void runOnce(s), disabled: loading, children: "\u8FD0\u884C\u4E00\u6B21" }), _jsx("button", { className: "wf-btn wf-btn--danger", onClick: () => void cancel(s), disabled: loading, children: "\u53D6\u6D88" })] })] }, s.id));
                    })] })] }));
}
