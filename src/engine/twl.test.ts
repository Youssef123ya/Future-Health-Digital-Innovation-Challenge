import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  TWL_CONSTANTS,
  bb2002ProtocolZone,
  bb2002WithdrawalBackstop,
  computeTwl,
  dewPointFromVapourPressureC,
  globeToMrtIso7726,
  psatTetensKpa,
  psychrometricWetBulbC,
  vapourPressureFromRhKpa,
  vapourPressureFromWetBulbKpa,
} from './twl'
import type { TwlHumidityInput, TwlInput, TwlRadiantInput, TwlResult, TwlVariant } from './twl'

// ─────────────────────────────── Fixture types ───────────────────────────────

interface FixtureInputs {
  tdb_c: number
  twb_psychrometric_c: number | null
  rh_pct: number | null
  pa_kpa: number | null
  tg_c: number | null
  globe_diameter_m: number | null
  mrt_c: number | null
  wind_m_s: number
  pressure_kpa: number
  icl_clo: number
  icl_vapour_perm: number
  tcore_limit_c: number
  sr_max_kg_m2_h: number
  humidity_input: 'twb' | 'rh' | 'pa'
}

interface FixtureExpected {
  twl_w_m2: number
  twl_alt_1p8_w_m2: number
  tsk_c: number
  flags: string[]
  zone_adosh: 'HIGH' | 'MEDIUM' | 'LOW'
  low_subzone_bb2002: 'ACCLIMATIZATION_140_220' | 'UNRESTRICTED_GE_220' | null
  zone_with_bb2002_backstops: 'HIGH' | 'MEDIUM' | 'LOW'
  backstop_reasons: string[]
  [key: string]: unknown
}

interface FixtureVector {
  id: string
  group: string
  inputs: FixtureInputs
  expected: FixtureExpected
  tol: { twl_w_m2_abs: number; tsk_c_abs: number; other_rel: number }
  published?: { twl_w_m2: number | null }
}

interface TableICell {
  block: 'A' | 'B' | 'C'
  db: number
  wb: number
  published: number | null
  physical: number
  alt_1p8: number
  x_physical: number
}

interface TwlFixture {
  vectors: FixtureVector[]
  tableI_full: TableICell[]
  validation: {
    tableI_stats: {
      n_numeric: number
      n_np: number
      alt_1p8: { max_abs: number; mean: number; rms: number; floor_matches: number; round_matches: number }
      physical: {
        max_abs: number
        min: number
        max: number
        mean: number
        rms: number
        n_zoneC_cells: number
        zoneC_max_abs: number
      }
    }
  }
}

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/twl.json', import.meta.url), 'utf8')) as TwlFixture

function inputFromVector(v: FixtureVector, variant: TwlVariant): TwlInput {
  const i = v.inputs
  const humidity: TwlHumidityInput =
    i.humidity_input === 'twb'
      ? { twbPsychrometricC: i.twb_psychrometric_c as number }
      : i.humidity_input === 'rh'
        ? { rhPct: i.rh_pct as number }
        : { paKpa: i.pa_kpa as number }
  const radiant: TwlRadiantInput =
    i.tg_c !== null ? { tgC: i.tg_c, globeDiameterM: i.globe_diameter_m ?? 0.15 } : { mrtC: i.mrt_c as number }
  return {
    tdbC: i.tdb_c,
    windMs: i.wind_m_s,
    pKpa: i.pressure_kpa,
    iclClo: i.icl_clo,
    vapourPermeation: i.icl_vapour_perm,
    tcoreLimitC: i.tcore_limit_c,
    srMaxKgPerM2PerH: i.sr_max_kg_m2_h,
    variant,
    ...humidity,
    ...radiant,
  }
}

