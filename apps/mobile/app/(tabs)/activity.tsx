import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { kindOf, KIND_LABEL, when, type Kind } from '../../src/lib/format'
import { useGateway } from '../../src/state/session'
import { useNow, usePoll } from '../../src/state/usePoll'
import { loaders } from '../../src/state/loaders'
import { Chips, ErrorNote, KindIcon, Loading, Screen, T } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

type Filter = 'all' | 'paid' | 'blocked' | 'waiting'
const MATCH: Record<Filter, (k: Kind) => boolean> = {
  all: () => true, paid: k => k === 'paid', blocked: k => k === 'blocked' || k === 'rejected', waiting: k => k === 'waiting',
}

/** Every decision the gateway made, newest first, with the filter chips from the design. */
export default function Activity() {
  const gw = useGateway()
  const now = useNow()
  const [f, setF] = useState<Filter>('all')
  const load = useCallback(() => loaders.activity(gw), [gw])
  const { data, error, loading, refresh } = usePoll(load, 6000, 'activity')
  const rows = (data ?? []).filter(d => MATCH[f](kindOf(d)))

  return (
    <Screen bottomSpace={120}>
      <T v="title" style={{ marginTop: 18 }}>Activity</T>
      <View style={{ marginTop: 16 }}>
        <Chips<Filter> value={f} onChange={setF} items={[{ id: 'all', label: 'All' }, { id: 'paid', label: 'Paid' }, { id: 'blocked', label: 'Blocked' }, { id: 'waiting', label: 'Waiting' }]} />
      </View>
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {data && rows.length === 0 ? <T v="sub" style={{ marginTop: 30, textAlign: 'center' }}>Nothing here yet.</T> : null}
      <View style={{ marginTop: 8 }}>
        {rows.map(d => {
          const k = kindOf(d)
          const tone = k === 'paid' ? C.green : k === 'blocked' || k === 'rejected' ? C.red : C.text2
          return (
            <Pressable key={d.decisionId} onPress={() => router.push(k === 'waiting' ? `/approval/${encodeURIComponent(d.decisionId)}` : `/decision/${encodeURIComponent(d.decisionId)}`)}
              style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.sep, opacity: pressed ? 0.6 : 1 })}>
              <KindIcon kind={k} size={40} />
              <View style={{ flex: 1, gap: 2 }}>
                <T v="bodyStrong" lines={1}>{d.purpose || d.host}</T>
                <T v="sub" lines={1}>{d.agentId} · {when(d.createdAt, now)}{d.failedCheck ? ` · ${d.failedCheck}` : ''}</T>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <T v="bodyStrong" style={{ fontVariant: ['tabular-nums'] }}>{d.amount ? (k === 'paid' ? `−${d.amount}` : d.amount) : ''}</T>
                <T v="sub" style={{ color: tone }}>{KIND_LABEL[k]}</T>
              </View>
            </Pressable>
          )
        })}
      </View>
    </Screen>
  )
}
