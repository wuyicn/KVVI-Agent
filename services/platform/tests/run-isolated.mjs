// Usage from services/platform: node tests/run-isolated.mjs npm test
// Never inherits a pilot DSN. Stops its own disposable cluster, retains evidence.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import net from 'node:net'
const pg = process.env.KVVI_TEST_PG_BIN ? process.env.KVVI_TEST_PG_BIN.replace(/\/$/, '')+'/' : ''
const dir = mkdtempSync(join(tmpdir(), 'kvvi-group-test-'))
const server = net.createServer()
await new Promise(r => server.listen(0, '127.0.0.1', r))
const port = server.address().port
await new Promise(r => server.close(r))
execFileSync(pg+'initdb', ['-D',dir,'-U','kvvi','-A','trust','--no-locale','-E','UTF8'],{stdio:'pipe'})
execFileSync(pg+'pg_ctl',['-D',dir,'-l',join(dir,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${dir}`,'-w','start'],{stdio:'pipe'})
console.log(`Isolated test cluster: ${dir}; port ${port}`)
const env = {...process.env}
for (const key of Object.keys(env)) if (key.startsWith('KVVI_')) delete env[key]
for (const [name,user,db] of [['ADMIN','kvvi','postgres'],['PLATFORM','kvvi_platform','kvvi_platform'],['BUSINESS','kvvi_business','kvvi_business'],['AUDIT','kvvi_audit_writer','kvvi_audit'],['AUDITREAD','kvvi_audit_reader','kvvi_audit']]) env[`KVVI_${name}_DSN`]=`postgres://${user}:kvvi-test@127.0.0.1:${port}/${db}`
env.KVVI_TEST_CLUSTER_MARKER = JSON.stringify({kind:'kvvi-disposable-test-cluster',dataDirectory:dir,port})
env.KVVI_SIGNING_KEY_PATH = join(dir,'test-signing.key')
let result
try { result=spawnSync(process.argv[2],process.argv.slice(3),{env,stdio:'inherit'}) }
finally { execFileSync(pg+'pg_ctl',['-D',dir,'-m','fast','-w','stop'],{stdio:'pipe'}); console.log('Test cluster stopped; retained for evidence:',dir) }
process.exit(result?.status ?? 1)
