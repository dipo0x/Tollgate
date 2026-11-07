import { router } from 'expo-router'
import { useCallback } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { FadeInDown } from 'react-native-reanimated'
import type { MandateRow } from '../../src/api/gateway'
import { money } from '../../src/lib/format'
import { useGateway } from '../../src/state/session'
import { usePoll } from '../../src/state/usePoll'
import { Card, Dot, ErrorNote, Glyph, Icon, Loading, Screen, T } from '../../src/ui/kit'
import { C, R } from '../../src/ui/theme'

/** Every agent the gateway knows: one card per mandate, with hired workers listed under the agent that hired them. */
export default function Agents() {
  const gw = useGateway()
  const load = useCallback(async () => { const [mandates, approvals] = await Promise.all([gw.mandates(), gw.approvals()]); return { mandates, approvals } }, [gw])
  const { data, error, loading, refresh } = usePoll(load, 6000)
  const tops = (data?.mandates ?? []).filter(m => !m.parentId)
  const running = tops.filter(m => m.status === 'active').length

  return (
    <Screen bottomSpace={120}>
      <View style={{ marginTop: 18, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <View style={{ gap: 4 }}><T v="title">Agents</T><T v="sub" style={{ fontSize: 15 }}>{data ? `${running} running · ${tops.length - running} stopped` : ' '}</T></View>
        <Pressable onPress={() => router.push('/agents/new')} accessibilityRole="button" accessibilityLabel="Add an agent" style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: C.button, alignItems: 'center', justifyContent: 'center' }}><Icon name="plus" color="#000" width={2.4} /></Pressable>
      </View>
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {tops.map((m, i) => <AgentCard key={m.id} m={m} i={i} kids={(data?.mandates ?? []).filter(c => c.parentId === m.id)} waiting={(data?.approvals ?? []).filter(a => a.status === 'pending' && a.decision.mandateId === m.id).length} />)}
      {data ? (
        <Pressable onPress={() => router.push('/agents/new')} style={{ marginTop: 12, height: 64, borderRadius: 24, borderWidth: 1.5, borderStyle: 'dashed', borderColor: C.card3, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
          <Icon name="plus" size={18} color={C.text2} width={2} /><T v="bodyStrong" style={{ color: C.text2 }}>Add an agent</T>
        </Pressable>
      ) : null}
      <View style={{ marginTop: 18, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
        <Icon name="info" size={16} color={C.text2} /><T v="small" style={{ flex: 1 }}>Each agent has its own budget, limits and key. The kill switch stops all of them at once.</T>
      </View>
    </Screen>
  )
}

function AgentCard({ m, i, kids, waiting }: { m: MandateRow; i: number; kids: MandateRow[]; waiting: number }) {
  const total = Number(m.balance?.total ?? 0), left = Number(m.balance?.remaining ?? 0)
  const active = m.status === 'active'
  return (
    <Animated.View entering={FadeInDown.delay(i * 60).springify().damping(18)}>
      <Pressable onPress={() => router.push(`/agents/${encodeURIComponent(m.id)}`)} style={({ pressed }) => ({ marginTop: i ? 10 : 22, opacity: pressed ? 0.75 : 1 })}>
        <Card style={{ padding: 16, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 48, height: 48, borderRadius: 15, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' }}><Glyph size={26} /></View>
            <View style={{ flex: 1, gap: 3 }}>
              <T v="bodyStrong" style={{ fontSize: 18 }} lines={1}>{m.agentId}</T>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Dot color={active ? C.green : C.text3} /><T v="sub">{active ? 'Running' : m.status === 'revoked' ? 'Stopped' : m.status}</T></View>
            </View>
            <Icon name="chev" size={16} color={C.text3} width={2} />
          </View>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T v="sub">Budget left</T><T style={{ fontSize: 14, fontVariant: ['tabular-nums'] }}>{money(m.balance?.remaining)} of {money(m.balance?.total)} {m.currency}</T></View>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: C.card2, overflow: 'hidden' }}><View style={{ width: `${total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0}%`, height: '100%', borderRadius: R.pill, backgroundColor: C.text }} /></View>
          </View>
          <View style={{ height: 1, backgroundColor: C.sep }} />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T v="sub">{waiting ? `${waiting} waiting for you` : 'Nothing waiting'}{kids.length ? ` · hired ${kids.length}` : ''}</T>
            <T v="sub">{money(m.perPayment)} max a payment</T>
          </View>
        </Card>
      </Pressable>
    </Animated.View>
  )
}