/** Fixture expected key → TwlResult key, for the heat-balance terms at the solution. */
const TERM_MAP: Array<[string, keyof TwlResult]> = [
  ['dew_point_c', 'dewPointC'],
  ['v_used_m_s', 'windUsedMs'],
  ['core_to_skin_H_w_m2', 'coreToSkinWm2'],
  ['dry_C_plus_R_w_m2', 'dryHeatLossWm2'],
  ['evap_E_w_m2', 'evapHeatLossWm2'],
  ['emax_w_m2', 'emaxWm2'],
  ['sweat_rate_kg_m2_h', 'sweatRateKgPerM2PerH'],
  ['sweat_rate_L_h_1p8m2', 'sweatRateLph'],
  ['x_lambda_sr_over_emax', 'sweatToEmaxRatio'],
  ['skin_wettedness_w', 'skinWettedness'],
  ['respiratory_B_w_m2', 'respiratoryWm2'],
  ['hc_w_m2_k', 'hcWm2K'],
  ['hr_w_m2_k', 'hrWm2K'],
  ['he_w_m2_kpa', 'heWm2Kpa'],
  ['t_operative_c', 'operativeTempC'],
  ['Fcle', 'fcle'],
  ['Fpcl', 'fpcl'],
]

/** Brake & Bates 2002 Table I block conditions (twl_and_regulation.md §1.8). */
const TABLE_I_BLOCKS = {
  A: { mrtMinusDb: 2, windMs: 0.2, pKpa: 101, iclClo: 0.45, perm: 0.45 },
  B: { mrtMinusDb: 0, windMs: 0.5, pKpa: 115, iclClo: 0.69, perm: 0.4 },
  C: { mrtMinusDb: 3, windMs: 1.5, pKpa: 80, iclClo: 0.35, perm: 0.45 },
} as const

function tableICell(c: TableICell, variant: TwlVariant): TwlResult {
  const b = TABLE_I_BLOCKS[c.block]
  return computeTwl({
    tdbC: c.db,
    twbPsychrometricC: c.wb,
    mrtC: c.db + b.mrtMinusDb,
    windMs: b.windMs,
    pKpa: b.pKpa,
    iclClo: b.iclClo,
    vapourPermeation: b.perm,
    variant,
  })
}

const maxAbs = (xs: number[]) => xs.reduce((m, x) => Math.max(m, Math.abs(x)), 0)
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
const rms = (xs: number[]) => Math.sqrt(mean(xs.map((x) => x * x)))

// ─────────────────────────────── Reference vectors ───────────────────────────────

describe('computeTwl vs fixtures/twl.json reference vectors (oracle: scripts/oracles/twl_oracle.py)', () => {
  it('has the 42 reference vectors', () => {
    expect(fixture.vectors).toHaveLength(42)
  })

  for (const v of fixture.vectors) {
    it(`${v.id}: TWL, skin temperature, flags and heat-balance terms (physical)`, () => {
      const r = computeTwl(inputFromVector(v, 'physical'))
      expect(Math.abs(r.twlWm2 - v.expected.twl_w_m2)).toBeLessThanOrEqual(v.tol.twl_w_m2_abs)
      expect(Math.abs(r.tskC - v.expected.tsk_c)).toBeLessThanOrEqual(v.tol.tsk_c_abs)
      expect(r.flags).toEqual(v.expected.flags)
      for (const [fk, rk] of TERM_MAP) {
        const e = v.expected[fk]
        if (typeof e !== 'number') continue
        const got = r[rk] as number
        expect(Math.abs(got - e), `${fk}`).toBeLessThanOrEqual(1e-4 + 1e-6 * Math.abs(e))
      }
      // derived inputs: vapour pressure, psychrometric wet bulb (inverted for RH inputs), MRT (ISO 7726 for globe inputs)
      if (v.inputs.pa_kpa !== null) expect(Math.abs(r.paKpa - v.inputs.pa_kpa)).toBeLessThanOrEqual(2e-6)
      if (v.inputs.twb_psychrometric_c !== null)
        expect(Math.abs(r.twbPsychrometricC - v.inputs.twb_psychrometric_c)).toBeLessThanOrEqual(2e-6)
      if (v.inputs.mrt_c !== null) expect(Math.abs(r.mrtC - v.inputs.mrt_c)).toBeLessThanOrEqual(2e-6)
      expect(r.inValidRange).toBe(r.twlWm2 >= 60 && r.twlWm2 <= 380)
    })

    it(`${v.id}: alt_1p8 variant`, () => {
      const r = computeTwl(inputFromVector(v, 'alt_1p8'))
      expect(Math.abs(r.twlWm2 - v.expected.twl_alt_1p8_w_m2)).toBeLessThanOrEqual(v.tol.twl_w_m2_abs)
    })
  }

  it('achieved max errors over all 42 vectors are far inside the spec port tolerance (±0.05 W/m², ±0.001 K)', () => {
    let twlErr = 0
    let altErr = 0
    let tskErr = 0
    for (const v of fixture.vectors) {
      const p = computeTwl(inputFromVector(v, 'physical'))
      const a = computeTwl(inputFromVector(v, 'alt_1p8'))
      twlErr = Math.max(twlErr, Math.abs(p.twlWm2 - v.expected.twl_w_m2))
      altErr = Math.max(altErr, Math.abs(a.twlWm2 - v.expected.twl_alt_1p8_w_m2))
      tskErr = Math.max(tskErr, Math.abs(p.tskC - v.expected.tsk_c))
    }
    console.info(
      `[twl] max |ΔTWL| physical ${twlErr.toExponential(2)} W/m², alt_1p8 ${altErr.toExponential(2)} W/m²; ` +
        `max |Δtsk| ${tskErr.toExponential(2)} K`,
    )
    expect(twlErr).toBeLessThan(1e-3)
    expect(altErr).toBeLessThan(1e-3)
    expect(tskErr).toBeLessThan(1e-5)
  })
})

