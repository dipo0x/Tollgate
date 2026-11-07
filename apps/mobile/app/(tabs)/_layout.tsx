import * as Haptics from 'expo-haptics'
import { Tabs } from 'expo-router'
import { Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAlerts } from '../../src/state/alerts'
import { Glass } from '../../src/ui/Glass'
import { Icon, T, type IconName } from '../../src/ui/kit'
import { C } from '../../src/ui/theme'

/** The parts of the tab bar props this dock uses. */
type DockProps = { state: { index: number; routes: { key: string; name: string }[] }; navigateToTab: (routeKey: string) => void }

const TABS: Record<string, { label: string; icon: IconName }> = {
  home: { label: 'Home', icon: 'home' },
  agents: { label: 'Agents', icon: 'agents' },
  activity: { label: 'Activity', icon: 'clock' },
  account: { label: 'Account', icon: 'person' },
}

/** The floating dock: Liquid Glass on iOS 26 (frosted before that), the active tab in a lighter pill. */
function Dock({ state, navigateToTab }: DockProps) {
  const insets = useSafeAreaInsets()
  return (
    <View style={{ position: 'absolute', left: 16, right: 16, bottom: Math.max(insets.bottom, 12) + 4, height: 70 }}>
      <Glass radius={35} interactive style={{ flex: 1, flexDirection: 'row', padding: 5, gap: 4 }}>
        {state.routes.map((r, i) => {
          const t = TABS[r.name]
          if (!t) return null
          const on = state.index === i
          return (
            <Pressable key={r.key} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={t.label}
              onPress={() => { if (!on) { void Haptics.selectionAsync(); navigateToTab(r.key) } }}
              style={{ flex: 1, borderRadius: 30, alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: on ? 'rgba(255,255,255,0.12)' : 'transparent' }}>
              <Icon name={t.icon} size={24} />
              <T style={{ fontSize: 12, color: C.text, opacity: on ? 1 : 0.85 }}>{t.label}</T>
            </Pressable>
          )
        })}
      </Glass>
    </View>
  )
}

export default function TabsLayout() {
  useAlerts()
  return (
    <Tabs tabBar={p => <Dock state={p.state} navigateToTab={p.navigateToTab} />} screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: C.bg } }}>
      <Tabs.Screen name="home" />
      <Tabs.Screen name="agents" />
      <Tabs.Screen name="activity" />
      <Tabs.Screen name="account" />
    </Tabs>
  )
}
