import { describe, expect, it } from 'vitest'
import { newAlerts, type Seen } from '../src/lib/alerts'

const dec = { decisionId: 'dec_1', mandateId: 'mnd_app', agentId: 'spend-agent', host: '127.0.0.1', purpose: 'bridge brief', amount: '0.206712', currency: 'USDC', decision: 'NEEDS_APPROVAL' as const, checks: [], state: 'awaiting_approval', createdAt: '2026-11-07T20:00:00Z' }
const approval = (status: 'pending' | 'approved') => ({ decisionId: 'dec_1', status, expiresAt: '2026-11-07T21:00:00Z', decision: dec })
const task = (messages: { at: string; from: 'owner' | 'agent'; text: string; decisionId?: string }[]) => ({ id: 'task_1', mandateId: 'mnd_app', status: 'done' as const, createdAt: '2026-11-07T20:00:00Z', updatedAt: '2026-11-07T20:00:00Z', messages })
const fresh = (): Seen => ({ keys: new Set(), since: '2026-11-07T19:59:00Z' })

describe('newAlerts: what deserves a notification', () => {
  it('a payment waiting for you: who, how much, to whom, and a tap opens the Approve screen', () => {
    expect(newAlerts(fresh(), [approval('pending')], [])).toEqual([
      { key: 'approval:dec_1', title: 'Payment waiting for your approval', body: 'spend-agent wants to pay 0.21 USDC to 127.0.0.1 for bridge brief. Tap to review.', url: '/approval/dec_1' },
    ])
  })
  it('an approved or rejected payment raises nothing', () => {
    expect(newAlerts(fresh(), [approval('approved')], [])).toEqual([])
  })
  it('an agent reply opens its chat; your own messages never alert', () => {
    const a = newAlerts(fresh(), [], [{ agentId: 'spend-agent', tasks: [task([{ at: '2026-11-07T20:00:01Z', from: 'owner', text: 'hi' }, { at: '2026-11-07T20:00:05Z', from: 'agent', text: 'Hello! What can I get you?' }])] }])
    expect(a).toEqual([{ key: 'msg:task_1:1', title: 'Your agent replied', body: 'Hello! What can I get you?', url: '/chat/spend-agent' }])
  })
  it('the agent asking for a payment you are already alerted about is not a second alert', () => {
    const a = newAlerts(fresh(), [approval('pending')], [{ agentId: 'spend-agent', tasks: [task([{ at: '2026-11-07T20:00:05Z', from: 'agent', text: 'Approve it in Tollgate.', decisionId: 'dec_1' }])] }])
    expect(a.map(x => x.key)).toEqual(['approval:dec_1'])
  })
  it('nothing is raised twice, and nothing from before the app started watching', () => {
    const seen = fresh(); seen.keys.add('approval:dec_1')
    const old = { agentId: 'spend-agent', tasks: [task([{ at: '2026-11-07T19:00:00Z', from: 'agent', text: 'old news' }])] }
    expect(newAlerts(seen, [approval('pending')], [old])).toEqual([])
  })
  it('a long reply is shortened for the banner', () => {
    const a = newAlerts(fresh(), [], [{ agentId: 'spend-agent', tasks: [task([{ at: '2026-11-07T20:00:05Z', from: 'agent', text: 'x'.repeat(300) }])] }])
    expect(a[0]!.body).toHaveLength(138)
  })
})
