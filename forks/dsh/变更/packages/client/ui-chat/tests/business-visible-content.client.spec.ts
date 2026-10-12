import { describe, expect, it } from 'vitest'
import type { ChatNode } from '../src/client/contract/chat-nodes.ts'
import { businessVisibleBlocks } from '../src/client/chat/business-presentation.ts'

describe('business-visible assistant content', () => {
  it('retains image-only replies and business values without changing logged blocks', () => {
    const image = { kind: 'image', attachment: { attachmentId: 'sha256:ab', mimeType: 'image/png', width: 1, height: 1 } } as const
    const blocks = [
      { kind: 'reasoning', text: 'private' }, { kind: 'text', text: ' \n ' },
      image, { kind: 'text', text: 'API-001 客户' },
      { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' },
    ] as ChatNode<'assistant-step'>['data']['blocks']
    expect(businessVisibleBlocks(blocks)).toEqual([image, { kind: 'text', text: 'API-001 客户' }])
    expect(blocks).toHaveLength(5)
  })
})
