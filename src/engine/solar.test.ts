import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  julianDayFromEpochMs,
  solarPosition,
  solarPositionFromJulianDay,
  toaHorizontalWm2,
  SOLAR_CONSTANT_WM2,
  hourMeanSolarPosition,
  daylightMeanSinElevation,
} from './solar'

interface SolarCase {
  site: string
  lat: number
  lon: number
  time_utc: string
  julian_day: number
  noaa: {
    declination_deg: number
    eot_min: number
    hour_angle_deg: number
    zenith_deg: number
    refraction_deg: number
    apparent_zenith_deg: number
    cos_zenith: number
    cos_apparent_zenith: number
    earth_sun_au: number
  }
  pvlib_spa: { zenith_deg: number; apparent_zenith_deg: number }
}
interface FullCase {
  id: string
  inputs: { lat: number; lon: number; time_end_utc: string; avg_minutes: number }
  derived: {
    time_eval_utc: string
    julian_day: number
    zenith_deg: number
    apparent_zenith_deg: number
    cos_zenith: number
    earth_sun_au: number
    cos_zenith_sunlit_mean_info: number
    sunlit_fraction_info: number
  }
}
interface Fixture {
  solar_cases: SolarCase[]
  full_cases: FullCase[]
  sanity_checks: { solar_vs_spa: { noaa_vs_spa_max_abs_zenith_deg: number } }
}

const fx = JSON.parse(readFileSync(new URL('../../fixtures/wbgt_liljegren.json', import.meta.url), 'utf8')) as Fixture

/** Spec acceptance (wbgt_liljegren.md §10.3, §16): NOAA port within 1e-9 of the oracle; ≤ 0.03° and 5e-4 cos z vs SPA. */
const NOAA_TOL = 1e-9
const SPA_ZENITH_TOL_DEG = 0.03
const SPA_COS_TOL = 5e-4
const cosd = (deg: number) => Math.cos((deg * Math.PI) / 180)

/**
 * Extra NREL SPA reference points computed once with pvlib 0.16.1 (`get_solarposition(..., altitude=0, pressure=101325,
 * temperature=15, method="nrel_numpy")`) for the Zill sites, covering low sun, sunrise/sunset and another year.
 */
const PVLIB_SPA_POINTS = [
  { site: 'ruwais', lat: 24.11, lon: 52.73, utc: '2025-08-15T06:30Z', zen: 30.838476, app: 30.828534 },
  { site: 'ruwais', lat: 24.11, lon: 52.73, utc: '2025-08-15T14:10Z', zen: 79.135147, app: 79.052846 },
  { site: 'al_ain', lat: 24.2075, lon: 55.7447, utc: '2025-06-21T01:50Z', zen: 86.661842, app: 86.451594 },
  { site: 'al_ain', lat: 24.2075, lon: 55.7447, utc: '2026-02-10T11:15Z', zen: 55.491328, app: 55.467187 },
  { site: 'madinat_zayed', lat: 23.6833, lon: 53.7, utc: '2026-07-01T09:00Z', zen: 7.121249, app: 7.11919 },
  { site: 'abu_dhabi_city', lat: 24.4539, lon: 54.3773, utc: '2025-11-05T13:40Z', zen: 90.784146, app: 90.183008 },
  { site: 'abu_dhabi_city', lat: 24.4539, lon: 54.3773, utc: '2025-04-01T02:15Z', zen: 90.684404, app: 90.100135 },
  { site: 'liwa', lat: 23.13, lon: 53.77, utc: '2025-12-21T03:30Z', zen: 85.001269, app: 84.842292 },
]

