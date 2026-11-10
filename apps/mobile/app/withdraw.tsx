import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Linking, Pressable, TextInput, View } from 'react-native'
import { GatewayError } from '../src/api/gateway'
import { money } from '../src/lib/format'
import { loaders } from '../src/state/loaders'
import { confirmWithFace, useGateway } from '../src/state/session'
import { usePoll } from '../src/state/usePoll'
import { Card, Circle, ErrorNote, Label, Loading, Pill, Screen, T, TopBar } from '../src/ui/kit'
import { C, F } from '../src/ui/theme'

/** "1.5" -> 1500000n. Exact, no floats. Undefined unless it is a positive amount with at most 6 decimals. */
export function toMicro(s: string): bigint | undefined {
  const m = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(s)
  if (!m) return undefined
  const v = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0') || '0')
  return v > 0n ? v : undefined
}

const STATE: Record<string, string> = { requested: 'Started', signed: 'Sending', sent: 'Sent', failed: 'Failed', refused: 'Refused', unknown: 'Check balance' }

/**
 * Take your USDC back out of the account your agents pay from. You choose an amount; you cannot choose where it goes: the
 * destination is set on the computer that runs the signer, so a stolen phone cannot redirect your money. Face ID is asked every time.
 * Money agents have already been promised stays behind. Works while payments are frozen.
 */
export default function Withdraw() {
  const gw = useGateway()
  const load = useCallback(() => loaders.withdraw(gw), [gw])
  const { data, error, loading, refresh } = usePoll(load, 20_000)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ amount: string; to: string; explorer?: string } | null>(null)

  const available = data?.available ? toMicro(data.available) ?? 0n : 0n
  const want = toMicro(text.trim())
  const tooMuch = want !== undefined && want > available
  const ready = !!data?.enabled && want !== undefined && !tooMuch && !busy

  async function submit() {
    if (!want) return
    const amount = `${want / 1_000_000n}.${(want % 1_000_000n).toString().padStart(6, '0')}`
    setProblem(null)
    const f = await confirmWithFace(`Withdraw ${money(amount)} USDC to your account`)
    if (!f.ok) { setProblem(f.why === 'Cancelled.' ? null : f.why); return }
    setBusy(true)
    try {
      const r = await gw.withdraw(amount)
      setDone({ amount: r.amount, to: r.to, ...(r.explorer ? { explorer: r.explorer } : {}) })
      setText('')
    } catch (e) {
      setProblem(e instanceof GatewayError ? e.message : 'Nothing was moved. Try again.')
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Withdraw" />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {data && !data.enabled ? <T v="sub" style={{ marginTop: 40, textAlign: 'center', lineHeight: 20 }}>{data.reason ?? 'Withdrawals are not set up on this gateway.'}</T> : null}

      {data?.enabled ? (
        <>
          <View style={{ marginTop: 26, alignItems: 'center', gap: 4 }}>
            <T v="label">YOU CAN WITHDRAW</T>
            <T v="h1" style={{ fontVariant: ['tabular-nums'] }}>{money(data.available)} USDC</T>
            <T v="small" style={{ textAlign: 'center' }}>{money(data.balance)} in the account, {money(data.held)} set aside for payments in progress</T>
          </View>

          {done ? (
            <Card style={{ marginTop: 22, padding: 16, gap: 6 }}>
              <T v="bodyStrong">Sent {money(done.amount)} USDC</T>
              <T v="sub">To {done.to}. It usually lands within seconds.</T>
              {done.explorer ? <Pressable onPress={() => void Linking.openURL(done.explorer!)} accessibilityRole="link"><T v="sub" style={{ color: C.text, textDecorationLine: 'underline' }}>See it on NEAR</T></Pressable> : null}
            </Card>
          ) : null}

          <Card style={{ marginTop: 22, padding: 16, gap: 12 }}>
            <View style={{ gap: 2 }}><T v="label">TO (SET ON YOUR COMPUTER)</T><T v="sub" selectable>{data.to}</T></View>
            <View style={{ flexDirection: 'row', alignItems: 'center', height: 52, paddingHorizontal: 14, borderRadius: 14, backgroundColor: C.card2 }}>
              <TextInput value={text} onChangeText={t => { setDone(null); setText(t.replace(/[^0-9.]/g, '').replace(/^(\d{0,12}\.?\d{0,2}).*$/, '$1')) }} keyboardType="decimal-pad" inputMode="decimal"
                accessibilityLabel="Amount to withdraw in USDC" placeholder="0.00" placeholderTextColor={C.text3}
                style={{ flex: 1, color: C.text, fontFamily: F.semibold, fontSize: 22, fontVariant: ['tabular-nums'], paddingVertical: 0 }} />
              <T v="bodyStrong" style={{ color: C.text2 }}>USDC</T>
              <Pressable onPress={() => { setDone(null); setText(money(data.available).replace(/^0\.00$/, '')) }} accessibilityRole="button" accessibilityLabel="Withdraw everything available" hitSlop={8} style={{ marginLeft: 12 }}>
                <T v="bodyStrong">Max</T>
              </Pressable>
            </View>
            {tooMuch ? <T v="small" style={{ color: C.red }}>That is more than the {money(data.available)} USDC that can leave right now.</T> : null}
            {text && want === undefined ? <T v="small" style={{ color: C.red }}>Use an amount like 5 or 0.50.</T> : null}
            {problem ? <T v="small" style={{ color: C.red, lineHeight: 18 }}>{problem}</T> : null}
            <Pill title={busy ? 'Withdrawing…' : 'Withdraw'} icon="send" onPress={() => void submit()} disabled={!ready} busy={busy} />
            <T v="small" style={{ textAlign: 'center' }}>Face ID is asked every time. The signer keeps a little NEAR ({data.near}) to pay network fees. Withdrawals move USDC only, in whole cents.</T>
          </Card>

          {data.withdrawals.length ? (
            <>
              <Label>Past withdrawals</Label>
              <Card>
                {data.withdrawals.map((w, i) => (
                  <Pressable key={w.withdrawalId} disabled={!w.explorer} onPress={() => { if (w.explorer) void Linking.openURL(w.explorer) }} accessibilityRole={w.explorer ? 'link' : 'text'}
                    style={{ paddingHorizontal: 16, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: i ? 1 : 0, borderTopColor: C.sep }}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <T v="bodyStrong">{money(w.amount)} USDC</T>
                      <T v="small" lines={2}>{new Date(w.at).toLocaleString()}{w.note ? ` · ${w.note}` : ''}</T>
                    </View>
                    <T v="sub" style={{ color: w.state === 'sent' ? C.green : w.state === 'failed' || w.state === 'refused' ? C.red : C.text2 }}>{STATE[w.state] ?? w.state}</T>
                  </Pressable>
                ))}
              </Card>
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  )
}
