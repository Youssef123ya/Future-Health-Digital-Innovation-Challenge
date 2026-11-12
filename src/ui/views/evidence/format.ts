/**
 * Formatting for the Evidence view. Pure functions, no React. Missing values render as the design system's em dash and
 * are never shown as zero (ARCHITECTURE.md §1 principle 3); zero event counts carry their rule-of-three bound, because
 * "none observed in n" is not "none possible" (VALIDATION-COHORT.md §2.4).
 */
import { NO_DATA, formatNumber, formatSigned } from '../../components/format'
import type { Est, Pair } from './types'

/** No-break space between a number and its unit or percent sign (the docs' "66.9 %" style, kept on one line). */
export const NBSP = ' '

export type Num = number | null | undefined

const finite = (v: Num): v is number => typeof v === 'number' && Number.isFinite(v)

/** Number with fixed decimals and locale grouping ("1,284.5"), U+2212 minus, em dash when missing. */
export function num(v: Num, precision = 0): string {
  return formatNumber(finite(v) ? v : null, precision)
}

/** Number followed by a unit with a no-break space ("41.5 min/h"); em dash alone when missing. */
export function withUnit(v: Num, unit: string, precision = 0): string {
  return finite(v) ? `${num(v, precision)}${NBSP}${unit}` : NO_DATA
}

/** A share (0–1) as a percentage ("83.7 %"). */
export function pct(share: Num, precision = 0): string {
  return finite(share) ? `${num(share * 100, precision)}${NBSP}%` : NO_DATA
}

/** A signed number ("+7", "−244", "0"). */
export function signed(v: Num, precision = 0): string {
  return finite(v) ? formatSigned(v, precision) : NO_DATA
}

/** A signed share as a percentage ("−66.6 %"). */
export function signedPct(share: Num, precision = 1): string {
  return finite(share) ? `${formatSigned(share * 100, precision)}${NBSP}%` : NO_DATA
}

/** A 95 % interval as "[lo, hi]"; '' when absent. `scale` converts units (e.g. 100 for shares shown as %). */
export function ci(interval: Pair | readonly number[] | null | undefined, precision = 0, scale = 1): string {
  if (!interval || interval.length < 2 || !finite(interval[0]) || !finite(interval[1])) return ''
  return `[${num(interval[0] * scale, precision)}, ${num(interval[1] * scale, precision)}]`
}

/** True when an estimate is a zero event count reported with its one-sided 95 % rule-of-three bound. */
export function isZeroCount(e: Est | null | undefined): boolean {
  return !!e && e.count === 0 && finite(e.upper95 ?? null)
}

export interface EstText {
  /** The point estimate ("114.1", "0"). */
  value: string
  /** The interval or bound ("[56.2, 184.3]", "≤ 9.0"); '' when none. */
  detail: string
  /** Screen-reader sentence for the detail. */
  detailLabel: string
}

/**
 * A rate or mean with its uncertainty. Zero counts print "0" with "≤ u" (u = 3/n × 1,000, one-sided 95 %), others the
 * percentile interval. `scale` multiplies value and interval (100 for shares → %).
 */
export function estText(e: Est | null | undefined, precision = 1, scale = 1): EstText {
  if (!e || !finite(e.value)) return { value: NO_DATA, detail: '', detailLabel: '' }
  if (isZeroCount(e)) {
    const bound = num((e.upper95 as number) * scale, 1)
    return { value: '0', detail: `≤${NBSP}${bound}`, detailLabel: `none observed; one-sided 95 % upper bound ${bound}` }
  }
  const interval = ci(e.ci95, precision, scale)
  return {
    value: num(e.value * scale, precision),
    detail: interval,
    detailLabel: interval ? `95 % interval ${interval.slice(1, -1).replace(', ', ' to ')}` : '',
  }
}

/** One-line form of {@link estText}: "114.1 [56.2, 184.3]" or "0 (≤ 9.0)". */
export function estLine(e: Est | null | undefined, precision = 1, scale = 1): string {
  const t = estText(e, precision, scale)
  if (!t.detail) return t.value
  return isZeroCount(e) ? `${t.value} (${t.detail})` : `${t.value} ${t.detail}`
}

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
}

/** Scientific notation with superscript exponent: 4.89e-10 → "4.89 × 10⁻¹⁰". */
export function sci(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return NO_DATA
  if (v === 0) return '0'
  const [mantissa, exponent] = v.toExponential(Math.max(0, digits - 1)).split('e')
  const exp = String(Number(exponent)).replace(/[0-9-]/g, (c) => SUPERSCRIPT[c] ?? c)
  const m = mantissa.replace(/\.?0+$/, '').replace('-', '−')
  return `${m}${NBSP}×${NBSP}10${exp}`
}

/**
 * A measured difference with a sensible number of significant digits: exact zero prints "0", values below 0.001 in
 * scientific notation, others with up to `digits` significant digits ("0.142", "10.1", "2.96").
 */
export function sig(v: Num, digits = 3): string {
  if (!finite(v)) return NO_DATA
  if (v === 0) return '0'
  const abs = Math.abs(v)
  if (abs < 1e-3) return sci(v, digits)
  const decimals = Math.max(0, digits - 1 - Math.floor(Math.log10(abs)))
  return num(Number(v.toFixed(decimals)), decimals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
}

/**
 * Share of the tolerance used by the worst difference (max |Δ| ÷ tolerance). Exact checks (tolerance 0) use 0 when the
 * difference is also 0 and Infinity otherwise; null for missing inputs.
 */
export function toleranceUse(maxAbsDiff: Num, tolerance: Num): number | null {
  if (!finite(maxAbsDiff) || !finite(tolerance)) return null
  if (tolerance === 0) return maxAbsDiff === 0 ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(maxAbsDiff) / tolerance
}

/** Text for {@link toleranceUse}: "< 0.1 %", "47 %", "100 %", "exceeds". */
export function toleranceUseText(use: number | null): string {
  if (use === null) return NO_DATA
  if (!Number.isFinite(use)) return 'exceeds tolerance'
  if (use === 0) return '0 %'
  if (use < 0.001) return `<${NBSP}0.1${NBSP}%`
  if (use < 0.01) return pct(use, 1)
  return pct(use, 0)
}

/** "0:00"-style local hour label for an integer hour of day ("05:00"). */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** Compact byte size ("256 kB"). */
export function bytes(n: Num): string {
  if (!finite(n)) return NO_DATA
  if (n < 1024) return `${n}${NBSP}B`
  if (n < 1024 * 1024) return `${num(n / 1024, 0)}${NBSP}kB`
  return `${num(n / (1024 * 1024), 1)}${NBSP}MB`
}

/** First 12 hex digits of a SHA-256, as the stamps print it. */
export function shortHash(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 12) : NO_DATA
}
