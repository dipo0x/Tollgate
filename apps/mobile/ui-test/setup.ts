// Native pieces a Node test run cannot load. Each is replaced by something that does nothing: no screen's logic lives in them.
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(), notificationAsync: jest.fn(), selectionAsync: jest.fn(), ImpactFeedbackStyle: {}, NotificationFeedbackType: {} }))
jest.mock('expo-linear-gradient', () => ({ LinearGradient: 'LinearGradient' }))
jest.mock('expo-blur', () => ({ BlurView: 'BlurView' }))
jest.mock('expo-glass-effect', () => ({ GlassView: 'GlassView', isLiquidGlassAvailable: () => false, isGlassEffectAPIAvailable: () => false }))
// Animations are not what these tests check: Animated.View becomes a plain View and entering animations do nothing. The one animation that
// carries a rule is the hold-to-approve fill: it only calls its `finish` callback if the finger stays down for the whole duration, and
// letting go (which assigns a new value) cancels it. That is kept, so a test can hold, or let go early.
jest.mock('react-native-reanimated', () => {
  const rn = require('react-native')
  const layout = { duration: () => layout, delay: () => layout, springify: () => layout, damping: () => layout }
  const id = (x: unknown) => x
  const timing = (to: number, cfg?: { duration?: number }, cb?: (finished: boolean) => void) => ({ __timing: true, to, duration: cfg?.duration ?? 0, cb })
  const shared = (initial: unknown) => {
    let value = initial, timer: ReturnType<typeof setTimeout> | undefined
    return { get value() { return value }, set value(v: any) {
      if (timer) clearTimeout(timer)
      if (v && typeof v === 'object' && v.__timing) { if (v.cb && v.to === 1) timer = setTimeout(() => v.cb(true), v.duration); else value = v.to } else value = v
    } }
  }
  return {
    __esModule: true,
    default: { View: rn.View, Text: rn.Text, ScrollView: rn.ScrollView, createAnimatedComponent: id },
    Easing: { out: id, in: id, ease: id, cubic: id, linear: id, bezier: () => id, inOut: id },
    FadeIn: layout, FadeInDown: layout, FadeInUp: layout, FadeOutDown: layout, ZoomIn: layout,
    runOnJS: id, useSharedValue: (v: unknown) => { const ref = require('react').useRef(null); if (!ref.current) ref.current = shared(v); return ref.current }, useAnimatedStyle: () => ({}),
    withTiming: timing, withDelay: (_d: number, v: unknown) => v, withSequence: (...v: unknown[]) => v[v.length - 1], withRepeat: id,
  }
})
jest.mock('react-native-safe-area-context', () => {
  const React = require('react')
  return { SafeAreaView: ({ children }: { children: unknown }) => React.createElement('View', null, children), SafeAreaProvider: ({ children }: { children: unknown }) => children, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }
})
