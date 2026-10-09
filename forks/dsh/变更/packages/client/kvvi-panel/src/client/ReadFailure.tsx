/** Localized recovery controls for read-only business API failures. */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Copy } from './FormView.tsx'
import css from './business.module.css'

/**
 * Explain a failed read without discarding its diagnostic code or retry action.
 * @param props - diagnostic text, localized copy, and a read-only retry callback.
 * @returns the visible failure and recovery control.
 */
export function ReadFailure({ error, copy, onRetry }: {
  readonly error: string
  readonly copy: Copy
  readonly onRetry: () => void
}): ReactNode {
  const message = error === 'KVVI_FORM_ARCHIVED' ? 'read.archived' : error.startsWith('KVVI_UNREACHABLE') ? 'read.unreachable'
    : error.startsWith('KVVI_NOT_ALLOWED') || error.startsWith('KVVI_FORBIDDEN') ? 'read.denied'
      : error.startsWith('KVVI_TOKEN_') || error.startsWith('KVVI_SESSION_') ? 'read.sessionEnded'
        : 'read.failed'
  return (
    <div role="alert" className={css.notice}>
      <p>{copy(message)}</p>
      <code>{error}</code>
      <Button variant="outline" onClick={onRetry}>{copy('read.retry')}</Button>
    </div>
  )
}
