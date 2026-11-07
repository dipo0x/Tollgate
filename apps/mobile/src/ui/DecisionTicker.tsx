import { useEffect, useState } from 'react'
import { View } from 'react-native'
import Animated, { FadeInUp, FadeOut, LinearTransition } from 'react-native-reanimated'
import { Icon, T } from './kit'
import { C } from './theme'

type Item = { kind: 'ok' | 'no' | 'wait'; title: string; amount: string }

/**
 * Welcome-screen feed: what Tollgate does, shown rather than told. One decision slides in every 2.2 s, the older ones move down
 * and fade. The examples are the kinds of decision the 3 Nov live 1Click test produced (allowed, blocked by C06/C09, held).
 */
const FEED: Item[] = [
  { kind: 'ok', title: 'Allowed · market data', amount: '0.20' },
  { kind: 'no', title: 'Blocked · refund to a stranger', amount: '0.20' },
  { kind: 'wait', title: 'Waiting for you · bridge brief', amount: '0.21' },
  { kind: 'no', title: 'Blocked · price raised after quote', amount: '0.45' },
  { kind: 'ok', title: 'Allowed · within your budget', amount: '0.20' },
  { kind: 'no', title: 'Blocked · over your limit', amount: '0.20' },
]

export function DecisionTicker() {
  const [n, setN] = useState(3)
  useEffect(() => { const t = setInterval(() => setN(v => v + 1), 2200); return () => clearInterval(t) }, [])
  const rows = [n, n - 1, n - 2].map(i => ({ id: i, item: FEED[((i % FEED.length) + FEED.length) % FEED.length]! }))
  return (
    <View style={{ gap: 8 }} accessible accessibilityLabel="Examples of payments Tollgate allowed, blocked or held for you">
      {rows.map((r, i) => (
        <Animated.View key={r.id} entering={FadeInUp.duration(450)} exiting={FadeOut.duration(250)} layout={LinearTransition.duration(400)}
          style={{ opacity: 1 - i * 0.28, flexDirection: 'row', alignItems: 'center', gap: 12, height: 52, paddingHorizontal: 14, borderRadius: 18, backgroundColor: 'rgba(28,28,30,0.8)' }}>
          <View style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: r.item.kind === 'ok' ? C.greenBg : r.item.kind === 'no' ? C.redBg : C.card2 }}>
            {r.item.kind === 'wait'
              ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: C.text }} />
              : <Icon name={r.item.kind === 'ok' ? 'check' : 'x'} size={14} color={r.item.kind === 'ok' ? C.green : C.red} width={2.8} />}
          </View>
          <T lines={1} style={{ flex: 1, fontSize: 15 }}>{r.item.title}</T>
          <T v="sub" style={{ fontVariant: ['tabular-nums'] }}>{r.item.amount}</T>
        </Animated.View>
      ))}
    </View>
  )
}
