import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { managedBusinessDirectory } from '../src/business-directory.ts'

const temporary: string[] = []
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function home() { const path = await mkdtemp(join(tmpdir(), 'kvvi-managed-test-')); temporary.push(path); return path }
const mode = { companyId: 'company', userId: 'builder', gateway: 'BUILDER' as const }
const intent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
it('allocates a private directory per identity and intent, with durable retry ownership', async () => {
  const root = await home()
  const first = managedBusinessDirectory(root, mode, intent)
  expect(managedBusinessDirectory(root, mode, intent)).toBe(first)
  expect(managedBusinessDirectory(root, { ...mode, userId: 'other' }, intent)).not.toBe(first)
  expect(managedBusinessDirectory(root, { ...mode, companyId: 'other' }, intent)).not.toBe(first)
  expect(JSON.parse(await readFile(join(first, '.kvvi-build.json'), 'utf8')).intentId).toBe(intent)
  expect(managedBusinessDirectory(root, mode, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).not.toBe(first)
})
it('refuses worker access, traversal, missing deployment storage and symlink roots', async () => {
  const root = await home()
  expect(() => managedBusinessDirectory(root, { ...mode, gateway: 'USER' }, intent)).toThrow('KVVI_BUILDER_REQUIRED')
  expect(() => managedBusinessDirectory(root, mode, '../outside')).toThrow('KVVI_BUILD_INVALID')
  expect(() => managedBusinessDirectory(undefined, mode, intent)).toThrow('KVVI_BUILD_STORAGE_UNAVAILABLE')
  expect(await readdir(root)).toEqual([])
  const outside = await home()
  await symlink(outside, join(root, 'business-workspaces'))
  expect(() => managedBusinessDirectory(root, mode, intent)).toThrow('KVVI_BUILD_STORAGE_UNAVAILABLE')
  expect(await readdir(outside)).toEqual([])
})
it('never adopts an unmarked existing directory or follows a replaced leaf', async () => {
  const root = await home()
  const path = managedBusinessDirectory(root, mode, intent)
  await rm(path, { recursive: true })
  await mkdir(path)
  expect(() => managedBusinessDirectory(root, mode, intent)).toThrow('KVVI_BUILD_STORAGE_UNAVAILABLE')
  await rm(path, { recursive: true })
  await symlink(await home(), path)
  expect(() => managedBusinessDirectory(root, mode, intent)).toThrow('KVVI_BUILD_STORAGE_UNAVAILABLE')
})
