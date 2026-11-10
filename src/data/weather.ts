/**
 * Zill weather data layer.
 *
 * - Pure parsers for every cached file type in public/data (schemas: docs/research/data_and_validation.md §8) → hourly
 *   {@link EnvSample} series with provenance (model, grid cell, lead day, fetch time).
 * - Minute-level interpolation: state variables linearly; radiation disaggregated *within* each hour by cos(zenith), so
 *   the hourly energy is conserved and there is never sunlight while the sun is down.
 * - A live Open-Meteo forecast fetcher (models=ecmwf_ifs, the UAE best-match model; data_and_validation.md §3).
 * - {@link resolveEnvironment}: the fail-safe source chain of ARCHITECTURE.md §5 — site sensor → live forecast →
 *   archive → cached forecast → conservative default. A missing or stale input can only make the result more
 *   conservative: > 6 h lowers confidence, ≥ 24 h adds a 1 °C WBGT margin, unknown wind → 0.5 m/s, unknown solar →
 *   clear sky.
 * - A browser loader for the cached JSON (relative to the page, injectable fetch) and a METAR loader.
 *
 * Conventions (data_and_validation.md §1, §3.2, §8): cached time axes are `t_i = t0_unix + 3600·i` (UTC seconds); local
 * time is Asia/Dubai (UTC+4, no DST); `temperature_2m`, `relative_humidity_2m`, `dew_point_2m`, `surface_pressure`
 * (station level, not MSL), `wind_speed_10m` (m/s) and `cloud_cover` are instants at t; every radiation field is the
 * mean over the preceding hour [t − 1 h, t). There is no 2 m wind (`wind_speed_2m` is invalid). `best_match` is never
 * used for skill work.
 *
 * This module is occupational-safety decision-support plumbing: it estimates the environment a worker is exposed to,
 * and says nothing about the person.
 */
import type { EnvSample, EnvSource, RiskDriver, Site } from '../engine/types'
import { DAY_MS, DUBAI_OFFSET_MS, HOUR_MS, MINUTE_MS, localParts } from '../engine/time'
import { getSite, isSiteId, type GridCellInfo, type SiteId } from './sites'

// ═══════════════════════════════ Attribution and licensing ═══════════════════════════════

/**
 * Open-Meteo attribution. Basis: Open-Meteo licence page — "You must include a link next to any location Open-Meteo
 * data are displayed … `<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>`"; data are CC BY 4.0,
 * which also requires a licence link and an indication of changes (data_and_validation.md §7).
 */
export const OPEN_METEO_ATTRIBUTION = {
  text: 'Weather data by Open-Meteo.com',
  href: 'https://open-meteo.com/',
  html: '<a href="https://open-meteo.com/">Weather data by Open-Meteo.com</a>',
  licence: 'CC BY 4.0',
  licenceUrl: 'https://creativecommons.org/licenses/by/4.0/',
  changes: 'Re-packaged into column arrays by Zill; values not modified.',
} as const

/**
 * Copernicus (ERA5) attribution and disclaimer. Basis: ECMWF Confluence (updated 2025-07-03), "[Generated using/Contains
 * modified] Copernicus Climate Change Service information [year]." plus the C3S disclaimer; the CDS catalogue lists
 * ERA5 as CC-BY-4.0 (DOI 10.24381/cds.adbb2d47) (data_and_validation.md §7).
 */
export const COPERNICUS_ATTRIBUTION =
  'Contains modified Copernicus Climate Change Service information 2026. Neither the European Commission nor ECMWF is ' +
  'responsible for any use that may be made of the Copernicus information or data it contains.'

/** Open-Meteo software citation (Zenodo), as recommended by Open-Meteo (data_and_validation.md §7). */
export const OPEN_METEO_CITATION =
  'Zippenfenig, P. (2023). Open-Meteo.com Weather API [Computer software]. Zenodo. https://doi.org/10.5281/ZENODO.7970649'

/** IEM attribution for the METAR observations (public-domain statement, attribution appreciated; data_and_validation.md §7). */
export const IEM_ATTRIBUTION = 'Observations: Iowa Environmental Mesonet, Iowa State University.'

/** Suggested data footer, transcribed from data_and_validation.md §7. */
export const WEATHER_DATA_FOOTER =
  'Weather data by Open-Meteo.com (CC BY 4.0) — ECMWF IFS (CC BY 4.0); contains modified Copernicus Climate Change ' +
  'Service information 2026. Observations: Iowa Environmental Mesonet, Iowa State University. Data re-packaged by Zill.'

/**
 * Licensing note. Basis: Open-Meteo Terms — "You may only use the free API services for non-commercial purposes";
 * commercial use includes commercial products. A hackathon prototype plausibly falls within non-commercial use, but any
 * employer pilot or production deployment is commercial and needs a paid plan: API Standard €29/month (Forecast API)
 * or API Professional €99/month / €1,099/year (adds historical weather and Previous Runs), prices fetched 2026-11-09
 * (data_and_validation.md §1, §7). Interpretation, not legal advice.
 */
export const OPEN_METEO_LICENSING_NOTE =
  'The free Open-Meteo API is for non-commercial use only. This prototype uses it under that tier; an employer pilot ' +
  'or production deployment needs a commercial plan (API Standard €29/month for forecasts; API Professional €99/month ' +
  'or €1,099/year for historical data and previous model runs; prices as of 2026-11-09).'

// ═══════════════════════════════ API and fail-safe constants ═══════════════════════════════

/** Live forecast endpoint (data_and_validation.md §2). */
export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

/**
 * The 10 hourly variables needed for Liljegren WBGT, as cached in every file (data_and_validation.md §1, §8 `WbgtVar`).
 * `wind_speed_2m` is deliberately absent: the API returns it as all-null with unit "undefined" [VERIFIED].
 */
export const WBGT_VARIABLES = [
  'temperature_2m',
  'relative_humidity_2m',
  'dew_point_2m',
  'surface_pressure',
  'wind_speed_10m',
  'shortwave_radiation',
  'direct_radiation',
  'diffuse_radiation',
  'direct_normal_irradiance',
  'cloud_cover',
] as const

/** One of the 10 cached WBGT input variables. */
export type WbgtVariable = (typeof WBGT_VARIABLES)[number]

/** Largest `forecast_days` the Forecast API accepts ("Allowed range 0 to 16", data_and_validation.md §2). */
export const MAX_FORECAST_DAYS = 16

/**
 * Live-forecast request timeout, ms [ENG]. Matches the service worker's NetworkFirst `networkTimeoutSeconds: 5`
 * (vite.config.ts) so a slow network falls back to cached data quickly.
 */
export const LIVE_FORECAST_TIMEOUT_MS = 5_000

/** Fail-safe wind when unknown: 0.5 m/s at 10 m (ARCHITECTURE.md §5 "Unknown wind → 0.5 m/s"). */
export const DEFAULT_WIND10_MS = 0.5

/**
 * A forecast this old is stale and its confidence is lowered (ARCHITECTURE.md §5: "older than 6 h → confidence
 * lowered"). 6 h is one ECMWF IFS update cycle (`update_interval_seconds` 21600, data_and_validation.md §3.5), so a
 * forecast this old has been superseded. Exactly 6 h counts as stale [ENG, protective boundary].
 */
export const FORECAST_STALE_AFTER_MIN = 360

/**
 * A forecast this old earns a WBGT safety margin (ARCHITECTURE.md §5: "older than 24 h → add 1 °C WBGT margin").
 * Exactly 24 h counts [ENG, protective boundary] — so archived day-1 forecasts (issued 24–29 h ahead) carry it.
 */
export const FORECAST_MARGIN_AFTER_MIN = 1_440

/** WBGT margin for data at least 24 h old, or of unknown age (ARCHITECTURE.md §5). */
export const STALE_WBGT_MARGIN_C = 1

/** Forecast lead beyond which values are labelled low confidence (data_and_validation.md §3.5: "If days 8–16 are shown, label them low confidence"). */
export const FORECAST_LOW_CONFIDENCE_LEAD_DAYS = 7

/**
 * A site-sensor reading older than this is treated as missing [ENG]. WBGT meters log every 1–2 min; a 15-min silence
 * indicates a fault, so the chain falls back to the forecast and asks for a sensor check.
 */
export const SENSOR_MAX_AGE_MIN = 15

/** Solar constant used by Liljegren's wbgt.c for top-of-atmosphere irradiance: 1367 W/m² (wbgt_liljegren.md §4, §11). */
export const SOLAR_CONSTANT_WM2 = 1367

/** Inverse square of the perihelion Earth–Sun distance (0.983 AU) — the largest TOA factor (wbgt_liljegren.md §7.3). */
const MAX_INV_R2 = 1 / (0.983 * 0.983)

/** Open-Meteo floors the DNI divisor at sin 3° (`Zensun.calculateBackwardsDNI`, data_and_validation.md §3.3). */
const SIN_3DEG = Math.sin((3 * Math.PI) / 180)

/** Magnus coefficients used by Open-Meteo for RH ↔ dew point: β = 17.625, λ = 243.04 °C (data_and_validation.md §3.4). */
const MAGNUS_BETA = 17.625
const MAGNUS_LAMBDA_C = 243.04

// ═══════════════════════════════ Types ═══════════════════════════════

/** Weather models that appear in the cached files and the live fetcher. */
export type WeatherModel =
  | 'ecmwf_ifs'
  | 'era5'
  | 'ecmwf_ifs025'
  | 'dwd_icon_seamless'
  | 'ncep_gfs_seamless'
  | 'era5_land'
  | 'era5_seamless'

/** Archive models stored per site (data_and_validation.md §8 `ArchiveFile.models`). `ecmwf_ifs` is the live-forecast model. */
export type ArchiveModel = 'ecmwf_ifs' | 'era5'

/** Previous-Runs models (data_and_validation.md §8). `ecmwf_ifs025` is primary; never `best_match` (it mixes models by lead). */
export type PreviousRunsModel = 'ecmwf_ifs025' | 'dwd_icon_seamless' | 'ncep_gfs_seamless'

/** Lead day of an archived forecast: dN = value for the same valid time from runs issued ~24·N h earlier. */
export type LeadDay = 0 | 1 | 2 | 3

/** Model blocks of a validation-point file (airport cells, cell_selection=nearest). */
export type ValidationModelKey = 'era5@nearest' | 'era5_land@nearest' | 'era5_seamless@nearest' | 'ecmwf_ifs@nearest'

/** Validation points (airports with METAR). */
export type ValidationPointId = 'omaa' | 'omad' | 'omal'

/** METAR stations with cached observations. */
export type MetarIcao = 'OMAA' | 'OMAD' | 'OMAL'

/** Grid cell metadata, camel-cased from the cached `Grid` block (same shape as `SITE_DATA_INFO` cells in sites.ts). */
export type GridCell = GridCellInfo

/** Latitude/longitude in degrees (north, east). */
export interface LatLon {
  lat: number
  lon: number
}

/**
 * An hourly environmental series with provenance. Samples are ascending; `t` is the end of the hour over which the
 * radiation fields were averaged (the {@link EnvSample} contract for Open-Meteo hourly data).
 */
export interface WeatherSeries {
  /** Site id ('musaffah', …) or validation point id ('omaa', …). */
  locationId: string
  /** Source label carried by every sample. */
  source: EnvSource
  model: WeatherModel
  grid: GridCell | null
  /** For archived Previous-Runs forecasts: lead day N (issued ~24·N h before each valid time). */
  leadDays?: LeadDay
  /** Epoch ms when the data were obtained (fetch time of a live or persisted forecast). */
  obtainedAt?: number
  samples: EnvSample[]
  /** Hours omitted because a required variable (T, humidity, pressure, wind or GHI) was null. */
  droppedHours: number
}

