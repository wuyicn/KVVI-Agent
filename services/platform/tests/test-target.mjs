import { readFileSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Fail before reset, including per-database administrator overrides. Never print DSNs. */
export function assertTestTarget(dsns, marker) {
  try {
    const value = typeof marker === 'string' ? JSON.parse(marker) : marker
    if (value?.kind !== 'kvvi-disposable-test-cluster' || !Number.isInteger(value.port)) throw 0
    const dir = realpathSync(value.dataDirectory)
    if (!basename(dir).startsWith('kvvi-group-test-')) throw 0
    const pid = readFileSync(join(dir, 'postmaster.pid'), 'utf8').split('\n')
    if (realpathSync(pid[1]) !== dir || Number(pid[3]) !== value.port) throw 0
    process.kill(Number(pid[0]), 0)
    if (Object.keys(dsns).length < 5) throw 0
    for (const dsn of Object.values(dsns)) {
      const url = new URL(dsn)
      if (!['postgres:', 'postgresql:'].includes(url.protocol)
        || url.hostname !== '127.0.0.1' || Number(url.port) !== value.port
        || url.search !== '' || url.hash !== '') throw 0
    }
  } catch {
    throw new Error('KVVI_UNSAFE_TEST_TARGET: use a running disposable test cluster')
  }
}
