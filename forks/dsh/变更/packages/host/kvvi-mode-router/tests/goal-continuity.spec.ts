import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import GoalService from '@deepseek-ai/dsh-goal'
import * as goalDriver from '@deepseek-ai/dsh-goal-round-driver'
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { expect, it, vi } from 'vitest'
import KvviModeRouter, { ownedSessionId, signModeHeaders, type ModeContext } from '../src/index.ts'

const secret = 'bounded-goal-continuity-secret'
const identity = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  companyId: '33333333-3333-4333-8333-333333333333',
  gateway: 'BUILDER' as const,
}

/** Two deterministic model responses; all scheduling and execution remain real. */
class GoalAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly ctx: Context) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    // The goal driver started after the signed request closed. Identity may be
    // restored only inside the tool/approval seams, not inherited by this turn.
    expect(() => this.ctx.kvviModeRouter.requireMode()).toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
    if (this.requests.length === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: ToolCallId('queued-goal-probe'),
        name: 'goal_identity_probe', arguments: '{}',
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (this.requests.length !== 2) throw new Error('Bounded goal adapter exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Goal verified.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('a real queued Builder goal round restores its authenticated Agent identity through approval and execution', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    await ctx.plugin(GoalService)
    await ctx.plugin(goalDriver)
    await ctx.plugin(AgentLoop, { agents: [] })
    // Unused GUI facades are constructor dependencies, never identity sources.
    const unused = (): never => { throw new Error('GUI facade unexpectedly used') }
    ctx.provide('connection' as never, {} as never)
    ctx.provide('sessionController', { create: unused, list: unused, search: unused, control: unused })
    ctx.provide('agentPresets', { select: unused, remoteExportList: unused })
    await ctx.plugin(KvviModeRouter, { secret })

    const adapter = new GoalAdapter(ctx)
    ctx.llm.registerAdapter(['goal-test'], adapter)
    let agent!: Agent
    let boundSession!: Agent['session']
    const modes: { seam: string; mode: ModeContext }[] = []
    ctx.tools.register(defineTool({
      name: 'goal_identity_probe', description: 'Verify the queued goal identity.', parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { verified: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'Identity verified.' }],
      },
      execute: async (_args, exec) => {
        expect(exec.agent).toBe(agent)
        expect(exec.agent?.session).toBe(boundSession)
        modes.push({ seam: 'execute', mode: ctx.kvviModeRouter.requireMode() })
        const goal = ctx.goals.get(agent)!
        ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
        return { verified: true }
      },
    }))
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'goal_identity_probe') return next()
      modes.push({ seam: 'pre-execute', mode: ctx.kvviModeRouter.requireMode() })
      return { kind: 'ask', reason: 'Verify this one queued goal call.' }
    })
    ctx.on('approval/request', async request => {
      expect(request.agent).toBe(agent)
      expect(request.callId).toBe('queued-goal-probe')
      modes.push({ seam: 'approval', mode: ctx.kvviModeRouter.requireMode() })
      return 'allowed-once'
    })

    const response = { writeHead: () => response, end: () => response }
    await ctx.waterfall('connection/request', {
      headers: signModeHeaders(identity, secret),
    } as never, response as never, async () => {
      const mode = ctx.kvviModeRouter.requireMode()
      agent = (await ctx.agents.create({
        sessionId: SessionId(ownedSessionId(mode, 'queued-builder-goal')),
        meta: { agentPreset: mode.preset },
        agentOptions: { provider: 'goal-test', model: 'goal-test' },
      })).agent
      boundSession = agent.session
    })
    expect(() => ctx.kvviModeRouter.requireMode()).toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')

    // No direct followup or tools.execute: the host goal driver must reserve,
    // queue, claim, admit, and run this one automatic round itself.
    const goal = ctx.goals.create(agent, { objective: 'Verify Builder goal identity.', maxGoalRounds: 1 })
    await vi.waitFor(() => {
      expect(ctx.goals.get(agent)).toMatchObject({ id: goal.id, phase: 'complete', roundsStarted: 1 })
      expect(agent.status).toBe('idle')
    })
    expect(adapter.requests).toHaveLength(2)
    expect(modes.map(({ seam }) => seam)).toEqual(['pre-execute', 'approval', 'execute'])
    for (const { mode } of modes) expect(mode).toMatchObject({ ...identity, preset: 'kvvi-builder' })
    const admitted = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)
    expect(admitted).toHaveLength(1)
    expect(admitted[0]).toMatchObject({ data: { source: {
      kind: 'goal', goalId: goal.id, round: 1,
    } } })
    expect(() => ctx.kvviModeRouter.requireMode()).toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
  } finally {
    await ctx.fiber.dispose()
  }
})
