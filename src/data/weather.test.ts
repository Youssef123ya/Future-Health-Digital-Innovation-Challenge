import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EnvSample } from '../engine/types'
import { DAY_MS, HOUR_MS, MINUTE_MS, epochFromLocal, localParts } from '../engine/time'
import { SITE_DATA_INFO, SITE_IDS, getSite, type SiteId } from './sites'
import {
  CONSERVATIVE_PROFILE,
  DEFAULT_WIND10_MS,
  STALE_WBGT_MARGIN_C,
  WBGT_VARIABLES,
  WeatherDataError,
  archivePeriodFor,
  buildForecastUrl,
  conservativeDefaultSample,
  createEnvSampler,
  createWeatherLoader,
  deriveConservativeProfile,
  fetchLiveForecast,
  forecastConfidence,
  instantFromHourMean,
  interpolateEnv,
  noaaCosZenith,
  parseArchiveFile,
  parseDemoDays,
  parseForecastResponse,
  parseManifest,
  parseMetarFile,
  parsePreviousRunsFile,
  parseValidationPointFile,
  resolveEnvironment,
  sampleAt,
  solarGeometryTime,
  type FetchLike,
  type WeatherSeries,
} from './weather'

const DATA = new URL('../../public/data/', import.meta.url)
const rawCache = new Map<string, unknown>()
const readJson = (rel: string): unknown => {
  if (!rawCache.has(rel)) rawCache.set(rel, JSON.parse(readFileSync(new URL(rel, DATA), 'utf8')))
  return rawCache.get(rel)
}
const YEARS = [2020, 2021, 2022, 2023, 2024, 2025]
const local = (s: string) => epochFromLocal(s)

const musaffah2025 = () => parseArchiveFile(readJson('weather/archive/musaffah_2025.json'))
const MUSAFFAH = getSite('musaffah')

// ───────────────────────────── Parsers on the real cached files ─────────────────────────────

describe('cached archive files', () => {
  it('every summer file parses to 2928 hourly samples per model with monotonic times and sane units', () => {
    for (const site of SITE_IDS) {
      for (const year of YEARS) {
        const raw = readJson(`weather/archive/${site}_${year}.json`)
        for (const model of ['ecmwf_ifs', 'era5'] as const) {
          const s = parseArchiveFile(raw, model)
          expect(s.locationId).toBe(site)
          expect(s.source).toBe('archive')
          expect(s.droppedHours).toBe(0)
          expect(s.samples).toHaveLength(2928)
          expect(s.samples[0].t).toBe(local(`${year}-06-01T00:00`))
          expect(s.samples[2927].t).toBe(local(`${year}-09-30T23:00`))
          const bad: string[] = []
          for (let i = 0; i < s.samples.length; i++) {
            const x = s.samples[i]
            const h = localParts(x.t).hour
            const checks: [boolean, string][] = [
              [i === 0 || x.t - s.samples[i - 1].t === HOUR_MS, 'hourly step'],
              [x.taC > 15 && x.taC < 52, 'air temperature °C'],
              [x.rhPct >= 0 && x.rhPct <= 100, 'RH %'],
              [x.tdC! <= x.taC + 0.05, 'dew point ≤ air temperature'],
              [x.pHpa > 950 && x.pHpa < 1015, 'surface pressure hPa (Al Ain ~970, coast ~1000)'],
              [x.wind10Ms >= 0 && x.wind10Ms < 25, 'wind m/s (not km/h)'],
              [x.ghiWm2 >= 0 && x.ghiWm2 < 1100, 'GHI W/m²'],
              [Math.abs(x.directWm2! + x.diffuseWm2! - x.ghiWm2) < 1, 'GHI = horizontal beam + diffuse'],
              [!(h <= 4 || h >= 21) || x.ghiWm2 === 0, 'no sun in hours ending 00–04 and 21–23'],
            ]
            for (const [ok, what] of checks) if (!ok) bad.push(`${site} ${year} ${model} i=${i}: ${what}`)
          }
          expect(bad).toEqual([])
        }
      }
    }
  })

  it('records the grid cells of SITE_DATA_INFO, including the KEZAD land cell (the requested point is water)', () => {
    for (const site of SITE_IDS) {
      const s = parseArchiveFile(readJson(`weather/archive/${site}_2025.json`))
      expect(s.grid).toEqual(SITE_DATA_INFO[site].ifsCell)
      const e = parseArchiveFile(readJson(`weather/archive/${site}_2025.json`), 'era5')
      expect(e.grid).toEqual(SITE_DATA_INFO[site].era5Cell)
    }
    expect(SITE_DATA_INFO.kezad.ifsCell).toMatchObject({ lat: 24.710016, lon: 54.694534, elevationM: 0, cellSelection: 'land' })
  })

  it('musaffah 2025-08-01 has Tmax 45 °C, as in demo-days.json, and the demo analysis equals the archive slice', () => {
    const s = musaffah2025()
    const t0 = local('2025-08-01T00:00')
    const day = s.samples.filter((x) => x.t >= t0 && x.t < t0 + DAY_MS)
    expect(day).toHaveLength(24)
    expect(Math.max(...day.map((x) => x.taC))).toBe(45)
    const demo = parseDemoDays(readJson('weather/demo-days.json')).find((d) => d.id === 'musaffah_2025-08-01')!
    expect(demo.summary.tmaxC).toBe(45)
    expect(demo.analysis.samples).toEqual(day)
  })

  it('parses the November 2025 Musaffah file (720 hours)', () => {
    const s = parseArchiveFile(readJson('weather/archive/musaffah_2025-11.json'))
    expect(s.samples).toHaveLength(720)
    expect(s.samples[0].t).toBe(local('2025-11-01T00:00'))
  })

  it('rejects files of the wrong schema', () => {
    expect(() => parseArchiveFile({ schema: 'something/else' })).toThrow(WeatherDataError)
    expect(() => parsePreviousRunsFile(readJson('weather/archive/musaffah_2025.json'))).toThrow(/previous_runs/)
  })
})

