import { randomBytes } from 'node:crypto'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'
import { z } from 'zod'

/**
 * NEAR AI Cloud runs models inside Intel TDX enclaves and signs every completion with a key that lives in the enclave. This checks,
 * for one answer, the parts a client can check without Intel's own verifier:
 *
 *   1. ATTESTATION (before the answer is trusted). GET /v1/attestation/report with a nonce we just made. The TDX quote's OWN bytes
 *      (not the JSON next to it) must carry report_data = signing address, 12 zero bytes, our nonce. So the key that signs is the
 *      key that quote names, and the quote is fresh, not replayed.
 *   2. SIGNATURE (for this answer). GET /v1/signature/<chat id>. Its text must be sha256(exact request bytes):sha256(exact response
 *      bytes) and it must recover (EIP-191) to the attested address.
 *
 * What this does NOT do, stated where it is used: verify the quote's Intel signature chain (DCAP), its measurements, or GPU evidence.
 * For that, NEAR AI publishes nearai-cloud-verifier. An answer that fails any step is labelled unverified, never verified.
 * Docs: https://docs.near.ai/cloud/verification
 */

const HEX = /^[0-9a-f]*$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i

const Attestation = z.object({
  signing_address: z.string().regex(ADDRESS),
  signing_algo: z.literal('ecdsa'),
  intel_quote: z.string().regex(HEX).min(1264), // at least header + TD report: 632 bytes
  request_nonce: z.string().regex(/^[0-9a-f]{64}$/i),
})
const Report = z.object({ gateway_attestation: Attestation, model_attestations: z.array(Attestation).optional() })

export type Attested = { signingAddress: string; nonce: string; source: 'gateway' | 'model' }

/** TDX quote v4: 48-byte header, then the TD report; report_data is the TD report's last 64 bytes, at offset 568. */
export function reportDataOfQuote(quoteHex: string): Uint8Array | undefined {
  const q = hexToBytes(quoteHex.length % 2 ? `0${quoteHex}` : quoteHex)
  if (q.length < 632) return undefined
  const version = q[0]! | (q[1]! << 8)
  const teeType = q[4]! | (q[5]! << 8) | (q[6]! << 16) | (q[7]! << 24)
  if (version !== 4 || teeType !== 0x81) return undefined // 0x81 = Intel TDX
  return q.subarray(568, 632)
}

/** Does this quote bind this signer (20 bytes, then 12 zeros) and this nonce (32 bytes)? Read from the quote, not the JSON. */
export function quoteBinds(quoteHex: string, address: string, nonce: string): boolean {
  const rd = reportDataOfQuote(quoteHex)
  if (!rd) return false
  const want = new Uint8Array(64)
  want.set(hexToBytes(address.slice(2)), 0)
  want.set(hexToBytes(nonce), 32)
  return bytesToHex(rd) === bytesToHex(want)
}

export type AttestResult = { ok: true; attested: Attested[] } | { ok: false; why: string }

/** Fetch and check a fresh attestation report. `model` adds the model's own enclave evidence (provider_tee signatures need it). */
export async function attest(doFetch: typeof fetch, base: string, model?: string, nonce = randomBytes(32).toString('hex')): Promise<AttestResult> {
  const u = new URL(`${base.replace(/\/v1\/?$/, '')}/v1/attestation/report`)
  u.searchParams.set('signing_algo', 'ecdsa'); u.searchParams.set('nonce', nonce)
  if (model) { u.searchParams.set('model', model); u.searchParams.set('provider', 'near') }
  let raw: unknown
  try {
    const res = await doFetch(u, { headers: { accept: 'application/json', ...(model ? { 'x-no-aliasing': 'true' } : {}) }, signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { ok: false, why: `the attestation report was refused (${res.status})` }
    raw = await res.json()
  } catch { return { ok: false, why: 'the attestation report could not be fetched' } }
  const r = Report.safeParse(raw)
  if (!r.success) return { ok: false, why: 'the attestation report is not in the documented shape' }
  const attested: Attested[] = []
  const take = (a: z.infer<typeof Attestation>, source: Attested['source']) => {
    if (a.request_nonce.toLowerCase() !== nonce.toLowerCase()) return
    if (!quoteBinds(a.intel_quote, a.signing_address, nonce)) return
    attested.push({ signingAddress: a.signing_address.toLowerCase(), nonce, source })
  }
  take(r.data.gateway_attestation, 'gateway')
  for (const m of r.data.model_attestations ?? []) take(m, 'model')
  if (!attested.some(a => a.source === 'gateway')) return { ok: false, why: 'the gateway quote does not bind its signing key and our nonce' }
  return { ok: true, attested }
}

/** EIP-191 personal_sign recovery: the 0x address that signed `text`, or undefined. */
export function recoverEip191(text: string, signatureHex: string): string | undefined {
  try {
    const sig = hexToBytes(signatureHex.replace(/^0x/, ''))
    if (sig.length !== 65) return undefined
    const v = sig[64]! >= 27 ? sig[64]! - 27 : sig[64]!
    if (v !== 0 && v !== 1) return undefined
    const msg = utf8ToBytes(text)
    const digest = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]))
    const pub = secp256k1.Signature.fromCompact(sig.subarray(0, 64)).addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(false)
    return `0x${bytesToHex(keccak_256(pub.subarray(1)).subarray(12))}`
  } catch { return undefined }
}

