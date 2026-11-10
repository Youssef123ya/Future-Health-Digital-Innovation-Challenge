/**
 * Simulation inputs for one site-day — the weather the virtual workers experience (analysis), the weather the engine
 * could have known (archived forecast), the roster and provenance (docs/SIMULATION.md §3; contract: sim/types.ts SimData).
 *
 * Evidence class: inputs to the SIMULATED COHORT (docs/SIMULATION.md). Weather is real (ECMWF IFS analysis and archived
 * ECMWF IFS 0.25° day-1 forecasts via Open-Meteo); the workforce is synthetic (data/workforce.ts).
 *
 * Two loaders share one implementation (data/weather.ts `createWeatherLoader`): the browser loader fetches
 * './data/weather/...' (public/data in the build, cached by the service worker); the Node loader reads the same files
 * from disk (tests and back-test scripts run with vitest / tsx). This module never reads a clock.
 */
import type { Crew, EnvSample, WorkerProfile } from '../engine/types'
import { HOUR_MS, epochFromLocal } from '../engine/time'
import { getSite, isSiteId, type SiteId } from '../data/sites'
import {
  WEATHER_DATA_FOOTER,
  archivePeriodFor,
  createEnvSampler,
  createWeatherLoader,
  interpolateEnv,
  previousRunsYearFor,
  type DemoDay,
  type FetchLike,
  type InstantEnvSample,
  type WeatherLoader,
  type WeatherSeries,
} from '../data/weather'
import { DEFAULT_WORKFORCE_SEED, generateWorkforce } from '../data/workforce'
import type { SimData, SimWeather } from './types'

/**
 * Hours of hourly data kept around a local day: from 2 h before local midnight to 26 h after it, so every minute of
 * the day can be interpolated (radiation of the hour [h, h+1) sits in the sample stamped h+1) [ENG].
 */
export const SIM_DAY_WINDOW = Object.freeze({
  beforeH: 2,
  afterH: 26,
  basis: '[ENG] covers 00:00–24:00 local plus the next hourly stamp (Open-Meteo radiation is the mean over the preceding hour)',
})

/** Provenance line used when no archived forecast exists for the date (the engine then sees the analysis). */
export const PERFECT_FORECAST_NOTE =
  'Engine forecast: no archived forecast is cached for this date, so the engine sees the analysis itself (perfect-forecast assumption — optimistic for forecast-based policies; documented in docs/SIMULATION.md §3).'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function checkDate(date: string): void {
  if (!DATE_RE.test(date) || !Number.isFinite(epochFromLocal(`${date}T00:00`))) throw new RangeError(`simdata: invalid local date '${date}' (expected YYYY-MM-DD)`)
}

/**
 * Hourly samples of a series that fall inside the simulation window of a local date ({@link SIM_DAY_WINDOW}).
 * Basis: EnvSample contract (engine/types.ts: `t` is the end of the radiation hour); [ENG] window.
 */
export function daySamples(samples: readonly EnvSample[], date: string): EnvSample[] {
  checkDate(date)
  const d0 = epochFromLocal(`${date}T00:00`)
  const lo = d0 - SIM_DAY_WINDOW.beforeH * HOUR_MS
  const hi = d0 + SIM_DAY_WINDOW.afterH * HOUR_MS
  return samples.filter((s) => s.t >= lo && s.t <= hi).map((s) => ({ ...s }))
}

const gridText = (s: WeatherSeries): string =>
  s.grid ? `grid ${s.grid.lat.toFixed(3)}°N ${s.grid.lon.toFixed(3)}°E (${s.grid.cellSelection} cell)` : 'grid not recorded'

/**
 * SimWeather for a cached demo day (public/data/weather/demo-days.json): analysis = the day's ECMWF IFS analysis (24 local
 * hours); forecast = the archived ECMWF IFS 0.25° day-1 forecast for the same hours (Open-Meteo Previous Runs), i.e. what
 * a site could have known a day ahead. Basis: docs/SIMULATION.md §3; data_and_validation.md §8 (demo-day selection).
 */
export function simWeatherFromDemoDay(day: DemoDay): SimWeather {
  const fc = day.forecasts[1]
  const hasFc = fc !== undefined && fc.samples.length > 0
  const year = day.date.slice(0, 4)
  return {
    analysis: day.analysis.samples.map((s) => ({ ...s })),
    forecast: (hasFc ? fc.samples : day.analysis.samples).map((s) => ({ ...s })),
    provenance: [
      `Ground truth: ECMWF IFS analysis (Open-Meteo archive), ${gridText(day.analysis)}; demo day ${day.id} [${day.tags.join(', ')}] from public/data/weather/demo-days.json (source public/data/weather/archive/${day.siteId}_${year}${day.date.slice(5, 7) === '11' ? '-11' : ''}.json).`,
      hasFc
        ? `Engine forecast: ECMWF IFS 0.25° day-1 forecast for the same hours (Open-Meteo Previous Runs, issued ≈ 24 h before each valid hour), ${gridText(fc)}; cached in public/data/weather/demo-days.json.`
        : PERFECT_FORECAST_NOTE,
      ...day.why.map((w) => `Why this day: ${w}`),
      WEATHER_DATA_FOOTER,
    ],
  }
}

