import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import { GatewayError, type MandateRow } from '../../src/api/gateway'
import { agentState, kindOf, KIND_LABEL, money, when } from '../../src/lib/format'
import { useGateway } from '../../src/state/session'
import { peekScreen, useNow, usePoll } from '../../src/state/usePoll'
import { Amount, Card, Circle, Dot, ErrorNote, Glyph, Icon, KindIcon, Label, Loading, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** One agent: what it has left, the rules it works under, and what it did. The owner can stop it for good from here. */
export default function AgentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const now = useNow()
  const [problem, setProblem] = useState<string | null>(null)
  const load = useCallback(async () => {
    const [m, decisions] = await Promise.all([gw.mandate(id), gw.decisionsFor(id, 8)])
    return { ...m, decisions }
  }, [gw, id])
  const { data, error, loading, refresh } = usePoll(load, 6000, `agent:${id}`)
  const m = data?.mandate
  // Drawn at once from the Agents list's row while the full rules load, so tapping an agent never shows a blank screen.
  const row = peekScreen<{ mandates: MandateRow[] }>('agents')?.mandates.find(r => r.id === id)
  const head = m && data
    ? { agentId: m.agentId, validUntil: m.validUntil, status: data.status, currency: m.budget.currency, total: m.budget.total, remaining: data.balance?.remaining, settled: data.balance?.settled, committed: data.balance?.committed }
    : row ? { agentId: row.agentId, validUntil: row.validUntil, status: row.status, currency: row.currency, total: row.balance?.total, remaining: row.balance?.remaining, settled: row.balance?.settled, committed: row.balance?.committed } : undefined
  const active = head?.status === 'active'
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
        right={head ? <View style={{ height: 36, paddingHorizontal: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.1)', flexDirection: 'row', alignItems: 'center', gap: 8 }}><Dot color={active ? C.green : C.text3} /><T v="bodyStrong" style={{ fontSize: 15 }}>{agentState(head.status).short}</T></View> : undefined} />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !head ? <Loading /> : null}
      {head ? (
        <>
          <View style={{ marginTop: 18, flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <View style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}><Glyph size={32} /></View>
            <View style={{ flex: 1, gap: 3 }}><T v="h1" lines={1}>{head.agentId}</T><T v="sub">Until {new Date(head.validUntil).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</T></View>
          </View>
          <View style={{ marginTop: 24, gap: 6 }}>
            <Amount value={head.remaining} unit={head.currency} size={48} />
            <T v="sub" style={{ fontSize: 15 }}>Left of {money(head.total)} · {money(head.settled)} spent · {money(head.committed)} held</T>
          </View>

          <Pressable onPress={() => router.push(`/chat/${encodeURIComponent(head.agentId)}`)} accessibilityRole="button"
            style={{ marginTop: 20, height: 52, borderRadius: 26, backgroundColor: active ? C.button : C.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Icon name="chat" size={19} color={active ? '#000' : C.text} width={2.2} /><T v="bodyStrong" style={{ color: active ? '#000' : C.text, fontSize: 17 }}>{active ? `Message ${head.agentId}` : 'See the conversation'}</T>
          </Pressable>
        </>
      ) : null}
      {head && !(m && data) ? <Loading /> : null}
      {m && data ? (
        <>

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