const Signature = z.object({ text: z.string(), signature: z.string().regex(/^(0x)?[0-9a-f]{130}$/i), signing_address: z.string().regex(ADDRESS), signing_algo: z.literal('ecdsa'), signature_kind: z.string().optional() })

export type Verdict = { verified: true; signer: string; kind: 'gateway' | 'provider_tee' } | { verified: false; why: string }

/** Pure: is this signature over exactly these bytes, by a key an attestation we checked names? */
export function checkSignature(raw: unknown, request: Uint8Array, response: Uint8Array, model: string, attested: readonly Attested[]): Verdict {
  const s = Signature.safeParse(raw)
  if (!s.success) return { verified: false, why: 'no signature in the documented shape' }
  const req = bytesToHex(sha256(request)), res = bytesToHex(sha256(response))
  const kind = s.data.signature_kind === 'provider_tee' || s.data.text.split(':').length === 3 ? 'provider_tee' : 'gateway'
  const expected = kind === 'gateway' ? `${req}:${res}` : `${model}:${req}:${res}`
  if (s.data.text !== expected) return { verified: false, why: 'the signed text is not the hash of this exact request and answer' }
  const signer = recoverEip191(s.data.text, s.data.signature)
  if (!signer || signer !== s.data.signing_address.toLowerCase()) return { verified: false, why: 'the signature does not recover to the address it claims' }
  const want = attested.filter(a => a.source === (kind === 'gateway' ? 'gateway' : 'model'))
  if (want.filter(a => a.signingAddress === signer).length !== 1) return { verified: false, why: `the signer is not the one key named by the ${kind === 'gateway' ? 'gateway' : 'model'} attestation we checked` }
  return { verified: true, signer, kind }
}

/** Fetch the signature for one completion and check it. */
export async function verifyCompletion(doFetch: typeof fetch, base: string, apiKey: string, chatId: string, request: Uint8Array, response: Uint8Array, model: string, attested: readonly Attested[]): Promise<Verdict> {
  let raw: unknown
  try {
    const u = new URL(`${base.replace(/\/v1\/?$/, '')}/v1/signature/${encodeURIComponent(chatId)}`)
    u.searchParams.set('signing_algo', 'ecdsa'); u.searchParams.set('model', model)
    const r = await doFetch(u, { headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
    if (!r.ok) return { verified: false, why: `the signature was not available (${r.status})` }
    raw = await r.json()
  } catch { return { verified: false, why: 'the signature could not be fetched' } }
  return checkSignature(raw, request, response, model, attested)
}

/** The line under an answer. Says exactly what was checked and what was not. */
export function attestationLine(v: Verdict): string {
  if (!v.verified) return `_NEAR AI Cloud answered this; Tollgate could NOT verify it (${v.why})._`
  return `_Answered inside an Intel TDX enclave on NEAR AI Cloud. Checked: the ${v.kind === 'gateway' ? 'gateway' : 'model'} signature over this exact request and answer recovers to ${v.signer.slice(0, 6)}…${v.signer.slice(-4)}, the key bound in a fresh TDX quote. Not checked here: Intel's signature on that quote._`
}
