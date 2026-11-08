import * as Haptics from 'expo-haptics'
import { router } from 'expo-router'
import { LinearGradient } from 'expo-linear-gradient'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import Animated, { Easing, runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Path, Rect } from 'react-native-svg'
import type { GatewayError } from '../api/gateway'
import { splitAmount, type Kind } from '../lib/format'
import { Glass } from './Glass'
import { C, F, R } from './theme'

// ---- icons: 24px strokes, white by default --------------------------------------------------------------------------------
const P: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h14V10',
  agents: 'M9 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M12 7v5l3 2',
  person: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8M4 21a8 8 0 0 1 16 0',
  gear: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  power: 'M12 3v9M5.6 7a8 8 0 1 0 12.8 0',
  back: 'M15 5l-7 7 7 7',
  x: 'M6 6l12 12M18 6L6 18',
  chev: 'M9 6l6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21',
  stop: 'M7.5 7.5h9v9h-9z',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4',
  send: 'M12 19V5M6 11l6-6 6 6',
  chat: 'M4 5h16v11H9l-5 4z',
  minus: 'M5 12h14',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  store: 'M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6',
  briefcase: 'M4 8h16v11H4zM9 8V5h6v3M4 13h16',
  face: 'M7 3H5a2 2 0 0 0-2 2v2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M3 17v2a2 2 0 0 0 2 2h2M9 9v1M15 9v1M9.5 15a3.5 3.5 0 0 0 5 0',
  copy: 'M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2M5 15V5a2 2 0 0 1 2-2h10',
  share: 'M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6',
  wallet: 'M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2M3 10h18M16 14.5h2',
  shield: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M12 11v5M12 8h.01',
  out: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  key: 'M8 11a4 4 0 1 1 0 8 4 4 0 0 1 0-8M10.8 12.2L20 3M17 6l3 3M15 8l2 2',
  globe: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
}
export type IconName = keyof typeof P
export function Icon({ name, size = 20, color = C.text, width = 1.9 }: { name: IconName; size?: number; color?: string; width?: number }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round"><Path d={P[name]} /></Svg>
}

/** The Tollgate mark: two posts and a bar. */
export function Glyph({ size = 22, bar = C.text }: { size?: number; bar?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 26 26">
      <Rect x={3} y={4} width={3.4} height={18} fill={C.text} />
      <Rect x={19.6} y={4} width={3.4} height={18} fill={C.text} />
      <Rect x={6.4} y={9} width={13.2} height={3.4} fill={bar} />
    </Svg>
  )
}

// ---- text ---------------------------------------------------------------------------------------------------------------
type TV = 'title' | 'h1' | 'h2' | 'body' | 'bodyStrong' | 'sub' | 'small' | 'label'
const TS: Record<TV, TextStyle> = {
  title: { fontFamily: F.bold, fontSize: 34, letterSpacing: -0.6, color: C.text },
  h1: { fontFamily: F.bold, fontSize: 28, letterSpacing: -0.5, color: C.text },
  h2: { fontFamily: F.semibold, fontSize: 17, color: C.text },
  body: { fontFamily: F.regular, fontSize: 16, color: C.text },
  bodyStrong: { fontFamily: F.semibold, fontSize: 16, color: C.text },
  sub: { fontFamily: F.regular, fontSize: 14, color: C.text2 },
  small: { fontFamily: F.regular, fontSize: 13, color: C.text2, lineHeight: 18 },
  label: { fontFamily: F.semibold, fontSize: 13, letterSpacing: 0.8, color: C.text2 },
}
export function T({ v = 'body', style, children, lines, selectable }: { v?: TV; style?: StyleProp<TextStyle>; children: ReactNode; lines?: number; selectable?: boolean }) {
  return <Text style={[TS[v], style]} numberOfLines={lines} selectable={selectable}>{children}</Text>
}

// ---- layout ---------------------------------------------------------------------------------------------------------------
/** Black with a soft warm-grey glow at the top. Scrolls unless told not to. */
export function Screen({ children, scroll = true, pad = true, bottomSpace = 24 }: { children: ReactNode; scroll?: boolean; pad?: boolean; bottomSpace?: number }) {
  const body = <View style={[{ flexGrow: 1 }, pad && { paddingHorizontal: 20 }]}>{children}</View>
  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient colors={[C.glow, '#161314', C.bg]} locations={[0, 0.42, 0.8]} style={StyleSheet.absoluteFill} pointerEvents="none" />
      <SafeAreaView edges={['top']} style={{ flex: 1 }}>
        {scroll ? <ScrollView contentContainerStyle={{ flexGrow: 1, paddingBottom: bottomSpace }} showsVerticalScrollIndicator={false}>{body}</ScrollView> : body}
      </SafeAreaView>
    </View>
  )
}

