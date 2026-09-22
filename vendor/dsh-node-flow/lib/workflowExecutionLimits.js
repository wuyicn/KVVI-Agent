export const MAX_WORKFLOW_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_WORKFLOW_STEPS = 100_000;
function positiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
export function normalizeWorkflowExecutionLimits(value) {
    const duration = positiveInteger(value?.maxDurationSec);
    const steps = positiveInteger(value?.maxSteps) ?? MAX_WORKFLOW_STEPS;
    return {
        maxDurationSec: duration === undefined ? undefined : Math.min(duration, MAX_WORKFLOW_DURATION_SECONDS),
        maxSteps: Math.min(steps, MAX_WORKFLOW_STEPS),
    };
}
export function validateWorkflowExecutionLimits(value) {
    if (!value)
        return;
    if (value.maxDurationSec !== undefined && (!positiveInteger(value.maxDurationSec) || value.maxDurationSec > MAX_WORKFLOW_DURATION_SECONDS)) {
        throw new Error(`最长运行时间必须是 1 到 ${MAX_WORKFLOW_DURATION_SECONDS} 秒的整数`);
    }
    if (value.maxSteps !== undefined && (!positiveInteger(value.maxSteps) || value.maxSteps > MAX_WORKFLOW_STEPS)) {
        throw new Error(`最大执行步数必须是 1 到 ${MAX_WORKFLOW_STEPS} 的整数`);
    }
}
