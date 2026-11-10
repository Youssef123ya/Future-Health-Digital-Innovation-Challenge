import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  GAGGE,
  GAGGE_PARITY_PARAMS,
  createGaggeState,
  gaggeDefaultWMax,
  gaggeStep,
  gaggeWaterLossG,
  pSatTorr,
  type GaggeInputs,
  type GaggeParams,
} from './gagge'

interface FixtureInputs {
  tdb: number
  tr: number
  v: number
  rh: number
  met: number
  clo: number
  wme: number
  body_surface_area: number
  p_atm: number
  position: 'standing' | 'sitting'
  max_skin_blood_flow: number
  max_sweating: number
  w_max: number | false
}
type Outputs = Record<'t_core' | 't_skin' | 'm_bl' | 'm_rsw' | 'w' | 'w_max' | 'e_skin' | 'e_rsw' | 'e_max' | 'q_sensible' | 'q_skin' | 'q_res', number>
interface FixtureCase {
  id: string
  inputs: FixtureInputs
  official_59: Outputs
  runs: Array<Outputs & { steps: number }>
}
interface MrtVector {
  id: string
  mrt_c: number
}
interface Fixture {
  meta: { self_check: { max_abs_diff: number }; steps: number[] }
  cases: FixtureCase[]
  mrt: MrtVector[]
}

const fixture = JSON.parse(readFileSync(new URL('../../fixtures/gagge.json', import.meta.url), 'utf8')) as Fixture

function toInputs(c: FixtureInputs): GaggeInputs {
  return {
    taC: c.tdb,
    trC: c.tr,
    vMs: c.v,
    rhPct: c.rh,
    metabolic: c.met * GAGGE.MET_FACTOR,
    wme: c.wme,
    clo: c.clo,
    bodyPosition: c.position,
    bsa: c.body_surface_area,
    pAtmPa: c.p_atm,
    ...(c.w_max === false ? {} : { wMax: c.w_max }),
  }
}

function toParams(c: FixtureInputs): GaggeParams {
  return { ...GAGGE_PARITY_PARAMS, maxSkinBloodFlow: c.max_skin_blood_flow, maxSweatingGm2h: c.max_sweating }
}

function outputsOf(s: ReturnType<typeof gaggeStep>): Outputs {
  return {
    t_core: s.tCoreC,
    t_skin: s.tSkinC,
    m_bl: s.mBl,
    m_rsw: s.mRswGm2h,
    w: s.w,
    w_max: s.wMax,
    e_skin: s.eSkinWm2,
    e_rsw: s.eRswWm2,
    e_max: s.eMaxWm2,
    q_sensible: s.qSensibleWm2,
    q_skin: s.qSensibleWm2 + s.eSkinWm2,
    q_res: s.qResWm2,
  }
}

function relErr(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(1, Math.abs(b))
}

describe('Gagge two-node port — parity with pythermalcomfort 4.8.1 two_nodes_gagge', () => {
  it('fixture self-check: patched 59-step oracle equals the official function', () => {
    expect(fixture.meta.self_check.max_abs_diff).toBeLessThan(1e-9)
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10)
  })

  let worst = 0
  for (const c of fixture.cases) {
    it(`${c.id}: every duration (${fixture.meta.steps.join(', ')} min) matches to 1e-9`, () => {
      for (const run of c.runs) {
        const s0 = createGaggeState({ initialMetabolicWm2: c.inputs.met * GAGGE.MET_FACTOR })
        const s = gaggeStep(s0, toInputs(c.inputs), run.steps, toParams(c.inputs))
        const got = outputsOf(s)
        for (const k of Object.keys(got) as Array<keyof Outputs>) {
          const e = relErr(got[k], run[k])
          worst = Math.max(worst, e)
          expect(e, `${c.id} steps=${run.steps} ${k}: ${got[k]} vs ${run[k]}`).toBeLessThan(1e-9)
        }
      }
    })
  }

  it('59 steps equal the official public-function outputs', () => {
    for (const c of fixture.cases) {
      const s = gaggeStep(createGaggeState({ initialMetabolicWm2: c.inputs.met * GAGGE.MET_FACTOR }), toInputs(c.inputs), GAGGE.UPSTREAM_STEPS, toParams(c.inputs))
      const got = outputsOf(s)
      for (const k of Object.keys(got) as Array<keyof Outputs>) expect(relErr(got[k], c.official_59[k])).toBeLessThan(1e-9)
    }
    // Reported for the summary.
    console.info(`[gagge parity] worst relative error over all fixture values: ${worst.toExponential(2)}`)
  })
})

