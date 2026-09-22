import { copyFile } from 'node:fs/promises'

await Promise.all([
  copyFile(new URL('../lib/index.js', import.meta.url), new URL('../lib/runtime.js', import.meta.url)),
  copyFile(new URL('../lib/index.d.ts', import.meta.url), new URL('../lib/runtime.d.ts', import.meta.url)),
  copyFile(new URL('../lib/index.js', import.meta.url), new URL('../lib/runtime-automation.js', import.meta.url)),
  copyFile(new URL('../lib/index.d.ts', import.meta.url), new URL('../lib/runtime-automation.d.ts', import.meta.url)),
  copyFile(new URL('../lib/index.js', import.meta.url), new URL('../lib/runtime-integrations.js', import.meta.url)),
  copyFile(new URL('../lib/index.d.ts', import.meta.url), new URL('../lib/runtime-integrations.d.ts', import.meta.url)),
  copyFile(new URL('../lib/index.js', import.meta.url), new URL('../lib/runtime-resilience.js', import.meta.url)),
  copyFile(new URL('../lib/index.d.ts', import.meta.url), new URL('../lib/runtime-resilience.d.ts', import.meta.url)),
])
