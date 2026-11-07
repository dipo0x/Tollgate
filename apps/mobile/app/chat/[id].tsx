import * as Haptics from 'expo-haptics'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { GatewayError, type Decision, type TaskT } from '../../src/api/gateway'
import { useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { Glass } from '../../src/ui/Glass'
import { Circle, Dot, ErrorNote, Glyph, Icon, T } from '../../src/ui/kit'
import { C, F, R } from '../../src/ui/theme'

/**
 * Text your agent. Each message becomes a task in the gateway's inbox; the agent collects it and answers in the same thread.
 * A payment it wants shows up as a card in the chat, and approving it still goes through the Approve screen (hold, then Face ID).
 *
 * The phone never talks to the agent directly: both only talk to your gateway, so the agent can run wherever you choose.
 * `id` is the agent's NAME: one conversation across all its runs, so coming back always continues where you left off.
 */
type Line = { key: string; from: 'owner' | 'agent'; text: string; at: string; decisionId?: string; sending?: boolean }

// A message nobody has collected for this long means the agent is not running.
const UNANSWERED_MS = 20_000
const SUGGESTIONS = ['What can you buy for me?', 'How much budget is left?', 'Buy the bridge cost brief']

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const now = useNow()
  const [draft, setDraft] = useState('')
  const [outbox, setOutbox] = useState<Line[]>([])
  const [problem, setProblem] = useState<GatewayError | undefined>(undefined)
  const scroll = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null)

  const load = useCallback(async () => {
    const [c, approvals, decisions] = await Promise.all([gw.conversation(id), gw.approvals().catch(() => []), gw.decisions(100).catch(() => [])])
    return {
      tasks: c.tasks, agent: c.agentId, sendTo: c.runningMandateId, active: !!c.runningMandateId,
      pending: new Set(approvals.filter(a => a.status === 'pending').map(a => a.decisionId)),
      rejected: new Set(approvals.filter(a => a.status === 'rejected').map(a => a.decisionId)),
      decisions: new Map<string, Decision>([...decisions.map(d => [d.decisionId, d] as const), ...approvals.map(a => [a.decisionId, a.decision] as const)]),
    }
  }, [gw, id])
  const { data, error, refresh } = usePoll(load, 2500, `chat:${id}`)

  const saved = threadOf(data?.tasks ?? [])
  // A sent message shows at once; it disappears from the outbox when the gateway's copy arrives.
  const lines = [...saved, ...outbox.filter(o => !saved.some(s => s.from === 'owner' && s.text === o.text && s.at >= o.at.slice(0, 16)))]
  const waiting = (data?.tasks ?? []).find(t => t.status === 'queued' || t.status === 'working')
  const notListening = waiting?.status === 'queued' && now - Date.parse(waiting.createdAt) > UNANSWERED_MS
  const presence = !data ? '' : !data.active ? 'Not running' : notListening ? 'Offline' : waiting ? 'Thinking…' : 'Online'

  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60) }, [lines.length, Boolean(waiting)])

  async function send(raw: string) {
    const text = raw.trim()
    if (!text || !data?.sendTo) return
    const pending: Line = { key: `out:${Date.now()}`, from: 'owner', text, at: new Date().toISOString(), sending: true }
    setOutbox(o => [...o, pending])
    setDraft('')
    setProblem(undefined)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    try {
      await gw.sendTask(data.sendTo, text)
      await refresh()
    } catch (e) {
      setDraft(text)
      setProblem(e instanceof GatewayError ? e : new GatewayError('Not sent. Try again.', 0))
    } finally {
      setOutbox(o => o.filter(x => x.key !== pending.key))
    }
  }

  function openPayment(decisionId: string) {
    router.push(data?.pending.has(decisionId) ? `/approval/${encodeURIComponent(decisionId)}` : `/decision/${encodeURIComponent(decisionId)}`)
  }

  const live = presence === 'Online' || presence === 'Thinking…'
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.sep }}>
            <Circle icon="back" label="Back" onPress={() => router.back()} />
            <Avatar size={40} />
            <View style={{ flex: 1, gap: 2 }}>
              <T v="bodyStrong" lines={1} style={{ fontSize: 17 }}>{data?.agent ?? 'Agent'}</T>
              {presence ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Dot color={live ? C.green : presence === 'Offline' ? C.red : C.text3} />
                  <T v="small" style={{ fontSize: 13 }}>{presence}</T>
                </View>
              ) : null}
            </View>
          </View>
          <View style={{ paddingHorizontal: 16 }}><ErrorNote compact error={error} onRetry={() => void refresh()} /></View>

          <ScrollView ref={scroll as never} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16, flexGrow: 1 }} keyboardDismissMode="interactive">
            {data && lines.length === 0 ? <Welcome agent={data.agent} active={data.active} onPick={t => void send(t)} /> : null}
            {lines.map((l, i) => {
              const prev = lines[i - 1], next = lines[i + 1]
              return (
                <View key={l.key}>
                  {!prev || day(prev.at) !== day(l.at) ? <DaySep iso={l.at} now={now} /> : null}
                  <Bubble line={l} first={!prev || prev.from !== l.from} last={!next || next.from !== l.from} now={now} />
                  {l.decisionId ? <PaymentCard id={l.decisionId} d={data?.decisions.get(l.decisionId)} pending={data?.pending.has(l.decisionId) ?? false} rejected={data?.rejected.has(l.decisionId) ?? false} onOpen={openPayment} /> : null}
                </View>
              )
            })}
            {waiting && !notListening && data?.active ? <Typing /> : null}
            {notListening ? (
              <Animated.View entering={FadeIn} style={{ marginTop: 14, padding: 14, borderRadius: R.card, backgroundColor: C.card, gap: 6 }}>
                <T v="bodyStrong" style={{ fontSize: 15 }}>{data?.agent ?? 'Your agent'} is offline</T>
                <T v="sub">Your message is saved and gets an answer as soon as the agent runs. On your computer: pnpm live:app</T>
              </Animated.View>
            ) : null}
          </ScrollView>

          {data?.active && lines.length > 0 && !waiting && !draft ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 8 }} style={{ flexGrow: 0 }}>
              {SUGGESTIONS.map(s => <Chip key={s} text={s} onPress={() => void send(s)} />)}
            </ScrollView>
          ) : null}

          <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 6 }}>
            {problem ? <T v="small" style={{ color: C.red, textAlign: 'center' }}>{problem.code === 'unreachable' || problem.code === 'timeout' ? 'Not sent: your computer didn’t answer. Tap send to try again.' : `Not sent: ${problem.message}`}</T> : null}
            {data && !data.active ? (
              <T v="sub" style={{ textAlign: 'center', paddingVertical: 12 }}>{data.agent} isn’t running right now. Your conversation is kept, and it carries on here when {data.agent} runs again.</T>
            ) : (
              <Glass radius={26} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 4 }}>
                <TextInput value={draft} onChangeText={setDraft} placeholder={`Message ${data?.agent ?? 'your agent'}`} placeholderTextColor={C.text3} multiline maxLength={500}
                  style={{ flex: 1, minHeight: 40, maxHeight: 120, backgroundColor: 'transparent', color: C.text, fontFamily: F.regular, fontSize: 16, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10 }} />
                <Pressable onPress={() => void send(draft)} disabled={!draft.trim()} accessibilityLabel="Send"
                  style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: draft.trim() ? C.button : C.card2, transform: [{ scale: pressed ? 0.92 : 1 }] })}>
                  <Icon name="send" size={19} color={draft.trim() ? '#000' : C.text3} width={2.4} />
                </Pressable>
              </Glass>
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  )
}