describe('archived forecasts, demo days, validation points, METAR, manifest', () => {
  it('parses Previous Runs at each lead with lead-day metadata; demo forecasts equal the same slices', () => {
    const raw = readJson('weather/previous-runs/musaffah_2025.json')
    for (const model of ['ecmwf_ifs025', 'dwd_icon_seamless', 'ncep_gfs_seamless'] as const) {
      for (const lead of [0, 1, 2, 3] as const) {
        const s = parsePreviousRunsFile(raw, model, lead)
        expect(s.samples).toHaveLength(2928)
        expect(s.source).toBe('cached_forecast')
        expect(s.leadDays).toBe(lead)
        expect(s.model).toBe(model)
      }
    }
    const d1 = parsePreviousRunsFile(raw, 'ecmwf_ifs025', 1)
    const t0 = local('2025-08-01T00:00')
    const slice = d1.samples.filter((x) => x.t >= t0 && x.t < t0 + DAY_MS)
    const demo = parseDemoDays(readJson('weather/demo-days.json')).find((d) => d.id === 'musaffah_2025-08-01')!
    expect(demo.forecasts[1].samples).toEqual(slice)
    expect(demo.forecasts[1].leadDays).toBe(1)
    expect(demo.forecasts[3].model).toBe('ecmwf_ifs025')
  })

  it('parses all 7 demo days with 24 local hours each', () => {
    const days = parseDemoDays(readJson('weather/demo-days.json'))
    expect(days).toHaveLength(7)
    for (const d of days) {
      expect(d.analysis.samples).toHaveLength(24)
      expect(localParts(d.analysis.samples[0].t)).toMatchObject({ dateKey: d.date, hour: 0 })
      expect(Math.max(...d.analysis.samples.map((x) => x.taC))).toBeCloseTo(d.summary.tmaxC, 6)
    }
  })

  it('parses validation points; ERA5-Land has no wind/pressure/radiation so every hour is dropped', () => {
    const raw = readJson('weather/validation/omaa_2025.json')
    const ifs = parseValidationPointFile(raw)
    expect(ifs.samples).toHaveLength(2928)
    expect(ifs.grid?.cellSelection).toBe('nearest')
    const land = parseValidationPointFile(raw, 'era5_land@nearest')
    expect(land.samples).toHaveLength(0)
    expect(land.droppedHours).toBe(2928)
    const prev = parsePreviousRunsFile(readJson('weather/validation/omaa_2025_previous.json'), 'ncep_gfs_seamless', 2)
    expect(prev.locationId).toBe('omaa')
    expect(prev.samples).toHaveLength(2928)
  })

  it('parses METAR files (UTC axis, one routine report per hour, one hour missing)', () => {
    const m = parseMetarFile(readJson('obs/OMAA_2025_summer.json'))
    expect(m.icao).toBe('OMAA')
    expect(m.observations).toHaveLength(2951)
    expect(m.observations[0].t).toBe(Date.parse('2025-05-31T00:00:00Z'))
    for (let i = 1; i < m.observations.length; i++) expect(m.observations[i].t).toBeGreaterThan(m.observations[i - 1].t)
    for (const o of m.observations) {
      expect(o.taC).not.toBeNull()
      expect(o.taC!).toBeGreaterThan(15)
      expect(o.taC!).toBeLessThan(52)
    }
  })

  it('parses the manifest', () => {
    const m = parseManifest(readJson('weather/manifest.json'))
    expect(m.file_count).toBe(m.files.length)
    expect(m.files.some((f) => f.path === 'data/weather/archive/kezad_2024.json')).toBe(true)
  })
})

