// Fetches Satoshi from Fontshare (Indian Type Foundry) into assets/fonts, once.
// Its licence (ITF Free Font License) allows embedding it in this app but not redistributing the files from a repository,
// so the files are git-ignored and fetched here instead of committed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = new URL('../assets/fonts/', import.meta.url).pathname
const WEIGHTS = ['Regular', 'Medium', 'Bold', 'Black']
const need = WEIGHTS.filter(w => !existsSync(join(OUT, `Satoshi-${w}.otf`)))
if (need.length === 0) process.exit(0)

console.log('Fetching the Satoshi font from Fontshare (about 2 MB, once)...')
const dir = mkdtempSync(join(tmpdir(), 'satoshi-'))
try {
  const res = await fetch('https://api.fontshare.com/v2/fonts/download/satoshi')
  if (!res.ok) throw new Error(`Fontshare answered ${res.status}`)
  const zip = join(dir, 'satoshi.zip')
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()))
  execFileSync('unzip', ['-q', '-o', zip, '-d', dir])
  mkdirSync(OUT, { recursive: true })
  for (const w of WEIGHTS) copyFileSync(join(dir, 'Satoshi_Complete', 'Fonts', 'OTF', `Satoshi-${w}.otf`), join(OUT, `Satoshi-${w}.otf`))
  console.log('Satoshi is ready.')
} catch (e) {
  console.error(`Could not fetch Satoshi: ${e.message}\nDownload it from https://www.fontshare.com/fonts/satoshi and put Satoshi-Regular/Medium/Bold/Black.otf in apps/mobile/assets/fonts.`)
  process.exitCode = 1
} finally {
  rmSync(dir, { recursive: true, force: true })
}