describe('NOAA solar position port (wbgt_liljegren.md §10.2)', () => {
  it('Julian Day from epoch ms', () => {
    expect(julianDayFromEpochMs(Date.parse('2000-01-01T12:00Z'))).toBe(2451545)
    for (const c of fx.solar_cases) {
      expect(julianDayFromEpochMs(Date.parse(c.time_utc))).toBeCloseTo(c.julian_day, 6)
    }
  })

  it('matches every oracle field of the 12 fixture solar cases within 1e-9', () => {
    let worst = 0
    for (const c of fx.solar_cases) {
      const s = solarPosition(Date.parse(c.time_utc), c.lat, c.lon)
      const pairs: [number, number][] = [
        [s.declinationDeg, c.noaa.declination_deg],
        [s.eqOfTimeMin, c.noaa.eot_min],
        [s.hourAngleDeg, c.noaa.hour_angle_deg],
        [s.zenithDeg, c.noaa.zenith_deg],
        [s.refractionDeg, c.noaa.refraction_deg],
        [s.apparentZenithDeg, c.noaa.apparent_zenith_deg],
        [s.cosZenith, c.noaa.cos_zenith],
        [s.cosApparentZenith, c.noaa.cos_apparent_zenith],
        [s.earthSunAu, c.noaa.earth_sun_au],
      ]
      for (const [mine, ref] of pairs) worst = Math.max(worst, Math.abs(mine - ref))
    }
    expect(worst).toBeLessThanOrEqual(NOAA_TOL)
  })

  it('southern-hemisphere, western-longitude and polar-day checks keep their signs (Sydney, Phoenix, Tromsø)', () => {
    for (const site of ['sydney_check', 'phoenix_check', 'tromso_check']) {
      const c = fx.solar_cases.find((x) => x.site === site) as SolarCase
      const s = solarPosition(Date.parse(c.time_utc), c.lat, c.lon)
      expect(Math.sign(s.declinationDeg)).toBe(Math.sign(c.noaa.declination_deg))
      expect(s.hourAngleDeg).toBeCloseTo(c.noaa.hour_angle_deg, 8)
      expect(s.apparentZenithDeg).toBeCloseTo(c.noaa.apparent_zenith_deg, 8)
    }
  })

  it('agrees with NREL SPA (pvlib) within 0.03° zenith and 5e-4 cos z on the fixture points', () => {
    for (const c of fx.solar_cases) {
      const s = solarPosition(Date.parse(c.time_utc), c.lat, c.lon)
      expect(Math.abs(s.zenithDeg - c.pvlib_spa.zenith_deg)).toBeLessThanOrEqual(SPA_ZENITH_TOL_DEG)
      expect(Math.abs(s.cosZenith - cosd(c.pvlib_spa.zenith_deg))).toBeLessThanOrEqual(SPA_COS_TOL)
      if (90 - c.pvlib_spa.apparent_zenith_deg > 5) {
        expect(Math.abs(s.apparentZenithDeg - c.pvlib_spa.apparent_zenith_deg)).toBeLessThanOrEqual(SPA_ZENITH_TOL_DEG)
      }
    }
  })

  it('agrees with NREL SPA (pvlib) on extra hard-coded points at the Zill sites', () => {
    let worstZen = 0
    for (const p of PVLIB_SPA_POINTS) {
      const s = solarPosition(Date.parse(p.utc), p.lat, p.lon)
      worstZen = Math.max(worstZen, Math.abs(s.zenithDeg - p.zen))
      expect(Math.abs(s.zenithDeg - p.zen)).toBeLessThanOrEqual(SPA_ZENITH_TOL_DEG)
      expect(Math.abs(s.cosZenith - cosd(p.zen))).toBeLessThanOrEqual(SPA_COS_TOL)
      if (90 - p.app > 5) expect(Math.abs(s.apparentZenithDeg - p.app)).toBeLessThanOrEqual(SPA_ZENITH_TOL_DEG)
    }
    // The oracle's year-long Abu Dhabi statistic is 0.0159°; spot points must not exceed the acceptance either.
    expect(worstZen).toBeLessThanOrEqual(Math.max(fx.sanity_checks.solar_vs_spa.noaa_vs_spa_max_abs_zenith_deg, 0.02))
  })

  it('refraction is added to the elevation, so the apparent zenith is smaller near the horizon', () => {
    const s = solarPosition(Date.parse('2025-07-15T01:45Z'), 24.4539, 54.3773)
    expect(s.refractionDeg).toBeGreaterThan(0.2)
    expect(s.apparentZenithDeg).toBeLessThan(s.zenithDeg)
    expect(s.apparentElevationDeg).toBeCloseTo(90 - s.apparentZenithDeg, 12)
    expect(s.cosApparentZenith).toBeCloseTo(Math.sin((s.apparentElevationDeg * Math.PI) / 180), 12)
  })

  it('solarPositionFromJulianDay is the same computation', () => {
    const t = Date.parse('2025-06-21T08:20Z')
    expect(solarPositionFromJulianDay(julianDayFromEpochMs(t), 24.4539, 54.3773)).toEqual(solarPosition(t, 24.4539, 54.3773))
  })
})

