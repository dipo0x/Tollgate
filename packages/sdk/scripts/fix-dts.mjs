// tsc leaves `./file.ts` in the generated .d.ts imports. A consumer's compiler would reject that, so point them at `./file.js`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
const dir = new URL('../dist/', import.meta.url)
for (const f of readdirSync(dir).filter(n => n.endsWith('.d.ts'))) {
  const p = new URL(f, dir), s = readFileSync(p, 'utf8')
  writeFileSync(p, s.replace(/(from\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'))
}
