import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { HUMAN_MRT, SITE_HEAT_DEFAULTS, SITE_HEAT_DRIVER_IDS, computeSiteHeat, humanMrtC } from './indices'
import type { HumanMrtInput } from './indices'
import { wbgtComponents } from './wbgt'
import { computeTwl, psychrometricWetBulbC, vapourPressureFromRhKpa } from './twl'
import { heatIndexNwsC } from './limits'
import { epochFromLocal } from './time'
import type { EnvSample, Site } from './types'
import { getSite } from '../data/sites'
import { parseDemoDays, sampleAt } from '../data/weather'

// ─────────────────────────────── Fixtures ───────────────────────────────

interface MrtCase {
  id: string
  inputs: { ta_c: number; rh_pct: number; ghi_wm2: number; fdir: number; cos_zenith: number; ground_temp_c?: number; albedo?: number }
  intermediates: { fdir_used: number; emis_atm: number; dni_wm2: number; fp: number }
  outputs: { mrt_c: number }
}
const MRT_FIXTURE = JSON.parse(readFileSync(new URL('../../fixtures/mrt_human.json', import.meta.url), 'utf8')) as {
  meta: { tolerance_c: number }
  cases: MrtCase[]
}
const toInput = (c: MrtCase): HumanMrtInput => ({
  taC: c.inputs.ta_c,
  rhPct: c.inputs.rh_pct,
  ghiWm2: c.inputs.ghi_wm2,
  fdir: c.inputs.fdir,
  cosZenith: c.inputs.cos_zenith,
  ...(c.inputs.ground_temp_c !== undefined ? { groundTempC: c.inputs.ground_temp_c } : {}),
  ...(c.inputs.albedo !== undefined ? { albedo: c.inputs.albedo } : {}),
})

const DEMO = parseDemoDays(JSON.parse(readFileSync(new URL('../../public/data/weather/demo-days.json', import.meta.url), 'utf8')))
const MUSAFFAH = getSite('musaffah')
const AUG1 = DEMO.find((d) => d.id === 'musaffah_2025-08-01')!
const NOV26 = DEMO.find((d) => d.id === 'musaffah_2025-11-26')!

const NOON_AUG = epochFromLocal('2025-08-01T12:30')
const baseEnv = (over: Partial<EnvSample> = {}): EnvSample => ({
  t: NOON_AUG,
  taC: 44,
  rhPct: 20,
  pHpa: 1000,
  wind10Ms: 2,
  ghiWm2: 900,
  radiationWindowMin: 0,
  radiantBoostC: 0,
  source: 'archive',
  ...over,
})
const SITE_NO_BOOST: Site = { ...MUSAFFAH, radiantBoostC: 0 }

// ─────────────────────────────── humanMrtC ───────────────────────────────

describe('humanMrtC — thermofeel oracle (fixtures/mrt_human.json)', () => {
  it('has the expected number of oracle cases', () => {
    expect(MRT_FIXTURE.cases.length).toBeGreaterThanOrEqual(15)
  })
  for (const c of MRT_FIXTURE.cases) {
    it(`${c.id}: matches thermofeel within 1e-6 °C`, () => {
      expect(Math.abs(humanMrtC(toInput(c)) - c.outputs.mrt_c)).toBeLessThan(MRT_FIXTURE.meta.tolerance_c)
    })
  }
})

