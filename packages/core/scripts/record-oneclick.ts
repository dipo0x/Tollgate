// Records real 1Click responses into fixtures/oneclick/ so everything else can replay them offline.
// Run it by hand: `pnpm --filter @tollgate/core record:oneclick`. It never runs in CI.
//
// Safe by construction: it only reads (token list, a status lookup) and makes a DRY quote,
// which creates nothing and moves no money. The API key is read from the git-ignored .env, sent
// only as a header, and stripped from anything written to disk.
import { FileFixtureStore, HttpOneClick, MemoryFixtureStore, recordingFetch } from '../src/oneclick/index.ts'

try { process.loadEnvFile(new URL('../../../.env', import.meta.url)) } catch { /* rely on the real environment */ }
const key = process.env['NEAR_1CLICK_API_KEY'] ?? process.env['ONECLICK_JWT'] ?? ''
if (!key) { console.error('No API key found (NEAR_1CLICK_API_KEY). Nothing recorded.'); process.exit(1) }

const dir = new URL('../fixtures/oneclick/', import.meta.url).pathname
const disk = new FileFixtureStore(dir)
const staging = new MemoryFixtureStore()
const live = new HttpOneClick({ apiKey: key, fetch: recordingFetch(fetch, staging, { secrets: [key] }) })

// 1. The public token list.
const cat = await live.tokens()
console.log(`tokens: ${cat.size}`)

// 2. A deposit address 1Click has never seen: the real 404.
const missing = await live.status('6ccbfe88ce0d615631d41dd81b48518f0ea27e60b8805d363159b4ab6bbb46f3')
console.log(`status of an unknown address -> found: ${missing.found}`)

// 3. A dry quote. Kept only if it really works; a service error must not be frozen into fixtures.
const usdcNear = cat.find('USDC', 'near')
let quoted = false
if (usdcNear) {
  try {
    const q = await live.dryQuote({
      originAsset: 'USDC', originNetwork: 'near', destinationAsset: 'USDC', destination: 'merchant.near',
      amountOut: '1.000000', refundTo: 'payer.near', originAssetId: usdcNear.assetId, destinationAssetId: usdcNear.assetId,
    })
    console.log('dry quote ->', JSON.stringify(q)); quoted = true
  } catch (err) { console.warn('dry quote NOT recorded:', err instanceof Error ? err.message : err) }
}

for (const f of staging.all.values()) {
  const isQuote = f.request.path === '/v0/quote'
  if (isQuote && !quoted) continue
  disk.put({ ...f, note: isQuote ? 'live dry quote' : 'recorded from the live service' })
  console.log(`saved ${f.request.method} ${f.request.path} -> HTTP ${f.response.status}${f.scrubbed ? ' (secret scrubbed)' : ''}`)
}