/**
 * An {@link EnvSample} whose radiation fields are *instantaneous* at `t` (not an Open-Meteo preceding-hour mean).
 * Produced by the interpolators, the conservative default and {@link resolveEnvironment}. Evaluate solar geometry at
 * `t` for these samples (see {@link solarGeometryTime}).
 */
export interface InstantEnvSample extends EnvSample {
  radiationWindowMin: 0
}

/** Cos(zenith) provider (t epoch ms, latitude and longitude in degrees). Inject engine/solar.ts here when available. */
export type CosZenithFn = (t: number, latDeg: number, lonDeg: number) => number

/** Thrown by parsers, the loader and the live fetcher. `kind` lets callers decide how to fall back. */
export class WeatherDataError extends Error {
  readonly kind: 'schema' | 'network' | 'http' | 'timeout' | 'api'
  constructor(kind: WeatherDataError['kind'], message: string) {
    super(message)
    this.name = 'WeatherDataError'
    this.kind = kind
  }
}

// ─────────────── Raw cached-file schemas (data_and_validation.md §8, transcribed) ───────────────

type Num = number | null

/** Time axis shared by every cached weather file. */
export interface TimeAxisJson {
  timezone: string
  utc_offset_seconds: number
  start_local: string
  end_local: string
  /** UTC epoch seconds of index 0. */
  t0_unix: number
  step_seconds: number
  n: number
  rule: string
}

/** Grid block as stored in the files. */
export interface GridJson {
  lat: number
  lon: number
  elevation_m: number
  cell_selection: 'land' | 'nearest'
}

/** Site block as stored in the files. */
export interface SiteJson {
  id: string
  name: string
  lat: number
  lon: number
  kind: string
}

/** `zill.weather.archive/v1`. */
export interface ArchiveFileJson {
  schema: 'zill.weather.archive/v1'
  site: SiteJson
  period: { start_date: string; end_date: string }
  time: TimeAxisJson
  models: Record<ArchiveModel, { grid: GridJson; request_url: string; fetched_at: string; columns: Record<WbgtVariable, Num[]> }>
}

/** `zill.weather.previous_runs/v1` (site files and validation-point files). */
export interface PreviousRunsFileJson {
  schema: 'zill.weather.previous_runs/v1'
  site?: SiteJson
  point?: { id: string; icao: string; name: string; lat: number; lon: number }
  period: { start_date: string; end_date: string }
  time: TimeAxisJson
  leads: { days: number[]; definition: string }
  models: Record<
    PreviousRunsModel,
    { grid: GridJson; request_url: string; fetched_at: string; columns: Record<WbgtVariable, Record<'d0' | 'd1' | 'd2' | 'd3', Num[]>> }
  >
}

/** `zill.weather.validation_point/v1`. */
export interface ValidationPointFileJson {
  schema: 'zill.weather.validation_point/v1'
  point: { id: ValidationPointId; icao: string; name: string; lat: number; lon: number; station: { lat: number; lon: number; elevation_m: number } }
  period: { start_date: string; end_date: string }
  time: TimeAxisJson
  models: Record<ValidationModelKey, { model: string; grid: GridJson; request_url: string; fetched_at: string; columns: Record<string, Num[]> }>
}

/** One demo day in `zill.weather.demo_days/v1`. */
export interface DemoDayJson {
  id: string
  site: SiteJson
  date: string
  tags: string[]
  why: string[]
  summary: {
    date: string
    tmax_c: number
    tmin_c: number
    td_mean_c: number
    td_max_c: number
    rh_min_pct: number
    rh_max_pct: number
    ghi_max_wm2: number
    daytime_cloud_mean_pct: number
    tw_stull_max_c: number
    wbgt_shade_proxy_daylight_max_c: number
    wbgt_shade_proxy_max_hour_local: string
  }
  analysis: { model: 'ecmwf_ifs'; grid: GridJson; from: string; t0_local: string; t0_unix: number; step_seconds: number; n: number; hourly: Record<WbgtVariable, Num[]> }
  forecast: { model: 'ecmwf_ifs025'; grid: GridJson; from: string; leads: Record<'d1' | 'd2' | 'd3', Record<WbgtVariable, Num[]>> }
}

/** `zill.weather.demo_days/v1`. */
export interface DemoDaysFileJson {
  schema: 'zill.weather.demo_days/v1'
  generated_at: string
  timezone: string
  utc_offset_seconds: number
  days: DemoDayJson[]
}

/** `zill.obs.metar/v1`. */
export interface MetarFileJson {
  schema: 'zill.obs.metar/v1'
  station: { icao: string; name: string; lat: number; lon: number; elevation_m: number; network: string; note: string }
  source: { provider: string; request_url: string; fetched_at: string; report_types: string; raw_csv: string }
  columns: {
    valid_utc: string[]
    temp_c: Num[]
    dewpoint_c: Num[]
    rh_pct: Num[]
    wind_dir_deg: Num[]
    wind_speed_ms: Num[]
    gust_ms: Num[]
    qnh_hpa: Num[]
    visibility_km: Num[]
    cavok: boolean[]
    wx: (string | null)[]
    sky1: (string | null)[]
  }
}

/** `zill.weather.manifest/v1`. */
export interface WeatherManifest {
  schema: 'zill.weather.manifest/v1'
  generated_at: string
  generator: string
  file_count: number
  total_bytes: number
  attribution_html: string
  licence: string
  files: { path: string; bytes: number; sha256: string; schema: string | null; models: string[] | null; period: unknown }[]
}

// ─────────────── Parsed demo days and observations ───────────────

/** Summary statistics of a demo day (local calendar day; analysis model ecmwf_ifs). The WBGT proxy ranks days only. */
export interface DemoDaySummary {
  date: string
  tmaxC: number
  tminC: number
  tdMeanC: number
  tdMaxC: number
  rhMinPct: number
  rhMaxPct: number
  ghiMaxWm2: number
  daytimeCloudMeanPct: number
  twStullMaxC: number
  /** Ranking proxy 0.7·min(Tw_Stull, Ta) + 0.3·Ta — NOT a WBGT for display (data_and_validation.md §8). */
  wbgtShadeProxyDaylightMaxC: number
  wbgtShadeProxyMaxHourLocal: string
}

/** A curated demo day: the IFS analysis (24 local hours) plus the archived IFS 0.25° forecasts for the same hours. */
export interface DemoDay {
  id: string
  siteId: SiteId
  date: string
  tags: string[]
  why: string[]
  summary: DemoDaySummary
  /** Source 'archive': what actually happened (IFS analysis), 24 hourly samples for local hours 00:00–23:00. */
  analysis: WeatherSeries
  /** Source 'cached_forecast': the forecast that was available 1, 2 and 3 days ahead. */
  forecasts: Record<1 | 2 | 3, WeatherSeries>
}

/** One routine METAR (UTC time axis; values exactly as reported, null when missing). */
export interface MetarObservation {
  t: number
  /** Integer precision (METAR TT group); quantisation ±0.5 °C. */
  taC: number | null
  tdC: number | null
  rhPct: number | null
  windDirDeg: number | null
  /** 10 m, 2-min mean (METAR convention), m/s. */
  windMs: number | null
  gustMs: number | null
  /** Sea-level-reduced QNH — NOT surface pressure. */
  qnhHpa: number | null
  visibilityKm: number | null
  cavok: boolean
  wx: string | null
  sky1: string | null
}

/** A parsed METAR file. */
export interface MetarSeries {
  icao: string
  name: string
  lat: number
  lon: number
  elevationM: number
  note: string
  provider: string
  observations: MetarObservation[]
}

// ═══════════════════════════════ Small numeric helpers ═══════════════════════════════

const lerp = (a: number, b: number, f: number): number => a + (b - a) * f

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function fail(message: string): never {
  throw new WeatherDataError('schema', message)
}

/** RH from air temperature and dew point (Magnus, Open-Meteo's own relation; data_and_validation.md §3.4), clamped to [0, 100]. */
function rhFromDewPoint(taC: number, tdC: number): number {
  const rh = (100 * Math.exp((MAGNUS_BETA * tdC) / (MAGNUS_LAMBDA_C + tdC))) / Math.exp((MAGNUS_BETA * taC) / (MAGNUS_LAMBDA_C + taC))
  return Math.min(100, Math.max(0, rh))
}

/** Dew point from air temperature and RH (inverse Magnus, data_and_validation.md §3.4). */
function dewPointFromRh(taC: number, rhPct: number): number {
  const g = Math.log(Math.max(rhPct, 0.1) / 100) + (MAGNUS_BETA * taC) / (MAGNUS_LAMBDA_C + taC)
  return (MAGNUS_LAMBDA_C * g) / (MAGNUS_BETA - g)
}

/**
 * Stull (2011) psychrometric wet bulb as used by Open-Meteo (`min(Tw, T)`; data_and_validation.md §3.4). Used here only
 * to derive the conservative default's humidity; it is NOT the natural wet bulb of the WBGT formula.
 */
function stullWetBulbC(taC: number, rhPct: number): number {
  const tw =
    taC * Math.atan(0.151977 * Math.sqrt(rhPct + 8.313659)) +
    Math.atan(taC + rhPct) -
    Math.atan(rhPct - 1.676331) +
    0.00391838 * rhPct ** 1.5 * Math.atan(0.023101 * rhPct) -
    4.686035
  return Math.min(tw, taC)
}

/** Percentile with linear interpolation between order statistics (Hyndman–Fan type 7, the numpy default). */
function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const a = [...values].sort((x, y) => x - y)
  const pos = p * (a.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.min(a.length - 1, lo + 1)
  return a[lo] + (a[hi] - a[lo]) * (pos - lo)
}

/** Round to a fixed number of decimals the way the provenance script did (`Number(x.toFixed(d))`). */
const roundTo = (x: number, decimals: number): number => Number(x.toFixed(decimals))

// ═══════════════════════════════ Solar geometry (minimal local port) ═══════════════════════════════

const DEG = Math.PI / 180

/**
 * NOAA Solar Calculator (Meeus) position: cos(apparent zenith) including refraction, and the Earth–Sun distance in AU.
 * Transcribed from docs/research/wbgt_liljegren.md §10.2 (valid 1901–2099; verified there against NREL SPA to 0.016°).
 * A minimal copy for the data layer (radiation disaggregation, clear-sky default); engine code uses engine/solar.ts.
 */
