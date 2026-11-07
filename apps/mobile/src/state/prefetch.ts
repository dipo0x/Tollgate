import { GatewayError, type Gateway } from '../api/gateway'
import { keys, loaders } from './loaders'
import { hasScreen, primeScreen } from './screenMemory'

type Job = { key: string; run: (gw: Gateway) => Promise<unknown> }

/**
 * Load every screen's data in the background as the app opens, so each screen appears at once when tapped.
 *
 * Order: what the owner is most likely to open first. After the agent list arrives, each RUNNING agent's screen and chat are added.
 * Uses the background-lane client (lanes.ts): it never competes with the owner. When the owner taps something, the request in
 * flight here is cancelled ("yielded"); this waits for the owner's request to finish and tries the same item again.
 *
 * A screen already loaded is skipped, unless `refresh` (back in the app after a while): then it is reloaded and replaced in place. Any other error skips that item (the screen loads it itself when opened).
 * Returns how many screens were primed. `stillWanted` lets the caller stop it (unpaired, app closed).
 */
export async function prefetchAll(gw: Gateway, stillWanted: () => boolean = () => true, opts: { refresh?: boolean } = {}): Promise<number> {
  const queue: Job[] = [
    { key: 'home', run: loaders.home },
    { key: 'agents', run: loaders.agents },
    { key: 'activity', run: loaders.activity },
    { key: 'account', run: loaders.account },
    { key: 'topup', run: loaders.topup },
    { key: 'shops', run: loaders.shops },
    { key: 'services', run: loaders.services },
    { key: 'jobs', run: loaders.jobs },
  ]
  let primed = 0, yields = 0
  while (queue.length && stillWanted()) {
    const job = queue[0]!
    if (!opts.refresh && hasScreen(job.key)) { queue.shift(); continue } // on a refresh, stored data is replaced in place
    try {
      const value = await job.run(gw)
      if (!stillWanted()) break
      primeScreen(job.key, value); primed++; yields = 0; queue.shift()
      if (job.key === 'agents') {
        const running = (value as Awaited<ReturnType<typeof loaders.agents>>).mandates.filter(m => m.status === 'active' && !m.parentId)
        for (const m of running) queue.push({ key: keys.agent(m.id), run: g => loaders.agent(g, m.id) }, { key: keys.chat(m.agentId), run: g => loaders.chat(g, m.agentId) })
      }
    } catch (e) {
      // The owner tapped something: the same item again once they are served (at most 5 times, then the screen loads it itself).
      if (e instanceof GatewayError && e.code === 'yielded' && ++yields <= 5) continue
      yields = 0; queue.shift() // a real failure: leave it to the screen
    }
  }
  return primed
}
