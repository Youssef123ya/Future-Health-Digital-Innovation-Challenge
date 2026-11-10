/**
 * Hours in each heat zone, 2020–2025 (evidence class 2 "real-data exposure", docs/SIMULATION.md): five Abu Dhabi sites ×
 * six Jun–Sep seasons, hourly, through the engine (indices.ts computeSiteHeat). Design: docs/research/
 * data_and_validation.md §10 A; preview numbers for comparison in §6.5.
 *
 * Inputs: public/data/weather/archive/{site}_{2020..2025}.json — ECMWF IFS 9 km analysis (primary: the live-forecast
 * model, identical to Open-Meteo best_match at these sites) and ERA5 (sensitivity: homogeneous reanalysis). Airport
 * anchor: public/data/weather/validation/*_2025.json + public/data/obs/*_2025_summer.json (METAR).
 * Outputs (public/data/validation/hours-in-zone.json):
 *   - hours per WBGT band anchored on published limits (lib/zones.ts) and per ADOSH TWL zone (sun and shade);
 *   - by month and by local hour; days with any High-zone hour; longest run ≥ RAL(115 W);
 *   - the share of High-zone and ≥ RAL(115 W) hours that fall OUTSIDE the MoHRE midday-break window;
 *   - a TWL plausibility comparison with the published UAE field means (Bates & Schneider 2008; Miller et al. 2011);
 *   - the planning insight: allowed work min/h (limits.ts allowedWorkFraction) for moderate (300 W) and heavy (415 W)
 *     work under REL and RAL, resting in a cooled cabin versus in shade, by local hour;
 *   - sensitivity (ERA5; site radiant allowance), the comparison with the research preview, and an observational anchor
 *     at the three airports (model-only vs METAR-based WBGT hours).
 * This is a weather-exposure statistic, not a count of worker exposure: it says how often the outdoor environment at the
 * site reached each band, not how many workers were exposed.
 */
import { parseArchiveFile } from '../../src/data/weather'
import type { ArchiveModel } from '../../src/data/weather'
import { SITES } from '../../src/data/sites'
import type { SiteId } from '../../src/data/sites'
import { allowedWorkFraction, wbgtEffectiveC, REST_METABOLIC_W } from '../../src/engine/limits'
import type { ExposureLimitId } from '../../src/engine/limits'
import type { Site } from '../../src/engine/types'
import { Provenance, codeStamp, isMainModule, timed, writeValidationJson, DATA_ATTRIBUTION } from './lib/io'
import type { CodeStamp, InputFileRecord } from './lib/io'
import { heatColumns, hourHeat, timeIndex } from './lib/heat'
import type { BoostMode, HeatColumns } from './lib/heat'
import { ADOSH_ZONES, BAND_METABOLIC_W, WBGT_BANDS, WBGT_THRESHOLDS, adoshZoneIndex, adoshZoneTable, cooledRestWbgt, inMiddayBreak, inMiddayBreakSeason, middayBreakRule, wbgtBandIndex } from './lib/zones'
import type { CooledRestWbgt, WbgtBand } from './lib/zones'
import { AIRPORTS, AIRPORT_PERIOD, airportSite, loadAirportAnalysis, loadMetar, metarUsable, obsMetSample } from './lib/airports'
import { quantileSorted, roundTo } from './lib/stats'
import { HOURS_GE30_BY_YEAR_PREVIEW, HOURS_PREVIEW, HOURS_PREVIEW_SOURCE, UAE_FIELD_TWL } from './lib/research'
import type { RunOptions } from './reference'

// ─────────────────────────────── Configuration ───────────────────────────────

/** Seasons covered by the cached archive (data_and_validation.md §8). */
export const HOURS_YEARS = [2020, 2021, 2022, 2023, 2024, 2025] as const

/** Archive model runs: the primary IFS run, the ERA5 sensitivity, and the IFS run with the site radiant allowance. */
export interface ArchiveRun {
  id: 'ifs' | 'era5' | 'ifs_site_boost'
  model: ArchiveModel
  boost: BoostMode
  role: 'primary' | 'sensitivity'
  label: string
}

export const ARCHIVE_RUNS: readonly ArchiveRun[] = [
  { id: 'ifs', model: 'ecmwf_ifs', boost: 'none', role: 'primary', label: 'ECMWF IFS 9 km analysis, no site radiant allowance' },
  { id: 'era5', model: 'era5', boost: 'none', role: 'sensitivity', label: 'ERA5 0.25° reanalysis, no site radiant allowance' },
  { id: 'ifs_site_boost', model: 'ecmwf_ifs', boost: 'site', role: 'sensitivity', label: 'ECMWF IFS 9 km with the site radiant allowance (sites.ts radiantBoostC, [ENG])' },
]

/** Work rates of the planning insight (ACGIH representative rates, limits.ts ACGIH_METABOLIC_W). */
export const PLAN_WORK = [
  { id: 'moderate', workW: BAND_METABOLIC_W.moderate },
  { id: 'heavy', workW: BAND_METABOLIC_W.heavy },
] as const
const PLAN_LIMITS: readonly ExposureLimitId[] = ['REL', 'RAL']
const PLAN_REST = ['cabin', 'shade'] as const
/** Local hours of the daytime shift summary, inclusive [ENG: 07:00–17:00 covers the usual outdoor shift]. */
export const DAY_SHIFT_HOURS = { from: 7, to: 17 } as const
/** Local hours compared with the UAE field studies (Bates & Schneider 2008 sampled 08/12/14/16 h). */
export const FIELD_HOURS = [8, 12, 14, 16] as const