function noaaSolar(t: number, latDeg: number, lonDeg: number): { cosZenith: number; earthSunAu: number } {
  const jd = t / DAY_MS + 2440587.5
  const T = (jd - 2451545) / 36525
  const L0 = (((280.46646 + T * (36000.76983 + 0.0003032 * T)) % 360) + 360) % 360
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T)
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T)
  const C =
    Math.sin(M * DEG) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * M * DEG) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * M * DEG) * 0.000289
  const nu = M + C
  const R = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(nu * DEG))
  const omega = 125.04 - 1934.136 * T
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * DEG)
  const eps = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - 0.001813 * T))) / 60) / 60 + 0.00256 * Math.cos(omega * DEG)
  const dec = Math.asin(Math.sin(eps * DEG) * Math.sin(lambda * DEG))
  const y = Math.tan((eps / 2) * DEG) ** 2
  const eotMin =
    (4 / DEG) *
    (y * Math.sin(2 * L0 * DEG) -
      2 * e * Math.sin(M * DEG) +
      4 * e * y * Math.sin(M * DEG) * Math.cos(2 * L0 * DEG) -
      0.5 * y * y * Math.sin(4 * L0 * DEG) -
      1.25 * e * e * Math.sin(2 * M * DEG))
  const dayFrac = (((jd + 0.5) % 1) + 1) % 1
  const tstMin = (((dayFrac * 1440 + eotMin + 4 * lonDeg) % 1440) + 1440) % 1440
  const hourAngle = tstMin / 4 - 180
  const cosz = Math.sin(latDeg * DEG) * Math.sin(dec) + Math.cos(latDeg * DEG) * Math.cos(dec) * Math.cos(hourAngle * DEG)
  const el = 90 - Math.acos(Math.max(-1, Math.min(1, cosz))) / DEG
  let refractionDeg: number
  if (el > 85) refractionDeg = 0
  else if (el > 5) {
    const tn = Math.tan(el * DEG)
    refractionDeg = (58.1 / tn - 0.07 / tn ** 3 + 0.000086 / tn ** 5) / 3600
  } else if (el > -0.575) refractionDeg = (1735 + el * (-518.2 + el * (103.4 + el * (-12.79 + el * 0.711)))) / 3600
  else refractionDeg = -20.772 / Math.tan(el * DEG) / 3600
  return { cosZenith: Math.sin((el + refractionDeg) * DEG), earthSunAu: R }
}

/**
 * Cos(apparent zenith) at `t` (epoch ms) — NOAA Solar Calculator with refraction, wbgt_liljegren.md §10.2. ≤ 0 means
 * the sun is down. Default {@link CosZenithFn} of the interpolators.
 */
export function noaaCosZenith(t: number, latDeg: number, lonDeg: number): number {
  return noaaSolar(t, latDeg, lonDeg).cosZenith
}

/**
 * Clear-sky global horizontal irradiance used when solar radiation is unknown (ARCHITECTURE.md §5 "Unknown solar →
 * clear-sky estimate"): `GHI = kt_clear · TOA`, with TOA = 1367·max(cos z, 0)/R² (Liljegren wbgt.c, wbgt_liljegren.md
 * §11) and `kt_clear` the site's 95th-percentile clear-sky index from the cached archive ({@link CONSERVATIVE_PROFILE}).
 * Applying the near-noon P95 index at every sun angle over-estimates morning and evening sun — the protective direction.
 */
export function clearSkyGhiWm2(t: number, latDeg: number, lonDeg: number, ktClear: number): number {
  const { cosZenith, earthSunAu } = noaaSolar(t, latDeg, lonDeg)
  if (cosZenith <= 0) return 0
  return (ktClear * SOLAR_CONSTANT_WM2 * cosZenith) / (earthSunAu * earthSunAu)
}

/** Mean of max(0, cos z) over the hour ending at `tEnd`, from `n` midpoint sub-samples. */
function hourMeanCosZenith(tEnd: number, lat: number, lon: number, cosZenith: CosZenithFn, n = 60): number {
  let sum = 0
  for (let k = 0; k < n; k++) sum += Math.max(0, cosZenith(tEnd - HOUR_MS + ((k + 0.5) * HOUR_MS) / n, lat, lon))
  return sum / n
}

/**
 * Instantaneous irradiance at the END of an hour from its preceding-hour mean: `mean · cos z(t_end) / mean(cos z)`,
 * with night counted as zero. This is the Open-Meteo `backwardsAveragedToInstantFactor` construction
 * (data_and_validation.md §3.3); against the API's `shortwave_radiation_instant` at the Musaffah IFS cell on 2025-07-15
 * it agrees within 0.9 % after the first daylight hour. Never positive when the sun is down; capped at the TOA value.
 */
export function instantFromHourMean(
  meanWm2: number,
  tEnd: number,
  latDeg: number,
  lonDeg: number,
  cosZenith: CosZenithFn = noaaCosZenith,
): number {
  if (!(meanWm2 > 0)) return 0
  const m = hourMeanCosZenith(tEnd, latDeg, lonDeg, cosZenith)
  const cz = Math.max(0, cosZenith(tEnd, latDeg, lonDeg))
  if (m <= 0 || cz <= 0) return 0
  return Math.min((meanWm2 * cz) / m, SOLAR_CONSTANT_WM2 * MAX_INV_R2 * cz)
}

/**
 * Time at which to evaluate solar geometry for a sample: `t − 30 min` for an Open-Meteo hourly sample (preceding-hour
 * mean; wbgt_liljegren.md §13.3, the C convention `minute − 0.5·avg`), `t` for an {@link InstantEnvSample}. Mixing an
 * hour-mean GHI with the instantaneous zenith is the error the WBGT spec warns against (§13.5).
 */
export function solarGeometryTime(sample: EnvSample & { radiationWindowMin?: number }): number {
  return sample.radiationWindowMin === 0 ? sample.t : sample.t - 30 * MINUTE_MS
}

// ═══════════════════════════════ Parsers ═══════════════════════════════

type ColumnGetter = (v: WbgtVariable) => readonly Num[] | undefined

function finite(x: Num | undefined): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

/**
 * One hourly sample from column arrays, or null when a required variable is missing. RH missing but dew point present
 * → RH from Magnus. Values are kept exactly as the API returned them.
 */
function sampleFromColumns(get: ColumnGetter, i: number, t: number, source: EnvSource): EnvSample | null {
  const at = (v: WbgtVariable) => finite(get(v)?.[i])
  const taC = at('temperature_2m')
  const tdC = at('dew_point_2m')
  let rhPct = at('relative_humidity_2m')
  if (rhPct === undefined && taC !== undefined && tdC !== undefined) rhPct = rhFromDewPoint(taC, tdC)
  const pHpa = at('surface_pressure')
  const wind10Ms = at('wind_speed_10m')
  const ghiWm2 = at('shortwave_radiation')
  if (taC === undefined || rhPct === undefined || pHpa === undefined || wind10Ms === undefined || ghiWm2 === undefined) return null
  const s: EnvSample = { t, taC, rhPct, pHpa, wind10Ms, ghiWm2, source }
  if (tdC !== undefined) s.tdC = tdC
  const directWm2 = at('direct_radiation')
  const diffuseWm2 = at('diffuse_radiation')
  const dniWm2 = at('direct_normal_irradiance')
  const cloudPct = at('cloud_cover')
  if (directWm2 !== undefined) s.directWm2 = directWm2
  if (diffuseWm2 !== undefined) s.diffuseWm2 = diffuseWm2
  if (dniWm2 !== undefined) s.dniWm2 = dniWm2
  if (cloudPct !== undefined) s.cloudPct = cloudPct
  return s
}

function checkTimeAxis(time: unknown, ctx: string): TimeAxisJson {
  if (!isRecord(time)) fail(`${ctx}: missing time axis`)
  const { t0_unix, step_seconds, n, utc_offset_seconds } = time
  if (typeof t0_unix !== 'number' || typeof n !== 'number' || step_seconds !== 3600)
    fail(`${ctx}: time axis must have numeric t0_unix, n and step_seconds = 3600`)
  if (utc_offset_seconds !== 14_400) fail(`${ctx}: expected Asia/Dubai (utc_offset_seconds 14400)`)
  return time as unknown as TimeAxisJson
}

function gridFrom(g: unknown): GridCell | null {
  if (!isRecord(g) || typeof g.lat !== 'number' || typeof g.lon !== 'number') return null
  return {
    lat: g.lat,
    lon: g.lon,
    elevationM: typeof g.elevation_m === 'number' ? g.elevation_m : Number.NaN,
    cellSelection: g.cell_selection === 'nearest' ? 'nearest' : 'land',
  }
}

function seriesFromAxis(
  get: ColumnGetter,
  t0Unix: number,
  n: number,
  meta: Omit<WeatherSeries, 'samples' | 'droppedHours'>,
  ctx: string,
): WeatherSeries {
  for (const v of WBGT_VARIABLES) {
    const col = get(v)
    if (col !== undefined && col.length !== n) fail(`${ctx}: column ${v} has ${col.length} values, expected ${n}`)
  }
  const samples: EnvSample[] = []
  let droppedHours = 0
  for (let i = 0; i < n; i++) {
    const s = sampleFromColumns(get, i, (t0Unix + 3600 * i) * 1000, meta.source)
    if (s) samples.push(s)
    else droppedHours++
  }
  return { ...meta, samples, droppedHours }
}

/**
 * Parse a `zill.weather.archive/v1` file (public/data/weather/archive/{site}_{year}.json) into an hourly series with
 * source 'archive'. Index i is UTC epoch `t0_unix + 3600·i`; data in `models.{era5,ecmwf_ifs}.columns[var][i]`
 * (data_and_validation.md §8). Default model `ecmwf_ifs`: the UAE best-match model and the live-forecast model (§1).
 */
export function parseArchiveFile(json: unknown, model: ArchiveModel = 'ecmwf_ifs'): WeatherSeries {
  if (!isRecord(json) || json.schema !== 'zill.weather.archive/v1') fail('not a zill.weather.archive/v1 file')
  const time = checkTimeAxis(json.time, 'archive')
  const site = json.site
  const block = isRecord(json.models) ? json.models[model] : undefined
  if (!isRecord(site) || typeof site.id !== 'string') fail('archive: missing site')
  if (!isRecord(block) || !isRecord(block.columns)) fail(`archive: missing model block ${model}`)
  const columns = block.columns as Record<string, Num[]>
  return seriesFromAxis((v) => columns[v], time.t0_unix, time.n, { locationId: site.id, source: 'archive', model, grid: gridFrom(block.grid) }, `archive ${site.id}`)
}

/**
 * Parse a `zill.weather.previous_runs/v1` file into the archived forecast at one lead day, source 'cached_forecast'.
 * Data in `models.{ecmwf_ifs025,dwd_icon_seamless,ncep_gfs_seamless}.columns[var].{d0..d3}[i]`. dN = value for the same
 * valid time from runs issued ~24·N h earlier (d1 = leads 24–29 h for 6-hourly models; data_and_validation.md §8).
 * Defaults: primary model `ecmwf_ifs025` (IFS 9 km previous runs only start 2025-10-01) and lead 1.
 */
export function parsePreviousRunsFile(json: unknown, model: PreviousRunsModel = 'ecmwf_ifs025', lead: LeadDay = 1): WeatherSeries {
  if (!isRecord(json) || json.schema !== 'zill.weather.previous_runs/v1') fail('not a zill.weather.previous_runs/v1 file')
  const time = checkTimeAxis(json.time, 'previous_runs')
  const owner = isRecord(json.site) ? json.site : isRecord(json.point) ? json.point : undefined
  const block = isRecord(json.models) ? json.models[model] : undefined
  if (!owner || typeof owner.id !== 'string') fail('previous_runs: missing site/point')
  if (!isRecord(block) || !isRecord(block.columns)) fail(`previous_runs: missing model block ${model}`)
  const columns = block.columns as Record<string, Record<string, Num[]>>
  const key = `d${lead}`
  return seriesFromAxis(
    (v) => columns[v]?.[key],
    time.t0_unix,
    time.n,
    { locationId: owner.id, source: 'cached_forecast', model, grid: gridFrom(block.grid), leadDays: lead },
    `previous_runs ${owner.id} ${model} ${key}`,
  )
}