function Avatar({ size }: { size: number }) {
  return <View style={{ width: size, height: size, borderRadius: size * 0.32, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' }}><Glyph size={size * 0.5} /></View>
}

function Welcome({ agent, active, onPick }: { agent: string; active: boolean; onPick: (t: string) => void }) {
  return (
    <Animated.View entering={FadeInDown.duration(400)} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingHorizontal: 12 }}>
      <Avatar size={72} />
      <T v="h2" style={{ textAlign: 'center' }}>{agent}</T>
      <T v="sub" style={{ textAlign: 'center', lineHeight: 20 }}>Ask it anything. It only buys when you ask, and every payment waits for your yes with Face ID.</T>
      {active ? <View style={{ gap: 8, marginTop: 8, alignSelf: 'stretch' }}>{SUGGESTIONS.map(s => <Chip key={s} text={s} onPress={() => onPick(s)} wide />)}</View> : null}
    </Animated.View>
  )
}

function Chip({ text, onPress, wide }: { text: string; onPress: () => void; wide?: boolean }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ paddingVertical: 10, paddingHorizontal: 14, borderRadius: R.pill, borderWidth: 1, borderColor: C.card3, backgroundColor: pressed ? C.card2 : 'transparent', alignItems: wide ? 'center' : undefined })}>
      <T v="sub" style={{ color: C.text, fontSize: 15 }}>{text}</T>
    </Pressable>
  )
}

function DaySep({ iso, now }: { iso: string; now: number }) {
  const label = day(iso) === day(new Date(now).toISOString()) ? 'Today'
    : day(iso) === day(new Date(now - 86_400_000).toISOString()) ? 'Yesterday'
    : new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  return <T v="small" style={{ textAlign: 'center', fontSize: 12, marginVertical: 12, color: C.text3 }}>{label}</T>
}

