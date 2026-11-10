import { router } from 'expo-router'
import { useCallback } from 'react'
import { Pressable, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { loaders } from '../../src/state/loaders'
import { kindOf, KIND_LABEL, money, timeLeft, when } from '../../src/lib/format'
import { Card, Circle, Dot, ErrorNote, Glyph, Icon, KindIcon, Loading, Screen, T } from '../../src/ui/kit'
import { C, F, R } from '../../src/ui/theme'

/**
 * Home, kept calm on purpose: how much is left, whether payments are live or frozen, what needs you, what happened last.
 * Every number is read from the gateway; nothing here is computed from guesses.
 */
export default function Home() {
  const gw = useGateway()
  const now = useNow()
  const load = useCallback(() => loaders.home(gw), [gw])
  const { data, error, loading, refresh } = usePoll(load, 4000, 'home')

  const active = (data?.mandates ?? []).filter(m => m.status === 'active' && !m.parentId)
  // Agents' budgets are permission to spend, not money. What can really be spent is never more than the payment account holds.
  const budgets = active.reduce((s, m) => s + Number(m.balance?.remaining ?? 0), 0)
  const held = data?.funds ? Number(data.funds.available) : null
  const left = held === null || !Number.isFinite(held) ? budgets : Math.min(budgets, held)
  const capped = held !== null && Number.isFinite(held) && budgets > held
  const agents = [...new Set(active.map(m => m.agentId))]
  const waiting = (data?.approvals ?? []).filter(a => a.status === 'pending')
  const recent = (data?.decisions ?? []).filter(d => kindOf(d) !== 'waiting').slice(0, 3)
  const frozen = data?.status.frozen ?? false

  return (
    <Screen bottomSpace={120}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
        <View style={{ width: 44, height: 44, borderRadius: R.tile, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}><Glyph /></View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Circle icon="power" label="Kill switch" onPress={() => router.push('/freeze')} />
          <Circle icon="gear" label="Account" onPress={() => router.navigate('/(tabs)/account')} />
        </View>
      </View>

      {frozen ? (
        <Animated.View entering={FadeIn} style={{ marginTop: 14, padding: 14, borderRadius: R.card, backgroundColor: C.redBg, borderWidth: 1, borderColor: 'rgba(255,69,58,0.35)', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Icon name="power" color={C.red} width={2.2} />
          <View style={{ flex: 1, gap: 2 }}><T v="bodyStrong">Payments are frozen</T><T v="sub">Every payment is refused</T></View>
          <Pressable onPress={() => router.push('/freeze')} style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: C.button, justifyContent: 'center' }}><T v="bodyStrong" style={{ color: '#000', fontSize: 15 }}>Unfreeze</T></Pressable>
        </Animated.View>
      ) : null}

      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}

      {data ? (
        <Animated.View entering={FadeIn.duration(400)}>
          <View style={{ marginTop: 22, gap: 8 }}>
            <T v="sub" style={{ fontSize: 15 }}>Left to spend</T>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <T style={{ fontFamily: F.semibold, fontSize: 52, letterSpacing: -1.6, fontVariant: ['tabular-nums'] }}>{money(left.toFixed(6))}</T>
              <T v="sub" style={{ fontSize: 17 }}>USDC</T>
            </View>
            {capped ? <T v="small">Your agents may spend up to {money(budgets.toFixed(6))}, but the payment account holds {money(held.toFixed(6))}.</T> : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Dot color={frozen ? C.red : C.green} /><T v="sub" style={{ fontSize: 15, color: frozen ? C.red : C.text2 }}>{frozen ? 'Frozen' : 'Payments on'}</T>
                <T v="sub" style={{ fontSize: 15 }}>· {data.status.mode === 'live' ? 'Live' : 'Test mode'}</T>
              </View>
              <Pressable onPress={() => router.push('/topup')} style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: C.card2, justifyContent: 'center' }}><T v="bodyStrong" style={{ fontSize: 15 }}>Top up</T></Pressable>
            </View>
          </View>

          <Pressable onPress={() => router.navigate('/(tabs)/agents')} style={{ marginTop: 22, height: 48, paddingHorizontal: 16, borderRadius: 24, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="agents" size={18} />
            <T style={{ flex: 1, fontSize: 15 }}>{agents.length === 1 ? '1 agent running' : `${agents.length} agents running`}</T>
            <T v="sub" lines={1} style={{ maxWidth: 140 }}>{agents.join(', ')}</T>
            <Icon name="chev" size={14} color={C.text3} width={2} />
          </Pressable>

          <T v="sub" style={{ fontSize: 15, marginTop: 26, marginBottom: 8, marginLeft: 4 }}>{waiting.length === 0 ? 'Nothing needs you' : waiting.length === 1 ? '1 payment needs you' : `${waiting.length} payments need you`}</T>
          {waiting.map(a => (
            <Pressable key={a.decisionId} onPress={() => router.push(`/approval/${encodeURIComponent(a.decisionId)}`)} style={({ pressed }) => ({ marginBottom: 8, opacity: pressed ? 0.7 : 1 })}>
              <Card style={{ padding: 14, flexDirection: 'row', alignItems: 'center', gap: 14, opacity: frozen ? 0.45 : 1 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' }}><Icon name="store" size={18} /></View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="bodyStrong" lines={1}>{a.decision.purpose || a.decision.host}</T>
                  <T v="sub" lines={1}>{frozen ? 'Locked while frozen' : `${a.decision.agentId} · expires in ${timeLeft(a.expiresAt, now)}`}</T>
                </View>
                <T v="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>{money(a.decision.amount)}</T>
                <Icon name="chev" size={16} color={C.text3} width={2} />
              </Card>
            </Pressable>
          ))}

          <View style={{ marginTop: 26, marginBottom: 4, marginHorizontal: 4, flexDirection: 'row', justifyContent: 'space-between' }}>
            <T v="sub" style={{ fontSize: 15 }}>Recent</T>
            <Pressable onPress={() => router.navigate('/(tabs)/activity')}><T v="sub" style={{ fontSize: 15 }}>See all</T></Pressable>
          </View>
          <Card>
            {recent.length === 0 ? <T v="sub" style={{ padding: 16 }}>No payments yet.</T> : recent.map((d, i) => {
              const k = kindOf(d)
              return (
                <Pressable key={d.decisionId} onPress={() => router.push(`/decision/${encodeURIComponent(d.decisionId)}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
                  <KindIcon kind={k} size={36} />
                  <View style={{ flex: 1, gap: 2 }}><T lines={1}>{d.purpose || d.host}</T><T v="sub" lines={1}>{when(d.createdAt, now)} · {KIND_LABEL[k].toLowerCase()}</T></View>
                  <T style={{ fontVariant: ['tabular-nums'], color: k === 'paid' ? C.text : C.text2 }}>{k === 'paid' ? `−${money(d.amount)}` : d.amount ?? ''}</T>
                </Pressable>
              )
            })}
          </Card>
        </Animated.View>
      ) : null}
    </Screen>
  )
}