// ─────────────────────────────── Report contract ───────────────────────────────

/** Hour counts for one season or a mean season. */
export interface ZoneHours {
  hours: number
  /** Hours per WBGT band (lib/zones.ts WBGT_BANDS order). */
  wbgtBands: number[]
  /** Hours per ADOSH zone [high, medium, low], TWL in sun. */
  adoshSun: number[]
  /** Hours per ADOSH zone, TWL in engineered shade. */
  adoshShade: number[]
  /** Research-preview cut points (illustrative 28/30/32/33 °C, data_and_validation.md §6.5) for comparison only. */
  previewCutpoints: { ge28: number; ge30: number; ge32: number; ge33: number; ge30OutsideBreak: number }
  /** Days with at least one hour in the ADOSH High zone (sun). */
  daysWithAdoshHigh: number
  /** Days with at least one hour at WBGT ≥ RAL(115 W). */
  daysWithWbgtGeRal115: number
  /** Longest run of consecutive hours at WBGT ≥ RAL(115 W). */
  longestRunGeRal115H: number
}

export interface SiteRunSummary {
  site: SiteId
  run: ArchiveRun['id']
  radiantBoostC: number
  grid: { lat: number; lon: number; elevationM: number } | null
  seasons: number
  /** WBGT distribution over all hours of all seasons (max = maximum over the seasons). */
  wbgt: { p50: number; p95: number; max: number }
  twlSun: { p05: number; p50: number; min: number }
  meanSeason: ZoneHours
  byYear: (ZoneHours & { year: number })[]
}

export interface HoursInZoneReport {
  schema: 'zill.validation.hours_in_zone/v1'
  evidenceClass: 'real_data_exposure'
  title: string
  generatedBy: 'scripts/validate/hours-in-zone.ts'
  command: string
  stamp: CodeStamp
  provenance: { inputs: InputFileRecord[]; manifestMismatches: string[]; attribution: typeof DATA_ATTRIBUTION }
  config: {
    years: number[]
    season: string
    timezone: string
    runs: readonly ArchiveRun[]
    wbgtBands: readonly WbgtBand[]
    wbgtThresholdsC: typeof WBGT_THRESHOLDS
    adoshZones: ReturnType<typeof adoshZoneTable>
    middayBreak: ReturnType<typeof middayBreakRule>
    engine: string
    cooledRest: CooledRestWbgt
    clothing: string
    notes: string[]
  }
  sites: SiteRunSummary[]
  /** Primary run: mean hours per season by local month (6–9) and by local hour (0–23), per site. */
  byMonth: { site: SiteId; month: number; wbgtBands: number[]; adoshSun: number[]; adoshShade: number[] }[]
  byHour: { site: SiteId; hour: number; wbgtBands: number[]; adoshSun: number[]; adoshShade: number[]; meanWbgtC: number; meanTwlSun: number }[]
  middayBreak: {
    site: SiteId | 'all'
    adoshHighHours: number
    adoshHighOutsideBreak: number
    adoshHighShareOutside: number
    wbgtGeRal115Hours: number
    wbgtGeRal115OutsideBreak: number
    wbgtGeRal115ShareOutside: number
    /** Of the outside hours: share on season days outside the break dates (1–14 Jun, 16–30 Sep). */
    wbgtGeRal115OutsideSeasonDatesShare: number
  }[]
  twlPlausibility: {
    published: typeof UAE_FIELD_TWL
    rows: { site: SiteId | 'all'; period: 'jun_sep' | 'june'; byHour: { hour: number; twlSunMean: number; twlShadeMean: number }[] }[]
    daysDaytimeMinBelow: { site: SiteId | 'all'; below140Share: number; below115Share: number }[]
    verdict: string[]
  }
  workRest: {
    method: string
    cooledRest: CooledRestWbgt
    restMetabolicW: number
    middayBreakHours: number[]
    /** Pooled over the five sites, Jun–Sep 2020–2025: mean allowed work min/h by local hour. */
    byHour: { hour: number; work: 'moderate' | 'heavy'; limit: ExposureLimitId; rest: 'cabin' | 'shade'; meanMinPerHour: number; zeroShare: number }[]
    /** Mean over the daytime shift hours, by site and month (month 0 = whole season). */
    dayShift: { site: SiteId | 'all'; month: number; work: 'moderate' | 'heavy'; limit: ExposureLimitId; rest: 'cabin' | 'shade'; meanMinPerHour: number; zeroShare: number }[]
  }
  sensitivity: { site: SiteId; ral115HoursIfs: number; ral115HoursEra5: number; era5MinusIfsPct: number; ral115HoursWithBoost: number; boostMinusNonePct: number }[]
  researchComparison: {
    source: string
    rows: { site: SiteId; model: ArchiveModel; ours: Record<string, number>; preview: Record<string, number>; diff: Record<string, number> }[]
    ge30ByYearIfs: { site: SiteId; ours: number[]; preview: number[] }[]
    note: string
  }
  observationalAnchor: {
    period: typeof AIRPORT_PERIOD
    rows: { icao: string; nMatched: number; source: 'metar_obs_met' | 'ecmwf_ifs' | 'era5'; wbgtBands: number[]; geRal115: number; adoshHighSun: number }[]
    note: string
  }
  headline: Record<string, number | string>
}

// ─────────────────────────────── Aggregation helpers ───────────────────────────────

