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
