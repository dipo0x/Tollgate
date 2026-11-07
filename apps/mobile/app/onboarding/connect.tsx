import { CameraView, useCameraPermissions } from 'expo-camera'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { useRef, useState } from 'react'
import { TextInput, View } from 'react-native'
import { checkGatewayUrl, createGateway, GatewayError, parsePairingCode } from '../../src/api/gateway'
import { useSession } from '../../src/state/session'
import { Card, Circle, Icon, Pill, Screen, T, TopBar } from '../../src/ui/kit'
import { C, F, R } from '../../src/ui/theme'

/**
 * Onboarding 2 of 3: pair with the owner's gateway, by scanning the dashboard's code or typing the address and key.
 * Nothing is saved until the gateway has answered with this key: a wrong address or key never reaches the Keychain.
 */
export default function Connect() {
  const { pair } = useSession()
  const [mode, setMode] = useState<'scan' | 'type'>('scan')
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [perm, askPerm] = useCameraPermissions()
  const scanned = useRef(false)

  async function connect(rawUrl: string, rawKey: string) {
    setProblem(null)
    const u = checkGatewayUrl(rawUrl)
    if (!u.ok) { setProblem(u.why); return }
    if (rawKey.trim().length < 16) { setProblem('That key is too short. Copy it from your dashboard.'); return }
    setBusy(true)
    try {
      await createGateway({ baseUrl: u.url, token: rawKey.trim() }).status()
      await pair(u.url, rawKey.trim())
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      router.replace('/onboarding/faceid')
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : 'Could not connect. Nothing was saved.')
      scanned.current = false
    } finally {
      setBusy(false)
    }
  }

  function onScan(data: string) {
    if (scanned.current || busy) return
    scanned.current = true
    const p = parsePairingCode(data)
    if (!p.ok) { setProblem(p.why); setTimeout(() => { scanned.current = false }, 1500); return }
    void connect(p.url, p.key)
  }

  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Connect" />
      <View style={{ marginTop: 18, gap: 8 }}>
        <T v="h1">{mode === 'scan' ? 'Scan your gateway' : 'Enter your gateway'}</T>
        <T v="sub" style={{ fontSize: 16, lineHeight: 22 }}>{mode === 'scan' ? 'On your computer, open the Tollgate dashboard and choose Pair a phone.' : 'Type your gateway’s address and the key from the dashboard.'}</T>
      </View>

      {mode === 'scan' ? (
        <View style={{ marginTop: 30, alignSelf: 'center', width: 260, height: 260, borderRadius: 34, overflow: 'hidden', backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
          {perm?.granted ? (
            <CameraView style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={r => onScan(r.data)} />
          ) : (
            <View style={{ alignItems: 'center', gap: 14, padding: 20 }}>
              <Icon name="face" size={34} color={C.text3} />
              <T v="small" style={{ textAlign: 'center' }}>The camera is only used to read the pairing code.</T>
              <Pill title="Allow camera" dark onPress={() => void askPerm()} style={{ height: 44 }} />
            </View>
          )}
        </View>
      ) : (
        <Card style={{ marginTop: 26 }}>
          <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
            <T v="small">Gateway address</T>
            <TextInput value={url} onChangeText={setUrl} placeholder="https://gateway.example.com" placeholderTextColor={C.text3} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL"
              style={{ color: C.text, fontFamily: F.regular, fontSize: 17, paddingVertical: 2 }} />
          </View>
          <View style={{ height: 1, marginLeft: 16, backgroundColor: C.sep }} />
          <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
            <T v="small">Key</T>
            <TextInput value={key} onChangeText={setKey} placeholder="From your dashboard" placeholderTextColor={C.text3} autoCapitalize="none" autoCorrect={false} secureTextEntry textContentType="password"
              style={{ color: C.text, fontFamily: F.regular, fontSize: 17, paddingVertical: 2 }} />
          </View>
        </Card>
      )}

      {problem ? (
        <View style={{ marginTop: 14, padding: 14, borderRadius: R.card, backgroundColor: C.redBg, flexDirection: 'row', gap: 10 }}>
          <Icon name="info" size={18} color={C.red} /><T v="sub" style={{ flex: 1, color: C.text }}>{problem}</T>
        </View>
      ) : (
        <T v="small" style={{ marginTop: 14, marginHorizontal: 4 }}>This phone will be able to approve, reject and freeze. It never holds a wallet key.</T>
      )}

      <View style={{ flex: 1 }} />
      <View style={{ gap: 6, paddingBottom: 12 }}>
        {mode === 'type' ? <Pill title="Connect" busy={busy} disabled={!url || !key} onPress={() => void connect(url, key)} /> : null}
        <Pill title={mode === 'scan' ? 'Enter the address instead' : 'Scan a code instead'} dark onPress={() => { setProblem(null); setMode(mode === 'scan' ? 'type' : 'scan') }} />
      </View>
    </Screen>
  )
}