// ─────────────────────────────── Brake & Bates 2002 Table I ───────────────────────────────

describe('Brake & Bates 2002 Table I (75 cells: 62 numeric, 13 "n/p")', () => {
  const cells = fixture.tableI_full
  const numeric = cells.filter((c) => c.published !== null)
  const np = cells.filter((c) => c.published === null)

  it('reproduces the oracle for every cell, both variants', () => {
    expect(cells).toHaveLength(75)
    let worst = 0
    for (const c of cells) {
      worst = Math.max(worst, Math.abs(tableICell(c, 'physical').twlWm2 - c.physical))
      worst = Math.max(worst, Math.abs(tableICell(c, 'alt_1p8').twlWm2 - c.alt_1p8))
    }
    expect(worst).toBeLessThan(1e-3)
  })

  it('alt_1p8 agreement with the printed table: max |Δ| 1.86, mean +0.69, rms 0.85, 45/62 floor matches (§1.6, §1.8)', () => {
    const s = fixture.validation.tableI_stats.alt_1p8
    const d = numeric.map((c) => tableICell(c, 'alt_1p8').twlWm2 - (c.published as number))
    expect(numeric).toHaveLength(62)
    expect(maxAbs(d)).toBeCloseTo(s.max_abs, 4)
    expect(maxAbs(d)).toBeLessThan(1.9)
    expect(mean(d)).toBeCloseTo(s.mean, 4)
    expect(rms(d)).toBeCloseTo(s.rms, 4)
    const floors = numeric.filter((c) => Math.floor(tableICell(c, 'alt_1p8').twlWm2) === c.published).length
    expect(floors).toBe(s.floor_matches)
  })

  it('physical agreement: 54 zone-C cells within 1.34 W/m², all 62 within +1.34/−10.10, mean +0.03, rms 1.87 (§1.6)', () => {
    const s = fixture.validation.tableI_stats.physical
    const rs = numeric.map((c) => ({ c, r: tableICell(c, 'physical') }))
    const d = rs.map(({ c, r }) => r.twlWm2 - (c.published as number))
    expect(Math.min(...d)).toBeCloseTo(s.min, 4)
    expect(Math.max(...d)).toBeCloseTo(s.max, 4)
    expect(Math.min(...d)).toBeGreaterThan(-10.11)
    expect(Math.max(...d)).toBeLessThan(1.34)
    expect(mean(d)).toBeCloseTo(s.mean, 4)
    expect(rms(d)).toBeCloseTo(s.rms, 4)
    const zoneC = rs.filter(({ r }) => r.sweatToEmaxRatio > 1.7)
    expect(zoneC).toHaveLength(s.n_zoneC_cells)
    expect(maxAbs(zoneC.map(({ c, r }) => r.twlWm2 - (c.published as number)))).toBeCloseTo(s.zoneC_max_abs, 4)
    expect(maxAbs(zoneC.map(({ c, r }) => r.twlWm2 - (c.published as number)))).toBeLessThan(1.34)
    // the 8 low-x (zone-B) cells — 80 kPa block, WB 24–26 — range from 0.4 above to 10.1 below the printed values
    const zoneB = rs.filter(({ r }) => r.sweatToEmaxRatio <= 1.7)
    expect(zoneB).toHaveLength(8)
    expect(zoneB.every(({ c }) => c.block === 'C' && c.wb <= 26)).toBe(true)
    const dB = zoneB.map(({ c, r }) => r.twlWm2 - (c.published as number))
    expect(Math.max(...dB)).toBeLessThan(0.45)
    expect(Math.min(...dB)).toBeGreaterThan(-10.11)
  })

  it('every "n/p" cell computes below 99.73 W/m² (max 99.7235), smaller than the smallest printed value 103', () => {
    expect(np).toHaveLength(13)
    const worst = Math.max(...np.map((c) => tableICell(c, 'physical').twlWm2))
    expect(worst).toBeLessThan(99.73)
    expect(worst).toBeCloseTo(99.7235, 3)
    expect(Math.min(...numeric.map((c) => c.published as number))).toBe(103)
  })
})

