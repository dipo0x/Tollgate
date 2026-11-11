import { router } from 'expo-router'
import { useCallback } from 'react'
import { View } from 'react-native'
import { earningsOf } from '../src/lib/earnings'
import { money, when } from '../src/lib/format'
import { useGateway } from '../src/state/session'
import { loaders } from '../src/state/loaders'
import { useNow, usePoll } from '../src/state/usePoll'
import { Card, Circle, ErrorNote, Icon, Label, Loading, Screen, T, Tile, TopBar } from '../src/ui/kit'
import { C, F } from '../src/ui/theme'

/**
 * Money your agents have earned. Two lines, never blended silently: what Tollgate confirmed itself, and work sold on the NEAR AI Agent
 * Market, which the market pays out. Read-only; every figure comes from the gateway.
 */
export default function Earnings() {
  const gw = useGateway()
  const now = useNow()
  const load = useCallback(() => loaders.earnings(gw), [gw])
  const { data, error, loading, refresh } = usePoll(load, 10_000, 'earnings')
  const e: ReturnType<typeof earningsOf> | undefined = data
  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Earned" />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !e ? <Loading /> : null}
      {e ? (
        <>
          <View style={{ marginTop: 22, gap: 8 }}>
            <T v="sub" style={{ fontSize: 15 }}>Total earned</T>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <T style={{ fontFamily: F.semibold, fontSize: 52, letterSpacing: -1.6, fontVariant: ['tabular-nums'], color: e.any ? C.green : C.text }}>{money(e.total)}</T>
              <T v="sub" style={{ fontSize: 17 }}>USDC</T>
            </View>
          </View>

          <Card style={{ marginTop: 18 }}>
            <View style={{ padding: 14, gap: 4 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T v="bodyStrong">Confirmed by Tollgate</T><T v="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>{money(e.confirmed)}</T></View>
              <T v="small">Revenue credited to a job after Tollgate checked a receipt or the transaction on the chain.</T>
            </View>
            <View style={{ padding: 14, gap: 4, borderTopWidth: 1, borderTopColor: C.sep }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}><T v="bodyStrong">Sold on the market</T><T v="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>{money(e.sold)}</T></View>
              <T v="small">Work delivered through your listing on the NEAR AI Agent Market. The market pays it out; Tollgate has not confirmed the payout itself.</T>
            </View>
          </Card>

          {e.sales.length ? (
            <>
              <Label>Sales</Label>
              <Card>
                {e.sales.map((s, i) => (
                  <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
                    <Tile icon="store" size={40} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T v="bodyStrong" lines={1}>{s.title}</T>
                      <T v="sub" lines={1}>{when(s.occurredAt, now)} · {s.status}</T>
                    </View>
                    <T v="bodyStrong" style={{ color: C.green, fontVariant: ['tabular-nums'] }}>+{money(s.amount)}</T>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {e.earningJobs.length ? (
            <>
              <Label>Jobs with confirmed revenue</Label>
              <Card>
                {e.earningJobs.map((j, i) => (
                  <View key={j.job.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
                    <Tile icon="briefcase" size={40} />
                    <T v="bodyStrong" lines={1} style={{ flex: 1 }}>{j.job.goal || j.job.id}</T>
                    <T v="bodyStrong" style={{ color: C.green, fontVariant: ['tabular-nums'] }}>+{money(j.summary?.revenue)}</T>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {!e.any ? (
            <T v="sub" style={{ marginTop: 24, textAlign: 'center' }}>Nothing earned yet. Your listing tollgate-briefs is live on the NEAR AI Agent Market; its first sale shows up here when the work is delivered.</T>
          ) : null}
          <View style={{ marginTop: 16, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
            <Icon name="info" size={16} color={C.text2} /><T v="small" style={{ flex: 1 }}>Earnings never raise an agent’s spending budget. Only you do that, by creating a new agent.</T>
          </View>
        </>
      ) : null}
    </Screen>
  )
}