export function TopBar({ left, title, right }: { left?: ReactNode; title?: string; right?: ReactNode }) {
  return (
    <View style={{ height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
      <View style={{ minWidth: 44 }}>{left}</View>
      {title ? <T v="h2">{title}</T> : null}
      <View style={{ minWidth: 44, alignItems: 'flex-end' }}>{right}</View>
    </View>
  )
}

export function Circle({ icon, onPress, label, tint }: { icon: IconName; onPress: () => void; label: string; tint?: string }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      <Glass radius={22} interactive style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={19} color={tint ?? C.text} />
      </Glass>
    </Pressable>
  )
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[{ backgroundColor: C.card, borderRadius: R.card, overflow: 'hidden' }, style]}>{children}</View>
}

export function Tile({ icon, color = C.text, bg = C.card2, size = 36 }: { icon: IconName; color?: string; bg?: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2 - 6, backgroundColor: bg, alignItems: 'center', justifyContent: 'center' }}><Icon name={icon} size={18} color={color} /></View>
}

export function Row({ icon, title, sub, right, onPress, first, danger, chevron = true }: { icon?: IconName; title: string; sub?: string; right?: ReactNode; onPress?: () => void; first?: boolean; danger?: boolean; chevron?: boolean }) {
  const inner = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 13, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: C.sep }}>
      {icon ? <Tile icon={icon} color={danger ? C.red : C.text} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <T style={danger ? { color: C.red } : undefined}>{title}</T>
        {sub ? <T v="small">{sub}</T> : null}
      </View>
      {right}
      {onPress && chevron ? <Icon name="chev" size={16} color={C.text3} width={2} /> : null}
    </View>
  )
  return onPress ? <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>{inner}</Pressable> : inner
}

export function Label({ children }: { children: string }) {
  return <T v="label" style={{ marginTop: 24, marginBottom: 8, marginLeft: 4 }}>{children.toUpperCase()}</T>
}

export function Pill({ title, onPress, dark, disabled, busy, icon, style }: { title: string; onPress: () => void; dark?: boolean; disabled?: boolean; busy?: boolean; icon?: IconName; style?: StyleProp<ViewStyle> }) {
  const fg = dark ? C.text : '#000'
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button" accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => [{ height: 56, borderRadius: 28, paddingHorizontal: 22, backgroundColor: dark ? C.card2 : C.button, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: disabled ? 0.4 : pressed ? 0.75 : 1 }, style]}>
      {busy ? <ActivityIndicator color={fg} /> : <>{icon ? <Icon name={icon} size={19} color={fg} width={2} /> : null}<T v="bodyStrong" style={{ color: fg, fontSize: 17 }}>{title}</T></>}
    </Pressable>
  )
}

export function Chips<K extends string>({ items, value, onChange }: { items: { id: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }} accessibilityRole="tablist">
      {items.map(i => {
        const on = i.id === value
        return (
          <Pressable key={i.id} onPress={() => onChange(i.id)} accessibilityRole="tab" accessibilityState={{ selected: on }}
            style={{ height: 36, paddingHorizontal: 16, borderRadius: 18, backgroundColor: on ? C.button : C.card, justifyContent: 'center' }}>
            <T v="bodyStrong" style={{ fontSize: 15, color: on ? '#000' : C.text }}>{i.label}</T>
          </Pressable>
        )
      })}
    </View>
  )
}

/** "0.20" big and white, "6712" smaller and grey, then the unit. */
export function Amount({ value, unit = 'USDC', size = 56, center }: { value: string | undefined; unit?: string; size?: number; center?: boolean }) {
  const { main, rest } = splitAmount(value)
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: center ? 'center' : 'flex-start' }}>
      <T style={{ fontFamily: F.bold, fontSize: size, letterSpacing: -size * 0.035, fontVariant: ['tabular-nums'] }}>{main}</T>
      {rest ? <T style={{ fontFamily: F.bold, fontSize: size * 0.62, color: C.text3 }}>{rest}</T> : null}
      <T style={{ fontFamily: F.semibold, fontSize: Math.max(13, size * 0.28), color: C.text2, marginLeft: 8 }}>{unit}</T>
    </View>
  )
}

export function KindIcon({ kind, size = 38 }: { kind: Kind; size?: number }) {
  const good = kind === 'paid', bad = kind === 'blocked' || kind === 'rejected'
  return (
    <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: good ? C.greenBg : bad ? C.redBg : C.card2, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={good ? 'check' : bad ? 'x' : 'clock'} size={17} color={good ? C.green : bad ? C.red : C.text} width={2.4} />
    </View>
  )
}

