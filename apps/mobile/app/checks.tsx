import { router } from 'expo-router'
import { View } from 'react-native'
import { CHECKS } from '../src/lib/checks'
import { Card, Circle, Icon, Screen, T, TopBar } from '../src/ui/kit'
import { C } from '../src/ui/theme'

/** The twelve checks every payment passes, in order, in plain words. Read-only: the rules themselves live in the gateway. */
export default function Checks() {
  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="The 12 checks" />
      <T v="sub" style={{ marginTop: 14, marginHorizontal: 4 }}>Before anything is signed, Tollgate runs these in order. The first one that says no stops the payment, and any check that errors or cannot get its facts counts as a no.</T>
      <Card style={{ marginTop: 18 }}>
        {CHECKS.map((c, i) => (
          <View key={c.id} style={{ padding: 14, gap: 6, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ paddingHorizontal: 8, height: 24, borderRadius: 12, backgroundColor: C.card2, justifyContent: 'center' }}><T v="small" style={{ fontVariant: ['tabular-nums'] }}>{c.id}</T></View>
              <T v="bodyStrong" style={{ flex: 1 }}>{c.name}</T>
            </View>
            <T v="sub">{c.asks}</T>
            <T v="small" style={{ color: C.text2 }}>Stops it when: {c.blocksWhen}</T>
          </View>
        ))}
      </Card>
      <View style={{ marginTop: 16, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
        <Icon name="info" size={16} color={C.text2} /><T v="small" style={{ flex: 1 }}>Tap a payment in Activity to see which of these passed or failed for it, with the evidence.</T>
      </View>
    </Screen>
  )
}