/** Consecutive messages from the same side are grouped: tighter spacing, a tail only at the end, one time stamp. */
function Bubble({ line, first, last, now }: { line: Line; first: boolean; last: boolean; now: number }) {
  const mine = line.from === 'owner'
  const tail = 6, round = 20
  return (
    <Animated.View entering={FadeInDown.duration(220)} style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginTop: first ? 10 : 3 }}>
      <View style={{
        maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: mine ? C.button : C.card, opacity: line.sending ? 0.6 : 1,
        borderTopLeftRadius: !mine && !first ? tail : round, borderBottomLeftRadius: !mine && !last ? tail : round,
        borderTopRightRadius: mine && !first ? tail : round, borderBottomRightRadius: mine && !last ? tail : round,
      }}>
        <T selectable style={{ color: mine ? '#000' : C.text, fontSize: 16, lineHeight: 22 }}>{line.text}</T>
      </View>
      {last ? <T v="small" style={{ fontSize: 11, marginTop: 4, marginHorizontal: 6, color: C.text3 }}>{line.sending ? 'Sending…' : clock(line.at, now)}</T> : null}
    </Animated.View>
  )
}

function PaymentCard({ id, d, pending, rejected, onOpen }: { id: string; d: Decision | undefined; pending: boolean; rejected: boolean; onOpen: (id: string) => void }) {
  const s = paymentState(d, pending, rejected)
  return (
    <Animated.View entering={FadeInDown.duration(260)} style={{ alignSelf: 'flex-start', width: '82%', marginTop: 6, padding: 14, borderRadius: R.card, backgroundColor: C.card, borderWidth: 1, borderColor: pending ? 'rgba(255,255,255,0.18)' : C.sep, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <T v="small" style={{ fontSize: 12, letterSpacing: 0.6, color: C.text3 }}>PAYMENT</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Dot color={s.color} /><T v="small" style={{ fontSize: 13, color: s.color === C.text3 ? C.text2 : s.color }}>{s.label}</T></View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <T style={{ fontFamily: F.bold, fontSize: 30, letterSpacing: -0.5 }}>{d?.amount ? Number(d.amount).toFixed(2) : '—'}</T>
        <T v="sub">{d?.currency ?? 'USDC'}</T>
      </View>
      {d ? <T v="sub" lines={1}>{d.host}{d.purpose ? ` · ${d.purpose}` : ''}</T> : null}
      <Pressable onPress={() => onOpen(id)} style={({ pressed }) => ({ height: 42, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: pending ? C.button : C.card2, opacity: pressed ? 0.8 : 1 })}>
        <T v="bodyStrong" style={{ fontSize: 15, color: pending ? '#000' : C.text }}>{pending ? 'Review and approve' : 'See details'}</T>
      </Pressable>
    </Animated.View>
  )
}

function Typing() {
  return (
    <Animated.View entering={FadeIn} style={{ alignSelf: 'flex-start', marginTop: 10, flexDirection: 'row', gap: 5, paddingHorizontal: 16, paddingVertical: 14, borderRadius: 20, backgroundColor: C.card }}>
      {[0, 1, 2].map(i => <TypingDot key={i} delay={i * 160} />)}
    </Animated.View>
  )
}

function TypingDot({ delay }: { delay: number }) {
  const o = useSharedValue(0.3)
  useEffect(() => { o.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 380 }), withTiming(0.3, { duration: 380 })), -1)) }, [delay, o])
  const style = useAnimatedStyle(() => ({ opacity: o.value, transform: [{ translateY: (1 - o.value) * 2 }] }))
  return <Animated.View style={[{ width: 7, height: 7, borderRadius: 4, backgroundColor: C.text2 }, style]} />
}

/** What a payment card says. Only the gateway's records decide it: a card never says Paid unless the decision is settled. */
export function paymentState(d: Decision | undefined, pending: boolean, rejected: boolean): { label: string; color: string } {
  if (pending) return { label: 'Waiting for you', color: C.text }
  if (rejected) return { label: 'You said no', color: C.text3 }
  if (!d) return { label: 'Checking…', color: C.text3 }
  if (d.decision === 'DENY') return { label: 'Blocked by Tollgate', color: C.red }
  if (d.state === 'settled') return { label: 'Paid', color: C.green }
  if (d.state === 'expired') return { label: 'Expired, not paid', color: C.text3 }
  return { label: 'Approved', color: C.green }
}

const day = (iso: string) => iso.slice(0, 10)
const clock = (iso: string, now: number) => (now - Date.parse(iso) < 60_000 ? 'Just now' : new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))

/** Every task's messages, oldest first, as one conversation. */
export function threadOf(tasks: readonly TaskT[]): Line[] {
  return tasks
    .flatMap(t => t.messages.map((m, i) => ({ key: `${t.id}:${i}`, from: m.from, text: m.text, at: m.at, ...(m.decisionId ? { decisionId: m.decisionId } : {}) })))
    .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
}
