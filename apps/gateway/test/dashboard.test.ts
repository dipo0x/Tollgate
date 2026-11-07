import { Window } from 'happy-dom'
import { describe, expect, it } from 'vitest'
import { AUTO, boot, challenge, OPERATOR, record } from './helpers.ts'

type El = { click(): void; hidden: boolean; textContent: string | null; dispatchEvent(e: unknown): boolean }
const HIRING = { ...AUTO, delegation: { maxDepth: 1 } }

const D1 = '0xdep0000000000000000000000000000000000001'
const INJECT_IMG = '<img src=x onerror="window.__pwned=1">'
const INJECT_SCRIPT = '<script>window.__pwned=1</script>'

describe('the dashboard is served safely', () => {
  it('serves the page and its assets (including the pairing QR encoder) with a strict policy: no inline code, same-origin only, never cached', async () => {
    const g = boot()
    for (const [path, type] of [['/dashboard', 'text/html'], ['/dashboard/app.js', 'text/javascript'], ['/dashboard/app.css', 'text/css'], ['/dashboard/qr.js', 'text/javascript']] as const) {
      const res = await g.app.request(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("default-src 'none'"); expect(csp).toContain("script-src 'self'"); expect(csp).toContain("connect-src 'self'"); expect(csp).toContain("frame-ancestors 'none'")
      expect(csp).not.toContain('unsafe-inline'); expect(csp).not.toContain('unsafe-eval')
      expect(res.headers.get('cache-control')).toBe('no-store'); expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })
  it('the page has no inline script, no inline style and no inline event handler (the policy would block them anyway)', async () => {
    const html = await (await boot().app.request('/dashboard')).text()
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
    expect(html).not.toMatch(/\sstyle\s*=/i)
  })
  it('the page script never builds markup from text: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval', async () => {
    const js = await (await boot().app.request('/dashboard/app.js')).text()
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment', 'DOMParser', "setAttribute('style'", 'cssText', 'localStorage']) expect(js, bad).not.toContain(bad)
  })
  it('the page itself holds no secret, but the data behind it needs the operator token', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: AUTO })
    for (const p of ['/v1/mandates', '/v1/decisions', '/v1/approvals', '/v1/services', '/v1/audit']) {
      expect((await g.call('GET', p, undefined)).status).toBe(401)
      expect((await g.call('GET', p, token)).status).toBe(403) // an agent's token is not the owner's
      expect((await g.call('GET', p, OPERATOR)).status).toBe(200)
    }
  })
  it('lists every mandate with its money, children included', async () => {
    const g = boot(); await g.setup({ mandate: HIRING })
    await g.op('POST', '/v1/mandates/mnd_1/delegate', { id: 'mnd_w', agentId: 'worker', total: '1.00', perPayment: '0.50', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'] })
    const r = (await g.op('GET', '/v1/mandates')).json.mandates as { id: string; parentId?: string; balance: { total: string } }[]
    expect(r.map(m => m.id).sort()).toEqual(['mnd_1', 'mnd_w'])
    expect(r.find(m => m.id === 'mnd_w')).toMatchObject({ parentId: 'mnd_1', balance: { total: '1.000000' } })
  })
})

/** Loads the real page and script into a DOM, with its fetch wired to the in-process gateway. */
async function openDashboard(g: ReturnType<typeof boot>) {
  const html = await (await g.app.request('/dashboard')).text()
  const js = await (await g.app.request('/dashboard/app.js')).text()
  const win = new Window({ url: 'http://localhost:8787/dashboard' })
  win.document.write(html.replace(/<script src="[^"]*"><\/script>/g, '').replace(/<link[^>]*>/, ''))
  ;(win as unknown as { fetch: unknown }).fetch = (u: string, init?: RequestInit) => g.app.request(u, init)
  ;(win as unknown as { confirm: () => boolean }).confirm = () => true
  win.eval(js)
  const $ = (s: string) => win.document.querySelector(s) as unknown as El | null
  const until = async (fn: () => boolean, what: string) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 20)) } throw new Error(`timed out waiting for: ${what}`) }
  const signIn = async (token: string) => { ($('#token') as unknown as { value: string }).value = token; $('#login')!.dispatchEvent(new win.Event('submit', { cancelable: true })) }
  const tab = async (name: string) => {
    const find = () => [...win.document.querySelectorAll('#tabs button')].find(x => (x.textContent ?? '').startsWith(name)) as unknown as El | undefined
    await until(() => !!find(), `the ${name} tab`); find()!.click()
  }
  return { win, $, until, signIn, tab, text: () => win.document.body.textContent ?? '', close: () => win.happyDOM.close() }
}

