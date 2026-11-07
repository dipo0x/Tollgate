import * as Notifications from 'expo-notifications'
import { router, usePathname } from 'expo-router'
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { newAlerts, type Seen } from '../lib/alerts'
import { useGateway } from './session'

/**
 * Alerts on this phone: a banner, a sound and the app badge when an agent needs your yes or answers you.
 *
 * These are local notifications raised by the app itself while it runs (open, or briefly in the background). They are not
 * push: iOS stops the app soon after it leaves the screen, and real push needs the paid Apple Developer Program. The badge
 * always shows how many payments wait for you, so nothing is missed when you open the app again.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: true }),
})

const EVERY_MS = 8000

/** Mount once inside the paired app. Watches the gateway and raises alerts; tapping one opens the screen it is about. */
export function useAlerts(): void {
  const gw = useGateway()
  const path = usePathname()
  const here = useRef(path)
  here.current = path

  useEffect(() => {
    void Notifications.requestPermissionsAsync().catch(() => {})
    const open = (r: Notifications.NotificationResponse | null) => {
      const url = r?.notification.request.content.data?.['url']
      if (typeof url === 'string' && url.startsWith('/')) router.push(url as never)
    }
    void Notifications.getLastNotificationResponseAsync().then(open).catch(() => {})
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => sub.remove()
  }, [])

  useEffect(() => {
    let seen: Seen | null = null
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const [approvals, mandates] = await Promise.all([gw.approvals(), gw.mandates()])
        const agents = [...new Set(mandates.filter(m => m.status === 'active').map(m => m.agentId))]
        const convos = await Promise.all(agents.map(a => gw.conversation(a).then(c => ({ agentId: a, tasks: c.tasks })).catch(() => ({ agentId: a, tasks: [] }))))
        const pending = approvals.filter(a => a.status === 'pending').length
        void Notifications.setBadgeCountAsync(pending).catch(() => {})
        if (!seen) {
          // First look: remember what is already there, so opening the app never floods you with old news.
          seen = { keys: new Set(newAlerts({ keys: new Set(), since: '' }, approvals, convos).map(a => a.key)), since: new Date().toISOString() }
          return
        }
        for (const a of newAlerts(seen, approvals, convos)) {
          seen.keys.add(a.key)
          if (here.current === a.url) continue // already looking at it
          await Notifications.scheduleNotificationAsync({ content: { title: a.title, body: a.body, data: { url: a.url }, sound: true }, trigger: null })
        }
      } catch {
        // The gateway is unreachable: the screens already say so. Alerts resume when it answers.
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = setInterval(() => { if (AppState.currentState !== 'background') void tick() }, EVERY_MS)
    const wake = AppState.addEventListener('change', s => { if (s === 'active') void tick() })
    return () => { clearInterval(timer); wake.remove() }
  }, [gw])
}
