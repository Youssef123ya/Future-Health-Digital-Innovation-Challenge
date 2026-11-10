import { readFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ECTEMP,
  ECTEMP_SIGMOID,
  apsi,
  apsiCritical,
  ectempDisplayBand,
  ectempInit,
  ectempObservation,
  ectempRun,
  ectempStep,
  ectempSteadyStateC,
  ectempUpdate,
  ectempWarmupDone,
  minuteSqi,
  physioChannelStatus,
  physiologyLevel,
  physioMonitorInit,
  physioMonitorStep,
  psiBand,
  psiDisplay,
  psiHrBaseline,
  psiMoran,
  sqiRScale,
  type EctempModel,
  type EctempTrack,
  type PhysioMinute,
  type PhysiologyInput,
} from './physio'
import { MINUTE_MS, epochFromLocal } from './time'
import { TIER_TO_LEVEL, type ClinicalTier } from './types'

// ─────────────────────────────── fixtures ───────────────────────────────

interface EctempVector {
  name: string
  ct0: number
  v0: number
  hr: (number | null)[]
  ct_quadratic?: number[]
  v_quadratic?: number[]
  ct_sigmoid?: number[]
  v_sigmoid?: number[]
  psi?: number
  r_scale?: number
}
interface PhysioFixtures {
  constants: { gamma2: number; sigma2: number; b0: number; b1: number; b2: number; ct0_default: number; v0_default: number; quadratic_vertex_ct: number; quadratic_vertex_hr: number; sigmoid: { A: number; K: number; Q: number; B: number; M: number; nu: number } }
  ectemp_vectors: EctempVector[]
  psi_vectors: { ct: number; hr: number; ct0: number; hr0: number; psi: number; category: string }[]
  apsi_vectors: { ct: number; hr: number; ct_rest: number; hr_rest: number; age: number; tsk: number | null; hr_crit: number; ct_crit: number; apsi: number }[]
  sqi_vectors: { name: string; expected_interval_s: number; samples: [number, number | null, boolean][]; psi: number; valid: boolean; hr_mean: number | null; flags: string[]; r_scale: number | null }[]
  observation_model_table: { ct: number; hr_quadratic: number; hr_sigmoid: number; dhr_quadratic: number; dhr_sigmoid: number }[]
  steady_state_ct_for_constant_hr: { hr: number; ct_ss_quadratic: number | null; ct_ss_sigmoid: number | null }[]
  steady_state_dynamics: { ct: number; quadratic: { P_pred: number }; sigmoid: { P_pred: number } }[]
  hr_blunting_effect_quadratic: { true_hr: number; hr_reduction_bpm: number; ct_ss_true: number; ct_ss_blunted: number; underestimate_degC: number }[]
}
interface ClinicalFixtures {
  physio_escalation_vectors: {
    input: { ectemp: number; psi: number; hr_sustained_5min: number; age: number; channel_valid: boolean; conservative_mode: boolean }
    expected: { floor: string | null; reasons: string[] }
  }[]
}

const fx = JSON.parse(readFileSync(new URL('../../fixtures/physio/physio_fixtures.json', import.meta.url), 'utf8')) as PhysioFixtures
const cfx = JSON.parse(readFileSync(new URL('../../fixtures/physio/clinical_rules_fixtures.json', import.meta.url), 'utf8')) as ClinicalFixtures

const T0 = epochFromLocal('2026-07-15T06:00')
const at = (min: number): number => T0 + min * MINUTE_MS

/** Achieved accuracy versus the fixtures, printed after the run. */
const accuracy = { ctQuadratic: 0, vQuadratic: 0, ctSigmoid: 0, vSigmoid: 0, ctTracker: 0, psi: 0, apsi: 0, sqi: 0, ectempSteps: 0 }
afterAll(() => {
  console.info('[physio accuracy]', JSON.stringify(accuracy))
})

/** Small deterministic PRNG for property tests (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─────────────────────────────── ECTemp ───────────────────────────────

describe('ECTEMP constants (§10.1)', () => {
  it('match the USARIEM values bit-for-bit, with GAMMA2/SIGMA2 computed', () => {
    expect(ECTEMP.GAMMA2).toBe(fx.constants.gamma2)
    expect(ECTEMP.SIGMA2).toBe(fx.constants.sigma2)
    expect(ECTEMP.GAMMA2).toBe(0.022 ** 2)
    expect(ECTEMP.SIGMA2).toBe(18.88 ** 2)
    expect([ECTEMP.B0, ECTEMP.B1, ECTEMP.B2]).toEqual([fx.constants.b0, fx.constants.b1, fx.constants.b2])
    expect(ECTEMP.CT0_DEFAULT).toBe(fx.constants.ct0_default)
    expect(ECTEMP.V0_DEFAULT).toBe(fx.constants.v0_default)
    expect(Math.abs(ECTEMP.VERTEX_CT - fx.constants.quadratic_vertex_ct)).toBeLessThan(1e-4)
    expect(Math.abs(ECTEMP.VERTEX_CT - -ECTEMP.B1 / (2 * ECTEMP.B2))).toBeLessThan(1e-4)
    expect(Math.abs(ECTEMP.VERTEX_HR - fx.constants.quadratic_vertex_hr)).toBeLessThan(1e-3)
    const s = fx.constants.sigmoid
    expect(ECTEMP_SIGMOID).toEqual({ A: s.A, K: s.K, Q: s.Q, B: s.B, M: s.M, NU: s.nu })
  })
})

describe('ECTemp reference vectors (physio_fixtures.json, CT ≤ 1e-9 °C, v ≤ 1e-12)', () => {
  for (const vec of fx.ectemp_vectors) {
    it(vec.name, () => {
      let rScale = 1
      if (vec.r_scale !== undefined) {
        rScale = sqiRScale(vec.psi as number)
        expect(Math.abs(rScale - vec.r_scale)).toBeLessThan(1e-12)
      }
      let ran = 0
      for (const model of ['quadratic', 'sigmoid'] as EctempModel[]) {
        const expCt = model === 'quadratic' ? vec.ct_quadratic : vec.ct_sigmoid
        const expV = model === 'quadratic' ? vec.v_quadratic : vec.v_sigmoid
        if (!expCt || !expV) continue
        ran++
        const out = ectempRun(vec.hr, { ct0C: vec.ct0, v0: vec.v0, rScale, model })
        expect(out.ctC).toHaveLength(expCt.length)
        let dCt = 0
        let dV = 0
        out.ctC.forEach((ct, i) => {
          dCt = Math.max(dCt, Math.abs(ct - expCt[i]))
          dV = Math.max(dV, Math.abs(out.variance[i] - expV[i]))
        })
        accuracy.ectempSteps += out.ctC.length
        if (model === 'quadratic') {
          accuracy.ctQuadratic = Math.max(accuracy.ctQuadratic, dCt)
          accuracy.vQuadratic = Math.max(accuracy.vQuadratic, dV)
        } else {
          accuracy.ctSigmoid = Math.max(accuracy.ctSigmoid, dCt)
          accuracy.vSigmoid = Math.max(accuracy.vSigmoid, dV)
        }
        expect(dCt).toBeLessThan(1e-9)
        expect(dV).toBeLessThan(1e-12)

        // The streaming tracker reproduces the batch filter on the same minutes (gaps here are > 5 and ≤ 30 min).
        let tr: EctempTrack = ectempInit(T0, vec.ct0, model, vec.v0)
        let dTr = 0
        vec.hr.forEach((hr, i) => {
          tr = ectempUpdate(tr, hr, at(i + 1), rScale)
          dTr = Math.max(dTr, Math.abs(tr.ctC - expCt[i]))
        })
        accuracy.ctTracker = Math.max(accuracy.ctTracker, dTr)
        expect(dTr).toBeLessThan(1e-9)
      }
      expect(ran).toBeGreaterThan(0)
    })
  }
})

/** §10.11 mixed shift profile, each value rounded to 3 decimals. */
function mixedProfile(): number[] {
  return [
    ...Array<number>(10).fill(75),
    ...Array.from({ length: 45 }, (_, i) => 135 + 10 * Math.sin(i / 7)),
    ...Array<number>(15).fill(95),
    ...Array<number>(30).fill(160),
    ...Array.from({ length: 20 }, (_, i) => 100 - 0.5 * i),
  ].map((x) => Math.round(x * 1000) / 1000)
}

