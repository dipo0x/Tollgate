import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import type { Kit } from '../lib/connect'
import { Card, Row, T } from './kit'
import { C } from './theme'

/**
 * How to plug in an agent that runs on the owner's own program: Claude, Grok, ChatGPT, a script on localhost, anything that can make
 * web requests. Three things to copy; the key is inside each, so it is shown only here, once, and never kept by the phone.
 */
export function ConnectKit({ kit }: { kit: Kit }) {
  const [copied, setCopied] = useState<string | null>(null)
  const copy = (id: string, text: string) => { void Clipboard.setStringAsync(text).then(() => { setCopied(id); void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success) }) }
  const rows: { id: string; title: string; sub: string; text: string }[] = [
    { id: 'prompt', title: 'Instructions for an AI agent', sub: 'Paste into Claude, Grok, ChatGPT or your own agent', text: kit.prompt },
    { id: 'code', title: 'Starter program', sub: 'Node 22, no packages. Replace one function with your agent', text: kit.code },
    { id: 'curl', title: 'Two web requests', sub: 'To try it by hand in a terminal', text: kit.curl },
  ]
  return (
    <Card>
      {rows.map((r, i) => (
        <Row key={r.id} first={i === 0} title={r.title} sub={r.sub} right={
          <Pressable onPress={() => copy(r.id, r.text)} accessibilityRole="button" accessibilityLabel={`Copy ${r.title}`}
            style={{ height: 34, paddingHorizontal: 14, borderRadius: 17, backgroundColor: C.button, justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ color: '#000', fontSize: 15 }}>{copied === r.id ? 'Copied' : 'Copy'}</T>
          </Pressable>} />
      ))}
    </Card>
  )
}

/** Shown under the kit: what the key can and cannot do. */
export const KEY_NOTE = 'The key lets your agent read this chat, answer it, and ask to pay. Nothing is paid until you approve it on this phone. It is shown once: get a new one from the agent’s page.'
export const KitNote = () => <View style={{ marginTop: 10, marginHorizontal: 4 }}><T v="small">{KEY_NOTE}</T></View>
