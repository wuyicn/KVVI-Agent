/**
 * The closed component registry for published systems.
 *
 * ── What "closed" buys ───────────────────────────────────────────────────────
 *
 * A contract is data, not code. This table is the *only* set of components the
 * runtime can draw, and every entry is an explicit import. A `componentName`
 * that is not a key here renders a blocking error instead of anything else.
 *
 * That is the whole defence: a contract cannot name a component that runs
 * remote code, because no such component is reachable from this module.
 *
 * ── The keys are the platform's catalogue, not a convenience list ────────────
 *
 * These 23 names are the ones `COMPONENT_REGISTRY` declares in the published
 * contracts (the golden-sample `context.json` files), each with its own
 * `viewTypes`.
 * The table below carries the same `viewTypes`, so a contract that puts a
 * `SubmitButton` in a `DETAIL` view is refused here for the same reason the
 * registry refuses it — not because this renderer happens to lack a branch.
 *
 * ⚠️ The production registry is a separate artefact and still an open item:
 * the repository carries it only as a golden-sample fixture. Widening this
 * table widens what a published contract can draw, so it is a product
 * decision, not a convenience.
 *
 * ⚠️ `fieldVisibility` is applied by the caller, not here. A registry entry
 * renders what it is told to render; deciding whether a field may be shown or
 * written belongs to the platform (the single authorization point). Duplicating
 * that decision here would create a second judge.
 */
import type { ReactNode } from 'react'
import { NOT_REGISTERED, WRONG_VIEW_TYPE, FIELD_UNBOUND, QUERY_UNSUPPORTED } from './locales.ts'
import css from './business.module.css'

/** The three view types a published `view-schema` may declare. */
export type ViewType = 'FORM' | 'LIST' | 'DETAIL'

/** One rendered field: the label, the current value, and how it may be used. */
export interface FieldRenderProps {
  readonly field: string
  readonly label: string
  readonly value: string
  /** `VISIBLE` | `READONLY` | `MASKED` — never `HIDDEN`; hidden fields are not rendered at all. */
  readonly mode: string
  /** Selectable options, when the model declares them for this field. */
  readonly options?: readonly { readonly value: string; readonly label: string }[]
  readonly onChange: (next: string) => void
}

/** One decoration bound to a value rather than edited. */
export interface ValueRenderProps {
  readonly label: string
  readonly value: string
  readonly mode: string
}

/** How one registry entry draws a field. */
export type FieldRenderer = (props: FieldRenderProps) => ReactNode

/** How one registry entry draws a bound value. */
export type ValueRenderer = (props: ValueRenderProps) => ReactNode

/** Which button a contract placed. */
export type ButtonAction = 'submit' | 'draft' | 'cancel' | 'openRecord'

/** One entry of the closed table. */
export type RegistryEntry =
  | {
    /** Container: draws its children, binds nothing itself. */
    readonly kind: 'layout'
    readonly viewTypes: readonly ViewType[]
    readonly render: (props: { readonly title?: string; readonly children: ReactNode }) => ReactNode
  }
  | {
    readonly kind: 'field'
    readonly viewTypes: readonly ViewType[]
    readonly render: FieldRenderer
  }
  | {
    readonly kind: 'value'
    readonly viewTypes: readonly ViewType[]
    readonly render: ValueRenderer
  }
  | {
    readonly kind: 'button'
    readonly viewTypes: readonly ViewType[]
    readonly action: ButtonAction
    /** Whether the contract may omit its label and take the product's own copy. */
    readonly defaultLabel: boolean
  }
  | {
    /**
     * A component this renderer **carries but cannot draw**, because the
     * platform endpoint it needs does not exist. Kept as an explicit entry so
     * the refusal names the real reason instead of reading as a missing import.
     */
    readonly kind: 'unsupported'
    readonly viewTypes: readonly ViewType[]
    readonly code: string
    readonly needs?: 'query'
  }

const ALL_VIEWS: readonly ViewType[] = ['FORM', 'LIST', 'DETAIL']
const FORM_ONLY: readonly ViewType[] = ['FORM']
const LIST_ONLY: readonly ViewType[] = ['LIST']
const DETAIL_ONLY: readonly ViewType[] = ['DETAIL']

function readOnlyOf(mode: string): boolean {
  return mode === 'READONLY' || mode === 'MASKED'
}

/** The shared label + control frame every field uses. */
function Field({ label, children }: {
  readonly label: string
  readonly children: ReactNode
}): ReactNode {
  return (
    <label className={css.field}>
      <span>{label}</span>
      {children}
    </label>
  )
}


/**
 * Single-line text.
 * @param props - field presentation and the change callback.
 * @returns the input.
 */
function ShortTextField({ field, label, value, mode, onChange }: FieldRenderProps): ReactNode {
  return (
    <Field label={label}>
      <input
        aria-label={field}
        value={value}
        readOnly={readOnlyOf(mode)}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.value) }}
        className={css.control}
      />
    </Field>
  )
}

