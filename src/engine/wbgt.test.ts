import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { EnvSample } from './types'
import {
  LILJEGREN,
  viscosityKgMs,
  thermalConductivityWmK,
  diffusivityM2s,
  latentHeatEvapJkg,
  atmosphericEmissivity,
  hSphereWm2K,
  hCylinderWm2K,
  preprocessFdir,
  globeTemperature,
  naturalWetBulb,
  psychrometricWetBulb,
  wbgtOutdoorC,
  wbgtIndoorC,
  liljegrenDirectBeam,
  liljegrenToaWm2,
  clearSkyGhiWm2,
  stabilityClassSrdt,
  windSpeed2mMs,
  wind2mFrom10m,
  URBAN_WIND_EXPONENTS,
  RURAL_WIND_EXPONENTS,
  LSRDT,
  globeMrtC,
  globeMrtFromRadiationC,
  bomApproxWbgtNotForAlerts,
  wbgtComponents,
  type LiljegrenInputs,
} from './wbgt'

// ─────────────────────────────── Fixture types ───────────────────────────────

interface PropertyRow {
  T_K: number
  P_hPa: number
  viscosity_kg_ms: number
  thermal_cond_W_mK: number
  diffusivity_m2_s: number
  evap_J_kg: number
  emis_atm_rh30: number
  emis_atm_rh70: number
  h_sphere_u0p13: number
  h_sphere_u1: number
  h_sphere_u4: number
  h_cylinder_u0p13: number
  h_cylinder_u1: number
  h_cylinder_u4: number
}
interface CoreCase {
  id: string
  inputs: {
    ta_c: number
    rh_pct: number
    p_hpa: number
    u2_ms: number
    ghi_wm2: number
    fdir_supplied: number
    cos_zenith: number
  }
  preprocessing: { fdir_used: number }
  outputs: { tg_c: number; tnwb_c: number; tpsy_c: number; wbgt_outdoor_c: number; wbgt_indoor_formula_c: number }
  iterations: { tg: number; tnwb: number; tpsy: number }
}
interface WindCase {
  u10_ms: number
  ghi_wm2: number
  cos_zenith: number
  daytime: boolean
  stability_class: number
  exponent_urban: number
  u2_urban_no_floor_ms: number
  u10_after_knmi_floor_ms: number
  u2_thermofeel_api_ms: number
  u2_rural_original_C_dT_lt0_ms: number
  u2_rural_original_C_dT_ge0_ms: number
}
interface FdirCase {
  toa_wm2: number
  ghi_wm2: number
  clearness_kt: number | null
  ghi_used_wm2: number
  fdir: number
}
interface FullCase {
  id: string
  site: string
  inputs: {
    lat: number
    lon: number
    time_end_utc: string
    avg_minutes: number
    ta_c: number
    rh_pct: number | null
    td_c: number | null
    p_hpa: number
    u10_ms: number
    ghi_wm2: number
    direct_wm2: number | null
  }
  derived: {
    rh_used_pct: number
    cos_zenith: number
    toa_wm2: number
    clearness_before_cap: number | null
    ghi_used_wm2: number
    fdir: number
    u10_after_floor_ms: number
    daytime: boolean
    stability_class: number
    wind_exponent: number
    u2_ms: number
  }
  outputs: { tg_c: number; tnwb_c: number; tpsy_c: number; wbgt_c: number }
  iterations: { tg: number; tnwb: number; tpsy: number }
  shade_variant: { tg_c: number; tnwb_c: number; wbgt_outdoor_formula_c: number; wbgt_indoor_formula_c: number }
  bom_approximation_NOT_LILJEGREN: { e_hpa: number; wbgt_c: number }
  sensitivity_fdir_openmeteo: { fdir_openmeteo_direct_over_ghi: number; wbgt_c: number } | null
}
interface LemkeFigure {
  n: number
  x: number[]
  digitized_wbgt_c: number[]
  thermofeel_wbgt_c: number[]
}
interface Fixture {
  constants: Record<string, number | number[] | number[][]>
  property_functions: PropertyRow[]
  core_cases: CoreCase[]
  wind_cases: WindCase[]
  fdir_cases: FdirCase[]
  full_cases: FullCase[]
  formula_cases: { tnwb_c: number; tg_c: number; ta_c: number; wbgt_outdoor_c: number; wbgt_indoor_shade_c: number }[]
  bom_approximation_cases_NOT_LILJEGREN: { ta_c: number; rh_pct: number; e_hpa: number; wbgt_bom_c: number }[]
  sanity_checks: {
    lemke_kjellstrom_2012: {
      fig1: LemkeFigure
      fig2: LemkeFigure
      fig3: LemkeFigure
      fig4: LemkeFigure
      S0_geometry_free: { digitized_c: number; thermofeel_c: number }
    }
  }
}
interface MrtExample {
  inputs: {
    ta_c: number
    rh_pct: number
    wind_2m_ms: number
    solar_wm2: number
    fdir: number
    cos_zenith: number
    pressure_hpa: number
  }
  liljegren_globe_tg_c: number
  h_liljegren_sphere_wm2k: number
  /** Keys include 'globe_forcing_used_by_liljegren_model' and 'a_invert_liljegren_h_D0.0508_recommended'. */
  mrt_c: Record<string, number>
}

const fx = JSON.parse(readFileSync(new URL('../../fixtures/wbgt_liljegren.json', import.meta.url), 'utf8')) as Fixture
const phs = JSON.parse(readFileSync(new URL('../../fixtures/phs.json', import.meta.url), 'utf8')) as {
  mrt_from_globe: { examples: MrtExample[] }
}