describe('top-of-atmosphere irradiance', () => {
  it('TOA = 1367·max(cos z, 0)/R²', () => {
    expect(SOLAR_CONSTANT_WM2).toBe(1367)
    expect(toaHorizontalWm2(1, 1)).toBe(1367)
    expect(toaHorizontalWm2(0.5, 1.0164)).toBeCloseTo(683.5 / 1.0164 ** 2, 9)
    expect(toaHorizontalWm2(-0.2, 1)).toBe(0)
  })
})

describe('hour-mean radiation geometry (D5, §13.3)', () => {
  it('evaluates at t_end − 30 min and reproduces every full-case derived geometry', () => {
    for (const c of fx.full_cases) {
      const tEnd = Date.parse(c.inputs.time_end_utc)
      const g = hourMeanSolarPosition(tEnd, c.inputs.lat, c.inputs.lon, c.inputs.avg_minutes)
      expect(g.tEvalMs).toBe(Date.parse(c.derived.time_eval_utc))
      expect(g.julianDay).toBeCloseTo(c.derived.julian_day, 6)
      expect(Math.abs(g.cosApparentZenith - c.derived.cos_zenith)).toBeLessThanOrEqual(NOAA_TOL)
      expect(Math.abs(g.zenithDeg - c.derived.zenith_deg)).toBeLessThanOrEqual(NOAA_TOL)
      expect(Math.abs(g.apparentZenithDeg - c.derived.apparent_zenith_deg)).toBeLessThanOrEqual(NOAA_TOL)
      expect(Math.abs(g.earthSunAu - c.derived.earth_sun_au)).toBeLessThanOrEqual(NOAA_TOL)
    }
  })

  it('avgMin = 0 is the instantaneous geometry', () => {
    const t = Date.parse('2025-07-15T09:00Z')
    expect(hourMeanSolarPosition(t, 24.4539, 54.3773, 0).cosApparentZenith).toBe(solarPosition(t, 24.4539, 54.3773).cosApparentZenith)
  })
})

describe('daylight-mean sin(elevation) over an interval', () => {
  it('reproduces the oracle sunlit-mean cos z and sunlit fraction for every full case', () => {
    for (const c of fx.full_cases) {
      const tEnd = Date.parse(c.inputs.time_end_utc)
      const m = daylightMeanSinElevation(tEnd - 3_600_000, tEnd, c.inputs.lat, c.inputs.lon, 60)
      expect(Math.abs(m.sunlitMeanSinElevation - c.derived.cos_zenith_sunlit_mean_info)).toBeLessThanOrEqual(NOAA_TOL)
      expect(Math.abs(m.sunlitFraction - c.derived.sunlit_fraction_info)).toBeLessThanOrEqual(NOAA_TOL)
      expect(m.intervalMeanSinElevation).toBeCloseTo(m.sunlitMeanSinElevation * m.sunlitFraction, 15)
    }
  })

  it('the sunrise hour is partly lit and the night is unlit', () => {
    const sunrise = daylightMeanSinElevation(Date.parse('2025-07-15T01:00Z'), Date.parse('2025-07-15T02:00Z'), 24.4539, 54.3773)
    expect(sunrise.sunlitFraction).toBeGreaterThan(0)
    expect(sunrise.sunlitFraction).toBeLessThan(1)
    const night = daylightMeanSinElevation(Date.parse('2025-07-15T19:00Z'), Date.parse('2025-07-15T20:00Z'), 24.4539, 54.3773)
    expect(night).toEqual({ sunlitMeanSinElevation: 0, sunlitFraction: 0, intervalMeanSinElevation: 0 })
  })
})