describe('humanMrtC — physics', () => {
  const sun: HumanMrtInput = { taC: 44, rhPct: 20, ghiWm2: 950, fdir: 0.85, cosZenith: 0.95 }

  it('≈ 70–80 °C at 44 °C / 950 W/m² (phs_iso7933.md §10.3: 74.07 °C), well below the black-globe MRT (≈ 94 °C)', () => {
    const mrt = humanMrtC(sun)
    expect(mrt).toBeGreaterThan(70)
    expect(mrt).toBeLessThan(80)
    expect(mrt).toBeCloseTo(74.07, 1)
  })

  it('sun > engineered shade ≥ Ta', () => {
    const s = humanMrtC(sun)
    const sh = humanMrtC({ ...sun, shade: true })
    expect(s).toBeGreaterThan(sh)
    expect(sh).toBeGreaterThanOrEqual(sun.taC)
  })

  it('engineered shade drops direct and sky shortwave but keeps reflected ground shortwave [ENG]', () => {
    const shade = humanMrtC({ ...sun, shade: true })
    const noShortwave = humanMrtC({ ...sun, ghiWm2: 0 })
    const brightGround = humanMrtC({ ...sun, shade: true, albedo: 0.6 })
    expect(shade).toBeGreaterThan(Math.max(noShortwave, sun.taC) - 1e-9)
    expect(brightGround).toBeGreaterThan(shade)
  })

  it('rises monotonically with GHI', () => {
    let prev = -Infinity
    for (let g = 0; g <= 1100; g += 50) {
      const m = humanMrtC({ ...sun, ghiWm2: g })
      expect(m).toBeGreaterThan(prev)
      prev = m
    }
  })

  it('clear night: MRT below air temperature (cold sky); humid night closer to Ta', () => {
    const dry = humanMrtC({ taC: 33, rhPct: 30, ghiWm2: 0, fdir: 0, cosZenith: -0.4 })
    const humid = humanMrtC({ taC: 33, rhPct: 90, ghiWm2: 0, fdir: 0, cosZenith: -0.4 })
    expect(dry).toBeLessThan(33)
    expect(humid).toBeLessThan(33)
    expect(humid).toBeGreaterThan(dry)
  })

  it('low-sun guard: no direct beam below cos z = 0.00873 (DNI would blow up)', () => {
    const guarded = humanMrtC({ taC: 32, rhPct: 50, ghiWm2: 5, fdir: 0.5, cosZenith: 0.005 })
    const diffuseOnly = humanMrtC({ taC: 32, rhPct: 50, ghiWm2: 5, fdir: 0, cosZenith: 0.005 })
    expect(guarded).toBeCloseTo(diffuseOnly, 12)
    expect(guarded).toBeLessThan(40)
  })

  it('hot ground raises the MRT; fdir is clamped to 0.9', () => {
    expect(humanMrtC({ ...sun, groundTempC: 60 })).toBeGreaterThan(humanMrtC(sun))
    expect(humanMrtC({ ...sun, fdir: 0.99 })).toBeCloseTo(humanMrtC({ ...sun, fdir: 0.9 }), 12)
  })

  it('constants: absorptivity 0.7, emissivity 0.97, Liljegren albedo 0.45 by default', () => {
    expect(HUMAN_MRT.SHORTWAVE_ABSORPTIVITY).toBe(0.7)
    expect(HUMAN_MRT.LONGWAVE_EMISSIVITY).toBe(0.97)
    expect(HUMAN_MRT.DEFAULT_ALBEDO).toBe(0.45)
    expect(humanMrtC({ ...sun, albedo: 0.45 })).toBe(humanMrtC(sun))
  })

  it('throws RangeError on non-finite inputs', () => {
    expect(() => humanMrtC({ ...sun, taC: Number.NaN })).toThrow(RangeError)
    expect(() => humanMrtC({ ...sun, ghiWm2: Number.POSITIVE_INFINITY })).toThrow(RangeError)
  })
})

// ─────────────────────────────── computeSiteHeat ───────────────────────────────