/** Spec tolerances (wbgt_liljegren.md §0 D10, §16; fixture meta.tolerances). */
const EXACT_PORT_C = 1e-6
const WIND_MS = 1e-9
const NOAA = 1e-9
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)

function coreInputs(c: CoreCase): LiljegrenInputs {
  return {
    taC: c.inputs.ta_c,
    rhPct: c.inputs.rh_pct,
    pHpa: c.inputs.p_hpa,
    u2Ms: c.inputs.u2_ms,
    ghiWm2: c.inputs.ghi_wm2,
    fdir: c.inputs.fdir_supplied,
    cosZenith: c.inputs.cos_zenith,
  }
}

function envFromFull(c: FullCase): EnvSample {
  return {
    t: Date.parse(c.inputs.time_end_utc),
    taC: c.inputs.ta_c,
    rhPct: c.inputs.rh_pct ?? Number.NaN,
    tdC: c.inputs.td_c ?? undefined,
    pHpa: c.inputs.p_hpa,
    wind10Ms: c.inputs.u10_ms,
    ghiWm2: c.inputs.ghi_wm2,
    directWm2: c.inputs.direct_wm2 ?? undefined,
    source: 'archive',
  }
}

const fullCase = (id: string) => fx.full_cases.find((c) => c.id === id) as FullCase

// ─────────────────────────────── Constants and properties ───────────────────────────────

describe('Liljegren constants (wbgt_liljegren.md §4)', () => {
  it('match the fixture exactly', () => {
    const k = fx.constants
    expect(LILJEGREN.STEFANB).toBe(k.STEFANB_W_m2K4)
    expect(LILJEGREN.CP).toBe(k.Cp_J_kgK)
    expect(LILJEGREN.M_AIR).toBe(k.M_AIR_g_mol)
    expect(LILJEGREN.M_H2O).toBe(k.M_H2O_g_mol)
    expect(LILJEGREN.R_GAS).toBe(k.R_GAS_J_kmolK)
    expect(LILJEGREN.R_AIR).toBe(k.R_AIR_J_kgK)
    expect(LILJEGREN.PR).toBe(k.Pr)
    expect(LILJEGREN.RATIO).toBe(k.RATIO_Cp_Mair_over_Mh2o)
    expect(LILJEGREN.EMIS_GLOBE).toBe(k.EMIS_GLOBE)
    expect(LILJEGREN.ALB_GLOBE).toBe(k.ALB_GLOBE)
    expect(LILJEGREN.D_GLOBE_M).toBe(k.D_GLOBE_m)
    expect(LILJEGREN.EMIS_WICK).toBe(k.EMIS_WICK)
    expect(LILJEGREN.ALB_WICK).toBe(k.ALB_WICK)
    expect(LILJEGREN.D_WICK_M).toBe(k.D_WICK_m)
    expect(LILJEGREN.L_WICK_M).toBe(k.L_WICK_m)
    expect(LILJEGREN.EMIS_SFC).toBe(k.EMIS_SFC)
    expect(LILJEGREN.ALB_SFC).toBe(k.ALB_SFC)
    expect(LILJEGREN.SOLAR_CONST_WM2).toBe(k.SOLAR_CONST_W_m2)
    expect(LILJEGREN.CZA_MIN).toBe(k.CZA_MIN)
    expect(LILJEGREN.NORMSOLAR_MAX).toBe(k.NORMSOLAR_MAX)
    expect(LILJEGREN.MIN_SPEED_MS).toBe(k.MIN_SPEED_ms)
    expect(LILJEGREN.CONVERGENCE_K).toBe(k.CONVERGENCE_K)
    expect(LILJEGREN.MAX_ITER).toBe(k.MAX_ITER_thermofeel)
    expect(LILJEGREN.DAMPING_NEW_WEIGHT).toBe(k.DAMPING_new_weight)
    expect(LILJEGREN.MIN_WIND_10M_MS).toBe(k.MIN_WIND_10M_KNMI_ms)
    expect([...URBAN_WIND_EXPONENTS]).toEqual(k.URBAN_EXP_by_class_1to6)
    expect([...RURAL_WIND_EXPONENTS]).toEqual(k.RURAL_EXP_by_class_1to6_original_C_only)
    expect(LSRDT.map((r) => [...r])).toEqual(k.LSRDT_table_rows_wind_cols_radiation)
  })
})

describe('thermophysical property functions (§5–6)', () => {
  it('match all 10 fixture rows to ≤ 1e-10 relative', () => {
    let worst = 0
    for (const r of fx.property_functions) {
      const pairs: [number, number][] = [
        [viscosityKgMs(r.T_K), r.viscosity_kg_ms],
        [thermalConductivityWmK(r.T_K), r.thermal_cond_W_mK],
        [diffusivityM2s(r.T_K, r.P_hPa), r.diffusivity_m2_s],
        [latentHeatEvapJkg(r.T_K), r.evap_J_kg],
        [atmosphericEmissivity(r.T_K, 0.3), r.emis_atm_rh30],
        [atmosphericEmissivity(r.T_K, 0.7), r.emis_atm_rh70],
        [hSphereWm2K(r.T_K, r.P_hPa, 0.13), r.h_sphere_u0p13],
        [hSphereWm2K(r.T_K, r.P_hPa, 1), r.h_sphere_u1],
        [hSphereWm2K(r.T_K, r.P_hPa, 4), r.h_sphere_u4],
        [hCylinderWm2K(r.T_K, r.P_hPa, 0.13), r.h_cylinder_u0p13],
        [hCylinderWm2K(r.T_K, r.P_hPa, 1), r.h_cylinder_u1],
        [hCylinderWm2K(r.T_K, r.P_hPa, 4), r.h_cylinder_u4],
      ]
      for (const [mine, ref] of pairs) worst = Math.max(worst, rel(mine, ref))
    }
    expect(worst).toBeLessThan(1e-10)
  })

  it('the convective coefficients floor the speed at 0.13 m/s inside Re', () => {
    expect(hSphereWm2K(303.15, 1000, 0.01)).toBe(hSphereWm2K(303.15, 1000, 0.13))
    expect(hCylinderWm2K(303.15, 1000, 0)).toBe(hCylinderWm2K(303.15, 1000, 0.13))
  })
})