describe('§10.11 inline ECTemp vectors', () => {
  const TOL = 6e-11 // printed with 10 decimals

  it('constant HR 150 bpm from CT0 37.1, v0 0 (quadratic and sigmoid)', () => {
    const rows: [number, number, number, number, number][] = [
      [1, 37.1040984872, 0.0004826592, 37.1043857913, 0.0004828492],
      [2, 37.1122322845, 0.0009613346, 37.1131251556, 0.0009622468],
      [10, 37.2974244028, 0.0043970644, 37.3260852271, 0.0043961658],
      [30, 37.9952213426, 0.0091149215, 38.1469575591, 0.0080608259],
      [60, 38.5680548322, 0.0119378445, 38.6546743355, 0.0104271586],
      [120, 38.8637955223, 0.0138412717, 38.8648770183, 0.0124243818],
    ]
    const hr = Array<number>(120).fill(150)
    const q = ectempRun(hr)
    const s = ectempRun(hr, { model: 'sigmoid' })
    for (const [m, ct, v, cts, vs] of rows) {
      expect(Math.abs(q.ctC[m - 1] - ct)).toBeLessThan(TOL)
      expect(Math.abs(q.variance[m - 1] - v)).toBeLessThan(TOL)
      expect(Math.abs(s.ctC[m - 1] - cts)).toBeLessThan(TOL)
      expect(Math.abs(s.variance[m - 1] - vs)).toBeLessThan(TOL)
    }
  })

  it('mixed shift profile (quadratic, sigmoid in brackets)', () => {
    const hr = mixedProfile()
    const fixtureHr = fx.ectemp_vectors.find((v) => v.name === 'work_rest_mixed_120min')?.hr
    expect(hr).toEqual(fixtureHr)
    const q = ectempRun(hr)
    const s = ectempRun(hr, { model: 'sigmoid' })
    const rows: [number, number, number][] = [
      [1, 37.0995051173, 37.1001293559],
      [11, 37.1077237858, 37.1415611798],
      [30, 37.8006011281, 37.9619341442],
      [60, 37.9398546515, 38.0714538989],
      [100, 38.697149767, 38.7692293422],
      [120, 37.8853754175, 37.9563707404],
    ]
    for (const [m, ct, cts] of rows) {
      expect(Math.abs(q.ctC[m - 1] - ct)).toBeLessThan(TOL)
      expect(Math.abs(s.ctC[m - 1] - cts)).toBeLessThan(TOL)
    }
  })

  it('minutes 21-35 missing: CT holds, v grows by GAMMA2 per minute, then recovers', () => {
    const hr: (number | null)[] = mixedProfile().map((x, i) => (i >= 20 && i <= 34 ? null : x))
    const q = ectempRun(hr)
    for (let m = 20; m <= 35; m++) expect(Math.abs(q.ctC[m - 1] - 37.4551614866)).toBeLessThan(TOL)
    expect(Math.abs(q.variance[19] - 0.0071636465)).toBeLessThan(TOL)
    for (let m = 21; m <= 35; m++) expect(q.variance[m - 1] - q.variance[m - 2]).toBeCloseTo(0.000484, 15)
    expect(Math.abs(q.variance[34] - 0.0144236465)).toBeLessThan(TOL)
    expect(hr[35]).toBe(130.833)
    expect(Math.abs(q.ctC[35] - 37.5079241755)).toBeLessThan(TOL)
    expect(Math.abs(q.variance[35] - 0.0138841581)).toBeLessThan(TOL)
    expect(Math.abs(q.ctC[119] - 37.87634809)).toBeLessThan(TOL)
  })

  it('psi 0.85 every minute (rScale 1.4682673689)', () => {
    const rScale = sqiRScale(0.85)
    expect(Math.abs(rScale - 1.4682673689)).toBeLessThan(TOL)
    const q = ectempRun(mixedProfile(), { rScale })
    expect(Math.abs(q.ctC[99] - 38.5912184742)).toBeLessThan(TOL)
    expect(Math.abs(q.ctC[119] - 37.9389992082)).toBeLessThan(TOL)
  })

  it('edge cases: 30 min at 200 bpm and at 45 bpm', () => {
    expect(Math.abs(ectempRun(Array<number>(30).fill(200)).ctC[29] - 38.6318095827)).toBeLessThan(TOL)
    expect(Math.abs(ectempRun(Array<number>(30).fill(45)).ctC[29] - 36.5809911061)).toBeLessThan(TOL)
  })
})

