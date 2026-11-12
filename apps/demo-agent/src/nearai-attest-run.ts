/**
 * `pnpm nearai:attest`: check NEAR AI Cloud's enclaves live, with no key and no funds. For the gateway and for one model NEAR AI
 * runs itself, it sends a fresh nonce, then reads the Intel TDX quote's own bytes and requires them to bind that enclave's signing
 * key and our nonce (nearai-verify.ts). Writes the result to bench/results/nearai-attestation.json.
 *
 * What this proves: those keys are the ones the TDX quotes name, and the quotes are fresh. What it does not: Intel's signature on
 * the quotes, or that any particular answer was signed (that needs a completion, which needs NEAR AI credit).
 */
import { writeFileSync } from 'node:fs'
import { attest } from './nearai-verify.ts'

const BASE = 'https://cloud-api.near.ai/v1'
const MODEL = process.env['NEARAI_MODEL']?.trim() || 'Qwen/Qwen3.6-35B-A3B-FP8'

const withModel = await attest(fetch, BASE, MODEL)
const gatewayOnly = withModel.ok ? withModel : await attest(fetch, BASE)
const result = {
  checkedAt: new Date().toISOString(),
  endpoint: `${BASE}/attestation/report`,
  model: MODEL,
  ok: gatewayOnly.ok,
  ...(gatewayOnly.ok
    ? { enclaves: gatewayOnly.attested.map(a => ({ source: a.source, signingAddress: a.signingAddress, nonce: a.nonce })) }
    : { why: gatewayOnly.why }),
  checked: 'fresh 32-byte nonce echoed; TDX quote v4 (tee 0x81) report_data = signing address, 12 zero bytes, our nonce, read from the quote bytes',
  notChecked: "Intel's signature chain on the quote (DCAP), measurements, GPU evidence; any completion's signature (needs credit)",
}
const out = new URL('../../../bench/results/nearai-attestation.json', import.meta.url)
writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
if (gatewayOnly.ok) for (const e of gatewayOnly.attested) console.log(`${e.source.padEnd(8)} ${e.signingAddress}  bound in a fresh TDX quote`)
else console.log(`Not verified: ${gatewayOnly.why}`)
console.log(`Written to bench/results/nearai-attestation.json`)
process.exitCode = result.ok ? 0 : 1
