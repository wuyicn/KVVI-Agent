/** Private builder files live below the configured runtime home, never a browser-selected path. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

interface BuilderIdentity { companyId: string; userId: string; gateway: 'USER' | 'BUILDER' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function directory(path: string): boolean {
  let created = false
  try { mkdirSync(path, { mode: 0o700 }); created = true }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid directory')
  return created
}
/**
 * @param home - operator-configured absolute DSH home; missing storage fails closed.
 * @param identity - verified platform identity, not request-body claims.
 * @param intentId - stable build UUID; names never participate in path selection.
 * @returns an existing owned or newly created directory. Unmarked paths and links are refused.
 */
export function managedBusinessDirectory(home: string | undefined, identity: BuilderIdentity, intentId: string): string {
  if (identity.gateway !== 'BUILDER') throw new Error('KVVI_BUILDER_REQUIRED')
  if (!uuid.test(intentId)) throw new Error('KVVI_BUILD_INVALID')
  try {
    if (!home || !isAbsolute(home)) throw new Error('missing runtime home')
    let path = realpathSync(home)
    const owner = digest(JSON.stringify([identity.companyId, identity.userId]))
    for (const part of ['business-workspaces', owner]) { path = join(path, part); directory(path) }
    path = join(path, intentId)
    const marker = join(path, '.kvvi-build.json')
    const value = JSON.stringify({ version: 1, owner, intentId })
    // Keep allocation and its ownership marker together without yielding to another request.
    if (directory(path)) writeFileSync(marker, value, { flag: 'wx', mode: 0o600 })
    const info = lstatSync(marker)
    if (!info.isFile() || info.isSymbolicLink() || readFileSync(marker, 'utf8') !== value) throw new Error('ownership mismatch')
    return path
  } catch { throw new Error('KVVI_BUILD_STORAGE_UNAVAILABLE') }
}