/**
 * SimWeather for any cached day from a season archive series (analysis) and an archived lead-1 Previous-Runs series
 * (forecast; null → the analysis, see {@link PERFECT_FORECAST_NOTE}). `files` are the repository paths quoted in the
 * provenance. Basis: docs/SIMULATION.md §3 ("the engine sees the forecast that was actually available").
 */
export function simWeatherFromSeries(
  siteId: SiteId,
  date: string,
  analysis: WeatherSeries,
  forecast: WeatherSeries | null,
  files: { analysis?: string; forecast?: string } = {},
): SimWeather {
  if (analysis.locationId !== siteId) throw new RangeError(`simdata: analysis series is for ${analysis.locationId}, not ${siteId}`)
  const an = daySamples(analysis.samples, date)
  if (an.length === 0) throw new RangeError(`simdata: the analysis series has no data for ${siteId} ${date}`)
  const fcDay = forecast && forecast.locationId === siteId ? daySamples(forecast.samples, date) : []
  const hasFc = fcDay.length >= 12
  return {
    analysis: an,
    forecast: hasFc ? fcDay : an.map((s) => ({ ...s })),
    provenance: [
      `Ground truth: ${analysis.model === 'era5' ? 'ERA5 reanalysis' : 'ECMWF IFS analysis'} (Open-Meteo archive), ${gridText(analysis)}${files.analysis ? `; ${files.analysis}` : ''}.`,
      hasFc && forecast
        ? `Engine forecast: ${forecast.model} day-${forecast.leadDays ?? 1} forecast (Open-Meteo Previous Runs, issued ≈ ${24 * (forecast.leadDays ?? 1)} h before each valid hour), ${gridText(forecast)}${files.forecast ? `; ${files.forecast}` : ''}.`
        : PERFECT_FORECAST_NOTE,
      WEATHER_DATA_FOOTER,
    ],
  }
}

/** Minute samplers over a SimWeather (data/weather.ts `createEnvSampler`: energy-conserving cos-zenith disaggregation). */
export function weatherSamplers(weather: SimWeather, siteId: SiteId): {
  analysis: (t: number) => InstantEnvSample | null
  forecast: (t: number) => InstantEnvSample | null
} {
  const site = getSite(siteId)
  const loc = { lat: site.lat, lon: site.lon }
  return { analysis: createEnvSampler(weather.analysis, loc), forecast: createEnvSampler(weather.forecast, loc) }
}

/**
 * Minute-resolution analysis and forecast from `startT` to `endT` inclusive (data/weather.ts `interpolateEnv`, 1-min
 * step; instants outside the hourly data are skipped). Basis: docs/SIMULATION.md §3 (weather interpolated to the minute).
 */
export function minuteWeather(
  weather: SimWeather,
  siteId: SiteId,
  startT: number,
  endT: number,
): { analysis: InstantEnvSample[]; forecast: InstantEnvSample[] } {
  const site = getSite(siteId)
  const loc = { lat: site.lat, lon: site.lon }
  return { analysis: interpolateEnv(weather.analysis, startT, endT, loc, 1), forecast: interpolateEnv(weather.forecast, startT, endT, loc, 1) }
}

/** Roster options of {@link siteRoster} / {@link SimDataLoader.load}. */
export interface RosterOptions {
  /** Explicit roster (both or neither). */
  crews?: Crew[]
  workers?: WorkerProfile[]
  /** Synthetic workforce seed (default data/workforce.ts DEFAULT_WORKFORCE_SEED). */
  workforceSeed?: string | number
  /** Generated crews for the site (default 3). */
  crewsPerSite?: number
  /** Include the fixed Musaffah demo crew when the site is Musaffah (default true). */
  includeDemoCrew?: boolean
}

/**
 * The roster of one site: the explicit crews/workers when given, else the deterministic synthetic workforce of that site
 * (data/workforce.ts generateWorkforce; plus the Musaffah demo crew). Basis: sim/types.ts SimConfig.crews ("default = the
 * synthetic workforce for the site").
 */
export function siteRoster(siteId: SiteId, opts: RosterOptions = {}): { crews: Crew[]; workers: WorkerProfile[] } {
  if ((opts.crews === undefined) !== (opts.workers === undefined)) throw new RangeError('simdata: pass both crews and workers, or neither')
  if (opts.crews && opts.workers) return { crews: opts.crews, workers: opts.workers }
  const wf = generateWorkforce({
    seed: opts.workforceSeed ?? DEFAULT_WORKFORCE_SEED,
    crewsPerSite: opts.crewsPerSite ?? 3,
    sites: [getSite(siteId)],
    includeDemoCrew: opts.includeDemoCrew ?? true,
  })
  const crews = wf.crews.filter((c) => c.siteId === siteId)
  const ids = new Set(crews.flatMap((c) => c.workerIds))
  return { crews, workers: wf.workers.filter((w) => ids.has(w.id)) }
}

