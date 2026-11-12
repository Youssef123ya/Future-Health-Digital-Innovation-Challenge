/**
 * "Conditions now" for the five Abu Dhabi sites on the overview: the live Open-Meteo ECMWF IFS forecast for each site
 * (data/weather.ts fetchLiveForecast, with a timeout) → resolveEnvironment (the data layer's fail-safe chain) →
 * engine/indices computeSiteHeat (Liljegren WBGT in sun and shade, Brake & Bates TWL) → the ADOSH TWL zone of the
 * jurisdiction rule pack. Offline, the chain falls back by itself: a forecast the service worker cached earlier (aged by
 * its own time axis, so the staleness margin applies) or, with nothing cached, the conservative design hour derived
 * from the cached 2020–2025 archive. Site-level weather only: no individual data.
 */
import { SITES, type SiteId } from '../../../data/sites'
import { fetchLiveForecast, resolveEnvironment, type FetchLike, type WeatherSeries } from '../../../data/weather'
import { computeSiteHeat } from '../../../engine/indices'
import { isMiddayBreak, twlZone } from '../../../engine/regulation'
import { DAY_MS } from '../../../engine/time'
import type { EnvSource, RiskLevel } from '../../../engine/types'

/** Overview fetch timeout: longer than the service worker's 5 s network timeout (vite.config.ts), so a cached forecast
 * served by the worker arrives before this request gives up. [ENG] */
export const OVERVIEW_FORECAST_TIMEOUT_MS = 8_000
/** Reuse one fetch for this long within a page session. [ENG] */
export const LIVE_CONDITIONS_TTL_MS = 10 * 60_000

/** Conditions at one site, resolved for `t`. */
export interface SiteConditions {
  siteId: SiteId
  name: string
  t: number
  source: EnvSource
  /** Minutes since the data were obtained (null: unknown, treated as old). */
  ageMin: number | null
  stale: boolean
  confidence: 'high' | 'medium' | 'low'
  /** Fail-safe WBGT margin the engine would add for stale or missing data, °C. */
  wbgtMarginC: number
  taC: number
  rhPct: number
  wbgtC: number
  wbgtShadeC: number
  twlWm2: number
  zone: { label: string; level: RiskLevel } | null
  /** Why the live forecast was not used (timeout, network…), when it was not. */
  fetchError: string | null
}

export interface LiveConditions {
  t: number
  sites: SiteConditions[]
  /** Sites resolved from a fresh live forecast. */
  liveCount: number
  middayBreak: boolean
}

/**
 * Bounds `obtainedAt` of a fetched forecast by its own time axis. An Open-Meteo forecast starts at local midnight of the
 * day it was requested, so it was obtained no later than 24 h after its first sample: a response the service worker
 * served from its cache days later is aged accordingly instead of passing as fresh (fail-safe: older data → larger
 * margin).
 */
export function boundObtainedAt(series: WeatherSeries, fetchedAt: number): WeatherSeries {
  const first = series.samples[0]?.t
  const claimed = series.obtainedAt ?? fetchedAt
  const obtainedAt = first === undefined ? Math.min(claimed, fetchedAt) : Math.min(claimed, fetchedAt, first + DAY_MS)
  return obtainedAt === series.obtainedAt ? series : { ...series, obtainedAt }
}

/** Resolves the conditions at a site for `now` from a live forecast (or none: the fail-safe chain decides). Pure. */
export function conditionsFor(siteId: SiteId, now: number, live: WeatherSeries | null, fetchError: string | null = null): SiteConditions {
  const site = SITES.find((s) => s.id === siteId)
  if (!site) throw new Error(`Unknown site ${siteId}`)
  const env = resolveEnvironment({ siteId, now, liveForecast: live })
  const heat = computeSiteHeat(env.sample, site)
  const zone = twlZone(heat.twlWm2)
  return {
    siteId,
    name: site.name,
    t: now,
    source: env.source,
    ageMin: env.ageMin,
    stale: env.stale,
    confidence: env.confidence,
    wbgtMarginC: env.wbgtMarginC,
    taC: heat.taC,
    rhPct: heat.rhPct,
    wbgtC: heat.wbgtC,
    wbgtShadeC: heat.wbgtShadeC,
    twlWm2: heat.twlWm2,
    zone: zone ? { label: zone.label, level: zone.level } : null,
    fetchError,
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Fetches and resolves all five sites (each independently: one failed request does not hide the others). */
export async function fetchLiveConditions(opts: { now?: number; fetch?: FetchLike; timeoutMs?: number } = {}): Promise<LiveConditions> {
  const now = opts.now ?? Date.now()
  const series = await Promise.all(
    SITES.map(async (site) => {
      try {
        const s = await fetchLiveForecast({ site, now, forecastDays: 2, timeoutMs: opts.timeoutMs ?? OVERVIEW_FORECAST_TIMEOUT_MS, fetch: opts.fetch })
        return { series: boundObtainedAt(s, now), error: null }
      } catch (err) {
        return { series: null, error: errorText(err) }
      }
    }),
  )
  const sites = SITES.map((site, i) => conditionsFor(site.id, now, series[i].series, series[i].error))
  return {
    t: now,
    sites,
    liveCount: sites.filter((s) => s.source === 'forecast' && !s.stale).length,
    middayBreak: isMiddayBreak(now),
  }
}

let cached: { at: number; promise: Promise<LiveConditions> } | null = null

/** {@link fetchLiveConditions}, shared for {@link LIVE_CONDITIONS_TTL_MS} within the page session; `force` refetches. */
export function loadLiveConditions(force = false): Promise<LiveConditions> {
  const now = Date.now()
  if (!force && cached && now - cached.at < LIVE_CONDITIONS_TTL_MS) return cached.promise
  const promise = fetchLiveConditions({ now })
  cached = { at: now, promise }
  promise.catch(() => {
    if (cached?.promise === promise) cached = null
  })
  return promise
}

const SOURCE_TEXT: Readonly<Record<EnvSource, string>> = {
  forecast: 'Live forecast',
  cached_forecast: 'Cached forecast',
  archive: 'Weather archive',
  site_sensor: 'Site WBGT meter',
  conservative_default: 'Fail-safe default',
}

/** Plain-English data source of a site's conditions, with its age. */
export function sourceText(c: Pick<SiteConditions, 'source' | 'ageMin' | 'stale'>): string {
  const base = c.source === 'forecast' && c.stale ? 'Stale forecast' : SOURCE_TEXT[c.source]
  if (c.ageMin === null || c.source === 'conservative_default') return base
  const age = c.ageMin < 90 ? `${Math.round(c.ageMin)} min old` : `${(c.ageMin / 60).toFixed(c.ageMin < 600 ? 1 : 0)} h old`
  return `${base} · ${age}`
}