// ─────────────────────────────── Solver-level vectors ───────────────────────────────

describe('globe and wet-bulb solvers: 20 core cases (exact port, ≤ 1e-6 °C)', () => {
  it('fdir pre-processing: clamp to [0, 0.9], zero below CZA_MIN', () => {
    for (const c of fx.core_cases) {
      expect(preprocessFdir(c.inputs.fdir_supplied, c.inputs.cos_zenith)).toBe(c.preprocessing.fdir_used)
    }
  })

  it('Tg, Tnwb, Tpsy and both WBGT formulas match; iteration counts are identical', () => {
    let dTg = 0
    let dTnwb = 0
    let dTpsy = 0
    let dWbgt = 0
    for (const c of fx.core_cases) {
      const inp = coreInputs(c)
      const tg = globeTemperature(inp)
      const tw = naturalWetBulb(inp)
      const tp = psychrometricWetBulb(inp.taC, inp.rhPct, inp.pHpa, inp.u2Ms)
      expect(tg.converged && tw.converged && tp.converged).toBe(true)
      expect([c.id, tg.iterations, tw.iterations, tp.iterations]).toEqual([
        c.id,
        c.iterations.tg,
        c.iterations.tnwb,
        c.iterations.tpsy,
      ])
      dTg = Math.max(dTg, Math.abs(tg.valueC - c.outputs.tg_c))
      dTnwb = Math.max(dTnwb, Math.abs(tw.valueC - c.outputs.tnwb_c))
      dTpsy = Math.max(dTpsy, Math.abs(tp.valueC - c.outputs.tpsy_c))
      dWbgt = Math.max(dWbgt, Math.abs(wbgtOutdoorC(tw.valueC, tg.valueC, inp.taC) - c.outputs.wbgt_outdoor_c))
      dWbgt = Math.max(dWbgt, Math.abs(wbgtIndoorC(tw.valueC, tg.valueC) - c.outputs.wbgt_indoor_formula_c))
    }
    console.info(`[wbgt] core cases max |ΔTg| ${dTg.toExponential(2)}  |ΔTnwb| ${dTnwb.toExponential(2)}  |ΔTpsy| ${dTpsy.toExponential(2)}  |ΔWBGT| ${dWbgt.toExponential(2)} °C`)
    expect(Math.max(dTg, dTnwb, dTpsy, dWbgt)).toBeLessThanOrEqual(EXACT_PORT_C)
  })

  it('the psychrometric wet bulb equals Ta at saturation (1 iteration)', () => {
    const r = psychrometricWetBulb(30, 100, 1005, 1)
    expect(r.valueC).toBeCloseTo(30, 9)
    expect(r.iterations).toBe(1)
  })

  it('wind below the 0.13 m/s floor behaves exactly like 0.13 m/s', () => {
    const a = fx.core_cases.find((c) => c.id === 'calm_floor_0p13') as CoreCase
    const b = fx.core_cases.find((c) => c.id === 'below_floor_0p05') as CoreCase
    expect(globeTemperature(coreInputs(b)).valueC).toBe(globeTemperature(coreInputs(a)).valueC)
    expect(naturalWetBulb(coreInputs(b)).valueC).toBe(naturalWetBulb(coreInputs(a)).valueC)
  })
})

describe('MAX_ITER = 500 and the bisection fallback (§7.3–7.4, D2)', () => {
  it('a calm, humid, hot physical case needs more than the C code’s 50 iterations and still converges', () => {
    // §7.3: natural wet bulb needs up to 59 iterations at Ta 50 °C, RH 95 %, u2 0.13, GHI 1000 (grid P = 1000 hPa).
    const runs = [0, 0.5, 0.9].map((fdir) =>
      naturalWetBulb({ taC: 50, rhPct: 95, pHpa: 1000, u2Ms: 0.13, ghiWm2: 1000, fdir, cosZenith: 1 }),
    )
    expect(runs.every((r) => r.converged && !r.fallback)).toBe(true)
    expect(Math.max(...runs.map((r) => r.iterations))).toBeGreaterThan(50)
  })

  it('a physically impossible input (GHI 1000 at cos z 0.1) cycles, and bisection recovers Tnwb ≈ 55.90 °C', () => {
    // §7.4: "Tnwb = 55.90 °C for Ta 46, RH 70, u 0.13, S 1000, fdir 0.9, cza 0.1, found by bisection".
    const r = naturalWetBulb({ taC: 46, rhPct: 70, pHpa: 1000, u2Ms: 0.13, ghiWm2: 1000, fdir: 0.9, cosZenith: 0.1 })
    expect(r.converged).toBe(false)
    expect(r.fallback).toBe(true)
    expect(Math.abs(r.valueC - 55.9)).toBeLessThan(0.01)
  })

  it('the pipeline’s solar cap makes that input physical again: no fallback needed', () => {
    // §7.4 engine rule: apply the cap first. GHI 1000 at cos z 0.1 is capped to 0.85·TOA ≈ 113 W/m².
    const toa = liljegrenToaWm2(0.1, 1.0164)
    const db = liljegrenDirectBeam(1000, toa)
    expect(db.capped).toBe(true)
    const r = naturalWetBulb({ taC: 46, rhPct: 70, pHpa: 1000, u2Ms: 0.13, ghiWm2: db.ghiUsedWm2, fdir: db.fdir, cosZenith: 0.1 })
    expect(r.converged).toBe(true)
    expect(r.fallback).toBe(false)
    expect(r.valueC).toBeLessThan(46)
  })
})

