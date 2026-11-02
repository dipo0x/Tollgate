import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('the README\'s promise', () => {
  it('the protect-an-agent example is 15 lines or fewer (PRD F12)', () => {
    const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
    const block = /```ts\n([\s\S]*?)```/.exec(md)?.[1] ?? ''
    const lines = block.split('\n').filter(l => l.trim() !== '' && !l.trim().startsWith('//'))
    expect(lines.length).toBeGreaterThan(3)
    expect(lines.length).toBeLessThanOrEqual(15)
  })
})
