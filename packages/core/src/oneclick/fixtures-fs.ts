import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Fixture, FixtureStore } from './fixtures.ts'

/** Fixtures as one JSON file each, so a diff shows exactly which response changed. */
export class FileFixtureStore implements FixtureStore {
  private cache: Map<string, Fixture> | undefined
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }

  private load(): Map<string, Fixture> {
    if (this.cache) return this.cache
    const m = new Map<string, Fixture>()
    try {
      for (const f of readdirSync(this.dir).filter(n => n.endsWith('.json'))) {
        const fx = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Fixture
        m.set(fx.key, fx)
      }
    } catch { /* an empty or missing directory is an empty store */ }
    return (this.cache = m)
  }

  get(key: string) { return this.load().get(key) }

  put(f: Fixture): void {
    mkdirSync(this.dir, { recursive: true })
    const name = `${f.synthetic ? 'synthetic' : 'recorded'}-${f.request.method.toLowerCase()}-${f.request.path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}-${f.key.slice(0, 10)}.json`
    writeFileSync(join(this.dir, name), JSON.stringify(f, null, 2) + '\n')
    this.load().set(f.key, f)
  }
}
