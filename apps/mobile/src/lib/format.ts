import type { Decision } from '../api/gateway'

/** "0.206712" → { main: "0.20", rest: "6712" }: the big number shows cents, the extra precision sits beside it in grey. */
export function splitAmount(v: string | undefined): { main: string; rest: string } {
  if (!v || !/^\d+(\.\d+)?$/.test(v)) return { main: '—', rest: '' }
  const [whole, frac = ''] = v.split('.')
  const padded = frac.padEnd(2, '0')
  const rest = padded.slice(2).replace(/0+$/, '')
  return { main: `${whole}.${padded.slice(0, 2)}`, rest }
}

/** Two decimals for balances and limits ("5" → "5.00"). Never rounds up money: it cuts. */
export function money(v: string | undefined): string {
  if (!v || !/^\d+(\.\d+)?$/.test(v)) return '—'
  const [whole, frac = ''] = v.split('.')
  return `${whole}.${frac.padEnd(2, '0').slice(0, 2)}`
}

/**
 * A dollar amount typed by the owner ("10", "12.5", "$1,000.00") → a number with at most 2 decimals, or a reason it is not one.
 * USDC is dollars, so cents is the finest step a person types; the gateway still stores it exactly as a decimal string.
 */
export function parseUsd(text: string, max = 1_000_000): { ok: true; value: number } | { ok: false; why: string } {
  const t = text.replace(/[$,\s]/g, '')
  if (t === '') return { ok: false, why: 'Enter an amount.' }
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return { ok: false, why: 'Use a dollar amount like 10 or 12.50.' }
  const value = Number(t)
  if (!(value > 0)) return { ok: false, why: 'The amount must be more than $0.' }
  if (value > max) return { ok: false, why: `Keep it at or under $${max.toLocaleString('en-US')}.` }
  return { ok: true, value }
}

export function shortId(s: string | undefined, head = 6, tail = 4): string {
  if (!s) return '—'
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** "7:42" until the deadline; "expired" after it. */
export function timeLeft(iso: string, now: number): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms)) return '—'
  if (ms <= 0) return 'expired'
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`
}

export function when(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const d = Math.floor((now - t) / 1000)
  if (d < 60) return 'now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export type Kind = 'paid' | 'allowed' | 'waiting' | 'blocked' | 'rejected' | 'expired' | 'released'

/** What a decision means to the owner, in one word. The colour follows from it: green paid, red blocked, white the rest. */
export function kindOf(d: Pick<Decision, 'decision' | 'state'>): Kind {
  if (d.state === 'settled') return 'paid'
  if (d.state === 'rejected') return 'rejected'
  if (d.state === 'expired') return 'expired'
  if (d.state === 'released') return 'released'
  if (d.decision === 'DENY') return 'blocked'
  if (d.decision === 'NEEDS_APPROVAL' || d.state === 'pending') return 'waiting'
  return 'allowed'
}

export const KIND_LABEL: Record<Kind, string> = {
  paid: 'Paid', allowed: 'Allowed', waiting: 'Waiting', blocked: 'Blocked', rejected: 'Rejected', expired: 'Expired', released: 'Not paid',
}

/** Plain names for the twelve checks (C01–C12), as the owner reads them. */
export const CHECK_NAME: Record<string, string> = {
  C01: 'Mandate is valid', C02: 'Shop is allowed', C03: 'Request is sane', C04: 'Network and asset allowed', C05: 'Payee matches',
  C06: '1Click agrees', C07: 'Price is fair', C08: 'Refund comes back to you', C09: 'Within budget', C10: 'Not a replay', C11: 'Risk is low', C12: 'Your approval',
}

export function checkSummary(checks: Decision['checks']): { passed: number; total: number; failed?: string } {
  const failed = checks.find(c => c.result === 'fail')
  return { passed: checks.filter(c => c.result === 'pass').length, total: checks.length, ...(failed ? { failed: failed.id } : {}) }
}

/**
 * Why an agent is or is not running, in the owner's words. "expired" ran out of time (every test run lasts an hour; an agent you
 * add lasts 30 days); "revoked" is one you stopped. Neither can pay again; a new run with the same name continues its conversation.
 */
export function agentState(status: string): { label: string; short: string; running: boolean } {
  if (status === 'active') return { label: 'Running', short: 'Running', running: true }
  if (status === 'revoked') return { label: 'Stopped by you', short: 'Stopped', running: false }
  if (status === 'expired') return { label: 'Ended: ran out of time', short: 'Ended', running: false }
  return { label: status, short: status, running: false }
}

/** Who answers an agent, in the owner's words. */
export function answeredBy(m: { mode?: 'hosted' | 'external' | undefined; brain?: string | null | undefined }): string {
  if (m.mode === 'external') return 'Your own agent'
  if (m.mode === 'hosted') return m.brain ? (BRAIN_NAME[m.brain] ?? m.brain) : 'This computer'
  return 'Your agent'
}
const BRAIN_NAME: Record<string, string> = { claude: 'Claude', ollama: 'Local model', grok: 'Grok', openai: 'ChatGPT', near: 'NEAR AI' }

/** Agents grouped by name: the running runs, and the names with no running run (newest end first), for the Agents tab. */
export function groupAgents<M extends { id: string; agentId: string; status: string; validUntil: string; parentId?: string | undefined; archived?: boolean | undefined }>(rows: readonly M[]) {
  // A name the owner removed from the list stays hidden until a new run of it starts (the gateway then clears the flag).
  const tops = rows.filter(m => !m.parentId && !m.archived)
  const running = tops.filter(m => m.status === 'active')
  const runningNames = new Set(running.map(m => m.agentId))
  const past = new Map<string, M[]>()
  for (const m of tops) if (m.status !== 'active' && !runningNames.has(m.agentId)) past.set(m.agentId, [...(past.get(m.agentId) ?? []), m])
  const ended = [...past.entries()].map(([name, runs]) => {
    const last = [...runs].sort((a, b) => b.validUntil.localeCompare(a.validUntil))[0]!
    return { name, runs: runs.length, last }
  }).sort((a, b) => b.last.validUntil.localeCompare(a.last.validUntil))
  return { running, ended }
}
