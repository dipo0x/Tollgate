import { createHash } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { KeyPair, keyToImplicitAddress, PublicKey, type KeyPairString } from '@near-js/crypto'
import { actionCreators, buildDelegateAction, createTransaction, encodeDelegateAction, encodeSignedDelegate, Signature, SignedDelegate, SignedTransaction, encodeTransaction, type DelegateAction, type Transaction } from '@near-js/transactions'
import { baseDecode, baseEncode } from '@near-js/utils'

/**
 * Paying FROM NEAR. The agent's money sits in a NEAR account; a payment is a NEP-141 `ft_transfer` of USDC on NEAR to the
 * deposit address 1Click issued. Everything in the transaction comes from the STORED decision
 * and from constants here. The caller supplies only the access-key nonce and a recent block hash.
 */

/** Native USDC on NEAR mainnet (1Click lists it as nep141:<this>). Listed here so no request can name its own token. */
export const NEAR_USDC: NearToken = { contract: '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', decimals: 6 }
export const NEAR_CHAIN = 'near'

/** Fixed by the signer, never by the caller: 30 Tgas per call is ample for both calls. Unused gas is refunded by the protocol. */
export const GAS_PER_CALL = 30_000_000_000_000n
/**
 * NEP-145: an account must be registered with a token contract before it can hold the token. A fresh 1Click deposit address
 * may not be. `storage_deposit` with registration_only registers it if needed and refunds the deposit if it already is.
 * 0.00125 NEAR is the registration cost USDC on NEAR asks for.
 */
export const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n
/** `ft_transfer` requires exactly 1 yoctoNEAR attached. This is why a function-call access key cannot make the payment. */
export const ONE_YOCTO = 1n

export type NearToken = { contract: string; decimals: number }
/** What the caller may choose: the access key's next nonce, and a recent block hash (the transaction's expiry anchor). */
export type NearTxParams = { nonce: bigint; blockHash: string }

const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/
export const isNearAccount = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s)

export function validBlockHash(s: string): boolean {
  try { return baseDecode(s).length === 32 } catch { return false }
}

/** The whole transaction: register the recipient with USDC if needed, then transfer. Both calls go to the token contract, so it is one transaction, signed once. */
export function buildTransfer(o: { signerId: string; publicKey: string; token: NearToken; to: string; amount: bigint; tx: NearTxParams }): Transaction {
  const actions = [
    actionCreators.functionCall('storage_deposit', { account_id: o.to, registration_only: true }, GAS_PER_CALL, STORAGE_DEPOSIT_YOCTO),
    actionCreators.functionCall('ft_transfer', { receiver_id: o.to, amount: o.amount.toString() }, GAS_PER_CALL, ONE_YOCTO),
  ]
  return createTransaction(o.signerId, PublicKey.from(o.publicKey), o.token.contract, o.tx.nonce, actions, baseDecode(o.tx.blockHash))
}

/**
 * x402 on NEAR (the NEAR AI Agent Market). The market does not want a transaction: it wants a NEP-366 SIGNED DELEGATE ACTION,
 * which its relayer submits (and pays gas for) only when the hired agent delivers. Everything in it comes
 * from the stored decision and the constants here. The caller supplies only the next access-key nonce and the current block height.
 */
export const X402_CHAIN = 'near:mainnet'
/** The longest a signed payment may stay valid, in blocks (about a day). The signer's own bound, whatever the decision says. */
export const MAX_DELEGATE_TTL_BLOCKS = 100_000n
/** The shortest window worth signing: the market refuses a payment that expires before the job's window anyway. */
export const MIN_DELEGATE_TTL_BLOCKS = 60n
export type NearDelegateParams = { nonce: bigint; blockHeight: bigint }

/**
 * Exactly one action: `ft_transfer` of `amount` USDC to `to`, 1 yoctoNEAR, 30 Tgas. No storage_deposit: the market's treasury is
 * registered with USDC, and the market accepts a payment of exactly this shape only.
 */
export function buildPaymentDelegate(o: { senderId: string; publicKey: string; token: NearToken; to: string; amount: bigint; nonce: bigint; maxBlockHeight: bigint }): DelegateAction {
  return buildDelegateAction({
    senderId: o.senderId, receiverId: o.token.contract, nonce: o.nonce, maxBlockHeight: o.maxBlockHeight, publicKey: PublicKey.from(o.publicKey),
    actions: [actionCreators.functionCall('ft_transfer', { receiver_id: o.to, amount: o.amount.toString() }, GAS_PER_CALL, ONE_YOCTO)],
  })
}

/** The only thing that touches the NEAR key. Signs what it is handed; it never sends anything over a network. */
export interface NearBackend {
  readonly accountId: string
  readonly publicKey: string
  sign(tx: Transaction): { raw: string; hash: string }
  /** NEP-366: signs sha256(NEP-461 prefix ‖ borsh(delegate action)). Returns the borsh SignedDelegate, base64, and the digest. */
  signDelegate(d: DelegateAction): { raw: string; hash: string }
}

/** `accountId` is a named account the key belongs to. Without one, the key's own implicit account (64 hex characters) is used. */
export function nearBackend(secret: string, accountId?: string): NearBackend {
  const kp = KeyPair.fromString(secret as KeyPairString)
  const pub = kp.getPublicKey()
  return {
    accountId: accountId ?? keyToImplicitAddress(pub),
    publicKey: pub.toString(),
    sign(tx) {
      // NEAR signs the sha256 of the borsh-encoded transaction; that same digest, base58, is the transaction hash.
      const digest = new Uint8Array(createHash('sha256').update(encodeTransaction(tx)).digest())
      const { signature } = kp.sign(digest)
      const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: signature }) })
      return { raw: Buffer.from(signed.encode()).toString('base64'), hash: baseEncode(digest) }
    },
    signDelegate(d) {
      // encodeDelegateAction already puts the NEP-461 prefix (2^30 + 366) in front, so this signature can never be replayed
      // as an ordinary transaction signature, and vice versa.
      const digest = new Uint8Array(createHash('sha256').update(encodeDelegateAction(d)).digest())
      const { signature } = kp.sign(digest)
      const signed = new SignedDelegate({ delegateAction: d, signature: new Signature({ keyType: pub.keyType, data: signature }) })
      return { raw: Buffer.from(encodeSignedDelegate(signed)).toString('base64'), hash: baseEncode(digest) }
    },
  }
}

const NEAR_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{40,100}$/

/** Reads an `ed25519:...` secret key from a file only its owner can read. A file anyone else can read is refused, not used. */
export function loadNearKeyFile(path: string): string {
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error(`${path} is readable by other users (mode ${mode.toString(8)}): run chmod 600 on it`)
  const key = readFileSync(path, 'utf8').trim()
  if (!NEAR_KEY.test(key)) throw new Error(`${path} does not hold an ed25519:... NEAR secret key`)
  return key
}

/** Makes a new NEAR key file (mode 600) and returns only PUBLIC values. Refuses to overwrite. */
export function createNearKeyFile(path: string): { accountId: string; publicKey: string } {
  if (existsSync(path)) throw new Error(`${path} already exists: not overwriting a key`)
  const kp = KeyPair.fromRandom('ed25519')
  writeFileSync(path, kp.toString() + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
  return { accountId: keyToImplicitAddress(kp.getPublicKey()), publicKey: kp.getPublicKey().toString() }
}
