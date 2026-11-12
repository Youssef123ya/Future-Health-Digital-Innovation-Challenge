/**
 * Real-weather context for the regulator and HSE consoles: public/data/validation/hours-in-zone.json (schema
 * zill.validation.hours_in_zone/v1, written by scripts/validate/hours-in-zone.ts). Mean hours per season (1 Jun – 30 Sep,
 * 2020–2025) in each WBGT band and ADOSH TWL zone at the five Abu Dhabi sites, by month and by hour of day, from the
 * primary run (ECMWF IFS analysis via Open-Meteo, no site radiant allowance). Environmental data only — no person.
 * Loader plus pure transforms (unit-tested).
 */
import { useEffect, useState } from 'react'

/** Band or zone definition from the file's config. */
export interface HizBand {
  id: string
  label: string
  meaning?: string
  basis?: string
  fromC?: number | null
  toC?: number | null
  minWm2?: number | null
  maxWm2?: number | null
}

interface HizCounts {
  wbgtBands: number[]
  adoshSun: number[]
  adoshShade: number[]
}

export interface HizSiteRow {
  site: string
  run: string
  seasons: number
  wbgt: { p50: number; p95: number; max: number }
  meanSeason: HizCounts & { hours: number; daysWithAdoshHigh: number; daysWithWbgtGeRal115: number; longestRunGeRal115H: number }
}

export interface HizMiddayRow {
  site: string
  adoshHighHours: number
  adoshHighOutsideBreak: number
  adoshHighShareOutside: number
  wbgtGeRal115Hours: number
  wbgtGeRal115OutsideBreak: number
  wbgtGeRal115ShareOutside: number
  wbgtGeRal115OutsideSeasonDatesShare: number
}

/** The parts of hours-in-zone.json this view reads. */
export interface HoursInZoneFile {
  schema: string
  title: string
  stamp?: { stamp?: string }
  provenance?: { attribution?: Record<string, string> }
  config: {
    years: number[]
    season: string
    runs: Array<{ id: string; label: string; role: string }>
    wbgtBands: HizBand[]
    adoshZones: HizBand[]
    middayBreak: { from: string; to: string; startHhmm: string; endHhmm: string; basis: string }
    notes: string[]
  }
  sites: HizSiteRow[]
  byMonth: Array<HizCounts & { site: string; month: number }>
  byHour: Array<HizCounts & { site: string; hour: number; meanWbgtC: number; meanTwlSun: number }>
  middayBreak: HizMiddayRow[]
}

/** What the charts stack: WBGT bands, or ADOSH TWL zones in the sun. */
export type HizMeasure = 'wbgt' | 'adosh'

/** The primary run (the meteorological exposure, no site radiant allowance). */
export const PRIMARY_RUN = 'ifs'

/** ADOSH zones charted: the two with zone controls (High, Medium); the Low zone is unrestricted. */
export const CHARTED_ADOSH_ZONES: readonly string[] = ['high', 'medium']

/** A chart series: a band or zone, most severe first (it sits on the baseline). */
export interface HizSeries {
  id: string
  label: string
  /** Index into the file's count arrays. */
  index: number
  meaning: string
}

/**
 * Series of a measure, most severe first: the five WBGT bands from ≥ 33.0 °C down, or the High then Medium ADOSH zone
 * (sun TWL). The most severe band sits on the shared baseline so it compares exactly across bars.
 */
export function seriesFor(data: Pick<HoursInZoneFile, 'config'>, measure: HizMeasure): HizSeries[] {
  if (measure === 'wbgt') {
    return data.config.wbgtBands
      .map((b, index) => ({ id: b.id, label: `WBGT ${b.label} °C`, index, meaning: b.meaning ?? '' }))
      .reverse()
  }
  const out: HizSeries[] = []
  for (const id of CHARTED_ADOSH_ZONES) {
    const index = data.config.adoshZones.findIndex((z) => z.id === id)
    if (index < 0) continue
    const z = data.config.adoshZones[index]
    const range = z.minWm2 == null ? `TWL < ${z.maxWm2}` : z.maxWm2 == null ? `TWL ≥ ${z.minWm2}` : `TWL ${z.minWm2}–${z.maxWm2}`
    out.push({ id: z.id, label: `${z.label.split(' — ')[0]} (${range} W/m²)`, index, meaning: z.label })
  }
  return out
}