// ───────────────────────────── Interpolation ─────────────────────────────

describe('minute-level interpolation', () => {
  const ifsCell = SITE_DATA_INFO.musaffah.ifsCell

  it('reproduces the Open-Meteo instant values of the test vector within 1 % after the first daylight hour', () => {
    // data_and_validation.md §3.3: IFS cell 24.358522 N 54.498936 E, 2025-07-15, local hour: backward GHI → API instant.
    const vector: [number, number, number][] = [
      [7, 69, 117.1],
      [8, 227, 290.4],
      [9, 423, 490.7],
      [10, 610, 670.0],
      [11, 761, 804.1],
      [12, 858, 878.4],
      [13, 890, 884.8],
    ]
    let maxRelErr = 0
    for (const [h, mean, api] of vector) {
      const v = instantFromHourMean(mean, local(`2025-07-15T${String(h).padStart(2, '0')}:00`), ifsCell.lat, ifsCell.lon)
      maxRelErr = Math.max(maxRelErr, Math.abs(v / api - 1))
    }
    expect(maxRelErr).toBeLessThan(0.01)
    // Sunrise hour (06:00: 2 → 18.3) is outside the documented tolerance but must stay small and non-negative.
    const sunrise = instantFromHourMean(2, local('2025-07-15T06:00'), ifsCell.lat, ifsCell.lon)
    expect(sunrise).toBeGreaterThan(0)
    expect(sunrise).toBeLessThan(40)
  })

  it('never produces negative radiation or sunlight while the sun is down (all of summer 2025, every minute)', () => {
    const s = musaffah2025()
    const series = interpolateEnv(s.samples, s.samples[0].t, s.samples[s.samples.length - 1].t, MUSAFFAH, 1)
    expect(series.length).toBe(2927 * 60 + 1)
    let nightMinutes = 0
    let negativeOrNaN = 0
    let sunWhileDown = 0
    let maxGhi = 0
    for (const x of series) {
      for (const v of [x.ghiWm2, x.directWm2!, x.diffuseWm2!, x.dniWm2!]) if (!(Number.isFinite(v) && v >= 0)) negativeOrNaN++
      if (noaaCosZenith(x.t, MUSAFFAH.lat, MUSAFFAH.lon) <= 0) {
        nightMinutes++
        if (x.ghiWm2 !== 0 || x.directWm2 !== 0 || x.diffuseWm2 !== 0 || x.dniWm2 !== 0) sunWhileDown++
      }
      maxGhi = Math.max(maxGhi, x.ghiWm2)
    }
    expect(series.every((x) => x.radiationWindowMin === 0)).toBe(true)
    expect(negativeOrNaN).toBe(0)
    expect(sunWhileDown).toBe(0)
    expect(nightMinutes).toBeGreaterThan(75_000) // ~11 h of night per day over 122 days
    expect(maxGhi).toBeLessThan(1100) // instantaneous peak stays physical (below 0.85·TOA ≈ 1100 W/m²)
  })

  it('conserves the hourly mean radiation (energy) within each hour', () => {
    const s = musaffah2025()
    const sampler = createEnvSampler(s.samples, MUSAFFAH)
    let checked = 0
    for (const hourEnd of s.samples.slice(1)) {
      if (hourEnd.ghiWm2 <= 0) continue
      let sum = 0
      for (let k = 0; k < 60; k++) sum += sampler(hourEnd.t - HOUR_MS + (k + 0.5) * MINUTE_MS)!.ghiWm2
      expect(sum / 60).toBeCloseTo(hourEnd.ghiWm2, 6)
      checked++
    }
    expect(checked).toBeGreaterThan(1500)
  })

  it('interpolates state variables linearly and is exact at the hourly stamps', () => {
    const s = musaffah2025()
    const i = 1500
    const a = s.samples[i]
    const b = s.samples[i + 1]
    const exact = sampleAt(s.samples, a.t, MUSAFFAH)!
    expect(exact.taC).toBe(a.taC)
    expect(exact.rhPct).toBe(a.rhPct)
    expect(exact.wind10Ms).toBe(a.wind10Ms)
    const mid = sampleAt(s.samples, a.t + 30 * MINUTE_MS, MUSAFFAH)!
    expect(mid.taC).toBeCloseTo((a.taC + b.taC) / 2, 10)
    expect(mid.tdC!).toBeCloseTo((a.tdC! + b.tdC!) / 2, 10)
    expect(mid.pHpa).toBeCloseTo((a.pHpa + b.pHpa) / 2, 10)
    expect(mid.cloudPct!).toBeCloseTo((a.cloudPct! + b.cloudPct!) / 2, 10)
    expect(sampleAt(s.samples, s.samples[0].t - MINUTE_MS, MUSAFFAH)).toBeNull()
    expect(sampleAt(s.samples, s.samples[2927].t + MINUTE_MS, MUSAFFAH)).toBeNull()
  })

  it('evaluates solar geometry at t − 30 min for hourly samples and at t for instantaneous ones', () => {
    const s = musaffah2025()
    expect(solarGeometryTime(s.samples[10])).toBe(s.samples[10].t - 30 * MINUTE_MS)
    const inst = sampleAt(s.samples, s.samples[10].t + 7 * MINUTE_MS, MUSAFFAH)!
    expect(solarGeometryTime(inst)).toBe(inst.t)
  })
})

