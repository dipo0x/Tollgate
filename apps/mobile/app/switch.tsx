import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, TextInput, View } from 'react-native'
import { checkGatewayUrl, createGateway, GatewayError, parsePairingCode } from '../src/api/gateway'
import { useSession } from '../src/state/session'
import { Card, Circle, Dot, Icon, Label, Pill, Screen, T, TopBar } from '../src/ui/kit'
import { C, F, R } from '../src/ui/theme'

const MAIN_LENS = 'AVCaptureDeviceTypeBuiltInWideAngleCamera'
type Reach = 'checking' | 'up' | 'down'

/**
 * Change the gateway address without unpairing: when the Wi-Fi changes, or the computer gets a new number. The key, Face ID,
 * agents and chats all stay. Three ways: one tap on an address this gateway reported while connected; scan a new code; type one.
 *
 * Checking which addresses answer sends NO key (GET /healthz). The key goes to an address only after the owner picks it, and the
 * switch is saved only once the gateway there accepts the key (session.switchTo). A scanned code with a different key re-pairs.
 */
export default function Switch() {
  const { url, alternates, switchTo, pair } = useSession()
  const [reach, setReach] = useState<Record<string, Reach>>({})
  const [mode, setMode] = useState<'pick' | 'scan' | 'type'>('pick')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  // What the overlay says while switching: does it answer (no key sent), does it accept the key, then connected.
  const [step, setStep] = useState<'reach' | 'key' | 'done'>('reach')
  const [problem, setProblem] = useState<string | null>(null)
  const [perm, askPerm] = useCameraPermissions()
  const scanned = useRef(false)
  const all = [...new Set([...(url ? [url] : []), ...alternates])]

  // Which addresses answer right now. No key is sent: /healthz is open, and says only "ok" and whether payments are frozen.
  useEffect(() => {
    let live = true
    setReach(Object.fromEntries(all.map(a => [a, 'checking' as Reach])))
    for (const a of all) {
      createGateway({ baseUrl: a, token: '', timeoutMs: 5000 }).health()
        .then(() => live && setReach(r => ({ ...r, [a]: 'up' })), () => live && setReach(r => ({ ...r, [a]: 'down' })))
    }
    return () => { live = false }
  }, [all.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  async function use(raw: string) {
    setProblem(null)
    const c = checkGatewayUrl(raw)
    if (!c.ok) { setProblem(c.why); return } // a typo is refused here: nothing is sent anywhere
    setBusy(c.url); setStep('reach')
    try {
      // 1. Does anything answer there? Asks the open health check only: no key is sent to an address that is not even up.
      await createGateway({ baseUrl: c.url, token: '', timeoutMs: 8000 }).health()
        .catch(() => { throw new GatewayError(`Nothing answers at ${host(c.url)}. Check the computer is on and on the same Wi-Fi.`, 0) })
      // 2. Does it accept this phone's key? Only then is the new address saved (session.switchTo).
      setStep('key')
      await switchTo(c.url)
      await connected()
    } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'Not switched. Nothing was changed.') } finally { setBusy(null) }
  }

  /** A moment of "Connected" before closing, so the switch is seen to have worked; the app then loads fresh data (the pill). */
  async function connected() {
    setStep('done')
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    await new Promise(r => setTimeout(r, 700))
    router.back()
  }

  async function onScan(data: string) {
    if (scanned.current || busy) return
    scanned.current = true
    const p = parsePairingCode(data)
    if (!p.ok) { setProblem(p.why); setTimeout(() => { scanned.current = false }, 1500); return }
    setProblem(null); setBusy(p.url); setStep('key')
    try {
      await createGateway({ baseUrl: p.url, token: p.key }).status() // nothing is saved until this gateway accepts this key
      await pair(p.url, p.key) // Face ID stays set up; only the address (and the key, if it changed) is replaced
      await connected()
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : 'Not switched. Nothing was changed.'); scanned.current = false
    } finally { setBusy(null) }
  }

  const host = (u: string) => { try { return new URL(u).host } catch { return u } }
  const label: Record<Reach, string> = { checking: 'Checking…', up: 'Answering', down: 'Not answering' }

  return (
    <Screen>
      <TopBar left={<Circle icon="x" label="Close" onPress={() => router.back()} />} title="Change address" />
      <T v="sub" style={{ marginTop: 14, fontSize: 15, lineHeight: 21 }}>Same gateway, new address. Your key, Face ID, agents and chats stay as they are.</T>

      {mode === 'pick' ? (
        <>
          <Label>Addresses for your gateway</Label>
          <Card>
            {all.length === 0 ? <T v="sub" style={{ padding: 16 }}>None saved yet. Scan a new code or type the address below.</T> : all.map((a, i) => {
              const r = reach[a] ?? 'checking', current = a === url
              return (
                <Pressable key={a} disabled={current || !!busy} onPress={() => void use(a)} accessibilityRole="button" accessibilityLabel={`Use ${host(a)}`}
                  style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep, opacity: pressed ? 0.7 : 1 })}>
                  <Dot color={r === 'up' ? C.green : r === 'down' ? C.red : C.text3} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <T lines={1}>{host(a)}</T>
                    <T v="sub">{current ? `In use · ${label[r]}` : label[r]}{a.includes('.local') ? ' · stays the same on a new Wi-Fi number' : ''}</T>
                  </View>
                  {busy === a ? <ActivityIndicator color={C.text} /> : current ? <Icon name="check" size={18} color={C.text2} /> : <T v="bodyStrong" style={{ fontSize: 15, color: r === 'down' ? C.text3 : C.text }}>Use</T>}
                </Pressable>
              )
            })}
          </Card>
          <T v="small" style={{ marginTop: 8, marginHorizontal: 4 }}>Learned from your gateway while connected. Checking them sends no key.</T>
        </>
      ) : mode === 'scan' ? (
        <View style={{ marginTop: 24, alignSelf: 'center', width: 260, height: 260, borderRadius: 34, overflow: 'hidden', backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
          {perm?.granted ? (
            <CameraView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} facing="back" selectedLens={MAIN_LENS} barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={r => void onScan(r.data)} />
          ) : (
            <View style={{ alignItems: 'center', gap: 14, padding: 20 }}>
              <T v="small" style={{ textAlign: 'center' }}>On your computer: dashboard → Pair a phone. The camera is only used to read the code.</T>
              <Pill title="Allow camera" dark onPress={() => void askPerm()} style={{ height: 44 }} />
            </View>
          )}
          {busy ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator size="large" color={C.text} /></View> : null}
        </View>
      ) : (
        <Card style={{ marginTop: 22 }}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
            <T v="small">New gateway address</T>
            <TextInput value={typed} onChangeText={setTyped} placeholder="http://your-mac.local:8787" placeholderTextColor={C.text3} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" autoFocus
              style={{ color: C.text, fontFamily: F.regular, fontSize: 17, paddingVertical: 2 }} />
          </View>
        </Card>
      )}

      {problem ? (
        <View style={{ marginTop: 14, padding: 14, borderRadius: R.card, backgroundColor: C.redBg, flexDirection: 'row', gap: 10 }}>
          <Icon name="info" size={18} color={C.red} /><T v="sub" style={{ flex: 1, color: C.text }}>{problem}</T>
        </View>
      ) : null}

      <View style={{ flex: 1, minHeight: 24 }} />
      <View style={{ gap: 6, paddingBottom: 12 }}>
        {mode === 'type' ? <Pill title="Use this address" busy={busy !== null} disabled={!typed.trim()} onPress={() => void use(typed.trim())} /> : null}
        {mode !== 'scan' ? <Pill title="Scan a new code" dark onPress={() => { setProblem(null); scanned.current = false; setMode('scan') }} /> : null}
        {mode !== 'type' ? <Pill title="Type an address" dark onPress={() => { setProblem(null); setMode('type') }} /> : null}
        {mode !== 'pick' ? <Pill title="Back to saved addresses" dark onPress={() => { setProblem(null); setMode('pick') }} /> : null}
      </View>

      {/* While switching: the whole screen says what is happening, step by step, so a tap never looks like nothing happened. */}
      <Modal transparent visible={busy !== null} animationType="fade" statusBarTranslucent>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.78)', alignItems: 'center', justifyContent: 'center', padding: 32 }} accessibilityViewIsModal accessibilityLiveRegion="polite">
          <View style={{ width: '100%', maxWidth: 320, padding: 24, borderRadius: R.card, backgroundColor: C.card, alignItems: 'center', gap: 14 }}>
            {step === 'done' ? <Icon name="check" size={34} color={C.green} width={2.6} /> : <ActivityIndicator size="large" color={C.text} />}
            <T v="h2" style={{ textAlign: 'center' }}>{step === 'done' ? 'Connected' : `Connecting to ${busy ? host(busy) : ''}`}</T>
            <T v="sub" style={{ textAlign: 'center', lineHeight: 20 }}>
              {step === 'reach' ? 'Checking it answers…' : step === 'key' ? 'Checking it accepts this phone’s key…' : 'Loading your data…'}
            </T>
          </View>
        </View>
      </Modal>
    </Screen>
  )
}
