/**
 * The whole visual system. Near-monochrome on purpose: colour only means something.
 * Green = paid or on. Red = blocked or frozen. Everything else is white or grey.
 */
export const C = {
  bg: '#000000',
  glow: '#3a3435',
  card: '#1C1C1E',
  card2: '#2C2C2E',
  card3: '#3A3A3C',
  sep: 'rgba(255,255,255,0.08)',
  text: '#FFFFFF',
  text2: '#8E8E93',
  text3: '#636366',
  button: '#F2F2F2',
  green: '#30D158',
  greenBg: 'rgba(48,209,88,0.15)',
  red: '#FF453A',
  redBg: 'rgba(255,69,58,0.14)',
} as const

/** Satoshi, the typeface from the design. Satoshi has no SemiBold, so "semibold" uses Bold and "bold" uses Black for big numbers. */
export const F = {
  regular: 'Satoshi-Regular',
  medium: 'Satoshi-Medium',
  semibold: 'Satoshi-Bold',
  bold: 'Satoshi-Black',
} as const

export const R = { card: 22, pill: 999, tile: 13 } as const
