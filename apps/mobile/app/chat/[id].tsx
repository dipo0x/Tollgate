import * as Haptics from 'expo-haptics'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionSheetIOS, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, TextInput, View } from 'react-native'
import type { ImagePickerOptions } from 'expo-image-picker'
import { photos, speech } from '../../src/lib/optional-native'
import Animated, { FadeIn, FadeInDown, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import { GatewayError, type AttachmentRefT, type Decision, type TaskT } from '../../src/api/gateway'
import { useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { loaders } from '../../src/state/loaders'
import { answeredBy } from '../../src/lib/format'
import { presenceOf } from '../../src/lib/presence'
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
type Line = { key: string; from: 'owner' | 'agent'; text: string; at: string; decisionId?: string; sending?: boolean; attachments?: AttachmentRefT[]; previews?: string[] }
/** A photo picked but not sent yet: already sealed on the gateway, shown here from the phone's own copy. */
type Staged = { ref: AttachmentRefT; uri: string }
const MAX_PHOTO_BYTES = 5 * 1024 * 1024

const SUGGESTIONS = ['What can you buy for me?', 'How much budget is left?', 'Buy the bridge cost brief']

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const now = useNow()
  const [draft, setDraft] = useState('')
  // While the owner is typing (the box is active, keyboard up) the suggestions get out of the way; they return when it closes.
  const [typing, setTyping] = useState(false)
  const [outbox, setOutbox] = useState<Line[]>([])
  const [staged, setStaged] = useState<Staged[]>([])
  const [uploading, setUploading] = useState(false)
  const [listening, setListening] = useState(false)
  const sendAfterVoice = useRef(false)
  const heard = useRef('')
  const [problem, setProblem] = useState<GatewayError | undefined>(undefined)
  const scroll = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null)

  const load = useCallback(() => loaders.chat(gw, id), [gw, id])
  // While a reply is on its way, look every 0.6 s; otherwise every 2.5 s.
  const [expecting, setExpecting] = useState(false)
  const { data, error, refresh } = usePoll(load, expecting ? 600 : 2500, `chat:${id}`)

  const saved = threadOf(data?.tasks ?? [])
  // A sent message shows at once; it disappears from the outbox when the gateway's copy arrives.
  const lines = [...saved, ...outbox.filter(o => !saved.some(s => s.from === 'owner' && s.text === o.text && s.at >= o.at.slice(0, 16)))]
  // Typing dots only while an answer is plausibly on its way; a message nobody collected, or one the agent went silent on, says so.
  const { presence: state } = presenceOf(data?.tasks ?? [], now)
  const thinking = state === 'thinking'
  useEffect(() => { setExpecting(thinking || outbox.length > 0) }, [thinking, outbox.length])
  const notListening = state === 'offline' || state === 'stalled' || data?.mode === 'hosted' && data.hostOnline === false
  // A hosted agent is answered by the owner's computer: when that is not answering agents at all, say so instead of "Online".
  const hostDown = data?.mode === 'hosted' && data.hostOnline === false
  const presence = !data ? '' : !data.active ? 'Not running' : hostDown ? 'Computer offline' : state === 'offline' ? 'Offline' : state === 'stalled' ? 'Not answering' : thinking ? 'Thinking…' : 'Online'

  useEffect(() => { setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 60) }, [lines.length, thinking])

  async function send(raw: string) {
    const text = raw.trim()
    const photos = staged
    if ((!text && photos.length === 0) || !data?.sendTo) return
    const pending: Line = { key: `out:${Date.now()}`, from: 'owner', text, at: new Date().toISOString(), sending: true, previews: photos.map(p => p.uri) }
    setOutbox(o => [...o, pending])
    setDraft('')
    setStaged([])
    setProblem(undefined)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    try {
      await gw.sendTask(data.sendTo, text, photos.map(p => p.ref.id))
      await refresh()
    } catch (e) {
      setDraft(text)
      setStaged(photos)
      setProblem(e instanceof GatewayError ? e : new GatewayError('Not sent. Try again.', 0))
    } finally {
      setOutbox(o => o.filter(x => x.key !== pending.key))
    }
  }

  const sendRef = useRef(send)
  sendRef.current = send

  // ---- photos: camera or library, sealed on the gateway as soon as they are picked ------------------------------------------
  function addPhoto() {
    ActionSheetIOS.showActionSheetWithOptions({ options: ['Take photo', 'Choose from library', 'Cancel'], cancelButtonIndex: 2 }, i => {
      if (i === 0) void pick('camera')
      if (i === 1) void pick('library')
    })
  }
  async function pick(from: 'camera' | 'library') {
    const ImagePicker = photos
    if (!ImagePicker) return
    const perm = from === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) { setProblem(new GatewayError(from === 'camera' ? 'Camera access is off. Turn it on in Settings → Tollgate.' : 'Photo access is off. Turn it on in Settings → Tollgate.', 0)); return }
    const opts: ImagePickerOptions = { mediaTypes: ['images'], quality: 0.6, base64: true, exif: false }
    const r = from === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts)
    const a = r.canceled ? undefined : r.assets[0]
    if (!a?.base64) return
    if (a.base64.length * 0.75 > MAX_PHOTO_BYTES) { setProblem(new GatewayError('That photo is over 5 MB. Try a smaller one.', 0)); return }
    setUploading(true)
    try {
      const ref = await gw.uploadAttachment({ name: a.fileName ?? `photo-${Date.now()}.jpg`, contentType: a.mimeType === 'image/png' ? 'image/png' : 'image/jpeg', base64: a.base64 })
      setStaged(s2 => [...s2, { ref, uri: a.uri }].slice(-4))
    } catch (e) {
      setProblem(e instanceof GatewayError ? e : new GatewayError('The photo was not added. Try again.', 0))
    } finally { setUploading(false) }
  }

  // ---- voice notes: the iPhone turns speech into text (on the phone when it can); tap the mic again and it is sent ------------
  useEffect(() => {
    const m = speech?.ExpoSpeechRecognitionModule
    if (!m) return
    const subs = [
      m.addListener('result', e => { const t = e.results[0]?.transcript ?? ''; heard.current = t; setDraft(t) }),
      m.addListener('end', () => {
        setListening(false)
        if (sendAfterVoice.current && heard.current.trim()) void sendRef.current(heard.current)
        sendAfterVoice.current = false
      }),
      m.addListener('error', e => { setListening(false); if (e.error !== 'aborted' && e.error !== 'no-speech') setProblem(new GatewayError(`Voice note didn’t work (${e.message || e.error}). Type instead, or try again.`, 0)) }),
    ]
    return () => subs.forEach(x => x.remove())
  }, [])
  async function toggleVoice() {
    const m = speech?.ExpoSpeechRecognitionModule
    if (!m) return
    if (listening) { sendAfterVoice.current = true; m.stop(); return }
    const perm = await m.requestPermissionsAsync()
    if (!perm.granted) { setProblem(new GatewayError('Microphone or speech access is off. Turn them on in Settings → Tollgate.', 0)); return }
    heard.current = ''; setDraft(''); setProblem(undefined)
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    m.start({ lang: 'en-US', interimResults: true, addsPunctuation: true, continuous: true, requiresOnDeviceRecognition: m.supportsOnDeviceRecognition() })
    setListening(true)
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
                  <Dot color={live ? C.green : notListening ? C.red : C.text3} />
                  <T v="small" style={{ fontSize: 13 }}>{presence}{data?.mode && data.active ? ` · ${answeredBy({ mode: data.mode, brain: data.brain })}` : ''}</T>
                </View>
              ) : null}
            </View>
            {data?.detailId ? <Circle icon="info" label="Details" onPress={() => router.push(`/agents/${encodeURIComponent(data.detailId!)}`)} /> : null}
          </View>
          <View style={{ paddingHorizontal: 16 }}><ErrorNote compact error={error} onRetry={() => void refresh()} /></View>

          <ScrollView ref={scroll as never} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 16, flexGrow: 1 }} keyboardDismissMode="interactive">
            {data && lines.length === 0 ? <Welcome agent={data.agent} active={data.active} onPick={t => void send(t)} /> : null}
            {lines.map((l, i) => {
              const prev = lines[i - 1], next = lines[i + 1]
              return (
                <View key={l.key}>
                  {!prev || day(prev.at) !== day(l.at) ? <DaySep iso={l.at} now={now} /> : null}
                  <Bubble line={l} first={!prev || prev.from !== l.from} last={!next || next.from !== l.from} now={now} photo={gw.attachmentDataUri} />
                  {l.decisionId ? <PaymentCard id={l.decisionId} d={data?.decisions.get(l.decisionId)} pending={data?.pending.has(l.decisionId) ?? false} rejected={data?.rejected.has(l.decisionId) ?? false} onOpen={openPayment} /> : null}
                </View>
              )
            })}
            {thinking && data?.active ? <Typing /> : null}
            {state === 'offline' ? (
              <Animated.View entering={FadeIn} style={{ marginTop: 14, padding: 14, borderRadius: R.card, backgroundColor: C.card, gap: 6 }}>
                <T v="bodyStrong" style={{ fontSize: 15 }}>{data?.agent ?? 'Your agent'} is offline</T>
                <T v="sub">{data?.mode === 'external' ? 'Your message is saved. Your own agent isn’t connected: open the agent’s page for its key and steps.' : 'Your message is saved and gets an answer as soon as your computer answers agents again. On your computer: pnpm live:app'}</T>
              </Animated.View>
            ) : null}
            {state === 'stalled' ? (
              <Animated.View entering={FadeIn} style={{ marginTop: 14, padding: 14, borderRadius: R.card, backgroundColor: C.card, gap: 6 }}>
                <T v="bodyStrong" style={{ fontSize: 15 }}>{data?.agent ?? 'Your agent'} stopped answering</T>
                <T v="sub">{data?.mode === 'external' ? 'Nothing is paid without your yes. Check that your own agent is still running, then send your message again.' : 'Nothing is paid without your yes. Send your message again once your computer answers agents: pnpm live:app'}</T>
              </Animated.View>
            ) : null}
          </ScrollView>

          {/* Hidden while the agent is actually answering, but shown again once it has clearly stopped listening: a message
              stuck in the queue would otherwise hide the suggestions for as long as the agent stays offline. */}
          {data?.active && lines.length > 0 && !thinking && !draft && !typing ? (
            // A sideways row gets no height of its own in this column, and iOS clipped the chips' tops and bottoms: give it one.
            <View style={{ height: 52 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16, alignItems: 'center' }}>
                {SUGGESTIONS.map(s => <Chip key={s} text={s} onPress={() => void send(s)} />)}
              </ScrollView>
            </View>
          ) : null}

          <View style={{ paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6, gap: 6 }}>
            {problem ? <T v="small" style={{ color: C.red, textAlign: 'center' }}>{problem.code === 'unreachable' || problem.code === 'timeout' ? 'Not sent: your computer didn’t answer. Tap send to try again.' : `Not sent: ${problem.message}`}</T> : null}
            {data && !data.active ? (
              <T v="sub" style={{ textAlign: 'center', paddingVertical: 12 }}>{data.agent} isn’t running right now. Your conversation is kept, and it carries on here when {data.agent} runs again.</T>
            ) : (
              <View style={{ gap: 8 }}>
                {staged.length || uploading ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 4 }}>
                    {staged.map(p => (
                      <View key={p.ref.id}>
                        <Image source={{ uri: p.uri }} style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: C.card2 }} />
                        <Pressable onPress={() => setStaged(s2 => s2.filter(x => x.ref.id !== p.ref.id))} accessibilityLabel="Remove photo" hitSlop={8}
                          style={{ position: 'absolute', top: -6, right: -6, width: 22, height: 22, borderRadius: 11, backgroundColor: C.card3, alignItems: 'center', justifyContent: 'center' }}>
                          <Icon name="x" size={12} width={2.4} />
                        </Pressable>
                      </View>
                    ))}
                    {uploading ? <View style={{ width: 64, height: 64, borderRadius: 14, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' }}><T v="small">Adding…</T></View> : null}
                  </ScrollView>
                ) : null}
                <Glass radius={26} style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 6, padding: 4 }}>
                  {photos ? <Pressable onPress={addPhoto} disabled={listening || uploading || staged.length >= 4} accessibilityLabel="Add a photo"
                    style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: pressed ? C.card2 : 'transparent', opacity: listening ? 0.4 : 1 })}>
                    <Icon name="plus" size={22} color={C.text2} width={2.2} />
                  </Pressable> : <View style={{ width: 8 }} />}
                  <TextInput value={draft} onChangeText={setDraft} editable={!listening} onFocus={() => setTyping(true)} onBlur={() => setTyping(false)}
                    placeholder={listening ? 'Listening… tap ■ to send' : `Message ${data?.agent ?? 'your agent'}`} placeholderTextColor={listening ? C.red : C.text3} multiline maxLength={500}
                    style={{ flex: 1, minHeight: 40, maxHeight: 120, backgroundColor: 'transparent', color: C.text, fontFamily: F.regular, fontSize: 16, paddingHorizontal: 6, paddingTop: 10, paddingBottom: 10 }} />
                  {draft.trim() || staged.length || !speech ? (
                    listening ? null : (
                      <Pressable onPress={() => void send(draft)} accessibilityLabel="Send"
                        style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: C.button, transform: [{ scale: pressed ? 0.92 : 1 }] })}>
                        <Icon name="send" size={19} color="#000" width={2.4} />
                      </Pressable>
                    )
                  ) : null}
                  {speech && (listening || !(draft.trim() || staged.length)) ? (
                    <Pressable onPress={() => void toggleVoice()} accessibilityLabel={listening ? 'Stop and send voice note' : 'Voice note'}
                      style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: listening ? C.red : C.card2, transform: [{ scale: pressed ? 0.92 : 1 }] })}>
                      <Icon name={listening ? 'stop' : 'mic'} size={19} color={listening ? '#fff' : C.text} width={2.2} />
                    </Pressable>
                  ) : null}
                </Glass>
              </View>
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
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ height: 40, justifyContent: 'center', paddingHorizontal: 16, borderRadius: R.pill, borderWidth: 1, borderColor: C.card3, backgroundColor: pressed ? C.card2 : 'transparent', alignItems: wide ? 'center' : undefined })}>
      <T v="sub" lines={1} style={{ color: C.text, fontSize: 15, lineHeight: 20 }}>{text}</T>
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
function Bubble({ line, first, last, now, photo }: { line: Line; first: boolean; last: boolean; now: number; photo: (id: string) => Promise<string> }) {
  const mine = line.from === 'owner'
  const tail = 6, round = 20
  return (
    <Animated.View entering={FadeInDown.duration(220)} style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginTop: first ? 10 : 3 }}>
      <View style={{
        maxWidth: '82%', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: mine ? C.button : C.card, opacity: line.sending ? 0.6 : 1,
        borderTopLeftRadius: !mine && !first ? tail : round, borderBottomLeftRadius: !mine && !last ? tail : round,
        borderTopRightRadius: mine && !first ? tail : round, borderBottomRightRadius: mine && !last ? tail : round,
      }}>
        {line.previews?.length || line.attachments?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: line.text ? 8 : 0 }}>
            {line.previews?.map(u => <Image key={u} source={{ uri: u }} style={{ width: 180, height: 180, borderRadius: 14 }} />)}
            {line.previews?.length ? null : line.attachments?.map(a => <Attachment key={a.id} a={a} load={photo} />)}
          </View>
        ) : null}
        {line.text ? <T selectable style={{ color: mine ? '#000' : C.text, fontSize: 16, lineHeight: 22 }}>{line.text}</T> : null}
      </View>
      {last ? <T v="small" style={{ fontSize: 11, marginTop: 4, marginHorizontal: 6, color: C.text3 }}>{line.sending ? 'Sending…' : clock(line.at, now)}</T> : null}
    </Animated.View>
  )
}

