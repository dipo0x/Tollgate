import { describe, expect, it } from 'vitest'
import { ABANDONED_TEXT } from '../src/gateway.ts'
import { boot, mandateBody, OPERATOR, T0 } from './helpers.ts'

/** The owner tells an agent what to do (phone or dashboard); the agent collects it with its own key and replies. No money moves here. */
describe('tasks: the owner talks to an agent', () => {
  it('owner sends a task, the agent claims it once, replies, and the owner reads the thread', async () => {
    const g = boot(); const { token, mandateId } = await g.setup()
    const made = await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: '  buy the bridge cost brief  ' })
    expect(made.status).toBe(201)
    expect(made.json.task).toMatchObject({ mandateId, status: 'queued', messages: [{ from: 'owner', text: 'buy the bridge cost brief' }] })

    const next = await g.call('POST', '/v1/tasks/next', token)
    expect(next.json.task).toMatchObject({ id: made.json.task.id, status: 'working' })
    expect((await g.call('POST', '/v1/tasks/next', token)).json).toEqual({ task: null }) // claimed once

    expect((await g.call('POST', `/v1/tasks/${made.json.task.id}/reply`, token, { text: 'Asked to pay 0.20 USDC. Waiting for you.', decisionId: 'dec_1' })).status).toBe(200)
    expect((await g.call('POST', `/v1/tasks/${made.json.task.id}/reply`, token, { text: 'Bought it.', status: 'done' })).status).toBe(200)
    const list = await g.op('GET', `/v1/agents/${mandateId}/tasks`)
    expect(list.json.tasks[0].status).toBe('done')
    expect(list.json.tasks[0].messages.map((m: { from: string }) => m.from)).toEqual(['owner', 'agent', 'agent'])
    expect(list.json.tasks[0].messages[1].decisionId).toBe('dec_1')
  })

  it('an agent only ever sees and answers its own tasks', async () => {
    const g = boot(); const a = await g.setup()
    const b = await g.op('POST', '/v1/mandates', mandateBody({ id: 'mnd_2', agentId: 'agent-2' }))
    const tokenB = b.json.agentToken as string
    const t = await g.op('POST', `/v1/agents/${a.mandateId}/tasks`, { text: 'for agent one only' })
    expect((await g.call('POST', '/v1/tasks/next', tokenB)).json).toEqual({ task: null })
    expect((await g.call('POST', `/v1/tasks/${t.json.task.id}/reply`, tokenB, { text: 'mine now', status: 'done' })).status).toBe(404)
    expect((await g.call('POST', '/v1/tasks/next', a.token)).json.task.id).toBe(t.json.task.id)
  })

  it('only the owner gives tasks and reads them; only an agent collects them', async () => {
    const g = boot(); const { token, mandateId } = await g.setup()
    expect((await g.call('POST', `/v1/agents/${mandateId}/tasks`, token, { text: 'pay yourself' })).status).toBe(403)
    expect((await g.call('GET', `/v1/agents/${mandateId}/tasks`, token)).status).toBe(403)
    expect((await g.call('POST', `/v1/agents/${mandateId}/tasks`, undefined, { text: 'x' })).status).toBe(401)
    expect((await g.call('POST', '/v1/tasks/next', OPERATOR)).status).toBe(403)
  })

  it('refuses an empty or oversized task, an unknown agent, and extra fields', async () => {
    const g = boot(); const { mandateId } = await g.setup()
    expect((await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: '   ' })).status).toBe(400)
    expect((await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'x'.repeat(501) })).status).toBe(400)
    expect((await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'ok', amount: '5' })).status).toBe(400)
    expect((await g.op('POST', '/v1/agents/mnd_nope/tasks', { text: 'ok' })).status).toBe(404)
  })

  it('writes the task to the audit chain without the words', async () => {
    const g = boot(); const { mandateId } = await g.setup()
    await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'secret plan' })
    const audit = await g.op('GET', '/v1/audit?limit=50')
    const s = JSON.stringify(audit.json)
    expect(s).toContain('task.created')
    expect(s).not.toContain('secret plan')
  })

  it('a message to a run that has ended is refused with the reason, never queued forever', async () => {
    const g = boot(); const { mandateId } = await g.setup()
    await g.op('POST', `/v1/mandates/${mandateId}/revoke`)
    const r = await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'hello?' })
    expect(r.status).toBe(409)
    expect(r.json.error.code).toBe('agent_ended')
  })

  it('one conversation per agent name: the chat carries on across runs, and new messages go to the running run', async () => {
    const g = boot(); await g.setup({ mandate: { id: 'mnd_run1', agentId: 'spend-agent' } })
    await g.op('POST', '/v1/agents/mnd_run1/tasks', { text: 'first run' })
    await g.op('POST', '/v1/mandates/mnd_run1/revoke') // that run ends
    let c = await g.op('GET', '/v1/conversations/spend-agent')
    expect(c.json).toMatchObject({ runningMandateId: null })
    expect(c.json.tasks.map((t: { messages: { text: string }[] }) => t.messages[0]!.text)).toEqual(['first run']) // history kept
    await g.op('POST', '/v1/mandates', mandateBody({ id: 'mnd_run2', agentId: 'spend-agent' })) // a new run, same name
    c = await g.op('GET', '/v1/conversations/spend-agent')
    expect(c.json.runningMandateId).toBe('mnd_run2')
    g.setNow(new Date(T0.getTime() + 60_000)) // a minute later
    await g.op('POST', '/v1/agents/mnd_run2/tasks', { text: 'second run' })
    c = await g.op('GET', '/v1/conversations/spend-agent')
    expect(c.json.tasks.map((t: { messages: { text: string }[] }) => t.messages[0]!.text)).toEqual(['second run', 'first run'])
    expect((await g.op('GET', '/v1/conversations/nobody')).status).toBe(404)
  })
  it('a task its agent went silent on is closed as failed, so the phone never shows "typing" forever', async () => {
    const g = boot(); const { token, mandateId } = await g.setup()
    const t = (await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'hj' })).json.task
    await g.call('POST', '/v1/tasks/next', token) // claimed: working
    const at = (ms: number) => g.setNow(new Date(T0.getTime() + ms))
    at(60_000) // a heartbeat inside the 90 s lease keeps it open
    expect((await g.call('POST', `/v1/tasks/${t.id}/alive`, token)).status).toBe(200)
    at(140_000) // 80 s after that heartbeat: still inside the lease
    expect((await g.op('GET', `/v1/agents/${mandateId}/tasks`)).json.tasks[0].status).toBe('working')
    at(151_000) // 91 s of silence: the agent has stopped
    const c = await g.op('GET', '/v1/conversations/agent-1')
    expect(c.json.tasks[0]).toMatchObject({ status: 'failed' })
    expect(c.json.tasks[0].messages.at(-1)).toMatchObject({ from: 'agent', text: ABANDONED_TEXT })
    expect((await g.call('POST', `/v1/tasks/${t.id}/alive`, token)).status).toBe(404) // a closed task cannot be revived by a heartbeat
    expect(JSON.stringify((await g.op('GET', '/v1/audit?limit=50')).json)).toContain('task.abandoned')
  })

  it('a queued task is never closed as abandoned (nobody claimed it), and only an agent may send a heartbeat for its own task', async () => {
    const g = boot(); const a = await g.setup()
    const b = await g.op('POST', '/v1/mandates', mandateBody({ id: 'mnd_2', agentId: 'agent-2' }))
    const t = (await g.op('POST', `/v1/agents/${a.mandateId}/tasks`, { text: 'later' })).json.task
    g.setNow(new Date(T0.getTime() + 3_600_000))
    expect((await g.op('GET', `/v1/agents/${a.mandateId}/tasks`)).json.tasks[0].status).toBe('queued')
    await g.call('POST', '/v1/tasks/next', a.token)
    expect((await g.call('POST', `/v1/tasks/${t.id}/alive`, b.json.agentToken as string)).status).toBe(404)
    expect((await g.call('POST', `/v1/tasks/${t.id}/alive`, OPERATOR)).status).toBe(403)
  })
})
