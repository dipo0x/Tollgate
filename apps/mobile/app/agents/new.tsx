import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated'
import { GatewayError, MARKET_HOST, type AgentCreatedT } from '../../src/api/gateway'
import { connectKit } from '../../src/lib/connect'
import { parseUsd } from '../../src/lib/format'
import { confirmWithFace, useGateway, useSession } from '../../src/state/session'
import { usePoll } from '../../src/state/usePoll'
import { loaders } from '../../src/state/loaders'
import { ConnectKit, KitNote } from '../../src/ui/ConnectKit'
import { Card, Circle, ErrorNote, Icon, Label, Pill, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C, F } from '../../src/ui/theme'

const BUDGET_PICKS = [5, 10, 25, 50, 100]
const PER_PICKS = [0.25, 1, 2, 5]
const OWN = 'own' // the choice "my own agent"; every other choice is the id of a brain the computer offers, or '' for its default

/**
 * A new chat. An agent is a chat room with a name: pick who answers it, give it a budget, and you are in the conversation.
 *
 *   - A brain from your computer (Claude, Grok, a local model, your own OpenAI-compatible server): nothing to set up. The agent host
 *     on your computer answers it. The phone sends the brain's NAME; keys and addresses stay on the computer.
 *   - Your own agent: you get a key, once, to plug into whatever you built or use. It answers over the same web API.
 *
 * The one rule: every payment starts out needing the owner's yes (approval.above 0.00, set in mandateForNewAgent, not here). Auto-approving
 * small payments is set on the computer. A borrowed phone can start a chat, but that agent cannot move money without the owner.
 */
