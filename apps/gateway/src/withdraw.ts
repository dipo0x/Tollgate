import { randomBytes } from 'node:crypto'
import type { AuditStore } from '@tollgate/core'
import { NearTxFailed, type NearRail } from './near-rpc.ts'
import type { SignerClient } from './signer.ts'

type Out = { status: 200 | 400 | 404 | 409 | 422 | 502 | 503; body: unknown }
const ok = (body: unknown): Out => ({ status: 200, body })
const fail = (status: Out['status'], code: string, message: string): Out => ({ status, body: { error: { code, message } } })
const usdc = (micro: bigint) => `${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, '0')}`

export type WithdrawDeps = {
  signer: SignerClient
  rail: NearRail
  audit: Pick<AuditStore, 'append' | 'tail'>
  /** Runs `fn` while holding a lock shared by every gateway on this database: two withdrawals never run side by side. */
  lock: <T>(key: string, fn: () => Promise<T>) => Promise<T>
  /** USDC (micro) promised to payments that are not settled or released yet. It stays on the account. */
  held: () => Promise<bigint>
  explorer?: (txHash: string) => string
  log?: (event: string, fields: Record<string, unknown>) => void
}

/**
 * Taking the owner's USDC back out of the signer's NEAR account.
 *
 *   owner (phone) → this service → signer (signs; the destination is ITS setting) → NEAR → the owner's own account
 *
 * The owner chooses an amount. Nobody chooses a destination: the signer sends only to SIGNER_WITHDRAW_TO. What stays behind is
 * whatever payments in flight still need. Every step is written to the audit chain, so a withdrawal can always be traced.
 */
export class Withdrawals {
  constructor(private readonly d: WithdrawDeps) {}

  /** What the withdraw screen shows: where from, where to, how much can move. Reads the chain, so it can fail; that is reported, not guessed. */
  async info(): Promise<Out> {
    const near = await this.d.signer.near?.()
    if (!near) return ok({ enabled: false, reason: 'The signer has no NEAR account, so there is nothing to withdraw.' })
    if (!near.withdrawTo) return ok({ enabled: false, from: near.accountId, reason: 'No withdrawal account is set. Set SIGNER_WITHDRAW_TO on the signer, then restart it.' })
    try {
      const [f, held] = await Promise.all([this.d.rail.funds(near.accountId), this.d.held()])
      const avail = f.usdcMicro > held ? f.usdcMicro - held : 0n
      return ok({ enabled: true, from: near.accountId, to: near.withdrawTo, balance: usdc(f.usdcMicro), held: usdc(held), available: usdc(avail), near: (Number(f.nearYocto / 10n ** 18n) / 1e6).toFixed(4) })
    } catch (e) {
      return fail(502, 'chain_unreachable', `Could not read the balance from NEAR (${e instanceof Error ? e.message : 'unknown'}). Nothing was moved.`)
    }
  }

  /** The owner's withdrawals, newest first, from the audit chain. */
  async list(limit = 20): Promise<Out> {
    const rows = (await this.d.audit.tail(400)).filter(e => e.type.startsWith('withdrawal.'))
    const byId = new Map<string, { withdrawalId: string; amount: string; to: string; state: string; at: string; txHash?: string; explorer?: string; note?: string }>()
    for (const e of rows) {
      const p = e.payload as { withdrawalId: string; amount?: string; to?: string; txHash?: string; reason?: string }
      const cur = byId.get(p.withdrawalId) ?? { withdrawalId: p.withdrawalId, amount: p.amount ?? '', to: p.to ?? '', state: 'requested', at: e.ts }
      if (p.amount) cur.amount = p.amount
      if (p.to) cur.to = p.to
      if (p.txHash) { cur.txHash = p.txHash; if (this.d.explorer) cur.explorer = this.d.explorer(p.txHash) }
      cur.state = e.type.slice('withdrawal.'.length)
      if (p.reason) cur.note = p.reason
      byId.set(p.withdrawalId, cur)
    }
    return ok({ withdrawals: [...byId.values()].reverse().slice(0, limit) })
  }

