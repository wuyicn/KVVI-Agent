export class RetryExhaustedError extends Error {
    attempts;
    lastError;
    constructor(message, attempts, lastError) {
        super(message);
        this.attempts = attempts;
        this.lastError = lastError;
        this.name = 'RetryExhaustedError';
    }
}
export function normalizeRetryPolicy(data) {
    const retries = Math.min(10, Math.max(0, Math.floor(Number(data.retryCount)) || 0));
    const delaySeconds = Math.min(3600, Math.max(0, Number(data.retryDelay) || 0));
    return {
        retries,
        delayMs: Math.round(delaySeconds * 1000),
        backoff: data.retryBackoff === 'exponential' ? 'exponential' : 'fixed',
    };
}
export function retryDelayMilliseconds(policy, retryIndex) {
    if (policy.delayMs <= 0)
        return 0;
    const multiplier = policy.backoff === 'exponential' ? 2 ** Math.max(0, retryIndex - 1) : 1;
    return Math.min(3_600_000, policy.delayMs * multiplier);
}
function abortError(signal) {
    return signal?.reason instanceof Error ? signal.reason : new Error('运行已取消');
}
async function waitForRetry(delayMs, signal) {
    if (signal?.aborted)
        throw abortError(signal);
    if (delayMs <= 0)
        return;
    await new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            reject(abortError(signal));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, delayMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
    });
}
export async function executeWithRetry(operation, data, signal) {
    const policy = normalizeRetryPolicy(data);
    const maxAttempts = policy.retries + 1;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (signal?.aborted)
            throw abortError(signal);
        try {
            return { value: await operation(attempt), attempts: attempt };
        }
        catch (error) {
            if (signal?.aborted)
                throw abortError(signal);
            lastError = error;
            if (attempt >= maxAttempts) {
                const message = error instanceof Error ? error.message : String(error);
                throw new RetryExhaustedError(message, attempt, error);
            }
            await waitForRetry(retryDelayMilliseconds(policy, attempt), signal);
        }
    }
    throw new RetryExhaustedError('节点执行失败', maxAttempts, lastError);
}