describe('observation model and steady state', () => {
  it('h(CT) and dh/dCT match the observation-model table (rounded to 3 and 4 decimals)', () => {
    for (const row of fx.observation_model_table) {
      const q = ectempObservation(row.ct, 'quadratic')
      const s = ectempObservation(row.ct, 'sigmoid')
      expect(Math.abs(q.hrBpm - row.hr_quadratic)).toBeLessThanOrEqual(5e-4 + 1e-9)
      expect(Math.abs(s.hrBpm - row.hr_sigmoid)).toBeLessThanOrEqual(5e-4 + 1e-9)
      expect(Math.abs(q.slopeBpmPerC - row.dhr_quadratic)).toBeLessThanOrEqual(5e-5 + 1e-9)
      expect(Math.abs(s.slopeBpmPerC - row.dhr_sigmoid)).toBeLessThanOrEqual(5e-5 + 1e-9)
    }
  })

  it('sigmoid slope equals the finite-difference derivative', () => {
    for (let ct = 35; ct <= 41.5; ct += 0.25) {
      const d = 1e-5
      const fd = (ectempObservation(ct + d, 'sigmoid').hrBpm - ectempObservation(ct - d, 'sigmoid').hrBpm) / (2 * d)
      expect(Math.abs(ectempObservation(ct, 'sigmoid').slopeBpmPerC - fd)).toBeLessThan(1e-5)
    }
  })

  it('steady-state CT for constant HR (inverse model) matches the table, null beyond range', () => {
    for (const row of fx.steady_state_ct_for_constant_hr) {
      for (const [model, exp] of [['quadratic', row.ct_ss_quadratic], ['sigmoid', row.ct_ss_sigmoid]] as const) {
        const got = ectempSteadyStateC(row.hr, model)
        if (exp === null) expect(got).toBeNull()
        else expect(Math.abs((got as number) - exp)).toBeLessThanOrEqual(5e-5 + 1e-9)
      }
    }
  })

  it('steady-state predicted variance of the Kalman recursion matches the oracle', () => {
    for (const row of fx.steady_state_dynamics) {
      for (const model of ['quadratic', 'sigmoid'] as EctempModel[]) {
        const hr = ectempObservation(row.ct, model).hrBpm // zero innovation: CT stays at row.ct
        let ct = row.ct
        let v = 0
        for (let i = 0; i < 5000; i++) ({ ctC: ct, variance: v } = ectempStep(ct, v, hr, 1, model))
        expect(ct).toBe(row.ct)
        const pPred = v + ECTEMP.GAMMA2
        expect(Math.abs(pPred - row[model].P_pred)).toBeLessThanOrEqual(5e-7 + 1e-12)
      }
    }
  })

  it('HR blunting (e.g. beta-blockers) lowers the steady-state estimate as tabulated', () => {
    for (const row of fx.hr_blunting_effect_quadratic) {
      const ctTrue = ectempSteadyStateC(row.true_hr) as number
      const ctBlunted = ectempSteadyStateC(row.true_hr - row.hr_reduction_bpm) as number
      expect(Math.abs(ctTrue - row.ct_ss_true)).toBeLessThanOrEqual(5e-4 + 1e-9)
      expect(Math.abs(ctBlunted - row.ct_ss_blunted)).toBeLessThanOrEqual(5e-4 + 1e-9)
      expect(Math.abs(ctTrue - ctBlunted - row.underestimate_degC)).toBeLessThanOrEqual(1e-3)
    }
  })

  it('c ≤ 0 beyond the quadratic vertex skips the measurement update', () => {
    const p = ectempStep(42.5, 0.01, 190)
    expect(p.ctC).toBe(42.5)
    expect(p.variance).toBe(0.01 + ECTEMP.GAMMA2)
  })
})

describe('ECTemp tracker gap rules (§10.2)', () => {
  const feed = (seq: (number | null)[], start: EctempTrack = ectempInit(T0)): EctempTrack =>
    seq.reduce<EctempTrack>((s, hr, i) => ectempUpdate(s, hr, at(i + 1)), start)

  it('a gap of ≤ 5 missing minutes is linearly interpolated once the next reading arrives', () => {
    const ref = ectempRun([100, 110, 120, 130, 140, 150, 150])
    const mid = feed([100, 110, null, null, null])
    const anchor = feed([100, 110])
    expect(mid.ctC).toBe(anchor.ctC) // provisional: CT held during the open gap
    expect(mid.variance).toBeCloseTo(anchor.variance + 3 * ECTEMP.GAMMA2, 15)
    const s = feed([100, 110, null, null, null, 150, 150])
    expect(s.ctC).toBe(ref.ctC[6])
    expect(s.variance).toBe(ref.variance[6])
  })

  it('skipped timestamps behave like explicit null minutes', () => {
    let s = ectempInit(T0)
    s = ectempUpdate(s, 100, at(1))
    s = ectempUpdate(s, 110, at(2))
    s = ectempUpdate(s, 150, at(6))
    s = ectempUpdate(s, 150, at(7))
    expect(s.ctC).toBe(ectempRun([100, 110, 120, 130, 140, 150, 150]).ctC[6])
  })

  it('a 6-minute gap is not interpolated (null minutes)', () => {
    const seq = [100, 110, null, null, null, null, null, null, 150]
    expect(feed(seq).ctC).toBe(ectempRun(seq).ctC[8])
  })

  it('a gap of exactly 30 missing minutes keeps the filter; 31 re-initialises and restarts the warm-up', () => {
    const keep = [100, ...Array<null>(30).fill(null), 150]
    const sKeep = feed(keep)
    expect(sKeep.ctC).toBe(ectempRun(keep).ctC[31])
    expect(sKeep.initT).toBe(T0)

    const reinit = [100, ...Array<null>(31).fill(null), 150]
    const sRe = feed(reinit)
    const fresh = ectempStep(ECTEMP.CT0_DEFAULT, ECTEMP.V0_DEFAULT, 150)
    expect(sRe.ctC).toBe(fresh.ctC)
    expect(sRe.variance).toBe(fresh.variance)
    expect(sRe.initT).toBe(at(32))
    expect(ectempWarmupDone(sRe, at(33))).toBe(false)
    expect(ectempWarmupDone(sRe, at(32 + 30))).toBe(true)

    // Same through skipped timestamps (one long jump).
    let s = ectempUpdate(ectempInit(T0), 100, at(1))
    s = ectempUpdate(s, 150, at(33))
    expect(s.ctC).toBe(fresh.ctC)
    expect(s.initT).toBe(at(32))
  })

  it('ignores duplicate or out-of-order minutes; non-finite rScale counts as missing', () => {
    const s = feed([100, 110])
    expect(ectempUpdate(s, 150, s.t)).toBe(s)
    expect(ectempUpdate(s, 150, s.t - MINUTE_MS)).toBe(s)
    const a = ectempUpdate(s, 150, s.t + MINUTE_MS, Infinity)
    const b = ectempUpdate(s, null, s.t + MINUTE_MS)
    expect(a).toEqual(b)
  })

  it('accepts a bare EctempState and restarts the warm-up from it (fail-safe)', () => {
    const s = ectempUpdate({ ctC: 37.1, variance: 0, t: T0 }, 120, at(1))
    expect(s.ctC).toBe(ectempStep(37.1, 0, 120).ctC)
    expect(s.initT).toBe(T0)
    expect(ectempWarmupDone(s, at(29))).toBe(false)
  })
})

