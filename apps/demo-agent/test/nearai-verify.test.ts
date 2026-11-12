import { readFileSync } from 'node:fs'
import { secp256k1 } from '@noble/curves/secp256k1'
import { sha256 } from '@noble/hashes/sha2'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'
import { describe, expect, it } from 'vitest'
import { attest, attestationLine, checkSignature, quoteBinds, recoverEip191, reportDataOfQuote, type Attested } from '../src/nearai-verify.ts'

// A REAL report from NEAR AI Cloud's gateway (fetched 12 Nov 2026), with the nonce we sent.
const REAL = JSON.parse(readFileSync(new URL('./fixtures/nearai-attestation.json', import.meta.url), 'utf8'))
const G = REAL.gateway_attestation as { signing_address: string; intel_quote: string; request_nonce: string; report_data: string }
const BASE = 'https://cloud-api.near.ai/v1'
const serving = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

describe('NEAR AI attestation, against a real report', () => {
  it('reads report_data out of the TDX quote bytes, and it is signer + 12 zero bytes + our nonce', () => {
    const rd = reportDataOfQuote(G.intel_quote)!
    expect(bytesToHex(rd)).toBe(G.report_data)
    expect(quoteBinds(G.intel_quote, G.signing_address, G.request_nonce)).toBe(true)
  })

  it('accepts the real report when the nonce is the one we sent', async () => {
    const r = await attest(serving(REAL), BASE, undefined, G.request_nonce)
    expect(r).toEqual({ ok: true, attested: [{ signingAddress: G.signing_address.toLowerCase(), nonce: G.request_nonce, source: 'gateway' }] })
  })

  it('refuses a replayed report (we sent a different nonce)', async () => {
    const r = await attest(serving(REAL), BASE, undefined, 'ab'.repeat(32))
    expect(r.ok).toBe(false)
  })

  it('refuses a report whose JSON names another signer than the quote binds', async () => {
    const forged = { gateway_attestation: { ...REAL.gateway_attestation, signing_address: '0x' + '11'.repeat(20) } }
    expect((await attest(serving(forged), BASE, undefined, G.request_nonce)).ok).toBe(false)
  })

  it('refuses a quote with one byte of report_data changed, and anything that is not a TDX v4 quote', () => {
    const q = G.intel_quote
    const flipped = q.slice(0, 568 * 2) + (q[568 * 2] === '0' ? '1' : '0') + q.slice(568 * 2 + 1)
    expect(quoteBinds(flipped, G.signing_address, G.request_nonce)).toBe(false)
    expect(reportDataOfQuote('05' + q.slice(2))).toBeUndefined() // version 5 is not what this parser knows
    expect(reportDataOfQuote(q.slice(0, 1000))).toBeUndefined()
  })

  it('refuses a refused or malformed report, failing closed', async () => {
    expect((await attest(serving({}, 503), BASE, undefined, G.request_nonce)).ok).toBe(false)
    expect((await attest(serving({ nope: 1 }), BASE, undefined, G.request_nonce)).ok).toBe(false)
  })
})

describe('NEAR AI response signatures (EIP-191)', () => {
  const priv = secp256k1.utils.randomPrivateKey()
  const address = `0x${bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))}`
  const sign = (text: string) => {
    const m = utf8ToBytes(text)
    const d = keccak_256(new Uint8Array([...utf8ToBytes(`\x19Ethereum Signed Message:\n${m.length}`), ...m]))
    const s = secp256k1.sign(d, priv)
    return `0x${bytesToHex(s.toCompactRawBytes())}${(s.recovery + 27).toString(16)}`
  }
  const request = utf8ToBytes('{"model":"m","messages":[]}'), response = utf8ToBytes('{"id":"chat-1","choices":[]}')
  const text = `${bytesToHex(sha256(request))}:${bytesToHex(sha256(response))}`
  const attested: Attested[] = [{ signingAddress: address, nonce: '00', source: 'gateway' }]
  const sig = (over: Record<string, unknown> = {}) => ({ text, signature: sign(text), signing_address: address, signing_algo: 'ecdsa', ...over })

  it('recovers the signer the way Ethereum wallets do', () => {
    expect(recoverEip191(text, sign(text))).toBe(address)
  })

  it('verifies a gateway signature over these exact bytes, by the attested key', () => {
    const v = checkSignature(sig(), request, response, 'm', attested)
    expect(v).toEqual({ verified: true, signer: address, kind: 'gateway' })
    expect(attestationLine(v)).toMatch(/Intel TDX enclave/)
  })

  it('refuses: other bytes, a forged signer claim, an unattested signer, garbage', () => {
    expect(checkSignature(sig(), request, utf8ToBytes('{"id":"chat-1","choices":[1]}'), 'm', attested).verified).toBe(false) // answer changed
    expect(checkSignature(sig({ signing_address: '0x' + '22'.repeat(20) }), request, response, 'm', attested).verified).toBe(false)
    expect(checkSignature(sig(), request, response, 'm', [{ signingAddress: '0x' + '33'.repeat(20), nonce: '00', source: 'gateway' }]).verified).toBe(false)
    expect(checkSignature({ text }, request, response, 'm', attested).verified).toBe(false)
    const v = checkSignature(sig(), request, response, 'm', [])
    expect(v.verified).toBe(false)
    expect(attestationLine(v)).toMatch(/could NOT verify/)
  })
})
