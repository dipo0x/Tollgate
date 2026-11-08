import type { BrainInfo } from './brains.ts'
import type { ChatTurn, Engine } from './claude-agent.ts'
import type { TaskStatus } from './worker.ts'

/**
 * The agent host. Plain idea: the owner's computer is a switchboard. Every agent the owner makes in the app as "hosted" is a chat
 * room; this loop sits at the switchboard, picks up the next unanswered message from ANY of those rooms, hands it to the brain that
 * room uses, and puts the answer back. One loop serves all rooms, so making a new agent in the app needs no new program.
 *
 * It holds ONE key, the runner key, which is not the owner's key: it cannot approve, freeze or create anything. For each message it
 * acts as that one hosted agent (header x-tollgate-mandate) and nothing else, so the agent's budget, shop list and the owner's yes on
 * every payment apply exactly as if the agent had its own key.
 *
 * The money machinery (signer calls, the shop's bill, 1Click) is the caller's: it arrives as `handle`, so this file has no payment
 * code and the tests need no network. Fail closed: a message that cannot be worked is closed as failed, with words, never left "typing".
 */

/** A chat message as the gateway stores it. The agent is told a photo was attached (its kind only), never given the photo. */
export type ChatMsg = { at: string; from: 'owner' | 'agent'; text: string; attachments?: { contentType: string }[] }
export function turnOf(m: ChatMsg): ChatTurn {
  const n = m.attachments?.length ?? 0
  const note = n ? `[The owner attached ${n === 1 ? 'a ' + (m.attachments![0]!.contentType === 'application/pdf' ? 'PDF' : 'photo') : n + ' files'}. You cannot see attachments, and you can never send them anywhere yourself.]` : ''
  return { from: m.from, text: [m.text, note].filter(Boolean).join('\n') || note }
}
/** The message just claimed is always in the history, even if a read lags behind the write. */
export function withTask(h: ChatTurn[], msgs: ChatMsg[]): ChatTurn[] {
  return msgs.map(turnOf).every(m => h.some(t => t.from === m.from && t.text === m.text)) ? h : [...h, ...msgs.map(turnOf)]
}

/** A call to the gateway AS one hosted agent (the runner key plus the agent's mandate id). */
export type AgentCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<{ status: number; json: any }>

export type Job = {
  taskId: string
  mandateId: string
  agentId: string
  /** The brain the owner chose for this agent, or null for "whatever this computer prefers". */
  engine: Engine | null
  messages: ChatMsg[]
  /** The whole chat of this agent's name, oldest first, with the new message included. */
  history: ChatTurn[]
  call: AgentCall
}

