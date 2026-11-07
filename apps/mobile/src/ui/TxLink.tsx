import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { useState } from 'react'
import { Linking, Pressable, View } from 'react-native'
import { safeExplorer } from '../api/gateway'
import { shortId } from '../lib/format'
import { Icon, T } from './kit'
import { C } from './theme'

/**
 * A transaction id the owner can act on. Tap: open it on the chain's explorer (only a known explorer, over https: safeExplorer).
 * Press and hold: copy the full id. With no safe explorer link, a tap copies instead, so the id is never a dead end.
 */
export function TxLink({ hash, explorer }: { hash: string; explorer?: string | undefined }) {
  const [copied, setCopied] = useState(false)
  const link = safeExplorer(explorer)
  const copy = () => void Clipboard.setStringAsync(hash).then(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    setCopied(true); setTimeout(() => setCopied(false), 1400)
  })
  return (
    <Pressable onPress={() => (link ? void Linking.openURL(link) : copy())} onLongPress={copy} hitSlop={8}
      accessibilityRole={link ? 'link' : 'button'} accessibilityLabel={`Transaction ${shortId(hash, 6, 4)}`}
      accessibilityHint={link ? `Opens it on ${new URL(link).hostname}. Press and hold to copy.` : 'Copies the transaction id.'}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: pressed ? 0.6 : 1 })}>
      <T v="sub" style={{ fontSize: 16, color: copied ? C.green : C.text, textDecorationLine: link && !copied ? 'underline' : 'none' }}>{copied ? 'Copied' : shortId(hash, 6, 4)}</T>
      {link && !copied ? <View><Icon name="out" size={14} color={C.text2} width={2} /></View> : null}
    </Pressable>
  )
}
