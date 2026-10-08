/**
 * Renders a published `view-schema` as a usable interface.
 *
 * ── Validate first, then draw ───────────────────────────────────────────────
 *
 * A published tree is checked **completely** before anything is drawn, and one
 * problem withholds the whole view. Two reasons, both earned:
 *
 * 1. A contract is one document. Half-drawing it shows a form whose missing
 *    field reads as a rendering bug rather than a refused contract, and the
 *    employee fills in the rest before discovering the submit cannot work.
 * 2. A pre-pass is what makes "nothing is drawn" checkable. Aborting mid-tree
 *    leaves whatever was already emitted on screen, which is exactly the state
 *    this component exists to prevent.
 *
 * ── What is *not* decided here ──────────────────────────────────────────────
 *
 * Authorization. `fieldVisibility` arrives with the spec (the platform computed
 * it from the session); this component obeys it and never re-derives it.
 * `HIDDEN` is filtered **twice** — at render and again when the payload is
 * built — because a form that renders without a field but submits it anyway has
 * carried the hidden value out of the browser.
 */
import { Fragment, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  COMPONENT_REGISTRY, FIELD_UNBOUND, NOT_REGISTERED, QUERY_UNSUPPORTED, WRONG_VIEW_TYPE,
} from './registry.tsx'
import type { FieldRenderProps, RegistryEntry, ViewType } from './registry.tsx'
import type { ModelField, ViewNode, ViewSpec } from './api.ts'
import type { KvviKey } from './locales.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './business.module.css'

/**
 * The translate function a renderer receives.
 *
 * Keyed by this package's dictionary rather than the framework's
 * `TranslateNS`, because these components are plain props consumers: a test
 * hands them the dictionary directly. The framework's typed `t` is assignable
 * here (it accepts this key set plus the shared vocabulary), so the panel
 * threads it through unchanged.
 */
export type Copy = (key: KvviKey, params?: Record<string, unknown>) => string

/** One thing that makes a published tree undrawable. */
export interface TreeNodeProblem {
  /** Stable, machine-readable reason — the same string an operator greps for. */
  readonly code: string
  /** The `componentName` that caused it. */
  readonly componentName: string
  /** The `view_type` the view declared. */
  readonly viewType: string
  /** Present when the fix involves a specific query code. */
  readonly queryCode?: string
}

/** The label/visibility/options a field needs, derived from the model + spec. */
export interface FieldContext {
  readonly labels: Readonly<Record<string, string>>
  readonly modes: Readonly<Record<string, string>>
  readonly options: Readonly<Record<string, readonly { value: string; label: string }[]>>
}

/** Props the tree renderer accepts. */
export interface KvviViewProps {
  readonly spec: ViewSpec
  /** Dictionary lookup; the surrounding panel passes the framework's `t`. */
  readonly copy: Copy
  /** Selectable options, labels and visibility, from the published model. */
  readonly context?: FieldContext
  /** Starting values, keyed by field code. */
  readonly initial?: Readonly<Record<string, string>>
  /**
   * Called with the values that were actually rendered and are still visible.
   * Omitted renders the tree read-only, which is what a DETAIL view needs.
   */
  readonly onSubmit?: (data: Record<string, string>) => void
  /** Called when the tree named an `OpenRecordLink`. */
  readonly onOpenRecord?: () => void
  /** Controlled draft shared by the business tab and its form dialog. */
  readonly values?: Readonly<Record<string, string>>
  readonly onValuesChange?: (values: Record<string, string>) => void
  readonly busy?: boolean
}

/** The context used when a caller supplies none: identifiers, no options. */
const EMPTY_CONTEXT: FieldContext = { labels: {}, modes: {}, options: {} }

/** Read a node's bound field code, or `undefined` when it binds nothing. */
function boundField(node: ViewNode): string | undefined {
  const binding = (node.props ?? {}).fieldBinding as { fieldRef?: unknown } | undefined
  return typeof binding?.fieldRef === 'string' ? binding.fieldRef : undefined
}

/** Read a node's bound value reference, used by `Description`/`StatusBadge`. */
function valueField(node: ViewNode): string | undefined {
  const value = (node.props ?? {}).value as { fieldRef?: unknown } | undefined
  return typeof value?.fieldRef === 'string' ? value.fieldRef : undefined
}

/** Read a node's literal text, used by `Text`. */
function literalText(node: ViewNode): string | undefined {
  const text = (node.props ?? {}).text
  return typeof text === 'string' ? text : undefined
}