/**
 * Parse a `zill.weather.validation_point/v1` file (airport cells for METAR validation). Variables differ from the site
 * files (no diffuse/DNI; `pressure_msl` is ignored — surface pressure is used for psychrometrics). The `era5_land`
 * block has no wind, pressure or radiation, so all its hours are dropped (data_and_validation.md §8).
 */
export function parseValidationPointFile(json: unknown, model: ValidationModelKey = 'ecmwf_ifs@nearest'): WeatherSeries {
  if (!isRecord(json) || json.schema !== 'zill.weather.validation_point/v1') fail('not a zill.weather.validation_point/v1 file')
  const time = checkTimeAxis(json.time, 'validation_point')
  const point = json.point
  const block = isRecord(json.models) ? json.models[model] : undefined
  if (!isRecord(point) || typeof point.id !== 'string') fail('validation_point: missing point')
  if (!isRecord(block) || !isRecord(block.columns)) fail(`validation_point: missing model block ${model}`)
  const columns = block.columns as Record<string, Num[]>
  const modelName = (typeof block.model === 'string' ? block.model : model.split('@')[0]) as WeatherModel
  return seriesFromAxis((v) => columns[v], time.t0_unix, time.n, { locationId: point.id, source: 'archive', model: modelName, grid: gridFrom(block.grid) }, `validation ${point.id}`)
}

/**
 * Parse `zill.weather.demo_days/v1`. Hourly arrays have 24 entries indexed by local hour (index h = h:00 Asia/Dubai,
 * radiation at h = mean over [h − 1, h)); the analysis is the ecmwf_ifs archive and the forecasts are ecmwf_ifs025
 * Previous-Runs leads d1–d3 for the same valid hours (data_and_validation.md §8).
 */
export function parseDemoDays(json: unknown): DemoDay[] {
  if (!isRecord(json) || json.schema !== 'zill.weather.demo_days/v1' || !Array.isArray(json.days)) fail('not a zill.weather.demo_days/v1 file')
  return (json.days as unknown[]).map((raw, k) => {
    if (!isRecord(raw)) fail(`demo day ${k}: not an object`)
    const d = raw as unknown as DemoDayJson
    const siteId: string = isRecord(d.site) && typeof d.site.id === 'string' ? d.site.id : ''
    if (!isSiteId(siteId)) fail(`demo day ${d.id}: unknown site ${siteId}`)
    const a = d.analysis
    if (!isRecord(a) || typeof a.t0_unix !== 'number' || a.n !== 24 || !isRecord(a.hourly)) fail(`demo day ${d.id}: bad analysis block`)
    const analysis = seriesFromAxis((v) => a.hourly[v], a.t0_unix, 24, { locationId: siteId, source: 'archive', model: 'ecmwf_ifs', grid: gridFrom(a.grid) }, `demo ${d.id}`)
    const leadSeries = (lead: 1 | 2 | 3): WeatherSeries => {
      const cols = d.forecast?.leads?.[`d${lead}`]
      if (!isRecord(cols)) fail(`demo day ${d.id}: missing forecast lead d${lead}`)
      return seriesFromAxis(
        (v) => cols[v],
        a.t0_unix,
        24,
        { locationId: siteId, source: 'cached_forecast', model: 'ecmwf_ifs025', grid: gridFrom(d.forecast.grid), leadDays: lead },
        `demo ${d.id} d${lead}`,
      )
    }
    const s = d.summary
    return {
      id: d.id,
      siteId,
      date: d.date,
      tags: [...d.tags],
      why: [...d.why],
      summary: {
        date: s.date,
        tmaxC: s.tmax_c,
        tminC: s.tmin_c,
        tdMeanC: s.td_mean_c,
        tdMaxC: s.td_max_c,
        rhMinPct: s.rh_min_pct,
        rhMaxPct: s.rh_max_pct,
        ghiMaxWm2: s.ghi_max_wm2,
        daytimeCloudMeanPct: s.daytime_cloud_mean_pct,
        twStullMaxC: s.tw_stull_max_c,
        wbgtShadeProxyDaylightMaxC: s.wbgt_shade_proxy_daylight_max_c,
        wbgtShadeProxyMaxHourLocal: s.wbgt_shade_proxy_max_hour_local,
      },
      analysis,
      forecasts: { 1: leadSeries(1), 2: leadSeries(2), 3: leadSeries(3) },
    }
  })
}

/**
 * Parse a `zill.obs.metar/v1` file (routine METARs from the Iowa Environmental Mesonet; UTC time axis, temperatures at
 * integer precision, QNH not surface pressure; data_and_validation.md §5, §8).
 */
export function parseMetarFile(json: unknown): MetarSeries {
  if (!isRecord(json) || json.schema !== 'zill.obs.metar/v1') fail('not a zill.obs.metar/v1 file')
  const f = json as unknown as MetarFileJson
  const c = f.columns
  if (!isRecord(c) || !Array.isArray(c.valid_utc)) fail('metar: missing columns')
  const n = c.valid_utc.length
  const observations: MetarObservation[] = []
  for (let i = 0; i < n; i++) {
    const t = Date.parse(c.valid_utc[i])
    if (Number.isNaN(t)) fail(`metar: bad timestamp ${c.valid_utc[i]}`)
    observations.push({
      t,
      taC: c.temp_c[i] ?? null,
      tdC: c.dewpoint_c[i] ?? null,
      rhPct: c.rh_pct[i] ?? null,
      windDirDeg: c.wind_dir_deg[i] ?? null,
      windMs: c.wind_speed_ms[i] ?? null,
      gustMs: c.gust_ms[i] ?? null,
      qnhHpa: c.qnh_hpa[i] ?? null,
      visibilityKm: c.visibility_km[i] ?? null,
      cavok: c.cavok[i] === true,
      wx: c.wx[i] ?? null,
      sky1: c.sky1[i] ?? null,
    })
  }
  const st = f.station
  return { icao: st.icao, name: st.name, lat: st.lat, lon: st.lon, elevationM: st.elevation_m, note: st.note, provider: f.source?.provider ?? '', observations }
}

/** Validate and return a `zill.weather.manifest/v1` file (path, bytes, sha256, schema, models and period of every file). */
export function parseManifest(json: unknown): WeatherManifest {
  if (!isRecord(json) || json.schema !== 'zill.weather.manifest/v1' || !Array.isArray(json.files)) fail('not a zill.weather.manifest/v1 file')
  return json as unknown as WeatherManifest
}

/**
 * Parse an Open-Meteo Forecast API response into a series with source 'forecast'. Timestamps are local wall time
 * (timezone=Asia/Dubai) and are converted with the response's `utc_offset_seconds`; wind is converted from km/h if the
 * unit was not m/s. Hours with a null required variable (e.g. past the IFS horizon) are dropped.
 */
export function parseForecastResponse(json: unknown, locationId: string, obtainedAt: number): WeatherSeries {
  if (!isRecord(json)) fail('forecast: response is not an object')
  if (json.error === true) throw new WeatherDataError('api', `Open-Meteo: ${String(json.reason ?? 'error')}`)
  const offsetS = json.utc_offset_seconds
  const hourly = json.hourly
  if (typeof offsetS !== 'number' || !isRecord(hourly) || !Array.isArray(hourly.time)) fail('forecast: missing hourly block')
  const units = isRecord(json.hourly_units) ? json.hourly_units : {}
  const windUnit = units.wind_speed_10m
  let windFactor = 1
  if (windUnit === 'km/h') windFactor = 1 / 3.6
  else if (windUnit !== undefined && windUnit !== 'm/s') fail(`forecast: unexpected wind unit ${String(windUnit)}`)
  if (units.temperature_2m !== undefined && units.temperature_2m !== '°C') fail(`forecast: unexpected temperature unit ${String(units.temperature_2m)}`)
  const times = hourly.time as string[]
  const cols = hourly as Record<string, Num[] | undefined>
  const wind = cols.wind_speed_10m?.map((w) => (typeof w === 'number' ? w * windFactor : w))
  const get: ColumnGetter = (v) => (v === 'wind_speed_10m' ? wind : cols[v])
  const samples: EnvSample[] = []
  let droppedHours = 0
  for (let i = 0; i < times.length; i++) {
    const local = Date.parse(`${times[i].length === 16 ? `${times[i]}:00` : times[i]}Z`)
    if (Number.isNaN(local)) fail(`forecast: bad timestamp ${times[i]}`)
    const s = sampleFromColumns(get, i, local - offsetS * 1000, 'forecast')
    if (s) samples.push(s)
    else droppedHours++
  }
  const grid: GridCell | null =
    typeof json.latitude === 'number' && typeof json.longitude === 'number'
      ? { lat: json.latitude, lon: json.longitude, elevationM: typeof json.elevation === 'number' ? json.elevation : Number.NaN, cellSelection: 'land' }
      : null
  return { locationId, source: 'forecast', model: 'ecmwf_ifs', grid, obtainedAt, samples, droppedHours }
}

// ═══════════════════════════════ Minute-level interpolation ═══════════════════════════════

/**
 * Build a sampler that returns the environment at any instant inside an hourly series (null outside it or across a gap
 * longer than one hour). State variables (T, RH, dew point, pressure, wind, cloud) are interpolated linearly between
 * the hourly instants. Radiation for an instant in hour [t_i − 1 h, t_i) is disaggregated from that hour's mean by
 * cos(zenith): `I(t) = mean · cos z⁺(t) / mean_hour(cos z⁺)` — the Open-Meteo backward-to-instant construction
 * (data_and_validation.md §3.3) applied at every minute. Each hour's energy is conserved, and irradiance is exactly
 * zero whenever cos z ≤ 0. DNI is the instantaneous beam divided by max(cos z, sin 3°) (Open-Meteo's DNI floor).
 * Per-hour means are memoised, so sampling a whole day minute by minute is cheap.
 */
export function createEnvSampler(
  hourly: readonly EnvSample[],
  loc: LatLon,
  cosZenith: CosZenithFn = noaaCosZenith,
): (t: number) => InstantEnvSample | null {
  const hourMeans = new Map<number, number>()
  const meanCz = (tEnd: number): number => {
    let m = hourMeans.get(tEnd)
    if (m === undefined) {
      m = hourMeanCosZenith(tEnd, loc.lat, loc.lon, cosZenith)
      hourMeans.set(tEnd, m)
    }
    return m
  }
  const n = hourly.length
  return (t: number) => {
    if (n === 0 || !(t >= hourly[0].t) || !(t <= hourly[n - 1].t)) return null
    // Largest i with hourly[i].t ≤ t.
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (hourly[mid].t <= t) lo = mid
      else hi = mid - 1
    }
    const a = hourly[lo]
    const b = a.t === t ? a : hourly[lo + 1]
    if (b.t - a.t > HOUR_MS + 1000) return null
    // The hour containing t is [t_j − 1 h, t_j) with t_j the first stamp > t; at the series end use the hour ending at t.
    const rad = a.t === t ? (lo + 1 < n ? hourly[lo + 1] : a) : b
    if (rad.t - HOUR_MS > t + 1000) return null
    const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
    const opt = (x: number | undefined, y: number | undefined) => (x !== undefined && y !== undefined ? lerp(x, y, f) : undefined)

    const czT = Math.max(0, cosZenith(t, loc.lat, loc.lon))
    const m = meanCz(rad.t)
    const factor = m > 0 ? czT / m : 0
    const cap = SOLAR_CONSTANT_WM2 * MAX_INV_R2 * czT
    const inst = (mean: number | undefined) => (mean === undefined ? undefined : Math.min(Math.max(0, mean) * factor, cap))

    const out: InstantEnvSample = {
      t,
      taC: lerp(a.taC, b.taC, f),
      rhPct: lerp(a.rhPct, b.rhPct, f),
      pHpa: lerp(a.pHpa, b.pHpa, f),
      wind10Ms: lerp(a.wind10Ms, b.wind10Ms, f),
      ghiWm2: inst(rad.ghiWm2) ?? 0,
      source: a.source,
      radiationWindowMin: 0,
    }
    const tdC = opt(a.tdC, b.tdC)
    const cloudPct = opt(a.cloudPct, b.cloudPct)
    const directWm2 = inst(rad.directWm2)
    const diffuseWm2 = inst(rad.diffuseWm2)
    if (tdC !== undefined) out.tdC = tdC
    if (cloudPct !== undefined) out.cloudPct = cloudPct
    if (directWm2 !== undefined) out.directWm2 = directWm2
    if (diffuseWm2 !== undefined) out.diffuseWm2 = diffuseWm2
    if (directWm2 !== undefined) out.dniWm2 = czT > 0 ? directWm2 / Math.max(czT, SIN_3DEG) : 0
    else if (rad.dniWm2 !== undefined) out.dniWm2 = czT > 0 ? Math.max(0, rad.dniWm2) : 0
    if (a.radiantBoostC !== undefined) out.radiantBoostC = a.radiantBoostC
    return out
  }
}

