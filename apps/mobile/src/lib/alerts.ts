import type { Approval, TaskT } from '../api/gateway'
import { money } from './format'

/** What deserves an alert on the phone. Pure, so it is tested without a phone (test/alerts.test.ts). */
export type Alert = { key: string; title: string; body: string; url: string }
export type Conversation = { agentId: string; tasks: readonly TaskT[] }
export type Seen = { keys: Set<string>; since: string }

/**
 * What is new since the last look. A payment waiting for you is one alert; an agent's message is another, except when it is
 * the agent asking for that same payment (the payment alert already says it). Nothing older than `since` is ever raised.
 */
export function newAlerts(seen: Seen, approvals: readonly Approval[], convos: readonly Conversation[]): Alert[] {
  const out: Alert[] = []
  const waiting = approvals.filter(a => a.status === 'pending')
  const waitingIds = new Set(waiting.map(a => a.decisionId))
  for (const a of waiting) {
    const key = `approval:${a.decisionId}`
    if (seen.keys.has(key)) continue
    const d = a.decision
    out.push({ key, title: 'Payment waiting for your approval', body: `${d.agentId} wants to pay ${d.amount ? money(d.amount) : '?'} ${d.currency ?? 'USDC'} to ${d.host}${d.purpose ? ` for ${d.purpose}` : ''}. Tap to review.`, url: `/approval/${encodeURIComponent(a.decisionId)}` })
  }
  for (const c of convos) {
    for (const t of c.tasks) {
      t.messages.forEach((m, i) => {
        const key = `msg:${t.id}:${i}`
        if (m.from !== 'agent' || m.at <= seen.since || seen.keys.has(key)) return
        if (m.decisionId && waitingIds.has(m.decisionId)) return
        out.push({ key, title: 'Your agent replied', body: m.text.length > 140 ? `${m.text.slice(0, 137)}…` : m.text, url: `/chat/${encodeURIComponent(c.agentId)}` })
      })
    }
  }
  return out
}
