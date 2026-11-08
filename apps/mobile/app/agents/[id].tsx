import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { ActionSheetIOS, Alert, Pressable, View } from 'react-native'
import { GatewayError, type MandateRow } from '../../src/api/gateway'
import { connectKit, type Kit } from '../../src/lib/connect'
import { agentState, answeredBy, kindOf, KIND_LABEL, money, when } from '../../src/lib/format'
import { useGateway, useSession } from '../../src/state/session'
import { peekScreen, useNow, usePoll } from '../../src/state/usePoll'
import { loaders } from '../../src/state/loaders'
import { ConnectKit, KitNote } from '../../src/ui/ConnectKit'
import { Amount, Card, Circle, Dot, ErrorNote, Glyph, Icon, KindIcon, Label, Loading, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** One agent: what it has left, the rules it works under, and what it did. The owner can stop it for good from here. */
export default function AgentDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const { url } = useSession()
  const now = useNow()
  const [problem, setProblem] = useState<string | null>(null)
  const [kit, setKit] = useState<Kit | null>(null) // a fresh key's instructions, shown once
  const load = useCallback(() => loaders.agent(gw, id), [gw, id])
  const { data, error, loading, refresh } = usePoll(load, 6000, `agent:${id}`)
  const m = data?.mandate
  // Drawn at once from the Agents list's row while the full rules load, so tapping an agent never shows a blank screen.
  const row = peekScreen<{ mandates: MandateRow[] }>('agents')?.mandates.find(r => r.id === id)
  const head = m && data
    ? { agentId: m.agentId, validUntil: m.validUntil, status: data.status, currency: m.budget.currency, total: m.budget.total, remaining: data.balance?.remaining, settled: data.balance?.settled, committed: data.balance?.committed }
    : row ? { agentId: row.agentId, validUntil: row.validUntil, status: row.status, currency: row.currency, total: row.balance?.total, remaining: row.balance?.remaining, settled: row.balance?.settled, committed: row.balance?.committed } : undefined
  const active = head?.status === 'active'
  const askAlways = m ? Number(m.approval.above) === 0 : false

  const who = data?.row ?? row
  const external = who?.mode === 'external'

  /** Choose another brain on this computer for the agent (or hand an agent of your own back to it). */
  async function pickBrain() {
    setProblem(null)
    let offered: { id: string; label: string }[] = []
    try { offered = (await gw.brains()).brains } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'Could not ask your computer. Try again.'); return }
    const options = [...offered.map(b => b.label), 'This computer’s default', 'Cancel']
    ActionSheetIOS.showActionSheetWithOptions({ title: 'Who answers this chat?', options, cancelButtonIndex: options.length - 1 }, async i => {
      if (i === options.length - 1) return
      const brain = i < offered.length ? offered[i]!.id : null
      try { await gw.setAgent(m?.agentId ?? head?.agentId ?? '', { mode: 'hosted', brain }); await refresh() } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'Not changed. Try again.') }
    })
  }

  /** A new key for an agent you run yourself; the old one stops working at once. */
  function newKey() {
    Alert.alert('Get a new key?', 'The old key stops working at once. Your agent needs the new one to keep answering.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Get new key', onPress: async () => {
        try { const key = await gw.newKey(m!.agentId); setKit(connectKit({ url: url ?? '', key, name: m!.agentId, mandateId: id })) } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'No new key. Try again.') }
      } },
    ])
  }

  /** Switch a hosted agent to your own program: a key is made, once. */
  function useOwnAgent() {
    Alert.alert('Answer with your own agent?', 'Your computer stops answering this chat. You get a key to plug your own agent in.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Get key', onPress: async () => {
        try { const r = await gw.setAgent(m!.agentId, { mode: 'external' }); if (r.agentToken) setKit(connectKit({ url: url ?? '', key: r.agentToken, name: m!.agentId, mandateId: id })); await refresh() } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'Not changed. Try again.') }
      } },
    ])
  }

  function remove() {
    Alert.alert(`Remove ${m?.agentId ?? 'this agent'} from your list?`, 'Its conversation and payment records stay. Starting an agent with the same name brings the chat back.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: async () => {
        try { await gw.archiveAgent(m!.agentId); router.back() } catch (e) { setProblem(e instanceof GatewayError ? e.message : 'Not removed. Try again.') }
      } },
    ])
  }

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

          {active ? (
            <>
              <Label>Answered by</Label>
              <Card>
                <Row first title={answeredBy(who ?? {})} sub={external ? 'Your own program, with a key' : 'The agent host on your computer'} onPress={external ? undefined : () => void pickBrain()} right={external ? undefined : <T v="sub">Change</T>} chevron={false} />
                {external ? <Row title="Get a new key" sub="Replaces the old one at once" onPress={newKey} /> : null}
                {external ? <Row title="Let this computer answer instead" sub="Pick a brain on your computer" onPress={() => void pickBrain()} /> : null}
                {who?.mode === 'hosted' ? <Row title="Use my own agent" sub="Claude, Grok, ChatGPT or one you built" onPress={useOwnAgent} /> : null}
              </Card>
              {kit ? <><Label>Plug it in</Label><ConnectKit kit={kit} /><KitNote /></> : null}
            </>
          ) : null}

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
          {!active ? (
            <Card style={{ marginTop: 24 }}>
              <Row first icon="x" title="Remove from my list" sub="The conversation and records stay" chevron={false} onPress={remove} />
            </Card>
          ) : null}
          {problem ? <T v="sub" style={{ marginTop: 12, color: C.red, textAlign: 'center' }}>{problem}</T> : null}
        </>
      ) : null}
    </Screen>
  )
}
