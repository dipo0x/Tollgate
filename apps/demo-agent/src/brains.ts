import { z } from 'zod'
import { aiProblem, askClaude, askOllama, CHAT_MODEL, OLLAMA_CHAT_MODEL, promisesAction, SYSTEM, toMessages, type ChatTurn, type Engine, type ToolSpec } from './claude-agent.ts'
import { attest, attestationLine, verifyCompletion, type Verdict } from './nearai-verify.ts'

/**
 * Brains: who thinks for a hosted agent. Plain idea: an agent in the app is a chat room; the owner picks who answers it, the way you
 * pick a contact. Claude, Grok, a model on this computer, or any server that speaks the common "chat completions" language (that is
 * most of them: OpenAI, xAI's Grok, NEAR AI Cloud, LM Studio, vLLM, llama.cpp, Ollama's /v1...).
 *
 * Keys and addresses live ONLY in this computer's environment (.env). The phone and the gateway see an id and a label, nothing else.
 * A brain is a speaker, not a wallet: it gets the same three or five tools as any other and cannot pay by itself.
 */
export type BrainSpec =
  | { id: string; label: string; kind: 'claude'; model: string }
  | { id: string; label: string; kind: 'ollama'; url: string; model: string }
  | { id: string; label: string; kind: 'openai'; baseUrl: string; model: string; apiKey?: string; /** NEAR AI Cloud: check each answer's TEE signature (nearai-verify.ts). */ verify?: 'nearai' }

export type BrainInfo = { id: string; label: string; detail: string }

const Custom = z.array(z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(40),
  baseUrl: z.url(),
  model: z.string().min(1).max(100),
  /** The NAME of an environment variable that holds the key, so this JSON never contains a secret. Leave out for a local server with no key. */
  keyEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
})).max(8)

const PRESET_IDS = new Set(['claude', 'ollama', 'grok', 'openai', 'near'])

/**
 * Which brains this computer can run, from its environment. Pure: `ollama` says whether Ollama answered, because that needs the network.
 *   claude  ANTHROPIC_API_KEY            model AGENT_MODEL
 *   ollama  (running on this computer)   model AGENT_OLLAMA_MODEL
 *   grok    XAI_API_KEY                  model XAI_MODEL (default grok-4)
 *   openai  OPENAI_API_KEY               model OPENAI_MODEL (default gpt-4o-mini)
 *   near    NEARAI_API_KEY + NEARAI_MODEL (NEAR AI Cloud; no default model, because the catalogue changes)
 *   custom  AGENT_BRAINS='[{"id":"mine","label":"My agent","baseUrl":"http://localhost:8000/v1","model":"m","keyEnv":"MINE_KEY"}]'
 * `notes` explains, in one line each, anything that was set but could not be used.
 */
export function loadBrains(env: Record<string, string | undefined>, opts: { ollama: boolean }): { specs: BrainSpec[]; notes: string[] } {
  const specs: BrainSpec[] = [], notes: string[] = []
  const has = (k: string) => Boolean(env[k]?.trim())
  if (has('ANTHROPIC_API_KEY')) specs.push({ id: 'claude', label: 'Claude', kind: 'claude', model: env['AGENT_MODEL']?.trim() || CHAT_MODEL })
  if (opts.ollama) specs.push({ id: 'ollama', label: 'Local model', kind: 'ollama', url: (env['OLLAMA_URL']?.trim() || 'http://127.0.0.1:11434').replace(/\/+$/, ''), model: env['AGENT_OLLAMA_MODEL']?.trim() || env['PLANNER_MODEL']?.trim() || OLLAMA_CHAT_MODEL })
  if (has('XAI_API_KEY')) specs.push({ id: 'grok', label: 'Grok', kind: 'openai', baseUrl: 'https://api.x.ai/v1', model: env['XAI_MODEL']?.trim() || 'grok-4', apiKey: env['XAI_API_KEY']!.trim() })
  if (has('OPENAI_API_KEY')) specs.push({ id: 'openai', label: 'ChatGPT', kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: env['OPENAI_MODEL']?.trim() || 'gpt-4o-mini', apiKey: env['OPENAI_API_KEY']!.trim() })
  if (has('NEARAI_API_KEY')) {
    if (has('NEARAI_MODEL')) specs.push({ id: 'near', label: 'NEAR AI', kind: 'openai', baseUrl: (env['NEARAI_BASE_URL']?.trim() || 'https://cloud-api.near.ai/v1').replace(/\/+$/, ''), model: env['NEARAI_MODEL']!.trim(), apiKey: env['NEARAI_API_KEY']!.trim(), verify: 'nearai' })
    else notes.push('NEARAI_API_KEY is set but NEARAI_MODEL is not: NEAR AI is off until you name the model to use.')
  }
  const raw = env['AGENT_BRAINS']?.trim()
  if (raw) {
    let json: unknown
    try { json = JSON.parse(raw) } catch { notes.push('AGENT_BRAINS is not valid JSON: your own agents are off.') }
    const parsed = json === undefined ? undefined : Custom.safeParse(json)
    if (parsed && !parsed.success) notes.push(`AGENT_BRAINS is not right (${parsed.error.issues[0]?.path.join('.') || 'list'}: ${parsed.error.issues[0]?.message}): your own agents are off.`)
    if (parsed?.success) {
      for (const c of parsed.data) {
        if (PRESET_IDS.has(c.id) || specs.some(s => s.id === c.id)) { notes.push(`AGENT_BRAINS: "${c.id}" is already taken. Pick another id.`); continue }
        const key = c.keyEnv ? env[c.keyEnv]?.trim() : undefined
        if (c.keyEnv && !key) { notes.push(`AGENT_BRAINS: "${c.id}" needs ${c.keyEnv} in .env, and it is empty.`); continue }
        specs.push({ id: c.id, label: c.label, kind: 'openai', baseUrl: c.baseUrl.replace(/\/+$/, ''), model: c.model, ...(key ? { apiKey: key } : {}) })
      }
    }
  }
  return { specs, notes }
}

