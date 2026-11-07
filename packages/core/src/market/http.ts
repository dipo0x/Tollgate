import type { MarketAdapter, MarketPrice } from '../adapters.ts'
import { isAmount } from '../money.ts'

/**
 * The real NEAR AI Agent Market, over its public API (no key, no account): the market's published payees, and a seller's
 * published default price. Read-only. It never pays anything and never sends anything about the agent.
 *
 * Every answer is still parsed by the checks (MarketRecipientsSchema / MarketPriceSchema); this client only fetches and shapes.
 */
export const MARKET_BASE_URL = 'https://market.near.ai'
export const MARKET_HOST_SUFFIX = '.market.near.ai'
const HANDLE = /^[a-z][a-z0-9-]{2,29}$/

/** `contract-health-auditor.market.near.ai` -> `contract-health-auditor`. Anything else is not a market seller. */
export function handleOf(host: string): string | undefined {
  const h = host.toLowerCase()
  if (!h.endsWith(MARKET_HOST_SUFFIX)) return undefined
  const handle = h.slice(0, -MARKET_HOST_SUFFIX.length)
  return HANDLE.test(handle) ? handle : undefined
}

/** "0.5000" -> "0.5". The market writes prices with 4 decimals; we keep at most 6 and refuse anything else. */
function normalisePrice(p: unknown): string | undefined {
  if (typeof p !== 'string' && typeof p !== 'number') return undefined
  const s = String(p)
  return isAmount(s) ? s : undefined
}

export class HttpMarket implements MarketAdapter {
  private readonly base: string
  private readonly doFetch: typeof fetch
  private readonly timeoutMs: number

  constructor(o: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.base = (o.baseUrl ?? MARKET_BASE_URL).replace(/\/+$/, '')
    this.doFetch = o.fetch ?? fetch
    this.timeoutMs = o.timeoutMs ?? 8000
  }

  private async get(path: string): Promise<{ status: number; json: unknown }> {
    const res = await this.doFetch(`${this.base}${path}`, { headers: { accept: 'application/json', 'user-agent': 'tollgate-gateway' }, signal: AbortSignal.timeout(this.timeoutMs) })
    if (res.status >= 500) throw new Error(`market answered ${res.status}`)
    let json: unknown
    try { json = await res.json() } catch { throw new Error(`market answered ${res.status} with something that is not JSON`) }
    return { status: res.status, json }
  }

  async recipients(): Promise<unknown> {
    const r = await this.get('/.well-known/x402')
    if (r.status !== 200) throw new Error(`market payee list answered ${r.status}`)
    return r.json
  }

  async defaultPrice(host: string): Promise<MarketPrice> {
    const handle = handleOf(host)
    if (!handle) return { found: false }
    const agent = await this.get(`/v1/agents/${handle}`)
    if (agent.status === 404) return { found: false }
    if (agent.status !== 200) throw new Error(`market agent lookup answered ${agent.status}`)
    const a = agent.json as { agent_id?: unknown; handle?: unknown }
    // The agent the market returns must be the one we asked about.
    if (typeof a.agent_id !== 'string' || a.handle !== handle) throw new Error('market returned a different agent than the one asked for')
    const plans = await this.get(`/v1/agents/${encodeURIComponent(a.agent_id)}/pricing-plans`)
    if (plans.status === 404) return { found: false }
    if (plans.status !== 200) throw new Error(`market pricing lookup answered ${plans.status}`)
    const rows = Array.isArray(plans.json) ? plans.json : ((plans.json as { plans?: unknown[] }).plans ?? [])
    const defaults = (rows as { is_default?: unknown; price_amount?: unknown }[]).filter(p => p.is_default === true)
    // Exactly one default plan, or we do not know what the seller charges.
    if (defaults.length !== 1) return { found: false }
    const price = normalisePrice(defaults[0]!.price_amount)
    if (!price) throw new Error('market default price is not a decimal we can read')
    return { found: true, price, currency: 'USD' }
  }
}