export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
}

/** The gateway is not answering, or refused: say so plainly. The screen keeps showing the last good data underneath. */
export function ErrorNote({ error, onRetry, compact }: { error: GatewayError | undefined; onRetry?: () => void; compact?: boolean }) {
  const [open, setOpen] = useState(false)
  if (!error) return null
  const offline = error.code === 'unreachable' || error.code === 'timeout'
  const help = error.help ?? []
  // One slim line, for screens where the content matters more than the error (the chat). Tap it for the full note.
  if (compact && !open) {
    return (
      <Pressable onPress={() => { onRetry?.(); if (help.length) setOpen(true) }} accessibilityRole="button" accessibilityLabel={`${offline ? 'Reconnecting' : 'Something went wrong'}. Tap for details.`}
        style={{ marginTop: 8, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.redBg }}>
        <Icon name="info" size={14} color={C.red} />
        <T v="sub" style={{ color: C.text, fontSize: 13 }}>{offline ? 'Reconnecting to your computer…' : 'Something went wrong'}</T>
      </Pressable>
    )
  }
  return (
    <View style={{ marginTop: 14, padding: 16, borderRadius: R.card, backgroundColor: C.redBg, gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
        <View style={{ paddingTop: 2 }}><Icon name="info" size={18} color={C.red} /></View>
        <View style={{ flex: 1, gap: 4 }}>
          <T v="bodyStrong" style={{ fontSize: 15 }}>{offline ? 'Not connected' : 'Something went wrong'}</T>
          <T v="sub" style={{ color: C.text2 }}>{error.message}</T>
        </View>
      </View>
      {open && help.length > 0 ? (
        <View style={{ gap: 10, paddingLeft: 28 }}>
          {help.map((step, i) => (
            <View key={i} style={{ flexDirection: 'row', gap: 10 }}>
              <T v="sub" style={{ color: C.text3, width: 14 }}>{i + 1}</T>
              <T v="sub" style={{ flex: 1, color: C.text }}>{step}</T>
            </View>
          ))}
        </View>
      ) : null}
      {help.length > 0 || onRetry || offline ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingLeft: 28 }}>
          {help.length > 0 ? (
            <Pressable onPress={() => setOpen(v => !v)} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.card2 }}>
              <T v="sub" style={{ color: C.text }}>{open ? 'Hide steps' : 'How to fix'}</T>
            </Pressable>
          ) : null}
          {onRetry ? (
            <Pressable onPress={onRetry} style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.button }}>
              <T v="sub" style={{ color: '#000' }}>Try again</T>
            </Pressable>
          ) : null}
          {/* The network changed? Switch to another address of the same gateway, keeping the key. No unpairing. */}
          {offline ? (
            <Pressable onPress={() => router.push('/switch')} accessibilityRole="button" style={{ paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.pill, backgroundColor: C.card2 }}>
              <T v="sub" style={{ color: C.text }}>Change address</T>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

export function Loading() {
  return <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={C.text2} /></View>
}

/**
 * Hold to approve: the bar fills while the finger stays down (about 1.2 s) and drains if it lifts. Only a full hold calls
 * onDone, so a stray tap or a pocket press can never approve a payment. Haptics mark the start and the finish.
 */
export function HoldButton({ label = 'Hold to approve', onDone, disabled }: { label?: string; onDone: () => void; disabled?: boolean }) {
  const p = useSharedValue(0)
  const [holding, setHolding] = useState(false)
  const done = useRef(false)
  const finish = () => { if (done.current) return; done.current = true; void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); onDone() }
  const fill = useAnimatedStyle(() => ({ width: `${p.value * 100}%` }))
  useEffect(() => { if (!disabled) done.current = false }, [disabled])
  return (
    <Pressable disabled={disabled} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Press and hold to approve"
      onPressIn={() => { done.current = false; setHolding(true); void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); p.value = withTiming(1, { duration: 1200 * (1 - p.value), easing: Easing.linear }, f => { if (f) runOnJS(finish)() }) }}
      onPressOut={() => { setHolding(false); if (!done.current) p.value = withTiming(0, { duration: 250 }) }}
      style={{ height: 60, borderRadius: 30, backgroundColor: C.card2, overflow: 'hidden', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}>
      <Animated.View style={[{ position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: C.button }, fill]} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <Icon name="face" size={20} color={holding ? '#000' : C.text} width={2} />
        <T v="bodyStrong" style={{ fontSize: 17, color: holding ? '#000' : C.text }}>{holding ? 'Keep holding' : label}</T>
      </View>
    </Pressable>
  )
}