/** What the phone is told: id, label and a short detail. Never a key, never a path or a query from an address. */
export function describeBrains(specs: readonly BrainSpec[]): BrainInfo[] {
  return specs.map(s => {
    const where = s.kind === 'claude' ? 'Anthropic' : hostOf(s.kind === 'ollama' ? s.url : s.baseUrl)
    return { id: s.id, label: s.label, detail: `${s.model} · ${s.kind === 'ollama' ? 'on this computer' : where}`.slice(0, 80) }
  })
}

const hostOf = (u: string) => { try { return new URL(u).host } catch { return 'unknown address' } }

export function engineFor(spec: BrainSpec, fetchImpl: typeof fetch = fetch): Engine {
  if (spec.kind === 'claude') {
    return { id: spec.id, label: spec.label, ask: a => askClaude(a.history, a.tools, { model: spec.model }, a.context), explain: aiProblem }
  }
  if (spec.kind === 'ollama') {
    return {
      id: spec.id, label: spec.label,
      ask: async a => ({ text: await askOllama(a.history, a.tools, { ollama: { url: spec.url, model: spec.model, fetch: fetchImpl } }, a.context) }),
      explain: e => `I can’t think right now: ${spec.label} on your computer did not answer (${(e as Error).message}).`,
    }
  }
  return {
    id: spec.id, label: spec.label,
    ask: async a => ({ text: await askOpenAI(spec, a.history, a.tools, a.context, fetchImpl) }),
    explain: e => (e instanceof BrainError ? e.plain : `I stopped: ${spec.label} gave an answer I could not use.`),
  }
}

/** A failure of an OpenAI-compatible brain, already in words the owner can act on. */
export class BrainError extends Error {
  readonly plain: string
  constructor(plain: string) { super(plain); this.plain = plain }
}

/** What each failure means for the owner. The server's own message is never shown: it can echo the request. */
export function openAIProblem(label: string, model: string, status: number): string {
  if (status === 401 || status === 403) return `I can’t think right now: ${label} refused the key in .env on your computer. Check the key, then restart pnpm live:app.`
  if (status === 404) return `I can’t think right now: ${label} has no model called "${model}". Fix the model name in .env on your computer.`
  if (status === 402) return `I can’t think right now: the ${label} account is out of credit.`
  if (status === 429) return `I’m being rate-limited by ${label} right now. Try again in a minute.`
  if (status >= 500) return `${label} had a problem on its side (${status}). Try again shortly.`
  return `${label} refused my request (${status}). Check pnpm live:app on your computer for details.`
}

const ROUND_MS = 60_000
type OAIMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]; tool_call_id?: string }
type OAIReply = { choices?: { message?: { content?: string | { text?: string }[] | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string | object } }[] } }[] }

/**
 * The agent on any OpenAI-compatible server: its tool calling, at most six rounds, the same tools and the same one-purchase rule
 * (the tools enforce it, not the brain). Sends only the chat, the system prompt and structured shop fields: never a shop's own text.
 */