describe('ECTemp properties', () => {
  it('steady-state CT is strictly monotone in HR and the filter converges to it', () => {
    for (const model of ['quadratic', 'sigmoid'] as EctempModel[]) {
      let prev = -Infinity
      for (let hr = 50; hr <= 180; hr += 10) {
        const ct = ectempRun(Array<number>(900).fill(hr), { model }).ctC[899]
        expect(ct).toBeGreaterThan(prev)
        expect(Math.abs(ct - (ectempSteadyStateC(hr, model) as number))).toBeLessThan(1e-3)
        prev = ct
      }
    }
    const rnd = prng(7)
    for (let i = 0; i < 40; i++) {
      const a = 45 + rnd() * 140
      const b = a + 1 + rnd() * (190 - a - 1)
      for (const model of ['quadratic', 'sigmoid'] as EctempModel[]) {
        const ca = ectempRun(Array<number>(600).fill(a), { model }).ctC[599]
        const cb = ectempRun(Array<number>(600).fill(b), { model }).ctC[599]
        expect(cb).toBeGreaterThan(ca)
      }
    }
  })

  it('each null minute holds CT exactly and adds exactly GAMMA2 to the variance', () => {
    const rnd = prng(11)
    for (let i = 0; i < 200; i++) {
      const ct0 = 36 + rnd() * 4
      const v0 = rnd() * 0.05
      const n = 1 + Math.floor(rnd() * 60)
      let ct = ct0
      let v = v0
      for (let k = 0; k < n; k++) {
        const p = ectempStep(ct, v, null, 1, rnd() < 0.5 ? 'quadratic' : 'sigmoid')
        expect(p.ctC).toBe(ct)
        expect(p.variance - v).toBeCloseTo(ECTEMP.GAMMA2, 15)
        ct = p.ctC
        v = p.variance
      }
      expect(Math.abs(v - (v0 + n * ECTEMP.GAMMA2))).toBeLessThan(1e-14)
    }
  })

  it('a valid measurement never increases the variance', () => {
    const rnd = prng(5)
    for (let i = 0; i < 200; i++) {
      const v = rnd() * 0.05
      const p = ectempStep(36 + rnd() * 4, v, 45 + rnd() * 150, 1 + rnd() * 3)
      expect(p.variance).toBeLessThanOrEqual(v + ECTEMP.GAMMA2)
      expect(p.variance).toBeGreaterThan(0)
    }
  })
})

describe('ECTemp display band (§10.2 rule 4)', () => {
  it('formats "≈38.2 ± 0.6" and clamps to [35.5, 42.0]', () => {
    expect(ectempDisplayBand(38.23, { channelValid: true })).toEqual({ centreC: 38.2, halfWidthC: 0.6, lowC: 37.6, highC: 38.8, text: '≈38.2 ± 0.6' })
    expect(ectempDisplayBand(43.7, { channelValid: true })?.text).toBe('≈42.0 ± 0.6')
    expect(ectempDisplayBand(34.0, { channelValid: true })?.text).toBe('≈35.5 ± 0.6')
  })

  it('is hidden during warm-up, while the channel is invalid, or with HR-suppressing medication', () => {
    expect(ectempDisplayBand(38.2, { channelValid: false })).toBeNull()
    expect(ectempDisplayBand(38.2, { channelValid: true, warmupDone: false })).toBeNull()
    expect(ectempDisplayBand(38.2, { channelValid: true, hrSuppressingMedication: true })).toBeNull()
    expect(ectempDisplayBand(null, { channelValid: true })).toBeNull()
  })
})

// ─────────────────────────────── PSI / aPSI ───────────────────────────────

describe('PSI and aPSI (§10.3; tolerance 1e-6)', () => {
  it('PSI fixture vectors and Moran bands', () => {
    for (const p of fx.psi_vectors) {
      const psi = psiMoran(p.ct, p.hr, p.ct0, p.hr0) as number
      accuracy.psi = Math.max(accuracy.psi, Math.abs(psi - p.psi))
      expect(Math.abs(psi - p.psi)).toBeLessThan(1e-6)
      expect(psiBand(psi)).toBe(p.category)
    }
  })

  it('§10.11 inline PSI vectors', () => {
    const rows: [number, number, number, number, number, string][] = [
      [38.4, 150, 37.1, 70, 6.344697, 'high'],
      [39.0, 165, 37.0, 70, 8.318182, 'very_high'],
      [38.0, 140, 36.9, 80, 5.115385, 'moderate'],
      [37.8, 120, 37.1, 75, 3.60119, 'low'],
    ]
    for (const [ct, hr, ct0, hr0, exp, band] of rows) {
      const psi = psiMoran(ct, hr, ct0, hr0) as number
      expect(Math.abs(psi - exp)).toBeLessThan(1e-6)
      expect(psiBand(psi)).toBe(band)
    }
  })

  it('PSI is invalid when CT0 ≥ 39.5 or HR0 ≥ 180; bands use the conservative ceil mapping; display clamps 0-10', () => {
    expect(psiMoran(38, 120, 39.5, 70)).toBeNull()
    expect(psiMoran(38, 120, 37, 180)).toBeNull()
    expect(psiBand(2)).toBe('no_little')
    expect(psiBand(2.001)).toBe('low')
    expect(psiBand(4)).toBe('low')
    expect(psiBand(6.0000000001)).toBe('moderate') // rounded at 1e-9 before ceil
    expect(psiBand(8)).toBe('high')
    expect(psiBand(8.01)).toBe('very_high')
    expect(psiBand(-1)).toBe('no_little')
    expect(psiDisplay(12.3)).toBe(10)
    expect(psiDisplay(-0.4)).toBe(0)
    expect(psiDisplay(5.5)).toBe(5.5)
  })

  it('aPSI fixture vectors, including HRcrit and CTcrit', () => {
    for (const a of fx.apsi_vectors) {
      const crit = apsiCritical(a.ct, a.age, a.tsk)
      expect(Math.abs(crit.hrCritBpm - a.hr_crit)).toBeLessThan(1e-9)
      expect(Math.abs(crit.ctCritC - a.ct_crit)).toBeLessThan(1e-9)
      const v = apsi(a.ct, a.hr, a.ct_rest, a.hr_rest, a.age, a.tsk) as number
      accuracy.apsi = Math.max(accuracy.apsi, Math.abs(v - a.apsi))
      expect(Math.abs(v - a.apsi)).toBeLessThan(1e-6)
    }
    expect(apsi(38, 150, 39.6, 70, 30)).toBeNull()
  })

  it('HR0 baseline: lowest seated 5-min mean, else the first 5 usable shift minutes', () => {
    expect(psiHrBaseline([70, 68, 66, 67, 69, 72, 75])).toBeCloseTo(68, 12)
    expect(psiHrBaseline([70, null, 66, 67, 69, 72], [null, 80, 82, 84, 86, 88, 90])).toBeCloseTo(84, 12)
    expect(psiHrBaseline([], [80, 82])).toBeNull()
  })
})

