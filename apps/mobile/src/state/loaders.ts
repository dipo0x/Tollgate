import type { Decision, Gateway } from '../api/gateway'

/** Optional extras may fail to an empty list, but a prefetch that was cancelled must stay cancelled, never be stored half-empty. */
const soft = <T,>(p: Promise<T[]>): Promise<T[]> => p.catch((e: { code?: string }) => { if (e?.code === 'yielded') throw e; return [] as T[] })

/**
 * What each screen loads, in one place, so the screen and the prefetch (prefetch.ts) load exactly the same thing under the same key.
 * A screen calls `loaders.x(gw)` with the user-lane client; prefetch calls it with the background-lane client. The approve and
 * freeze screens are deliberately absent: they act on money and always load fresh.
 */
export const loaders = {
  home: async (gw: Gateway) => {
    // What the payment account really holds, so "left to spend" can never show more than exists. Unknown (null) if the chain cannot be read.
    const funds = gw.withdrawals().then(w => (w.enabled && w.available !== undefined ? { available: w.available } : null)).catch((e: { code?: string }) => { if (e?.code === 'yielded') throw e; return null })
    const [status, mandates, approvals, decisions, held] = await Promise.all([gw.status(), gw.mandates(), gw.approvals(), gw.decisions(20), funds])
    return { status, mandates, approvals, decisions, funds: held }
  },
  agents: async (gw: Gateway) => { const [mandates, approvals] = await Promise.all([gw.mandates(), gw.approvals()]); return { mandates, approvals } },
  activity: (gw: Gateway) => gw.decisions(100),
  account: (gw: Gateway) => gw.status(),
  topup: (gw: Gateway) => gw.status(),
  withdraw: (gw: Gateway) => gw.withdrawals(),
  shops: (gw: Gateway) => gw.services(),
  services: (gw: Gateway) => gw.services(),
  jobs: async (gw: Gateway) => ({ jobs: await gw.jobs(), past: await gw.history() }),
  agent: async (gw: Gateway, id: string) => {
    // The list row says who answers this agent (hosted with a brain, or its own program). The gateway keeps the list for 5 s, so this is cheap.
    const [m, decisions, rows] = await Promise.all([gw.mandate(id), gw.decisionsFor(id, 8), soft(gw.mandates())])
    return { ...m, decisions, row: rows.find(r => r.id === id) }
  },
  brains: (gw: Gateway) => gw.brains(),
  chat: async (gw: Gateway, agentId: string) => {
    const [c, approvals, decisions, brains] = await Promise.all([gw.conversation(agentId), soft(gw.approvals()), soft(gw.decisions(100)), gw.brains().catch((e: { code?: string }) => { if (e?.code === 'yielded') throw e; return undefined })])
    const lastRun = [...c.runs].sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0]
    return {
      tasks: c.tasks, agent: c.agentId, sendTo: c.runningMandateId, active: !!c.runningMandateId,
      // Who answers this chat, and whether the owner's computer is answering at all right now (for the "offline" words).
      mode: c.agent?.mode, brain: c.agent?.brain ?? null, hostOnline: brains?.online, detailId: c.runningMandateId ?? lastRun?.id,
      pending: new Set(approvals.filter(a => a.status === 'pending').map(a => a.decisionId)),
      rejected: new Set(approvals.filter(a => a.status === 'rejected').map(a => a.decisionId)),
      decisions: new Map<string, Decision>([...decisions.map(d => [d.decisionId, d] as const), ...approvals.map(a => [a.decisionId, a.decision] as const)]),
    }
  },
}

/** The screen-memory key each loader fills (usePoll's third argument). */
export const keys = {
  agent: (mandateId: string) => `agent:${mandateId}`,
  chat: (agentId: string) => `chat:${agentId}`,
}
