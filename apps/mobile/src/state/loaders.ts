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
    const [status, mandates, approvals, decisions] = await Promise.all([gw.status(), gw.mandates(), gw.approvals(), gw.decisions(20)])
    return { status, mandates, approvals, decisions }
  },
  agents: async (gw: Gateway) => { const [mandates, approvals] = await Promise.all([gw.mandates(), gw.approvals()]); return { mandates, approvals } },
  activity: (gw: Gateway) => gw.decisions(100),
  account: (gw: Gateway) => gw.status(),
  topup: (gw: Gateway) => gw.status(),
  shops: (gw: Gateway) => gw.services(),
  services: (gw: Gateway) => gw.services(),
  jobs: async (gw: Gateway) => ({ jobs: await gw.jobs(), past: await gw.history() }),
  agent: async (gw: Gateway, id: string) => {
    const [m, decisions] = await Promise.all([gw.mandate(id), gw.decisionsFor(id, 8)])
    return { ...m, decisions }
  },
  chat: async (gw: Gateway, agentId: string) => {
    const [c, approvals, decisions] = await Promise.all([gw.conversation(agentId), soft(gw.approvals()), soft(gw.decisions(100))])
    return {
      tasks: c.tasks, agent: c.agentId, sendTo: c.runningMandateId, active: !!c.runningMandateId,
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