describe('Gagge stepper — state carrying', () => {
  const hot = fixture.cases.find((c) => c.id === 'hot_dry_sun_moderate')!
  const inp = toInputs(hot.inputs)

  it('chunked stepping is bit-identical to one continuous run', () => {
    const s0 = createGaggeState({ initialMetabolicWm2: inp.metabolic })
    const whole = gaggeStep(s0, inp, 240)
    let chunked = s0
    for (const n of [1, 9, 20, 30, 60, 0, 120]) chunked = gaggeStep(chunked, inp, n)
    expect(chunked).toEqual(whole)
    let perMinute = s0
    for (let i = 0; i < 240; i++) perMinute = gaggeStep(perMinute, inp, 1)
    expect(perMinute).toEqual(whole)
  })

  it('does not mutate the input state and counts minutes', () => {
    const s0 = createGaggeState()
    const copy = { ...s0 }
    const s1 = gaggeStep(s0, inp, 5)
    expect(s0).toEqual(copy)
    expect(s1.minutes).toBe(5)
    expect(gaggeStep(s1, inp, 0)).toEqual(s1)
  })

  it('changing conditions: work then shade rest cools the core', () => {
    const s0 = createGaggeState({ initialMetabolicWm2: inp.metabolic })
    const work = gaggeStep(s0, inp, 30)
    const rest = gaggeStep(work, { ...inp, trC: inp.taC, metabolic: 65, vMs: 1 }, 30)
    expect(work.tCoreC).toBeGreaterThan(38)
    expect(rest.tCoreC).toBeLessThan(work.tCoreC)
  })

  it('rejects invalid input', () => {
    const s0 = createGaggeState()
    expect(() => gaggeStep(s0, inp, 1.5)).toThrow(RangeError)
    expect(() => gaggeStep(s0, inp, -1)).toThrow(RangeError)
    expect(() => gaggeStep(s0, { ...inp, taC: NaN }, 1)).toThrow(RangeError)
    expect(() => gaggeStep(s0, { ...inp, wMax: 1.2 }, 1)).toThrow(RangeError)
    expect(() => createGaggeState({ massKg: 0 })).toThrow(RangeError)
  })
})

describe('Gagge helpers and extensions', () => {
  const base: GaggeInputs = { taC: 38, trC: 50, vMs: 1, rhPct: 35, metabolic: 230, wme: 0, clo: 0.6, bodyPosition: 'standing', bsa: 1.9 }

  it('p_sat_torr and default w_max follow the upstream formulas', () => {
    expect(pSatTorr(35)).toBeCloseTo(Math.exp(18.6686 - 4030.183 / 270), 12)
    expect(gaggeDefaultWMax(1, 0.6)).toBeCloseTo(0.59, 12)
    expect(gaggeDefaultWMax(0.01, 0)).toBeCloseTo(0.38 * Math.pow(0.1, -0.29), 12)
  })

  it('neutral extension values reproduce the parity run exactly', () => {
    const s0 = createGaggeState({ initialMetabolicWm2: 230 })
    const a = gaggeStep(s0, base, 90)
    const b = gaggeStep(s0, base, 90, { sweatGainMultiplier: 1, setpointShiftC: 0, dehydration: { pct: 0, setpointCPerPct: 0.15, sweatGainLossPerPct: 0.03 } })
    expect(b).toEqual(a)
  })

  it('sweat-gain multiplier lowers, set-point shift and dehydration raise the compensable core temperature', () => {
    // Compensable work in heat (w < w_max at steady state), 3 h.
    const comp: GaggeInputs = { taC: 30, trC: 35, vMs: 1, rhPct: 40, metabolic: 200, wme: 0, clo: 0.6, bodyPosition: 'standing', bsa: 1.9, wMax: 1 }
    const s0 = createGaggeState({ initialMetabolicWm2: 200 })
    const ref = gaggeStep(s0, comp, 180)
    expect(ref.w).toBeLessThan(1)
    const gain = gaggeStep(s0, comp, 180, { sweatGainMultiplier: 1.3, setpointShiftC: 0 })
    const fever = gaggeStep(s0, comp, 180, { sweatGainMultiplier: 1, setpointShiftC: 0.5 })
    const dry = gaggeStep(s0, comp, 180, { sweatGainMultiplier: 1, setpointShiftC: 0, dehydration: { pct: 3, setpointCPerPct: 0.15, sweatGainLossPerPct: 0.03 } })
    expect(gain.tCoreC).toBeLessThan(ref.tCoreC)
    expect(gain.sweatG).toBeGreaterThan(ref.sweatG * 0.95)
    expect(fever.tCoreC - ref.tCoreC).toBeGreaterThan(0.3)
    // ≈ 0.1–0.2 °C per 1 % body-mass loss (Montain & Coyle 1992; TB MED 507 Para 2-3f ≈ 0.2 °C).
    const perPct = (dry.tCoreC - ref.tCoreC) / 3
    expect(perPct).toBeGreaterThan(0.1)
    expect(perPct).toBeLessThan(0.2)
  })

  it('tracks produced sweat (≥ evaporated) and water loss', () => {
    const s = gaggeStep(createGaggeState({ initialMetabolicWm2: 230 }), base, 60)
    expect(s.sweatProdGm2h).toBeGreaterThanOrEqual(s.mRswGm2h - 1e-9)
    expect(s.sweatG).toBeGreaterThan(100)
    expect(gaggeWaterLossG(s)).toBeGreaterThan(s.sweatG)
    // Respiratory water: q_res / 0.68 g/(m²·h) for 60 min.
    expect(s.respiratoryWaterG).toBeCloseTo((s.qResWm2 / 0.68) * 1.9, 6)
  })

  it('body mass scales the heat capacity (lighter body heats faster)', () => {
    const light = gaggeStep(createGaggeState({ massKg: 55 }), base, 30)
    const heavy = gaggeStep(createGaggeState({ massKg: 95 }), base, 30)
    expect(light.tCoreC).toBeGreaterThan(heavy.tCoreC)
  })
})