// ───────────────────────────── Conservative default ─────────────────────────────

describe('conservative default', () => {
  it('the hard-coded profile is reproduced from the cached 2020–2025 archive (provenance check)', () => {
    const files = SITE_IDS.flatMap((site) => YEARS.map((y) => readJson(`weather/archive/${site}_${y}.json`)))
    const derived = deriveConservativeProfile(files)
    let maxTempErr = 0
    for (const site of SITE_IDS) {
      const d = derived[site]!
      const p = CONSERVATIVE_PROFILE[site]
      expect(d.pHpa).toBeCloseTo(p.pHpa, 6)
      expect(d.ktClear).toBeCloseTo(p.ktClear, 6)
      for (let m = 0; m < 4; m++) {
        for (let h = 0; h < 24; h++) {
          maxTempErr = Math.max(maxTempErr, Math.abs(d.taC[m][h] - p.taC[m][h]), Math.abs(d.tdC[m][h] - p.tdC[m][h]))
        }
      }
    }
    expect(maxTempErr).toBeLessThan(1e-9)
  })

  it('the design temperature is a true 95th percentile: ~5 % of archive hours exceed it', () => {
    let above = 0
    let total = 0
    for (const site of SITE_IDS) {
      for (const y of YEARS) {
        for (const x of parseArchiveFile(readJson(`weather/archive/${site}_${y}.json`)).samples) {
          const { month, hour } = localParts(x.t)
          total++
          if (x.taC > CONSERVATIVE_PROFILE[site].taC[month - 6][hour]) above++
        }
      }
    }
    expect(above / total).toBeGreaterThan(0.03)
    expect(above / total).toBeLessThan(0.06)
  })

  it('assumes 0.5 m/s wind and clear-sky sun only while the sun is up, with Td ≤ Ta', () => {
    for (const site of SITE_IDS) {
      const noon = conservativeDefaultSample(site, local('2025-08-01T12:30'))
      expect(noon.source).toBe('conservative_default')
      expect(noon.wind10Ms).toBe(DEFAULT_WIND10_MS)
      expect(noon.ghiWm2).toBeGreaterThan(800)
      expect(noon.ghiWm2).toBeLessThan(1000)
      expect(noon.tdC!).toBeLessThanOrEqual(noon.taC)
      expect(noon.rhPct).toBeGreaterThan(0)
      expect(noon.rhPct).toBeLessThanOrEqual(100)
      const night = conservativeDefaultSample(site, local('2025-08-01T22:00'))
      expect(night.ghiWm2).toBe(0)
    }
  })

  it('interpolates between local hours and uses the summer envelope outside June–September', () => {
    const p = CONSERVATIVE_PROFILE.alain
    const half = conservativeDefaultSample('alain', local('2025-07-10T13:30'))
    expect(half.taC).toBeCloseTo((p.taC[1][13] + p.taC[1][14]) / 2, 10)
    const jan = conservativeDefaultSample('alain', local('2026-01-15T14:00'))
    expect(jan.taC).toBe(Math.max(p.taC[0][14], p.taC[1][14], p.taC[2][14], p.taC[3][14]))
    expect(jan.ghiWm2).toBeGreaterThan(0) // winter sun is lower: clear-sky uses the real solar geometry
    expect(jan.ghiWm2).toBeLessThan(half.ghiWm2)
  })
})