// ─────────────────────────────── Pre-processing vectors ───────────────────────────────

describe('wind: SRDT stability class and the 10 m → 2 m power law (§12)', () => {
  it('matches all 45 fixture wind cases (class, exponent, u2 with/without the 0.62 m/s floor, rural) to 1e-9', () => {
    for (const w of fx.wind_cases) {
      const cls = stabilityClassSrdt(w.cos_zenith > 0, w.u10_ms, w.ghi_wm2)
      expect(cls).toBe(w.stability_class)
      const noFloor = wind2mFrom10m(w.u10_ms, w.cos_zenith, w.ghi_wm2, { apply10mFloor: false })
      expect(noFloor.exponent).toBe(w.exponent_urban)
      expect(Math.abs(noFloor.u2Ms - w.u2_urban_no_floor_ms)).toBeLessThanOrEqual(WIND_MS)
      const api = wind2mFrom10m(w.u10_ms, w.cos_zenith, w.ghi_wm2)
      expect(api.u10UsedMs).toBe(w.u10_after_knmi_floor_ms)
      expect(Math.abs(api.u2Ms - w.u2_thermofeel_api_ms)).toBeLessThanOrEqual(WIND_MS)
      expect(Math.abs(windSpeed2mMs(w.u10_ms, cls, 'rural') - w.u2_rural_original_C_dT_lt0_ms)).toBeLessThanOrEqual(WIND_MS)
      const ruralGe0 = wind2mFrom10m(w.u10_ms, w.cos_zenith, w.ghi_wm2, {
        apply10mFloor: false,
        terrain: 'rural',
        nightDeltaTNonNegative: true,
      })
      expect(Math.abs(ruralGe0.u2Ms - w.u2_rural_original_C_dT_ge0_ms)).toBeLessThanOrEqual(WIND_MS)
    }
  })

  it('2 m floors: 0.487 (day A), 0.415 (day D), 0.383 (night E) m/s from the 0.62 m/s 10 m floor', () => {
    expect(wind2mFrom10m(0, 1, 1000).u2Ms).toBeCloseTo(0.487, 3)
    expect(wind2mFrom10m(0, 0.5, 100).u2Ms).toBeCloseTo(0.415, 3)
    expect(wind2mFrom10m(0, -0.3, 0).u2Ms).toBeCloseTo(0.383, 3)
  })
})

describe('direct-beam fraction with the 0.85 normsolar cap (§11, D6)', () => {
  it('matches all 17 fixture fdir cases to 1e-9', () => {
    for (const f of fx.fdir_cases) {
      const r = liljegrenDirectBeam(f.ghi_wm2, f.toa_wm2)
      expect(Math.abs(r.ghiUsedWm2 - f.ghi_used_wm2)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(r.fdir - f.fdir)).toBeLessThanOrEqual(1e-9)
      if (f.clearness_kt === null) expect(r.clearness).toBeNull()
      else expect(r.clearness).toBeCloseTo(f.clearness_kt, 12)
    }
  })

  it('sample values and the 0.9 clamp from S* ≥ 0.8251 (§11)', () => {
    expect(liljegrenDirectBeam(200, 1000).fdir).toBeCloseTo(0.004, 4)
    expect(liljegrenDirectBeam(500, 1000).fdir).toBeCloseTo(0.3791, 4)
    expect(liljegrenDirectBeam(700, 1000).fdir).toBeCloseTo(0.7444, 4)
    expect(liljegrenDirectBeam(830, 1000).fdir).toBe(0.9)
    const capped = liljegrenDirectBeam(1200, 1000)
    expect(capped.capped).toBe(true)
    expect(capped.ghiUsedWm2).toBeCloseTo(850, 9)
  })

  it('TOA is zero below CZA_MIN and GHI is then kept as diffuse', () => {
    expect(liljegrenToaWm2(0.008, 1)).toBe(0)
    expect(liljegrenToaWm2(0.5, 1)).toBe(683.5)
    expect(liljegrenDirectBeam(20, 0)).toEqual({ ghiUsedWm2: 20, fdir: 0, clearness: null, capped: false })
  })
})

describe('WBGT weighting (ISO 7243 via Lemke & Kjellstrom 2012 Eqs 1–2)', () => {
  it('matches the 6 formula cases to 1e-9', () => {
    for (const f of fx.formula_cases) {
      expect(Math.abs(wbgtOutdoorC(f.tnwb_c, f.tg_c, f.ta_c) - f.wbgt_outdoor_c)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(wbgtIndoorC(f.tnwb_c, f.tg_c) - f.wbgt_indoor_shade_c)).toBeLessThanOrEqual(1e-9)
    }
  })
})

// ─────────────────────────────── Full pipeline ───────────────────────────────

