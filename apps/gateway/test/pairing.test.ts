import { describe, expect, it } from 'vitest'
import { lanAddresses, listensOnNetwork } from '../src/network.ts'
import { boot, OPERATOR } from './helpers.ts'

const iface = (address: string, over: Record<string, unknown> = {}) => ({ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, ...over }) as never

describe('lanAddresses: only addresses a phone on the same Wi-Fi can open', () => {
  it('keeps private network addresses, Wi-Fi/Ethernet first', () => {
    expect(lanAddresses({ utun3: [iface('10.8.0.2')], en0: [iface('192.168.1.20')], bridge0: [iface('172.20.0.1')] })).toEqual(['192.168.1.20', '172.20.0.1', '10.8.0.2'])
  })
  it('drops loopback, IPv6, link-local and public addresses (plain http with the key must never point at the internet)', () => {
    expect(lanAddresses({
      lo0: [iface('127.0.0.1', { internal: true })], en0: [iface('fe80::1', { family: 'IPv6' }), iface('169.254.3.4'), iface('8.8.8.8')],
    })).toEqual([])
  })
  it('listensOnNetwork: only a non-loopback bind is reachable from a phone', () => {
    expect(listensOnNetwork('127.0.0.1')).toBe(false)
    expect(listensOnNetwork('localhost')).toBe(false)
    expect(listensOnNetwork('0.0.0.0')).toBe(true)
    expect(listensOnNetwork('192.168.1.20')).toBe(true)
  })
})

describe('GET /v1/pairing', () => {
  it('tells the dashboard where the gateway listens and which Wi-Fi addresses a phone could use', async () => {
    const g = boot({ info: { mode: 'offline', network: { host: '0.0.0.0', port: 8787 } }, lanAddresses: () => ['192.168.1.20'] })
    expect((await g.op('GET', '/v1/pairing')).json).toEqual({ listen: '0.0.0.0', port: 8787, openToNetwork: true, addresses: ['192.168.1.20'] })
  })
  it('says plainly when the gateway only accepts this computer (the default)', async () => {
    const g = boot({ info: { mode: 'offline', network: { host: '127.0.0.1', port: 8787 } }, lanAddresses: () => ['192.168.1.20'] })
    expect((await g.op('GET', '/v1/pairing')).json).toMatchObject({ openToNetwork: false })
  })
  it('is for the owner only: no token or an agent token is refused', async () => {
    const g = boot(); const { token } = await g.setup()
    expect((await g.call('GET', '/v1/pairing', undefined)).status).toBe(401)
    expect((await g.call('GET', '/v1/pairing', token)).status).toBe(403)
    expect((await g.call('GET', '/v1/pairing', OPERATOR)).status).toBe(200)
  })
})