// ─────────────────────────────── Published worked examples ───────────────────────────────

describe('published worked examples (Brake & Bates 2002 text; AOH 2002)', () => {
  const textExample = (windMs: number) =>
    computeTwl({ tdbC: 40, twbPsychrometricC: 30, mrtC: 40, windMs, pKpa: 100 })

  it('p.180: 30 WB, 40 DB, 40 globe, 100 kPa, 0.2 m/s, Icl 0.35/icl 0.45 → 110.7 (published 110, truncated)', () => {
    const r = textExample(0.2)
    expect(Math.round(r.twlWm2 * 10) / 10).toBe(110.7)
    expect(Math.floor(r.twlWm2)).toBe(110)
  })

  it('p.181: same with 0.7 m/s → 158.3 (published 158)', () => {
    const r = textExample(0.7)
    expect(Math.round(r.twlWm2 * 10) / 10).toBe(158.3)
    expect(Math.floor(r.twlWm2)).toBe(158)
  })

  it('App. 2 "typically 26 °C WB, 35 °C DB and globe, 0.5 m/s" ≈ 220 → 217.0', () => {
    const r = computeTwl({ tdbC: 35, twbPsychrometricC: 26, mrtC: 35, windMs: 0.5, pKpa: 100 })
    expect(Math.round(r.twlWm2 * 10) / 10).toBe(217.0)
  })

  it('AOH 2002 Table 2 high-wind cases agree within 0.6 W/m² (243 → 243.5, 263 → 263.4)', () => {
    const hotDry = computeTwl({ tdbC: 38, twbPsychrometricC: 28, mrtC: 38, windMs: 3, pKpa: 100 })
    const hotHumid = computeTwl({ tdbC: 31, twbPsychrometricC: 28, mrtC: 31, windMs: 3, pKpa: 100 })
    expect(Math.abs(hotDry.twlWm2 - 243)).toBeLessThan(0.6)
    expect(Math.abs(hotHumid.twlWm2 - 263)).toBeLessThan(0.6)
  })

  it('sensitivity around DB 40, RH 40 %, MRT 65, 1 m/s (148): DB+1 → 134, MRT+5 → 135, 2 m/s → 181, RH 50 % → 105 (§1.8)', () => {
    const base = { tdbC: 40, rhPct: 40, mrtC: 65, windMs: 1, pKpa: 100 }
    expect(Math.round(computeTwl(base).twlWm2)).toBe(148)
    expect(Math.round(computeTwl({ ...base, tdbC: 41 }).twlWm2)).toBe(134)
    expect(Math.round(computeTwl({ ...base, mrtC: 70 }).twlWm2)).toBe(135)
    expect(Math.round(computeTwl({ ...base, windMs: 2 }).twlWm2)).toBe(181)
    expect(Math.round(computeTwl({ ...base, rhPct: 50 }).twlWm2)).toBe(105)
  })
})

// ─────────────────────────────── Helpers ───────────────────────────────

