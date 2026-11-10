/**
 * Number and duration formatting for Zill displays. A missing value renders as an em dash and is never shown as zero,
 * because a missing input must never read as reassurance (ARCHITECTURE.md §1 principle 3, fail-safe).
 */

/** Text shown for a missing value. Components add screen-reader text ("No data") next to it. */
export const NO_DATA = '—'

/** U+2212 MINUS SIGN: typographically correct and the same width as "+", so signed columns line up. */
const MINUS = '−'

const formatters = new Map<string, Intl.NumberFormat>()

function formatter(locale: string, precision: number, sign: 'negative' | 'exceptZero'): Intl.NumberFormat {
  const key = `${locale}|${precision}|${sign}`
  let f = formatters.get(key)
  if (!f) {
    const digits = { minimumFractionDigits: precision, maximumFractionDigits: precision }
    try {
      f = new Intl.NumberFormat(locale, { ...digits, signDisplay: sign })
    } catch {
      // Engines without Intl.NumberFormat v3 reject signDisplay 'negative'; 'auto' differs only for negative zero.
      f = new Intl.NumberFormat(locale, { ...digits, signDisplay: sign === 'negative' ? 'auto' : sign })
    }
    formatters.set(key, f)
  }
  return f
}

/**
 * Formats a number with a fixed number of decimals and locale digit grouping, e.g. `formatNumber(1284.5, 1)` →
 * "1,284.5". Negative values use U+2212; a value that rounds to zero prints without a sign. Null, undefined and
 * non-finite values return {@link NO_DATA}. [ENG] display convention.
 */
export function formatNumber(value: number | null | undefined, precision = 0, locale = 'en-US'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return NO_DATA
  return formatter(locale, precision, 'negative').format(value).replace('-', MINUS)
}

/**
 * Formats a change with an explicit sign, e.g. "+1.2", "−0.8" or "0", for deltas against a named comparison period.
 * [ENG] display convention.
 */
export function formatSigned(value: number, precision = 0, locale = 'en-US'): string {
  if (!Number.isFinite(value)) return NO_DATA
  return formatter(locale, precision, 'exceptZero').format(value).replace('-', MINUS)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Formats a duration given in minutes as "m:ss", or "h:mm:ss" from one hour. Seconds are floored, so a countdown to a
 * required break or limit never shows more time than actually remains. [ENG] protective rounding.
 */
export function formatClock(minutes: number): string {
  if (!Number.isFinite(minutes)) return NO_DATA
  // The 1e-6 s guard absorbs binary rounding (e.g. 0.7 × 60 = 41.99999…) without overstating time.
  const totalS = Math.max(0, Math.floor(minutes * 60 + 1e-6))
  const h = Math.floor(totalS / 3600)
  const m = Math.floor((totalS % 3600) / 60)
  const s = totalS % 60
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/**
 * Formats a duration in minutes as "<1 min", "12 min" or "1 h 05 min" (English; localised views pass their own
 * formatter). Whole minutes are floored for the same protective reason as {@link formatClock}. [ENG]
 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return NO_DATA
  if (minutes <= 0) return '0 min'
  if (minutes < 1) return '<1 min'
  const whole = Math.floor(minutes + 1e-9)
  if (whole < 60) return `${whole} min`
  return `${Math.floor(whole / 60)} h ${pad2(whole % 60)} min`
}
