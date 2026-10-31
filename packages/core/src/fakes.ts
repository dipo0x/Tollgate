import type { OneClickAdapter, OneClickRecord, OneClickStatusResult, PinStore, QuoteRequest } from './adapters.ts'

/**
 * A scriptable stand-in for 1Click, for tests and the offline benchmark. Because it is
 * only an object, it can also misbehave on demand, which is how the fault-injection tests work.
 */
export class FakeOneClick implements OneClickAdapter {
  private records = new Map<string, unknown>()
  /** What a dry quote returns. Set to anything, including garbage, to test how checks cope. */
  quote: unknown = { amountIn: '0.250000' }
  /** throw: the call rejects. hang: the call never answers. */
  fault: 'none' | 'throw' | 'hang' = 'none'
  calls = { status: 0, dryQuote: 0 }

  /** Registers a record under its deposit address. Pass `unknown` on purpose to store malformed ones. */
  add(record: OneClickRecord | Record<string, unknown>): this {
    this.records.set(String((record as { depositAddress?: unknown }).depositAddress), record)
    return this
  }

  async status(depositAddress: string): Promise<OneClickStatusResult> {
    this.calls.status++
    await this.misbehave()
    const record = this.records.get(depositAddress)
    return record === undefined ? { found: false } : { found: true, record }
  }

  async dryQuote(_req: QuoteRequest): Promise<unknown> {
    this.calls.dryQuote++
    await this.misbehave()
    return this.quote
  }

  private async misbehave(): Promise<void> {
    if (this.fault === 'throw') throw new Error('1Click unavailable')
    if (this.fault === 'hang') await new Promise<never>(() => {})
  }
}

export class InMemoryPins implements PinStore {
  private payees = new Map<string, string>()
  private refunds = new Map<string, string[]>()
  pinPayee(host: string, address: string): this { this.payees.set(host, address); return this }
  pinRefund(host: string, address: string): this { this.refunds.set(host, [...(this.refunds.get(host) ?? []), address]); return this }
  async payee(host: string): Promise<string | undefined> { return this.payees.get(host) }
  async refundTargets(host: string): Promise<readonly string[]> { return this.refunds.get(host) ?? [] }
}
