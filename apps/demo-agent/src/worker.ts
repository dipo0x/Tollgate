import { decideSpend, type PlannerService } from './spend.ts'
import type { SpendCatalogEntry } from './planner.ts'

/**
 * One task from the owner's phone, worked end to end by the agent.
 *
 * Plain idea: the owner types "buy the bridge cost brief" in the app. The agent picks a shop it is allowed to pay (prices and
 * categories only), asks the shop for a bill, and asks Tollgate to pay it. Tollgate holds it for the owner. The agent tells the
 * owner, in the same chat, what it asked for and waits. Only after the owner's yes is anything signed.
 *
 * Every network call is in `io`, so this file has no keys, no URLs and no money: the live script (e2e/src/live-app.ts) wires the
 * real ones, the tests wire fakes. Fail closed: any surprise ends the task as failed with nothing signed.
 */

export type TaskStatus = 'working' | 'done' | 'failed'
export type Challenge = { id: string; amount: string; recipient: string; expires: string; [k: string]: unknown }
export type Decision = { decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL'; decisionId: string; failedCheck?: string; reason?: string; checks?: { id: string; name: string; result: string; evidence?: unknown }[]; bind?: { to: string; amount: string } }

export type WorkerIO = {
  reply(text: string, opts?: { status?: TaskStatus; decisionId?: string }): Promise<void>
  catalog(): Promise<PlannerService[]>
  /** What is left on this agent's mandate, in dollars. */
  remaining(): Promise<number>
  /** What the signer's account holds, in USDC micro-units and yoctoNEAR. */
  funds(): Promise<{ usdcMicro: bigint; nearYocto: bigint }>
  /** Ask the shop for a bill (its 402). */
  bill(serviceId: string): Promise<Challenge>
  authorize(serviceHost: string, challenge: Challenge, purpose: string): Promise<Decision>
  /** Sign through Tollgate (the signer rebuilds it from the stored decision) and broadcast. Returns the transaction hash. */
  pay(decisionId: string): Promise<string>
  /** 1Click's word on whether the deposit was paid: SUCCESS, REFUNDED, FAILED, or still pending. */
  settled(depositAddress: string): Promise<string>
  /** Collect what was bought. */
  collect(serviceId: string, challenge: Challenge, txHash: string, depositAddress: string): Promise<{ status: number; summary: string }>
  reconcile(decisionId: string): Promise<void>
  /**
   * Hire a NEAR AI market seller (x402 on NEAR): the seller does the job described in `task`, Tollgate checks the price, the owner
   * approves on the phone, and the market settles only if the seller delivers. Absent when this agent has no market access.
   */
  marketBuy?(shop: { id: string; host: string }, task: string): Promise<BuyOutcome>
  sleep(ms: number): Promise<void>
  now(): number
}

export type WorkerLimits = { allowedHosts: string[]; perPayment: number; reserve: number; useLlm: boolean; approvalWaitMs: number; settleTries: number }

/** USDC has 6 decimals; 1Click's deposit runs a few percent above the quote, so ask for 5% headroom before requesting a bill. */
const micro = (usd: number) => BigInt(Math.round(usd * 1e6))
const MIN_GAS_YOCTO = 10n ** 22n // 0.01 NEAR
const usd = (m: bigint) => (Number(m) / 1e6).toFixed(2)
/** The same plain names the app shows (apps/mobile/src/lib/format.ts CHECK_NAME). */
const CHECK_PLAIN: Record<string, string> = {
  C01: 'Mandate is valid', C02: 'Shop is allowed', C03: 'Request is sane', C04: 'Network and asset allowed', C05: 'Payee matches',
  C06: '1Click agrees', C07: 'Price is fair', C08: 'Refund comes back to you', C09: 'Within budget', C10: 'Not a replay', C11: 'Risk is low', C12: 'Your approval',
}

export async function runTask(text: string, io: WorkerIO, lim: WorkerLimits): Promise<TaskStatus> {
  try {
    // 1. Decide what to buy, from structured registry fields only (A16: no shop text reaches the planner).
    const decision = await decideSpend({ task: text, services: await io.catalog(), allowedHosts: lim.allowedHosts, budget: { remaining: await io.remaining(), reserve: lim.reserve, perPayment: lim.perPayment }, useLlm: lim.useLlm })
    if (decision.outcome === 'skip') { await io.reply(`I didn’t buy anything: ${decision.why}.`, { status: 'done' }); return 'done' }
    const r = await buy(decision.service, text, io, lim)
    await io.reply(r.text, { status: r.outcome === 'paid' ? 'done' : 'failed', ...(r.decisionId ? { decisionId: r.decisionId } : {}) })
    return r.outcome === 'paid' ? 'done' : 'failed'
  } catch (e) {
    await io.reply(`I stopped: ${(e as Error).message}. If nothing says it was paid, nothing was.`, { status: 'failed' }).catch(() => {})
    return 'failed'
  }
}

export type BuyOutcome = { outcome: 'paid' | 'not_paid'; text: string; decisionId?: string; amount?: string; tx?: string }

/**
 * Pay one shop through Tollgate: money check, bill, the twelve checks, the owner's yes, sign, settle, collect.
 * Says the in-between steps in the chat itself (the approval request, the payment); returns how it ended, for the caller to say.
 * The delivered goods go to the owner as their own message and never back to a model (A16).
 */
export async function buy(svc: Pick<SpendCatalogEntry, 'id' | 'host' | 'quotedPrice'>, purpose: string, io: WorkerIO, lim: WorkerLimits): Promise<BuyOutcome> {
  const stop = (text: string, decisionId?: string): BuyOutcome => ({ outcome: 'not_paid', text, ...(decisionId ? { decisionId } : {}) })
  const f = await io.funds()
  const need = micro(svc.quotedPrice) * 105n / 100n
  if (f.usdcMicro < need) return stop(`The payment account holds ${usd(f.usdcMicro)} USDC; this needs about ${usd(need)}. Top it up from Account → Add money. Nothing was paid.`)
  if (f.nearYocto < MIN_GAS_YOCTO) return stop('The payment account needs 0.01 NEAR for network fees. Top it up from Account → Add money. Nothing was paid.')

  // A cold first 1Click lookup can time out (a DENY): one fresh retry, only for that.
  let ch = await io.bill(svc.id), d = await io.authorize(svc.host, ch, purpose)
  if (d.decision === 'DENY' && JSON.stringify(d.checks ?? []).includes('timed out')) { ch = await io.bill(svc.id); d = await io.authorize(svc.host, ch, purpose) }
  if (d.decision === 'DENY') return stop(`Tollgate blocked it: “${CHECK_PLAIN[d.failedCheck ?? ''] ?? 'a check'}” failed${d.reason ? ` (${d.reason})` : ''}. Nothing was paid.`, d.decisionId)
  if (micro(Number(ch.amount)) > f.usdcMicro) return stop(`The shop wants ${ch.amount} USDC; the account holds ${usd(f.usdcMicro)}. Nothing was paid.`, d.decisionId)

  if (d.decision === 'NEEDS_APPROVAL') {
    await io.reply(`I want to pay ${ch.amount} USDC to ${svc.id} for this. Approve it in Tollgate to go ahead.`, { decisionId: d.decisionId })
    const expires = Date.parse(ch.expires)
    const until = Math.min(io.now() + lim.approvalWaitMs, Number.isFinite(expires) ? expires - 30_000 : Infinity)
    while (d.decision === 'NEEDS_APPROVAL' && io.now() < until) { await io.sleep(3000); d = await io.authorize(svc.host, ch, purpose) }
    if (d.decision === 'NEEDS_APPROVAL') return stop('No answer before the bill expired. Nothing was paid.', d.decisionId)
    if (d.decision !== 'ALLOW') return stop('You said no, so nothing was paid.', d.decisionId)
  }
  if (!d.bind) return stop('Tollgate allowed it but gave no payment details, so I stopped. Nothing was paid.', d.decisionId)

  // 1Click, not this agent, says whether it was paid.
  const tx = await io.pay(d.decisionId)
  await io.reply(`Paying ${d.bind.amount} USDC. Transaction ${tx.slice(0, 10)}… is on NEAR.`, { decisionId: d.decisionId })
  let status = ''
  for (let i = 0; i < lim.settleTries && !['SUCCESS', 'REFUNDED', 'FAILED'].includes(status); i++) { if (i) await io.sleep(5000); status = await io.settled(d.bind.to) }
  const got = await io.collect(svc.id, ch, tx, d.bind.to)
  await io.reconcile(d.decisionId).catch(() => { /* the gateway's own sweeper reconciles later */ })
  if (status !== 'SUCCESS') return stop(`1Click says the payment is ${status || 'not found'}${status === 'REFUNDED' ? ' (the money went back)' : ''}.`, d.decisionId)
  if (got.status !== 200) return stop(`Paid, but the shop answered ${got.status} instead of delivering. Tollgate cannot stop a shop that takes payment and delivers nothing; this is on your record.`, d.decisionId)
  return { outcome: 'paid', text: `Done. ${got.summary}`, decisionId: d.decisionId, amount: d.bind.amount, tx }
}
