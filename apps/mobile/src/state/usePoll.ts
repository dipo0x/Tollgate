import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { GatewayError } from '../api/gateway'
import { lastSeen } from './screenMemory'
export { clearScreenCache, hasScreen, peekScreen, primeScreen } from './screenMemory'

/** Failures in a row before a screen that already shows data says the gateway is not answering. One slow answer is not an outage. */
export const FAILS_BEFORE_ERROR = 3


/**
 * Keep one piece of gateway data fresh while its screen is on show: load now, then every few seconds, and stop when the
 * screen is left. Never two loads at once: on a slow gateway, overlapping requests queue up and make it slower still.
 * Errors are kept, not hidden: with nothing to show, the first failure is shown; with data on screen, the last good data
 * stays and the error appears once FAILS_BEFORE_ERROR loads in a row have failed.
 */
export function usePoll<T>(load: () => Promise<T>, everyMs = 5000, key?: string) {
  const [data, setData] = useState<T | undefined>(() => (key ? lastSeen.get(key) as T | undefined : undefined))
  const [error, setError] = useState<GatewayError | undefined>(undefined)
  const [loading, setLoading] = useState(() => !(key && lastSeen.has(key)))
  const loadRef = useRef(load)
  const busy = useRef<Promise<void> | null>(null)
  const fails = useRef(0)
  const hasData = useRef(!!(key && lastSeen.has(key)))
  const keyRef = useRef(key)
  useEffect(() => { keyRef.current = key }, [key])
  const refresh = useCallback(() => {
    if (busy.current) return busy.current // a load is still running: wait for it instead of starting another
    busy.current = (async () => {
      try {
        const v = await loadRef.current()
        fails.current = 0; hasData.current = true
        if (keyRef.current) lastSeen.set(keyRef.current, v)
        setData(v); setError(undefined)
      } catch (e) {
        fails.current += 1
        if (!hasData.current || fails.current >= FAILS_BEFORE_ERROR) setError(e instanceof GatewayError ? e : new GatewayError('Something went wrong. Nothing was done.', 0))
      } finally {
        setLoading(false); busy.current = null
      }
    })()
    return busy.current
  }, [])

  // The loader changes when the phone switches gateway address: load again at once (after any load already running), rather than
  // waiting for the next tick and leaving the screen looking dormant.
  const firstLoad = useRef(true)
  useEffect(() => {
    loadRef.current = load
    if (firstLoad.current) { firstLoad.current = false; return }
    void (busy.current ?? Promise.resolve()).then(() => refresh())
  }, [load, refresh])

  useFocusEffect(useCallback(() => {
    void refresh()
    const t = setInterval(() => void refresh(), everyMs)
    return () => clearInterval(t)
  }, [refresh, everyMs]))

  return { data, error, loading, refresh }
}

/** A clock that ticks every second, for countdowns. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  return now
}
