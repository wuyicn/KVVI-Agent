import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  assertPresetAllowed, enforceCreateRequest, KvviModeRouter,
  signModeHeaders, verifyModeHeaders, presetFor,
} from '../src/index.ts'

const secret = 'stage8-mode-router-secret'
const context = {
  sessionId: 'a0000000-0000-4000-8000-000000000099',
  companyId: 'a0000000-0000-4000-8000-000000000001',
  gateway: 'USER' as const,
}

describe('KVVI mode router', () => {
  it('maps only trusted gateways to fixed presets', () => {
    expect(presetFor('BUILDER')).toBe('kvvi-builder')
    expect(presetFor('USER')).toBe('kvvi-worker')
    expect(() => presetFor('admin')).toThrow('KVVI_GATEWAY_INVALID')
  })

  it('accepts a fresh platform-signed context and rejects tampering', () => {
    const headers = signModeHeaders(context, secret, 1_700_000_000_000)
    expect(verifyModeHeaders(headers, secret, 1_700_000_000_500)).toEqual({
      ...context, preset: 'kvvi-worker', issuedAt: 1_700_000_000_000,
    })
    expect(() => verifyModeHeaders({ ...headers, 'x-kvvi-gateway': 'BUILDER' },
      secret, 1_700_000_000_500)).toThrow('KVVI_RUNTIME_CONTEXT_INVALID')
  })

  it('fails closed for missing, stale, or unknown context', () => {
    expect(() => verifyModeHeaders({}, secret, 1_700_000_000_500))
      .toThrow('KVVI_RUNTIME_CONTEXT_REQUIRED')
    const stale = signModeHeaders(context, secret, 1_699_999_000_000)
    expect(() => verifyModeHeaders(stale, secret, 1_700_000_000_500))
      .toThrow('KVVI_RUNTIME_CONTEXT_EXPIRED')
    expect(() => signModeHeaders({ ...context, gateway: 'ADMIN' as never }, secret))
      .toThrow('KVVI_GATEWAY_INVALID')
  })

  it('overrides caller-selected presets and locks later selection', () => {
    expect(enforceCreateRequest({ cwd: '/work', agentPreset: 'kvvi-builder' }, 'kvvi-worker'))
      .toEqual({ cwd: '/work', agentPreset: 'kvvi-worker' })
    expect(() => assertPresetAllowed('kvvi-builder', 'kvvi-worker'))
      .toThrow('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
    expect(() => assertPresetAllowed('kvvi-worker', 'kvvi-worker')).not.toThrow()
  })

  it('binds create and preset-select calls to the signed request context', async () => {
    const ctx = new Context()
    const creates: unknown[] = []
    ctx.provide('connection' as never, {} as never)
    ctx.provide('sessionController', {
      create: async request => { creates.push(request); return request },
    })
    ctx.provide('agentPresets', {
      select: async (_agent, requested) => requested,
    })
    await ctx.plugin(KvviModeRouter, { secret })

    const headers = signModeHeaders(context, secret)
    const response = {
      writeHead: () => response,
      end: () => response,
    }
    await ctx.waterfall('connection/request', { headers } as never, response as never,
      async () => {
        await ctx.sessionController.create({ cwd: '/work', agentPreset: 'kvvi-builder' })
        await expect(ctx.agentPresets.select({}, 'kvvi-builder'))
          .rejects.toThrow('KVVI_PRESET_LOCKED_TO_SESSION_MODE')
        await expect(ctx.agentPresets.select({}, 'kvvi-worker')).resolves.toBe('kvvi-worker')
      })

    expect(creates).toEqual([{ cwd: '/work', agentPreset: 'kvvi-worker' }])
    await ctx.fiber.dispose()
  })
})
