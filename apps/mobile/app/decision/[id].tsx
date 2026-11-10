import { router, useLocalSearchParams } from 'expo-router'
import { useCallback } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { CHECK_NAME, kindOf, KIND_LABEL, shortId, when } from '../../src/lib/format'
import { safeExplorer } from '../../src/api/gateway'
import { TxLink } from '../../src/ui/TxLink'
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
  const link = safeExplorer(d?.onchain?.explorer)
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
            <Amount value={d.amount} unit={d.currency ?? ''} size={48} center exact />
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
          {d.onchain ? (
            <>
              <T v="sub" style={{ marginTop: 26, marginBottom: 8, marginLeft: 4, fontSize: 14 }}>On the blockchain</T>
              <Card>
                <Row first title="Network" right={<T>{d.onchain.network}</T>} />
                <Row title="Transaction" sub={d.state === 'settled' ? 'Confirmed paid by 1Click' : 'Signed and sent. It shows on the chain once confirmed.'}
                  right={<TxLink hash={d.onchain.txHash} explorer={d.onchain.explorer} />} />
                <Row title="Paid from" right={<T v="sub" style={{ fontSize: 16 }}>{shortId(d.onchain.from, 6, 4)}</T>} />
              </Card>
              {link ? (
                <Pressable onPress={() => void Linking.openURL(link)} accessibilityRole="link" accessibilityLabel={`View on ${new URL(link).hostname}`}
                  style={({ pressed }) => ({ marginTop: 12, height: 52, borderRadius: 26, backgroundColor: C.button, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: pressed ? 0.8 : 1 })}>
                  <Icon name="globe" size={18} color="#000" width={2.2} />
                  <T v="bodyStrong" style={{ color: '#000', fontSize: 17 }}>View on {new URL(link).hostname}</T>
                </Pressable>
              ) : null}
            </>
          ) : k === 'paid' ? (
            <T v="small" style={{ marginTop: 14, marginHorizontal: 4 }}>No blockchain transaction is recorded for this payment, so there is no link to show.</T>
          ) : null}
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