// ───────────────────────────── Fail-safe resolution ─────────────────────────────

describe('resolveEnvironment', () => {
  const now = local('2025-08-01T10:20')
  const archive = musaffah2025()
  const cached = parsePreviousRunsFile(readJson('weather/previous-runs/musaffah_2025.json'), 'ecmwf_ifs025', 1)
  const live = (ageMin: number): WeatherSeries => ({
    ...archive,
    source: 'forecast',
    model: 'ecmwf_ifs',
    obtainedAt: now - ageMin * MINUTE_MS,
  })

  it('follows the EnvSource priority: forecast → archive → cached forecast → conservative default', () => {
    expect(resolveEnvironment({ siteId: 'musaffah', now, liveForecast: live(30), archive, cachedForecast: cached }).source).toBe('forecast')
    expect(resolveEnvironment({ siteId: 'musaffah', now, archive, cachedForecast: cached }).source).toBe('archive')
    expect(resolveEnvironment({ siteId: 'musaffah', now, cachedForecast: cached }).source).toBe('cached_forecast')
    const none = resolveEnvironment({ siteId: 'musaffah', now })
    expect(none.source).toBe('conservative_default')
    expect(none.sample.source).toBe('conservative_default')
    expect(none.confidence).toBe('low')
    expect(none.stale).toBe(true)
    expect(none.ageMin).toBeNull()
    expect(none.wbgtMarginC).toBe(STALE_WBGT_MARGIN_C)
    expect(none.sample.wind10Ms).toBe(0.5)
    expect(none.drivers.some((d) => d.id === 'env_conservative_default' && d.direction === 'raises')).toBe(true)
    expect(none.drivers.find((d) => d.id === 'env_stale_margin')).toMatchObject({ direction: 'raises', value: 1 })
  })

  it('falls through a source that does not cover now (e.g. an expired forecast)', () => {
    const r = resolveEnvironment({ siteId: 'musaffah', now: local('2026-11-10T09:00'), liveForecast: live(30), archive })
    expect(r.source).toBe('conservative_default')
    expect(r.drivers.filter((d) => d.id === 'env_source_no_coverage')).toHaveLength(2)
  })

  it('returns the archive value interpolated to the minute, with the site radiant boost attached', () => {
    const r = resolveEnvironment({ siteId: 'musaffah', now, archive })
    const a = archive.samples.find((x) => x.t === local('2025-08-01T10:00'))!
    const b = archive.samples.find((x) => x.t === local('2025-08-01T11:00'))!
    expect(r.sample.t).toBe(now)
    expect(r.sample.taC).toBeCloseTo(a.taC + ((b.taC - a.taC) * 20) / 60, 10)
    expect(r.sample.radiantBoostC).toBe(MUSAFFAH.radiantBoostC)
    expect(r).toMatchObject({ ageMin: 0, stale: false, confidence: 'high', wbgtMarginC: 0 })
  })

  it('applies the staleness rules: ≥ 6 h lowers confidence, ≥ 24 h adds a 1 °C WBGT margin (boundaries protective)', () => {
    const at = (age: number) => resolveEnvironment({ siteId: 'musaffah', now, liveForecast: live(age) })
    expect(at(180)).toMatchObject({ stale: false, confidence: 'high', wbgtMarginC: 0, ageMin: 180 })
    expect(at(359)).toMatchObject({ stale: false, confidence: 'high', wbgtMarginC: 0 })
    expect(at(360)).toMatchObject({ stale: true, confidence: 'medium', wbgtMarginC: 0 })
    expect(at(420)).toMatchObject({ stale: true, confidence: 'medium', wbgtMarginC: 0 })
    expect(at(1440)).toMatchObject({ stale: true, confidence: 'low', wbgtMarginC: 1 })
    const old = at(25 * 60)
    expect(old).toMatchObject({ stale: true, confidence: 'low', wbgtMarginC: 1 })
    expect(old.drivers.map((d) => d.id)).toEqual(expect.arrayContaining(['env_data_stale', 'env_stale_margin']))
    expect(old.drivers.find((d) => d.id === 'env_stale_margin')).toMatchObject({ direction: 'raises', value: 1, unit: '°C' })
  })

  it('treats archived day-N forecasts as 24·N h old, and data of unknown age as ≥ 24 h', () => {
    const d1 = resolveEnvironment({ siteId: 'musaffah', now, cachedForecast: cached })
    expect(d1).toMatchObject({ ageMin: 1440, confidence: 'low', wbgtMarginC: 1 })
    const d0 = parsePreviousRunsFile(readJson('weather/previous-runs/musaffah_2025.json'), 'ecmwf_ifs025', 0)
    expect(resolveEnvironment({ siteId: 'musaffah', now, cachedForecast: d0 })).toMatchObject({ ageMin: 0, confidence: 'high', wbgtMarginC: 0 })
    const unknown: WeatherSeries = { ...cached, leadDays: undefined }
    expect(resolveEnvironment({ siteId: 'musaffah', now, cachedForecast: unknown })).toMatchObject({ ageMin: null, confidence: 'low', wbgtMarginC: 1, stale: true })
  })

  it('uses a fresh, plausible site sensor and fills its missing fields from the forecast', () => {
    const r = resolveEnvironment({ siteId: 'musaffah', now, liveForecast: live(60), sensor: { t: now - 5 * MINUTE_MS, measuredWbgtC: 33.4 } })
    expect(r.source).toBe('site_sensor')
    expect(r.sample.source).toBe('site_sensor')
    expect(r.sample.measuredWbgtC).toBe(33.4)
    expect(r).toMatchObject({ confidence: 'high', wbgtMarginC: 0, stale: false, ageMin: 5 })
    const model = resolveEnvironment({ siteId: 'musaffah', now, liveForecast: live(60) })
    expect(r.sample.taC).toBe(model.sample.taC)
  })

  it('pairs a sensor air temperature with the model dew point (physically consistent humidity)', () => {
    const model = resolveEnvironment({ siteId: 'musaffah', now, archive })
    const r = resolveEnvironment({ siteId: 'musaffah', now, archive, sensor: { t: now, taC: model.sample.taC + 2 } })
    expect(r.sample.taC).toBeCloseTo(model.sample.taC + 2, 10)
    expect(r.sample.tdC).toBeCloseTo(model.sample.tdC!, 10)
    expect(r.sample.rhPct).toBeLessThan(model.sample.rhPct) // warmer air at the same moisture → lower RH
  })

  it('ignores a stale or implausible sensor, falls back, and asks for a sensor check', () => {
    const stale = resolveEnvironment({ siteId: 'musaffah', now, liveForecast: live(60), sensor: { t: now - 30 * MINUTE_MS, measuredWbgtC: 25 } })
    expect(stale.source).toBe('forecast')
    expect(stale.sample.measuredWbgtC).toBeUndefined()
    expect(stale.drivers.find((d) => d.id === 'env_sensor_unavailable')).toMatchObject({ direction: 'raises', value: 30 })
    const broken = resolveEnvironment({ siteId: 'musaffah', now, liveForecast: live(60), sensor: { t: now, measuredWbgtC: 85 } })
    expect(broken.source).toBe('forecast')
    expect(broken.drivers.some((d) => d.id === 'env_sensor_unavailable')).toBe(true)
  })

  it('a sensor with only a WBGT reading and no model data keeps the conservative met fields (medium confidence)', () => {
    const r = resolveEnvironment({ siteId: 'musaffah', now, sensor: { t: now, measuredWbgtC: 31 } })
    expect(r.source).toBe('site_sensor')
    expect(r.confidence).toBe('medium')
    expect(r.wbgtMarginC).toBe(0) // the WBGT itself is measured
    expect(r.sample.wind10Ms).toBe(0.5)
    expect(r.drivers.some((d) => d.id === 'env_stale_margin')).toBe(false)
  })

  it('substitutes 0.5 m/s for unknown wind and clear sky for unknown solar', () => {
    const broken: EnvSample[] = archive.samples.map((x) => ({ ...x, wind10Ms: Number.NaN, ghiWm2: Number.NaN, directWm2: undefined, diffuseWm2: undefined, dniWm2: undefined }))
    const r = resolveEnvironment({ siteId: 'musaffah', now, archive: { ...archive, samples: broken } })
    expect(r.sample.wind10Ms).toBe(DEFAULT_WIND10_MS)
    expect(r.sample.ghiWm2).toBeGreaterThan(400)
    expect(r.drivers.map((d) => d.id)).toEqual(expect.arrayContaining(['env_wind_default', 'env_solar_clear_sky']))
  })

  it('ignores series for another site', () => {
    const kezad = parseArchiveFile(readJson('weather/archive/kezad_2025.json'))
    const r = resolveEnvironment({ siteId: 'musaffah', now, archive: kezad })
    expect(r.source).toBe('conservative_default')
    expect(r.drivers.some((d) => d.id === 'env_series_wrong_site')).toBe(true)
  })

  it('never reports sun at night from any source', () => {
    for (const t of [local('2025-08-01T21:30'), local('2025-08-02T03:00')]) {
      expect(resolveEnvironment({ siteId: 'musaffah', now: t, archive }).sample.ghiWm2).toBe(0)
      expect(resolveEnvironment({ siteId: 'musaffah', now: t }).sample.ghiWm2).toBe(0)
    }
  })

  it('labels forecast values beyond a 7-day lead as low confidence', () => {
    const f = live(10)
    expect(forecastConfidence(f, now + 2 * DAY_MS, now)).toBe('high')
    expect(forecastConfidence(f, now + 8 * DAY_MS, now)).toBe('low')
  })
})

