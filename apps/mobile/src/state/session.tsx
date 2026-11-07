import * as LocalAuthentication from 'expo-local-authentication'
import { prefetchAll } from './prefetch'
import { clearScreenCache } from './usePoll'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { AppState } from 'react-native'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { alternatesFrom, checkGatewayUrl, createGateway, GatewayError, type Gateway } from '../api/gateway'

/**
 * Who this phone is paired with, kept in the iOS Keychain (Android Keystore), never in plain storage or logs.
 *
 * The key here is the gateway's operator key until the approver-only key exists (gateway work, phase 2). So the app itself
 * limits what it does with it: read, approve, reject, freeze, add an agent that always needs approval. Approving and unfreezing
 * also need Face ID every time.
 */
const KEY_URL = 'tollgate.gateway.url'
const KEY_TOKEN = 'tollgate.gateway.token'
const KEY_FACE = 'tollgate.faceid.ready'
/** Other addresses of the same gateway (its .local name, Wi-Fi numbers), learned while connected. Not secret; kept beside the URL. */
const KEY_ALT = 'tollgate.gateway.alternates'

type Session = {
  ready: boolean
  paired: boolean
  faceReady: boolean
  url: string | null
  gateway: Gateway | null
  pair: (url: string, token: string) => Promise<void>
  /** Other addresses this gateway reported, to switch to without unpairing. */
  alternates: string[]
  /** Move to another address of the same gateway, keeping the key. Checked with the key first; nothing is saved if it fails. */
  switchTo: (url: string) => Promise<void>
  unpair: () => Promise<void>
  setFaceReady: () => Promise<void>
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [faceReady, setFace] = useState(false)
  const [alternates, setAlternates] = useState<string[]>([])

  useEffect(() => {
    (async () => {
      const [u, t, f, a] = await Promise.all([SecureStore.getItemAsync(KEY_URL), SecureStore.getItemAsync(KEY_TOKEN), SecureStore.getItemAsync(KEY_FACE), SecureStore.getItemAsync(KEY_ALT)])
      setUrl(u); setToken(t); setFace(f === '1'); setAlternates(parseAlternates(a)); setReady(true)
    })().catch(() => setReady(true))
  }, [])

  const pair = useCallback(async (u: string, t: string) => {
    const opts = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
    await SecureStore.setItemAsync(KEY_URL, u, opts)
    await SecureStore.setItemAsync(KEY_TOKEN, t, opts)
    clearScreenCache() // a new gateway: nothing from the old one may show
    setUrl(u); setToken(t)
  }, [])

  const unpair = useCallback(async () => {
    await Promise.all([SecureStore.deleteItemAsync(KEY_URL), SecureStore.deleteItemAsync(KEY_TOKEN), SecureStore.deleteItemAsync(KEY_FACE), SecureStore.deleteItemAsync(KEY_ALT)])
    clearScreenCache()
    setUrl(null); setToken(null); setFace(false); setAlternates([])
  }, [])

  const switchTo = useCallback(async (u: string) => {
    if (!token) throw new GatewayError('This phone is not paired yet.', 0)
    const c = checkGatewayUrl(u)
    if (!c.ok) throw new GatewayError(c.why, 0)
    await createGateway({ baseUrl: c.url, token }).status() // the same key must work there, or nothing changes
    await SecureStore.setItemAsync(KEY_URL, c.url, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
    clearScreenCache()
    setUrl(c.url)
  }, [token])

  const setFaceReady = useCallback(async () => { await SecureStore.setItemAsync(KEY_FACE, '1'); setFace(true) }, [])

  const gateway = useMemo(() => (url && token ? createGateway({ baseUrl: url, token }) : null), [url, token])

  // Prefetch every screen in the background lane as the app opens, and again on returning to it after a minute away (prefetch.ts).
  // A new pairing or unpairing bumps the run number, which stops a run in progress: one gateway's data never lands for another.
  const run = useRef(0)
  const lastRun = useRef(0)
  useEffect(() => {
    if (!url || !token || !faceReady) return
    const background = createGateway({ baseUrl: url, token, lane: 'background' })
    // Learn this gateway's other addresses while it is reachable, for "Change address" later (no unpairing when the network changes).
    void background.pairing().then(info => {
      const alt = alternatesFrom(url, info)
      if (!alt.length) return
      setAlternates(alt)
      void SecureStore.setItemAsync(KEY_ALT, JSON.stringify(alt), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY })
    }, () => {})
    const start = (refresh: boolean) => {
      const me = ++run.current
      lastRun.current = Date.now()
      void prefetchAll(background, () => run.current === me, { refresh }).catch(() => {})
    }
    start(false)
    // Back after a minute or more: refresh what is stored in place (nothing is emptied, so no screen goes blank meanwhile).
    const sub = AppState.addEventListener('change', s => { if (s === 'active' && Date.now() - lastRun.current > 60_000) start(true) })
    return () => { run.current++; sub.remove() }
  }, [url, token, faceReady])
  const value = useMemo<Session>(() => ({ ready, paired: !!gateway, faceReady, url, gateway, pair, unpair, setFaceReady, alternates, switchTo }), [ready, gateway, faceReady, url, pair, unpair, setFaceReady, alternates, switchTo])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Saved alternates, re-checked: anything malformed or unsafe is dropped. */
function parseAlternates(raw: string | null): string[] {
  try { const a = JSON.parse(raw ?? '[]'); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string' && checkGatewayUrl(x).ok) : [] } catch { return [] }
}

export function useSession(): Session {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

/** The gateway client, for screens that only render once paired. */
export function useGateway(): Gateway {
  const g = useSession().gateway
  if (!g) throw new Error('not paired')
  return g
}

// Expo Go has no Face ID permission of its own, so iOS can only ask it for the passcode. A real (development or store) build has it
// (NSFaceIDUsageDescription in app.json), so there we require the face and never offer the passcode.
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient

/**
 * Face ID, for approving and unfreezing. In a real build the passcode is not accepted (a lost phone whose passcode someone has watched
 * you type must not be able to approve a payment). In Expo Go, which cannot do Face ID, the passcode is the only option.
 * Fails closed: no hardware, nothing enrolled, cancelled or errored → false, and the caller does nothing.
 */
export async function confirmWithFace(prompt: string): Promise<{ ok: true } | { ok: false; why: string }> {
  try {
    if (!(await LocalAuthentication.hasHardwareAsync())) return { ok: false, why: 'This phone has no Face ID or fingerprint reader.' }
    // Constants.isDevice is false on the iOS simulator, where Face ID is switched on from the simulator's own menu, not from Settings.
    if (!(await LocalAuthentication.isEnrolledAsync())) return { ok: false, why: Constants.isDevice === false ? 'This simulator has no Face ID. In the Simulator menu: Features → Face ID → Enrolled, then try again.' : 'Set up Face ID in your phone’s settings first.' }
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: prompt, cancelLabel: 'Cancel', disableDeviceFallback: !IN_EXPO_GO })
    return r.success ? { ok: true } : { ok: false, why: r.error === 'user_cancel' || r.error === 'app_cancel' || r.error === 'system_cancel' ? 'Cancelled.' : 'Face ID did not match.' }
  } catch {
    return { ok: false, why: 'Face ID is not available right now.' }
  }
}
