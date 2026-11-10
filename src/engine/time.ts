/**
 * Abu Dhabi local-time helpers. Abu Dhabi observes Gulf Standard Time (UTC+4) all year with no daylight saving,
 * so a fixed offset is exact. All engine timestamps are epoch milliseconds (UTC).
 */

export const DUBAI_OFFSET_MS = 4 * 3_600_000
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

export interface LocalParts {
  year: number
  /** 1–12 */
  month: number
  day: number
  hour: number
  minute: number
  /** 1–366 */
  dayOfYear: number
  /** Minutes since local midnight, 0–1439. */
  minutesOfDay: number
  /** 0 = Sunday … 6 = Saturday */
  weekday: number
  /** "YYYY-MM-DD" */
  dateKey: string
  /** "HH:mm" */
  hhmm: string
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Parse an Abu Dhabi local timestamp "YYYY-MM-DDTHH:mm" (seconds optional) into epoch ms. */
export function epochFromLocal(local: string): number {
  const withSeconds = local.length === 16 ? `${local}:00` : local
  const t = Date.parse(`${withSeconds}Z`)
  if (Number.isNaN(t)) throw new Error(`Invalid local timestamp: ${local}`)
  return t - DUBAI_OFFSET_MS
}

/** Break an epoch-ms timestamp into Abu Dhabi local calendar parts. */
export function localParts(t: number): LocalParts {
  const d = new Date(t + DUBAI_OFFSET_MS)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  const hour = d.getUTCHours()
  const minute = d.getUTCMinutes()
  const startOfYear = Date.UTC(year, 0, 1)
  const dayOfYear = Math.floor((Date.UTC(year, month - 1, day) - startOfYear) / DAY_MS) + 1
  return {
    year,
    month,
    day,
    hour,
    minute,
    dayOfYear,
    minutesOfDay: hour * 60 + minute,
    weekday: d.getUTCDay(),
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
    hhmm: `${pad(hour)}:${pad(minute)}`,
  }
}

/** Epoch ms of local midnight for the local day containing `t`. */
export function startOfLocalDay(t: number): number {
  const p = localParts(t)
  return epochFromLocal(`${p.dateKey}T00:00`)
}

/** Epoch ms for a local "HH:mm" on the same local day as `t`. */
export function atLocalTime(t: number, hhmm: string): number {
  return epochFromLocal(`${localParts(t).dateKey}T${hhmm}`)
}

/** Parse "HH:mm" into minutes since midnight. */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Format minutes since midnight as "HH:mm". */
export function minutesToHhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

export function formatLocalHhmm(t: number): string {
  return localParts(t).hhmm
}

export function formatLocalDate(t: number): string {
  return localParts(t).dateKey
}