/** Loads SimData for a site and local date. */
export interface SimDataLoader {
  /** Weather only (demo day when cached, else archive + previous runs). Rejects when no analysis is cached. */
  weather(siteId: SiteId, date: string): Promise<SimWeather>
  /** Weather + roster ({@link siteRoster}). */
  load(siteId: SiteId, date: string, opts?: RosterOptions): Promise<SimData>
  /** The cached demo days (public/data/weather/demo-days.json). */
  demoDays(): Promise<DemoDay[]>
}

/**
 * A SimData loader over any data/weather.ts WeatherLoader: a demo day is used when one is cached for (site, date);
 * otherwise the season archive (Jun–Sep 2020–2025, Nov 2025 at Musaffah) gives the analysis and the Previous-Runs file
 * (Jun–Sep 2024–2025) the lead-1 forecast. Basis: docs/SIMULATION.md §3; data_and_validation.md §8 (cache layout).
 */
export function createSimDataLoader(loader: WeatherLoader): SimDataLoader {
  const weather = async (siteId: SiteId, date: string): Promise<SimWeather> => {
    if (!isSiteId(siteId)) throw new RangeError(`simdata: unknown site '${String(siteId)}'`)
    checkDate(date)
    const demo = (await loader.demoDays()).find((d) => d.siteId === siteId && d.date === date)
    if (demo) return simWeatherFromDemoDay(demo)
    const noon = epochFromLocal(`${date}T12:00`)
    const period = archivePeriodFor(siteId, noon)
    if (period === null) throw new RangeError(`simdata: no cached weather for ${siteId} on ${date} (archive covers Jun–Sep 2020–2025, Nov 2025 at Musaffah)`)
    const analysis = await loader.archive(siteId, period)
    const year = previousRunsYearFor(noon)
    let forecast: WeatherSeries | null = null
    if (year !== null) {
      try {
        forecast = await loader.previousRuns(siteId, year, 'ecmwf_ifs025', 1)
      } catch {
        forecast = null
      }
    }
    return simWeatherFromSeries(siteId, date, analysis, forecast, {
      analysis: `public/data/weather/archive/${siteId}_${period}.json`,
      ...(year !== null ? { forecast: `public/data/weather/previous-runs/${siteId}_${year}.json` } : {}),
    })
  }
  return {
    weather,
    demoDays: () => loader.demoDays(),
    load: async (siteId, date, opts = {}) => {
      const w = await weather(siteId, date)
      const roster = siteRoster(siteId, opts)
      return { site: getSite(siteId), crews: roster.crews, workers: roster.workers, weather: w }
    },
  }
}

/**
 * Browser loader: fetches './data/weather/...' relative to the page (public/data in the build; offline via the service
 * worker). Basis: data/weather.ts createWeatherLoader.
 */
export function createBrowserSimDataLoader(opts: { baseUrl?: string; fetch?: FetchLike } = {}): SimDataLoader {
  return createSimDataLoader(createWeatherLoader({ ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) }))
}

interface FsLike {
  readFile(path: string | URL, encoding: 'utf8'): Promise<string>
}

/** Module specifier held in a variable so bundlers leave it alone (the browser build never calls the Node loader). */
const FS_MODULE = 'node:fs/promises'
/** Repository data directory relative to this file (a variable, so Vite does not treat it as an asset URL). */
const DATA_DIR_REL = '../../public/data/'
let fsModule: Promise<FsLike> | null = null

function nodeFs(): Promise<FsLike> {
  fsModule ??= import(/* @vite-ignore */ FS_MODULE) as Promise<FsLike>
  return fsModule
}

/**
 * Node loader (vitest, tsx scripts): the same cached files read from disk with node:fs — by default the repository's
 * public/data/ resolved from this module's URL, so it works from any working directory. Basis: data/weather.ts
 * createWeatherLoader with a file-system FetchLike.
 */
export function createNodeSimDataLoader(opts: { dataDir?: string | URL } = {}): SimDataLoader {
  const dir = opts.dataDir ?? new URL(DATA_DIR_REL, import.meta.url)
  const fetchFs: FetchLike = async (input: string) => {
    const rel = input.replace(/^\.\/data\//, '')
    const target =
      typeof dir === 'string' ? `${dir.replace(/[\\/]+$/, '')}/${rel}` : new URL(rel, dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`))
    let text: string
    try {
      text = await (await nodeFs()).readFile(target, 'utf8')
    } catch {
      return { ok: false, status: 404, json: async () => null }
    }
    return { ok: true, status: 200, json: async () => JSON.parse(text) as unknown }
  }
  return createSimDataLoader(createWeatherLoader({ fetch: fetchFs, baseUrl: './data/' }))
}