describe('wbgtComponents: 20 Open-Meteo-style full cases (exact port, ≤ 1e-6 °C)', () => {
  it('reproduces outputs, derived pre-processing, iteration counts and the reference shade variant', () => {
    let dTg = 0
    let dTnwb = 0
    let dTpsy = 0
    let dWbgt = 0
    let dShade = 0
    for (const c of fx.full_cases) {
      const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon, { engineeredShade: false })
      const d = c.derived
      expect(Math.abs(w.rhPct - d.rh_used_pct)).toBeLessThan(2e-9)
      expect(Math.abs(w.cosZenith - d.cos_zenith)).toBeLessThanOrEqual(NOAA)
      expect(Math.abs(w.toaWm2 - d.toa_wm2)).toBeLessThanOrEqual(1e-8)
      if (d.clearness_before_cap === null) expect(w.clearness).toBeNull()
      else expect(Math.abs((w.clearness as number) - d.clearness_before_cap)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(w.ghiUsedWm2 - d.ghi_used_wm2)).toBeLessThanOrEqual(1e-8)
      expect(Math.abs(w.fdir - d.fdir)).toBeLessThanOrEqual(1e-9)
      expect(w.wind10Ms).toBe(d.u10_after_floor_ms)
      expect(w.cosZenith > 0).toBe(d.daytime)
      expect(w.stabilityClass).toBe(d.stability_class)
      expect(w.windExponent).toBe(d.wind_exponent)
      expect(Math.abs(w.wind2Ms - d.u2_ms)).toBeLessThanOrEqual(WIND_MS)
      expect([c.id, w.iterations.tg, w.iterations.tnwb, w.iterations.tpwb]).toEqual([
        c.id,
        c.iterations.tg,
        c.iterations.tnwb,
        c.iterations.tpsy,
      ])
      expect(w.converged).toBe(true)
      expect(w.solverFallback).toBe(false)
      expect(w.wbgtSource).toBe('model')
      expect(w.wbgtC).toBe(w.wbgtModelC)
      dTg = Math.max(dTg, Math.abs(w.tgC - c.outputs.tg_c))
      dTnwb = Math.max(dTnwb, Math.abs(w.tnwbC - c.outputs.tnwb_c))
      dTpsy = Math.max(dTpsy, Math.abs(w.tpwbC - c.outputs.tpsy_c))
      dWbgt = Math.max(dWbgt, Math.abs(w.wbgtC - c.outputs.wbgt_c))
      dShade = Math.max(
        dShade,
        Math.abs(w.tgShadeC - c.shade_variant.tg_c),
        Math.abs(w.tnwbShadeC - c.shade_variant.tnwb_c),
        Math.abs(w.wbgtShadeC - c.shade_variant.wbgt_indoor_formula_c),
      )
    }
    console.info(`[wbgt] full cases max |ΔTg| ${dTg.toExponential(2)}  |ΔTnwb| ${dTnwb.toExponential(2)}  |ΔTpsy| ${dTpsy.toExponential(2)}  |ΔWBGT| ${dWbgt.toExponential(2)}  shade ${dShade.toExponential(2)} °C`)
    expect(Math.max(dTg, dTnwb, dTpsy, dWbgt, dShade)).toBeLessThanOrEqual(EXACT_PORT_C)
  })

  it('Madinat Zayed worked example (inland_summer_noon_extreme): WBGT 35.48 °C', () => {
    const c = fullCase('inland_summer_noon_extreme')
    expect(c.site).toBe('madinat_zayed')
    const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon)
    // wbgt_liljegren.md §16: cza 0.99923, fdir 0.7335, u2 1.084 m/s, Tg 63.80, Tnwb 25.85, Tpsy 22.40, WBGT 35.48 °C.
    expect(w.cosZenith).toBeCloseTo(0.99923, 5)
    expect(w.fdir).toBeCloseTo(0.7335, 4)
    expect(w.wind2Ms).toBeCloseTo(1.084, 3)
    expect(w.tgC).toBeCloseTo(63.8, 2)
    expect(w.tnwbC).toBeCloseTo(25.85, 2)
    expect(w.tpwbC).toBeCloseTo(22.4, 2)
    expect(w.wbgtC).toBeCloseTo(35.48, 2)
    expect(Math.abs(w.wbgtC - c.outputs.wbgt_c)).toBeLessThanOrEqual(EXACT_PORT_C)
    expect(w.humidityFrom).toBe('dew_point')
    expect(w.stabilityClass).toBe(1)
  })

  it('the solar-cap case rescales GHI to 0.85·TOA and flags it', () => {
    const c = fullCase('solar_cap_cloud_enhancement')
    const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon, { engineeredShade: false })
    expect(w.solarCapped).toBe(true)
    expect(w.ghiUsedWm2).toBeCloseTo(0.85 * w.toaWm2, 9)
    expect(w.fdir).toBe(0.9)
    expect(Math.abs(w.wbgtC - c.outputs.wbgt_c)).toBeLessThanOrEqual(EXACT_PORT_C)
  })

  it('night and the sunrise hour carry no beam term (fdir 0) and the globe sits below Ta', () => {
    for (const id of ['night_humid_no_sun', 'sunrise_hour', 'winter_night', 'calm_humid_night']) {
      const c = fullCase(id)
      const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon, { engineeredShade: false })
      expect(w.fdir).toBe(0)
      expect(w.tgC).toBeLessThan(w.taC)
    }
  })

  it('Open-Meteo direct/GHI sensitivity variant reproduces the fixture (no cap; bound 0.765·TOA/GHI)', () => {
    const withDirect = fx.full_cases.filter((c) => c.sensitivity_fdir_openmeteo !== null)
    expect(withDirect.length).toBe(3)
    for (const c of withDirect) {
      const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon, { fdirMethod: 'direct_ratio' })
      const s = c.sensitivity_fdir_openmeteo as { fdir_openmeteo_direct_over_ghi: number; wbgt_c: number }
      expect(w.fdirMethod).toBe('direct_ratio')
      expect(w.fdir).toBeCloseTo(Math.min(s.fdir_openmeteo_direct_over_ghi, 0.9), 9)
      expect(Math.abs(w.wbgtModelC - s.wbgt_c)).toBeLessThanOrEqual(EXACT_PORT_C)
      // §13.5: the alternative fdir moves WBGT by ≤ 0.17 °C on these days.
      expect(Math.abs(w.wbgtModelC - c.outputs.wbgt_c)).toBeLessThanOrEqual(0.171)
    }
    const noDirect = fullCase('winter_noon')
    const w = wbgtComponents(envFromFull(noDirect), noDirect.inputs.lat, noDirect.inputs.lon, { fdirMethod: 'direct_ratio' })
    expect(w.fdirMethod).toBe('liljegren')
    expect(w.defaults).toContain('direct_ratio_unavailable')
  })
})

