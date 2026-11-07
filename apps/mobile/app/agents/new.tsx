import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated'
import { GatewayError } from '../../src/api/gateway'
import { parseUsd } from '../../src/lib/format'
import { confirmWithFace, useGateway } from '../../src/state/session'
import { usePoll } from '../../src/state/usePoll'
import { Card, Circle, ErrorNote, Icon, Label, Pill, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C, F } from '../../src/ui/theme'

const BUDGET_PICKS = [5, 10, 25, 50, 100]
const PER_PICKS = [1, 2, 5, 10]

/**
 * Add an agent from the phone. The one rule: it always starts with every payment needing the owner's yes (approval.above 0.00,
 * set in mandateForNewAgent, not by this screen). Auto-approving small payments is set on the computer. So a borrowed or stolen
 * phone can create an agent, but that agent cannot move money without the owner.
 */
export default function NewAgent() {
  const gw = useGateway()
  const load = useCallback(() => gw.services(), [gw])
  const { data: services, error } = usePoll(load, 30_000, 'services')
  const shops = (services ?? []).filter(s => s.enabled)
  const [name, setName] = useState('')
  // Typed as text so the owner can write any amount; parsed (parseUsd, tested) before anything is sent.
  const [budgetText, setBudgetText] = useState('10')
  const [perText, setPerText] = useState('2')
  const [hosts, setHosts] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [key, setKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => { if (hosts.length === 0 && shops.length > 0) setHosts([shops[0]!.host]) }, [shops.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const b = parseUsd(budgetText), p = parseUsd(perText)
  const budget = b.ok ? b.value : 0, per = p.ok ? p.value : 0
  const perTooBig = b.ok && p.ok && per > budget
  const ok = /^[a-z0-9][a-z0-9-]{1,23}$/.test(name) && hosts.length > 0 && b.ok && p.ok && !perTooBig

  async function create() {
    setProblem(null)
    const f = await confirmWithFace(`Add ${name}`)
    if (!f.ok) { setProblem(f.why === 'Cancelled.' ? null : f.why); return }
    setBusy(true)
    try {
      const r = await gw.addAgent({ name, budget: budget.toFixed(2), perPayment: per.toFixed(2), hosts, now: new Date() })
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setKey(r.agentToken)
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : 'Not added. Try again.')
    } finally { setBusy(false) }
  }

  if (key) {
    return (
      <Screen>
        <TopBar title="Agent added" />
        <Animated.View entering={FadeIn} style={{ marginTop: 30, alignItems: 'center', gap: 10 }}>
          <Animated.View entering={ZoomIn.springify()} style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: C.greenBg, alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={32} color={C.green} width={2.6} /></Animated.View>
          <T v="h1">{name} is ready</T>
          <T v="sub" style={{ fontSize: 15 }}>${budget.toFixed(2)} budget · ${per.toFixed(2)} max a payment</T>
        </Animated.View>
        <Card style={{ marginTop: 26 }}>
          <Row first title="Agent key" sub="Shown once. Put it in your agent’s Tollgate settings." right={
            <Pressable onPress={() => void Clipboard.setStringAsync(key).then(() => setCopied(true))} style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: C.button, justifyContent: 'center' }}><T v="bodyStrong" style={{ color: '#000', fontSize: 15 }}>{copied ? 'Copied' : 'Copy'}</T></Pressable>} />
        </Card>
        <T v="small" style={{ marginTop: 10, marginHorizontal: 4 }}>It can ask to pay right away. Nothing moves until you approve it.</T>
        <View style={{ flex: 1 }} />
        <Pill title="Done" onPress={() => router.back()} style={{ marginBottom: 12 }} />
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

  return (
    <Screen>
      <TopBar left={<Circle icon="x" label="Cancel" onPress={() => router.back()} />} title="Add an agent" />
      <Card style={{ marginTop: 18 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 12, gap: 4 }}>
          <T v="small">Name</T>
          <TextInput value={name} onChangeText={t => setName(t.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 24))} placeholder="research-agent" placeholderTextColor={C.text3}
            autoCapitalize="none" autoCorrect={false} style={{ color: C.text, fontFamily: F.regular, fontSize: 17, paddingVertical: 2 }} />
        </View>
      </Card>
      <Card style={{ marginTop: 12 }}>
        {amountField('Budget', 'Total it can ever spend', budgetText, setBudgetText, BUDGET_PICKS, budgetText && !b.ok ? b.why : null, true)}
        {amountField('Max per payment', 'No single payment above this', perText, setPerText, PER_PICKS,
          perText && !p.ok ? p.why : perTooBig ? 'Can’t be more than the budget.' : null)}
      </Card>
      <Label>Shops it may pay</Label>
      <ErrorNote error={error} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {shops.length === 0 && services ? <T v="sub">No shops are enabled yet. Enable one on your dashboard first.</T> : null}
        {shops.map(s => {
          const on = hosts.includes(s.host)
          return (
            <Pressable key={s.id} onPress={() => setHosts(h => on ? h.filter(x => x !== s.host) : [...h, s.host])} accessibilityRole="checkbox" accessibilityState={{ checked: on }}
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
      <Pill title="Create with Face ID" icon="face" busy={busy} disabled={!ok} onPress={() => void create()} style={{ marginBottom: 12 }} />
    </Screen>
  )
}
