import { useFonts } from 'expo-font'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useState } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { SessionProvider, useSession } from '../src/state/session'
import { Splash } from '../src/ui/Splash'
import { C } from '../src/ui/theme'

void SplashScreen.preventAutoHideAsync().catch(() => {})

function Root() {
  const { ready } = useSession()
  // Satoshi (fetched by scripts/get-fonts.mjs; its licence allows embedding, not committing the files).
  const [fontsLoaded] = useFonts({
    'Satoshi-Regular': require('../assets/fonts/Satoshi-Regular.otf'),
    'Satoshi-Medium': require('../assets/fonts/Satoshi-Medium.otf'),
    'Satoshi-Bold': require('../assets/fonts/Satoshi-Bold.otf'),
    'Satoshi-Black': require('../assets/fonts/Satoshi-Black.otf'),
  })
  const show = ready && fontsLoaded
  const [splashDone, setSplashDone] = useState(false)
  // The native launch screen (the still gate) hands over to the animated one as soon as JavaScript runs.
  useEffect(() => { void SplashScreen.hideAsync().catch(() => {}) }, [])
  return (
    <>
      {show ? <AppStack /> : null}
      {splashDone ? null : <Splash ready={show} fontsReady={fontsLoaded} onDone={() => setSplashDone(true)} />}
    </>
  )
}

function AppStack() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg }, animation: 'slide_from_right' }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="onboarding/welcome" options={{ animation: 'fade' }} />
      <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
      <Stack.Screen name="approval/[id]" />
      <Stack.Screen name="chat/[id]" />
      <Stack.Screen name="freeze" options={{ presentation: 'modal' }} />
      <Stack.Screen name="agents/new" options={{ presentation: 'modal' }} />
    </Stack>
  )
}

export default function Layout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
      <SafeAreaProvider>
        <SessionProvider>
          <StatusBar style="light" />
          <Root />
        </SessionProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  )
}
