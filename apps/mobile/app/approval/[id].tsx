import * as Haptics from 'expo-haptics'
import { router, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, View } from 'react-native'
import Animated, { FadeIn, ZoomIn } from 'react-native-reanimated'
import { GatewayError } from '../../src/api/gateway'
import { CHECK_NAME, checkSummary, shortId, timeLeft } from '../../src/lib/format'
import { confirmWithFace, useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { Amount, Card, Circle, Dot, ErrorNote, HoldButton, Icon, Loading, Pill, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C, R } from '../../src/ui/theme'

/**
 * Approve or reject one payment.
 *
 * The order is the safety: (1) a full hold, so a stray tap does nothing; (2) Face ID, so only the owner; (3) the gateway's own
 * approve call, which re-checks the decision is still pending under its lock. Only after the gateway says yes does the screen
 * say "Approved". If any step fails, nothing was approved and the screen says why.
 */
export default function Approval() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const now = useNow()
  const [phase, setPhase] = useState<'decide' | 'working' | 'approved' | 'rejected'>('decide')
  const [problem, setProblem] = useState<string | null>(null)
  const [showChecks, setShowChecks] = useState(false)

  const load = useCallback(async () => {
    const [approvals, status] = await Promise.all([gw.approvals(), gw.status()])
    const a = approvals.find(x => x.decisionId === id)
    const d = phase === 'approved' ? await gw.decision(id).catch(() => undefined) : undefined
    return { a, frozen: status.frozen, d }
  }, [gw, id, phase])
  const { data, error, loading, refresh } = usePoll(load, 3000)
  const a = data?.a
  const dec = a?.decision
  const sum = dec ? checkSummary(dec.checks) : undefined
  const expired = a ? Date.parse(a.expiresAt) <= now : false
  const canDecide = phase === 'decide' && a?.status === 'pending' && !expired && !data?.frozen

  async function approve() {
    setProblem(null)
    const face = await confirmWithFace(`Approve ${dec?.amount ?? ''} ${dec?.currency ?? ''}`.trim())
    if (!face.ok) { setProblem(face.why === 'Cancelled.' ? null : face.why); return }
    setPhase('working')
    try {
      await gw.approve(id, 'Approved on the owner’s phone with Face ID')
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      setPhase('approved'); void refresh()
    } catch (e) {
      setPhase('decide'); setProblem(e instanceof GatewayError ? e.message : 'Not approved. Try again.')
    }
  }

  function reject() {
    Alert.alert('Reject this payment?', 'The agent will not be able to pay this. Nothing is spent.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Reject', style: 'destructive', onPress: async () => {
        setPhase('working')
        try { await gw.reject(id, 'Rejected on the owner’s phone'); setPhase('rejected'); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning) }
        catch (e) { setPhase('decide'); setProblem(e instanceof GatewayError ? e.message : 'Not rejected. Try again.') }
      } },
    ])
  }

  const settled = data?.d?.state === 'settled'
  const notPaid = data?.d && ['released', 'expired', 'rejected'].includes(data.d.state)

  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Approve payment"
        right={a && a.status === 'pending' ? <View style={{ height: 32, paddingHorizontal: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.1)', justifyContent: 'center' }}><T v="bodyStrong" style={{ fontSize: 14, fontVariant: ['tabular-nums'] }}>{timeLeft(a.expiresAt, now)}</T></View> : undefined} />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {data && !a ? <T v="sub" style={{ marginTop: 40, textAlign: 'center' }}>This payment is no longer waiting. It may have been decided on the dashboard.</T> : null}

      {a && dec ? (
        <Animated.View entering={FadeIn}>
          <View style={{ marginTop: 22, alignItems: 'center', gap: 12 }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }}><Icon name="store" size={28} /></View>
            <T v="sub" style={{ fontSize: 16 }}>{dec.agentId} wants to pay</T>
            <Amount value={dec.amount} unit={dec.currency ?? ''} center />
          </View>

          <Card style={{ marginTop: 24 }}>
            <Row first title="For" right={<T lines={2} style={{ maxWidth: 200, textAlign: 'right' }}>{dec.purpose || '—'}</T>} />
            <Row title="Shop" right={<T lines={1} style={{ maxWidth: 200 }}>{dec.host}</T>} />
            <Row title="Pays into" right={<T v="sub" style={{ fontSize: 16 }}>{shortId(dec.depositAddress, 8, 6)}</T>} />
          </Card>

          <Pressable onPress={() => setShowChecks(v => !v)} accessibilityRole="button" accessibilityState={{ expanded: showChecks }} style={{ marginTop: 12, padding: 16, borderRadius: R.card, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Dot color={sum?.failed ? C.red : C.green} />
            <T style={{ flex: 1 }}>{sum ? `${sum.passed} of ${sum.total} checks passed` : ''}</T>
            <T v="sub">{showChecks ? 'Hide' : 'Show'}</T>
          </Pressable>
          {showChecks ? (
            <Card style={{ marginTop: 8, paddingVertical: 6 }}>
              {dec.checks.map(c => (
                <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 6 }}>
                  <Icon name={c.result === 'pass' ? 'check' : c.result === 'fail' ? 'x' : 'clock'} size={15} color={c.result === 'pass' ? C.green : c.result === 'fail' ? C.red : C.text2} width={2.4} />
                  <T style={{ flex: 1, fontSize: 15 }}>{CHECK_NAME[c.id] ?? c.name}</T>
                  <T v="small" style={{ color: C.text3 }}>{c.id}</T>
                </View>
              ))}
            </Card>
          ) : null}
        </Animated.View>
      ) : null}

      {problem ? <T v="sub" style={{ marginTop: 14, color: C.red, textAlign: 'center' }}>{problem}</T> : null}
      <View style={{ flex: 1 }} />

      <View style={{ paddingTop: 20, paddingBottom: 12, gap: 14 }}>
        {phase === 'approved' || phase === 'rejected' ? (
          <Animated.View entering={ZoomIn.springify()} style={{ alignItems: 'center', gap: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name={phase === 'approved' ? 'check' : 'x'} color={phase === 'approved' ? C.green : C.red} width={2.6} />
              <T v="bodyStrong" style={{ fontSize: 17, color: phase === 'approved' ? C.green : C.red }}>
                {phase === 'rejected' ? 'Rejected. Nothing was paid.' : settled ? 'Paid and settled' : notPaid ? 'Approved, but not paid' : 'Approved. The agent can pay now.'}
              </T>
            </View>
            <Pill title="Done" onPress={() => router.back()} style={{ alignSelf: 'stretch' }} />
          </Animated.View>
        ) : a?.status === 'pending' ? (
          <>
            {data?.frozen ? <T v="sub" style={{ textAlign: 'center' }}>Payments are frozen. Unfreeze to approve.</T> : expired ? <T v="sub" style={{ textAlign: 'center' }}>This request expired. Nothing was paid.</T> : null}
            <HoldButton disabled={!canDecide} onDone={() => void approve()} />
            <Pressable onPress={reject} disabled={!canDecide} style={{ alignSelf: 'center', padding: 8, opacity: canDecide ? 1 : 0.4 }}><T v="bodyStrong" style={{ color: C.red, fontSize: 17 }}>Reject</T></Pressable>
          </>
        ) : a ? <T v="sub" style={{ textAlign: 'center' }}>Already {a.status}.</T> : null}
      </View>
    </Screen>
  )
}