const countsOf = (c: HizCounts, measure: HizMeasure): number[] => (measure === 'wbgt' ? c.wbgtBands : c.adoshSun)

/** A chart row: a category plus one value per series id. */
export type HizRow = { key: string; label: string; total: number } & Record<string, number | string>

function rowFrom(key: string, label: string, counts: number[], series: readonly HizSeries[]): HizRow {
  const row: HizRow = { key, label, total: 0 }
  let total = 0
  for (const s of series) {
    const v = Math.round((counts[s.index] ?? 0) * 10) / 10
    row[s.id] = v
    total += v
  }
  row.total = Math.round(total * 10) / 10
  return row
}

/** Mean season per site (primary run), in `siteOrder`. */
export function seasonRows(data: HoursInZoneFile, measure: HizMeasure, siteOrder: readonly string[], nameOf: (id: string) => string): HizRow[] {
  const series = seriesFor(data, measure)
  const out: HizRow[] = []
  for (const id of siteOrder) {
    const s = data.sites.find((x) => x.site === id && x.run === PRIMARY_RUN)
    if (s) out.push(rowFrom(id, nameOf(id), countsOf(s.meanSeason, measure), series))
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Mean hours per month of the season for one site. */
export function monthRows(data: HoursInZoneFile, site: string, measure: HizMeasure): HizRow[] {
  const series = seriesFor(data, measure)
  return data.byMonth
    .filter((m) => m.site === site)
    .sort((a, b) => a.month - b.month)
    .map((m) => rowFrom(String(m.month), MONTHS[m.month - 1] ?? String(m.month), countsOf(m, measure), series))
}

/** Mean hours per season at each local hour of day (each hour of day has one sample per season day). */
export function hourRows(data: HoursInZoneFile, site: string, measure: HizMeasure): HizRow[] {
  const series = seriesFor(data, measure)
  return data.byHour
    .filter((h) => h.site === site)
    .sort((a, b) => a.hour - b.hour)
    .map((h) => rowFrom(String(h.hour), `${String(h.hour).padStart(2, '0')}:00`, countsOf(h, measure), series))
}

/**
 * Local hours of day whose samples fall inside the midday-break window (12:30–15:00 → the 13:00 and 14:00 samples;
 * the file's note: hour of day = local hour of the instantaneous sample time).
 */
export function middayBreakHours(startHhmm: string, endHhmm: string): number[] {
  const toMin = (s: string): number => {
    const [h, m] = s.split(':').map(Number)
    return h * 60 + m
  }
  const a = toMin(startHhmm)
  const b = toMin(endHhmm)
  const out: number[] = []
  for (let h = 0; h < 24; h++) if (h * 60 >= a && h * 60 < b) out.push(h)
  return out
}

/** Midday-break row of a site ('all' = the five-site mean). */
export function middayRow(data: HoursInZoneFile, site: string): HizMiddayRow | null {
  return data.middayBreak.find((m) => m.site === site) ?? null
}

// ─────────────────────────────── Loader ───────────────────────────────

/** Relative path: the app is served under base './'. */
export const HOURS_IN_ZONE_URL = './data/validation/hours-in-zone.json'

export type HizState = { status: 'loading' } | { status: 'ready'; data: HoursInZoneFile } | { status: 'error'; message: string }

let cache: Promise<HoursInZoneFile> | null = null

function load(): Promise<HoursInZoneFile> {
  cache ??= fetch(HOURS_IN_ZONE_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<HoursInZoneFile>
    })
    .then((d) => {
      if (!d || d.schema !== 'zill.validation.hours_in_zone/v1' || !Array.isArray(d.sites)) throw new Error('unexpected file format')
      return d
    })
    .catch((err: unknown) => {
      cache = null
      throw err
    })
  return cache
}

/** Loads hours-in-zone.json once per page. */
export function useHoursInZone(): HizState {
  const [state, setState] = useState<HizState>({ status: 'loading' })
  useEffect(() => {
    let alive = true
    load().then(
      (data) => alive && setState({ status: 'ready', data }),
      (err: unknown) => alive && setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    )
    return () => {
      alive = false
    }
  }, [])
  return state
}
