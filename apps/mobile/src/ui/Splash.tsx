import { useEffect } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withDelay, withSequence, withTiming } from 'react-native-reanimated'
import { C, F } from './theme'

/**
 * The opening: the Tollgate gate builds itself on black. Two posts rise, the bar sweeps across, the name fades in, then the whole
 * thing fades into the app. It covers the moment the fonts and the saved pairing are loading, and never waits on the network.
 * Plays for about 3 s: posts, bar, name, a short hold, then the fade. It fades only after the name has fully appeared, so it
 * never cuts mid-movement, and only once the app is ready underneath.
 */
export function Splash({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const post = useSharedValue(0), bar = useSharedValue(0), word = useSharedValue(0), out = useSharedValue(1)
  const landed = useSharedValue(0)

  useEffect(() => {
    const ease = Easing.bezier(0.2, 0.8, 0.2, 1)
    post.value = withTiming(1, { duration: 900, easing: ease })
    bar.value = withDelay(800, withTiming(1, { duration: 700, easing: Easing.bezier(0.7, 0, 0.2, 1) }))
    word.value = withDelay(1500, withTiming(1, { duration: 700, easing: ease }, f => { if (f) landed.value = 1 }))
  }, [post, bar, word, landed])

  useEffect(() => {
    if (!ready) return
    const t = setInterval(() => {
      if (landed.value !== 1) return
      clearInterval(t)
      out.value = withSequence(withTiming(1, { duration: 900 }), withTiming(0, { duration: 500 }, f => { if (f) runOnJS(onDone)() }))
    }, 50)
    return () => clearInterval(t)
  }, [ready, landed, out, onDone])

  const postStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: post.value }], opacity: post.value }))
  const barStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: bar.value }] }))
  const wordStyle = useAnimatedStyle(() => ({ opacity: word.value, transform: [{ translateY: (1 - word.value) * 8 }] }))
  const wrapStyle = useAnimatedStyle(() => ({ opacity: out.value }))

  // The mark is drawn from plain views (26×26 grid scaled ×4), so it animates on the UI thread with no SVG work.
  const k = 4
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', zIndex: 10 }, wrapStyle]} pointerEvents="none">
      <View style={{ width: 26 * k, height: 26 * k }}>
        <Animated.View style={[{ position: 'absolute', left: 3 * k, top: 4 * k, width: 3.4 * k, height: 18 * k, backgroundColor: C.text, transformOrigin: 'bottom' }, postStyle]} />
        <Animated.View style={[{ position: 'absolute', left: 19.6 * k, top: 4 * k, width: 3.4 * k, height: 18 * k, backgroundColor: C.text, transformOrigin: 'bottom' }, postStyle]} />
        <Animated.View style={[{ position: 'absolute', left: 6.4 * k, top: 9 * k, width: 13.2 * k, height: 3.4 * k, backgroundColor: C.text, transformOrigin: 'left' }, barStyle]} />
      </View>
      <Animated.Text style={[{ marginTop: 22, color: C.text, fontFamily: F.bold, fontSize: 30, letterSpacing: -0.8 }, wordStyle]}>Tollgate</Animated.Text>
    </Animated.View>
  )
}