export async function askOpenAI(spec: Extract<BrainSpec, { kind: 'openai' }>, history: readonly ChatTurn[], tools: ToolSpec[], context: string, doFetch: typeof fetch = fetch): Promise<string> {
  const messages: OAIMessage[] = [{ role: 'system', content: context ? `${SYSTEM}\n\n${context}` : SYSTEM }, ...toMessages(history).map(m => ({ role: m.role, content: m.content as string }))]
  const defs = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: z.toJSONSchema(t.schema) } }))
  let nudged = false, capName: 'max_tokens' | 'max_completion_tokens' = 'max_tokens'
  const url = `${spec.baseUrl}/chat/completions`
  for (let round = 0; round < 6; round++) {
    let res: Response, sentBody = ''
    const send = () => { sentBody = JSON.stringify({ model: spec.model, messages, tools: defs, [capName]: 700 }); return doFetch(url, {
      method: 'POST', signal: AbortSignal.timeout(ROUND_MS),
      // identity: the signature covers the exact response bytes, so they must arrive as sent
      headers: { 'content-type': 'application/json', ...(spec.verify ? { 'accept-encoding': 'identity' } : {}), ...(spec.apiKey ? { authorization: `Bearer ${spec.apiKey}` } : {}) },
      body: sentBody,
    }) }
    try {
      res = await send()
      // Newer models take a different name for the length cap. Say so once and retry, instead of failing the owner's message.
      if (res.status === 400 && capName === 'max_tokens' && /max_completion_tokens/.test(await res.clone().text().catch(() => ''))) { capName = 'max_completion_tokens'; res = await send() }
    } catch {
      throw new BrainError(`I can’t reach ${spec.label} at ${hostOf(spec.baseUrl)}. Is it running, and is this computer online?`)
    }
    if (!res.ok) throw new BrainError(openAIProblem(spec.label, spec.model, res.status))
    const raw = await res.text().catch(() => '')
    const reply = (safeJson(raw) ?? {}) as OAIReply & { id?: string }
    const msg = reply.choices?.[0]?.message
    if (!msg) throw new BrainError(`${spec.label} sent no answer.`)
    const text = typeof msg.content === 'string' ? msg.content : Array.isArray(msg.content) ? msg.content.map(p => p.text ?? '').join('') : ''
    const calls = (msg.tool_calls ?? []).flatMap(c => c.function?.name ? [{ id: c.id ?? `call_${round}_${c.function.name}`, name: c.function.name, args: c.function.arguments }] : [])
    if (calls.length === 0) {
      // A model sometimes ANNOUNCES an action instead of calling the tool. Send it back once to do it.
      if (!nudged && promisesAction(text)) {
        nudged = true
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'You said you would do that but did not call a tool. Call the tool now. Do not ask the owner first.' })
        continue
      }
      if (!spec.verify || !spec.apiKey) return text.trim()
      const v = typeof reply.id === 'string' ? await nearAiVerdict(spec, doFetch, reply.id, sentBody, raw) : { verified: false as const, why: 'the answer had no id to fetch its signature by' }
      return `${text.trim()}\n\n${attestationLine(v)}`
    }
    messages.push({ role: 'assistant', content: text || null, tool_calls: calls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) } })) })
    for (const c of calls) {
      const tool = tools.find(t => t.name === c.name)
      const args = typeof c.args === 'string' ? safeJson(c.args) : c.args
      const out = tool ? await tool.run((args ?? {}) as Record<string, unknown>) : JSON.stringify({ error: `no tool ${c.name}` })
      messages.push({ role: 'tool', tool_call_id: c.id, content: out })
    }
  }
  return 'I went round in circles on that one. Could you say it another way?'
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s) } catch { return {} } }

/** One fresh attestation (with the model's own evidence when NEAR AI has it, else the gateway's), then this answer's signature. */
async function nearAiVerdict(spec: Extract<BrainSpec, { kind: 'openai' }>, doFetch: typeof fetch, chatId: string, request: string, response: string): Promise<Verdict> {
  let a = await attest(doFetch, spec.baseUrl, spec.model)
  if (!a.ok) a = await attest(doFetch, spec.baseUrl)
  if (!a.ok) return { verified: false, why: a.why }
  const enc = new TextEncoder()
  return verifyCompletion(doFetch, spec.baseUrl, spec.apiKey ?? '', chatId, enc.encode(request), enc.encode(response), spec.model, a.attested)
}
