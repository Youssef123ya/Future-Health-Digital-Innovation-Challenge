/**
 * Pure local-time helpers for the shell, the live demo and the overview: 'HH:mm' arithmetic on the simulated shift and
 * scenario dates. Calendar arithmetic only (no time zone: every scenario date and shift time is Abu Dhabi local time).
 * Unit-tested.
 */

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/** True for a 24-hour 'HH:mm' string. */
export function isHhmm(value: string | null | undefined): value is string {
  return typeof value === 'string' && HHMM.test(value)
}

/** Minutes after local midnight of an 'HH:mm' string (NaN when malformed). */
export function hhmmMinutes(hhmm: string): number {
  const m = HHMM.exec(hhmm)
  return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN
}

/** 'HH:mm' of minutes after local midnight, rounded and clamped to the day. */
export function minutesHhmm(minutes: number): string {
  const m = Math.min(Math.max(Math.round(minutes), 0), 23 * 60 + 59)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Share (0–1) of a shift elapsed at `now` ('HH:mm'); null when an input is malformed or the shift is empty. */
export function shiftProgress(now: string | null, shift: { start: string; end: string }): number | null {
  if (now === null) return null
  const n = hhmmMinutes(now)
  const s = hhmmMinutes(shift.start)
  const e = hhmmMinutes(shift.end)
  if (![n, s, e].every(Number.isFinite) || e <= s) return null
  return Math.min(1, Math.max(0, (n - s) / (e - s)))
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * "Fri 1 Aug 2025" from a local date "2025-08-01". Returns the input unchanged when it is not a valid date.
 * `weekday: false` → "1 Aug 2025".
 */
export function formatScenarioDate(date: string, opts: { weekday?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return date
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(Date.UTC(y, mo - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return date
  const core = `${d} ${MONTHS[mo - 1]} ${y}`
  return opts.weekday === false ? core : `${WEEKDAYS[dt.getUTCDay()]} ${core}`
}
