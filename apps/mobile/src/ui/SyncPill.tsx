import { ActivityIndicator, View } from 'react-native'
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSession } from '../state/session'
import { Glass } from './Glass'
import { T } from './kit'
import { C } from './theme'

/**
 * After a switch of gateway address (or a new pairing), a small pill above the tab bar while the app pulls fresh data from the
 * new address, so the screens never just sit there looking dormant. Gone when the prefetch for that address finishes (25 s at most).
 * Touches pass through it: it never blocks a tap.
 */
export function SyncPill() {
  const { syncing } = useSession()
  const insets = useSafeAreaInsets()
  if (!syncing) return null
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: insets.bottom + 72, alignItems: 'center' }}>
      <Animated.View entering={FadeInDown.duration(220)} exiting={FadeOutDown.duration(220)} accessibilityLiveRegion="polite" accessibilityLabel={`Loading your data from ${syncing}`}>
        <Glass radius={20} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 16 }}>
          <ActivityIndicator size="small" color={C.text} />
          <T v="sub" lines={1} style={{ color: C.text, fontSize: 14, maxWidth: 260 }}>Loading your data from {syncing}…</T>
        </Glass>
      </Animated.View>
    </View>
  )
}