// ───────────────────────────── Live forecast ─────────────────────────────

/** A canned Open-Meteo response built from a real demo day (local timestamps, timezone=Asia/Dubai). */
function cannedForecast(date = '2026-11-10', windUnit = 'm/s'): Record<string, unknown> {
  const day = parseDemoDays(readJson('weather/demo-days.json'))[0].analysis.samples
  const time = day.map((_, h) => `${date}T${String(h).padStart(2, '0')}:00`)
  const col = (f: (x: EnvSample) => number | undefined) => day.map((x) => f(x) ?? null)
  return {
    latitude: 24.358522,
    longitude: 54.498936,
    elevation: 6,
    utc_offset_seconds: 14400,
    timezone: 'Asia/Dubai',
    hourly_units: { temperature_2m: '°C', wind_speed_10m: windUnit },
    hourly: {
      time,
      temperature_2m: col((x) => x.taC),
      relative_humidity_2m: col((x) => x.rhPct),
      dew_point_2m: col((x) => x.tdC),
      surface_pressure: col((x) => x.pHpa),
      wind_speed_10m: col((x) => (windUnit === 'km/h' ? x.wind10Ms * 3.6 : x.wind10Ms)),
      shortwave_radiation: col((x) => x.ghiWm2),
      direct_radiation: col((x) => x.directWm2),
      diffuse_radiation: col((x) => x.diffuseWm2),
      direct_normal_irradiance: col((x) => x.dniWm2),
      cloud_cover: col((x) => x.cloudPct),
    },
  }
}