describe('psychrometric and radiant helpers', () => {
  it('Tetens psat and its inverse (dew point) round-trip', () => {
    expect(psatTetensKpa(0)).toBeCloseTo(0.6105, 10)
    for (const t of [5, 20, 30.5, 38.2]) expect(dewPointFromVapourPressureC(psatTetensKpa(t))).toBeCloseTo(t, 9)
    expect(dewPointFromVapourPressureC(0)).toBe(-Infinity)
  })

  it('psychrometric wet bulb inverts eq. 1 (pa = psat(WB) − 0.000644·P·(DB − WB))', () => {
    for (const [tdb, twb, p] of [
      [40, 30, 100],
      [46, 22.3, 97.5],
      [34, 32, 80],
    ]) {
      const pa = vapourPressureFromWetBulbKpa(tdb, twb, p)
      expect(pa).toBeCloseTo(psatTetensKpa(twb) - TWL_CONSTANTS.psychrometerCoeffPerK * p * (tdb - twb), 12)
      expect(psychrometricWetBulbC(tdb, pa, p)).toBeCloseTo(twb, 8)
    }
    expect(vapourPressureFromRhKpa(40, 40)).toBeCloseTo(0.4 * psatTetensKpa(40), 12)
  })

  it('ISO 7726 globe → MRT: 50 °C globe at 40 °C air, 1 m/s → 67.1 °C (150 mm) vs 82.6 °C (raw 25 mm)', () => {
    expect(globeToMrtIso7726(50, 40, 1)).toBeCloseTo(67.100599, 5)
    expect(globeToMrtIso7726(50, 40, 1, 0.025)).toBeCloseTo(82.616514, 5)
    expect(globeToMrtIso7726(35, 35, 2, 0.0508)).toBeCloseTo(35, 10)
  })

  it('accepts vapour pressure directly (same TWL as the wet-bulb form)', () => {
    const v = fixture.vectors.find((x) => x.id === 'BB2002-TEXT-1') as FixtureVector
    const r = computeTwl({ tdbC: 40, paKpa: v.inputs.pa_kpa as number, mrtC: 40, windMs: 0.2, pKpa: 100 })
    expect(Math.abs(r.twlWm2 - v.expected.twl_w_m2)).toBeLessThan(1e-3)
  })
})

// ─────────────────────────────── Edge cases and fail-safe behaviour ───────────────────────────────