export type RunnerOptions = {
  gatewayUrl: string
  runnerToken: string
  engines: Engine[]
  /** What the phone is told about the brains (id, label, detail). */
  brains: BrainInfo[]
  /** Does the work for one message; may take minutes (a payment waits for the owner's yes). Throwing closes the message as failed. */
  handle(job: Job): Promise<TaskStatus>
  pollMs?: number
  helloMs?: number
  /** Agents answered at the same time. One message per agent at a time, so this is how many rooms are busy at once. */
  maxParallel?: number
  log?: (line: string) => void
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

export type Runner = {
  /** Stops taking messages and closes any in progress with an honest note. Resolves when the loop has ended. */
  stop(): Promise<void>
  /** Mandate ids being worked right now. */
  busy(): string[]
  finished: Promise<void>
}

const STOPPED_TEXT = 'The agent was stopped part-way. Check Activity for whether anything was paid.'
const FAILED_TEXT = 'I stopped part-way on this one. If nothing says it was paid, nothing was. Send it again.'

export function startRunner(o: RunnerOptions): Runner {
  const doFetch = o.fetch ?? fetch, sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
  const log = o.log ?? (() => {}), base = o.gatewayUrl.replace(/\/+$/, ''), pollMs = o.pollMs ?? 300, maxParallel = o.maxParallel ?? 4
  let stopping = false
  const running = new Map<string, { taskId: string; call: AgentCall }>() // by mandate id: one message per agent at a time
  const work = new Set<Promise<void>>()

  const raw = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    const res = await doFetch(`${base}${path}`, {
      method, signal: AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${o.runnerToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text(); let json: any; try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json }
  }
  const asAgent = (mandateId: string): AgentCall => (method, path, body) => raw(method, path, { 'x-tollgate-mandate': mandateId }, body)

  async function hello() {
    try {
      const r = await raw('POST', '/v1/runner/hello', {}, { brains: o.brains })
      if (r.status !== 200) log(`runner hello refused (${r.status}): ${r.json?.error?.message ?? ''}`)
    } catch { /* the gateway is down for a moment; the next hello says it again */ }
  }

  async function process(next: { task: { id: string; messages: ChatMsg[] }; mandateId: string; agentId: string; brain: string | null }) {
    const { task, mandateId, agentId, brain } = next
    const call = asAgent(mandateId)
    running.set(mandateId, { taskId: task.id, call })
    // The lease: while a message is open, tell the gateway every 20 s that the agent is still on it. If this process dies, the
    // heartbeats stop and the gateway closes the message after 90 s, so the phone never shows "typing" forever.
    const beat = setInterval(() => { void call('POST', `/v1/tasks/${task.id}/alive`).catch(() => {}) }, 20_000)
    const close = (text: string) => call('POST', `/v1/tasks/${task.id}/reply`, { text, status: 'failed' }).catch(() => {})
    try {
      const engine = brain ? o.engines.find(e => e.id === brain) ?? null : null
      if (brain && !engine) {
        log(`${agentId}: brain "${brain}" is not set up here`)
        await close(`This agent answers with “${brain}”, but that is not set up on your computer. Open the agent in the app and choose another brain. Nothing was paid.`)
        return
      }
      const chat = await call('GET', '/v1/tasks/history?limit=50').catch(() => undefined)
      const past = (chat?.status === 200 ? (chat.json.tasks as { messages: ChatMsg[] }[]) : []).flatMap(t => t.messages).sort((a, b) => a.at.localeCompare(b.at)).slice(-40).map(turnOf)
      log(`${agentId}: working ${task.id}${engine ? ` with ${engine.label}` : ''}`)
      const status = await o.handle({ taskId: task.id, mandateId, agentId, engine, messages: task.messages, history: withTask(past, task.messages), call })
      log(`${agentId}: ${task.id} ${status}`)
    } catch (e) {
      // A throw here must not end the loop with the message still open: close it and keep collecting.
      log(`${agentId}: ${task.id} failed (${(e as Error).message})`)
      await close(FAILED_TEXT)
    } finally {
      clearInterval(beat)
      running.delete(mandateId)
    }
  }

  const finished = (async () => {
    void hello()
    const helloTimer = setInterval(() => { void hello() }, o.helloMs ?? 15_000)
    let down = false
    try {
      while (!stopping) {
        if (running.size >= maxParallel) { await sleep(pollMs); continue }
        let next: Awaited<ReturnType<typeof raw>> | undefined
        try { next = await raw('POST', '/v1/runner/tasks/next', {}, { busy: [...running.keys()] }) } catch { next = undefined }
        if (!next || next.status !== 200) {
          if (!down) log(next ? `runner refused (${next.status}): ${next.json?.error?.message ?? ''}` : 'cannot reach the gateway; trying again')
          down = true
          await sleep(next && next.status !== 200 ? 3000 : 1000)
          continue
        }
        down = false
        if (!next.json.task) { await sleep(pollMs); continue }
        const p = process(next.json as never)
        work.add(p); void p.finally(() => work.delete(p))
      }
    } finally { clearInterval(helloTimer) }
  })()

  return {
    finished,
    busy: () => [...running.keys()],
    async stop() {
      stopping = true
      // Messages cut off mid-way are told so, honestly: each may or may not have been paid, and Activity is the record.
      await Promise.all([...running.values()].map(r => r.call('POST', `/v1/tasks/${r.taskId}/reply`, { text: STOPPED_TEXT, status: 'failed' }).catch(() => {})))
      await finished
    },
  }
}