// ─────────────────────────────── SQI ───────────────────────────────

describe('minute SQI (§10.4)', () => {
  it('fixture vectors: ψ, validity, mean HR, flags and rScale', () => {
    for (const v of fx.sqi_vectors) {
      const r = minuteSqi(v.samples.map(([tSec, bpm, contactOk]) => ({ tSec, bpm, contactOk })), v.expected_interval_s)
      accuracy.sqi = Math.max(accuracy.sqi, Math.abs(r.sqi - v.psi))
      expect(Math.abs(r.sqi - v.psi), v.name).toBeLessThan(1e-6)
      expect(r.minuteValid, v.name).toBe(v.valid)
      if (v.hr_mean === null) expect(r.hrMeanBpm, v.name).toBeNull()
      else expect(Math.abs((r.hrMeanBpm as number) - v.hr_mean), v.name).toBeLessThan(1e-6)
      expect(r.flags, v.name).toEqual(v.flags)
      if (v.r_scale === null) expect(r.rScale, v.name).toBe(Infinity)
      else expect(Math.abs(r.rScale - v.r_scale), v.name).toBeLessThan(1e-6)
    }
  })

  it('§10.11 inline SQI: clean ψ 1 rScale 1; 6-s double-rate lock ψ 0.8333 rScale 1.552707', () => {
    const clean = fx.sqi_vectors.find((v) => v.name === 'clean_1hz')
    const lock = fx.sqi_vectors.find((v) => v.name === 'harmonic_jump_6s')
    const toSamples = (s: [number, number | null, boolean][]) => s.map(([tSec, bpm, contactOk]) => ({ tSec, bpm, contactOk }))
    const c = minuteSqi(toSamples(clean?.samples ?? []), 1)
    expect([c.sqi, c.minuteValid, c.rScale]).toEqual([1, true, 1])
    const l = minuteSqi(toSamples(lock?.samples ?? []), 1)
    expect(l.sqi).toBeCloseTo(0.8333333, 6)
    expect(l.rScale).toBeCloseTo(1.552707, 6)
    expect(l.nValid).toBe(50)
  })

  it('flags sustained > 200 bpm with good contact for the §4.3 item 3 rule', () => {
    const high = Array.from({ length: 60 }, (_, i) => ({ tSec: i, bpm: 210 + (i % 3), contactOk: true }))
    const r = minuteSqi(high, 1)
    expect(r.minuteValid).toBe(false)
    expect(r.implausibleHighHr).toBe(true)
    const offSkin = high.map((s) => ({ ...s, contactOk: false }))
    expect(minuteSqi(offSkin, 1).implausibleHighHr).toBe(false)
  })
})

// ─────────────────────────────── physiology channel ───────────────────────────────

const T_EVAL = at(120)
function steadyMinutes(n: number, m: Omit<PhysioMinute, 't'>): PhysioMinute[] {
  return Array.from({ length: n }, (_, i) => ({ ...m, t: T_EVAL - (n - 1 - i) * MINUTE_MS }))
}
const baseInput = (minutes: PhysioMinute[], extra: Partial<PhysiologyInput> = {}): PhysiologyInput => ({
  t: T_EVAL,
  minutes,
  initT: T0,
  consented: true,
  physioDisabled: false,
  ageYears: 35,
  conservativeMode: false,
  ...extra,
})

const REASON_TO_DRIVER: Record<string, string> = {
  'ECTEMP_GE_39.0': 'ectemp_ge_39_0',
  'ECTEMP_GE_38.4': 'ectemp_ge_38_4',
  'ECTEMP_GE_38.0': 'ectemp_ge_38_0_conservative',
  'ECTEMP_GE_38.0_advisory_prompt_checkin': 'ectemp_ge_38_0_advisory',
  PSI_VERY_HIGH: 'psi_very_high',
  PSI_HIGH: 'psi_high',
  PSI_MODERATE_advisory: 'psi_moderate_advisory',
  HR_SUSTAINED_GT_180_MINUS_AGE: 'hr_over_180_minus_age',
  PHYSIO_INVALID_ignored: 'physio_unavailable_signal_unusable',
}
const FLOOR_TO_TIER: Record<string, ClinicalTier> = { T1_rest_cool_notify_supervisor: 1, T2_first_aider_now: 2 }

