import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { GatewayError } from '../../src/api/gateway'
import { kindOf, KIND_LABEL, money, when } from '../../src/lib/format'
import { useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { Amount, Card, Circle, Dot, ErrorNote, Glyph, KindIcon, Label, Loading, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** One agent: what it has left, the rules it works under, and what it did. The owner can stop it for good from here. */
export default function AgentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const now = useNow()
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(async () => {
    const [m, decisions] = await Promise.all([gw.mandate(id), gw.decisions(100)])
    return { ...m, decisions: decisions.filter(d => d.mandateId === id).slice(0, 8) }
  }, [gw, id])
  const { data, error, loading, refresh } = usePoll(load, 6000)
  const m = data?.mandate
  const active = data?.status === 'active'
  const askAlways = m ? Number(m.approval.above) === 0 : false

  function stop() {
    Alert.alert(`Stop ${m?.agentId ?? 'this agent'}?`, 'It will not be able to pay anything again. Its key stops working. This cannot be undone; add it again to restart.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop agent', style: 'destructive', onPress: async () => {
        try { await gw.stopAgent(id); await refresh() } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'Not stopped. Try again.') }
      } },
    ])
  }

  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Agents" onPress={() => router.back()} />}
        right={data ? <View style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.1)', flexDirection: 'row', alignItems: 'center', gap: 8 }}><Dot color={active ? C.green : C.text3} /><T v="bodyStrong" style={{ fontSize: 15 }}>{active ? 'Running' : 'Stopped'}</T></View> : undefined} />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {m && data ? (
        <>
          <View style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}><Glyph size={32} /></View>
            <View style={{ flex: 1, gap: 3 }}><T v="h1" lines={1}>{m.agentId}</T><T v="sub">Until {new Date(m.validUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</T></View>
          </View>
          <View style={{ marginTop: 24, gap: 6 }}>
            <Amount value={data.balance?.remaining} unit={m.budget.currency} size={48} />
            <T v="sub" style={{ fontSize: 15 }}>Left of {money(m.budget.total)} · {money(data.balance?.settled)} spent · {money(data.balance?.committed)} held</T>
          </View>

          <Label>Rules</Label>
          <Card>
            <Row first title="Max per payment" right={<T>{money(m.budget.perPayment)} {m.budget.currency}</T>} />
            <Row title="Needs your yes" right={<T>{askAlways ? 'Every payment' : `Above ${money(m.approval.above)}`}</T>} />
            <Row title="Shops" right={<T lines={1} style={{ maxWidth: 190 }}>{m.allowedHosts.join(', ')}</T>} />
            <Row title="Pays from" right={<T>{m.allowedOriginNetworks.join(', ')} · {m.allowedAssets.join(', ')}</T>} />
            <Row title="Refunds go to" right={<T>{m.refund.mustBePayerOrPinned ? 'You only' : 'Anyone'}</T>} />
          </Card>
          <T v="small" style={{ marginTop: 8, marginHorizontal: 4 }}>Rules are loosened on your computer only. This phone can stop an agent, never give it more.</T>

          <Label>Recent</Label>
          <Card>
            {data.decisions.length === 0 ? <T v="sub" style={{ padding: 16 }}>Nothing yet.</T> : data.decisions.map((d, i) => {
              const k = kindOf(d)
              return (
                <Pressable key={d.decisionId} onPress={() => router.push(`/decision/${encodeURIComponent(d.decisionId)}`)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
                  <KindIcon kind={k} size={34} />
                  <View style={{ flex: 1, gap: 2 }}><T lines={1}>{d.purpose || d.host}</T><T v="sub">{when(d.createdAt, now)} · {KIND_LABEL[k].toLowerCase()}</T></View>
                  <T style={{ fontVariant: ['tabular-nums'] }}>{d.amount ?? ''}</T>
                </Pressable>
              )
            })}
          </Card>

          {active ? (
            <Card style={{ marginTop: 24 }}>
              <Row first icon="power" title={`Stop ${m.agentId}`} sub="For good. Other agents keep running." danger chevron={false} onPress={stop} />
            </Card>
          ) : null}
          {problem ? <T v="sub" style={{ marginTop: 12, color: C.red, textAlign: 'center' }}>{problem}</T> : null}
        </>
      ) : null}
    </Screen>
  )
}
