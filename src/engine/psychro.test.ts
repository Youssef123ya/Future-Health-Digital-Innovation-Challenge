import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  clampRhPct,
  liljegrenEsatHpa,
  liljegrenDewPointK,
  vapourPressureHpa,
  rhFromDewPointPct,
  dewPointC,
  psatTetensKpa,
  vapourPressureTetensKpa,
} from './psychro'

interface PropertyRow {
  T_K: number
  P_hPa: number
  esat_hPa: number
  dew_point_K_of_half_esat: number
}
interface CoreCase {
  id: string
  inputs: { ta_c: number; rh_pct: number }
  intermediates: { eair_hPa: number; tdew_c: number }
}
interface FullCase {
  id: string
  inputs: { ta_c: number; rh_pct: number | null; td_c: number | null }
  derived: { rh_used_pct: number }
}
interface WbgtFixture {
  property_functions: PropertyRow[]
  core_cases: CoreCase[]
  full_cases: FullCase[]
}
interface PhsVector {
  id: string
  inputs: { model: string; tdb: number; rh: number; p_a_kpa: number }
}

const wbgt = JSON.parse(
  readFileSync(new URL('../../fixtures/wbgt_liljegren.json', import.meta.url), 'utf8'),
) as WbgtFixture
const phs = JSON.parse(readFileSync(new URL('../../fixtures/phs.json', import.meta.url), 'utf8')) as {
  vectors: PhsVector[]
}

const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)

describe('Liljegren saturation vapour pressure and dew point (wbgt_liljegren.md §5)', () => {
  it('esat matches every fixture property row to ≤ 1e-10 relative', () => {
    let worst = 0
    for (const row of wbgt.property_functions) worst = Math.max(worst, rel(liljegrenEsatHpa(row.T_K), row.esat_hPa))
    expect(worst).toBeLessThan(1e-10)
  })

  it('spot value: 42.6048337558 hPa at 303.15 K', () => {
    expect(liljegrenEsatHpa(303.15)).toBeCloseTo(42.6048337558, 9)
  })

  it('dew point is the exact inverse of esat (fixture dew_point(½·esat))', () => {
    let worst = 0
    for (const row of wbgt.property_functions) {
      worst = Math.max(worst, rel(liljegrenDewPointK(0.5 * liljegrenEsatHpa(row.T_K)), row.dew_point_K_of_half_esat))
    }
    expect(worst).toBeLessThan(1e-10)
    for (const tK of [263.15, 288.15, 303.15, 323.15]) expect(liljegrenDewPointK(liljegrenEsatHpa(tK))).toBeCloseTo(tK, 9)
  })

  it('core-case intermediates: e_air and T_dew', () => {
    for (const c of wbgt.core_cases) {
      expect(vapourPressureHpa(c.inputs.ta_c, c.inputs.rh_pct)).toBeCloseTo(c.intermediates.eair_hPa, 7)
      expect(dewPointC(c.inputs.ta_c, c.inputs.rh_pct)).toBeCloseTo(c.intermediates.tdew_c, 7)
    }
  })
})

describe('RH from dew point (D8, §13.2)', () => {
  it('reproduces rh_used_pct of every full case that supplies a dew point', () => {
    const withTd = wbgt.full_cases.filter((c) => c.inputs.td_c !== null)
    expect(withTd.length).toBeGreaterThan(0)
    for (const c of withTd) {
      expect(Math.abs(rhFromDewPointPct(c.inputs.ta_c, c.inputs.td_c as number) - c.derived.rh_used_pct)).toBeLessThan(2e-9)
    }
  })

  it('clamps to [1, 100] %', () => {
    expect(rhFromDewPointPct(30, 35)).toBe(100)
    expect(rhFromDewPointPct(48, -60)).toBe(1)
    expect(clampRhPct(0)).toBe(1)
    expect(clampRhPct(104)).toBe(100)
    expect(clampRhPct(55)).toBe(55)
  })

  it('a dew point equal to the air temperature means saturation', () => {
    expect(rhFromDewPointPct(27.3, 27.3)).toBeCloseTo(100, 12)
  })
})

describe('Tetens saturation pressure for PHS 2023 and TWL (kept separate from Liljegren)', () => {
  it('psat(0 °C) = 0.6105 kPa and the curve is the stated Tetens form', () => {
    expect(psatTetensKpa(0)).toBe(0.6105)
    expect(psatTetensKpa(30)).toBeCloseTo(0.6105 * Math.exp((17.27 * 30) / 267.3), 14)
  })

  it('reproduces p_a of every ISO 7933:2023 vector in fixtures/phs.json', () => {
    const v23 = phs.vectors.filter((v) => v.inputs.model === '7933-2023')
    expect(v23.length).toBeGreaterThan(0)
    let worst = 0
    for (const v of v23) worst = Math.max(worst, Math.abs(vapourPressureTetensKpa(v.inputs.tdb, v.inputs.rh) - v.inputs.p_a_kpa))
    expect(worst).toBeLessThan(1e-12)
  })

  it('the two formulas differ slightly, which is why each model uses its own', () => {
    const lil = liljegrenEsatHpa(303.15) / 10
    const tet = psatTetensKpa(30)
    expect(Math.abs(lil - tet)).toBeGreaterThan(0.01)
    expect(Math.abs(lil - tet) / tet).toBeLessThan(0.01)
  })
})
