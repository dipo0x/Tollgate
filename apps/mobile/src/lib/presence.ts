import type { TaskT } from '../api/gateway'

/** A message nobody has collected for this long means the agent is not running. */
export const UNANSWERED_MS = 20_000
/**
 * A claimed message with no word and no heartbeat for this long means the agent stopped part-way. The gateway closes such a task
 * after 90 s (TASK_LEASE_MS) and says so in the chat; this is the phone's own limit on top, so "typing" can never run forever,
 * even against a gateway that does not close tasks.
 */
export const STALLED_MS = 120_000

export type Presence = 'thinking' | 'busy' | 'offline' | 'stalled' | 'online'

/** What the chat header and the typing dots say, from the gateway's tasks alone. Dots show only for 'thinking'. */
export function presenceOf(tasks: readonly TaskT[], now: number): { presence: Presence; waiting: TaskT | undefined } {
  // An agent answers one message at a time. While it is working on one (often a payment waiting for the owner's yes), a newer message
  // is queued behind it: that is "busy", not "offline". The working task's heartbeat decides whether the agent is alive at all.
  const working = tasks.find(t => t.status === 'working')
  const queued = tasks.find(t => t.status === 'queued')
  const waiting = working ?? queued
  if (!waiting) return { presence: 'online', waiting }
  // Written as "not recent" rather than "old": a time that does not parse (NaN) then counts as old, never as typing.
  if (working) return { presence: !(now - Date.parse(working.updatedAt) <= STALLED_MS) ? 'stalled' : queued ? 'busy' : 'thinking', waiting }
  return { presence: !(now - Date.parse(queued!.createdAt) <= UNANSWERED_MS) ? 'offline' : 'thinking', waiting }
}
