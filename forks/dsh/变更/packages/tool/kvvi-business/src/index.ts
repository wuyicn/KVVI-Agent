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
 * Registered: `record_schema`, `record_list`, `record_get`, `record_create`,
 * `record_update`, `workflow_available_actions`, `workflow_act`.
 *
 * `record_schema` is the one that answers a question about the *system* rather
 * than about its data: which field codes exist, which are required, what an
 * enum accepts. Without it the model has no way to learn a field code it was
 * not told, and a wrong guess is refused — so it guesses until it gives up.
 * That exact sequence is what it was added for.
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
import type {} from '@deepseek-ai/dsh-user-approval'
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
 * The `id` argument of every record tool.
 *
 * One constant, not four copies: the platform resolves either form in the same
 * place (`services/platform/src/request-refs.mjs`), and four descriptions that
 * drift would teach the model four different answers to one question. It is
 * spelled out because the model has no way to learn it otherwise — that is why
 * an earlier incident ended with the record number being pasted into a uuid
 * lookup, and with the model concluding the record was unreadable to it.
 */
const RECORD_REF = 'The record\'s id, or its record number (`recordNo`, e.g. `R-20261006-000003`). '
  + 'A record number is resolved by the platform, so either works. A freshly created record is '
  + 'reachable by the number `record_create` returned, without reading it back first.'

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

/** One field as the platform declares it. */
interface FieldDeclaration {
  field_code: string
  label: string
  type?: string
  required: boolean
  nullable: boolean
  write_policy?: string
  options?: { code: string; label: string }[]
}

/** The field catalogue of one system. */
interface FieldCatalogue {
  assetId: string
  fields: FieldDeclaration[]
  /** Declared fields this session may not see. Their names are not sent at all. */
  hiddenFieldCount: number
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
    name: 'record_schema',
    description: 'List the fields one published KVVI system declares — the field codes you must use '
      + 'as the keys of `data` in `record_create` and `record_update`. Each entry carries the label, '
      + 'the field type, `required`, `write_policy`, and the allowed values of an enum field. '
      + 'Read this BEFORE building a record payload: a field code that is not listed here is '
      + 'refused with `KVVI_FIELD_NOT_DECLARED`. This returns the system\'s declarations only, never '
      + 'record values, and a field this session is not allowed to see is not listed at all.',
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
          assetId: { type: 'string', required: true },
          fields: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                // 逐字段列出而不是 `type: 'json'`：这份清单是**照着它写 payload** 用的，
                // 声明成不设限的 JSON 就没人会发现平台少给了一个必填标记。
                field_code: { type: 'string', required: true },
                label: { type: 'string', required: true },
                type: { type: 'string' },
                required: { type: 'boolean', required: true },
                nullable: { type: 'boolean', required: true },
                write_policy: { type: 'string' },
                options: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      code: { type: 'string', required: true },
                      label: { type: 'string', required: true },
                    },
                  },
                },
              },
            },
          },
          hiddenFieldCount: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => {
        const names = value.fields
          .map(field => (field.required === true ? `${field.field_code} (required)` : field.field_code))
        const lines = [`${String(value.fields.length)} field(s): ${names.join(', ')}.`]
        // 有字段被挡掉时说出来。不说的话，「这个角色看不见任何字段」与
        // 「这个系统没有字段」对模型是同一件事 —— 而前者要去找管理员，后者不用。
        if (value.hiddenFieldCount > 0) {
          lines.push(`${String(value.hiddenFieldCount)} further field(s) are not visible to this session.`)
        }
        return [{ type: 'text', text: lines.join(' ') }]
      },
    },
    execute: args => call(async c => request<FieldCatalogue>(c, 'GET',
      `/systems/${encodeURIComponent(args.system)}/fields`)),
    presentCall: args => ({ card: 'generic', title: `Fields of ${args.system}`, kind: 'read' }),
  }))

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
      id: { type: 'string', required: true, description: RECORD_REF },
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
      + 'to value; take every code from `record_schema` rather than from the wording of the '
      + 'request. Only create when the user asked for it — this writes to the company\'s real '
      + 'data. The response carries the new record number.',
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
      id: { type: 'string', required: true, description: RECORD_REF },
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
      id: { type: 'string', required: true, description: RECORD_REF },
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
      + '(`KVVI_SELF_APPROVAL_FORBIDDEN`) — that is a rule, not a missing permission. '
      + 'Every transition requires the user to confirm the exact record, action and version '
      + 'before it runs. A prior confirmation does not authorize another call.',
    parameters: {
      system: { type: 'string', required: true, description: 'The system code (`assetId`).' },
      id: { type: 'string', required: true, description: RECORD_REF },
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
    execute: async (args, exec) => {
      // Confirmation is enforced in the executor; an allow hook cannot bypass it.
      const operation = Object.freeze({ ...args })
      const identity = Object.freeze({ ...contextFor().mode })
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) {
        throw new Error('KVVI_CONFIRMATION_UNAVAILABLE')
      }
      const outcome = await approval.request({
        agent: exec.agent, toolName: exec.name, callId: exec.callId, signal: exec.signal,
        reason: `确认流程变更：系统=${operation.system}，记录=${operation.id}，`
          + `动作=${operation.action}，版本=${String(operation.rowVersion)}。`
          + `企业=${identity.companyId}，用户=${identity.userId}。`,
      })
      if (outcome !== 'allowed-once') {
        throw new Error(`KVVI_CONFIRMATION_${outcome.toUpperCase()}`)
      }
      exec.signal.throwIfAborted()
      const current = contextFor().mode
      if (current.sessionId !== identity.sessionId || current.userId !== identity.userId
        || current.companyId !== identity.companyId || current.gateway !== identity.gateway) {
        throw new Error('KVVI_CONFIRMATION_CONTEXT_CHANGED')
      }
      return await call(async c => request<{
        recordId: string
        from: string
        state: string
        rowVersion: number
      }>(c, 'POST',
        `/systems/${encodeURIComponent(operation.system)}/records/${encodeURIComponent(operation.id)}/transitions`,
        { action: operation.action, rowVersion: operation.rowVersion }))
    },
    presentCall: args => ({ card: 'generic', title: `${args.action} on ${args.id}`, kind: 'edit' }),
  }))
}