  async create(amountText: string): Promise<Out> {
    const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(amountText)
    const amount = m ? BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0') : 0n
    if (amount <= 0n) return fail(400, 'invalid_amount', 'The amount must be a positive number of USDC with up to 6 decimals.')
    return this.d.lock('withdraw', () => this.run(amount))
  }

  private async run(amount: bigint): Promise<Out> {
    // Never from the memory: the audit record names this destination, so it must be what the signer uses right now.
    const near = await this.d.signer.near?.({ fresh: true })
    if (!near || !this.d.signer.withdraw) return fail(503, 'withdraw_unavailable', 'The signer has no NEAR account, so nothing can be withdrawn.')
    if (!near.withdrawTo) return fail(503, 'withdraw_off', 'No withdrawal account is set. Set SIGNER_WITHDRAW_TO on the signer, then restart it.')
    const text = usdc(amount), id = `wd_${randomBytes(10).toString('hex')}`
    let funds: bigint, held: bigint
    try { [{ usdcMicro: funds }, held] = await Promise.all([this.d.rail.funds(near.accountId), this.d.held()]) } catch (e) {
      return fail(502, 'chain_unreachable', `Could not read the balance from NEAR (${e instanceof Error ? e.message : 'unknown'}). Nothing was moved.`)
    }
    const available = funds > held ? funds - held : 0n
    if (amount > available) {
      return fail(422, 'insufficient_funds', `You asked for ${text} USDC, but only ${usdc(available)} can leave: the account holds ${usdc(funds)} and ${usdc(held)} is set aside for payments in progress.`)
    }
    await this.d.audit.append('withdrawal.requested', { withdrawalId: id, amount: text, to: near.withdrawTo, from: near.accountId })

    let signed: { signedTx: string; txHash: string }
    try {
      const tx = await this.d.rail.txParams(near.accountId, near.publicKey)
      const r = await this.d.signer.withdraw({ withdrawalId: id, amount: text, tx })
      if (r.status !== 200) {
        const e = (r.body as { error?: { code?: string; message?: string } }).error
        await this.d.audit.append('withdrawal.refused', { withdrawalId: id, reason: e?.code ?? `signer ${r.status}` })
        return fail(r.status === 403 ? 422 : 502, e?.code ?? 'signer_refused', `${e?.message ?? 'The signer refused.'} Nothing was moved.`)
      }
      signed = r.body as { signedTx: string; txHash: string }
    } catch (e) {
      await this.d.audit.append('withdrawal.refused', { withdrawalId: id, reason: 'not signed' })
      return fail(502, 'sign_failed', `The withdrawal could not be signed (${e instanceof Error ? e.message : 'unknown'}). Nothing was moved.`)
    }
    await this.d.audit.append('withdrawal.signed', { withdrawalId: id, txHash: signed.txHash })

    // Sending the same signed bytes twice is harmless (the chain knows the hash), so one retry is safe.
    let sent: string | undefined, lastError = ''
    for (let i = 0; i < 2 && !sent; i++) {
      try { sent = await this.d.rail.send(signed.signedTx) } catch (e) {
        lastError = e instanceof Error ? e.message : 'unknown'
        if (e instanceof NearTxFailed) {
          await this.d.audit.append('withdrawal.failed', { withdrawalId: id, txHash: signed.txHash, reason: lastError })
          return fail(502, 'transfer_failed', `${lastError}. Your USDC is still in the account.`)
        }
      }
    }
    if (!sent) {
      await this.d.audit.append('withdrawal.unknown', { withdrawalId: id, txHash: signed.txHash, reason: lastError })
      return fail(502, 'send_unconfirmed', `The transfer was signed but the network did not confirm it (${lastError}). It may or may not have gone through: check the balance before trying again. Transaction ${signed.txHash}.`)
    }
    await this.d.audit.append('withdrawal.sent', { withdrawalId: id, txHash: sent })
    this.d.log?.('withdrawal.sent', { withdrawalId: id, amount: text })
    return ok({ withdrawalId: id, amount: text, to: near.withdrawTo, txHash: sent, ...(this.d.explorer ? { explorer: this.d.explorer(sent) } : {}) })
  }
}