const nB = WBGT_BANDS.length
const nZ = ADOSH_ZONES.length
const zeros = (k: number): number[] => Array.from({ length: k }, () => 0)

function emptyZoneHours(): ZoneHours {
  return {
    hours: 0,
    wbgtBands: zeros(nB),
    adoshSun: zeros(nZ),
    adoshShade: zeros(nZ),
    previewCutpoints: { ge28: 0, ge30: 0, ge32: 0, ge33: 0, ge30OutsideBreak: 0 },
    daysWithAdoshHigh: 0,
    daysWithWbgtGeRal115: 0,
    longestRunGeRal115H: 0,
  }
}

/** Count one season's hours. */
function seasonHours(c: HeatColumns): ZoneHours {
  const z = emptyZoneHours()
  const highDays = new Set<number>()
  const ralDays = new Set<number>()
  let run = 0
  let prevT = Number.NaN
  for (let i = 0; i < c.n; i++) {
    const w = c.wbgtC[i]
    z.hours++
    z.wbgtBands[wbgtBandIndex(w)]++
    const zs = adoshZoneIndex(c.twlWm2[i])
    z.adoshSun[zs]++
    z.adoshShade[adoshZoneIndex(c.twlShadeWm2[i])]++
    if (w >= 28) z.previewCutpoints.ge28++
    if (w >= 30) {
      z.previewCutpoints.ge30++
      if (!inMiddayBreak(c.t[i])) z.previewCutpoints.ge30OutsideBreak++
    }
    if (w >= 32) z.previewCutpoints.ge32++
    if (w >= 33) z.previewCutpoints.ge33++
    if (zs === 0) highDays.add(c.dayIndex[i])
    const geRal = w >= WBGT_THRESHOLDS.ral115
    if (geRal) ralDays.add(c.dayIndex[i])
    const contiguous = c.t[i] - prevT === 3_600_000
    run = geRal ? (contiguous ? run + 1 : 1) : 0
    if (run > z.longestRunGeRal115H) z.longestRunGeRal115H = run
    prevT = c.t[i]
  }
  z.daysWithAdoshHigh = highDays.size
  z.daysWithWbgtGeRal115 = ralDays.size
  return z
}

/** Mean of several seasons (longest run = maximum over the seasons). */
function meanSeason(seasons: readonly ZoneHours[]): ZoneHours {
  const k = seasons.length
  const m = emptyZoneHours()
  const avg = (f: (s: ZoneHours) => number): number => roundTo(seasons.reduce((a, s) => a + f(s), 0) / k, 1)
  m.hours = avg((s) => s.hours)
  m.wbgtBands = m.wbgtBands.map((_, j) => avg((s) => s.wbgtBands[j]))
  m.adoshSun = m.adoshSun.map((_, j) => avg((s) => s.adoshSun[j]))
  m.adoshShade = m.adoshShade.map((_, j) => avg((s) => s.adoshShade[j]))
  m.previewCutpoints = {
    ge28: avg((s) => s.previewCutpoints.ge28),
    ge30: avg((s) => s.previewCutpoints.ge30),
    ge32: avg((s) => s.previewCutpoints.ge32),
    ge33: avg((s) => s.previewCutpoints.ge33),
    ge30OutsideBreak: avg((s) => s.previewCutpoints.ge30OutsideBreak),
  }
  m.daysWithAdoshHigh = avg((s) => s.daysWithAdoshHigh)
  m.daysWithWbgtGeRal115 = avg((s) => s.daysWithWbgtGeRal115)
  m.longestRunGeRal115H = Math.max(...seasons.map((s) => s.longestRunGeRal115H))
  return m
}

function sortedCopy(xs: Float64Array[]): Float64Array {
  const total = xs.reduce((a, x) => a + x.length, 0)
  const out = new Float64Array(total)
  let o = 0
  for (const x of xs) {
    out.set(x, o)
    o += x.length
  }
  return out.sort()
}

const share = (part: number, whole: number): number => (whole > 0 ? roundTo(part / whole, 3) : Number.NaN)

// ─────────────────────────────── Planning insight ───────────────────────────────

/** Accumulator of allowed work minutes. */
interface WorkAcc {
  sum: number
  zero: number
  n: number
}
const workKey = (work: string, limit: string, rest: string): string => `${work}|${limit}|${rest}`

function addWork(acc: Map<string, WorkAcc>, key: string, minutes: number): void {
  const a = acc.get(key) ?? { sum: 0, zero: 0, n: 0 }
  a.sum += minutes
  a.n++
  if (minutes <= 0) a.zero++
  acc.set(key, a)
}

/**
 * Allowed work minutes per hour for each work rate × limit × rest option in one hour (limits.ts allowedWorkFraction:
 * the largest f with Limit(f·M_work + (1−f)·115 W) ≥ f·WBGT_work + (1−f)·WBGT_rest). Work in direct sun; clothing:
 * ordinary work clothes (ACGIH CAV 0, no hood) via limits.ts wbgtEffectiveC. Cabin rest = min(cabin WBGT, shade WBGT).
 */