export default function NewChat() {
  const gw = useGateway()
  const { url } = useSession()
  const loadServices = useCallback(() => loaders.services(gw), [gw])
  const { data: services, error } = usePoll(loadServices, 30_000, 'services')
  const loadBrains = useCallback(() => loaders.brains(gw), [gw])
  const { data: brains } = usePoll(loadBrains, 10_000, 'brains')
  // Shops registered individually; the market's sellers are one switch below, so they are not listed one by one.
  const shops = (services ?? []).filter(s => s.enabled && !s.host.endsWith('.market.near.ai'))

  const [name, setName] = useState('')
  const [choice, setChoice] = useState<string | null>(null) // null until the brains have loaded and a default is picked
  const [budgetText, setBudgetText] = useState('5')
  const [perText, setPerText] = useState('0.25')
  const [hosts, setHosts] = useState<string[] | null>(null) // null: not touched, all enabled shops
  const [market, setMarket] = useState(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [made, setMade] = useState<AgentCreatedT | null>(null)

  // The default answer: the first brain the computer offers; with none, the computer's own default.
  useEffect(() => { if (choice === null && brains) setChoice(brains.brains[0]?.id ?? '') }, [brains, choice])
  const chosen = hosts ?? shops.map(s => s.host)
  const allHosts = [...chosen, ...(market ? [MARKET_HOST] : [])]
  const b = parseUsd(budgetText), p = parseUsd(perText)
  const budget = b.ok ? b.value : 0, per = p.ok ? p.value : 0
  const perTooBig = b.ok && p.ok && per > budget
  const ok = /^[a-z0-9][a-z0-9-]{1,23}$/.test(name) && choice !== null && allHosts.length > 0 && b.ok && p.ok && !perTooBig && budget > 0 && per > 0

  async function create() {
    setProblem(null)
    const f = await confirmWithFace(`Start ${name}`)
    if (!f.ok) { setProblem(f.why === 'Cancelled.' ? null : f.why); return }
    setBusy(true)
    try {
      const who = choice === OWN ? { mode: 'external' as const } : { mode: 'hosted' as const, brain: choice || null }
      const r = await gw.createAgent({ name, budget: budget.toFixed(2), perPayment: per.toFixed(2), hosts: allHosts, now: new Date() }, who)
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      // A chat room: go straight into it. Only an agent you bring yourself stops first, to hand you its key.
      if (r.agent.mode === 'hosted') router.replace(`/chat/${encodeURIComponent(name)}`)
      else setMade(r)
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : 'Not started. Try again.')
    } finally { setBusy(false) }
  }

  if (made?.agentToken) {
    const kit = connectKit({ url: url ?? '', key: made.agentToken, name, mandateId: made.mandate.id })
    return (
      <Screen>
        <TopBar title="Connect your agent" />
        <Animated.View entering={FadeIn} style={{ marginTop: 26, alignItems: 'center', gap: 10 }}>
          <Animated.View entering={ZoomIn.springify()} style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.greenBg, alignItems: 'center', justifyContent: 'center' }}><Icon name="key" size={30} color={C.green} width={2.4} /></Animated.View>
          <T v="h1">{name} is ready</T>
          <T v="sub" style={{ fontSize: 15, textAlign: 'center' }}>${budget.toFixed(2)} budget · ${per.toFixed(2)} max a payment. Give it the key below and it answers in the chat.</T>
        </Animated.View>
        <Label>Plug it in</Label>
        <ConnectKit kit={kit} />
        <KitNote />
        <View style={{ flex: 1, minHeight: 24 }} />
        <Pill title="Open the chat" onPress={() => router.replace(`/chat/${encodeURIComponent(name)}`)} style={{ marginBottom: 12 }} />
      </Screen>
    )
  }

  /** A typed dollar amount with quick picks underneath. The pick matching the current amount is highlighted. */
  const amountField = (label: string, hint: string, text: string, set: (t: string) => void, picks: number[], problemText: string | null, first?: boolean) => {
    const cur = parseUsd(text)
    return (
      <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 10, borderTopWidth: first ? 0 : 1, borderTopColor: C.sep }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}><T>{label}</T><T v="small">{hint}</T></View>
          <View style={{ flexDirection: 'row', alignItems: 'center', height: 44, paddingHorizontal: 12, borderRadius: 12, backgroundColor: C.card2, minWidth: 116 }}>
            <T v="bodyStrong" style={{ fontSize: 18, color: C.text2 }}>$</T>
            <TextInput value={text} onChangeText={t => set(t.replace(/[^0-9.]/g, '').slice(0, 10))} keyboardType="decimal-pad" inputMode="decimal" selectTextOnFocus
              accessibilityLabel={`${label} in dollars`} placeholder="0" placeholderTextColor={C.text3}
              style={{ flex: 1, marginLeft: 4, color: C.text, fontFamily: F.semibold, fontSize: 18, textAlign: 'right', fontVariant: ['tabular-nums'], paddingVertical: 0 }} />
          </View>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {picks.map(v => {
            const on = cur.ok && cur.value === v
            return (
              <Pressable key={v} onPress={() => set(String(v))} accessibilityRole="button" accessibilityLabel={`${label} $${v}`}
                style={{ height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: on ? C.button : C.card2, justifyContent: 'center' }}>
                <T v="bodyStrong" style={{ fontSize: 14, color: on ? '#000' : C.text }}>${v}</T>
              </Pressable>
            )
          })}
        </View>
        {problemText ? <T v="small" style={{ color: C.red }}>{problemText}</T> : null}
      </View>
    )
  }

  const offered = brains?.brains ?? []
  const choiceRow = (id: string, title: string, sub: string, first: boolean) => {
    const on = choice === id
    return (
      <Row key={id || 'default'} first={first} title={title} sub={sub} onPress={() => setChoice(id)} chevron={false}
        right={<View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: on ? C.button : C.card3, alignItems: 'center', justifyContent: 'center' }}>{on ? <View style={{ width: 11, height: 11, borderRadius: 6, backgroundColor: C.button }} /> : null}</View>} />
    )
  }

  return (
    <Screen>
      <TopBar left={<Circle icon="x" label="Cancel" onPress={() => router.back()} />} title="New chat" />
      <Card style={{ marginTop: 18 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
          <T v="small">Name</T>
          <TextInput value={name} onChangeText={t => setName(t.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24))} placeholder="trip-planner" placeholderTextColor={C.text3}
            autoCapitalize="none" autoCorrect={false} style={{ color: C.text, fontFamily: F.regular, fontSize: 17, paddingVertical: 2 }} />
        </View>
      </Card>

      <Label>Who answers</Label>
      <Card>
        {offered.length === 0 ? choiceRow('', 'This computer', 'Its default brain', true) : offered.map((x, i) => choiceRow(x.id, x.label, x.detail, i === 0))}
        {choiceRow(OWN, 'My own agent', 'Claude, Grok, ChatGPT, or one you built: connect it with a key', false)}
      </Card>
      {choice !== OWN && brains && !brains.online ? (
        <View style={{ marginTop: 10, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
          <Icon name="info" size={16} color={C.text2} /><T v="small" style={{ flex: 1 }}>Your computer isn’t answering agents right now. Start it with pnpm live:app. Your messages are kept and answered when it starts.</T>
        </View>
      ) : null}

      <Card style={{ marginTop: 18 }}>
        {amountField('Budget', 'Total it can ever spend', budgetText, setBudgetText, BUDGET_PICKS, budgetText && !b.ok ? b.why : null, true)}
        {amountField('Max per payment', 'No single payment above this', perText, setPerText, PER_PICKS,
          perText && !p.ok ? p.why : perTooBig ? 'Can’t be more than the budget.' : null)}
      </Card>

      <Label>Shops it may pay</Label>
      <ErrorNote error={error} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Pressable onPress={() => setMarket(m => !m)} accessibilityRole="checkbox" accessibilityState={{ checked: market }}
          style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 18, backgroundColor: market ? C.button : C.card, justifyContent: 'center' }}>
          <T v="bodyStrong" style={{ fontSize: 15, color: market ? '#000' : C.text }}>NEAR AI Agent Market</T>
          <T v="small" style={{ fontSize: 12, color: market ? '#3A3A3C' : C.text2 }}>Hire independent agents</T>
        </Pressable>
        {shops.map(s => {
          const on = chosen.includes(s.host)
          return (
            <Pressable key={s.id} onPress={() => setHosts(on ? chosen.filter(x => x !== s.host) : [...chosen, s.host])} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
              style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: 18, backgroundColor: on ? C.button : C.card, justifyContent: 'center' }}>
              <T v="bodyStrong" style={{ fontSize: 15, color: on ? '#000' : C.text }}>{s.name}</T>
              <T v="small" style={{ fontSize: 12, color: on ? '#3A3A3C' : C.text2 }}>{s.host}</T>
            </Pressable>
          )
        })}
      </View>

      <Card style={{ marginTop: 20 }}>
        <Row first icon="face" title="Every payment needs your yes" sub="Auto-approving small payments is set on your computer" />
      </Card>
      {problem ? <T v="sub" style={{ marginTop: 12, color: C.red, textAlign: 'center' }}>{problem}</T> : null}
      <View style={{ flex: 1, minHeight: 24 }} />
      <Pill title="Start chat with Face ID" icon="face" busy={busy} disabled={!ok} onPress={() => void create()} style={{ marginBottom: 12 }} />
    </Screen>
  )
}
