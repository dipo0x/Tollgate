import { decideSpend, type PlannerService } from './spend.ts'
import type { SpendCatalogEntry } from './planner.ts'

/**
 * One task from the owner's phone, worked end to end by the agent.
 *
 * Plain idea: the owner types "buy the settlement cost brief" in the app. The agent picks a shop it is allowed to pay (prices and
 * categories only), asks the shop for a bill, and asks Tollgate to pay it. Tollgate holds it for the owner. The agent tells the
 * owner, in the same chat, what it asked for and waits. Only after the owner's yes is anything signed.
 *
 * Every network call is in `io`, so this file has no keys, no URLs and no money: the live script (e2e/src/live-app.ts) wires the
 * real ones, the tests wire fakes. Fail closed: any surprise ends the task as failed with nothing signed.
 */

export type TaskStatus = 'working' | 'done' | 'failed'
export type Challenge = { id: string; amount: string; recipient: string; expires: string; [k: string]: unknown }
/** What a blocked payment says: the check in plain words, and the reason its own evidence gives (for example the network it used and the ones allowed). */
export function blockedWhy(d: Pick<Decision, 'failedCheck' | 'reason' | 'checks'>): string {
  const failed = d.checks?.find(c => c.id === d.failedCheck && c.result === 'fail')
  const ev = (failed?.evidence ?? {}) as { reason?: string; got?: unknown; allowed?: unknown }
  const why = d.reason ?? ev.reason
  const detail = ev.got !== undefined ? ` (it used ${JSON.stringify(ev.got)}${ev.allowed !== undefined ? `; allowed: ${JSON.stringify(ev.allowed)}` : ''})` : ''
  return `“${CHECK_PLAIN[d.failedCheck ?? ''] ?? 'a check'}” failed${why ? `: ${why}` : ''}${detail}`
}
export type Decision = { decision: 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL'; decisionId: string; failedCheck?: string; reason?: string; checks?: { id: string; name: string; result: string; evidence?: unknown }[]; bind?: { to: string; amount: string } }

export type WorkerIO = {
  reply(text: string, opts?: { status?: TaskStatus; decisionId?: string }): Promise<void>
  catalog(): Promise<PlannerService[]>
  /** What is left on this agent's mandate, in dollars. */
  remaining(): Promise<number>
  /** What the signer's account holds, in USDC micro-units and yoctoNEAR. */
  funds(): Promise<{ usdcMicro: bigint; nearYocto: bigint }>
  /** Ask the shop for a bill (its 402). With a deal, the shop bills the agreed price. */
  bill(serviceId: string, deal?: Deal): Promise<Challenge>
  /** With a negotiation id, Tollgate holds the shop to the agreed price, asset and payee (a bill that differs is refused at C07). */
  authorize(serviceHost: string, challenge: Challenge, purpose: string, negotiationId?: string): Promise<Decision>
  /**
   * Haggle with a shop that negotiates (the reference seller does; market sellers have one fixed price). Code works out the legal
   * moves and the gateway enforces the owner's ceiling and round limit. Absent when no shop here negotiates.
   */
  negotiate?(shopId: string): Promise<HaggleOutcome>
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
  /** Search the NEAR AI Agent Market. Structured fields only: never a seller's own description (A16). */
  marketSearch?(q: { category?: string | undefined; keyword?: string | undefined }): Promise<MarketSeller[]>
  /** Hire a seller found by marketSearch: registered as a shop on the spot (price and payee from the market), then marketBuy. */
  marketHire?(handle: string, task: string): Promise<BuyOutcome>
  /** The jobs the owner registered for this agent to earn from: what is sold, the price, and the account that must receive the money. */
  earnJobs?(): Promise<EarnJob[]>
  /** A customer paid. Tollgate checks the transaction on the NEAR network itself and credits revenue only if it matches the job. */
  earnClaim?(jobId: string, txHash: string, from: string): Promise<EarnResult>
  sleep(ms: number): Promise<void>
  now(): number
}

export type EarnJob = { id: string; goal: string; price: string; currency: string; receivingAddress: string; earned: string }
export type EarnResult = { credited: true; amount: string; txHash: string; from: string } | { credited: false; reason: string; detail: string }

/** An agreed price: the gateway's record of the deal, plus the seller's signed token that proves it to the seller. */
export type Deal = { negotiationId: string; token: string; price: string }
export type HaggleOutcome =
  | { outcome: 'agreed'; deal: Deal; ask: string; rounds: string[] }
  | { outcome: 'no_deal'; why: string; rounds: string[] }

export type WorkerLimits = { allowedHosts: string[]; perPayment: number; reserve: number; useLlm: boolean; approvalWaitMs: number; settleTries: number }

/** USDC has 6 decimals; 1Click's deposit runs a few percent above the quote, so ask for 5% headroom before requesting a bill. */
const micro = (usd: number) => BigInt(Math.round(usd * 1e6))
// A payment is two token calls (register the recipient, then transfer). NEAR holds the gas for both, plus the 0.00125 NEAR registration
// deposit, out of the balance before it runs. Measured on mainnet: a rejected payment needed 0.0630 NEAR. 0.065 leaves a little room.
const MIN_GAS_YOCTO = 65n * 10n ** 21n // 0.065 NEAR
const usd = (m: bigint) => (Number(m) / 1e6).toFixed(2)
/** The same plain names the app shows (apps/mobile/src/lib/format.ts CHECK_NAME). */
export const CHECK_PLAIN: Record<string, string> = {
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

export type MarketSeller = { handle: string; category: string; priceUsdc: string | null; deliveredJobs: number }

export type BuyOutcome = { outcome: 'paid' | 'not_paid'; text: string; decisionId?: string; amount?: string; tx?: string }

/**
 * Pay one shop through Tollgate: money check, bill, the twelve checks, the owner's yes, sign, settle, collect.
 * Says the in-between steps in the chat itself (the approval request, the payment); returns how it ended, for the caller to say.
 * The delivered goods go to the owner as their own message and never back to a model (A16).
 */
export async function buy(svc: Pick<SpendCatalogEntry, 'id' | 'host' | 'quotedPrice'>, purpose: string, io: WorkerIO, lim: WorkerLimits, deal?: Deal): Promise<BuyOutcome> {
  const stop = (text: string, decisionId?: string): BuyOutcome => ({ outcome: 'not_paid', text, ...(decisionId ? { decisionId } : {}) })
  const f = await io.funds()
  // With a deal the agreed price is what is asked for; without one, the shop's listed price.
  const need = micro(deal ? Number(deal.price) : svc.quotedPrice) * 105n / 100n
  if (f.usdcMicro < need) return stop(`The payment account holds ${usd(f.usdcMicro)} USDC; this needs about ${usd(need)}. Top it up from Account → Add money. Nothing was paid.`)
  if (f.nearYocto < MIN_GAS_YOCTO) return stop(`The payment account holds ${(Number(f.nearYocto / 10n ** 18n) / 1e6).toFixed(3)} NEAR; a payment needs about 0.065 NEAR up front for network fees. Top it up from Account → Add money. Nothing was paid.`)

  // A cold first 1Click lookup can time out (a DENY): one fresh retry, only for that.
  let ch = await io.bill(svc.id, deal), d = await io.authorize(svc.host, ch, purpose, deal?.negotiationId)
  if (d.decision === 'DENY' && JSON.stringify(d.checks ?? []).includes('timed out')) { ch = await io.bill(svc.id, deal); d = await io.authorize(svc.host, ch, purpose, deal?.negotiationId) }
  if (d.decision === 'DENY') return stop(`Tollgate blocked it: “${CHECK_PLAIN[d.failedCheck ?? ''] ?? 'a check'}” failed${d.reason ? ` (${d.reason})` : ''}. Nothing was paid.`, d.decisionId)
  if (micro(Number(ch.amount)) > f.usdcMicro) return stop(`The shop wants ${ch.amount} USDC; the account holds ${usd(f.usdcMicro)}. Nothing was paid.`, d.decisionId)

  if (d.decision === 'NEEDS_APPROVAL') {
    await io.reply(`I want to pay ${ch.amount} USDC to ${svc.id} for this. Approve it in Tollgate to go ahead.`, { decisionId: d.decisionId })
    const expires = Date.parse(ch.expires)
    const until = Math.min(io.now() + lim.approvalWaitMs, Number.isFinite(expires) ? expires - 30_000 : Infinity)
    while (d.decision === 'NEEDS_APPROVAL' && io.now() < until) { await io.sleep(3000); d = await io.authorize(svc.host, ch, purpose, deal?.negotiationId) }
    if (d.decision === 'NEEDS_APPROVAL') return stop('No answer before the bill expired. Nothing was paid.', d.decisionId)
    if (d.decision !== 'ALLOW') return stop('You said no, so nothing was paid.', d.decisionId)
  }
  if (!d.bind) return stop('Tollgate allowed it but gave no payment details, so I stopped. Nothing was paid.', d.decisionId)

  // 1Click, not this agent, says whether it was paid.
  // Signing and sending are two steps: Tollgate can sign and the broadcast to NEAR can still fail. Say that, with the reason, in the chat
  // (it used to surface only as a generic "stopped part-way"), and let the gateway settle the held money.
  let tx: string
  try { tx = await io.pay(d.decisionId) } catch (e) {
    await io.reconcile(d.decisionId).catch(() => { /* the gateway's own sweeper reconciles later */ })
    return stop(`Tollgate signed the payment, but sending it to NEAR failed (${(e as Error).message}). I could not confirm that it reached the network; check Activity. If it is not listed as paid, no money moved.`, d.decisionId)
  }
  await io.reply(`Paying ${d.bind.amount} USDC. Transaction ${tx.slice(0, 10)}… is on NEAR.`, { decisionId: d.decisionId })
  let status = ''
  for (let i = 0; i < lim.settleTries && !['SUCCESS', 'REFUNDED', 'FAILED'].includes(status); i++) { if (i) await io.sleep(5000); status = await io.settled(d.bind.to) }
  const got = await io.collect(svc.id, ch, tx, d.bind.to)
  await io.reconcile(d.decisionId).catch(() => { /* the gateway's own sweeper reconciles later */ })
  if (status !== 'SUCCESS') return stop(`1Click says the payment is ${status || 'not found'}${status === 'REFUNDED' ? ' (the money went back)' : ''}.`, d.decisionId)
  if (got.status !== 200) return stop(`Paid, but the shop answered ${got.status} instead of delivering. Tollgate cannot stop a shop that takes payment and delivers nothing; this is on your record.`, d.decisionId)
  return { outcome: 'paid', text: `Done. ${got.summary}`, decisionId: d.decisionId, amount: d.bind.amount, tx }
}