function hourWorkMinutes(wbgtSunC: number, wbgtShadeC: number, cabinC: number): Map<string, number> {
  const out = new Map<string, number>()
  const work = wbgtEffectiveC(wbgtSunC, 'work_clothes', false)
  // Cooled cabin: never above the outdoor shade WBGT, since shade is always available (as risk.ts does) [ENG].
  const rests = { cabin: wbgtEffectiveC(Math.min(cabinC, wbgtShadeC), 'work_clothes', false), shade: wbgtEffectiveC(wbgtShadeC, 'work_clothes', false) }
  for (const w of PLAN_WORK) {
    for (const limit of PLAN_LIMITS) {
      for (const rest of PLAN_REST) {
        const r = allowedWorkFraction({ workW: w.workW, restW: REST_METABOLIC_W, wbgtWorkEffC: work, wbgtRestEffC: rests[rest], limit })
        out.set(workKey(w.id, limit, rest), r.workMinPerHour)
      }
    }
  }
  return out
}

// ─────────────────────────────── Run ───────────────────────────────

/**
 * Compute every hours-in-zone statistic and (by default) write public/data/validation/hours-in-zone.json.
 * Basis: data_and_validation.md §10 A (design), regulation.ts (ADOSH zones, midday break), limits.ts (REL/RAL, work–rest).
 */