// Opened photos are kept in memory only, for this app session: never written to the phone's storage.
const opened = new Map<string, string>()

function Attachment({ a, load }: { a: AttachmentRefT; load: (id: string) => Promise<string> }) {
  const [uri, setUri] = useState(opened.get(a.id))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (uri || a.contentType === 'application/pdf') return
    let live = true
    load(a.id).then(u => { opened.set(a.id, u); if (live) setUri(u) }, () => { if (live) setFailed(true) })
    return () => { live = false }
  }, [a.id, a.contentType, load, uri])
  if (a.contentType === 'application/pdf' || failed) {
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.08)' }}><Icon name="doc" size={18} color={C.text2} /><T v="sub" lines={1} style={{ maxWidth: 160 }}>{failed ? 'Photo unavailable' : a.name}</T></View>
  }
  return uri ? <Image source={{ uri }} style={{ width: 180, height: 180, borderRadius: 14 }} /> : <View style={{ width: 180, height: 180, borderRadius: 14, backgroundColor: C.card2 }} />
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
    .flatMap(t => t.messages.map((m, i) => ({ key: `${t.id}:${i}`, from: m.from, text: m.text, at: m.at, ...(m.decisionId ? { decisionId: m.decisionId } : {}), ...(m.attachments?.length ? { attachments: m.attachments } : {}) })))
    .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
}
