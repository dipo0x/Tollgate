import { describe, expect, it } from 'vitest'
import { runTask, type Decision, type WorkerIO } from '../src/worker.ts'

const SVC = { id: 'svc_brief', category: 'market_data', host: '127.0.0.1', pricing: { model: 'per_request', quoted: '0.20', currency: 'USDC' }, verification: 'endpoint-checked', enabled: true, health: 'healthy' }
const CH = { id: 'ch1', amount: '0.206712', recipient: 'dep.near', expires: '2026-11-07T12:00:00Z' }
const LIM = { allowedHosts: ['127.0.0.1'], perPayment: 0.25, reserve: 0, useLlm: false, approvalWaitMs: 60_000, settleTries: 3 }
const held: Decision = { decision: 'NEEDS_APPROVAL', decisionId: 'dec_1' }
const allowed: Decision = { decision: 'ALLOW', decisionId: 'dec_1', bind: { to: 'dep.near', amount: '0.206712' } }

/** A fake world: answers in order, records every reply and every payment. */
function world(over: Partial<WorkerIO> & { answers?: Decision[] } = {}) {
  const replies: { text: string; status?: string; decisionId?: string }[] = [], paid: string[] = []
  let t = Date.parse('2026-11-07T11:00:00Z'); const answers = [...(over.answers ?? [held, allowed])]
  const io: WorkerIO = {
    reply: async (text, o) => { replies.push({ text, ...o }) },
    catalog: async () => [SVC], remaining: async () => 1, funds: async () => ({ usdcMicro: 1_000_000n, nearYocto: 10n ** 23n }),
    bill: async () => CH, authorize: async () => answers.length > 1 ? answers.shift()! : answers[0]!,
    pay: async id => { paid.push(id); return '7Hx9abcdef0123' }, settled: async () => 'SUCCESS',
    collect: async () => ({ status: 200, summary: 'Settling 1.00 USDC to a NEAR account through 1Click costs 1.0021 USDC right now.' }),
    reconcile: async () => {}, sleep: async ms => { t += ms }, now: () => t, ...over,
  }
  return { io, replies, paid }
}

describe('runTask: one owner task, worked by the agent', () => {
  it('asks, waits for the owner, pays only after the yes, and reports what it got', async () => {
    const w = world()
    expect(await runTask('buy the settlement cost brief', w.io, LIM)).toBe('done')
    expect(w.replies[0]).toMatchObject({ decisionId: 'dec_1' }); expect(w.replies[0]!.text).toMatch(/Approve it in Tollgate/)
    expect(w.paid).toEqual(['dec_1'])
    expect(w.replies.at(-1)).toMatchObject({ status: 'done' }); expect(w.replies.at(-1)!.text).toMatch(/costs 1\.0021 USDC/)
  })
  it('the owner says no: nothing is signed', async () => {
    const w = world({ answers: [held, { decision: 'DENY', decisionId: 'dec_1', reason: 'rejected by owner' }] })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(w.paid).toEqual([]); expect(w.replies.at(-1)!.text).toMatch(/You said no/)
  })
  it('no answer before the deadline: nothing is signed', async () => {
    const w = world({ answers: [held] })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(w.paid).toEqual([]); expect(w.replies.at(-1)!.text).toMatch(/No answer/)
  })
  it('a check blocks it: the reply names the check in plain words', async () => {
    const w = world({ answers: [{ decision: 'DENY', decisionId: 'dec_2', failedCheck: 'C05' }] })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(w.paid).toEqual([]); expect(w.replies.at(-1)!.text).toContain('Payee matches')
  })
  it('too little money: says so before even asking the shop for a bill', async () => {
    let billed = false
    const w = world({ funds: async () => ({ usdcMicro: 100_000n, nearYocto: 10n ** 23n }), bill: async () => { billed = true; return CH } })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(billed).toBe(false); expect(w.replies.at(-1)!.text).toMatch(/Add money/)
  })
  it('too little NEAR for fees: says so before asking the shop for a bill, with the real amount', async () => {
    let billed = false
    const w = world({ funds: async () => ({ usdcMicro: 1_000_000n, nearYocto: 54_955_363_487_500_000_000_000n }), bill: async () => { billed = true; return CH } })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(billed).toBe(false); expect(w.replies.at(-1)!.text).toMatch(/holds 0\.055 NEAR.*needs about 0\.065 NEAR/)
  })
  it('a shop that takes payment and delivers nothing is reported, not hidden', async () => {
    const w = world({ collect: async () => ({ status: 502, summary: '' }) })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(w.paid).toEqual(['dec_1']); expect(w.replies.at(-1)!.text).toMatch(/delivers nothing/)
  })
  it('signed but not sent: the owner is told why in the chat, and the hold is released', async () => {
    let reconciled = ''
    const w = world({ pay: async () => { throw new Error('send_tx failed: INVALID_TRANSACTION') }, reconcile: async id => { reconciled = id } })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(w.replies.at(-1)!.text).toMatch(/signed the payment, but sending it to NEAR failed \(send_tx failed: INVALID_TRANSACTION\)/)
    expect(reconciled).toBe('dec_1')
  })
  it('nothing payable: replies and does nothing', async () => {
    const w = world({ catalog: async () => [] })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('done')
    expect(w.paid).toEqual([]); expect(w.replies[0]!.text).toMatch(/didn’t buy anything/)
  })
  it('a crash anywhere ends the task as failed, never silently', async () => {
    const w = world({ bill: async () => { throw new Error('merchant down') } })
    expect(await runTask('buy the brief', w.io, LIM)).toBe('failed')
    expect(w.replies.at(-1)).toMatchObject({ status: 'failed' }); expect(w.replies.at(-1)!.text).toMatch(/merchant down/)
  })
})
