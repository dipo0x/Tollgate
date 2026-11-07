import { router, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { View } from 'react-native'
import { CHECK_NAME, kindOf, KIND_LABEL, shortId, when } from '../../src/lib/format'
import { useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { Amount, Card, Circle, ErrorNote, Icon, KindIcon, Loading, Row, Screen, T, TopBar } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** One decision, explained: what was asked, what Tollgate decided, and which check said so, with its evidence. */
export default function DecisionDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const gw = useGateway()
  const now = useNow()
  const load = useCallback(() => gw.decision(id), [gw, id])
  const { data: d, error, loading, refresh } = usePoll(load, 8000, `decision:${id}`)
  const k = d ? kindOf(d) : undefined
  const failed = d?.checks.find(c => c.id === d.failedCheck) ?? d?.checks.find(c => c.result === 'fail')
  const reason = failed?.evidence && typeof failed.evidence['reason'] === 'string' ? (failed.evidence['reason'] as string) : d?.reason

  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title={k ? KIND_LABEL[k] : ''} />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !d ? <Loading /> : null}
      {d && k ? (
        <>
          <View style={{ marginTop: 26, alignItems: 'center', gap: 12 }}>
            <KindIcon kind={k} size={72} />
            <Amount value={d.amount} unit={d.currency ?? ''} size={48} center />
            <T v="sub" style={{ fontSize: 16, textAlign: 'center' }}>{d.purpose || d.host}</T>
          </View>
          {failed || reason ? (
            <Card style={{ marginTop: 24, padding: 16, gap: 8 }}>
              <T v="h2">Why</T>
              <T v="sub" style={{ fontSize: 15, lineHeight: 21 }}>{reason ?? `${CHECK_NAME[failed!.id] ?? failed!.name} did not pass.`}</T>
            </Card>
          ) : null}
          <Card style={{ marginTop: 12 }}>
            <Row first title="Agent" right={<T>{d.agentId}</T>} />
            <Row title="Shop" right={<T lines={1} style={{ maxWidth: 200 }}>{d.host}</T>} />
            {failed ? <Row title="Check" right={<T>{failed.id} · {CHECK_NAME[failed.id] ?? failed.name}</T>} /> : null}
            <Row title="When" right={<T v="sub" style={{ fontSize: 16 }}>{when(d.createdAt, now)}</T>} />
            <Row title="Decision" right={<T v="sub" style={{ fontSize: 16 }}>{shortId(d.decisionId, 8, 4)}</T>} />
          </Card>
          {k === 'blocked' || k === 'rejected' ? (
            <View style={{ marginTop: 12, padding: 16, borderRadius: 22, backgroundColor: C.card, flexDirection: 'row', gap: 10, alignItems: 'center' }}>
              <Icon name="check" size={18} color={C.green} width={2.6} /><T style={{ fontSize: 15 }}>Nothing was signed. Nothing was paid.</T>
            </View>
          ) : null}
        </>
      ) : null}
    </Screen>
  )
}