/**
 * Multi-line text.
 * @param props - field presentation and the change callback.
 * @returns the textarea.
 */
function LongTextField({ field, label, value, mode, onChange }: FieldRenderProps): ReactNode {
  return (
    <Field label={label}>
      <textarea
        aria-label={field}
        value={value}
        readOnly={readOnlyOf(mode)}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.value) }}
        className={css.control}
      />
    </Field>
  )
}

/**
 * Integers, decimals and money all use the browser's numeric input.
 *
 * `step` is `any` rather than 1: a decimal field whose step refused its own
 * contract value would mark a valid record invalid in the browser.
 * @param props - field presentation and the change callback.
 * @returns the numeric input.
 */
function NumberField({ field, label, value, mode, onChange }: FieldRenderProps): ReactNode {
  return (
    <Field label={label}>
      <input
        aria-label={field}
        type="number"
        step="any"
        value={value}
        readOnly={readOnlyOf(mode)}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.value) }}
        className={css.control}
      />
    </Field>
  )
}

/**
 * A checkbox. The controlled value is the string `'true'` / `'false'`, so the
 * payload carries the same type the wire uses for every other field.
 * @param props - field presentation and the change callback.
 * @returns the checkbox.
 */
function BooleanField({ field, label, value, mode, onChange }: FieldRenderProps): ReactNode {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <input
        aria-label={field}
        type="checkbox"
        checked={value === 'true'}
        readOnly={readOnlyOf(mode)}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.checked ? 'true' : 'false') }}
      />
      <span style={{ fontSize: 12, marginLeft: 6 }}>{label}</span>
    </label>
  )
}

/**
 * A date, or a date and time when the model declares `datetime`.
 * @param props - field presentation and the change callback.
 * @returns the date input.
 */
function DateField({ field, label, value, mode, onChange }: FieldRenderProps): ReactNode {
  return (
    <Field label={label}>
      <input
        aria-label={field}
        type="date"
        value={value}
        readOnly={readOnlyOf(mode)}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.value) }}
        className={css.control}
      />
    </Field>
  )
}

/**
 * A date and time.
 * @param props - field presentation and the change callback.
 * @returns the datetime input.
 */
function DateTimeField({ field, label, value, mode, onChange }: FieldRenderProps): ReactNode {
  return (
    <Field label={label}>
      <input
        aria-label={field}
        type="datetime-local"
        value={value}
        readOnly={readOnlyOf(mode)}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.value) }}
        className={css.control}
      />
    </Field>
  )
}

/**
 * A single choice.
 *
 * The options come from the model's `type_config.options`, never from the view:
 * a view that listed its own choices would be a second source of truth for what
 * the column accepts.
 * @param props - field presentation, the model's options, and the change callback.
 * @returns the select.
 */
