/** What the agent can catch. Each carries what the gateway said, so the agent (or a person reading its log) can see WHY. */
export class TollgateError extends Error {
  constructor(message: string) { super(message); this.name = new.target.name }
}

export type CheckSummary = { id: string; name: string; result: string; evidence?: Record<string, unknown> }

/** The gateway refused the payment. `failedCheck` names the check that stopped it (for example C05, the payee changed). */
export class PaymentDenied extends TollgateError {
  readonly decisionId: string
  readonly failedCheck: string | undefined
  readonly reason: string | undefined
  readonly checks: readonly CheckSummary[]
  constructor(d: { decisionId: string; failedCheck?: string; reason?: string; checks?: readonly CheckSummary[] }) {
    super(`payment refused${d.failedCheck ? ` by ${d.failedCheck}` : ''}${d.reason ? ` (${d.reason})` : ''}`)
    this.decisionId = d.decisionId; this.failedCheck = d.failedCheck; this.reason = d.reason; this.checks = d.checks ?? []
  }
}

/** A person has to approve this payment first. Nothing was paid. */
export class ApprovalRequired extends TollgateError {
  readonly decisionId: string
  constructor(decisionId: string, why = 'a human must approve this payment') { super(why); this.decisionId = decisionId }
}

/** The payment was allowed but could not be completed (signing refused, the network failed). `paid` says whether money may have moved. */
export class PaymentFailed extends TollgateError {
  readonly decisionId: string
  readonly stage: 'sign' | 'broadcast' | 'params'
  /** True only once a signed transaction was handed to the network. Before that, no money moved. */
  readonly mayHavePaid: boolean
  constructor(message: string, o: { decisionId: string; stage: PaymentFailed['stage']; mayHavePaid: boolean }) { super(message); this.decisionId = o.decisionId; this.stage = o.stage; this.mayHavePaid = o.mayHavePaid }
}

/** The gateway itself could not be used (unreachable, wrong token, an error). Nothing was paid. */
export class GatewayError extends TollgateError {
  readonly status: number
  readonly code: string | undefined
  constructor(message: string, status: number, code?: string) { super(message); this.status = status; this.code = code }
}
