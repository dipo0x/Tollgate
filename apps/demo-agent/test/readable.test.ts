import { describe, expect, it } from 'vitest'
import { quickAnswer, readable, type ToolSpec } from '../src/claude-agent.ts'
import { z } from 'zod'

const tool = (name: string, out: unknown): ToolSpec => ({ name, description: name, schema: z.object({}), run: async () => JSON.stringify(out) })
const SHOPS = { shops: [
  { id: 'svc_brief', category: 'market_data', host: '127.0.0.1', price: '0.20', currency: 'USDC' },
  { id: 'svc_market_contract_health_auditor', category: 'dev_tools', host: 'contract-health-auditor.market.near.ai', price: '0.0500', currency: 'USDC' },
] }

describe('what the owner reads in the chat', () => {
  it('"What can you buy for me?" is answered from the shop list, as plain lines, with no model', async () => {
    const out = await quickAnswer('What can you buy for me?', [tool('list_shops', SHOPS)])
    expect(out).toContain('I can pay 2 shops')
    expect(out).toContain('• market data (svc_brief): 0.20 USDC')
    expect(out).toContain('• dev tools (svc_market_contract_health_auditor): 0.05 USDC, NEAR AI Agent Market seller')
    expect(out).not.toMatch(/[{}\[\]"]|```/)
  })
  it('"How much budget is left?" is answered from the budget tool', async () => {
    const out = await quickAnswer('How much budget is left?', [tool('check_budget', { remainingUsdc: '1.00', maxPerPaymentUsdc: '0.25' })])
    expect(out).toBe('You have 1.00 USDC left, and I can pay at most 0.25 at a time. Every payment waits for your yes.')
  })
  it('anything else goes to the model', async () => {
    expect(await quickAnswer('buy the bridge cost brief', [tool('list_shops', SHOPS)])).toBeUndefined()
    expect(await quickAnswer('Can you buy me a flight?', [tool('list_shops', SHOPS)])).toBeUndefined()
  })
  it('a model that pastes JSON anyway gets it turned into plain lines', () => {
    const pasted = 'Sure, let\'s see what\'s available. Here are the shops I can pay for right now:\n\n```json\n[\n    {"id": "svc_brief", "category": "market_data", "host": "127.0.0.1", "price": "0.20", "currency": "USDC"}\n]\n```\n\nWould you like to buy any of these?'
    const out = readable(pasted)
    expect(out).toContain('• market data (svc_brief): 0.20 USDC')
    expect(out).not.toMatch(/```|"id"|[{}]/)
    expect(out).toContain('Would you like to buy any of these?')
  })
  it('a code block that is not a list is dropped rather than shown', () => {
    expect(readable('Done.\n```\nrm -rf /\n```')).toBe('Done.')
  })
})
