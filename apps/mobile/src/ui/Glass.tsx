import { BlurView } from 'expo-blur'
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect'
import type { ReactNode } from 'react'
import { Platform, type StyleProp, type ViewStyle } from 'react-native'

/** iOS 26 and later draw Apple's Liquid Glass. Checked once; any doubt means the frosted fallback. */
const LIQUID = (() => { try { return Platform.OS === 'ios' && isLiquidGlassAvailable() } catch { return false } })()

/**
 * Liquid Glass for the controls that float over content: the dock, round buttons, the chat composer. Never for cards holding
 * amounts or text (Apple's guidance, and legibility): those stay solid.
 *
 * On iOS 26 this is the system material (it bends the light behind it and reacts to touch when `interactive`). Earlier iOS and
 * Android get the frosted blur the app used before, so the layout and contrast are the same everywhere.
 */
export function Glass({ children, radius, interactive, style }: { children?: ReactNode; radius: number; interactive?: boolean; style?: StyleProp<ViewStyle> }) {
  if (LIQUID) {
    return <GlassView glassEffectStyle="regular" colorScheme="dark" isInteractive={!!interactive} style={[{ borderRadius: radius }, style]}>{children}</GlassView>
  }
  return (
    <BlurView intensity={40} tint="dark" style={[{ borderRadius: radius, overflow: 'hidden', backgroundColor: 'rgba(28,28,30,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' }, style]}>
      {children}
    </BlurView>
  )
}

export const hasLiquidGlass = LIQUID