const respond = (body: unknown, status = 200): ReturnType<FetchLike> =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body })

describe('live forecast fetcher', () => {
  it('builds the verified request: ecmwf_ifs, Asia/Dubai, m/s, the 10 WBGT variables, forecast_days ≤ 16', () => {
    const url = new URL(buildForecastUrl(MUSAFFAH, 7))
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(url.searchParams.get('models')).toBe('ecmwf_ifs')
    expect(url.searchParams.get('timezone')).toBe('Asia/Dubai')
    expect(url.searchParams.get('wind_speed_unit')).toBe('ms')
    expect(url.searchParams.get('cell_selection')).toBe('land')
    expect(url.searchParams.get('hourly')!.split(',')).toEqual([...WBGT_VARIABLES])
    expect(url.searchParams.get('hourly')).not.toContain('wind_speed_2m')
    expect(url.searchParams.get('hourly')).not.toContain('best_match')
    expect(new URL(buildForecastUrl(MUSAFFAH, 30)).searchParams.get('forecast_days')).toBe('16')
    expect(new URL(buildForecastUrl(MUSAFFAH, 0)).searchParams.get('forecast_days')).toBe('1')
  })

  it('fetches and parses a forecast, converting local timestamps to UTC epochs', async () => {
    const calls: string[] = []
    const fetch: FetchLike = (url) => {
      calls.push(url)
      return respond(cannedForecast())
    }
    const nowMs = local('2026-11-10T08:00')
    const f = await fetchLiveForecast({ site: MUSAFFAH, now: nowMs, fetch })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('latitude=24.35&longitude=54.5')
    expect(f).toMatchObject({ locationId: 'musaffah', source: 'forecast', model: 'ecmwf_ifs', obtainedAt: nowMs, droppedHours: 0 })
    expect(f.samples).toHaveLength(24)
    expect(f.samples[0].t).toBe(local('2026-11-10T00:00'))
    expect(f.samples[12].taC).toBe(45) // musaffah 2025-08-01 peaked at 12:00 local
    expect(f.grid?.lat).toBe(24.358522)
    const r = resolveEnvironment({ siteId: 'musaffah', now: nowMs + 30 * MINUTE_MS, liveForecast: f })
    expect(r).toMatchObject({ source: 'forecast', confidence: 'high', ageMin: 30 })
  })

  it('converts km/h wind and drops hours with nulls past the model horizon', () => {
    const body = cannedForecast('2026-11-10', 'km/h')
    ;(body.hourly as Record<string, (number | null)[]>).temperature_2m[23] = null
    const f = parseForecastResponse(body, 'musaffah', 0)
    const day = parseDemoDays(readJson('weather/demo-days.json'))[0].analysis.samples
    expect(f.samples[5].wind10Ms).toBeCloseTo(day[5].wind10Ms, 10)
    expect(f.samples).toHaveLength(23)
    expect(f.droppedHours).toBe(1)
  })

  it('rejects API errors, HTTP errors and timeouts with a typed WeatherDataError', async () => {
    await expect(fetchLiveForecast({ site: MUSAFFAH, fetch: () => respond({ error: true, reason: 'Forecast days is invalid.' }) })).rejects.toMatchObject({ kind: 'api' })
    await expect(fetchLiveForecast({ site: MUSAFFAH, fetch: () => respond(null, 503) })).rejects.toMatchObject({ kind: 'http' })
    let seenSignal: AbortSignal | undefined
    const hang: FetchLike = (_url, init) => {
      seenSignal = init?.signal
      return new Promise(() => undefined)
    }
    const t0 = Date.now()
    await expect(fetchLiveForecast({ site: MUSAFFAH, fetch: hang, timeoutMs: 30 })).rejects.toMatchObject({ kind: 'timeout' })
    expect(Date.now() - t0).toBeLessThan(2000)
    expect(seenSignal?.aborted).toBe(true)
  })
})

