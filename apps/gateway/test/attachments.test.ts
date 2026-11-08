import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { open, seal } from '../src/attachments.ts'
import { boot, OPERATOR } from './helpers.ts'

const KEY = randomBytes(32)
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(64)])
const upload = (g: ReturnType<typeof boot>, over: Record<string, unknown> = {}) =>
  g.op('POST', '/v1/attachments', { name: 'passport.png', contentType: 'image/png', data: PNG.toString('base64'), ...over })

describe('sealing: what reaches the database is ciphertext', () => {
  it('opens with the right key, and refuses a changed byte or another key', () => {
    const s = seal(KEY, PNG)
    expect(s.data.equals(PNG)).toBe(false)
    expect(open(KEY, s)?.equals(PNG)).toBe(true)
    const tampered = { ...s, data: Buffer.from(s.data) }; tampered.data[0]! ^= 1
    expect(open(KEY, tampered)).toBeUndefined()
    expect(open(randomBytes(32), s)).toBeUndefined()
  })
})

describe('attachments through the gateway', () => {
  it('the owner uploads a photo, sends it with a message, and reads it back unchanged', async () => {
    const g = boot({ attachmentKey: KEY }); const { mandateId } = await g.setup()
    const up = await upload(g)
    expect(up.status).toBe(201)
    const ref = up.json.attachment
    expect(ref).toMatchObject({ name: 'passport.png', contentType: 'image/png', size: PNG.length })
    const t = await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'here is my passport', attachments: [ref.id] })
    expect(t.status).toBe(201)
    expect(t.json.task.messages[0].attachments).toEqual([ref])
    const back = await g.app.request(`/v1/attachments/${ref.id}`, { headers: { authorization: `Bearer ${OPERATOR}` } })
    expect(back.status).toBe(200)
    expect(back.headers.get('content-type')).toBe('image/png')
    expect(back.headers.get('cache-control')).toContain('no-store')
    expect(Buffer.from(await back.arrayBuffer()).equals(PNG)).toBe(true)
  })

  it('a message can be just a photo, but not nothing', async () => {
    const g = boot({ attachmentKey: KEY }); const { mandateId } = await g.setup()
    const ref = (await upload(g)).json.attachment
    expect((await g.op('POST', `/v1/agents/${mandateId}/tasks`, { attachments: [ref.id] })).status).toBe(201)
    expect((await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: '' })).status).toBe(400)
  })

  it('an agent cannot read the owner’s photos, and neither can anyone without a token', async () => {
    const g = boot({ attachmentKey: KEY }); const { token } = await g.setup()
    const ref = (await upload(g)).json.attachment
    expect((await g.call('GET', `/v1/attachments/${ref.id}`, token)).status).toBe(403)
    expect((await g.call('GET', `/v1/attachments/${ref.id}`, undefined)).status).toBe(401)
    expect((await g.call('POST', '/v1/attachments', token, { name: 'x.png', contentType: 'image/png', data: PNG.toString('base64') })).status).toBe(403)
  })

  it('refuses unknown photos on a message, odd file types, and anything when no key is set', async () => {
    const g = boot({ attachmentKey: KEY }); const { mandateId } = await g.setup()
    expect((await g.op('POST', `/v1/agents/${mandateId}/tasks`, { text: 'hi', attachments: ['att_00000000-0000-0000-0000-000000000000'] })).json.error.code).toBe('unknown_attachment')
    expect((await upload(g, { contentType: 'text/html' })).status).toBe(400)
    const off = boot()
    const r = await upload(off)
    expect(r.status).toBe(503)
    expect(r.json.error.code).toBe('attachments_off')
  })

  it('the audit log records that a photo arrived, never its name', async () => {
    const g = boot({ attachmentKey: KEY }); await g.setup()
    await upload(g)
    const log = JSON.stringify((await g.op('GET', '/v1/audit?limit=50')).json)
    expect(log).toContain('attachment.stored')
    expect(log).not.toContain('passport.png')
  })
})