function SingleSelectField({ field, label, value, mode, options, onChange }: FieldRenderProps): ReactNode {
  return (
    <Field label={label}>
      <select
        aria-label={field}
        value={value}
        disabled={readOnlyOf(mode)}
        onChange={(e) => { onChange(e.target.value) }}
        className={css.control}
      >
        <option value="" />
        {(options ?? []).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </Field>
  )
}

/**
 * Several choices.
 *
 * The value is a comma-separated list because the platform's record `data` is a
 * flat map of field code to value; a nested array would change the wire format
 * the execution point accepts.
 * @param props - field presentation, the model's options, and the change callback.
 * @returns the option group.
 */
function MultiSelectField({ field, label, value, mode, options, onChange }: FieldRenderProps): ReactNode {
  const chosen = value === '' ? [] : value.split(',')
  const toggle = (code: string, on: boolean): void => {
    const next = on ? [...chosen, code] : chosen.filter(c => c !== code)
    onChange(next.join(','))
  }
  return (
    <fieldset style={{ border: 'none', margin: '0 0 10px', padding: 0 }}>
      <legend style={{ fontSize: 12, opacity: .7, padding: 0 }}>{label}</legend>
      {(options ?? []).map(o => (
        <label key={o.value} style={{ display: 'block', fontSize: 12 }}>
          <input
            type="checkbox"
            aria-label={`${field}:${o.value}`}
            checked={chosen.includes(o.value)}
            disabled={readOnlyOf(mode)}
            onChange={(e) => { toggle(o.value, e.target.checked) }}
          />
          <span style={{ marginLeft: 6 }}>{o.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

/**
 * A labelled read-only line.
 * @param props - the label and value.
 * @returns the row.
 */
function Description({ label, value }: ValueRenderProps): ReactNode {
  return (
    <div style={{ marginBottom: 8, fontSize: 12.5 }} data-kvvi-value="description">
      <span style={{ opacity: .6, marginRight: 6 }}>{label}</span>
      <span>{value}</span>
    </div>
  )
}

/**
 * A value with its state emphasised.
 * @param props - the label and value.
 * @returns the badge.
 */
function StatusBadge({ label, value }: ValueRenderProps): ReactNode {
  return (
    <span
      data-kvvi-value="status"
      style={{
        display: 'inline-block', margin: '0 8px 8px 0', padding: '2px 8px',
        border: '1px solid var(--dsw-border, #e5e7eb)', borderRadius: 999, fontSize: 12,
      }}
      title={label}
    >
      {value}
    </span>
  )
}

/**
 * A plain bound value, or literal text.
 * @param props - the label and value.
 * @returns the value.
 */
function Text({ value }: ValueRenderProps): ReactNode {
  return <span data-kvvi-value="text">{value}</span>
}

/**
 * A section with a heading.
 * @param props - the heading and children.
 * @returns the section.
 */
function Section({ title, children }: { readonly title?: string; readonly children: ReactNode }): ReactNode {
  return (
    <section className={css.section}>
      {title === undefined ? null : <div className={css.sectionHeading}>{title}</div>}
      {children}
    </section>
  )
}

/**
 * A two-column grid.
 *
 * One column below 480px: the panel is a fixed overlay, so the available width
 * is known at render time and a squeeze-to-fit would be worse than a stack.
 * @param props - the children.
 * @returns the grid.
 */
function Grid({ children }: { readonly title?: string; readonly children: ReactNode }): ReactNode {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
      {children}
    </div>
  )
}

/**
 * The page roots. All three draw their children; they differ only in which view
 * type they belong to, which the table already encodes.
 * @param props - the children.
 * @returns the children.
 */
function PageRoot({ children }: { readonly title?: string; readonly children: ReactNode }): ReactNode {
  return <div data-kvvi-page="1">{children}</div>
}

/**
 * The closed table. Keys are the `componentName` values a contract may use.
 *
 * Every name matches the platform's `COMPONENT_REGISTRY`, and every `viewTypes`
 * matches that registry's own declaration for the same name.
 */
export const COMPONENT_REGISTRY: Readonly<Record<string, RegistryEntry>> = Object.freeze({
  FormPage: { kind: 'layout', viewTypes: FORM_ONLY, render: PageRoot },
  ListPage: { kind: 'layout', viewTypes: LIST_ONLY, render: PageRoot },
  DetailPage: { kind: 'layout', viewTypes: DETAIL_ONLY, render: PageRoot },
  Section: { kind: 'layout', viewTypes: ALL_VIEWS, render: Section },
  Grid: { kind: 'layout', viewTypes: ALL_VIEWS, render: Grid },

  ShortTextField: { kind: 'field', viewTypes: ALL_VIEWS, render: ShortTextField },
  LongTextField: { kind: 'field', viewTypes: ALL_VIEWS, render: LongTextField },
  BooleanField: { kind: 'field', viewTypes: ALL_VIEWS, render: BooleanField },
  IntegerField: { kind: 'field', viewTypes: ALL_VIEWS, render: NumberField },
  DecimalField: { kind: 'field', viewTypes: ALL_VIEWS, render: NumberField },
  MoneyField: { kind: 'field', viewTypes: ALL_VIEWS, render: NumberField },
  DateField: { kind: 'field', viewTypes: ALL_VIEWS, render: DateField },
  DateTimeField: { kind: 'field', viewTypes: ALL_VIEWS, render: DateTimeField },
  SingleSelectField: { kind: 'field', viewTypes: ALL_VIEWS, render: SingleSelectField },
  MultiSelectField: { kind: 'field', viewTypes: ALL_VIEWS, render: MultiSelectField },

  Text: { kind: 'value', viewTypes: ALL_VIEWS, render: Text },
  Description: { kind: 'value', viewTypes: ALL_VIEWS, render: Description },
  StatusBadge: { kind: 'value', viewTypes: ALL_VIEWS, render: StatusBadge },

  // A `Table` in a published view binds to a `DataBindingRef` with a
  // `queryCode`. The platform exposes systems, runtimes and records — there is
  // no query endpoint — so this entry refuses in a way that names the missing
  // endpoint. Drawing an empty table instead would report "no data" for "no
  // data source", which is the failure this refusal exists to prevent.
  Table: { kind: 'unsupported', viewTypes: ALL_VIEWS, code: QUERY_UNSUPPORTED, needs: 'query' },

  SaveDraftButton: { kind: 'button', viewTypes: ALL_VIEWS, action: 'draft', defaultLabel: true },
  SubmitButton: { kind: 'button', viewTypes: ALL_VIEWS, action: 'submit', defaultLabel: true },
  CancelButton: { kind: 'button', viewTypes: ALL_VIEWS, action: 'cancel', defaultLabel: true },
  OpenRecordLink: { kind: 'button', viewTypes: ALL_VIEWS, action: 'openRecord', defaultLabel: true },
})

/** Re-exported so callers depend on one module for every refusal code. */
export { NOT_REGISTERED, WRONG_VIEW_TYPE, FIELD_UNBOUND, QUERY_UNSUPPORTED }