describe('computeSiteHeat — mapping and integration', () => {
  const env = baseEnv()
  const h = computeSiteHeat(env, SITE_NO_BOOST)
  const c = wbgtComponents(env, SITE_NO_BOOST.lat, SITE_NO_BOOST.lon, { engineeredShade: true })

  it('maps the Liljegren components onto HeatIndices', () => {
    expect(h.t).toBe(env.t)
    expect(h.source).toBe('archive')
    expect(h.wbgtC).toBe(c.wbgtC)
    expect(h.wbgtShadeC).toBe(c.wbgtShadeC)
    expect(h.tgC).toBe(c.tgC)
    expect(h.tnwbC).toBe(c.tnwbC)
    expect(h.tpwbC).toBe(c.tpwbC)
    expect(h.wind2Ms).toBe(c.wind2Ms)
    expect(h.cosZenith).toBe(c.cosZenith)
    expect(h.mrtGlobeC).toBe(c.mrtC)
    expect(h.mrtGlobeShadeC).toBe(c.mrtShadeC)
    expect(h.components.engineeredShade).toBe(true)
  })

  it('HeatIndices.mrtC is the HUMAN MRT in sun (PHS input), below the globe MRT', () => {
    const expected = humanMrtC({ taC: c.taC, rhPct: c.rhPct, ghiWm2: c.ghiUsedWm2, fdir: c.fdir, cosZenith: c.cosZenith })
    expect(h.mrtC).toBeCloseTo(expected, 12)
    expect(h.mrtC).toBeLessThan(h.mrtGlobeC)
    expect(h.mrtC).toBeGreaterThan(60)
    expect(h.mrtHumanShadeC).toBeGreaterThanOrEqual(h.taC)
    expect(h.mrtHumanShadeC).toBeLessThan(h.mrtC)
  })

  it('TWL uses a TWL-consistent psychrometric wet bulb, the globe-field MRT, the 2 m wind and p = hPa/10', () => {
    const pKpa = c.pHpa / 10
    const twb = psychrometricWetBulbC(c.taC, vapourPressureFromRhKpa(c.taC, c.rhPct), pKpa)
    expect(h.twbPsychrometricC).toBeCloseTo(twb, 12)
    expect(h.twlWm2).toBe(computeTwl({ tdbC: c.taC, twbPsychrometricC: twb, mrtC: c.mrtC, windMs: c.wind2Ms, pKpa }).twlWm2)
    expect(h.twlShadeWm2).toBe(computeTwl({ tdbC: c.taC, twbPsychrometricC: twb, mrtC: c.mrtShadeC, windMs: c.wind2Ms, pKpa }).twlWm2)
    expect(h.twlShadeWm2).toBeGreaterThan(h.twlWm2)
    // Same humidity as giving TWL the RH directly (the Liljegren psychrometric wet bulb would not be).
    expect(h.twlWm2).toBeCloseTo(computeTwl({ tdbC: c.taC, rhPct: c.rhPct, mrtC: c.mrtC, windMs: c.wind2Ms, pKpa }).twlWm2, 6)
  })

  it('heat index = NWS heat index of the air', () => {
    expect(h.heatIndexC).toBe(heatIndexNwsC(c.taC, c.rhPct))
  })

  it('B&B 2002 backstop is advisory (info driver) when DB > 44 °C', () => {
    const hot = computeSiteHeat(baseEnv({ taC: 46 }), SITE_NO_BOOST)
    expect(hot.backstop.triggered).toBe(true)
    const d = hot.drivers.find((x) => x.id === 'bb2002_backstop')
    expect(d?.direction).toBe('info')
    expect(computeSiteHeat(baseEnv({ taC: 40 }), SITE_NO_BOOST).backstop.triggered).toBe(false)
  })

  it('emits only documented driver ids, all on the environment channel', () => {
    const cases = [
      computeSiteHeat(baseEnv({ taC: 46, measuredWbgtC: 30 }), MUSAFFAH),
      computeSiteHeat({ ...baseEnv(), wind10Ms: Number.NaN, ghiWm2: Number.NaN, radiantBoostC: undefined }, MUSAFFAH),
    ]
    for (const hh of cases) {
      for (const d of hh.drivers) {
        expect(SITE_HEAT_DRIVER_IDS as readonly string[]).toContain(d.id)
        expect(d.channel).toBe('environment')
        expect(d.basis.length).toBeGreaterThan(5)
      }
    }
  })
})

