/** Built-client regression: business chat omits diagnostics, while raw history remains inspectable. */
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { createMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, readPersistedEvents, seedSession, watchConsole } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

function fixture(): string {
  const session = Session.create(SessionId('business-language-source'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('system/message', {
    turn: 1, step: 1, message: createSystemMessage('INTERNAL_SCHEMA_DIAGNOSTIC', '@deepseek-ai/dsh-system-prompt'),
  }, { surfaceOp: 'append' })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '请检查客户登记表。' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('session/title', { title: 'Business language check', messageSeqs: [user.seq], source: { kind: 'fallback' } })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'INTERNAL_SCHEMA_REASONING' }, { type: 'text', text: '修改只保存在草稿中，发布前需要你确认。' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return [
    JSON.stringify({ type: 'session', version: SESSION_FORMAT_VERSION, id: '{{sessionId}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 }),
    ...session.snapshotEvents().map(event => JSON.stringify(event)), '',
  ].join('\n')
}

it.each(['kvvi-builder', 'kvvi-worker'])('renders %s as business language without destroying diagnostics', async (preset) => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  try {
    const sessionId = await seedSession(scaffold, fixture(), 'business-language-' + preset, preset)
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('修改只保存在草稿中，发布前需要你确认。', { exact: true }).waitFor()
    expect(await page.locator('[data-chat-flow]').textContent()).not.toMatch(/INTERNAL_SCHEMA|System prompt|Thinking/)
    await page.getByRole('tab', { name: 'Trajectory', exact: true }).click()
    const recorded = JSON.stringify(await readPersistedEvents(scaffold, sessionId))
    expect(recorded).toContain('INTERNAL_SCHEMA_DIAGNOSTIC')
    expect(recorded).toContain('INTERNAL_SCHEMA_REASONING')
    expect(tripwire.pageErrors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 60_000)
