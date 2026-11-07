import * as LocalAuthentication from 'expo-local-authentication'
import { clearScreenCache } from './usePoll'
import Constants, { ExecutionEnvironment } from 'expo-constants'
import * as SecureStore from 'expo-secure-store'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createGateway, type Gateway } from '../api/gateway'

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

type Session = {
  ready: boolean
  paired: boolean
  faceReady: boolean
  url: string | null
  gateway: Gateway | null
  pair: (url: string, token: string) => Promise<void>
  unpair: () => Promise<void>
  setFaceReady: () => Promise<void>
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [url, setUrl] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [faceReady, setFace] = useState(false)

  useEffect(() => {
    (async () => {
      const [u, t, f] = await Promise.all([SecureStore.getItemAsync(KEY_URL), SecureStore.getItemAsync(KEY_TOKEN), SecureStore.getItemAsync(KEY_FACE)])
      setUrl(u); setToken(t); setFace(f === '1'); setReady(true)
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
    await Promise.all([SecureStore.deleteItemAsync(KEY_URL), SecureStore.deleteItemAsync(KEY_TOKEN), SecureStore.deleteItemAsync(KEY_FACE)])
    clearScreenCache()
    setUrl(null); setToken(null); setFace(false)
  }, [])

  const setFaceReady = useCallback(async () => { await SecureStore.setItemAsync(KEY_FACE, '1'); setFace(true) }, [])

  const gateway = useMemo(() => (url && token ? createGateway({ baseUrl: url, token }) : null), [url, token])
  const value = useMemo<Session>(() => ({ ready, paired: !!gateway, faceReady, url, gateway, pair, unpair, setFaceReady }), [ready, gateway, faceReady, url, pair, unpair, setFaceReady])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
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
