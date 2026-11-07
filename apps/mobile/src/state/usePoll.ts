import { useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { GatewayError } from '../api/gateway'

/**
 * Keep one piece of gateway data fresh while its screen is on show: load now, then every few seconds, and stop when the
 * screen is left. Errors are kept, not hidden: a screen shows the last good data AND says the gateway is not answering.
 */
export function usePoll<T>(load: () => Promise<T>, everyMs = 5000) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<GatewayError | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const loadRef = useRef(load)
  useEffect(() => { loadRef.current = load }, [load])

  const refresh = useCallback(async () => {
    try {
      const v = await loadRef.current()
      setData(v); setError(undefined)
    } catch (e) {
      setError(e instanceof GatewayError ? e : new GatewayError('Something went wrong. Nothing was done.', 0))
    } finally {
      setLoading(false)
    }
  }, [])

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