/** Environment at one instant from an hourly series (see {@link createEnvSampler} for the method); null if not covered. */
export function sampleAt(hourly: readonly EnvSample[], t: number, loc: LatLon, cosZenith?: CosZenithFn): InstantEnvSample | null {
  return createEnvSampler(hourly, loc, cosZenith)(t)
}

/**
 * Minute-level series from `startT` to `endT` inclusive every `stepMin` minutes (instants outside the hourly series
 * are skipped). Method: {@link createEnvSampler}. Used for the 1-minute world simulation (docs/SIMULATION.md §3).
 */
export function interpolateEnv(
  hourly: readonly EnvSample[],
  startT: number,
  endT: number,
  loc: LatLon,
  stepMin = 1,
  cosZenith?: CosZenithFn,
): InstantEnvSample[] {
  if (!(stepMin > 0)) throw new RangeError('interpolateEnv: stepMin must be positive')
  const sampler = createEnvSampler(hourly, loc, cosZenith)
  const out: InstantEnvSample[] = []
  for (let t = startT; t <= endT; t += stepMin * MINUTE_MS) {
    const s = sampler(t)
    if (s) out.push(s)
  }
  return out
}

// ═══════════════════════════════ Conservative default ═══════════════════════════════

/** Per-site design profile for the conservative default (see {@link CONSERVATIVE_PROFILE}). */
export interface ConservativeProfile {
  /** Median (P50) Jun–Sep surface pressure, hPa. */
  pHpa: number
  /** 95th-percentile clear-sky index kt = hour-mean GHI / hour-mean TOA (hours with mean cos z ≥ 0.2). */
  ktClear: number
  /** P95 air temperature at local hours 00–23; rows June, July, August, September. */
  taC: readonly (readonly number[])[]
  /** Dew point that gives the P95 Stull wet bulb at the P95 air temperature; rows June…September. */
  tdC: readonly (readonly number[])[]
}

/**
 * Conservative design-hour profile per site, used when no weather data at all covers the requested time.
 *
 * PROVENANCE — derived once from public/data/weather/archive/{site}_{2020..2025}.json, model `ecmwf_ifs` (the live
 * forecast model), all days of each calendar month Jun–Sep 2020–2025 (~180 values per site, month and local hour), and
 * reproduced by {@link deriveConservativeProfile} in src/data/weather.test.ts:
 * - `taC[m][h]` = P95 of `temperature_2m` at local hour h;
 * - `tdC[m][h]` = the dew point that makes the Stull (2011) psychrometric wet bulb at `taC[m][h]` equal the P95 of the
 *   hourly Stull wet bulb — i.e. the 95th-percentile heat *and* the 95th-percentile humidity load at the same hour,
 *   a joint condition rarer than 1 in 20 (protective) yet physically consistent (Td ≤ Ta);
 * - `pHpa` = P50 of `surface_pressure` (WBGT is insensitive to it); `ktClear` = P95 of the hourly clear-sky index.
 * Wind is fixed at 0.5 m/s and the sky is clear (ARCHITECTURE.md §5). Months outside June–September use the per-hour
 * maximum of the four summer rows [ENG]: the repository holds no archive for those months (beyond November 2025 at
 * Musaffah, one site-year), so the default cannot be lowered without inventing data. This over-estimates winter heat —
 * acceptable for a last-resort state that is shown as "no weather data" with low confidence.
 */
export const CONSERVATIVE_PROFILE: Readonly<Record<SiteId, ConservativeProfile>> = {
  musaffah: {
    pHpa: 998.3,
    ktClear: 0.717,
    taC: [
      [33.6, 33.2, 32.6, 32.3, 32.5, 32.4, 32.5, 33.7, 35.3, 37.8, 40.3, 42.9, 44.7, 45.4, 45.6, 45.1, 43.0, 41.6, 39.5, 37.5, 35.9, 35.1, 34.7, 34.3],
      [36.3, 36.2, 35.8, 35.3, 35.3, 35.4, 35.2, 35.9, 37.4, 39.4, 41.5, 43.7, 45.5, 46.8, 47.1, 46.1, 43.8, 42.5, 40.9, 38.9, 37.9, 37.4, 36.9, 36.7],
      [36.2, 35.8, 35.5, 35.4, 34.9, 35.0, 34.6, 35.2, 36.9, 38.4, 40.8, 42.8, 44.9, 45.9, 46.4, 46.0, 45.1, 43.7, 41.5, 39.3, 38.4, 37.9, 37.2, 36.6],
      [33.0, 32.7, 32.2, 31.6, 31.5, 31.5, 31.3, 31.6, 33.5, 35.7, 38.4, 40.4, 42.1, 43.3, 43.7, 43.6, 42.4, 40.9, 38.7, 36.5, 35.6, 34.7, 34.2, 33.6],
    ],
    tdC: [
      [27.6, 27.7, 27.7, 27.8, 27.5, 27.6, 27.4, 26.9, 26.1, 24.3, 22.5, 21.0, 19.7, 20.2, 21.3, 21.1, 22.1, 23.0, 24.0, 25.7, 26.8, 27.3, 27.6, 27.6],
      [28.8, 28.8, 28.9, 28.9, 28.7, 28.7, 28.6, 28.3, 27.3, 25.9, 24.1, 23.1, 22.2, 22.0, 22.6, 22.7, 24.3, 24.9, 25.9, 27.3, 27.9, 28.3, 28.7, 28.6],
      [29.0, 29.1, 29.2, 29.3, 29.2, 29.1, 29.0, 28.7, 28.0, 27.2, 25.4, 24.0, 23.0, 23.5, 23.4, 23.5, 24.2, 24.7, 26.0, 27.1, 28.2, 28.5, 28.9, 29.0],
      [28.8, 28.6, 28.6, 28.7, 28.8, 28.9, 28.6, 28.7, 27.8, 26.5, 24.9, 23.4, 22.4, 21.9, 22.4, 22.3, 22.7, 23.9, 25.7, 26.8, 27.6, 28.3, 28.3, 28.3],
    ],
  },
  kezad: {
    pHpa: 999,
    ktClear: 0.719,
    taC: [
      [32.8, 32.3, 31.8, 32.2, 32.4, 32.3, 32.1, 33.6, 35.2, 37.4, 39.9, 41.7, 43.0, 42.5, 42.1, 40.7, 39.9, 38.5, 36.8, 35.1, 34.3, 33.9, 33.4, 33.0],
      [35.3, 34.8, 34.5, 34.2, 34.3, 34.6, 34.7, 35.7, 37.2, 39.5, 41.6, 43.4, 44.1, 44.1, 43.1, 42.0, 40.7, 39.8, 38.6, 36.9, 36.5, 36.2, 36.0, 35.7],
      [35.2, 34.8, 34.5, 34.3, 34.0, 34.2, 34.0, 34.7, 36.6, 38.7, 40.8, 42.5, 43.5, 43.8, 43.5, 42.5, 41.5, 40.0, 38.9, 37.6, 37.3, 36.7, 36.2, 35.6],
      [32.6, 32.0, 31.7, 31.4, 31.2, 31.5, 31.1, 31.5, 33.4, 35.7, 38.2, 40.3, 41.7, 42.1, 41.6, 40.5, 39.1, 37.9, 36.2, 34.9, 34.4, 33.9, 33.3, 32.9],
    ],
    tdC: [
      [28.2, 28.1, 28.2, 27.8, 27.3, 27.2, 27.1, 26.8, 26.0, 24.6, 22.9, 22.2, 22.6, 23.6, 23.3, 24.3, 24.7, 25.6, 27.0, 27.7, 28.1, 28.0, 28.1, 28.0],
      [29.1, 29.2, 29.2, 29.2, 28.9, 28.7, 28.4, 28.0, 27.5, 26.2, 24.4, 24.0, 24.5, 24.8, 25.5, 26.0, 26.6, 26.6, 27.6, 28.7, 29.0, 28.9, 29.2, 29.0],
      [29.1, 29.2, 29.3, 29.5, 29.3, 29.0, 29.1, 28.7, 28.1, 26.9, 25.1, 24.3, 25.4, 25.5, 25.6, 26.1, 26.6, 27.2, 28.0, 28.6, 29.0, 29.2, 29.3, 29.2],
      [28.6, 28.6, 28.7, 28.5, 28.6, 28.7, 28.7, 28.5, 27.9, 26.7, 25.0, 24.0, 23.9, 24.1, 24.7, 24.9, 25.6, 26.7, 27.2, 28.1, 28.3, 28.5, 28.6, 28.6],
    ],
  },
  ruwais: {
    pHpa: 998.1,
    ktClear: 0.728,
    taC: [
      [33.5, 33.1, 32.8, 32.7, 32.4, 32.4, 32.1, 33.3, 35.3, 37.7, 40.1, 42.4, 43.6, 44.3, 44.9, 44.1, 43.1, 42.4, 40.9, 39.0, 37.1, 35.8, 35.0, 34.1],
      [35.5, 34.8, 34.3, 34.1, 33.7, 33.6, 33.4, 34.3, 36.3, 38.8, 41.0, 43.0, 44.5, 45.3, 45.5, 45.2, 43.6, 42.7, 41.6, 39.5, 37.9, 37.1, 36.3, 35.9],
      [35.4, 34.8, 34.3, 34.0, 33.8, 34.2, 33.7, 34.2, 36.0, 38.3, 41.2, 43.0, 44.3, 45.0, 45.4, 44.7, 43.4, 41.6, 40.3, 38.7, 37.8, 37.0, 36.2, 35.7],
      [33.0, 32.6, 32.5, 31.7, 31.5, 31.9, 31.2, 31.9, 33.9, 36.1, 38.4, 40.4, 41.9, 42.6, 42.5, 42.2, 41.0, 39.6, 38.1, 36.1, 35.2, 34.5, 34.0, 33.5],
    ],
    tdC: [
      [26.1, 25.9, 25.8, 25.5, 25.9, 25.7, 25.6, 25.5, 25.3, 23.7, 21.6, 19.4, 19.2, 19.4, 19.9, 19.9, 21.1, 21.7, 22.8, 23.5, 25.0, 25.7, 25.8, 26.2],
      [28.9, 29.1, 29.2, 29.1, 29.1, 29.1, 29.1, 29.1, 28.3, 26.6, 24.8, 23.5, 22.9, 23.2, 23.4, 23.0, 23.5, 24.0, 25.1, 26.7, 28.2, 28.5, 29.0, 29.1],
      [29.5, 29.5, 29.4, 29.4, 29.7, 29.6, 29.7, 29.6, 29.2, 27.9, 25.5, 24.7, 24.1, 24.0, 24.4, 24.4, 24.9, 25.6, 26.5, 27.5, 28.6, 28.9, 29.3, 29.5],
      [28.4, 28.4, 28.2, 28.2, 28.4, 28.5, 28.3, 28.3, 28.1, 27.3, 25.8, 24.5, 23.9, 23.9, 23.8, 23.7, 24.4, 24.9, 25.8, 27.2, 27.8, 28.1, 28.1, 28.3],
    ],
  },
  alain: {
    pHpa: 970,
    ktClear: 0.728,
    taC: [
      [35.0, 34.3, 33.6, 32.9, 32.6, 32.8, 32.5, 34.1, 37.4, 40.7, 43.1, 45.0, 46.2, 47.1, 47.4, 47.4, 46.9, 46.1, 44.9, 42.4, 40.2, 38.7, 37.4, 36.3],
      [37.5, 36.9, 36.4, 35.8, 35.3, 35.2, 34.6, 35.3, 37.5, 40.0, 41.9, 43.5, 45.1, 45.8, 46.5, 46.9, 46.7, 46.1, 45.1, 43.5, 41.6, 40.2, 39.1, 38.3],
      [37.1, 36.2, 35.9, 35.3, 34.6, 34.3, 33.7, 34.3, 36.5, 39.4, 41.5, 43.4, 44.8, 45.9, 46.3, 46.6, 46.1, 45.4, 44.2, 43.2, 41.2, 39.8, 38.5, 37.6],
      [33.5, 32.7, 32.3, 31.7, 31.4, 31.4, 30.9, 31.1, 33.7, 37.3, 39.5, 41.2, 42.3, 43.4, 43.8, 44.0, 43.7, 42.9, 41.6, 40.0, 37.9, 36.7, 35.5, 34.3],
    ],
    tdC: [
      [22.9, 22.7, 23.0, 23.1, 22.9, 22.4, 22.4, 22.3, 20.5, 19.4, 18.0, 16.8, 15.8, 15.3, 14.6, 14.4, 14.2, 14.9, 16.3, 17.2, 20.6, 21.2, 22.3, 22.4],
      [22.9, 23.1, 23.7, 23.7, 23.9, 23.6, 23.0, 22.9, 22.8, 20.6, 19.3, 18.7, 18.3, 17.7, 17.4, 17.1, 16.7, 17.0, 17.9, 18.6, 21.1, 22.2, 22.6, 23.0],
      [23.6, 24.0, 24.0, 24.3, 24.8, 24.6, 24.2, 23.8, 22.8, 21.1, 20.1, 19.1, 18.7, 18.2, 17.2, 16.6, 16.9, 17.7, 19.3, 20.8, 21.7, 22.3, 22.8, 23.3],
      [23.8, 23.8, 24.0, 23.9, 23.7, 23.9, 23.3, 22.5, 20.7, 19.0, 17.6, 16.8, 16.3, 15.7, 15.2, 14.4, 13.9, 13.5, 16.2, 18.1, 21.6, 22.2, 22.8, 23.1],
    ],
  },
  saadiyat: {
    pHpa: 998.3,
    ktClear: 0.71,
    taC: [
      [32.9, 32.5, 32.7, 32.7, 32.8, 32.8, 32.9, 33.8, 35.0, 36.9, 39.2, 40.9, 41.9, 42.0, 41.3, 39.6, 38.7, 37.4, 36.1, 34.8, 34.3, 34.0, 33.8, 33.3],
      [35.0, 34.8, 34.7, 34.7, 34.5, 34.7, 34.8, 35.6, 36.9, 38.6, 40.5, 42.6, 44.0, 43.7, 42.4, 40.8, 39.7, 38.9, 37.6, 36.5, 35.8, 35.6, 35.5, 35.4],
      [35.4, 35.2, 34.8, 34.7, 34.5, 34.8, 34.5, 35.0, 36.5, 37.9, 39.9, 41.8, 43.2, 43.7, 43.2, 41.6, 40.6, 38.8, 37.6, 36.3, 36.2, 35.9, 36.0, 35.6],
      [33.1, 32.9, 32.6, 32.5, 32.4, 32.3, 31.9, 32.3, 33.6, 35.6, 37.5, 39.5, 40.6, 41.5, 41.6, 40.0, 38.9, 37.7, 36.2, 35.2, 34.8, 34.3, 33.8, 33.3],
    ],
    tdC: [
      [28.4, 28.3, 28.2, 28.0, 28.1, 27.5, 27.4, 27.2, 26.6, 25.5, 23.9, 22.9, 23.0, 23.5, 24.3, 25.2, 25.5, 26.8, 27.7, 27.9, 28.3, 28.1, 28.3, 28.3],
      [29.7, 29.8, 29.5, 29.5, 29.5, 29.2, 29.1, 28.5, 27.7, 26.6, 25.4, 25.0, 25.1, 25.2, 25.7, 26.7, 27.6, 28.2, 28.8, 29.2, 29.7, 29.7, 29.5, 29.7],
      [29.7, 29.6, 29.6, 29.6, 29.8, 29.6, 29.4, 29.3, 28.6, 27.6, 26.3, 25.5, 25.9, 25.8, 26.0, 27.0, 27.6, 28.2, 28.6, 29.8, 29.8, 29.8, 29.6, 29.8],
      [28.8, 28.9, 28.8, 28.6, 29.1, 29.1, 29.0, 29.0, 28.2, 27.1, 25.9, 24.6, 24.3, 24.8, 24.4, 25.1, 26.1, 26.7, 27.6, 28.2, 28.5, 28.6, 28.9, 28.9],
    ],
  },
}

