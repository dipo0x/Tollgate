import { describe, expect, it } from 'vitest'
import type { TaskT } from '../src/api/gateway'
import { presenceOf, STALLED_MS, UNANSWERED_MS } from '../src/lib/presence'

const T0 = Date.parse('2026-11-07T21:15:00.000Z')
const task = (status: TaskT['status'], updatedMsAgo: number, createdMsAgo = updatedMsAgo): TaskT => ({
  id: 't1', mandateId: 'm1', status, createdAt: new Date(T0 - createdMsAgo).toISOString(), updatedAt: new Date(T0 - updatedMsAgo).toISOString(), messages: [],
})

describe('presenceOf: the typing dots never run forever', () => {
  it('a working task with a recent word or heartbeat is thinking', () => {
    expect(presenceOf([task('working', 5_000)], T0).presence).toBe('thinking')
  })
  it('a working task silent past the limit is stalled, not typing (the bug: an agent killed mid-answer)', () => {
    expect(presenceOf([task('working', STALLED_MS + 1)], T0).presence).toBe('stalled')
    expect(presenceOf([task('working', 30 * 60_000)], T0).presence).toBe('stalled')
  })
  it('a queued task nobody collected is offline after the short limit', () => {
    expect(presenceOf([task('queued', 1_000)], T0).presence).toBe('thinking')
    expect(presenceOf([task('queued', UNANSWERED_MS + 1)], T0).presence).toBe('offline')
  })
  it('a time that does not parse counts as old, never as typing', () => {
    expect(presenceOf([{ ...task('working', 0), updatedAt: 'not a date' }], T0).presence).toBe('stalled')
  })
  it('done and failed tasks leave the agent online', () => {
    expect(presenceOf([task('done', 0), task('failed', 0)], T0)).toEqual({ presence: 'online', waiting: undefined })
  })
  it('a message queued behind a live working one is busy, not offline (the agent answers one at a time)', () => {
    const queued = { ...task('queued', 60_000), id: 't2' }
    expect(presenceOf([queued, task('working', 5_000)], T0).presence).toBe('busy')
    expect(presenceOf([task('working', 5_000), queued], T0).presence).toBe('busy')
  })
  it('a queued message behind a working one that went silent is still stalled', () => {
    expect(presenceOf([{ ...task('queued', 60_000), id: 't2' }, task('working', STALLED_MS + 1)], T0).presence).toBe('stalled')
  })
})