export function runHoursInZone(opts: RunOptions = {}): HoursInZoneReport {
  const log = opts.log ?? true
  const prov = new Provenance()
  const cooled = cooledRestWbgt()
  const t0 = performance.now()

  // 1. Hourly heat for every site × season × run.
  const cols = new Map<string, HeatColumns>() // key `${run}|${site}|${year}`
  const grids = new Map<string, { lat: number; lon: number; elevationM: number } | null>()
  for (const site of SITES) {
    for (const year of HOURS_YEARS) {
      const json = prov.readJson(`public/data/weather/archive/${site.id}_${year}.json`)
      for (const run of ARCHIVE_RUNS) {
        const series = parseArchiveFile(json, run.model)
        if (series.droppedHours > 0 && log) console.warn(`[hours] ${site.id} ${year} ${run.model}: ${series.droppedHours} hours dropped`)
        cols.set(`${run.id}|${site.id}|${year}`, heatColumns(series.samples, site, run.boost))
        if (!grids.has(`${run.model}|${site.id}`)) grids.set(`${run.model}|${site.id}`, series.grid ? { lat: series.grid.lat, lon: series.grid.lon, elevationM: series.grid.elevationM } : null)
      }
    }
  }
  const tHeat = performance.now()
  const get = (run: ArchiveRun['id'], site: SiteId, year: number): HeatColumns => {
    const c = cols.get(`${run}|${site}|${year}`)
    if (!c) throw new Error(`missing heat columns ${run} ${site} ${year}`)
    return c
  }

  // 2. Per-site summaries for every run.
  const sites: SiteRunSummary[] = []
  for (const run of ARCHIVE_RUNS) {
    for (const site of SITES) {
      const seasons = HOURS_YEARS.map((y) => ({ year: y, ...seasonHours(get(run.id, site.id, y)) }))
      const wb = sortedCopy(HOURS_YEARS.map((y) => get(run.id, site.id, y).wbgtC))
      const tw = sortedCopy(HOURS_YEARS.map((y) => get(run.id, site.id, y).twlWm2))
      sites.push({
        site: site.id,
        run: run.id,
        radiantBoostC: run.boost === 'site' ? site.radiantBoostC : 0,
        grid: grids.get(`${run.model}|${site.id}`) ?? null,
        seasons: seasons.length,
        wbgt: { p50: roundTo(quantileSorted(wb, 0.5), 2), p95: roundTo(quantileSorted(wb, 0.95), 2), max: roundTo(wb[wb.length - 1], 2) },
        twlSun: { p05: roundTo(quantileSorted(tw, 0.05), 1), p50: roundTo(quantileSorted(tw, 0.5), 1), min: roundTo(tw[0], 1) },
        meanSeason: meanSeason(seasons),
        byYear: seasons,
      })
    }
  }
  const summaryOf = (run: ArchiveRun['id'], site: SiteId): SiteRunSummary => {
    const s = sites.find((x) => x.run === run && x.site === site)
    if (!s) throw new Error(`missing summary ${run} ${site}`)
    return s
  }

  // 3. Primary run: by month, by hour, midday break, TWL plausibility, planning insight.
  const k = HOURS_YEARS.length
  const byMonth: HoursInZoneReport['byMonth'] = []
  const byHour: HoursInZoneReport['byHour'] = []
  const mbRows: HoursInZoneReport['middayBreak'] = []
  const twlRows: HoursInZoneReport['twlPlausibility']['rows'] = []
  const daysBelow: HoursInZoneReport['twlPlausibility']['daysDaytimeMinBelow'] = []
  const workByHour = new Map<string, WorkAcc>() // key hour|combo, pooled over sites
  const workDay = new Map<string, WorkAcc>() // key site|month|combo (site 'all' and month 0 too)
  const mbAll = { high: 0, highOut: 0, ral: 0, ralOut: 0, ralOutOffSeason: 0 }
  const twlAll = { jun_sep: new Map<number, { sun: number; shade: number; n: number }>(), june: new Map<number, { sun: number; shade: number; n: number }>() }
  const belowAll = { days: 0, b140: 0, b115: 0 }

  for (const site of SITES) {
    const monthAcc = new Map<number, { wb: number[]; zs: number[]; zh: number[] }>()
    const hourAcc = new Map<number, { wb: number[]; zs: number[]; zh: number[]; wsum: number; tsum: number; n: number }>()
    const mb = { high: 0, highOut: 0, ral: 0, ralOut: 0, ralOutOffSeason: 0 }
    const twlSite = { jun_sep: new Map<number, { sun: number; shade: number; n: number }>(), june: new Map<number, { sun: number; shade: number; n: number }>() }
    let days = 0
    let b140 = 0
    let b115 = 0
    for (const year of HOURS_YEARS) {
      const c = get('ifs', site.id, year)
      const dayMin = new Map<number, number>()
      for (let i = 0; i < c.n; i++) {
        const w = c.wbgtC[i]
        const band = wbgtBandIndex(w)
        const zs = adoshZoneIndex(c.twlWm2[i])
        const zh = adoshZoneIndex(c.twlShadeWm2[i])
        const mo = c.month[i]
        const hr = c.hour[i]
        const ma = monthAcc.get(mo) ?? { wb: zeros(nB), zs: zeros(nZ), zh: zeros(nZ) }
        ma.wb[band]++
        ma.zs[zs]++
        ma.zh[zh]++
        monthAcc.set(mo, ma)
        const ha = hourAcc.get(hr) ?? { wb: zeros(nB), zs: zeros(nZ), zh: zeros(nZ), wsum: 0, tsum: 0, n: 0 }
        ha.wb[band]++
        ha.zs[zs]++
        ha.zh[zh]++
        ha.wsum += w
        ha.tsum += c.twlWm2[i]
        ha.n++
        hourAcc.set(hr, ha)
        // Midday break: is this hour inside the MoHRE window?
        const inBreak = inMiddayBreak(c.t[i])
        const offSeasonDates = !inMiddayBreakSeason(c.t[i])
        if (zs === 0) {
          mb.high++
          if (!inBreak) mb.highOut++
        }
        if (w >= WBGT_THRESHOLDS.ral115) {
          mb.ral++
          if (!inBreak) {
            mb.ralOut++
            if (offSeasonDates) mb.ralOutOffSeason++
          }
        }
        // TWL at the field-study hours.
        if ((FIELD_HOURS as readonly number[]).includes(hr)) {
          for (const [period, ok] of [
            ['jun_sep', true],
            ['june', mo === 6],
          ] as const) {
            if (!ok) continue
            for (const target of [twlSite[period], twlAll[period]]) {
              const a = target.get(hr) ?? { sun: 0, shade: 0, n: 0 }
              a.sun += c.twlWm2[i]
              a.shade += c.twlShadeWm2[i]
              a.n++
              target.set(hr, a)
            }
          }
        }
        if (hr >= DAY_SHIFT_HOURS.from && hr <= DAY_SHIFT_HOURS.to) {
          dayMin.set(c.dayIndex[i], Math.min(dayMin.get(c.dayIndex[i]) ?? Number.POSITIVE_INFINITY, c.twlWm2[i]))
        }
        // Planning insight (every hour; shift summary 07–17 h).
        const wm = hourWorkMinutes(w, c.wbgtShadeC[i], cooled.wbgtC)
        for (const [combo, minutes] of wm) {
          addWork(workByHour, `${hr}|${combo}`, minutes)
          if (hr >= DAY_SHIFT_HOURS.from && hr <= DAY_SHIFT_HOURS.to) {
            for (const key of [`${site.id}|${mo}|${combo}`, `${site.id}|0|${combo}`, `all|${mo}|${combo}`, `all|0|${combo}`]) addWork(workDay, key, minutes)
          }
        }
      }
      for (const m of dayMin.values()) {
        days++
        if (m < 140) b140++
        if (m < 115) b115++
      }
    }
    for (const [mo, a] of [...monthAcc.entries()].sort((x, y) => x[0] - y[0])) {
      byMonth.push({ site: site.id, month: mo, wbgtBands: a.wb.map((x) => roundTo(x / k, 1)), adoshSun: a.zs.map((x) => roundTo(x / k, 1)), adoshShade: a.zh.map((x) => roundTo(x / k, 1)) })
    }
    for (const [hr, a] of [...hourAcc.entries()].sort((x, y) => x[0] - y[0])) {
      byHour.push({
        site: site.id,
        hour: hr,
        wbgtBands: a.wb.map((x) => roundTo(x / k, 1)),
        adoshSun: a.zs.map((x) => roundTo(x / k, 1)),
        adoshShade: a.zh.map((x) => roundTo(x / k, 1)),
        meanWbgtC: roundTo(a.wsum / a.n, 2),
        meanTwlSun: roundTo(a.tsum / a.n, 1),
      })
    }
    mbRows.push({
      site: site.id,
      adoshHighHours: roundTo(mb.high / k, 1),
      adoshHighOutsideBreak: roundTo(mb.highOut / k, 1),
      adoshHighShareOutside: share(mb.highOut, mb.high),
      wbgtGeRal115Hours: roundTo(mb.ral / k, 1),
      wbgtGeRal115OutsideBreak: roundTo(mb.ralOut / k, 1),
      wbgtGeRal115ShareOutside: share(mb.ralOut, mb.ral),
      wbgtGeRal115OutsideSeasonDatesShare: share(mb.ralOutOffSeason, mb.ralOut),
    })
    mbAll.high += mb.high
    mbAll.highOut += mb.highOut
    mbAll.ral += mb.ral
    mbAll.ralOut += mb.ralOut
    mbAll.ralOutOffSeason += mb.ralOutOffSeason
    for (const period of ['jun_sep', 'june'] as const) {
      twlRows.push({
        site: site.id,
        period,
        byHour: FIELD_HOURS.map((h) => {
          const a = twlSite[period].get(h)
          return { hour: h, twlSunMean: a ? roundTo(a.sun / a.n, 1) : Number.NaN, twlShadeMean: a ? roundTo(a.shade / a.n, 1) : Number.NaN }
        }),
      })
    }
    daysBelow.push({ site: site.id, below140Share: share(b140, days), below115Share: share(b115, days) })
    belowAll.days += days
    belowAll.b140 += b140
    belowAll.b115 += b115
  }
  const nSites = SITES.length
  mbRows.push({
    site: 'all',
    adoshHighHours: roundTo(mbAll.high / k / nSites, 1),
    adoshHighOutsideBreak: roundTo(mbAll.highOut / k / nSites, 1),
    adoshHighShareOutside: share(mbAll.highOut, mbAll.high),
    wbgtGeRal115Hours: roundTo(mbAll.ral / k / nSites, 1),
    wbgtGeRal115OutsideBreak: roundTo(mbAll.ralOut / k / nSites, 1),
    wbgtGeRal115ShareOutside: share(mbAll.ralOut, mbAll.ral),
    wbgtGeRal115OutsideSeasonDatesShare: share(mbAll.ralOutOffSeason, mbAll.ralOut),
  })
  for (const period of ['jun_sep', 'june'] as const) {
    twlRows.push({
      site: 'all',
      period,
      byHour: FIELD_HOURS.map((h) => {
        const a = twlAll[period].get(h)
        return { hour: h, twlSunMean: a ? roundTo(a.sun / a.n, 1) : Number.NaN, twlShadeMean: a ? roundTo(a.shade / a.n, 1) : Number.NaN }
      }),
    })
  }
  daysBelow.push({ site: 'all', below140Share: share(belowAll.b140, belowAll.days), below115Share: share(belowAll.b115, belowAll.days) })

  // TWL plausibility verdict (rule-based, stated in the output).
  const pooled = twlRows.find((r) => r.site === 'all' && r.period === 'jun_sep')
  const pooledJune = twlRows.find((r) => r.site === 'all' && r.period === 'june')
  const verdict: string[] = []
  if (pooled && pooledJune) {
    const [lo, hi] = UAE_FIELD_TWL.miller2011.meanBandWm2
    for (const row of pooled.byHour) {
      const bs = UAE_FIELD_TWL.batesSchneider2008.byHour[row.hour]
      const june = pooledJune.byHour.find((x) => x.hour === row.hour)
      verdict.push(
        `${String(row.hour).padStart(2, '0')}:00 — modelled Jun–Sep mean TWL ${row.twlSunMean} W/m² in sun, ${row.twlShadeMean} in shade (June ${june?.twlSunMean ?? 'n/a'} / ${june?.twlShadeMean ?? 'n/a'}); ` +
          `Miller 2011 summer means ${lo}–${hi}: shade ${row.twlShadeMean >= lo && row.twlShadeMean <= hi ? 'inside' : 'outside'}, sun ${row.twlSunMean >= lo && row.twlSunMean <= hi ? 'inside' : 'outside'}; ` +
          `Bates & Schneider May 2006: ${bs ?? 'n/a'}.`,
      )
    }
  }

  // Planning insight tables.
  const workByHourRows: HoursInZoneReport['workRest']['byHour'] = []
  for (let hr = 0; hr < 24; hr++) {
    for (const w of PLAN_WORK) {
      for (const limit of PLAN_LIMITS) {
        for (const rest of PLAN_REST) {
          const a = workByHour.get(`${hr}|${workKey(w.id, limit, rest)}`)
          if (!a) continue
          workByHourRows.push({ hour: hr, work: w.id, limit, rest, meanMinPerHour: roundTo(a.sum / a.n, 1), zeroShare: roundTo(a.zero / a.n, 3) })
        }
      }
    }
  }
  const dayShiftRows: HoursInZoneReport['workRest']['dayShift'] = []
  for (const s of [...SITES.map((x) => x.id), 'all' as const]) {
    for (const mo of [0, 6, 7, 8, 9]) {
      for (const w of PLAN_WORK) {
        for (const limit of PLAN_LIMITS) {
          for (const rest of PLAN_REST) {
            const a = workDay.get(`${s}|${mo}|${workKey(w.id, limit, rest)}`)
            if (!a) continue
            dayShiftRows.push({ site: s, month: mo, work: w.id, limit, rest, meanMinPerHour: roundTo(a.sum / a.n, 1), zeroShare: roundTo(a.zero / a.n, 3) })
          }
        }
      }
    }
  }

  // 4. Sensitivity: ERA5 vs IFS, site radiant allowance.
  const ralHours = (s: SiteRunSummary): number => s.meanSeason.wbgtBands.slice(2).reduce((a, x) => a + x, 0)
  const sensitivity = SITES.map((site) => {
    const ifs = ralHours(summaryOf('ifs', site.id))
    const era5 = ralHours(summaryOf('era5', site.id))
    const boost = ralHours(summaryOf('ifs_site_boost', site.id))
    return {
      site: site.id,
      ral115HoursIfs: roundTo(ifs, 1),
      ral115HoursEra5: roundTo(era5, 1),
      era5MinusIfsPct: roundTo((100 * (era5 - ifs)) / ifs, 1),
      ral115HoursWithBoost: roundTo(boost, 1),
      boostMinusNonePct: roundTo((100 * (boost - ifs)) / ifs, 1),
    }
  })

  // 5. Comparison with the research preview (thermofeel, config A).
  const researchRows: HoursInZoneReport['researchComparison']['rows'] = []
  for (const p of HOURS_PREVIEW) {
    const s = summaryOf(p.model === 'era5' ? 'era5' : 'ifs', p.site as SiteId)
    const ours = {
      p50: s.wbgt.p50,
      p95: s.wbgt.p95,
      max: s.wbgt.max,
      ge28: s.meanSeason.previewCutpoints.ge28,
      ge30: s.meanSeason.previewCutpoints.ge30,
      ge32: s.meanSeason.previewCutpoints.ge32,
      ge33: s.meanSeason.previewCutpoints.ge33,
      ge30OutsideBreak: s.meanSeason.previewCutpoints.ge30OutsideBreak,
    }
    const preview = { p50: p.p50, p95: p.p95, max: p.max, ge28: p.ge28, ge30: p.ge30, ge32: p.ge32, ge33: p.ge33, ge30OutsideBreak: p.ge30OutsideBreak }
    const diff: Record<string, number> = {}
    for (const key of Object.keys(preview) as (keyof typeof preview)[]) diff[key] = roundTo(ours[key] - preview[key], key.startsWith('ge') ? 0 : 2)
    researchRows.push({ site: s.site, model: p.model, ours, preview, diff })
  }
  const ge30ByYearIfs = SITES.map((site) => ({
    site: site.id,
    ours: summaryOf('ifs', site.id).byYear.map((y) => y.previewCutpoints.ge30),
    preview: [...(HOURS_GE30_BY_YEAR_PREVIEW[site.id] ?? [])],
  }))

  // 6. Observational anchor at the airports (summer 2025): model-only vs METAR-based WBGT hours.
  const anchorRows: HoursInZoneReport['observationalAnchor']['rows'] = []
  for (const a of AIRPORTS) {
    const metar = loadMetar(prov, a)
    const site: Site = airportSite(a, metar.lat, metar.lon)
    const ifs = loadAirportAnalysis(prov, a, 'ecmwf_ifs@nearest')
    const era5 = loadAirportAnalysis(prov, a, 'era5@nearest')
    const era5ByT = timeIndex(era5.samples.map((s) => s.t))
    const acc = {
      metar_obs_met: { wb: zeros(nB), ral: 0, high: 0 },
      ecmwf_ifs: { wb: zeros(nB), ral: 0, high: 0 },
      era5: { wb: zeros(nB), ral: 0, high: 0 },
    }
    let n = 0
    for (const s of ifs.samples) {
      const o = metar.byTime.get(s.t)
      const ei = era5ByT.get(s.t)
      if (!metarUsable(o) || ei === undefined) continue
      n++
      const hs = {
        metar_obs_met: hourHeat(obsMetSample(o, s), site, 'none'),
        ecmwf_ifs: hourHeat(s, site, 'none'),
        era5: hourHeat(era5.samples[ei], site, 'none'),
      }
      for (const key of ['metar_obs_met', 'ecmwf_ifs', 'era5'] as const) {
        const h = hs[key]
        acc[key].wb[wbgtBandIndex(h.wbgtC)]++
        if (h.wbgtC >= WBGT_THRESHOLDS.ral115) acc[key].ral++
        if (adoshZoneIndex(h.twlWm2) === 0) acc[key].high++
      }
    }
    for (const key of ['metar_obs_met', 'ecmwf_ifs', 'era5'] as const) {
      anchorRows.push({ icao: a.icao, nMatched: n, source: key, wbgtBands: acc[key].wb, geRal115: acc[key].ral, adoshHighSun: acc[key].high })
    }
  }
  const tAll = performance.now()

  // 7. Headline numbers (primary run, all sites pooled).
  const all = mbRows.find((r) => r.site === 'all')
  const ifsSites = SITES.map((s) => summaryOf('ifs', s.id))
  const meanOver = (f: (s: SiteRunSummary) => number): number => roundTo(ifsSites.reduce((acc, s) => acc + f(s), 0) / ifsSites.length, 1)
  const ds = (work: string, limit: string, rest: string): number => dayShiftRows.find((r) => r.site === 'all' && r.month === 0 && r.work === work && r.limit === limit && r.rest === rest)?.meanMinPerHour ?? Number.NaN
  const headline: Record<string, number | string> = {
    hoursPerSeason: ifsSites[0]?.meanSeason.hours ?? Number.NaN,
    meanSiteHoursGeRal115PerSeason: meanOver((s) => s.meanSeason.wbgtBands.slice(2).reduce((acc, x) => acc + x, 0)),
    meanSiteHoursGeRel115PerSeason: meanOver((s) => s.meanSeason.wbgtBands[4]),
    meanSiteHoursAdoshHighSunPerSeason: meanOver((s) => s.meanSeason.adoshSun[0]),
    meanSiteHoursAdoshHighShadePerSeason: meanOver((s) => s.meanSeason.adoshShade[0]),
    shareAdoshHighOutsideMiddayBreak: all?.adoshHighShareOutside ?? Number.NaN,
    shareWbgtGeRal115OutsideMiddayBreak: all?.wbgtGeRal115ShareOutside ?? Number.NaN,
    dayShiftModerateRelCabinMinPerHour: ds('moderate', 'REL', 'cabin'),
    dayShiftModerateRelShadeMinPerHour: ds('moderate', 'REL', 'shade'),
    dayShiftHeavyRelCabinMinPerHour: ds('heavy', 'REL', 'cabin'),
    dayShiftHeavyRelShadeMinPerHour: ds('heavy', 'REL', 'shade'),
    dayShiftModerateRalCabinMinPerHour: ds('moderate', 'RAL', 'cabin'),
    dayShiftModerateRalShadeMinPerHour: ds('moderate', 'RAL', 'shade'),
    dayShiftHeavyRalCabinMinPerHour: ds('heavy', 'RAL', 'cabin'),
    dayShiftHeavyRalShadeMinPerHour: ds('heavy', 'RAL', 'shade'),
    cooledRestWbgtC: cooled.wbgtC,
  }

  const report: HoursInZoneReport = {
    schema: 'zill.validation.hours_in_zone/v1',
    evidenceClass: 'real_data_exposure',
    title: 'Hours in each heat zone at five Abu Dhabi sites, Jun–Sep 2020–2025',
    generatedBy: 'scripts/validate/hours-in-zone.ts',
    command: 'npm run validate',
    stamp: codeStamp(prov.inputsSha256()),
    provenance: { inputs: prov.records(), manifestMismatches: prov.manifestMismatches(), attribution: DATA_ATTRIBUTION },
    config: {
      years: [...HOURS_YEARS],
      season: '1 Jun 00:00 – 30 Sep 23:00 local, every hour (2,928 h per season)',
      timezone: 'Asia/Dubai (UTC+4); hour of day = local hour of the instantaneous sample time',
      runs: ARCHIVE_RUNS,
      wbgtBands: WBGT_BANDS,
      wbgtThresholdsC: WBGT_THRESHOLDS,
      adoshZones: adoshZoneTable(),
      middayBreak: middayBreakRule(),
      engine:
        'indices.ts computeSiteHeat per hour: Liljegren WBGT in sun and engineered shade (hour-mean radiation, geometry at t − 30 min, 10 m → 2 m urban power law, 0.62 m/s 10 m floor); TWL in sun (globe-field MRT) and shade; regulation.ts twlZone / isMiddayBreak; limits.ts allowedWorkFraction',
      cooledRest: cooled,
      clothing: 'ordinary work clothes / cloth coveralls (ACGIH CAV 0, no hood): WBGT_eff = WBGT',
      notes: [
        'Model grid-cell values, not station or worksite measurements: the analysis carries about ±1.0–1.2 °C WBGT error against airport METARs (data_and_validation.md §6.3; see observationalAnchor and forecast-skill.json).',
        'The primary run applies no site radiant allowance (the meteorological exposure, as in the research preview); the ifs_site_boost run shows the effect of the [ENG] per-site allowance for hot work surfaces.',
        'Band edges are computed from the engine equations (REL(300 W) = 28.21, RAL(115 W) = 30.84, REL(115 W) = 33.00 °C) and the Qatar 32.1 °C stop value; lower edges are inclusive.',
        'Hours 13:00 and 14:00 local fall inside the midday-break window on 15 Jun–15 Sep; outdoor work in direct sun is banned there, so the allowed-work numbers for those hours apply only to the season dates outside the ban.',
      ],
    },
    sites,
    byMonth,
    byHour,
    middayBreak: mbRows,
    twlPlausibility: { published: UAE_FIELD_TWL, rows: twlRows, daysDaytimeMinBelow: daysBelow, verdict },
    workRest: {
      method:
        'limits.ts allowedWorkFraction per hour: largest f with Limit(f·M_work + (1−f)·115 W) ≥ f·WBGT_sun + (1−f)·WBGT_rest (1-h TWA, NIOSH 2016 §8.1 / ACGIH). WBGT_rest = cooled cabin (min(cabin WBGT, shade WBGT), as risk.ts) or the modelled engineered-shade WBGT. Minutes = 60·f; zeroShare = share of hours with no work allowed.',
      cooledRest: cooled,
      restMetabolicW: REST_METABOLIC_W,
      middayBreakHours: [13, 14],
      byHour: workByHourRows,
      dayShift: dayShiftRows,
    },
    sensitivity,
    researchComparison: {
      source: HOURS_PREVIEW_SOURCE,
      rows: researchRows,
      ge30ByYearIfs,
      note: 'The preview used thermofeel with radiation configuration A; the engine uses configuration B (§6.5 sensitivity: seasonal counts within 1 %). Counts are mean hours per season.',
    },
    observationalAnchor: {
      period: AIRPORT_PERIOD,
      rows: anchorRows,
      note: 'Hours per WBGT band over the matched METAR hours of summer 2025 at the airport model cells: METAR T/Td/wind with IFS 9 km radiation (obs-met) versus model-only WBGT (data_and_validation.md §10 A.4(b)). Airports stand in for the sites only approximately.',
    },
    headline,
  }
  if (opts.write ?? true) {
    const bytes = writeValidationJson('hours-in-zone', report)
    if (log) {
      console.log(
        `[hours] ${cols.size} site-seasons · heat ${(tHeat - t0).toFixed(0)} ms · aggregation+anchor ${(tAll - tHeat).toFixed(0)} ms · hours-in-zone.json ${(bytes / 1024).toFixed(1)} KiB`,
      )
    }
  }
  if (log && prov.manifestMismatches().length > 0) console.warn(`[hours] manifest mismatches: ${prov.manifestMismatches().join(', ')}`)
  return report
}

if (isMainModule(import.meta.url)) {
  const { ms } = timed(() => runHoursInZone())
  console.log(`[hours] done in ${(ms / 1000).toFixed(1)} s`)
}
