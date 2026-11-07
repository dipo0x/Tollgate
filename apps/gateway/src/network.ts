import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

/**
 * Where can a phone reach this gateway? Pairing a phone needs an address the PHONE can open: never 127.0.0.1 (on a phone that is
 * the phone itself), but this computer's address on the home or office network, like 192.168.1.20.
 *
 * Private IPv4 addresses only (RFC 1918): those are the ones a phone on the same Wi-Fi can reach. Public addresses, VPN tunnels
 * and link-local (169.254.x.x) are left out on purpose: plain http with the owner's key must never be pointed at the internet.
 */
const PRIVATE = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/

/** Interfaces most likely to be the Wi-Fi or Ethernet a phone shares (macOS en0/en1, Linux wlan/eth). Listed first. */
const PREFERRED = /^(en\d|wlan\d|wlp|eth\d|enp)/

export function lanAddresses(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  const rows: { name: string; address: string }[] = []
  for (const [name, list] of Object.entries(ifaces)) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !PRIVATE.test(i.address)) continue
      rows.push({ name, address: i.address })
    }
  }
  rows.sort((a, b) => Number(!PREFERRED.test(a.name)) - Number(!PREFERRED.test(b.name)) || a.name.localeCompare(b.name))
  return [...new Set(rows.map(r => r.address))]
}

/** Does a gateway listening on `host` accept connections from other machines? 127.0.0.1 / localhost / ::1: no. */
export const listensOnNetwork = (host: string): boolean => !['127.0.0.1', 'localhost', '::1'].includes(host)