describe('independent published values: Lemke & Kjellstrom (2012)', () => {
  it('Lemke & Kjellstrom S = 0 point (Fig. 1; Ta 30 °C, RH 55 %, u2 1 m/s): 24.822 vs published 24.83 °C', () => {
    const inp: LiljegrenInputs = { taC: 30, rhPct: 55, pHpa: 1013.25, u2Ms: 1, ghiWm2: 0, fdir: 0, cosZenith: 1 }
    const wbgt = wbgtOutdoorC(naturalWetBulb(inp).valueC, globeTemperature(inp).valueC, 30)
    const lk = fx.sanity_checks.lemke_kjellstrom_2012.S0_geometry_free
    expect(lk.digitized_c).toBe(24.83)
    expect(Math.abs(wbgt - 24.822221162)).toBeLessThanOrEqual(EXACT_PORT_C)
    expect(Math.abs(wbgt - lk.digitized_c)).toBeLessThanOrEqual(0.1)
    // Insensitive to pressure (§15.4: 24.818 at 1010 hPa).
    const at1010 = { ...inp, pHpa: 1010 }
    expect(wbgtOutdoorC(naturalWetBulb(at1010).valueC, globeTemperature(at1010).valueC, 30)).toBeCloseTo(24.818, 3)
  })

  it('reproduces the 99 digitized Figs 1–4 points (u ≥ 0.13): rms ≤ 0.15, max ≤ 0.25 °C', () => {
    const lk = fx.sanity_checks.lemke_kjellstrom_2012
    // Assumptions recorded with the digitization: P 1013.25 hPa, 2 m wind, fdir 0.8 and cos z = 1 for solar points.
    const base = { taC: 30, rhPct: 55, pHpa: 1013.25, u2Ms: 1, ghiWm2: 500, fdir: 0.8, cosZenith: 1 }
    const figs: [LemkeFigure, (x: number) => LiljegrenInputs][] = [
      [lk.fig1, (x) => ({ ...base, ghiWm2: x })],
      [lk.fig2, (x) => ({ ...base, rhPct: x })],
      [lk.fig3, (x) => ({ ...base, u2Ms: x })],
      [lk.fig4, (x) => ({ ...base, taC: x })],
    ]
    let sq = 0
    let n = 0
    let maxDev = 0
    let maxVsThermofeel = 0
    for (const [fig, make] of figs) {
      fig.x.forEach((x, i) => {
        const inp = make(x)
        if (inp.u2Ms < 0.13) return
        const w = wbgtOutdoorC(naturalWetBulb(inp).valueC, globeTemperature(inp).valueC, inp.taC)
        maxVsThermofeel = Math.max(maxVsThermofeel, Math.abs(w - fig.thermofeel_wbgt_c[i]))
        const dev = w - fig.digitized_wbgt_c[i]
        sq += dev * dev
        n++
        maxDev = Math.max(maxDev, Math.abs(dev))
      })
    }
    const rms = Math.sqrt(sq / n)
    console.info(`[wbgt] Lemke & Kjellstrom 2012: n ${n}, rms ${rms.toFixed(3)} °C, max ${maxDev.toFixed(3)} °C`)
    expect(n).toBe(99)
    expect(maxVsThermofeel).toBeLessThanOrEqual(5.1e-4)
    expect(rms).toBeLessThanOrEqual(0.15)
    expect(maxDev).toBeLessThanOrEqual(0.25)
  })
})

describe('BoM shade approximation — labelled comparator only (§17)', () => {
  it('matches the 8 fixture cases to 1e-9 and BoM’s Brisbane example (“about 30 °C”)', () => {
    for (const b of fx.bom_approximation_cases_NOT_LILJEGREN) {
      const r = bomApproxWbgtNotForAlerts(b.ta_c, b.rh_pct)
      expect(Math.abs(r.eHpa - b.e_hpa)).toBeLessThanOrEqual(1e-9)
      expect(Math.abs(r.wbgtC - b.wbgt_bom_c)).toBeLessThanOrEqual(1e-9)
    }
    expect(Math.abs(bomApproxWbgtNotForAlerts(29.4, 59).wbgtC - 30)).toBeLessThanOrEqual(0.5)
  })

  it('overestimates the Liljegren model by > 6 °C on a humid Abu Dhabi night (why it never drives alerts)', () => {
    const c = fullCase('night_humid_no_sun')
    const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon)
    expect(bomApproxWbgtNotForAlerts(c.inputs.ta_c, w.rhPct).wbgtC - w.wbgtModelC).toBeGreaterThan(6)
  })
})

// ─────────────────────────────── Shade, MRT, boost, measured WBGT ───────────────────────────────