/** Read a node's `DataBindingRef` query code, used by `Table`. */
function queryCode(node: ViewNode): string | undefined {
  const data = (node.props ?? {}).data as { queryCode?: unknown } | undefined
  return typeof data?.queryCode === 'string' ? data.queryCode : undefined
}

/** Read a node's literal `PROPS.title`. */
function titleOf(node: ViewNode): string | undefined {
  const title = (node.props ?? {}).title
  return typeof title === 'string' ? title : undefined
}

/**
 * Walk a tree and report **every** reason it cannot be drawn.
 *
 * Returning the whole list rather than the first problem is deliberate: a
 * builder fixing a contract should see all of it at once, not one per save.
 * @param nodes - the published tree.
 * @param viewType - the `view_type` the owning view declared.
 * @returns the problems, in tree order; empty means drawable.
 */
export function problemsOf(nodes: readonly ViewNode[], viewType: string): TreeNodeProblem[] {
  const problems: TreeNodeProblem[] = []
  const walk = (list: readonly ViewNode[]): void => {
    for (const node of list) {
      const entry: RegistryEntry | undefined = COMPONENT_REGISTRY[node.componentName]
      if (entry === undefined) {
        problems.push({ code: NOT_REGISTERED, componentName: node.componentName, viewType })
      } else if (!entry.viewTypes.includes(viewType as ViewType)) {
        problems.push({ code: WRONG_VIEW_TYPE, componentName: node.componentName, viewType })
      } else if (entry.kind === 'field' && boundField(node) === undefined) {
        // The platform registry marks `fieldBinding` required on every field
        // component, so a field node without one cannot address a column.
        problems.push({ code: FIELD_UNBOUND, componentName: node.componentName, viewType })
      } else if (entry.kind === 'unsupported') {
        const code = queryCode(node)
        problems.push({
          code: entry.code, componentName: node.componentName, viewType,
          ...(code === undefined ? {} : { queryCode: code }),
        })
      }
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return problems
}

/**
 * Flatten a tree to the field codes that will actually be rendered.
 * @param nodes - the published tree.
 * @param modes - the per-field visibility the platform decided.
 * @returns the field codes, in render order, with hidden fields removed.
 */
export function visibleFields(
  nodes: readonly ViewNode[],
  modes: Readonly<Record<string, string>>,
): string[] {
  const out: string[] = []
  const walk = (list: readonly ViewNode[]): void => {
    for (const node of list) {
      const field = boundField(node)
      if (field !== undefined && (modes[field] ?? 'VISIBLE') !== 'HIDDEN') out.push(field)
      if (node.children !== undefined) walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** The sentence that explains one refusal code. */
function explain(problem: TreeNodeProblem, copy: Copy): string {
  switch (problem.code) {
    case NOT_REGISTERED:
      return copy('blocked.notRegistered', { name: problem.componentName })
    case WRONG_VIEW_TYPE:
      return copy('blocked.wrongViewType', { name: problem.componentName, viewType: problem.viewType })
    case FIELD_UNBOUND:
      return copy('blocked.unbound', { name: problem.componentName })
    case QUERY_UNSUPPORTED:
      return copy('blocked.queryUnsupported', {
        name: problem.componentName, queryCode: problem.queryCode ?? '',
      })
    default:
      // An unmapped code is shown verbatim: inventing a sentence for it would
      // hide that a new refusal reached a screen nobody taught it about.
      return problem.code
  }
}

/** Render the blocking panel for one or more problems. */
function Blocked({ problems, copy }: {
  readonly problems: readonly TreeNodeProblem[]
  readonly copy: Copy
}): ReactNode {
  return (
    <div role="alert" style={{ padding: 12 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{copy('blocked.title')}</div>
      {problems.map((problem, index) => (
        <div key={`${problem.code}-${String(index)}`} style={{ fontSize: 12.5, marginBottom: 4 }}>
          {/* The code sits on its **own element**: it is the machine-readable
              half, so it must be findable as text, not only inside a sentence. */}
          <code data-kvvi-error={problem.code} style={{ marginRight: 6 }}>{problem.code}</code>
          <span>{explain(problem, copy)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * Render a published form or record view.
 *
 * One renderer serves FORM, LIST and DETAIL: the tree, the registry and the
 * declared view type decide what appears, and `onSubmit` decides whether
 * anything is editable. A renderer per view type would be a second place for
 * the registry to be enforced.
 * @param props - the spec, copy, field context, initial values and callbacks.
 * @returns the rendered tree, or the blocking refusal.
 */
export function KvviFormView({
  spec, copy, context = EMPTY_CONTEXT, initial = {}, onSubmit, onOpenRecord, values: controlledValues, onValuesChange, busy,
}: KvviViewProps): ReactNode {
  const tree = spec.componentsTree ?? []
  const problems = useMemo(() => problemsOf(tree, spec.view_type), [tree, spec.view_type])
  const fields = useMemo(() => visibleFields(tree, context.modes), [tree, context.modes])
  const [localValues, setValues] = useState<Record<string, string>>(initial)
  const values = controlledValues ?? localValues

  if (problems.length > 0) return <Blocked problems={problems} copy={copy} />

  const set = (field: string, next: string): void => {
    if (busy === true) return
    const updated = { ...values, [field]: next }
    setValues(updated)
    onValuesChange?.(updated)
  }

  const draw = (list: readonly ViewNode[]): ReactNode[] => list.map((node) => {
    const entry = COMPONENT_REGISTRY[node.componentName]
    if (entry === undefined) return null
    const title = titleOf(node)
    const kids = node.children === undefined ? [] : draw(node.children)

    // A node bound to a `HIDDEN` field draws **nothing** — including its
    // container and its children. Skipping only the payload would leave the
    // field's label on screen, and skipping only the label would leave an empty
    // slot that still says a field is there.
    const bound = boundField(node) ?? (entry.kind === 'value' ? valueField(node) : undefined)
    if (bound !== undefined && (context.modes[bound] ?? 'VISIBLE') === 'HIDDEN') return null

    switch (entry.kind) {
      case 'layout':
        return (
          <Fragment key={node.id}>
            {entry.render({ ...(title === undefined ? {} : { title }), children: kids })}
          </Fragment>
        )
      case 'field': {
        const field = boundField(node) ?? ''
        const options = context.options[field]
        const props: FieldRenderProps = {
          field,
          label: context.labels[field] ?? field,
          value: values[field] ?? '',
          mode: context.modes[field] ?? 'VISIBLE',
          ...(options === undefined ? {} : { options }),
          onChange: (next) => { set(field, next) },
        }
        return <Fragment key={node.id}>{entry.render(props)}</Fragment>
      }
      case 'value': {
        const field = valueField(node)
        return (
          <Fragment key={node.id}>
            {entry.render({
              label: field === undefined ? '' : (context.labels[field] ?? field),
              value: field === undefined ? (literalText(node) ?? '') : (values[field] ?? ''),
              mode: field === undefined ? 'READONLY' : (context.modes[field] ?? 'VISIBLE'),
            })}
          </Fragment>
        )
      }
      case 'button': {
        const text = literalText(node) ?? title
        if (entry.action === 'openRecord') {
          return (
            <button key={node.id} type="button" onClick={onOpenRecord} style={{ fontSize: 12, marginRight: 8 }}>
              {text ?? copy('list.open')}
            </button>
          )
        }
        // The other three are the form's own chrome. The panel renders one
        // submit for the whole form rather than one per node, so a contract
        // that placed three submit buttons cannot post the same record thrice.
        return null
      }
      default:
        return null
    }
  })

  const submit = (): void => {
    if (busy === true) return
    const data: Record<string, string> = {}
    for (const field of fields) {
      // Filtered again on the way out. The payload is built from the fields that
      // were rendered, so a value that arrived in `initial` for a hidden field
      // is not carried along.
      if ((context.modes[field] ?? 'VISIBLE') === 'HIDDEN') continue
      data[field] = values[field] ?? ''
    }
    onSubmit?.(data)
  }

  return (
    <form className={css.form} onSubmit={(e) => { e.preventDefault(); submit() }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>{draw(tree)}</fieldset>
      {onSubmit === undefined ? null : (
        <div className={css.formActions}><Button type="submit" variant="primary" disabled={busy}>{copy('form.submit')}</Button></div>
      )}
    </form>
  )
}

/**
 * Build the label/visibility/option context a published model implies.
 *
 * Labels come from the model, never from the view: a view that renamed a column
 * would be a second place the product's vocabulary lives.
 * @param fields - the model's field declarations.
 * @param modes - the platform's per-field visibility.
 * @returns labels and selectable options for the renderer.
 */
export function fieldContextOf(
  fields: readonly ModelField[] | undefined,
  modes: Readonly<Record<string, string>> = {},
): FieldContext {
  const labels: Record<string, string> = {}
  const options: Record<string, { value: string; label: string }[]> = {}
  for (const field of fields ?? []) {
    labels[field.field_code] = field.label ?? field.field_code
    const declared = field.type_config?.options
    if (declared !== undefined) {
      options[field.field_code] = declared.map(o => ({ value: o.code, label: o.label ?? o.code }))
    }
  }
  return { labels, modes, options }
}