describe('physiologyLevel (§10.5 floors; clinical_rules_fixtures physio vectors)', () => {
  for (const [i, v] of cfx.physio_escalation_vectors.entries()) {
    const inp = v.input
    it(`vector ${i}: ECTemp ${inp.ectemp}, PSI ${inp.psi}, HR ${inp.hr_sustained_5min}, valid ${inp.channel_valid}, conservative ${inp.conservative_mode}`, () => {
      const minutes = steadyMinutes(15, { valid: inp.channel_valid, hrBpm: inp.hr_sustained_5min, ctC: inp.ectemp, psi: inp.psi })
      const res = physiologyLevel(baseInput(minutes, { ageYears: inp.age, conservativeMode: inp.conservative_mode }))
      const tier = v.expected.floor === null ? 0 : FLOOR_TO_TIER[v.expected.floor]
      expect(res.tier).toBe(tier)
      expect(res.level).toBe(TIER_TO_LEVEL[tier])
      expect(res.available).toBe(inp.channel_valid)
      const ids = res.drivers.map((d) => d.id).filter((id) => id !== 'physio_no_warning' && id !== 'hr_limit_age_unknown')
      expect(new Set(ids)).toEqual(new Set(v.expected.reasons.map((r) => REASON_TO_DRIVER[r])))
      if (v.expected.reasons.some((r) => r.includes('advisory'))) expect(res.actions).toContain('symptom_checkin')
      if (tier >= 1) expect(res.actions).toEqual(expect.arrayContaining(['symptom_checkin', 'buddy_check']))
      if (tier === 2) expect(res.actions).toContain('first_aider_check')
      if (v.expected.reasons.length === 0) expect(res.drivers.map((d) => d.id)).toContain('physio_no_warning')
    })
  }

  it('§10.11 inline: 38.45/6.4/HR 150 age 35 → T1; 39.05/8.6 → T2; invalid → none; 38.1 conservative → T1', () => {
    const lvl = (ct: number, psi: number, hr: number, extra: Partial<PhysiologyInput> = {}, valid = true) =>
      physiologyLevel(baseInput(steadyMinutes(15, { valid, hrBpm: hr, ctC: ct, psi }), extra)).tier
    expect(lvl(38.45, 6.4, 150)).toBe(1)
    expect(lvl(39.05, 8.6, 120)).toBe(2)
    expect(lvl(39.5, 9.5, 170, {}, false)).toBe(0)
    expect(lvl(38.1, 3, 100, { conservativeMode: true })).toBe(1)
    expect(lvl(38.1, 3, 100)).toBe(0)
  })

  it('requires 5 sustained valid minutes; an invalid minute neither counts nor resets the run', () => {
    const m = steadyMinutes(15, { valid: true, hrBpm: 110, ctC: 38.5, psi: 3 })
    m[12] = { ...m[12], ctC: 38.3 } // one of the last 5 valid minutes below 38.4
    const r = physiologyLevel(baseInput(m))
    expect(r.tier).toBe(0)
    expect(r.drivers.map((d) => d.id)).toContain('ectemp_ge_38_0_advisory')

    const m2 = steadyMinutes(15, { valid: true, hrBpm: 110, ctC: 38.5, psi: 3 })
    m2[12] = { ...m2[12], valid: false, hrBpm: null, ctC: 37.0, psi: null } // dropout inside the run
    const r2 = physiologyLevel(baseInput(m2))
    expect(r2.tier).toBe(1)
    expect(r2.drivers.map((d) => d.id)).toContain('ectemp_ge_38_4')
  })

  it('is unavailable (never reassurance) when not consented, medicated, warming up or < 10 of 15 minutes valid', () => {
    const hot = steadyMinutes(15, { valid: true, hrBpm: 190, ctC: 39.6, psi: 9.5 })
    const cases: [Partial<PhysiologyInput>, string][] = [
      [{ consented: false }, 'not_consented'],
      [{ physioDisabled: true }, 'hr_suppressing_medication'],
      [{ initT: T_EVAL - 29 * MINUTE_MS }, 'warmup'],
    ]
    for (const [extra, reason] of cases) {
      const r = physiologyLevel(baseInput(hot, extra))
      expect(r.available).toBe(false)
      expect(r.level).toBe('safe')
      expect(r.status.reason).toBe(reason)
      expect(r.display).toBeNull()
      expect(r.drivers.every((d) => d.direction === 'info')).toBe(true)
    }
    const medicated = physiologyLevel(baseInput(hot, { physioDisabled: true }))
    expect(medicated.drivers[0].text.toLowerCase()).not.toContain('medic') // no clinical detail in the text

    const nine = hot.map((x, i) => (i < 6 ? { ...x, valid: false, hrBpm: null } : x))
    const r9 = physiologyLevel(baseInput(nine))
    expect(r9.status.reason).toBe('signal_unusable')
    expect(r9.status.signalQuality).toBe('unusable')
    expect(r9.actions).toContain('check_sensor')
    const ten = hot.map((x, i) => (i < 5 ? { ...x, valid: false, hrBpm: null } : x))
    const r10 = physiologyLevel(baseInput(ten))
    expect(r10.available).toBe(true)
    expect(r10.status.signalQuality).toBe('degraded')
    expect(r10.tier).toBe(2)
  })

  it('signal quality: good / degraded / unusable / absent', () => {
    const ok = steadyMinutes(15, { valid: true, hrBpm: 100, ctC: 37.2, psi: 1 })
    const st = (minutes: PhysioMinute[], consented = true) =>
      physioChannelStatus({ t: T_EVAL, minutes, initT: T0, consented, physioDisabled: false }).signalQuality
    expect(st(ok)).toBe('good')
    expect(st(ok.map((x, i) => (i < 3 ? { ...x, valid: false } : x)))).toBe('degraded')
    expect(st(ok.map((x, i) => (i < 6 ? { ...x, valid: false } : x)))).toBe('unusable')
    expect(st([])).toBe('absent')
    expect(st(ok, false)).toBe('absent')
  })

  it('unknown age uses the protective NIOSH age-50 HR limit (130 bpm)', () => {
    const m = steadyMinutes(15, { valid: true, hrBpm: 135, ctC: 37.5, psi: 3 })
    const r = physiologyLevel(baseInput(m, { ageYears: undefined }))
    expect(r.tier).toBe(1)
    expect(r.drivers.map((d) => d.id)).toEqual(expect.arrayContaining(['hr_limit_age_unknown', 'hr_over_180_minus_age']))
    expect(physiologyLevel(baseInput(m, { ageYears: 30 })).tier).toBe(0)
  })

  it('> 200 bpm with good contact for 2 min prompts a check-in and a buddy check even when the channel is invalid', () => {
    const m = steadyMinutes(15, { valid: true, hrBpm: 100, ctC: 37.2, psi: 1 })
    for (const i of [13, 14]) m[i] = { ...m[i], valid: false, hrBpm: null, implausibleHighHr: true }
    const r = physiologyLevel(baseInput(m))
    expect(r.drivers.map((d) => d.id)).toContain('hr_implausible_high')
    expect(r.actions).toEqual(expect.arrayContaining(['symptom_checkin', 'buddy_check']))
    expect(r.level).toBe('safe')
  })

  it('an evaluation time between minute stamps still uses the latest minute', () => {
    const m = steadyMinutes(15, { valid: true, hrBpm: 100, ctC: 37.6, psi: 1 })
    const r = physiologyLevel(baseInput(m, { t: T_EVAL + 40_000 }))
    expect(r.available).toBe(true)
    expect(r.display?.text).toBe('≈37.6 ± 0.6')
    const hi = steadyMinutes(15, { valid: false, hrBpm: null, ctC: 37.2, psi: null, implausibleHighHr: true })
    expect(physiologyLevel(baseInput(hi, { t: T_EVAL + 40_000 })).drivers.map((d) => d.id)).toContain('hr_implausible_high')
  })

  it('shows the ECTemp band only while valid, and never goes beyond T2 or calls 998', () => {
    const r = physiologyLevel(baseInput(steadyMinutes(15, { valid: true, hrBpm: 199, ctC: 41.5, psi: 10 })))
    expect(r.tier).toBe(2)
    expect(r.level).toBe('stop')
    expect(r.actions).not.toContain('call_998')
    expect(r.display?.text).toBe('≈41.5 ± 0.6')
  })

  it('property: an invalid channel never raises or lowers; a valid one never lowers and never reaches T3', () => {
    const rnd = prng(42)
    for (let i = 0; i < 300; i++) {
      const minutes = Array.from({ length: 15 }, (_, k) => ({
        t: T_EVAL - (14 - k) * MINUTE_MS,
        valid: rnd() < 0.9,
        hrBpm: 60 + rnd() * 140,
        ctC: 36.5 + rnd() * 4.5,
        psi: rnd() * 11,
      }))
      const mode = Math.floor(rnd() * 4)
      const invalidExtra: Partial<PhysiologyInput>[] = [
        { consented: false },
        { physioDisabled: true },
        { initT: T_EVAL - Math.floor(rnd() * 30) * MINUTE_MS },
        { minutes: minutes.map((m, k) => (k < 6 ? { ...m, valid: false } : m)) },
      ]
      const inv = physiologyLevel(baseInput(minutes, { ...invalidExtra[mode], ageYears: 20 + rnd() * 40 }))
      expect(inv.available).toBe(false)
      expect(inv.level).toBe('safe')
      expect(inv.tier).toBe(0)
      expect(inv.drivers.some((d) => d.direction !== 'info')).toBe(false)

      const valid = physiologyLevel(baseInput(minutes.map((m) => ({ ...m, valid: true })), { conservativeMode: rnd() < 0.5 }))
      expect(valid.available).toBe(true)
      expect(valid.tier).toBeLessThanOrEqual(2)
      expect(valid.level).not.toBe('emergency')
      expect(valid.drivers.some((d) => d.direction === 'lowers')).toBe(false)
    }
  })
})

