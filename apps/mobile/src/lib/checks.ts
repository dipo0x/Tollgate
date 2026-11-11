import { CHECK_NAME } from './format'

/**
 * Every payment goes through these twelve checks, in this order, and the first one that fails stops it. This is the owner's reading
 * of them, from the gateway's own rules (apps/docs/content/checks.md): what each asks, and what makes it say no.
 * The count is a design fact (C01 to C12), not a setting.
 */
export type CheckInfo = { id: string; name: string; asks: string; blocksWhen: string }

const INFO: Record<string, [string, string]> = {
  C01: ['Is this agent’s rulebook (mandate) active, inside its dates, and is it really this agent?', 'The mandate does not exist, was stopped, has not started or has run out, or the key belongs to another agent.'],
  C02: ['Is this shop one the rulebook allows, and one Tollgate has checked and enabled?', 'The shop’s address is not in the agent’s allowed list, or it is not an enabled, checked shop.'],
  C03: ['Is the bill readable, not expired, and a payment method Tollgate supports?', 'The bill is malformed, expired, or asks to be paid in a way Tollgate does not support.'],
  C04: ['Is the network and the coin allowed, and the same as the budget’s currency?', 'The payment would come from a network or coin the rulebook does not allow.'],
  C05: ['Is the money going to the payee Tollgate already recorded for this shop?', 'The address being paid differs from the one pinned for this shop. A first payment to a new shop waits for you instead.'],
  C06: ['Does an independent record (1Click, or the market) agree with the bill?', 'The independent record is missing, or its amount, coin or refund address differs from the bill. A lookup that errors also blocks.'],
  C07: ['Is the price close to an independent quote, or to the price you negotiated?', 'The price is above what the quote allows, or differs from the deal that was agreed.'],
  C08: ['If the payment fails, does the refund come back to you?', 'The refund address is neither your payment account nor one you pinned.'],
  C09: ['Is there budget left, and are the per-payment and speed limits kept?', 'It is above the per-payment limit, above what is left, or too many payments are happening too fast.'],
  C10: ['Has this exact bill been paid or decided before?', 'The same bill was already paid or already refused, so it cannot be paid twice.'],
  C11: ['Do small warning signs (a new shop, a large share of the limit, odd hours) add up to a risky score?', 'It never blocks on its own. It feeds the next check, which decides what the score means.'],
  C12: ['Does a person need to say yes?', 'It turns an allowed payment into a wait for you: every payment from the phone asks for your Face ID.'],
}

export const CHECKS: CheckInfo[] = Object.keys(CHECK_NAME).sort().map(id => ({ id, name: CHECK_NAME[id]!, asks: INFO[id]?.[0] ?? '', blocksWhen: INFO[id]?.[1] ?? '' }))
