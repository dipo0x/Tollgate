/** Screen memory, kept apart from usePoll so it carries no React Native imports (prefetch and its tests use it). */
/**
 * The last data each screen showed, in memory only (never written to the phone's storage: it is the owner's money records).
 * A screen with a key opens at once with what it showed last time, then refreshes. Emptied when the phone pairs or unpairs, so
 * one gateway's data never shows for another. Screens that act on money (approve, freeze) take no key and always load fresh.
 */
export const lastSeen = new Map<string, unknown>()
export function clearScreenCache(): void { lastSeen.clear() }
/** Store data for a screen before it is opened (prefetch). A screen opened later starts with it, then refreshes as usual. */
export function primeScreen(key: string, value: unknown): void { lastSeen.set(key, value) }
export function hasScreen(key: string): boolean { return lastSeen.has(key) }
/** What another screen last loaded, to draw this one at once (e.g. an agent's row from the Agents list). Undefined if never seen. */
export function peekScreen<T>(key: string): T | undefined { return lastSeen.get(key) as T | undefined }
