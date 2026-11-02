import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AuditEntry, AuditSink } from './audit.ts'

/** One JSON object per line, appended and never rewritten: the file is the log. */
export class FileAuditSink implements AuditSink {
  private readonly path: string
  constructor(path: string) { this.path = path; mkdirSync(dirname(path), { recursive: true }) }
  write(entry: AuditEntry): void { appendFileSync(this.path, JSON.stringify(entry) + '\n') }
}

export function readAuditFile(path: string): AuditEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim() !== '').map((l, i) => {
    try { return JSON.parse(l) as AuditEntry } catch { throw new Error(`audit file line ${i + 1} is not valid JSON`) }
  })
}
