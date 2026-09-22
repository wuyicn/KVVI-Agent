export function canResumeRun(run) {
    return (run.status === 'error' || run.status === 'interrupted' || run.status === 'cancelled')
        && !run.parentRunId
        && run.resumedByRunId === undefined
        && run.resumable !== false
        && (run.status !== 'error' || run.failed === 1)
        && Boolean(run.checkpoint?.nodeId && run.snapshot?.nodes.some((node) => node.id === run.checkpoint?.nodeId));
}
export function recoverInterruptedRuns(runs, now = new Date().toISOString()) {
    return runs.map((run) => run.status === 'running'
        ? {
            ...run,
            status: 'interrupted',
            completedAt: now,
            resumable: canResumeRun({ ...run, status: 'interrupted' }),
        }
        : run.status === 'waiting'
            ? { ...run, resumable: false }
            : { ...run, resumable: canResumeRun(run) });
}
export function upsertRunRecord(runs, run, limit = 200) {
    const sorted = [run, ...runs.filter((candidate) => candidate.id !== run.id)]
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const active = sorted.filter((candidate) => candidate.status === 'queued' || candidate.status === 'running' || (candidate.status === 'waiting' && !candidate.resumedByRunId));
    const history = sorted.filter((candidate) => candidate.status !== 'queued' && candidate.status !== 'running' && (candidate.status !== 'waiting' || Boolean(candidate.resumedByRunId))).slice(0, limit);
    return [...active, ...history].sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}