describe('shade WBGT (§9)', () => {
  it('engineered shade (default) floors the shade globe at Ta; the reference shade does not', () => {
    const c = fullCase('liwa_very_dry')
    const ref = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon, { engineeredShade: false })
    const eng = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon)
    expect(eng.engineeredShade).toBe(true)
    expect(ref.tgShadeC).toBeLessThan(ref.taC)
    expect(eng.tgShadeC).toBe(Math.max(ref.tgShadeC, ref.taC))
    expect(eng.wbgtShadeC).toBeCloseTo(0.7 * eng.tnwbShadeC + 0.3 * eng.tgShadeC, 12)
    expect(eng.wbgtShadeC - ref.wbgtShadeC).toBeGreaterThan(0)
    // §9: Tg(S = 0) falls up to ≈ 2.63 K below Ta in dry air, so the floor adds up to 0.3 × 2.63 ≈ 0.8 °C.
    expect(eng.wbgtShadeC - ref.wbgtShadeC).toBeLessThanOrEqual(0.8)
    // Shade keeps the real-sky 2 m wind and drops the solar load.
    expect(eng.wbgtShadeC).toBeLessThan(eng.wbgtModelC)
  })
})

describe('mean radiant temperature of the 2-inch globe (phs_iso7933.md §10)', () => {
  it('inverting the Liljegren balance reproduces method (a) of fixtures/phs.json mrt_from_globe', () => {
    for (const ex of phs.mrt_from_globe.examples) {
      const i = ex.inputs
      const tg = globeTemperature({
        taC: i.ta_c,
        rhPct: i.rh_pct,
        pHpa: i.pressure_hpa,
        u2Ms: i.wind_2m_ms,
        ghiWm2: i.solar_wm2,
        fdir: i.fdir,
        cosZenith: i.cos_zenith,
      })
      expect(Math.abs(tg.valueC - ex.liljegren_globe_tg_c)).toBeLessThanOrEqual(EXACT_PORT_C)
      const tgK = ex.liljegren_globe_tg_c + 273.15
      expect(hSphereWm2K(0.5 * (tgK + i.ta_c + 273.15), i.pressure_hpa, i.wind_2m_ms)).toBeCloseTo(ex.h_liljegren_sphere_wm2k, 9)
      const ref = ex.mrt_c['a_invert_liljegren_h_D0.0508_recommended']
      expect(Math.abs(globeMrtC(ex.liljegren_globe_tg_c, i.ta_c, i.pressure_hpa, i.wind_2m_ms) - ref)).toBeLessThanOrEqual(1e-6)
      const forcing = globeMrtFromRadiationC(i.ta_c, i.rh_pct, i.solar_wm2, i.fdir, i.cos_zenith)
      expect(Math.abs(forcing - ex.mrt_c.globe_forcing_used_by_liljegren_model)).toBeLessThanOrEqual(1e-6)
      // §10.3: the inversion returns the model's radiative forcing to within 0.04 °C.
      expect(Math.abs(ref - forcing)).toBeLessThanOrEqual(0.05)
    }
  })

  it('wbgtComponents MRT agrees with the radiation-field MRT to within 0.1 °C on sunny full cases', () => {
    // The globe is only solved to |F(x) − x| < 0.02 K; the inversion amplifies that by (4T_g³ + h/σε)/(4T_mrt³) ≈ 2–4
    // (larger at high wind), so 0.04 °C at 0.5–2 m/s (§10.3) becomes up to ≈ 0.06 °C at the 4–6.7 m/s shamal cases.
    let worst = 0
    for (const c of fx.full_cases.filter((x) => x.derived.fdir > 0)) {
      const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon)
      const forcing = globeMrtFromRadiationC(w.taC, w.rhPct, w.ghiUsedWm2, w.fdir, w.cosZenith)
      worst = Math.max(worst, Math.abs(w.mrtC - forcing))
      expect(w.mrtC).toBeGreaterThan(w.tgC)
    }
    console.info(`[wbgt] globe MRT inversion vs radiation forcing, max |Δ| ${worst.toFixed(3)} °C`)
    expect(worst).toBeLessThanOrEqual(0.1)
  })
})

describe('radiant boost (site hot surfaces)', () => {
  const c = fullCase('ruwais_humid_heat')
  const base = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon)
  const boosted = wbgtComponents({ ...envFromFull(c), radiantBoostC: 4 }, c.inputs.lat, c.inputs.lon)

  it('adds exactly the configured °C to the globe and raises Tnwb, MRT and WBGT consistently', () => {
    expect(boosted.radiantBoostC).toBe(4)
    expect(boosted.tgC).toBeCloseTo(base.tgC + 4, 12)
    expect(boosted.tnwbC).toBeGreaterThan(base.tnwbC)
    expect(boosted.mrtC).toBeGreaterThan(base.mrtC)
    expect(boosted.tpwbC).toBe(base.tpwbC)
    const dW = boosted.wbgtC - base.wbgtC
    expect(dW).toBeGreaterThan(0.2 * 4)
    expect(dW).toBeLessThan(0.9 * 4)
    expect(boosted.tgShadeC).toBeCloseTo(base.tgShadeC + 4, 12)
    expect(boosted.wbgtShadeC).toBeGreaterThan(base.wbgtShadeC)
  })

  it('the implied extra long-wave load re-solves to the boosted globe (energy-balance consistent)', () => {
    // MRT⁴ = radiant forcing + ΔL/σ, so the MRT difference recovers the load the boost applied.
    const extraK4 = (boosted.mrtC + 273.15) ** 4 - (base.mrtC + 273.15) ** 4
    const resolved = globeTemperature({
      taC: base.taC,
      rhPct: base.rhPct,
      pHpa: base.pHpa,
      u2Ms: base.wind2Ms,
      ghiWm2: base.ghiUsedWm2,
      fdir: base.fdir,
      cosZenith: base.cosZenith,
      extraRadiantK4: extraK4,
    })
    expect(Math.abs(resolved.valueC - boosted.tgC)).toBeLessThanOrEqual(0.05)
  })

  it('can be limited to the work area, and negative or invalid values are ignored [ENG]', () => {
    const sunOnly = wbgtComponents({ ...envFromFull(c), radiantBoostC: 4 }, c.inputs.lat, c.inputs.lon, {
      radiantBoostInShade: false,
    })
    expect(sunOnly.tgShadeC).toBe(base.tgShadeC)
    expect(sunOnly.wbgtShadeC).toBe(base.wbgtShadeC)
    const neg = wbgtComponents({ ...envFromFull(c), radiantBoostC: -3 }, c.inputs.lat, c.inputs.lon)
    expect(neg.wbgtC).toBe(base.wbgtC)
    expect(neg.defaults).toContain('radiant_boost_invalid_ignored')
  })
})

