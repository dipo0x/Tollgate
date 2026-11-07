import { Redirect } from 'expo-router'
import { useSession } from '../src/state/session'

/** Where the app opens: onboarding until paired and Face ID is set, then Home. */
export default function Index() {
  const { paired, faceReady } = useSession()
  if (!paired) return <Redirect href="/onboarding/welcome" />
  if (!faceReady) return <Redirect href="/onboarding/faceid" />
  return <Redirect href="/(tabs)/home" />
}
