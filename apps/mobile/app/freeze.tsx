import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { FadeIn, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated'
import { GatewayError } from '../src/api/gateway'
import { confirmWithFace, useGateway } from '../src/state/session'
import { usePoll } from '../src/state/usePoll'
import { Card, Circle, ErrorNote, Icon, Loading, Row, Screen, T, TopBar } from '../src/ui/kit'
import { C } from '../src/ui/theme'

/**
 * The kill switch. Freezing is one tap with no Face ID: stopping money must never be slow. Unfreezing needs Face ID.
 * The gateway refuses every payment while frozen, and the signer reads the same switch, so an approved payment cannot be signed.
 */
export default function Freeze() {
  const gw = useGateway()
  const load = useCallback(() => gw.status(), [gw])
  const { data, error, loading, refresh } = usePoll(load, 4000)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const shake = useSharedValue(0)
  const shakeStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }))
  const frozen = data?.frozen ?? false

  async function toggle() {
    setProblem(null)
    if (frozen) {
      const f = await confirmWithFace('Unfreeze all payments')
      if (!f.ok) { setProblem(f.why === 'Cancelled.' ? null : f.why); return }
    }
    setBusy(true)
    try {
      if (frozen) await gw.unfreeze()
      else {
        await gw.freeze()
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
        shake.value = withSequence(withTiming(-8, { duration: 60 }), withTiming(7, { duration: 60 }), withTiming(-4, { duration: 60 }), withTiming(0, { duration: 60 }))
      }
      await refresh()
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : 'Nothing changed. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen scroll={false}>
      {frozen ? <Animated.View entering={FadeIn} pointerEvents="none" style={{ position: 'absolute', top: 0, left: -20, right: -20, height: 500, backgroundColor: 'rgba(255,69,58,0.08)' }} /> : null}
      <Animated.View style={[{ flex: 1 }, shakeStyle]}>
        <TopBar left={<Circle icon="x" label="Close" onPress={() => router.back()} />} title="Kill switch" />
        <ErrorNote error={error} onRetry={() => void refresh()} />
        {loading && !data ? <Loading /> : null}
        <View style={{ marginTop: 26, alignItems: 'center', gap: 10, paddingHorizontal: 12 }}>
          <T v="h1" style={{ textAlign: 'center' }}>{frozen ? 'Payments frozen' : 'Stop every payment'}</T>
          <T v="sub" style={{ textAlign: 'center', fontSize: 16, lineHeight: 22 }}>{frozen ? 'Your agents can still ask. Tollgate says no to everything until you unfreeze.' : 'One tap, no Face ID. Starting again needs Face ID.'}</T>
        </View>
        <Pressable onPress={() => void toggle()} disabled={busy || !data} accessibilityRole="button" accessibilityLabel={frozen ? 'Unfreeze with Face ID' : 'Freeze all payments'}
          style={({ pressed }) => ({ alignSelf: 'center', marginTop: 44, width: 176, height: 176, borderRadius: 88, backgroundColor: frozen ? C.card2 : C.red, alignItems: 'center', justifyContent: 'center', gap: 8, opacity: busy ? 0.6 : 1, transform: [{ scale: pressed ? 0.95 : 1 }] })}>
          <Icon name="power" size={42} width={2.4} />
          <T v="bodyStrong" style={{ fontSize: 17 }}>{frozen ? 'Unfreeze' : 'Freeze'}</T>
        </Pressable>
        {problem ? <T v="sub" style={{ marginTop: 16, textAlign: 'center', color: C.red }}>{problem}</T> : null}
        <Card style={{ marginTop: 40 }}>
          <Row first icon="x" title="New payments" right={<T v="sub">{frozen ? 'Refused' : 'Checked'}</T>} />
          <Row icon="key" title="Signing" right={<T v="sub">{frozen ? 'Refused' : 'After your yes'}</T>} />
          <Row icon="info" title="Already on chain" right={<T v="sub">Can’t be pulled back</T>} />
        </Card>
      </Animated.View>
    </Screen>
  )
}