describe('the dashboard in a browser', () => {
  it('refuses a wrong token and says so, then opens with the right one and shows what the agent did', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: AUTO }); g.oneClick.add(record(D1))
    await g.authorize(token, challenge('c1', D1)); await g.authorize(token, challenge('c2', D1), { host: 'evil.example.org' })
    const d = await openDashboard(g)
    try {
      await d.signIn('not-the-token')
      await d.until(() => (d.$('#loginError')?.textContent ?? '') !== '', 'the refusal message')
      expect(d.$('#view')!.hidden).toBe(true)
      await d.signIn(OPERATOR)
      await d.until(() => d.text().includes('evil.example.org'), 'the decisions table')
      expect(d.text()).toContain('Blocked'); expect(d.text()).toMatch(/Allowed|Paid/); expect(d.text()).toContain('C02') // the check that stopped it
    } finally { await d.close() }
  })

  it('a click on a decision opens a drawer with every one of the twelve checks and its evidence', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: AUTO }); g.oneClick.add(record(D1))
    await g.authorize(token, challenge('c1', D1))
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.tab('Decisions'); await d.until(() => !!d.$('tr.row'), 'a decision row')
      d.$('tr.row')!.click()
      await d.until(() => d.win.document.querySelectorAll('.checks li').length === 12, 'twelve checks')
      expect(d.text()).toContain('Payee binding'); expect(d.text()).toContain('1Click cross-check')
      expect(d.win.document.querySelectorAll('.ribbon i').length).toBeGreaterThanOrEqual(12) // the ribbon shows all twelve at a glance
    } finally { await d.close() }
  })

  it('the overview adds up: spent, held and remaining, how many were paid and blocked, and what stopped them', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: AUTO }); g.oneClick.add(record(D1))
    await g.authorize(token, challenge('c1', D1)); await g.authorize(token, challenge('c2', D1), { host: 'evil.example.org' })
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.until(() => d.text().includes('What stopped payments') && d.text().includes('C02'), 'the overview')
      expect(d.text()).toContain('Budget'); expect(d.text()).toContain('5.00') // the mandate's total, formatted
      expect(d.text()).toContain('0.25') // the allowed payment's hold
      expect(d.text()).toContain('Host in scope') // the name of the check that stopped the attack
    } finally { await d.close() }
  })

  it('HOSTILE TEXT IS TEXT: markup in a purpose, a host, a service name and a listing never becomes an element and never runs', async () => {
    const g = boot(); const { token } = await g.setup({ mandate: AUTO }); g.oneClick.add(record(D1))
    await g.authorize(token, challenge('c1', D1), { purpose: INJECT_IMG })
    await g.authorize(token, challenge('c2', D1), { host: INJECT_IMG + '.example.com' })
    await g.op('POST', '/v1/services', { id: 'svc_x', name: INJECT_IMG, category: 'data', host: 'x.example.net', providerUrl: 'https://x.example.net', pricing: { model: 'per_request', quoted: '0.01', currency: 'USDC' }, paymentRails: [], limits: { maxPerRequest: '1.00', timeoutMs: 8000 }, listingText: INJECT_SCRIPT })
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.until(() => d.text().includes('onerror'), 'the decisions table')
      await d.tab('Services'); await d.until(() => d.text().includes('<script>'), 'the services table')
      expect(d.text()).toContain(INJECT_SCRIPT) // shown to the owner, as text
      expect(d.text()).toContain(INJECT_IMG)
      await d.tab('Audit'); await d.until(() => d.text().includes('Verify the whole chain'), 'the audit view')
      const w = d.win as unknown as { __pwned?: unknown }
      expect(w.__pwned).toBeUndefined()
      expect(d.win.document.querySelectorAll('img').length).toBe(0) // the hostile <img> exists only as visible characters
      expect(d.win.document.querySelectorAll('script').length).toBe(0) // (the page's own script tag was removed for the test; there must be no other)
    } finally { await d.close() }
  })

  it('an approval cannot be decided without a reason; with one, the decision reaches the gateway', async () => {
    const g = boot(); const { token } = await g.setup(); g.oneClick.add(record(D1))
    const a = await g.authorize(token, challenge('c1', D1)); expect(a.json.decision).toBe('NEEDS_APPROVAL')
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.tab('Approvals')
      const findApprove = () => [...d.win.document.querySelectorAll('button')].find(b => b.textContent === 'Approve') as unknown as El | undefined
      await d.until(() => !!findApprove(), 'the approval card')
      const approve = findApprove()!
      approve.click(); await new Promise(r => setTimeout(r, 100))
      expect((await g.op('GET', `/v1/decisions/${a.json.decisionId}`)).json.state).toBe('pending') // no reason, no decision
      ;(d.$('input[aria-label="Reason"]') as unknown as { value: string }).value = 'known supplier'
      approve.click()
      await new Promise(r => setTimeout(r, 200))
      expect((await g.op('GET', `/v1/decisions/${a.json.decisionId}`)).json.state).toBe('allowed')
    } finally { await d.close() }
  })

  it('the kill switch asks first, then freezes the gateway; unfreezing restores it', async () => {
    const g = boot(); await g.setup({ mandate: AUTO })
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.until(() => (d.$('#state')?.textContent ?? '') === 'Running', 'the status')
      d.$('#freeze')!.click()
      await d.until(() => (d.$('#state')?.textContent ?? '').includes('FROZEN'), 'frozen state')
      expect((await g.call('GET', '/healthz', undefined)).json.frozen).toBe(true)
      d.$('#freeze')!.click()
      await d.until(() => (d.$('#state')?.textContent ?? '') === 'Running', 'running state')
      expect((await g.call('GET', '/healthz', undefined)).json.frozen).toBe(false)
    } finally { await d.close() }
  })

  it('declining the kill switch\'s confirmation freezes nothing', async () => {
    const g = boot(); await g.setup({ mandate: AUTO })
    const d = await openDashboard(g)
    try {
      ;(d.win as unknown as { confirm: () => boolean }).confirm = () => false
      await d.signIn(OPERATOR); await d.until(() => (d.$('#state')?.textContent ?? '') === 'Running', 'the status')
      d.$('#freeze')!.click(); await new Promise(r => setTimeout(r, 200))
      expect((await g.call('GET', '/healthz', undefined)).json.frozen).toBe(false)
      expect(d.$('#state')!.textContent).toBe('Running')
    } finally { await d.close() }
  })

  it('the operator token lives in this tab only: it is never written to long-term storage, and the password field is emptied after sign-in', async () => {
    const g = boot(); await g.setup({ mandate: AUTO })
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.until(() => !d.$('#view')!.hidden, 'the dashboard')
      expect(d.win.localStorage.length).toBe(0)
      expect(JSON.stringify([...Object.keys(d.win.localStorage)])).not.toContain('token')
      expect(d.win.sessionStorage.getItem('tg-operator-token')).toBe(OPERATOR)
      expect((d.$('#token') as unknown as { value: string }).value).toBe('')
    } finally { await d.close() }
  })

  it('the audit tab verifies the chain, and signing out forgets the token', async () => {
    const g = boot(); await g.setup({ mandate: AUTO })
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.tab('Audit'); await d.until(() => d.text().includes('Verify the whole chain'), 'the audit view')
      ;[...d.win.document.querySelectorAll('button')].find(b => b.textContent === 'Verify the whole chain')!.click()
      await d.until(() => d.text().includes('The chain verifies'), 'verification result')
      d.$('#signout')!.click()
      expect(d.win.sessionStorage.getItem('tg-operator-token')).toBeNull()
      expect(d.$('#login')!.hidden).toBe(false)
    } finally { await d.close() }
  })

  it('mandates show their money, and a hired worker shows who it was hired under', async () => {
    const g = boot(); await g.setup({ mandate: HIRING })
    await g.op('POST', '/v1/mandates/mnd_1/delegate', { id: 'mnd_w', agentId: 'worker', total: '1.00', perPayment: '0.50', validUntil: '2026-11-08T00:00:00Z', allowedHosts: ['merchant.example.com'] })
    const d = await openDashboard(g)
    try {
      await d.signIn(OPERATOR); await d.tab('Mandates'); await d.until(() => d.text().includes('mnd_w'), 'the mandate cards')
      expect(d.text()).toContain('Hired by'); expect(d.text()).toContain('mnd_1'); expect(d.text()).toContain('remaining')
    } finally { await d.close() }
  })
})
