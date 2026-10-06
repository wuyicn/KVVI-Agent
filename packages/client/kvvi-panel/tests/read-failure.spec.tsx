// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ReadFailure } from '../src/client/ReadFailure.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
it.each([
  ['KVVI_NOT_ALLOWED', '你暂无查看权限'],
  ['KVVI_TOKEN_REQUIRED', '登录状态已失效'],
  ['KVVI_SESSION_EXPIRED', '登录状态已失效'],
  ['KVVI_UNREACHABLE', '无法连接服务'],
  ['KVVI_RUNTIME_CONTRACT_INCOMPLETE', '暂时无法读取内容'],
])('explains %s, keeps its code, and retries only on request', (code, explanation) => {
  const retry = vi.fn()
  render(<ReadFailure error={code} copy={key => zh[key]} onRetry={retry} />)
  expect(screen.getByRole('alert').textContent).toContain(explanation)
  expect(screen.getByText(code)).toBeTruthy()
  expect(retry).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(retry).toHaveBeenCalledOnce()
})
