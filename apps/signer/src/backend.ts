import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { keccak256, type Hex } from 'viem'

export type UnsignedTx = { chainId: number; to: Hex; data: Hex; value: 0n; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; type: 'eip1559' }

/** The only thing that touches a key. It signs what it is handed; the deciding is done before it, in policy.ts. It never sends anything over a network. */
export interface Backend {
  readonly address: Hex
  signTransaction(tx: UnsignedTx): Promise<{ raw: Hex; hash: Hex }>
}

export function viemBackend(privateKey: Hex): Backend {
  const account = privateKeyToAccount(privateKey)
  return {
    address: account.address,
    async signTransaction(tx) {
      const raw = await account.signTransaction(tx)
      return { raw, hash: keccak256(raw) }
    },
  }
}

const KEY = /^0x[0-9a-fA-F]{64}$/

/** Reads the key from a file that only its owner can read. A key file anyone else can read is refused, not used. */
export function loadKeyFile(path: string): Hex {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${path} is readable by other users (mode ${mode.toString(8)}): run chmod 600 on it`)
  const key = readFileSync(path, 'utf8').trim()
  if (!KEY.test(key)) throw new Error(`${path} does not hold a 0x-prefixed 32-byte hex key`)
  return key as Hex
}

/** Makes a new key file (mode 600) and returns only the PUBLIC address. Refuses to overwrite. */
export function createKeyFile(path: string): Hex {
  if (existsSync(path)) throw new Error(`${path} already exists: not overwriting a key`)
  const key = generatePrivateKey()
  writeFileSync(path, key + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return privateKeyToAccount(key).address
}