// ───────────────────────────── Loader ─────────────────────────────

describe('cached-file loader', () => {
  const fileFetch = (log: string[]): FetchLike => (url) => {
    log.push(url)
    expect(url.startsWith('./data/')).toBe(true)
    try {
      const text = readFileSync(new URL(url.slice('./data/'.length), DATA), 'utf8')
      return respond(JSON.parse(text))
    } catch {
      return respond(null, 404)
    }
  }

  it('loads cached files relative to the page and memoises raw files', async () => {
    const log: string[] = []
    const loader = createWeatherLoader({ fetch: fileFetch(log) })
    const a = await loader.archive('saadiyat', 2024)
    expect(a.samples).toHaveLength(2928)
    const era5 = await loader.archive('saadiyat', 2024, 'era5')
    expect(era5.model).toBe('era5')
    expect(log.filter((u) => u.endsWith('saadiyat_2024.json'))).toHaveLength(1)
    expect(await loader.demoDays()).toHaveLength(7)
    expect((await loader.metar('OMAL')).observations.length).toBeGreaterThan(2900)
    expect((await loader.previousRuns('alain', 2024, 'dwd_icon_seamless', 2)).leadDays).toBe(2)
    expect((await loader.manifest()).schema).toBe('zill.weather.manifest/v1')
  })

  it('finds the file covering a time and returns null when nothing is cached', async () => {
    const loader = createWeatherLoader({ fetch: fileFetch([]) })
    expect(archivePeriodFor('musaffah', local('2025-11-26T12:00'))).toBe('2025-11')
    expect(archivePeriodFor('kezad', local('2025-11-26T12:00'))).toBeNull()
    expect((await loader.archiveFor('musaffah', local('2025-11-26T12:00')))?.samples).toHaveLength(720)
    expect(await loader.archiveFor('alain', local('2026-01-10T12:00'))).toBeNull()
  })

  it('rejects missing files with an HTTP WeatherDataError and does not cache the failure', async () => {
    const log: string[] = []
    const loader = createWeatherLoader({ fetch: fileFetch(log) })
    await expect(loader.archive('musaffah', 2019)).rejects.toMatchObject({ kind: 'http' })
    await expect(loader.archive('musaffah', 2019)).rejects.toBeInstanceOf(WeatherDataError)
    expect(log.filter((u) => u.endsWith('musaffah_2019.json'))).toHaveLength(2)
  })
})

describe('sites', () => {
  it('match the coordinates used for the cached data', () => {
    for (const site of SITE_IDS) {
      const raw = readJson(`weather/archive/${site}_2025.json`) as { site: { lat: number; lon: number } }
      const s = getSite(site as SiteId)
      expect([s.lat, s.lon]).toEqual([raw.site.lat, raw.site.lon])
      expect(s.radiantBoostC).toBeGreaterThanOrEqual(0)
      expect(s.radiantBoostC).toBeLessThanOrEqual(2)
    }
  })
})