describe('physio monitor (per-worker minute processing)', () => {
  it('reproduces the batch filter, derives HR0 from the first 5 usable minutes and feeds physiologyLevel', () => {
    const hr = [...Array<number>(5).fill(80), ...Array<number>(55).fill(150)]
    let st = physioMonitorInit(T0)
    hr.forEach((h, i) => {
      st = physioMonitorStep(st, at(i + 1), { hrMeanBpm: h, minuteValid: true, rScale: 1 })
    })
    const ref = ectempRun(hr)
    expect(st.track.ctC).toBe(ref.ctC[59])
    expect(st.hr0Bpm).toBe(80)
    expect(st.minutes).toHaveLength(15)
    const last = st.minutes[st.minutes.length - 1]
    expect(last.psi).toBeCloseTo(psiMoran(ref.ctC[59], 150, 37.1, 80) as number, 12)
    expect(physioMonitorStep(st, at(60), { hrMeanBpm: 150, minuteValid: true, rScale: 1 })).toBe(st)

    const res = physiologyLevel({ t: at(60), minutes: st.minutes, initT: st.track.initT, consented: true, physioDisabled: false, ageYears: 35, conservativeMode: false })
    expect(res.available).toBe(true)
    expect(res.tier).toBeGreaterThanOrEqual(1)
    expect(res.display?.text).toMatch(/^≈\d\d\.\d ± 0\.6$/)
  })

  it('an invalid minute is a null minute for ECTemp and carries no HR or PSI', () => {
    let st = physioMonitorInit(T0, { seatedHr0Bpm: 70 })
    st = physioMonitorStep(st, at(1), { hrMeanBpm: 100, minuteValid: true, rScale: 1 })
    st = physioMonitorStep(st, at(2), { hrMeanBpm: 102, minuteValid: false, rScale: Infinity })
    const last = st.minutes[1]
    expect(last.valid).toBe(false)
    expect(last.hrBpm).toBeNull()
    expect(last.psi).toBeNull()
    expect(st.track.missingRunMin).toBe(1)
  })
})

// ─────────────────────────────── wave-2a review fixes ───────────────────────────────

const toRaw = (s: [number, number | null, boolean][]) => s.map(([tSec, bpm, contactOk]) => ({ tSec, bpm, contactOk }))
const sameSqi = (a: ReturnType<typeof minuteSqi>, b: ReturnType<typeof minuteSqi>): void => {
  expect(a.sqi).toBe(b.sqi)
  expect(a.minuteValid).toBe(b.minuteValid)
  expect(a.hrMeanBpm).toBe(b.hrMeanBpm)
  expect(a.rScale).toBe(b.rScale)
  expect(a.nValid).toBe(b.nValid)
  expect(a.flags).toEqual(b.flags)
  expect(a.implausibleHighHr).toBe(b.implausibleHighHr)
}