/** Per-hour envelope (max of the four summer rows) used outside June–September [ENG, protective]. */
const PROFILE_ENVELOPE: Readonly<Record<SiteId, { taC: number[]; tdC: number[] }>> = Object.fromEntries(
  (Object.keys(CONSERVATIVE_PROFILE) as SiteId[]).map((id) => {
    const p = CONSERVATIVE_PROFILE[id]
    const env = (rows: readonly (readonly number[])[]) => rows[0].map((_, h) => Math.max(...rows.map((r) => r[h])))
    return [id, { taC: env(p.taC), tdC: env(p.tdC) }]
  }),
) as Record<SiteId, { taC: number[]; tdC: number[] }>

/**
 * The conservative default environment at instant `t` for a site (source 'conservative_default'): the P95 design hour
 * of {@link CONSERVATIVE_PROFILE} (linear between local hours), wind 0.5 m/s, clear sky ({@link clearSkyGhiWm2}),
 * no cloud. Basis: ARCHITECTURE.md §5 fail-safe defaults ("Unknown wind → 0.5 m/s", "Unknown solar → clear-sky
 * estimate"); the temperature/humidity design values are [ENG] P95s derived from the cached archive.
 */
export function conservativeDefaultSample(siteId: SiteId, t: number): InstantEnvSample {
  const site = getSite(siteId)
  const prof = CONSERVATIVE_PROFILE[siteId]
  const month = localParts(t).month
  const row = month >= 6 && month <= 9 ? { taC: prof.taC[month - 6], tdC: prof.tdC[month - 6] } : PROFILE_ENVELOPE[siteId]
  const hourFloat = ((((t + DUBAI_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS
  const h0 = Math.floor(hourFloat)
  const h1 = (h0 + 1) % 24
  const f = hourFloat - h0
  const taC = lerp(row.taC[h0], row.taC[h1], f)
  const tdC = Math.min(taC, lerp(row.tdC[h0], row.tdC[h1], f))
  return {
    t,
    taC,
    tdC,
    rhPct: rhFromDewPoint(taC, tdC),
    pHpa: prof.pHpa,
    wind10Ms: DEFAULT_WIND10_MS,
    ghiWm2: clearSkyGhiWm2(t, site.lat, site.lon, prof.ktClear),
    cloudPct: 0,
    source: 'conservative_default',
    radiantBoostC: site.radiantBoostC,
    radiationWindowMin: 0,
  }
}

/**
 * Re-derive {@link CONSERVATIVE_PROFILE} from parsed-or-raw archive files (the provenance computation; see that
 * constant). Uses the `ecmwf_ifs` block, Hyndman–Fan type-7 percentiles, the Stull wet bulb and inverse Magnus
 * (data_and_validation.md §3.4), and the clear-sky index over hours whose mean cos z ≥ 0.2 (12 sub-samples per hour).
 * Returns profiles only for sites that appear in `files`; rows for months without data are NaN.
 */
export function deriveConservativeProfile(files: readonly unknown[]): Partial<Record<SiteId, ConservativeProfile>> {
  interface Acc { ta: number[][][]; tw: number[][][]; p: number[]; kt: number[] }
  const acc = new Map<SiteId, Acc>()
  const newBuckets = () => Array.from({ length: 4 }, () => Array.from({ length: 24 }, () => [] as number[]))
  for (const json of files) {
    const series = parseArchiveFile(json, 'ecmwf_ifs')
    if (!isSiteId(series.locationId) || !series.grid) continue
    const id = series.locationId
    const { lat, lon } = series.grid
    let a = acc.get(id)
    if (!a) {
      a = { ta: newBuckets(), tw: newBuckets(), p: [], kt: [] }
      acc.set(id, a)
    }
    for (const s of series.samples) {
      const lp = localParts(s.t)
      if (lp.month >= 6 && lp.month <= 9) {
        a.ta[lp.month - 6][lp.hour].push(s.taC)
        a.tw[lp.month - 6][lp.hour].push(stullWetBulbC(s.taC, s.rhPct))
      }
      a.p.push(s.pHpa)
      let czSum = 0
      let toaSum = 0
      for (let k = 0; k < 12; k++) {
        const sun = noaaSolar(s.t - HOUR_MS + ((k + 0.5) * HOUR_MS) / 12, lat, lon)
        const cz = Math.max(0, sun.cosZenith)
        czSum += cz
        toaSum += (SOLAR_CONSTANT_WM2 * cz) / (sun.earthSunAu * sun.earthSunAu)
      }
      if (czSum / 12 >= 0.2) a.kt.push(s.ghiWm2 / (toaSum / 12))
    }
  }
  const out: Partial<Record<SiteId, ConservativeProfile>> = {}
  for (const [id, a] of acc) {
    const taC: number[][] = []
    const tdC: number[][] = []
    for (let m = 0; m < 4; m++) {
      taC.push([])
      tdC.push([])
      for (let h = 0; h < 24; h++) {
        const t95 = percentile(a.ta[m][h], 0.95)
        const w95 = percentile(a.tw[m][h], 0.95)
        let rh = 100
        if (w95 < stullWetBulbC(t95, 100)) {
          let lo = 1
          let hi = 100
          for (let it = 0; it < 60; it++) {
            const mid = (lo + hi) / 2
            if (stullWetBulbC(t95, mid) < w95) lo = mid
            else hi = mid
          }
          rh = (lo + hi) / 2
        }
        taC[m].push(roundTo(t95, 1))
        tdC[m].push(roundTo(dewPointFromRh(t95, rh), 1))
      }
    }
    out[id] = { pHpa: roundTo(percentile(a.p, 0.5), 1), ktClear: roundTo(percentile(a.kt, 0.95), 3), taC, tdC }
  }
  return out
}

// ═══════════════════════════════ Fail-safe environment resolution ═══════════════════════════════

/**
 * A reading from an on-site instrument (ISO 7243 WBGT meter and/or weather station). Any subset of fields; missing
 * fields are filled from the best modelled source.
 */
export interface SensorReading {
  t: number
  measuredWbgtC?: number
  taC?: number
  rhPct?: number
  tdC?: number
  pHpa?: number
  wind10Ms?: number
  ghiWm2?: number
}

/** Inputs to {@link resolveEnvironment}. Series must be hourly Open-Meteo-style series (parsers or live fetcher). */
export interface ResolveEnvironmentInput {
  siteId: SiteId
  /** The instant to resolve, epoch ms (the engine never reads a clock). */
  now: number
  sensor?: SensorReading | null
  liveForecast?: WeatherSeries | null
  cachedForecast?: WeatherSeries | null
  archive?: WeatherSeries | null
  cosZenith?: CosZenithFn
}

/** Result of {@link resolveEnvironment}. */
export interface ResolvedEnvironment {
  /** Instantaneous sample at `now` (radiation evaluated at `now`). */
  sample: InstantEnvSample
  source: EnvSource
  /** Minutes since the data were obtained/issued; 0 for an analysis; null when no data exist (conservative default). */
  ageMin: number | null
  stale: boolean
  confidence: 'high' | 'medium' | 'low'
  /** WBGT margin (°C) the engine adds to WBGT_eff for stale or missing data. */
  wbgtMarginC: number
  /** Data-quality drivers (channel 'environment'); fail-safe substitutions have direction 'raises'. */
  drivers: RiskDriver[]
}

const BASIS_FAILSAFE = 'Zill fail-safe defaults (ARCHITECTURE.md §5)'
const SOURCE_BASIS: Record<EnvSource, string> = {
  site_sensor: 'ISO 7243:2017 — WBGT measured on site',
  forecast: 'Open-Meteo forecast API, ECMWF IFS HRES 9 km (models=ecmwf_ifs)',
  archive: 'Open-Meteo archive: ECMWF IFS analysis / ERA5 reanalysis (Copernicus C3S)',
  cached_forecast: 'Archived forecast (Open-Meteo Previous Runs or the last successful fetch)',
  conservative_default: 'P95 design hour from the 2020–2025 ECMWF IFS archive; clear sky; wind 0.5 m/s (ARCHITECTURE.md §5)',
}
const SOURCE_LABEL: Record<EnvSource, string> = {
  site_sensor: 'site WBGT meter',
  forecast: 'live forecast',
  archive: 'weather archive (analysis)',
  cached_forecast: 'cached forecast',
  conservative_default: 'conservative default',
}

function envDriver(id: string, text: string, direction: RiskDriver['direction'], basis: string, value?: number, unit?: string): RiskDriver {
  const d: RiskDriver = { id, channel: 'environment', text, direction, basis }
  if (value !== undefined) d.value = value
  if (unit !== undefined) d.unit = unit
  return d
}

function formatAge(min: number): string {
  return min < 90 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1)} h`
}

/**
 * Age of a series' value at `now`, minutes: 0 for an analysis; `now − obtainedAt` for a fetched forecast; `24·N h` for
 * an archived lead-N forecast (issued ~24·N h before the valid time); null (unknown → treated as ≥ 24 h) otherwise.
 */
function seriesAgeMin(series: WeatherSeries, slot: EnvSource, now: number): number | null {
  if (slot === 'archive') return 0
  if (series.obtainedAt !== undefined) return Math.max(0, (now - series.obtainedAt) / MINUTE_MS)
  if (series.leadDays !== undefined) return series.leadDays * 1440
  return null
}

/** Staleness rules of ARCHITECTURE.md §5 applied to a data age (null = unknown age = treated as ≥ 24 h). */
function ageRules(ageMin: number | null): { stale: boolean; confidence: 'high' | 'medium' | 'low'; marginC: number } {
  if (ageMin === null) return { stale: true, confidence: 'low', marginC: STALE_WBGT_MARGIN_C }
  const stale = ageMin >= FORECAST_STALE_AFTER_MIN
  const marginC = ageMin >= FORECAST_MARGIN_AFTER_MIN ? STALE_WBGT_MARGIN_C : 0
  return { stale, confidence: marginC > 0 ? 'low' : stale ? 'medium' : 'high', marginC }
}

/**
 * Confidence of a forecast value valid at `validT`, seen at `now` (for forecast strips and the planner): the staleness
 * rules on the fetch age (ARCHITECTURE.md §5), and 'low' beyond a 7-day lead (data_and_validation.md §3.5).
 */
export function forecastConfidence(series: WeatherSeries, validT: number, now: number): 'high' | 'medium' | 'low' {
  if (series.source === 'archive') return 'high'
  const age = seriesAgeMin(series, series.source, now)
  const rules = ageRules(age)
  const issued = series.obtainedAt ?? (series.leadDays !== undefined ? validT - series.leadDays * DAY_MS : undefined)
  if (issued !== undefined && validT - issued > FORECAST_LOW_CONFIDENCE_LEAD_DAYS * DAY_MS) return 'low'
  return rules.confidence
}

const inRange = (x: number | undefined, lo: number, hi: number) => x === undefined || (Number.isFinite(x) && x >= lo && x <= hi)

/** Plausibility screen for sensor values [ENG]: WBGT 0–50 °C, Ta −10–60 °C, RH 0–100 %, p 800–1100 hPa, wind 0–60 m/s, GHI 0–1500 W/m². */
function sensorPlausible(s: SensorReading): boolean {
  return (
    inRange(s.measuredWbgtC, 0, 50) &&
    inRange(s.taC, -10, 60) &&
    inRange(s.rhPct, 0, 100) &&
    inRange(s.tdC, -40, 40) &&
    inRange(s.pHpa, 800, 1100) &&
    inRange(s.wind10Ms, 0, 60) &&
    inRange(s.ghiWm2, 0, 1500)
  )
}

/**
 * Resolve the environment at `now` for a site through the fail-safe chain (ARCHITECTURE.md §1.3, §3, §5), in the
 * priority order of the `EnvSource` contract: a fresh site sensor (≤ 15 min, plausible) → live forecast → archive
 * (analysis of what happened) → cached forecast → conservative default.
 * - The first modelled source whose hourly samples bracket `now` supplies the met state, interpolated to the minute.
 * - A usable sensor overrides the fields it measures (a WBGT meter supplies `measuredWbgtC`); its missing fields come
 *   from the modelled source (sensor Ta is paired with the model's dew point, keeping humidity physically consistent).
 * - Age rules: ≥ 6 h stale → confidence lowered; ≥ 24 h (or unknown) → +1 °C WBGT margin and low confidence.
 * - Field fail-safes: missing wind → 0.5 m/s; missing solar → clear sky; missing pressure → site median.
 * - The site's radiant boost is attached for the modelled globe temperature (not to be added to a measured WBGT).
 */
export function resolveEnvironment(input: ResolveEnvironmentInput): ResolvedEnvironment {
  const { siteId, now } = input
  const site: Site = getSite(siteId)
  const prof = CONSERVATIVE_PROFILE[siteId]
  const loc = { lat: site.lat, lon: site.lon }
  const drivers: RiskDriver[] = []

  // 1. Best modelled source covering `now`, in contract priority order.
  let base: { sample: InstantEnvSample; source: EnvSource; ageMin: number | null } | null = null
  const slots: [WeatherSeries | null | undefined, EnvSource][] = [
    [input.liveForecast, 'forecast'],
    [input.archive, 'archive'],
    [input.cachedForecast, 'cached_forecast'],
  ]
  for (const [series, slot] of slots) {
    if (!series) continue
    if (series.locationId !== siteId) {
      drivers.push(envDriver('env_series_wrong_site', `Ignored ${SOURCE_LABEL[slot]} for another location (${series.locationId}).`, 'info', BASIS_FAILSAFE))
      continue
    }
    const s = sampleAt(series.samples, now, loc, input.cosZenith)
    if (!s || !Number.isFinite(s.taC) || !Number.isFinite(s.rhPct)) {
      drivers.push(envDriver('env_source_no_coverage', `The ${SOURCE_LABEL[slot]} does not cover this time.`, 'info', SOURCE_BASIS[slot]))
      continue
    }
    base = { sample: { ...s, source: slot }, source: slot, ageMin: seriesAgeMin(series, slot, now) }
    break
  }
  if (!base) {
    base = { sample: conservativeDefaultSample(siteId, now), source: 'conservative_default', ageMin: null }
    drivers.push(
      envDriver(
        'env_conservative_default',
        'No weather data for this time: assuming a hot, humid, clear-sky, light-wind hour (95th percentile for this site, month and hour).',
        'raises',
        SOURCE_BASIS.conservative_default,
      ),
    )
  }

  // 2. Field-level fail-safes on the modelled sample.
  const sample: InstantEnvSample = { ...base.sample, t: now }
  if (!(Number.isFinite(sample.wind10Ms) && sample.wind10Ms >= 0)) {
    sample.wind10Ms = DEFAULT_WIND10_MS
    drivers.push(envDriver('env_wind_default', 'Wind unknown: assuming 0.5 m/s.', 'raises', BASIS_FAILSAFE, DEFAULT_WIND10_MS, 'm/s'))
  }
  if (!(Number.isFinite(sample.ghiWm2) && sample.ghiWm2 >= 0)) {
    sample.ghiWm2 = clearSkyGhiWm2(now, site.lat, site.lon, prof.ktClear)
    drivers.push(envDriver('env_solar_clear_sky', 'Solar radiation unknown: assuming clear sky.', 'raises', BASIS_FAILSAFE))
  }
  if (!(Number.isFinite(sample.pHpa) && sample.pHpa > 0)) sample.pHpa = prof.pHpa
  if (site.radiantBoostC > 0) sample.radiantBoostC = site.radiantBoostC

  // 3. Site sensor override.
  const sensor = input.sensor
  if (sensor) {
    const ageMin = (now - sensor.t) / MINUTE_MS
    const hasMet = sensor.taC !== undefined && (sensor.rhPct !== undefined || sensor.tdC !== undefined)
    const fresh = ageMin >= -1 && ageMin <= SENSOR_MAX_AGE_MIN
    const plausible = sensorPlausible(sensor)
    if (fresh && plausible && (sensor.measuredWbgtC !== undefined || sensor.taC !== undefined)) {
      const merged: InstantEnvSample = { ...sample, source: 'site_sensor' }
      if (sensor.measuredWbgtC !== undefined) merged.measuredWbgtC = sensor.measuredWbgtC
      if (sensor.taC !== undefined) {
        merged.taC = sensor.taC
        if (sensor.rhPct !== undefined) {
          merged.rhPct = sensor.rhPct
          merged.tdC = sensor.tdC ?? dewPointFromRh(sensor.taC, sensor.rhPct)
        } else if (sensor.tdC !== undefined) {
          merged.tdC = Math.min(sensor.tdC, sensor.taC)
          merged.rhPct = rhFromDewPoint(sensor.taC, merged.tdC)
        } else if (sample.tdC !== undefined) {
          merged.tdC = Math.min(sample.tdC, sensor.taC)
          merged.rhPct = rhFromDewPoint(sensor.taC, merged.tdC)
        }
      }
      if (sensor.pHpa !== undefined) merged.pHpa = sensor.pHpa
      if (sensor.wind10Ms !== undefined) merged.wind10Ms = sensor.wind10Ms
      if (sensor.ghiWm2 !== undefined) merged.ghiWm2 = sensor.ghiWm2
      drivers.unshift(
        envDriver('env_source_site_sensor', `Site sensor reading (${formatAge(Math.max(0, ageMin))} old); other fields from the ${SOURCE_LABEL[base.source]}.`, 'info', SOURCE_BASIS.site_sensor),
      )
      const fullyMeasured = hasMet || base.source !== 'conservative_default'
      return {
        sample: merged,
        source: 'site_sensor',
        ageMin: Math.max(0, ageMin),
        stale: false,
        confidence: fullyMeasured ? 'high' : 'medium',
        wbgtMarginC: 0,
        drivers,
      }
    }
    drivers.push(
      envDriver(
        'env_sensor_unavailable',
        !fresh ? `Site sensor has not reported for ${formatAge(Math.max(0, ageMin))}: check the sensor.` : !plausible ? 'Site sensor values are implausible: check the sensor.' : 'Site sensor reading is incomplete: check the sensor.',
        'raises',
        BASIS_FAILSAFE,
        Math.max(0, Math.round(ageMin)),
        'min',
      ),
    )
  }

  // 4. Age rules.
  const rules = ageRules(base.ageMin)
  if (base.source !== 'conservative_default') {
    const ageText = base.ageMin === null ? 'of unknown age' : base.source === 'archive' ? 'for this hour' : `${formatAge(base.ageMin)} old`
    drivers.unshift(envDriver(`env_source_${base.source}`, `Weather from the ${SOURCE_LABEL[base.source]} (${ageText}).`, 'info', SOURCE_BASIS[base.source]))
    if (rules.stale) {
      drivers.push(
        envDriver('env_data_stale', `Weather data ${ageText}: confidence lowered.`, 'raises', `${BASIS_FAILSAFE}: older than 6 h`, base.ageMin === null ? undefined : Math.round(base.ageMin), 'min'),
      )
    }
  }
  if (rules.marginC > 0) {
    const why = base.source === 'conservative_default' ? 'No weather data of any age' : base.ageMin === null ? 'Weather data of unknown age' : 'Weather data at least 24 h old'
    drivers.push(envDriver('env_stale_margin', `${why}: +${rules.marginC} °C WBGT safety margin.`, 'raises', `${BASIS_FAILSAFE}: older than 24 h`, rules.marginC, '°C'))
  }
  return {
    sample,
    source: base.source,
    ageMin: base.ageMin === null ? null : Math.round(base.ageMin * 10) / 10,
    stale: rules.stale,
    confidence: rules.confidence,
    wbgtMarginC: rules.marginC,
    drivers,
  }
}

// ═══════════════════════════════ Live forecast ═══════════════════════════════

/** Minimal fetch signature (the global `fetch` satisfies it); injectable for tests and offline use. */
export type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<FetchResponseLike>

/** The part of a fetch `Response` the data layer uses. */
export interface FetchResponseLike {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/**
 * Forecast request URL (data_and_validation.md §3.1, verified template): the 10 WBGT variables, `models=ecmwf_ifs`
 * (deterministic; equals best_match in the UAE within the IFS horizon), `timezone=Asia/Dubai`, `wind_speed_unit=ms`,
 * `forecast_days` clamped to 1–16 (the API rejects 17), and `cell_selection=land` (as for the cached archive; keeps the
 * KEZAD point off the sea cell).
 */
export function buildForecastUrl(loc: LatLon, forecastDays = 7): string {
  const days = Math.min(MAX_FORECAST_DAYS, Math.max(1, Math.round(forecastDays)))
  return (
    `${OPEN_METEO_FORECAST_URL}?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&hourly=${WBGT_VARIABLES.join(',')}` +
    `&models=ecmwf_ifs&timezone=Asia%2FDubai&wind_speed_unit=ms&forecast_days=${days}&cell_selection=land`
  )
}

/** Options for {@link fetchLiveForecast}. */
export interface LiveForecastOptions {
  site: Pick<Site, 'id' | 'lat' | 'lon'>
  /** Fetch time recorded as `obtainedAt` (defaults to the wall clock — the data layer is not engine code). */
  now?: number
  /** 1–16 (default 7: the recommended IFS range; days 8–16 are labelled low confidence). */
  forecastDays?: number
  /** Abort after this many ms (default {@link LIVE_FORECAST_TIMEOUT_MS}). */
  timeoutMs?: number
  fetch?: FetchLike
  signal?: AbortSignal
}

/**
 * Fetch the live Open-Meteo ECMWF IFS forecast for a site (CORS-enabled; data_and_validation.md §3.7) with an
 * AbortController timeout (default 5 s). Rejects with a {@link WeatherDataError} ('timeout' | 'network' | 'http' |
 * 'api' | 'schema'); callers then fall back to cached data via {@link resolveEnvironment}. Free tier = non-commercial
 * use only ({@link OPEN_METEO_LICENSING_NOTE}).
 */
export async function fetchLiveForecast(opts: LiveForecastOptions): Promise<WeatherSeries> {
  const url = buildForecastUrl(opts.site, opts.forecastDays ?? 7)
  const fetchFn = opts.fetch ?? defaultFetch
  const timeoutMs = opts.timeoutMs ?? LIVE_FORECAST_TIMEOUT_MS
  const controller = new AbortController()
  const external = opts.signal
  const onExternalAbort = () => controller.abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new WeatherDataError('timeout', `Open-Meteo forecast timed out after ${timeoutMs} ms`))
    }, timeoutMs)
  })
  timeout.catch(() => undefined)
  external?.addEventListener('abort', onExternalAbort)
  try {
    if (external?.aborted) throw new WeatherDataError('network', 'Forecast request cancelled')
    const res = await Promise.race([fetchFn(url, { signal: controller.signal }), timeout])
    if (!res.ok) throw new WeatherDataError('http', `Open-Meteo forecast HTTP ${res.status}`)
    const json = await Promise.race([res.json(), timeout])
    return parseForecastResponse(json, opts.site.id, opts.now ?? Date.now())
  } catch (err) {
    if (err instanceof WeatherDataError) throw err
    if (external?.aborted) throw new WeatherDataError('network', 'Forecast request cancelled')
    if (controller.signal.aborted) throw new WeatherDataError('timeout', `Open-Meteo forecast timed out after ${timeoutMs} ms`)
    throw new WeatherDataError('network', `Open-Meteo forecast failed: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

// ═══════════════════════════════ Cached-file loader ═══════════════════════════════

/**
 * Which cached archive period covers `t` for a site: the summer files (Jun–Sep 2020–2025) or November 2025 at
 * Musaffah (the mild demo-day source), per the manifest (data_and_validation.md §8). Null when nothing is cached.
 */
export function archivePeriodFor(siteId: SiteId, t: number): number | '2025-11' | null {
  const { year, month } = localParts(t)
  if (year >= 2020 && year <= 2025 && month >= 6 && month <= 9) return year
  if (siteId === 'musaffah' && year === 2025 && month === 11) return '2025-11'
  return null
}

/** Year of the cached Previous-Runs file covering `t` (Jun–Sep 2024 and 2025), else null (data_and_validation.md §8). */
export function previousRunsYearFor(t: number): number | null {
  const { year, month } = localParts(t)
  return (year === 2024 || year === 2025) && month >= 6 && month <= 9 ? year : null
}

/** Options for {@link createWeatherLoader}. */
export interface WeatherLoaderOptions {
  /** Defaults to the global fetch. */
  fetch?: FetchLike
  /** Base path of the static data, relative to the page (default './data/', i.e. public/data in the build). */
  baseUrl?: string
}

/** Loader for the cached JSON shipped in public/data. Raw files are fetched once and memoised. */
export interface WeatherLoader {
  manifest(): Promise<WeatherManifest>
  archive(siteId: SiteId, period: number | '2025-11', model?: ArchiveModel): Promise<WeatherSeries>
  /** The archive file covering `t`, or null when none is cached. */
  archiveFor(siteId: SiteId, t: number, model?: ArchiveModel): Promise<WeatherSeries | null>
  previousRuns(siteId: SiteId, year: number, model?: PreviousRunsModel, lead?: LeadDay): Promise<WeatherSeries>
  demoDays(): Promise<DemoDay[]>
  validationPoint(pointId: ValidationPointId, model?: ValidationModelKey): Promise<WeatherSeries>
  validationPreviousRuns(pointId: ValidationPointId, model?: PreviousRunsModel, lead?: LeadDay): Promise<WeatherSeries>
  metar(icao: MetarIcao): Promise<MetarSeries>
}

/**
 * Create a browser loader for the cached weather and observation files. Paths are relative to the page
 * (`./data/weather/...`, `./data/obs/...`), so the static build runs from any base path; the service worker caches
 * them for offline use (vite.config.ts). Failures reject with a {@link WeatherDataError} and are not memoised.
 */
export function createWeatherLoader(opts: WeatherLoaderOptions = {}): WeatherLoader {
  const fetchFn = opts.fetch ?? defaultFetch
  const base = opts.baseUrl ?? './data/'
  const cache = new Map<string, Promise<unknown>>()
  const getJson = (path: string): Promise<unknown> => {
    const url = `${base}${path}`
    let p = cache.get(url)
    if (!p) {
      p = (async () => {
        let res: FetchResponseLike
        try {
          res = await fetchFn(url)
        } catch (err) {
          throw new WeatherDataError('network', `Could not load ${url}: ${err instanceof Error ? err.message : String(err)}`)
        }
        if (!res.ok) throw new WeatherDataError('http', `Could not load ${url}: HTTP ${res.status}`)
        return res.json()
      })()
      p.catch(() => cache.delete(url))
      cache.set(url, p)
    }
    return p
  }
  const loader: WeatherLoader = {
    manifest: async () => parseManifest(await getJson('weather/manifest.json')),
    archive: async (siteId, period, model = 'ecmwf_ifs') => parseArchiveFile(await getJson(`weather/archive/${siteId}_${period}.json`), model),
    archiveFor: async (siteId, t, model = 'ecmwf_ifs') => {
      const period = archivePeriodFor(siteId, t)
      return period === null ? null : loader.archive(siteId, period, model)
    },
    previousRuns: async (siteId, year, model = 'ecmwf_ifs025', lead = 1) =>
      parsePreviousRunsFile(await getJson(`weather/previous-runs/${siteId}_${year}.json`), model, lead),
    demoDays: async () => parseDemoDays(await getJson('weather/demo-days.json')),
    validationPoint: async (pointId, model = 'ecmwf_ifs@nearest') => parseValidationPointFile(await getJson(`weather/validation/${pointId}_2025.json`), model),
    validationPreviousRuns: async (pointId, model = 'ecmwf_ifs025', lead = 1) =>
      parsePreviousRunsFile(await getJson(`weather/validation/${pointId}_2025_previous.json`), model, lead),
    metar: async (icao) => parseMetarFile(await getJson(`obs/${icao}_2025_summer.json`)),
  }
  return loader
}