describe('computeSiteHeat — fail-safe defaults', () => {
  it('missing wind → 0.5 m/s with a raises driver (then the Liljegren 0.62 m/s floor)', () => {
    const missing = computeSiteHeat({ ...baseEnv(), wind10Ms: Number.NaN }, SITE_NO_BOOST)
    const half = computeSiteHeat(baseEnv({ wind10Ms: SITE_HEAT_DEFAULTS.windUnknown10Ms }), SITE_NO_BOOST)
    expect(missing.wbgtC).toBe(half.wbgtC)
    expect(missing.twlWm2).toBe(half.twlWm2)
    const d = missing.drivers.find((x) => x.id === 'env_wind_default')
    expect(d?.direction).toBe('raises')
    expect(half.drivers.some((x) => x.id === 'env_wind_default')).toBe(false)
    // The default is protective for WBGT and TWL compared with a breezy measurement.
    const breezy = computeSiteHeat(baseEnv({ wind10Ms: 4 }), SITE_NO_BOOST)
    expect(missing.wbgtC).toBeGreaterThan(breezy.wbgtC)
    expect(missing.twlWm2).toBeLessThan(breezy.twlWm2)
  })

  it('missing GHI → clear-sky estimate with a raises driver; never below a cloudy measured value', () => {
    const missing = computeSiteHeat({ ...baseEnv(), ghiWm2: Number.NaN }, SITE_NO_BOOST)
    expect(missing.drivers.find((x) => x.id === 'env_solar_clear_sky')?.direction).toBe('raises')
    const cloudy = computeSiteHeat(baseEnv({ ghiWm2: 300 }), SITE_NO_BOOST)
    expect(missing.wbgtC).toBeGreaterThan(cloudy.wbgtC)
    expect(missing.mrtC).toBeGreaterThan(cloudy.mrtC)
  })

  it('missing air temperature has no safe default: throws (the data layer supplies its conservative sample)', () => {
    expect(() => computeSiteHeat({ ...baseEnv(), taC: Number.NaN }, SITE_NO_BOOST)).toThrow(RangeError)
  })

  it('a sample without radiantBoostC takes the site allowance (protective), an explicit 0 does not', () => {
    const withSite = computeSiteHeat({ ...baseEnv(), radiantBoostC: undefined }, MUSAFFAH)
    const none = computeSiteHeat(baseEnv({ radiantBoostC: 0 }), MUSAFFAH)
    expect(withSite.components.radiantBoostC).toBe(MUSAFFAH.radiantBoostC)
    expect(withSite.drivers.some((d) => d.id === 'env_radiant_boost_site_default')).toBe(true)
    expect(none.components.radiantBoostC).toBe(0)
    expect(withSite.wbgtC).toBeGreaterThan(none.wbgtC)
    // The boost's long-wave load reaches the human MRT too (sun and shade).
    expect(withSite.mrtC).toBeGreaterThan(none.mrtC)
    expect(withSite.mrtHumanShadeC).toBeGreaterThan(none.mrtHumanShadeC)
  })
})