describe('edge cases', () => {
  const base = { tdbC: 38, twbPsychrometricC: 28, mrtC: 38, pKpa: 100 }

  it('clamps wind to [0.2, 4.0] m/s and flags it', () => {
    const calm = computeTwl({ ...base, windMs: 0 })
    expect(calm.twlWm2).toBe(computeTwl({ ...base, windMs: 0.2 }).twlWm2)
    expect(calm.flags).toContain('WIND_CLAMPED_TO_0.2')
    const gale = computeTwl({ ...base, windMs: 6 })
    expect(gale.twlWm2).toBe(computeTwl({ ...base, windMs: 4 }).twlWm2)
    expect(gale.flags).toContain('WIND_CLAMPED_TO_4.0')
  })

  it('returns TWL = 0 when the skin gains heat even at core temperature (no sustainable work)', () => {
    const r = computeTwl({ tdbC: 42, twbPsychrometricC: 36, mrtC: 70, windMs: 0.2, pKpa: 100 })
    expect(r.twlWm2).toBe(0)
    expect(r.flags.slice(0, 2)).toEqual(['NO_ROOT_NET_HEAT_GAIN', 'BELOW_VALID_RANGE_60'])
    expect(r.inValidRange).toBe(false)
  })

  it('flags results outside the 60–380 W/m² valid range', () => {
    const cool = computeTwl({ tdbC: 24, rhPct: 10, mrtC: 24, windMs: 4, pKpa: 101.3 })
    expect(cool.twlWm2).toBeGreaterThan(380)
    expect(cool.flags).toContain('ABOVE_VALID_RANGE_380')
    expect(cool.inValidRange).toBe(false)
  })

  it('TWL falls with wet bulb and radiant load and rises with air speed (physical variant)', () => {
    let prev = Infinity
    for (let wb = 20; wb <= 33; wb += 0.5) {
      const t = computeTwl({ tdbC: 40, twbPsychrometricC: wb, mrtC: 55, windMs: 1, pKpa: 100 }).twlWm2
      expect(t).toBeLessThan(prev)
      prev = t
    }
    prev = Infinity
    for (let mrt = 40; mrt <= 80; mrt += 5) {
      const t = computeTwl({ tdbC: 40, rhPct: 30, mrtC: mrt, windMs: 1, pKpa: 100 }).twlWm2
      expect(t).toBeLessThan(prev)
      prev = t
    }
    prev = -Infinity
    for (let v = 0.2; v <= 4; v += 0.2) {
      const t = computeTwl({ tdbC: 40, rhPct: 30, mrtC: 60, windMs: v, pKpa: 100 }).twlWm2
      expect(t).toBeGreaterThan(prev)
      prev = t
    }
  })

  it('the physical reading is never above alt_1p8 (it is the more protective reading)', () => {
    for (const v of fixture.vectors) {
      expect(v.expected.twl_w_m2).toBeLessThanOrEqual(v.expected.twl_alt_1p8_w_m2 + 1e-9)
      const p = computeTwl(inputFromVector(v, 'physical')).twlWm2
      const a = computeTwl(inputFromVector(v, 'alt_1p8')).twlWm2
      expect(p).toBeLessThanOrEqual(a + 1e-9)
    }
  })

  it('non-finite inputs give NaN + INVALID_INPUT (fail-safe), malformed shapes throw', () => {
    const r = computeTwl({ ...base, tdbC: NaN, windMs: 1 })
    expect(Number.isNaN(r.twlWm2)).toBe(true)
    expect(r.flags).toEqual(['INVALID_INPUT'])
    const twoHumidities = { ...base, rhPct: 40, windMs: 1 } as unknown as TwlInput
    expect(() => computeTwl(twoHumidities)).toThrow()
    const noRadiant = { tdbC: 38, twbPsychrometricC: 28, windMs: 1, pKpa: 100 } as unknown as TwlInput
    expect(() => computeTwl(noRadiant)).toThrow()
  })
})

// ─────────────────────────────── Brake & Bates protocol (advisory) ───────────────────────────────

describe('Brake & Bates 2002 advisory backstop and four-zone protocol', () => {
  it('backstop reasons match the fixture for every vector', () => {
    for (const v of fixture.vectors) {
      const b = bb2002WithdrawalBackstop(v.inputs.tdb_c, v.inputs.twb_psychrometric_c as number)
      expect(b.reasons, v.id).toEqual(v.expected.backstop_reasons)
      expect(b.triggered).toBe(v.expected.backstop_reasons.length > 0)
    }
  })

  it('uses strict "exceeds" thresholds and treats non-finite input as exceeding', () => {
    expect(bb2002WithdrawalBackstop(44, 32).triggered).toBe(false)
    expect(bb2002WithdrawalBackstop(44.01, 20).reasons).toEqual(['DB>44C'])
    expect(bb2002WithdrawalBackstop(30, 32.01).reasons).toEqual(['WB>32C'])
    expect(bb2002WithdrawalBackstop(NaN, 20).triggered).toBe(true)
    expect(bb2002WithdrawalBackstop(30, 20).basis).toMatch(/not in ADOSH/)
  })

  it('protocol zones match the fixture sub-zones and resolve exact boundaries to the more protective zone', () => {
    const expectedZone = (v: FixtureVector) =>
      v.expected.zone_adosh === 'HIGH'
        ? 'withdrawal'
        : v.expected.zone_adosh === 'MEDIUM'
          ? 'buffer'
          : v.expected.low_subzone_bb2002 === 'UNRESTRICTED_GE_220'
            ? 'unrestricted'
            : 'acclimatization'
    for (const v of fixture.vectors) expect(bb2002ProtocolZone(v.expected.twl_w_m2), v.id).toBe(expectedZone(v))
    expect(bb2002ProtocolZone(115)).toBe('withdrawal')
    expect(bb2002ProtocolZone(140)).toBe('buffer')
    expect(bb2002ProtocolZone(220)).toBe('acclimatization')
    expect(bb2002ProtocolZone(220.0001)).toBe('unrestricted')
    expect(bb2002ProtocolZone(NaN)).toBe('withdrawal')
  })
})
