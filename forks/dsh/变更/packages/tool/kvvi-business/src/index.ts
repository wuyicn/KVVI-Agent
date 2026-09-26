/**
 * Model-facing business tools for a deployed KVVI company.
 *
 * ── What makes these different from every other tool in the harness ─────────
 *
 * Each one is a call into **the customer's own platform service**, under **the
 * signed-in employee's identity**. The harness knows no tenant and must not
 * learn one from here: the identity comes from `kvviModeRouter.requireMode()`,
 * the context the runtime verified for this session, and never from an argument
 * the model produced.
 *
 * That is the rule the whole package exists to keep:
 *
 * | Rule | What breaks without it |
 * |---|---|
 * | Identity never comes from tool arguments | A prompt-injected model writes `tenant: other` and reads another company |
 * | A refusal is reported with the platform's own code | UI and Agent disagree about the same denial — G8's criterion |
 * | Only tools the platform can actually serve are registered | A tool that always fails teaches the model to retry forever |
 *
 * ── The registered set, and the ones deliberately missing ───────────────────
 *
 * Registered: `record_list`, `record_get`, `record_create`, `record_update`,
 * `workflow_available_actions`, `workflow_act`.
 *
 * **Not registered**: `aggregate_read`. The platform has no aggregate endpoint,
 * and §9.8.1 makes serving one non-trivial: whoever sees an aggregate must be
 * able to see every constituent row, so it cannot be computed from a filtered
 * page. Registering a tool that refuses every call would cost a tool slot and
 * make the model repeatedly attempt something it can never complete. The gap is
 * recorded in the package README instead.
 *
 * ── Identity-bearing argument names are rejected before execution ───────────
 *
 * `assertNoIdentityFields` walks the whole argument tree. A nested
 * `{ data: { tenant: 'x' } }` is the realistic shape, because record payloads
 * are nested by nature — a top-level-only check would pass exactly the request
 * that matters.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from '@deepseek-ai/dsh-host-kvvi-mode-router'
import { refusalMessage, request } from './client.ts'
import type { CallContext, CallResult } from './client.ts'

export const name = 'kvvi-business'
export const inject = ['tools', 'kvviModeRouter']

/** Deployment configuration for the business tools. */
export interface Config {
  /** Base URL of the KVVI platform service (no trailing `/api/v1`). */
  platformUrl: string
  /** Shared runtime-context secret; identical in both processes. */
  contextSecret: string
}

/** Schemastery configuration for the business tools. */
export const Config: z<Config> = z.object({
  platformUrl: z.string().required(),
  contextSecret: z.string().required(),
})

/**
 * Field names that would let a caller assert an identity.
 *
 * Same list as the platform's `IDENTITY_KEYS` (`api-router.mjs`) and the command
 * execution point's forbidden columns. It is repeated here rather than imported
 * because this package runs in a different process with no build edge to the
 * platform's sources — and because the check must fire **before** the request,
 * so that a rejected call never leaves a log line implying it was attempted
 * under another tenant.
 */
const IDENTITY_FIELDS = new Set(['companyid', 'tenant', 'actor', 'roles', 'gateway', 'userid'])

/**
 * Reject any identity-bearing key anywhere in the arguments.
 *
 * @param value - the model-supplied argument tree.
 * @param path - current path, for the message.
 * @throws {Error} `KVVI_IDENTITY_FIELD_FORBIDDEN` naming the offending path.
 */
export function assertNoIdentityFields(value: unknown, path = ''): void {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => { assertNoIdentityFields(item, `${path}[${String(index)}]`) })
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (IDENTITY_FIELDS.has(key.toLowerCase())) {
      throw new Error(`KVVI_IDENTITY_FIELD_FORBIDDEN: ${path === '' ? key : `${path}.${key}`}`)
    }
    assertNoIdentityFields(child, path === '' ? key : `${path}.${key}`)
  }
}

/**
 * One record as the platform returns it.
 *
 * Mutable and JSON-typed on purpose: these are the output schemas' inferred
 * types, and a hand-written `readonly` / `unknown` variant of the same shape
 * would only be a second declaration of it that drifts.
 */
