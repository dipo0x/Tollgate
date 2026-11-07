import { router } from 'expo-router'
import { useCallback } from 'react'
import { View } from 'react-native'
import { money } from '../src/lib/format'
import { useGateway } from '../src/state/session'
import { usePoll } from '../src/state/usePoll'
import { Card, Circle, ErrorNote, Icon, Loading, Screen, T, Tile, TopBar } from '../src/ui/kit'
import { C } from '../src/ui/theme'

/** The shops your gateway knows, read-only. Enabling one is done on the computer. */
export default function Shops() {
  const gw = useGateway()
  const load = useCallback(() => gw.services(), [gw])
  const { data, error, loading, refresh } = usePoll(load, 15_000)
  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Shops" />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {data && data.length === 0 ? <T v="sub" style={{ marginTop: 30, textAlign: 'center' }}>No shops yet. Add them on your dashboard.</T> : null}
      {data && data.length ? (
        <Card style={{ marginTop: 18 }}>
          {data.map((s, i) => (
            <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
              <Tile icon="store" size={40} />
              <View style={{ flex: 1, gap: 2 }}><T v="bodyStrong" lines={1}>{s.name}</T><T v="sub" lines={1}>{s.host} · {money(s.pricing.quoted)} {s.pricing.currency}</T></View>
              <T v="sub" style={{ color: s.enabled ? C.green : C.text2 }}>{s.enabled ? 'On' : 'Off'}</T>
            </View>
          ))}
        </Card>
      ) : null}
      <View style={{ marginTop: 16, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
        <Icon name="info" size={16} color={C.text2} /><T v="small" style={{ flex: 1 }}>Agents only ever see a shop’s name, category and price, never its own text. Shops are added and enabled on your computer.</T>
      </View>
    </Screen>
  )
}
