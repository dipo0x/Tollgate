import { router } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'
import Animated, { ZoomIn } from 'react-native-reanimated'
import { confirmWithFace, useSession } from '../../src/state/session'
import { Card, Circle, Icon, Pill, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** Onboarding 3 of 3: prove Face ID works now, so the first real approval is not the first time it is tried. */
export default function FaceId() {
  const { setFaceReady } = useSession()
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function turnOn() {
    setBusy(true); setProblem(null)
    const r = await confirmWithFace('Turn on Face ID for Tollgate')
    setBusy(false)
    if (!r.ok) { setProblem(r.why); return }
    await setFaceReady(); setOk(true)
  }

  return (
    <Screen>
      <TopBar left={router.canGoBack() ? <Circle icon="back" label="Back" onPress={() => router.back()} /> : undefined} />
      <View style={{ alignItems: 'center', marginTop: 60, gap: 28 }}>
        <View style={{ width: 150, height: 150, borderRadius: 40, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}>
          {ok ? <Animated.View entering={ZoomIn.springify()}><Icon name="check" size={64} color={C.green} width={2.4} /></Animated.View> : <Icon name="face" size={84} width={1.6} />}
        </View>
        <View style={{ alignItems: 'center', gap: 10, paddingHorizontal: 12 }}>
          <T v="h1" style={{ textAlign: 'center' }}>{ok ? 'You’re all set' : 'Approve with Face ID'}</T>
          <T v="sub" style={{ textAlign: 'center', fontSize: 16, lineHeight: 22 }}>{ok ? 'Every approval needs you, in person. A lost phone can’t approve anything.' : 'Approving a payment always needs your face. Stopping one never does.'}</T>
        </View>
      </View>
      <Card style={{ marginTop: 30 }}>
        <Row first icon="face" title="Approve a payment" right={<T v="sub">Face ID</T>} />
        <Row icon="power" title="Unfreeze payments" right={<T v="sub">Face ID</T>} />
        <Row icon="power" title="Freeze everything" right={<T v="sub">One tap</T>} />
      </Card>
      {problem ? <T v="sub" style={{ marginTop: 14, color: C.red, textAlign: 'center' }}>{problem}</T> : null}
      <View style={{ flex: 1 }} />
      <View style={{ paddingBottom: 12 }}>
        {ok ? <Pill title="Open Tollgate" onPress={() => router.replace('/(tabs)/home')} /> : <Pill title="Turn on Face ID" busy={busy} onPress={() => void turnOn()} />}
      </View>
    </Screen>
  )
}
