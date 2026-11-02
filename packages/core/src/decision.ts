export type CheckId =
  | 'C01' | 'C02' | 'C03' | 'C04' | 'C05' | 'C06'
  | 'C07' | 'C08' | 'C09' | 'C10' | 'C11' | 'C12'

export type CheckResult = {
  id: CheckId
  name: string
  result: 'pass' | 'warn' | 'fail'
  evidence: Record<string, unknown>
}

export type Verdict = 'ALLOW' | 'DENY' | 'NEEDS_APPROVAL'

export type Evaluation = {
  decision: Verdict
  checks: CheckResult[]
  /** First failing check, if any. */
  failedCheck?: CheckId
  /** The soft-signal score from C11, 0-100, when the pipeline got that far. */
  risk?: number
}
