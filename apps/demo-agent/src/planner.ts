import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'

/**
 * The agent's brain, when one is switched on (`pnpm demo --llm`). It PROPOSES; Tollgate decides. A model's answer is just another
 * claim the gateway checks: an offer above the mandate's ceiling is refused by the gateway whatever the model says.
 *
 * Defence for attack A16 (prompt injection): the model only ever sees structured numbers and registry fields we generated.
 * No merchant text, no listing description, no page content is ever placed in its prompt.
 */
export const PLANNER_MODEL = process.env['PLANNER_MODEL'] || 'claude-opus-5-5'

const Move = z.object({
  action: z.enum(['accept', 'counter', 'walk']),
  /** Required for a counter: a decimal USDC price with at most 6 places. */
  price: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).nullable(),
  /** One short sentence, shown in the demo so a viewer sees why. */
  reason: z.string().max(240),
})
export type Move = z.infer<typeof Move>

const SYSTEM = [
  'You are the purchasing planner of an AI agent that buys data for its owner.',
  'You receive structured JSON only and answer with the requested JSON. Be brief.',
  'Spend the owner\'s money carefully: prefer the cheapest enabled, verified option that meets the need, and negotiate down when you can.',
  'You never control payments directly: a separate firewall enforces the owner\'s limits on everything you propose.',
].join(' ')

export function plannerAvailable(): boolean { return Boolean(process.env['ANTHROPIC_API_KEY']) }

async function ask<T extends z.ZodType>(schema: T, task: string, data: unknown): Promise<z.infer<T>> {
  const client = new Anthropic()
  const res = await client.beta.messages.parse({
    model: PLANNER_MODEL,
    max_tokens: 2048,
    // Planning a price is a small decision: low effort keeps it fast and cheap.
    output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
    // If the model declines, the API retries on a fallback model inside the same call.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: `${task}\n\nDATA (JSON):\n${JSON.stringify(data)}` }],
  })
  if (res.stop_reason === 'refusal') throw new Error('the planner declined')
  if (!res.parsed_output) throw new Error('the planner returned no usable answer')
  return res.parsed_output as z.infer<T>
}

/** The agent's next move in a price negotiation. */
export async function nextMove(state: { item: string; sellerAsk: string; myLastOffer: string | null; round: number; maxRounds: number; ceiling: string }): Promise<Move> {
  const m = await ask(Move, 'Decide your next move in this price negotiation: accept the seller\'s ask, counter with a price, or walk away. A counter needs a price.', state)
  if (m.action === 'counter' && m.price === null) throw new Error('the planner countered without a price')
  return m
}