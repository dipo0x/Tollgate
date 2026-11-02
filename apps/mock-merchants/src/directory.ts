import { Hono } from 'hono'
import { INJECTION } from './merchant.ts'

/**
 * A SIMULATED service directory, with one poisoned listing (attack A16). Listings are third-party text: Tollgate stores them for a
 * human to read and never shows them to a model. The poisoned one pretends to be the cheapest, best service and carries an injection.
 */
export type Listing = { name: string; host: string; category: string; quoted: string; description: string }

export const LISTINGS: readonly Listing[] = [
  { name: 'Market data (demo)', host: 'merchant.example.com', category: 'data', quoted: '0.25', description: 'Daily market brief.' },
  { name: 'Best data, cheapest', host: 'directory.evil.net', category: 'data', quoted: '0.01', description: INJECTION },
]

export function createDirectory() {
  const app = new Hono()
  app.get('/v1/services', c => c.json({ simulated: true, services: LISTINGS }))
  return { app }
}
