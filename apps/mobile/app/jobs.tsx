import { router } from 'expo-router'
import { useCallback } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { money, shortId } from '../src/lib/format'
import { useGateway } from '../src/state/session'
import { usePoll } from '../src/state/usePoll'
import { loaders } from '../src/state/loaders'
import { Card, Circle, ErrorNote, Icon, Label, Loading, Screen, T, Tile, TopBar } from '../src/ui/kit'
import { C } from '../src/ui/theme'

/**
 * Every job your agents were hired for, then the real runs saved from outside the gateway's decision log. Read-only.
 * Earned and spent come from the gateway's ledger and verified receipts. An imported run is labelled and has no checks to show.
 */
export default function Jobs() {
  const gw = useGateway()
  const load = useCallback(() => loaders.jobs(gw), [gw])
  const { data, error, loading, refresh } = usePoll(load, 15_000, 'jobs')
  const empty = data && data.jobs.length === 0 && data.past.length === 0
  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Jobs" />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {empty ? <T v="sub" style={{ marginTop: 30, textAlign: 'center' }}>Nothing here yet. Jobs appear when you register work for an agent on your dashboard.</T> : null}

      {data && data.jobs.length ? (
        <>
          <Label>Jobs your agents were hired for</Label>
          <Card>
            {data.jobs.map(({ job, summary }, i) => (
              <View key={job.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
                <Tile icon="briefcase" size={40} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="bodyStrong" lines={1}>{job.goal || job.id}</T>
                  <T v="sub" lines={1}>{shortId(job.mandateId)} · price {money(job.price)} {job.currency}</T>
                  {summary ? <T v="sub" lines={1}>earned {money(summary.revenue)} · spent {money(summary.settled)} · {summary.blockedAttempts} blocked</T> : null}
                </View>
                {summary ? <T v="bodyStrong" style={{ color: Number(summary.net) < 0 ? C.red : C.green, fontVariant: ['tabular-nums'] }}>{money(summary.net)}</T> : null}
              </View>
            ))}
          </Card>
        </>
      ) : null}

      {data && data.past.length ? (
        <>
          <Label>Real runs recorded from outside the decision log</Label>
          <Card>
            {data.past.map((r, i) => (
              <Pressable key={r.id} disabled={!r.explorer} onPress={() => { if (r.explorer) void Linking.openURL(r.explorer) }}
                style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep, opacity: pressed ? 0.6 : 1 })}>
                <Tile icon="wallet" size={40} />
                <View style={{ flex: 1, gap: 2 }}>
                  <T v="bodyStrong" lines={2}>{r.title}</T>
                  <T v="sub" lines={1}>Imported · {r.occurredAt.slice(0, 10)} · {r.status}</T>
                </View>
                <T v="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>{money(r.amount)} {r.currency}</T>
              </Pressable>
            ))}
          </Card>
          <View style={{ marginTop: 12, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
            <Icon name="info" size={16} color={C.text2} />
            <T v="small" style={{ flex: 1 }}>These are real runs saved as plain facts. Their twelve checks are not stored, so none are shown. Tap one to open its transaction.</T>
          </View>
        </>
      ) : null}
    </Screen>
  )
}
