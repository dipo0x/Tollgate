import * as Clipboard from 'expo-clipboard'
import { router } from 'expo-router'
import { useCallback, useState } from 'react'
import { Share, View } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import { useGateway } from '../src/state/session'
import { usePoll } from '../src/state/usePoll'
import { Circle, ErrorNote, Icon, Loading, Pill, Screen, T, TopBar } from '../src/ui/kit'
import { C } from '../src/ui/theme'

/**
 * Where to send money so agents can pay: the signer's PUBLIC account, as text and a real QR code.
 * Tollgate is not a wallet: nothing is sent from this screen. The owner sends from their own wallet or exchange.
 */
export default function TopUp() {
  const gw = useGateway()
  const load = useCallback(() => gw.status(), [gw])
  const { data, error, loading, refresh } = usePoll(load, 15_000, 'topup')
  const [copied, setCopied] = useState(false)
  const addr = data?.signerAddress
  const near = addr ? !addr.startsWith('0x') : false

  return (
    <Screen>
      <TopBar left={<Circle icon="back" label="Back" onPress={() => router.back()} />} title="Top up" />
      <ErrorNote error={error} onRetry={() => void refresh()} />
      {loading && !data ? <Loading /> : null}
      {data && !addr ? <T v="sub" style={{ marginTop: 40, textAlign: 'center' }}>No signer is connected to your gateway yet, so there is no account to top up.</T> : null}
      {addr ? (
        <>
          <View style={{ marginTop: 26, alignSelf: 'center', padding: 18, borderRadius: 28, backgroundColor: '#fff' }}>
            <QRCode value={addr} size={200} ecl="H" backgroundColor="#fff" color="#000" />
          </View>
          <View style={{ marginTop: 20, alignItems: 'center', gap: 6, paddingHorizontal: 12 }}>
            <T v="bodyStrong">{near ? 'USDC on NEAR' : 'USDC'}</T>
            <T v="sub" style={{ textAlign: 'center', lineHeight: 20 }} selectable>{addr}</T>
          </View>
          <View style={{ marginTop: 22, flexDirection: 'row', gap: 10 }}>
            <Pill title={copied ? 'Copied' : 'Copy'} icon={copied ? 'check' : 'copy'} style={{ flex: 1 }} onPress={() => void Clipboard.setStringAsync(addr).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) })} />
            <Pill title="Share" icon="share" dark style={{ flex: 1 }} onPress={() => void Share.share({ message: addr })} />
          </View>
          <View style={{ marginTop: 16, marginHorizontal: 4, flexDirection: 'row', gap: 10 }}>
            <Icon name="info" size={16} color={C.text2} /><T v="small" style={{ flex: 1 }}>Send from your own wallet. Tollgate never moves money from this screen. The signer also needs a little NEAR for fees.</T>
          </View>
        </>
      ) : null}
    </Screen>
  )
}
