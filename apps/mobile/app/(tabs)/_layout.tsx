import { NativeTabs } from 'expo-router/native-tabs'
import { useAlerts } from '../../src/state/alerts'
import { C } from '../../src/ui/theme'

/**
 * The tab bar is Apple's own (UITabBar through Expo Router's native tabs), not one drawn by the app. On iOS 26 that is the real
 * Liquid Glass bar: clear glass over the content, a glass lens on the selected tab that bends what is behind it and slides between
 * tabs, and it shrinks out of the way when the owner scrolls down. Older iOS gets the system bar of its own version. Icons are SF
 * Symbols, outlined, filled when selected, as in Apple's apps.
 *
 * Why native rather than our own drawing: no hand-made view can do the lens. The system tab bar renders it, and it also brings
 * VoiceOver, Dynamic Type and haptics for free. The cost: the bar's look is Apple's, not ours (labels are in the system font).
 */
export default function TabsLayout() {
  useAlerts()
  return (
    <NativeTabs tintColor={C.text} minimizeBehavior="onScrollDown">
      <NativeTabs.Trigger name="home">
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="agents">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.2', selected: 'person.2.fill' }} />
        <NativeTabs.Trigger.Label>Agents</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf={{ default: 'clock', selected: 'clock.fill' }} />
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} />
        <NativeTabs.Trigger.Label>Account</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
