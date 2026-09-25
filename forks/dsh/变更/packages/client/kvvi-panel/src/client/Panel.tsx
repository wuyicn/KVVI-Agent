/**
 * Presentational components for the KVVI business panel.
 *
 * These are pure props consumers: they read nothing from context, subscribe to
 * nothing, and hold only the transient state of their own request. Registration
 * lives in `index.ts`.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Platform base for the panel's data reads.
 *
 * Empty means **same origin**: the browser asks whichever origin served this
 * bundle, and that origin is the KVVI platform service. Hardcoding a different
 * port here was the bug — the client's origin and the platform's origin are the
 * same one in the product deployment, because the platform is the only entry.
 */
const PLATFORM_BASE = ''

/**
 * Event the sidebar entry raises to ask the overlay to open.
 *
 * The two occupy different slots, so neither can render the other; a DOM event
 * is the narrowest thing that crosses between them without a module-level
 * mutable shared by every consumer. The name is namespaced to this package.
 */
const KVVI_OPEN_EVENT = 'kvvi-panel:open'

interface PanelData {
  readonly error?: string
  readonly companyName?: string | null
  readonly login?: string | null
  readonly capabilities?: readonly string[]
}

/**
 * Read this session's business context from the platform service.
 *
 * Failures resolve to `{ error }` rather than throwing: the panel is
 * supplementary, and "could not read" must stay distinguishable from "nothing
 * to do". Collapsing the two into one empty state would tell an employee their
 * queue is clear when the truth is that nobody asked.
 * @param signal - aborts the request on unmount.
 * @returns the panel data, or an error description.
 */
async function loadPanel(signal: AbortSignal): Promise<PanelData> {
  try {
    const res = await fetch(`${PLATFORM_BASE}/kvvi/panel`, { signal })
    if (!res.ok) return { error: `平台服务返回 ${res.status}` }
    return await res.json() as PanelData
  } catch (error) {
    if (signal.aborted) return { error: '已取消' }
    return { error: `连不上平台服务：${String(error)}` }
  }
}

interface Block {
  readonly title: string
  readonly hint: string
  readonly lines: readonly string[]
}

/**
 * Fold the platform payload into the four business views.
 *
 * They stay separate blocks because they fail differently: an empty queue
 * means nothing to do, while an empty capability list means permissions are
 * unconfigured. One shared "暂无" would read them as the same fact.
 * @param data - the platform payload, or its absence.
 * @returns blocks to render, in employee-priority order.
 */
function blocksOf(data: PanelData): readonly Block[] {
  return [
    {
      title: '待办',
      hint: '等你审批、以及你提交后还在流转的事',
      lines: data.error
        ? [`读取失败：${data.error}`]
        : ['待办口径尚未接通 —— 平台侧还没有这个端点'],
    },
    {
      title: '我的系统',
      hint: '本公司已发布的业务系统',
      lines: ['发布通道的已发布版本还没有对外列表接口'],
    },
    {
      title: '我的权限',
      hint: '本会话能做什么，由身份层给出',
      lines: data.capabilities?.length
        ? [...data.capabilities]
        : ['身份层没有给出任何能力 —— 请联系管理员确认你的角色'],
    },
    {
      title: '聚合口径',
      hint: '已定义的汇总，只读',
      lines: ['已定义的聚合口径还没有对外列表接口'],
    },
  ]
}

/**
 * Render the panel over the conversation area.
 * @param props - `onClose` from the registration site.
 * @returns the overlay.
 */
export function KvviPanel({ onClose }: { readonly onClose: () => void }): ReactNode {
  const [data, setData] = useState<PanelData | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void loadPanel(controller.signal).then(setData)
    return () => { controller.abort() }
  }, [])

  const who = data?.companyName ?? data?.login

  return (
    <div
      role="dialog"
      aria-label="KVVI business panel"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60, padding: 24,
        background: 'rgba(16,24,40,.28)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(event) => { event.stopPropagation() }}
        style={{
          background: 'var(--dsw-surface, #fff)', color: 'var(--dsw-fg, #111827)',
          borderRadius: 14, padding: '22px 24px', width: '100%',
          maxWidth: 560, maxHeight: '80vh', overflow: 'auto',
          boxShadow: '0 12px 32px rgba(16,24,40,.18)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <strong style={{ fontSize: 15 }}>业务</strong>
          {who ? <span style={{ fontSize: 12, opacity: .6 }}>{who}</span> : null}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            style={{
              border: '1px solid var(--dsw-border, #e5e7eb)', background: 'none',
              borderRadius: 8, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
              color: 'inherit',
            }}
          >
            关闭
          </button>
        </div>

        {blocksOf(data ?? {}).map(block => (
          <section key={block.title} style={{ marginTop: 18 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>{block.title}</div>
            <div style={{ fontSize: 12, opacity: .6, marginBottom: 8 }}>{block.hint}</div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {block.lines.map((line, index) => (
                <li
                  key={`${block.title}-${String(index)}`}
                  style={{
                    fontSize: 12.5, padding: '7px 0', opacity: .85,
                    borderTop: index === 0 ? 'none' : '1px solid var(--dsw-border, #f1f2f4)',
                  }}
                >
                  {line}
                </li>
              ))}
            </ul>
          </section>
        ))}

        {data?.error ? (
          <p style={{ fontSize: 12, opacity: .6, marginTop: 18, lineHeight: 1.7 }}>
            面板是附加信息。取不到时只会少显示内容，不影响对话与其他操作。
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Render the sidebar foot entry.
 * @param props - host-supplied width hint (`wide: false` is the 56px rail).
 * @returns the entry button.
 */
export function KvviEntry(
  { wide, onOpen }: SidebarFooterActionOwnerProps & { readonly onOpen: () => void },
): ReactNode {
  return (
    <button
      type="button"
      onClick={onOpen}
      title="业务"
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%',
        border: 'none', background: 'none', cursor: 'pointer',
        color: 'inherit', padding: '6px 8px', borderRadius: 8, fontSize: 13,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 14 }}>▣</span>
      {wide ? <span>业务</span> : null}
    </button>
  )
}

/**
 * Build the sidebar foot entry as a component.
 *
 * A factory rather than a module-level component: the bundle's public surface
 * stays `apply`/`inject`, and the registration site names what it registers.
 * @returns the entry component.
 */
export function createKvviEntry(): (props: SidebarFooterActionOwnerProps) => ReactNode {
  return (props: SidebarFooterActionOwnerProps) => (
    <KvviEntry
      {...props}
      onOpen={() => { globalThis.dispatchEvent(new Event(KVVI_OPEN_EVENT)) }}
    />
  )
}

/**
 * Build the panel as a component that owns its own closed/open state.
 *
 * The state is local because it is not shared with any other entry and does not
 * need to survive a remount: the panel is a transient view, not a layout fact.
 * @returns the overlay component.
 */
export function createKvviOverlay(): () => ReactNode {
  return () => {
    const [open, setOpen] = useState(false)
    useEffect(() => {
      const openPanel = (): void => { setOpen(true) }
      globalThis.addEventListener(KVVI_OPEN_EVENT, openPanel)
      return () => { globalThis.removeEventListener(KVVI_OPEN_EVENT, openPanel) }
    }, [])
    return open ? <KvviPanel onClose={() => { setOpen(false) }} /> : null
  }
}
