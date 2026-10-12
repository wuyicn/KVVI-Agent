/** Read-only preview of a builder-owned, unpublished registration draft. */
import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

interface Identity { companyId: string; userId: string; gateway: 'USER' | 'BUILDER' }
type Json = Record<string, unknown>
const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 5000
const code = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
const fail = (): never => { throw new Error('KVVI_PREVIEW_UNSUPPORTED') }
const fields = { short_text: 'ShortTextField', long_text: 'LongTextField', date: 'DateField', single_select: 'SingleSelectField' }
const paths = ['.kvvi-system.json', '契约/01-业务模型/business-schema.json', '契约/02-登记表单/view-schema.json',
  '契约/03-经营状态/workflow-spec.json', '契约/04-使用权限/permission-spec.json',
  '契约/05-工具/tool-spec.json', '契约/06-搭建命令/app-model-command.json']
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

function noLinkDirectory(path: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid directory')
}
function read(root: string, relative: string): string {
  let parent = root
  const parts = relative.split('/')
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); noLinkDirectory(parent) }
  if (realpathSync(parent) !== parent) throw new Error('linked directory')
  const filename = parts.at(-1)
  if (!filename) throw new Error('missing filename')
  const target = join(parent, filename)
  if (!lstatSync(target).isFile()) throw new Error('not a regular file')
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > 262144) throw new Error('invalid file')
    const bytes = Buffer.alloc(262145)
    let size = 0, count: number
    do { count = readSync(fd, bytes, size, bytes.length - size, size); size += count } while (count > 0 && size < bytes.length)
    const after = fstatSync(fd)
    if (size > 262144 || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || realpathSync(parent) !== parent || lstatSync(target).ino !== after.ino) throw new Error('changed file')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))
  } finally { closeSync(fd) }
}

/** A display-only field; it carries no authorization or write capability. */
export interface PreviewField {
  field_code: string
  label: string
  type: keyof typeof fields
  required: boolean
  default?: string
  constraints?: { trim?: boolean; min_length?: number; max_length?: number }
  type_config?: { options: { code: string; label: string; enabled: boolean }[] }
}
/** Only inert, supported nodes may reach the preview renderer. */
export interface PreviewNode { id: string; componentName: string; props?: Json; children?: PreviewNode[] }
/** The source digest identifies a read, not an approved or submittable version. */
export interface ManagedDraftPreview {
  intentId: string
  digest: string
  assetId: string
  validation: 'not_checked'
  canSubmit: false
  model: { schema_code: string; name: string; fields: PreviewField[] }
  view: { view_code: string; name: string; view_type: 'FORM'; componentsTree: PreviewNode[] }
  uniqueRules: string[][]
}

function fieldOf(value: unknown): PreviewField {
  if (!object(value) || !code(value.field_code) || !text(value.label) || typeof value.required !== 'boolean'
    || typeof value.type !== 'string' || !Object.hasOwn(fields, value.type)
    || (value.write_policy !== undefined && value.write_policy !== 'MUTABLE')) return fail()
  const field: PreviewField = {
    field_code: value.field_code, label: value.label,
    type: value.type as keyof typeof fields, required: value.required,
  }
  if (value.constraints !== undefined) {
    if (!object(value.constraints)) return fail()
    const c = value.constraints
    if (Object.keys(c).some(k => !['trim', 'min_length', 'max_length'].includes(k))) return fail()
    if (c.trim !== undefined && typeof c.trim !== 'boolean') return fail()
    for (const k of ['min_length', 'max_length']) if (c[k] !== undefined && (!Number.isSafeInteger(c[k]) || Number(c[k]) < 0 || Number(c[k]) > 100000)) return fail()
    if (Number(c.min_length ?? 0) > Number(c.max_length ?? 100000)) return fail()
    field.constraints = c
  }
  if (value.type === 'single_select') {
    if (!object(value.type_config) || !Array.isArray(value.type_config.options)
      || !value.type_config.options.length || value.type_config.options.length > 200) return fail()
    const options = value.type_config.options.map((o: unknown) => {
      if (!object(o) || !code(o.code) || !text(o.label) || typeof o.enabled !== 'boolean') return fail()
      return { code: o.code, label: o.label, enabled: o.enabled }
    })
    if (new Set(options.map(o => o.code)).size !== options.length) return fail()
    field.type_config = { options }
  }
  if (value.default !== undefined) {
    if (typeof value.default !== 'string' || value.default.length > 5000) return fail()
    if (field.type === 'single_select' && !field.type_config?.options.some(o => o.enabled && o.code === value.default)) return fail()
    field.default = value.default
  }
  return field
}