interface RecordRow {
  recordId: string
  state?: string
  recordNo?: string
  rowVersion: number
  data: Record<string, JsonValue>
}

/** The record list. */
interface RecordPage {
  items: RecordRow[]
  fieldVisibility: Record<string, JsonValue>
}

/** One record with the platform's per-field visibility. */
interface RecordView extends RecordRow {
  fieldVisibility: Record<string, JsonValue>
}

/** The workflow actions available on one record. */
interface ActionList {
  recordId: string
  state: string
  actions: { action: string; to: string }[]
}

/**
 * Register the worker's business tools.
 *
 * @param ctx - registrant context carrying the tool registry and mode router.
 * @param config - deployment's platform URL and shared secret.
 */
export function apply(ctx: Context, config: Config): void {
  /** Build the per-call identity context. Called at execution, never at load. */
  const contextFor = (): CallContext => ({
    mode: ctx.kvviModeRouter.requireMode(),
    baseUrl: config.platformUrl,
    secret: config.contextSecret,
  })

  /**
   * Run one platform call and unwrap it into the tool's canonical value.
   *
   * Every tool goes through this: one place decides that a refusal throws, so no
   * tool can quietly return a partial success.
   */
  const call = async <T>(run: (call: CallContext) => Promise<CallResult<T>>): Promise<T> => {
    const result = await run(contextFor())
    if (!result.ok) throw new Error(refusalMessage(result))
    return result.value
  }

  ctx.tools.register(defineTool({
    name: 'record_list',
    description: 'List the records of one published KVVI system that this session may read. '
      + 'Rows and fields are already filtered by the platform: a field you cannot see is '
      + 'absent from the response rather than empty, and an out-of-scope row is not returned. '
      + 'Call this before answering any question about existing business data.',
    parameters: {
      system: {
        type: 'string', required: true,
        description: 'The system code (`assetId`), as shown in the company\'s system list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // 逐字段列出而不是 `type: 'json'`：平台的行形状是**它可以承诺的那几列**，
          // 声明成不设限的 JSON 就没人会发现平台多塞了一个字段。
          items: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                recordId: { type: 'string', required: true },
                rowVersion: { type: 'integer', required: true },
                state: { type: 'string' },
                recordNo: { type: 'string' },
                data: { type: 'object', required: true, additionalProperties: true },
              },
            },
          },
          fieldVisibility: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${String(value.items.length)} record(s) visible to this session.`,
      }],
    },
    execute: args => call(async c => request<RecordPage>(c, 'GET',
      `/systems/${encodeURIComponent(args.system)}/records`)),
    presentCall: args => ({ card: 'generic', title: `List records of ${args.system}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'record_get',
    description: 'Read one KVVI record by id. Returns the field values this session may see and '
      + 'the `rowVersion` you must pass back when updating it.',
    parameters: {
      system: { type: 'string', required: true, description: 'The system code (`assetId`).' },
      id: { type: 'string', required: true, description: 'The record id from `record_list`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          rowVersion: { type: 'integer', required: true },
          state: { type: 'string' },
          recordNo: { type: 'string' },
          data: { type: 'object', required: true, additionalProperties: true },
          fieldVisibility: { type: 'object', required: true, additionalProperties: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Record ${value.recordId} (state ${value.state ?? '?'}).`,
      }],
    },
    execute: args => call(async c => request<RecordView>(c, 'GET',
      `/systems/${encodeURIComponent(args.system)}/records/${encodeURIComponent(args.id)}`)),
    presentCall: args => ({ card: 'generic', title: `Read record ${args.id}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'record_create',
    description: 'Create a record in a published KVVI system. `data` is a flat map of field code '
      + 'to value; field codes come from the system\'s model. Only create when the user asked for '
      + 'it — this writes to the company\'s real data. The response carries the new record number.',
    parameters: {
      system: { type: 'string', required: true, description: 'The system code (`assetId`).' },
      data: {
        type: 'object', required: true, additionalProperties: true,
        description: 'Field code to value. Never include identity fields such as `tenant`.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          recordNo: { type: 'string' },
          rowVersion: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Created record ${value.recordNo ?? value.recordId}.`,
      }],
    },
    execute: async (args) => {
      assertNoIdentityFields(args.data)
      return await call(async c => request<{ recordId: string; recordNo?: string; rowVersion: number }>(
        c, 'POST', `/systems/${encodeURIComponent(args.system)}/records`, { data: args.data }))
    },
    presentCall: args => ({ card: 'generic', title: `Create a record in ${args.system}`, kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'record_update',
    description: 'Update a KVVI record. `rowVersion` is REQUIRED and must be the value you read '
      + 'most recently: if someone else changed the record in between, the platform refuses with '
      + '`KVVI_ROW_VERSION_CONFLICT` instead of overwriting their change. On that code, re-read the '
      + 'record and decide with the user rather than retrying with the same version.',
    parameters: {
      system: { type: 'string', required: true, description: 'The system code (`assetId`).' },
      id: { type: 'string', required: true, description: 'The record id.' },
      data: {
        type: 'object', required: true, additionalProperties: true,
        description: 'Only the fields you are changing. Omitted fields keep their value.',
      },
      rowVersion: {
        type: 'integer', required: true,
        description: 'The version from `record_get`. Not a guess.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          rowVersion: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated ${value.recordId} to version ${String(value.rowVersion)}.`,
      }],
    },
    execute: async (args) => {
      assertNoIdentityFields(args.data)
      return await call(async c => request<{ recordId: string; rowVersion: number }>(
        c, 'PATCH',
        `/systems/${encodeURIComponent(args.system)}/records/${encodeURIComponent(args.id)}`,
        { data: args.data, rowVersion: args.rowVersion }))
    },
    presentCall: args => ({ card: 'generic', title: `Update record ${args.id}`, kind: 'edit' }),
  }))

  ctx.tools.register(defineTool({
    name: 'workflow_available_actions',
    description: 'List the workflow actions this session may run on one record right now. The '
      + 'platform applies the published workflow contract and the caller\'s flow permissions, so '
      + 'an empty list means "no legal next step", not "you forgot to look".',
    parameters: {
      system: { type: 'string', required: true, description: 'The system code (`assetId`).' },
      id: { type: 'string', required: true, description: 'The record id.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          state: { type: 'string', required: true },
          actions: {
            type: 'array', required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: { type: 'string', required: true },
                to: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.actions.length === 0
          ? `No legal workflow action from state ${value.state}.`
          : `Available: ${value.actions.map(a => a.action).join(', ')}.`,
      }],
    },
    execute: args => call(async c => request<ActionList>(c, 'GET',
      `/systems/${encodeURIComponent(args.system)}/records/${encodeURIComponent(args.id)}/actions`)),
    presentCall: args => ({ card: 'generic', title: `Workflow actions on ${args.id}`, kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'workflow_act',
    description: 'Move a KVVI record through one workflow transition. `action` must come from '
      + '`workflow_available_actions`. The platform refuses anything the published contract does '
      + 'not allow, including approving a request you submitted yourself '
      + '(`KVVI_SELF_APPROVAL_FORBIDDEN`) — that is a rule, not a missing permission.',
    parameters: {
      system: { type: 'string', required: true, description: 'The system code (`assetId`).' },
      id: { type: 'string', required: true, description: 'The record id.' },
      action: {
        type: 'string', required: true,
        description: 'The action code from `workflow_available_actions`.',
      },
      rowVersion: {
        type: 'integer', required: true,
        description: 'The version from `record_get`. A transition changes the record too.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recordId: { type: 'string', required: true },
          from: { type: 'string', required: true },
          state: { type: 'string', required: true },
          rowVersion: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text', text: `Moved from ${value.from} to ${value.state}.`,
      }],
    },
    execute: args => call(async c => request<{
      recordId: string
      from: string
      state: string
      rowVersion: number
    }>(c, 'POST',
      `/systems/${encodeURIComponent(args.system)}/records/${encodeURIComponent(args.id)}/transitions`,
      { action: args.action, rowVersion: args.rowVersion })),
    presentCall: args => ({ card: 'generic', title: `${args.action} on ${args.id}`, kind: 'edit' }),
  }))
}
