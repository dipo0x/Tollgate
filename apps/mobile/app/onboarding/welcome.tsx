import { router } from 'expo-router'
import { View } from 'react-native'
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated'
import { Icon, Pill, Screen, T, type IconName } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

const STEPS: { icon: IconName; label: string }[] = [
  { icon: 'agents', label: 'Your agent\nasks to pay' },
  { icon: 'check', label: 'Tollgate\nchecks it' },
  { icon: 'face', label: 'You\ndecide' },
]

/** Onboarding 1 of 3: what Tollgate is, in one sentence, with a three-step picture. No example payments: everything the app shows is real. */
export default function Welcome() {
  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Animated.View entering={FadeInDown.springify().damping(16)} style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}
          accessible accessibilityLabel="How it works: your agent asks to pay, Tollgate checks it, you decide">
          <View style={{ position: 'absolute', left: '17%', right: '17%', top: 38, height: 1, backgroundColor: C.card3 }} />
          {STEPS.map(s => (
            <View key={s.label} style={{ width: '33%', alignItems: 'center', gap: 14 }}>
              <View style={{ width: 76, height: 76, borderRadius: 38, backgroundColor: C.card, borderWidth: 1, borderColor: C.card3, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name={s.icon} size={30} color={s.icon === 'check' ? C.green : C.text} width={2} />
              </View>
              <T v="small" style={{ textAlign: 'center', color: C.text, fontSize: 15, lineHeight: 20 }}>{s.label}</T>
            </View>
          ))}
        </Animated.View>
        <Animated.View entering={FadeInUp.delay(150)} style={{ marginTop: 48, alignItems: 'center', gap: 12, paddingHorizontal: 8 }}>
          <T v="title" style={{ textAlign: 'center' }}>Your agent pays.{'\n'}You decide.</T>
          <T v="sub" style={{ textAlign: 'center', fontSize: 17, lineHeight: 24 }}>Every payment your AI agent wants to make is checked, then waits here for your yes. One tap stops them all.</T>
        </Animated.View>
      </View>
      <View style={{ paddingBottom: 12, gap: 14, alignItems: 'center' }}>
        <Pill title="Get started" onPress={() => router.push('/onboarding/connect')} style={{ alignSelf: 'stretch' }} />
      </View>
    </Screen>
  )
}