function project(intentId: string, companyId: string, raw: string[]): ManagedDraftPreview {
  const contents: unknown[] = raw.map((v): unknown => JSON.parse(v))
  const [marker, model, view] = contents
  if (!contents.every(object) || !object(marker) || !object(model) || !object(view)
    || !code(marker.assetId) || model.schema_code !== marker.assetId || !text(model.name)
    || !Array.isArray(model.fields) || !model.fields.length || model.fields.length > 100
    || !code(view.view_code) || !text(view.name) || view.view_type !== 'FORM'
    || !object(view.businessSchemaRef) || view.businessSchemaRef.asset_id !== marker.assetId
    || view.businessSchemaRef.scope_type !== 'TENANT' || view.businessSchemaRef.scope_id !== companyId) return fail()
  const declared = model.fields.map(fieldOf)
  const byCode = new Map(declared.map(f => [f.field_code, f]))
  if (byCode.size !== declared.length) return fail()
  const ids = new Set<string>(), bound = new Set<string>()
  function nodes(value: unknown, depth: number): PreviewNode[] {
    if (!Array.isArray(value) || depth > 12 || value.length > 200) return fail()
    return value.map((node: unknown) => {
      if (!object(node) || !code(node.id) || ids.has(node.id) || ids.size >= 300 || !text(node.componentName)
        || Object.keys(node).some(k => !['id', 'componentName', 'props', 'children'].includes(k))) return fail()
      ids.add(node.id)
      const props = node.props ?? {}
      if (!object(props)) return fail()
      const out: PreviewNode = { id: node.id, componentName: node.componentName }
      if (['FormPage', 'Section', 'Grid'].includes(node.componentName)) {
        if (Object.keys(props).some(k => k !== 'title') || (props.title !== undefined && !text(props.title))) return fail()
        out.props = props
      } else if (['SubmitButton', 'SaveDraftButton', 'CancelButton'].includes(node.componentName)) {
        if (Object.keys(props).length || node.children !== undefined) return fail()
      } else {
        if (Object.keys(props).some(k => k !== 'fieldBinding') || !object(props.fieldBinding)
          || props.fieldBinding.type !== 'FieldRef' || !code(props.fieldBinding.fieldRef) || node.children !== undefined) return fail()
        const field = byCode.get(props.fieldBinding.fieldRef)
        if (!field || fields[field.type] !== node.componentName || bound.has(field.field_code)) return fail()
        bound.add(field.field_code); out.props = { fieldBinding: { type: 'FieldRef', fieldRef: field.field_code } }
      }
      if (node.children !== undefined) out.children = nodes(node.children, depth + 1)
      return out
    })
  }
  const tree = nodes(view.componentsTree, 0)
  if (bound.size !== declared.length) return fail()
  if (model.indexes !== undefined && !Array.isArray(model.indexes)) return fail()
  const uniqueRules: string[][] = []
  for (const index of (model.indexes ?? []) as unknown[]) {
    if (!object(index) || !['NORMAL', 'UNIQUE'].includes(String(index.kind)) || !Array.isArray(index.fields)
      || !index.fields.length || index.fields.some(f => !code(f) || !byCode.has(f))
      || new Set(index.fields).size !== index.fields.length) return fail()
    if (index.kind === 'UNIQUE') uniqueRules.push(index.fields as string[])
  }
  return { intentId, assetId: marker.assetId, digest: 'sha256:' + hash(JSON.stringify(raw)), canSubmit: false, validation: 'not_checked',
    model: { schema_code: marker.assetId, name: model.name, fields: declared },
    view: { view_code: view.view_code, name: view.name, view_type: 'FORM', componentsTree: tree }, uniqueRules }
}

/**
 * Read the fixed legacy registration layout without allocating or changing files.
 * @param home - operator-configured runtime home.
 * @param identity - verified platform identity.
 * @param intentId - managed build identity, never a filesystem path.
 * @returns inert display data. Full validation and permission confirmation remain pending.
 */
export function readManagedDraft(home: string | undefined, identity: Identity, intentId: string): ManagedDraftPreview {
  if (identity.gateway !== 'BUILDER') throw new Error('KVVI_BUILDER_REQUIRED')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(intentId)) throw new Error('KVVI_BUILD_INVALID')
  let raw: string[]
  try {
    if (!home || !isAbsolute(home)) throw new Error('missing home')
    let root = realpathSync(home)
    const owner = hash(JSON.stringify([identity.companyId, identity.userId]))
    for (const part of ['business-workspaces', owner, intentId]) { root = join(root, part); noLinkDirectory(root) }
    if (read(root, '.kvvi-build.json') !== JSON.stringify({ version: 1, owner, intentId })) throw new Error('wrong owner')
    raw = paths.map(p => read(root, p))
    if (paths.some((p, i) => read(root, p) !== raw[i])) throw new Error('draft changed during read')
  } catch { throw new Error('KVVI_PREVIEW_UNAVAILABLE') }
  try { return project(intentId, identity.companyId, raw) }
  catch { throw new Error('KVVI_PREVIEW_UNSUPPORTED') }
}
