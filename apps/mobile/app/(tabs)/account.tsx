import * as Clipboard from 'expo-clipboard'
import Constants from 'expo-constants'
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Switch, View } from 'react-native'
import { useGateway, useSession } from '../../src/state/session'
import { usePoll } from '../../src/state/usePoll'
import { loaders } from '../../src/state/loaders'
import { Card, Circle, Dot, ErrorNote, Glyph, Label, Row, Screen, T } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** The Account tab: which gateway this phone answers for, the money, security, and unpairing. */
export default function Account() {
  const gw = useGateway()
  const { url, unpair } = useSession()
  const [copied, setCopied] = useState(false)
  const load = useCallback(() => loaders.account(gw), [gw])
  const { data, error, refresh } = usePoll(load, 8000, 'account')
  const host = url ? new URL(url).host : ''

  function confirmUnpair() {
    Alert.alert('Unpair this phone?', 'It will stop receiving payments to approve. Your agents, rules and money are not touched.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Unpair', style: 'destructive', onPress: () => void unpair().then(() => router.replace('/onboarding/welcome')) },
    ])
  }

  return (
    <Screen bottomSpace={120}>
      <T v="title" style={{ marginTop: 18 }}>Account</T>
      <Card style={{ marginTop: 18, padding: 16, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 54, height: 54, borderRadius: 27, backgroundColor: C.card2, alignItems: 'center', justifyContent: 'center' }}><Glyph size={26} /></View>
        <View style={{ flex: 1, gap: 3 }}>
          <T v="label" style={{ fontSize: 12 }}>CONNECTED GATEWAY</T>
          <T v="bodyStrong" lines={1} style={{ fontSize: 17 }}>{host}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Dot color={data?.frozen ? C.red : C.green} /><T v="sub">{data ? `${data.frozen ? 'Frozen' : 'Payments on'} · ${data.mode === 'live' ? 'Live' : 'Test mode'}` : 'Checking…'}</T></View>
        </View>
        <Circle icon={copied ? 'check' : 'copy'} label="Copy gateway address" tint={copied ? C.green : C.text2} onPress={() => { if (url) void Clipboard.setStringAsync(url).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400) }) }} />
      </Card>
      <ErrorNote error={error} onRetry={() => void refresh()} />

      <Label>Money</Label>
      <Card>
        <Row first icon="plus" title="Top up the signer" sub="The account your agents pay from" onPress={() => router.push('/topup')} />
        <Row icon="send" title="Withdraw to your account" sub="Take your USDC back out" onPress={() => router.push('/withdraw')} />
        <Row icon="plus" title="Earned" sub="What your agents have sold" onPress={() => router.push('/earnings')} />
        <Row icon="briefcase" title="Jobs" sub="Work your agents have done" onPress={() => router.push('/jobs')} />
        <Row icon="store" title="Shops agents may pay" sub="Checked by Tollgate" onPress={() => router.push('/shops')} />
        <Row icon="shield" title="The 12 checks" sub="What every payment must pass" onPress={() => router.push('/checks')} />
      </Card>

      <Label>Security</Label>
      <Card>
        <Row first icon="face" title="Face ID to approve" sub="Always required" right={<Switch value disabled trackColor={{ true: C.green, false: C.card3 }} />} />
        <Row icon="power" title="Kill switch" sub="Stop every payment, one tap" onPress={() => router.push('/freeze')} />
        <Row icon="key" title="Where is my recovery phrase?" sub="There isn’t one on this phone" onPress={() => Alert.alert('No recovery phrase here', 'This phone holds no wallet key. The signer key is a file on your gateway’s computer. Back it up there.')} />
      </Card>

      <Label>About</Label>
      <Card>
        <Row first icon="globe" title="Change gateway address" sub="New Wi-Fi or a new address. Keeps everything." onPress={() => router.push('/switch')} />
        <Row icon="globe" title="Network" right={<T v="sub">NEAR</T>} />
        <Row icon="out" title="Unpair this phone" danger chevron={false} onPress={confirmUnpair} />
      </Card>
      <T v="small" style={{ textAlign: 'center', marginTop: 22, color: C.text3 }}>Tollgate {Constants.expoConfig?.version ?? ''}</T>
    </Screen>
  )
}