describe('computeSiteHeat — meter, shade and radiation window', () => {
  it('a site meter becomes the exposure WBGT; shade stays modelled; large mismatch → check-meter driver', () => {
    const model = computeSiteHeat(baseEnv(), SITE_NO_BOOST)
    const metered = computeSiteHeat(baseEnv({ measuredWbgtC: model.wbgtC + 0.5 }), SITE_NO_BOOST)
    expect(metered.measured).toBe(true)
    expect(metered.wbgtC).toBe(model.wbgtC + 0.5)
    expect(metered.wbgtShadeC).toBe(model.wbgtShadeC)
    expect(metered.measuredMinusModelC).toBeCloseTo(0.5, 9)
    expect(metered.drivers.some((d) => d.id === 'wbgt_measured')).toBe(true)
    expect(metered.drivers.some((d) => d.id === 'wbgt_meter_model_mismatch')).toBe(false)
    const off = computeSiteHeat(baseEnv({ measuredWbgtC: model.wbgtC - 5 }), SITE_NO_BOOST)
    expect(off.drivers.some((d) => d.id === 'wbgt_meter_model_mismatch')).toBe(true)
    expect(model.measured).toBe(false)
    expect(model.measuredMinusModelC).toBeNull()
  })

  it('engineered shade is the default; the reference shade (opts false) is never warmer', () => {
    const eng = computeSiteHeat(baseEnv(), SITE_NO_BOOST)
    const ref = computeSiteHeat(baseEnv(), SITE_NO_BOOST, { engineeredShade: false })
    expect(ref.components.engineeredShade).toBe(false)
    expect(ref.wbgtShadeC).toBeLessThanOrEqual(eng.wbgtShadeC)
    expect(ref.mrtHumanShadeC).toBeLessThanOrEqual(eng.mrtHumanShadeC)
    expect(eng.wbgtC).toBe(ref.wbgtC)
  })

  it('honours env.radiationWindowMin (hour-mean data: geometry at t − 30 min)', () => {
    const t = epochFromLocal('2025-08-01T09:00')
    const instant = computeSiteHeat(baseEnv({ t, radiationWindowMin: 0 }), SITE_NO_BOOST)
    const hourly = computeSiteHeat(baseEnv({ t, radiationWindowMin: 60 }), SITE_NO_BOOST)
    expect(hourly.components.tEvalMs).toBe(t - 30 * 60_000)
    expect(instant.components.tEvalMs).toBe(t)
    expect(hourly.cosZenith).toBeLessThan(instant.cosZenith) // morning: the sun was lower 30 min earlier
    const forced = computeSiteHeat(baseEnv({ t, radiationWindowMin: 60 }), SITE_NO_BOOST, { radiationAvgMin: 0 })
    expect(forced.components.tEvalMs).toBe(t)
  })

  it('night: no sun, human MRT below air temperature', () => {
    const night = computeSiteHeat(baseEnv({ t: epochFromLocal('2025-08-01T02:00'), taC: 33, rhPct: 50, ghiWm2: 0 }), SITE_NO_BOOST)
    expect(night.cosZenith).toBeLessThan(0)
    expect(night.mrtC).toBeLessThan(night.taC)
    expect(night.mrtHumanShadeC).toBeGreaterThanOrEqual(night.taC)
  })
})

describe('computeSiteHeat — real cached demo days (Musaffah)', () => {
  const at = (day: typeof AUG1, hhmm: string) => {
    const s = sampleAt(day.analysis.samples, epochFromLocal(`${day.date}T${hhmm}`), MUSAFFAH)
    if (!s) throw new Error('no sample')
    return computeSiteHeat(s, MUSAFFAH)
  }

  it('1 Aug 2025 13:00: extreme heat, human MRT 70–90 °C, TWL in the ADOSH High zone in sun', () => {
    const h = at(AUG1, '13:00')
    expect(h.taC).toBeGreaterThan(42)
    expect(h.wbgtC).toBeGreaterThan(35)
    expect(h.wbgtC).toBeLessThan(42)
    expect(h.wbgtShadeC).toBeLessThan(h.wbgtC)
    expect(h.mrtC).toBeGreaterThan(70)
    expect(h.mrtC).toBeLessThan(90)
    expect(h.mrtC - h.taC).toBeLessThan(60) // inside the PHS t_r − t_a validity, unlike the globe MRT
    expect(h.twlWm2).toBeLessThan(115)
  })

  it('26 Nov 2025 13:00: mild — WBGT below 30 °C and TWL in the Low zone', () => {
    const h = at(NOV26, '13:00')
    expect(h.wbgtC).toBeLessThan(30)
    expect(h.twlWm2).toBeGreaterThan(140)
    expect(h.backstop.triggered).toBe(false)
  })

  it('performance: < 0.2 ms per call (mean)', () => {
    const samples = Array.from({ length: 24 }, (_, i) => sampleAt(AUG1.analysis.samples, epochFromLocal(`2025-08-01T${String(i).padStart(2, '0')}:30`), MUSAFFAH)).filter(
      (s): s is NonNullable<typeof s> => s !== null,
    )
    for (let i = 0; i < 200; i++) computeSiteHeat(samples[i % samples.length], MUSAFFAH)
    const n = 3000
    const t0 = performance.now()
    for (let i = 0; i < n; i++) computeSiteHeat(samples[i % samples.length], MUSAFFAH)
    const meanMs = (performance.now() - t0) / n
    expect(meanMs).toBeLessThan(0.2)
  })
})