describe('minute SQI robustness (review fixes; fixture parity kept)', () => {
  it("raises 'contact_lost' for off-skin samples without a reading (bpm null), without changing validity", () => {
    const clean = Array.from({ length: 60 }, (_, i) => ({ tSec: i, bpm: 120 + (i % 4), contactOk: true }))
    const offSkinNull = clean.map((s, i) => (i < 10 ? { tSec: s.tSec, bpm: null, contactOk: false } : s))
    const droppedNull = clean.map((s, i) => (i < 10 ? { tSec: s.tSec, bpm: null, contactOk: true } : s))
    const off = minuteSqi(offSkinNull, 1)
    const dropped = minuteSqi(droppedNull, 1)
    expect(off.flags).toContain('contact_lost')
    expect(dropped.flags).not.toContain('contact_lost')
    expect([off.sqi, off.nValid, off.minuteValid, off.hrMeanBpm, off.rScale]).toEqual([
      dropped.sqi,
      dropped.nValid,
      dropped.minuteValid,
      dropped.hrMeanBpm,
      dropped.rScale,
    ])
    // a whole minute off-skin with no reading at all: invalid and flagged (was silent before the fix)
    const allOff = minuteSqi(clean.map((s) => ({ tSec: s.tSec, bpm: null, contactOk: false })), 1)
    expect(allOff.minuteValid).toBe(false)
    expect(allOff.flags).toEqual(['contact_lost', 'low_coverage'])
    // flag order stays as in the reference fixtures: out_of_range, contact_lost, ratio_jump, flatline, low_coverage
    const mixed = minuteSqi([{ tSec: 0, bpm: 250, contactOk: true }, { tSec: 1, bpm: null, contactOk: false }], 1)
    expect(mixed.flags).toEqual(['out_of_range', 'contact_lost', 'low_coverage'])
  })

  it('every fixture vector gives the same result when stamped with absolute seconds (k·60 + s)', () => {
    for (const v of fx.sqi_vectors) {
      const ref = minuteSqi(toRaw(v.samples), v.expected_interval_s)
      for (const k of [1, 5, 7, 1440]) {
        const shifted = toRaw(v.samples).map((s) => ({ ...s, tSec: s.tSec + 60 * k }))
        sameSqi(minuteSqi(shifted, v.expected_interval_s), ref)
      }
    }
  })

  it('a harmonic lock stamped with absolute seconds is still caught by the 10-s ratio check', () => {
    const lock = fx.sqi_vectors.find((v) => v.name === 'harmonic_halving_5s')
    expect(lock?.flags).toContain('ratio_jump')
    const minute5 = toRaw(lock?.samples ?? []).map((s) => ({ ...s, tSec: 300 + s.tSec }))
    const r = minuteSqi(minute5, 1)
    expect(r.flags).toContain('ratio_jump')
    expect(r.sqi).toBeCloseTo(0.833333, 6)
    // order of the samples does not matter
    expect(minuteSqi([...minute5].reverse(), 1).flags).toEqual(r.flags)
  })

  it('samples beyond 60 s relative (a window crossing a minute boundary) are still ratio-checked', () => {
    const base = Array.from({ length: 60 }, (_, i) => ({ tSec: 30 + i, bpm: 80, contactOk: true }))
    // a 2.25x jump inside the 10-s segment [70, 80) s relative, i.e. after the first minute boundary
    const jumped = base.map((s) => (s.tSec >= 72 && s.tSec < 75 ? { ...s, bpm: 180 } : s))
    const r = minuteSqi(jumped, 1)
    expect(r.flags).toContain('ratio_jump')
    expect(r.nValid).toBe(50)
  })

  it('ignores a non-finite tSec when locating the minute (the other samples keep their segments)', () => {
    const lock = toRaw(fx.sqi_vectors.find((v) => v.name === 'harmonic_jump_6s')?.samples ?? [])
    const withNaN = [{ tSec: Number.NaN, bpm: 100, contactOk: true }, ...lock.map((s) => ({ ...s, tSec: s.tSec + 120 }))]
    expect(minuteSqi(withNaN, 1).flags).toContain('ratio_jump')
  })
})

describe('physiology channel start-up and dropout (review fixes)', () => {
  const evalAt = (st: ReturnType<typeof physioMonitorInit>, t: number) =>
    physiologyLevel({ t, minutes: st.minutes, initT: st.track.initT, consented: true, physioDisabled: false, ageYears: 35, conservativeMode: false })

  it("reports 'warmup' (never 'signal_unusable' or check_sensor) for the whole 30-min warm-up, then becomes valid", () => {
    let st = physioMonitorInit(T0)
    for (let i = 1; i <= 40; i++) {
      st = physioMonitorStep(st, at(i), { hrMeanBpm: 110, minuteValid: true, rScale: 1 })
      const r = evalAt(st, at(i))
      if (i < 30) {
        expect(r.status.reason, `minute ${i}`).toBe('warmup')
        expect(r.available).toBe(false)
        expect(r.actions, `minute ${i}`).not.toContain('check_sensor')
        expect(r.drivers.map((d) => d.id)).toEqual(['physio_unavailable_warmup'])
      } else {
        expect(r.available, `minute ${i}`).toBe(true)
        expect(r.status.reason).toBeNull()
      }
    }
  })

  it('a band that sends nothing during the warm-up is warm-up; after it, no_signal raises check_sensor', () => {
    const during = physioChannelStatus({ t: at(12), minutes: [], initT: T0, consented: true, physioDisabled: false })
    expect(during.reason).toBe('warmup')
    expect(during.signalQuality).toBe('absent')
    const r = physiologyLevel(baseInput([], { t: at(12), initT: T0 }))
    expect(r.actions).not.toContain('check_sensor')
    const after = physiologyLevel(baseInput([], { t: at(31), initT: T0 }))
    expect(after.status.reason).toBe('no_signal')
    expect(after.actions).toContain('check_sensor')
  })

  it('consent and the medication flag still take precedence over the warm-up', () => {
    const st = (extra: Partial<PhysiologyInput>) =>
      physioChannelStatus({ t: at(5), minutes: [], initT: T0, consented: true, physioDisabled: false, ...extra }).reason
    expect(st({ consented: false })).toBe('not_consented')
    expect(st({ physioDisabled: true })).toBe('hr_suppressing_medication')
  })

  it('a dropout after the warm-up raises check_sensor; when the signal returns after > 30 min the warm-up restarts without it', () => {
    let st = physioMonitorInit(T0)
    for (let i = 1; i <= 45; i++) st = physioMonitorStep(st, at(i), { hrMeanBpm: 110, minuteValid: true, rScale: 1 })
    expect(evalAt(st, at(45)).available).toBe(true)
    let sawCheckSensor = false
    for (let i = 46; i <= 80; i++) {
      st = physioMonitorStep(st, at(i), { hrMeanBpm: null, minuteValid: false, rScale: Infinity })
      const r = evalAt(st, at(i))
      if (r.status.validMinutesInWindow < 10) {
        expect(r.available, `minute ${i}`).toBe(false)
        expect(r.status.reason, `minute ${i}`).toBe('signal_unusable')
        expect(r.actions).toContain('check_sensor')
        sawCheckSensor = true
      } else {
        expect(r.available, `minute ${i}`).toBe(true)
      }
    }
    expect(sawCheckSensor).toBe(true)
    st = physioMonitorStep(st, at(81), { hrMeanBpm: 110, minuteValid: true, rScale: 1 })
    expect(st.track.initT).toBe(at(80)) // re-initialised after 35 missing minutes (§10.2 rule 3)
    const back = evalAt(st, at(81))
    expect(back.status.reason).toBe('warmup')
    expect(back.actions).not.toContain('check_sensor')
  })
})
