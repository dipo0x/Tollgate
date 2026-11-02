import type postgres from 'postgres'
import type { Bind, MandateState, StoredDecision } from './policy.ts'
import type { Claim, SignerStore } from './store.ts'

type Sql = postgres.Sql

/** The signer's own table. A claim row is the proof a decision was used: its primary key and its unique nonce are the "never twice". */
export async function ensureSignerSchema(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS signer_claims (
      decision_id  text PRIMARY KEY,
      nonce        text NOT NULL UNIQUE,
      mandate_id   text NOT NULL,
      chain        text NOT NULL,
      asset        text NOT NULL,
      amount       text NOT NULL,
      to_address   text NOT NULL,
      claimed_at   timestamptz NOT NULL,
      tx_hash      text,
      signer_address text,
      completed_at timestamptz
    )`
}

export class PostgresSignerStore implements SignerStore {
  private readonly sql: Sql
  constructor(sql: Sql) { this.sql = sql }

  async getDecision(id: string): Promise<StoredDecision | undefined> {
    const [r] = await this.sql`SELECT decision_id, mandate_id, decision, state, bind FROM gateway_decisions WHERE decision_id = ${id}`
    if (!r) return undefined
    return { decisionId: r['decision_id'], mandateId: r['mandate_id'], decision: r['decision'], state: r['state'], ...(r['bind'] ? { bind: r['bind'] as Bind } : {}) }
  }

  async mandateState(mandateId: string): Promise<MandateState | undefined> {
    const [r] = await this.sql`SELECT status, spec->>'validUntil' AS valid_until FROM mandates WHERE id = ${mandateId}`
    return r ? { status: r['status'], validUntil: String(r['valid_until']) } : undefined
  }

  async isFrozen(): Promise<boolean> {
    const [r] = await this.sql`SELECT value FROM gateway_settings WHERE key = 'frozen'`
    return r?.['value'] === true
  }

  async claim(c: Claim): Promise<boolean> {
    // ON CONFLICT DO NOTHING covers both unique keys: the decision id and the nonce.
    const r = await this.sql`
      INSERT INTO signer_claims (decision_id, nonce, mandate_id, chain, asset, amount, to_address, claimed_at)
      VALUES (${c.decisionId}, ${c.nonce}, ${c.mandateId}, ${c.chain}, ${c.asset}, ${c.amount}, ${c.to}, ${c.at}::timestamptz)
      ON CONFLICT DO NOTHING RETURNING decision_id`
    return r.length > 0
  }

  async complete(decisionId: string, r: { txHash: string; from: string }): Promise<void> {
    await this.sql`UPDATE signer_claims SET tx_hash = ${r.txHash}, signer_address = ${r.from}, completed_at = now() WHERE decision_id = ${decisionId}`
  }

  async unclaim(decisionId: string): Promise<void> {
    // Only a claim that never produced a signature may be given back.
    await this.sql`DELETE FROM signer_claims WHERE decision_id = ${decisionId} AND tx_hash IS NULL`
  }
}
