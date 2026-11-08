import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Photos and files the owner attaches in the chat are sealed with AES-256-GCM before they reach the database, under a key that
 * lives only in the gateway's .env (GATEWAY_ATTACHMENT_KEY). Someone holding a copy of the database sees ciphertext; a changed
 * byte fails the GCM tag, so a tampered attachment is refused rather than shown.
 */
export const ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'] as const
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

export function seal(key: Buffer, plain: Buffer): { iv: Buffer; tag: Buffer; data: Buffer } {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([c.update(plain), c.final()])
  return { iv, tag: c.getAuthTag(), data }
}

/** Undefined when the bytes were changed or the key is different: never a partly decrypted file. */
export function open(key: Buffer, sealed: { iv: Buffer; tag: Buffer; data: Buffer }): Buffer | undefined {
  try {
    const d = createDecipheriv('aes-256-gcm', key, sealed.iv)
    d.setAuthTag(sealed.tag)
    return Buffer.concat([d.update(sealed.data), d.final()])
  } catch { return undefined }
}

/** GATEWAY_ATTACHMENT_KEY: 32 random bytes, base64. Anything else is refused at boot, never silently weakened. */
export function attachmentKeyFrom(value: string | undefined): Buffer | undefined {
  if (!value) return undefined
  const k = Buffer.from(value, 'base64')
  if (k.length !== 32) throw new Error('GATEWAY_ATTACHMENT_KEY must be 32 random bytes in base64 (make one with: openssl rand -base64 32)')
  return k
}
