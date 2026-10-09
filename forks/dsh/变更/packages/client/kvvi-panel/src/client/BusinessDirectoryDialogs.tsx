/** Confirmed metadata writes use one retry key until their payload changes. */
import { useEffect, useRef, useState } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Copy } from './FormView.tsx'
import { writeDirectory, type BusinessGroup, type DirectoryAction, type DirectoryInput } from './business-directory-api.ts'
import { ReadFailure } from './ReadFailure.tsx'
import css from './business.module.css'
export interface DirectoryDialog { action: DirectoryAction; input: DirectoryInput }
const labels = { 'group.create': 'directory.newGroup', 'group.rename': 'directory.rename', 'group.delete': 'directory.dissolve', 'form.move': 'directory.move', 'form.archive': 'directory.archive', 'form.restore': 'directory.restore' } as const
/** @param props - immutable target/version and completion callbacks. @returns a confirmation dialog. */
export function BusinessDirectoryDialogs({ dialog, groups, copy, onClose, onCommitted, onConflict }: {
  dialog: DirectoryDialog
  groups: readonly BusinessGroup[]
  copy: Copy
  onClose: () => void
  onCommitted: (pending: boolean) => void
  onConflict: () => void
}) {
  const [name, setName] = useState(dialog.input.name ?? '')
  const [groupId, setGroupId] = useState(dialog.input.groupId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [conflict, setConflict] = useState(false)
  const retry = useRef<{ body: string; id: string }>()
  const writing = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  // The request may commit after close/navigation; never abort it and imply it was undone.
  const naming = dialog.action === 'group.create' || dialog.action === 'group.rename'
  const submit = () => {
    if (writing.current || conflict) return
    const input = { ...dialog.input, ...(naming ? { name: name.trim() } : {}), ...(dialog.action === 'form.move' ? { groupId: groupId || null } : {}), ...(['form.archive', 'form.restore'].includes(dialog.action) ? { confirmed: true } : {}) }
    const body = JSON.stringify(input)
    if (retry.current?.body !== body) retry.current = { body, id: randomUUID() }
    writing.current = true; setBusy(true); setError(undefined)
    void writeDirectory(dialog.action, input, { operationId: retry.current.id }).then((result) => {
      writing.current = false
      if (!alive.current) return
      setBusy(false)
      if (result.ok) { onCommitted(result.value.auditPending); return }
      setError(result.code)
      if (result.status === 409) { setConflict(true); onConflict() }
    })
  }
  return <Modal open title={copy(labels[dialog.action])} closeLabel={copy('panel.close')} onClose={() => { if (!busy) { alive.current = false; onClose() } }}>
    {dialog.action === 'group.delete' ? <p>{copy('directory.dissolveHint')}</p> : null}
    {dialog.action === 'form.archive' ? <p>{copy('directory.archiveHint')}</p> : null}
    {dialog.action === 'form.restore' ? <p>{copy('directory.restoreHint')}</p> : null}
    {naming ? <label className={css.field}>{copy('directory.groupName')}<input className={css.control} value={name} maxLength={80} disabled={busy || conflict} onChange={(e) => { setName(e.target.value) }}/></label> : null}
    {dialog.action === 'form.move' ? <label className={css.field}>{copy('directory.groupName')}<select className={css.control} value={groupId} disabled={busy || conflict} onChange={(e) => { setGroupId(e.target.value) }}><option value="">{copy('directory.ungrouped')}</option>{groups.map(g => <option key={g.groupId} value={g.groupId}>{g.name}</option>)}</select></label> : null}
    {error ? <ReadFailure copy={copy} error={error} onRetry={() => { if (conflict) onClose(); else submit() }}/> : null}
    {conflict ? <p role="status">{copy('directory.conflict')}</p> : null}
    <div className={css.formActions}><Button variant="outline" disabled={busy} onClick={onClose}>{copy('panel.close')}</Button><Button variant="primary" disabled={busy || conflict || (naming && !name.trim())} onClick={submit}>{copy('directory.confirm')}</Button></div>
  </Modal>
}