describe('measured WBGT and fail-safe defaults', () => {
  const c = fullCase('openmeteo_snapshot_peak')

  it('a site meter reading becomes the exposure WBGT; the model is kept for QA', () => {
    const w = wbgtComponents({ ...envFromFull(c), source: 'site_sensor', measuredWbgtC: 33.1 }, c.inputs.lat, c.inputs.lon, {
      radiationAvgMin: 60,
    })
    const model = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon)
    expect(w.wbgtC).toBe(33.1)
    expect(w.wbgtSource).toBe('measured')
    expect(w.wbgtModelC).toBe(model.wbgtModelC)
    expect(w.measuredMinusModelC).toBeCloseTo(33.1 - model.wbgtModelC, 12)
    expect(w.source).toBe('site_sensor')
  })

  it('site sensors default to instantaneous geometry; forecasts to the preceding-hour mid-point', () => {
    const env = envFromFull(c)
    expect(wbgtComponents({ ...env, source: 'site_sensor' }, c.inputs.lat, c.inputs.lon).tEvalMs).toBe(env.t)
    expect(wbgtComponents({ ...env, source: 'forecast' }, c.inputs.lat, c.inputs.lon).tEvalMs).toBe(env.t - 1_800_000)
  })

  it('unknown wind → the model minimum (0.62 m/s at 10 m), which is never cooler than a measured light breeze in sun', () => {
    const w = wbgtComponents({ ...envFromFull(c), wind10Ms: Number.NaN }, c.inputs.lat, c.inputs.lon)
    expect(w.defaults).toContain('wind_unknown_floor')
    expect(w.wind10Ms).toBe(0.62)
    const breezy = wbgtComponents({ ...envFromFull(c), wind10Ms: 3 }, c.inputs.lat, c.inputs.lon)
    expect(w.wbgtC).toBeGreaterThan(breezy.wbgtC)
  })

  it('unknown solar → Kasten–Czeplak clear sky; unknown pressure → 1013.25 hPa', () => {
    const w = wbgtComponents({ ...envFromFull(c), ghiWm2: Number.NaN, pHpa: Number.NaN }, c.inputs.lat, c.inputs.lon)
    expect(w.defaults).toEqual(expect.arrayContaining(['solar_unknown_clear_sky', 'pressure_unknown_standard']))
    expect(w.ghiInputWm2).toBeCloseTo(clearSkyGhiWm2(w.cosZenith), 12)
    expect(w.pHpa).toBe(1013.25)
    expect(clearSkyGhiWm2(1)).toBe(880)
    expect(clearSkyGhiWm2(0.02)).toBe(0)
  })

  it('negative night-time GHI (sensor offset) is clamped to 0', () => {
    const n = fullCase('winter_night')
    const w = wbgtComponents({ ...envFromFull(n), ghiWm2: -2 }, n.inputs.lat, n.inputs.lon, { engineeredShade: false })
    expect(w.ghiInputWm2).toBe(0)
    expect(Math.abs(w.wbgtC - n.outputs.wbgt_c)).toBeLessThanOrEqual(EXACT_PORT_C)
  })

  it('missing air temperature or humidity throws instead of returning a silent NaN', () => {
    expect(() => wbgtComponents({ ...envFromFull(c), taC: Number.NaN }, c.inputs.lat, c.inputs.lon)).toThrow(RangeError)
    expect(() =>
      wbgtComponents({ ...envFromFull(c), tdC: undefined, rhPct: Number.NaN }, c.inputs.lat, c.inputs.lon),
    ).toThrow(RangeError)
  })

  it('the calm-air bound (u2 = 0.13 m/s) is an upper bound in sun', () => {
    const w = wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon, { includeCalmAirBound: true })
    expect(w.wbgtCalmAirC).not.toBeNull()
    expect(w.wbgtCalmAirC as number).toBeGreaterThan(w.wbgtModelC)
    expect(wbgtComponents(envFromFull(c), c.inputs.lat, c.inputs.lon).wbgtCalmAirC).toBeNull()
  })
})

describe('performance', () => {
  it('10,000 full WBGT evaluations (sun + shade + psychrometric) run well under 1 s', () => {
    const c = fullCase('inland_summer_noon_extreme')
    const env = envFromFull(c)
    const hour = 3_600_000
    let checksum = 0
    const t0 = performance.now()
    for (let i = 0; i < 10_000; i++) {
      const w = wbgtComponents(
        { ...env, t: env.t + (i % 24) * hour, taC: 28 + (i % 23), wind10Ms: 0.3 + (i % 7), ghiWm2: (i * 37) % 1000 },
        c.inputs.lat,
        c.inputs.lon,
      )
      checksum += w.wbgtC
    }
    const ms = performance.now() - t0
    console.info(`[wbgt] 10,000 wbgtComponents evaluations: ${ms.toFixed(0)} ms`)
    expect(Number.isFinite(checksum)).toBe(true)
    expect(ms).toBeLessThan(1000)
  })
})
