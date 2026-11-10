import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import {
  minutesToLimit,
  phsConstants,
  phsInitialState,
  phsLimitMinutes,
  phsRun,
  phsStep,
  phsValidity,
  phsVapourPressureKpa,
  PHS_VALIDITY_LIMITS,
  type PhsConstants,
  type PhsInput,
  type PhsModel,
  type PhsOptions,
  type PhsPosture,
  type PhsResult,
  type PhsState,
  type PhsValidityField,
} from './phs'

// ─────────────────────────────── Fixture types (fixtures/phs.json, schema 1.0.0) ───────────────────────────────

interface FxInputs {
  tdb: number
  tr: number
  v: number
  rh: number
  met_wm2: number
  wme: number
  wme_wm2?: number
  clo: number
  posture: PhsPosture
  model: PhsModel
  i_mst: number
  a_p: number
  f_r: number
  drink: 0 | 1
  weight: number
  height: number
  walk_sp: number
  theta: number
  acclimatized: 0 | 100
  duration: number
  t_sk: number
  t_cr: number
  t_re: number
  t_cr_eq: number
  t_sk_t_cr_wg: number
  sweat_rate_watt: number
  evap_load_wm2_min: number
  p_a_kpa: number
}

interface FxOutputs {
  t_re: number
  t_sk: number
  t_cr: number
  t_cr_eq: number
  t_sk_t_cr_wg: number
  d_lim_loss_50: number
  d_lim_loss_95: number
  d_lim_t_re: number
  sweat_rate_watt: number
  sweat_loss_g: number
  evap_load_wm2_min: number
}

interface FxMargin {
  minute: number
}

interface FxVector {
  id: string
  group: 'iso_7933_2004_annex_f' | 'iso_7933_2023_annex_f' | 'abu_dhabi' | 'edge'
  inputs: FxInputs
  outputs: FxOutputs
  validity: { failing: string[]; within_limits: boolean }
  derived: Record<string, number>
  d_lim_margins: { d_lim_t_re: FxMargin | null; d_lim_loss_95: FxMargin | null }
  variants?: Record<string, FxOutputs>
  iso_published?: {
    t_re: number
    sweat_loss_g: number
    d_lim_t_re: number | null
    d_lim_loss_50?: number
    d_lim_loss_95: number
    sweat_rate_final_g_per_h?: number
  }
}

interface FxSegment {
  t_start_min: number
  duration: number
  outputs: FxOutputs
}

interface FxChain {
  id: string
  model: PhsModel
  segments_inputs: FxInputs[]
  single_call_120min?: { outputs: FxOutputs }
  pythermalcomfort_chained: FxSegment[]
  reference_continuous_recommended: FxSegment[]
  reference_continuous_summary: {
    shift_minutes: number
    first_minute_t_re_ge_38: number | null
    first_minute_sweat_loss_ge_dmax95: number | null
    max_t_re: number
    t_re_by_minute_every_15: Array<[number, number]>
  }
}

interface FxTrace {
  vector_id: string
  model: PhsModel
  rows: Array<{
    minute: number
    t_re: number
    t_sk: number
    t_cr: number
    sweat_rate_watt: number
    sweat_loss_g: number
  }>
}

interface PhsFixture {
  vectors: FxVector[]
  chains: FxChain[]
  traces: FxTrace[]
}

const fx = JSON.parse(readFileSync(new URL('../../fixtures/phs.json', import.meta.url), 'utf8')) as PhsFixture

const VARIANT_TCL = 'reference:hc_tcl_iter'
const VARIANT_3PCT = 'reference:drink0_threshold_3pct_without_x0.6'
const VARIANT_SP5783 = 'reference:sp_heat_57.83_(2004_BASIC)'

/** pythermalcomfort-parity options (the fixture engine). */
const PYTC: PhsOptions = { hcMode: 'pythermalcomfort', drink0Mode: 'pythermalcomfort', spHeatBasis: 'pythermalcomfort' }

// Recommended port tolerances (fixtures/phs.json conventions.recommended_tolerances_for_port).
const TOL = { tempC: 1e-6, wg: 1e-8, swWm2: 1e-6, waterG: 1e-4, evap: 1e-3 }

function vector(id: string): FxVector {
  const v = fx.vectors.find((x) => x.id === id)
  if (!v) throw new Error(`fixture vector ${id} missing`)
  return v
}

function chain(id: string): FxChain {
  const c = fx.chains.find((x) => x.id === id)
  if (!c) throw new Error(`fixture chain ${id} missing`)
  return c
}

function toInput(i: FxInputs): PhsInput {
  return {
    tdbC: i.tdb,
    trC: i.tr,
    paKpa: i.p_a_kpa,
    vMs: i.v,
    metabolicWm2: i.met_wm2,
    wmeWm2: i.wme_wm2 ?? i.wme * 58.15,
    clo: i.clo,
    posture: i.posture,
    acclimatized: i.acclimatized === 100,
    drink: i.drink,
    massKg: i.weight,
    heightM: i.height,
    walkSpeedMs: i.walk_sp,
    thetaDeg: i.theta,
    iMst: i.i_mst,
    aP: i.a_p,
    fR: i.f_r,
  }
}

/** Initial state carrying the fixture's 7 pythermalcomfort state kwargs; a fresh exposure (minute-1 override pending). */
function toInit(i: FxInputs): PhsState {
  return {
    ...phsInitialState(toInput(i), { model: i.model }),
    tSkC: i.t_sk,
    tCrC: i.t_cr,
    tReC: i.t_re,
    tCrEqC: i.t_cr_eq,
    skinCoreWeight: i.t_sk_t_cr_wg,
    sweatRateWm2: i.sweat_rate_watt,
    evapLoadWm2Min: i.evap_load_wm2_min,
  }
}

function runVector(v: FxVector, opts: PhsOptions = PYTC): PhsResult {
  return phsRun(toInput(v.inputs), { ...opts, model: v.inputs.model, durationMin: v.inputs.duration }, toInit(v.inputs))
}

/** Accumulates the worst |Δ| per quantity so the achieved accuracy can be reported. */
const worst: Record<string, number> = {}
function close(actual: number, expected: number, tol: number, label: string, key: string): void {
  const d = Math.abs(actual - expected)
  worst[key] = Math.max(worst[key] ?? 0, d)
  expect(d, `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol)
}

function relClose(actual: number, expected: number, rel: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: ${actual} vs ${expected}`).toBeLessThanOrEqual(rel * Math.max(1, Math.abs(expected)))
}

function checkPhysiology(r: PhsResult, o: FxOutputs, label: string): void {
  close(r.tReC, o.t_re, TOL.tempC, `${label} t_re`, 'tempC')
  close(r.tSkC, o.t_sk, TOL.tempC, `${label} t_sk`, 'tempC')
  close(r.tCrC, o.t_cr, TOL.tempC, `${label} t_cr`, 'tempC')
  close(r.tCrEqC, o.t_cr_eq, TOL.tempC, `${label} t_cr_eq`, 'tempC')
  close(r.skinCoreWeight, o.t_sk_t_cr_wg, TOL.wg, `${label} alpha`, 'wg')
  close(r.sweatRateWm2, o.sweat_rate_watt, TOL.swWm2, `${label} SW_p`, 'swWm2')
  close(r.waterLossG, o.sweat_loss_g, TOL.waterG, `${label} water`, 'waterG')
  close(r.evapLoadWm2Min, o.evap_load_wm2_min, TOL.evap, `${label} evap load`, 'evap')
}

/**
 * pythermalcomfort reports `duration` when a limit is not reached; Zill reports null. A fixture value below the duration
 * must match exactly. A value equal to the duration means "not reached" (or reached exactly at the last minute).
 */
function expectDlim(ours: number | null | undefined, theirs: number, duration: number, label: string): void {
  if (theirs < duration) expect(ours, label).toBe(theirs)
  else expect(ours === null || ours === duration, `${label}: ${String(ours)} vs fallback ${theirs}`).toBe(true)
}

// ─────────────────────────────── Oracle parity (pythermalcomfort 4.8.1) ───────────────────────────────

describe('PHS vs pythermalcomfort 4.8.1 (fixtures/phs.json, unrounded outputs)', () => {
  it('covers 50 vectors in both editions', () => {
    expect(fx.vectors).toHaveLength(50)
    expect(fx.vectors.filter((v) => v.inputs.model === '7933-2004').length).toBeGreaterThanOrEqual(15)
  })

  for (const v of fx.vectors) {
    it(`${v.id} (${v.inputs.model})`, () => {
      const r = runVector(v)
      const o = v.outputs
      const dur = v.inputs.duration
      checkPhysiology(r, o, v.id)

      // D_lim,tre: exact when reached (d_lim_margins says so), otherwise explicit null instead of `duration`.
      if (v.d_lim_margins.d_lim_t_re) expect(r.dLimTReMin).toBe(o.d_lim_t_re)
      else {
        expect(o.d_lim_t_re).toBe(dur)
        expect(r.dLimTReMin).toBeNull()
      }

      // D_lim,loss (2023) / D_lim,loss95 (2004), drink = 0 rule (× 0.6 after the loop) included.
      if (v.d_lim_margins.d_lim_loss_95) {
        const expected = v.inputs.drink === 0 ? v.d_lim_margins.d_lim_loss_95.minute * 0.6 : v.d_lim_margins.d_lim_loss_95.minute
        expect(o.d_lim_loss_95).toBe(expected)
        expect(r.dLimLossMin).toBe(o.d_lim_loss_95)
      } else if (v.id === 'E10') {
        // Documented, deliberate deviation (see the E10 test below): pythermalcomfort's 0.6 rule misses this case.
        expect(o.d_lim_loss_95).toBe(dur)
        expect(r.dLimLossMin).not.toBeNull()
      } else {
        expect(o.d_lim_loss_95).toBe(dur)
        expect(r.dLimLossMin).toBeNull()
      }

      if (v.inputs.model === '7933-2004') {
        if (v.id !== 'E10') expectDlim(r.dLimLoss50Min, o.d_lim_loss_50, dur, `${v.id} D_lim,loss50`)
      } else {
        expect(r.dLimLoss50Min).toBeUndefined()
      }
    })
  }

  it('reproduces the per-minute traces (ISO2004-F01, AD01) for all 480 minutes', () => {
    for (const t of fx.traces) {
      const v = vector(t.vector_id)
      const r = phsRun(toInput(v.inputs), { ...PYTC, model: t.model, durationMin: 480, trace: true }, toInit(v.inputs))
      expect(r.trace).toHaveLength(480)
      t.rows.forEach((row, k) => {
        const p = r.trace?.[k]
        if (!p) throw new Error('missing trace point')
        expect(p.minute).toBe(row.minute)
        // Fixture traces carry 12 significant digits.
        relClose(p.tReC, row.t_re, 1e-10, `${t.vector_id} min ${row.minute} t_re`)
        relClose(p.tSkC, row.t_sk, 1e-10, `${t.vector_id} min ${row.minute} t_sk`)
        relClose(p.tCrC, row.t_cr, 1e-10, `${t.vector_id} min ${row.minute} t_cr`)
        relClose(p.sweatRateWm2, row.sweat_rate_watt, 1e-10, `${t.vector_id} min ${row.minute} SW_p`)
        relClose(p.waterLossG, row.sweat_loss_g, 1e-10, `${t.vector_id} min ${row.minute} water`)
      })
    }
  })

  it('reproduces every pre-loop constant of section 4.2 (fixture `derived`)', () => {
    const pick: Array<[string, (k: PhsConstants) => number]> = [
      ['a_dubois', (k) => k.aDuM2],
      ['sp_heat', (k) => k.spHeatWMinM2K],
      ['sw_max', (k) => k.swMaxWm2],
      ['w_max', (k) => k.wMax],
      ['fcl', (k) => k.fcl],
      ['i_cl_st', (k) => k.iClStM2KW],
      ['i_tot_st', (k) => k.iTotStM2KW],
      ['v_r', (k) => k.vRMs],
      ['walk_sp_effective', (k) => k.walkSpeedMs],
      ['corr_cl', (k) => k.corrCl],
      ['corr_ia', (k) => k.corrIa],
      ['corr_tot', (k) => k.corrTot],
      ['i_tot_dyn', (k) => k.iTotDynM2KW],
      ['i_a_dyn', (k) => k.iADynM2KW],
      ['i_cl_dyn', (k) => k.iClDynM2KW],
      ['corr_e', (k) => k.corrE],
      ['im_dyn', (k) => k.imDyn],
      ['r_t_dyn', (k) => k.rTDynM2KpaW],
      ['t_exp', (k) => k.tExpC],
      ['c_res', (k) => k.cResWm2],
      ['e_res', (k) => k.eResWm2],
      ['z', (k) => k.zWm2K],
      ['hc_dyn_initial', (k) => k.hcInitialWm2K],
      ['f_cl_r', (k) => k.fClR],
      ['t_cr_eq_m', (k) => k.tCrEqMC],
    ]
    for (const v of fx.vectors) {
      const i = v.inputs
      const k = phsConstants(toInput(i), { model: i.model }, i.t_sk)
      for (const [name, get] of pick) relClose(get(k), v.derived[name] ?? Number.NaN, 1e-12, `${v.id} ${name}`)
      const is2023 = i.model === '7933-2023'
      const dMax95 = is2023 && i.drink === 0 ? k.dMax3PctG : k.dMax5PctG
      expect(dMax95, `${v.id} d_max_95`).toBe(v.derived.d_max_95)
      expect(is2023 ? dMax95 : k.dMax7p5PctG, `${v.id} d_max_50`).toBe(v.derived.d_max_50)
    }
  })

  it('converts RH to p_a with each edition\'s wrapper formula (Magnus 2023, Hyland-Wexler 2004)', () => {
    for (const v of fx.vectors) {
      relClose(phsVapourPressureKpa(v.inputs.tdb, v.inputs.rh, v.inputs.model), v.inputs.p_a_kpa, 1e-12, `${v.id} p_a`)
    }
    // Running from RH instead of p_a gives the same physiology.
    const v = vector('AD02')
    const { paKpa: _omit, ...rest } = toInput(v.inputs)
    void _omit
    const fromRh = phsRun({ ...rest, rhPct: v.inputs.rh }, { ...PYTC, durationMin: 480 })
    checkPhysiology(fromRh, v.outputs, 'AD02 from RH')
  })
})

// ─────────────────────────────── Documented variants ───────────────────────────────

describe('PHS documented variants (reference implementation, fixture `variants`)', () => {
  it('hcMode tclIteration matches `reference:hc_tcl_iter` for every 2023 vector', () => {
    const v2023 = fx.vectors.filter((v) => v.inputs.model === '7933-2023')
    expect(v2023.length).toBeGreaterThanOrEqual(30)
    for (const v of v2023) {
      const ref = v.variants?.[VARIANT_TCL]
      if (!ref) throw new Error(`${v.id}: variant missing`)
      const r = runVector(v, { ...PYTC, hcMode: 'tclIteration' })
      checkPhysiology(r, ref, `${v.id} tcl`)
      expectDlim(r.dLimTReMin, ref.d_lim_t_re, v.inputs.duration, `${v.id} tcl D_lim,tcr`)
      expectDlim(r.dLimLossMin, ref.d_lim_loss_95, v.inputs.duration, `${v.id} tcl D_lim,loss`)
    }
  })

  it('drink0Mode threshold3PctOnly matches the 3 %-only reading (AD15: 119 min instead of 71.4)', () => {
    const v = vector('AD15')
    const ref = v.variants?.[VARIANT_3PCT]
    if (!ref) throw new Error('variant missing')
    const r = runVector(v, { ...PYTC, drink0Mode: 'threshold3PctOnly' })
    checkPhysiology(r, ref, 'AD15 3%')
    expect(r.dLimLossMin).toBe(119)
    expect(ref.d_lim_loss_95).toBe(119)
    expect(runVector(v).dLimLossMin).toBe(71.39999999999999) // 119 × 0.6, as pythermalcomfort
  })

  it('spHeatBasis basic2004 (57.83) matches `reference:sp_heat_57.83_(2004_BASIC)` for the 2004 annex', () => {
    for (const v of fx.vectors.filter((x) => x.group === 'iso_7933_2004_annex_f')) {
      const ref = v.variants?.[VARIANT_SP5783]
      if (!ref) throw new Error(`${v.id}: variant missing`)
      const r = runVector(v, { ...PYTC, spHeatBasis: 'basic2004' })
      checkPhysiology(r, ref, `${v.id} 57.83`)
      expectDlim(r.dLimTReMin, ref.d_lim_t_re, 480, `${v.id} D_lim,tre`)
      expectDlim(r.dLimLossMin, ref.d_lim_loss_95, 480, `${v.id} D_lim,loss95`)
      expectDlim(r.dLimLoss50Min, ref.d_lim_loss_50, 480, `${v.id} D_lim,loss50`)
    }
  })

  it('under 2004 the per-minute t_sk h_c (2004 BASIC) equals pythermalcomfort wherever z dominates', () => {
    for (const v of fx.vectors.filter((x) => x.inputs.model === '7933-2004')) {
      const r = runVector(v, { ...PYTC, hcMode: 'tclIteration' })
      checkPhysiology(r, v.outputs, `${v.id} 2004 tsk-hc`)
    }
  })
})

// ─────────────────────────────── ISO published Annex F cases ───────────────────────────────

describe('ISO 7933 Annex F published cases', () => {
  const published2004 = fx.vectors.filter((v) => v.group === 'iso_7933_2004_annex_f')
  const published2023 = fx.vectors.filter((v) => v.group === 'iso_7933_2023_annex_f')

  /** Published D_lim 480 = not reached in the 480-min run. */
  function expectPublishedDlim(ours: number | null | undefined, pub: number | null | undefined, tol: number, label: string): void {
    if (pub === null || pub === undefined || pub >= 480) {
      expect(ours === null || ours === 480, `${label}: ${String(ours)} vs published ${String(pub)}`).toBe(true)
    } else {
      expect(ours, label).not.toBeNull()
      expect(Math.abs((ours as number) - pub), `${label}: ${String(ours)} vs published ${pub}`).toBeLessThanOrEqual(tol)
    }
  }

  it('2004 Annex F (10 cases), engine defaults: within 0.1 °C, 3 g and 1 min (pythermalcomfort agreement)', () => {
    expect(published2004).toHaveLength(10)
    for (const v of published2004) {
      const pub = v.iso_published
      if (!pub) throw new Error('published values missing')
      const r = runVector(v, { model: '7933-2004' })
      expect(Math.abs(r.tReC - pub.t_re), `${v.id} t_re`).toBeLessThanOrEqual(0.1 + 1e-9)
      expect(Math.abs(r.waterLossG - pub.sweat_loss_g), `${v.id} water`).toBeLessThanOrEqual(3)
      expectPublishedDlim(r.dLimTReMin, pub.d_lim_t_re, 1, `${v.id} D_lim,tre`)
      expectPublishedDlim(r.dLimLoss50Min, pub.d_lim_loss_50, 1, `${v.id} D_lim,loss50`)
      expectPublishedDlim(r.dLimLossMin, pub.d_lim_loss_95, 1, `${v.id} D_lim,loss95`)
    }
  })

  it('2004 Annex F with the 2004 BASIC c_sp (57.83): exact to the published 0.1 °C and minute, water within 0.4 g', () => {
    for (const v of published2004) {
      const pub = v.iso_published
      if (!pub) throw new Error('published values missing')
      const r = runVector(v, { model: '7933-2004', spHeatBasis: 'basic2004' })
      expect(Math.abs(r.tReC - pub.t_re), `${v.id} t_re ${r.tReC}`).toBeLessThanOrEqual(0.05 + 1e-9)
      expect(Math.abs(r.waterLossG - pub.sweat_loss_g), `${v.id} water`).toBeLessThanOrEqual(0.4)
      expectPublishedDlim(r.dLimTReMin, pub.d_lim_t_re, 0, `${v.id} D_lim,tre`)
      expectPublishedDlim(r.dLimLoss50Min, pub.d_lim_loss_50, 0, `${v.id} D_lim,loss50`)
      expectPublishedDlim(r.dLimLossMin, pub.d_lim_loss_95, 0, `${v.id} D_lim,loss95`)
    }
  })

  it('2023 Annex F (5 cases), engine defaults: within the stated annex residuals (~0.5 % water, 3 min D_lim,loss)', () => {
    expect(published2023).toHaveLength(5)
    for (const v of published2023) {
      const pub = v.iso_published
      if (!pub || pub.sweat_rate_final_g_per_h === undefined) throw new Error('published values missing')
      const r = runVector(v, {}) // engine defaults: 2023, tclIteration
      expect(Math.abs(r.tReC - pub.t_re), `${v.id} t_re ${r.tReC}`).toBeLessThanOrEqual(0.1)
      expect(Math.abs(r.waterLossG / pub.sweat_loss_g - 1), `${v.id} water ${r.waterLossG}`).toBeLessThanOrEqual(0.006)
      expect(Math.abs(r.sweatRateGPerH / pub.sweat_rate_final_g_per_h - 1), `${v.id} SW_p g/h`).toBeLessThanOrEqual(0.006)
      expectPublishedDlim(r.dLimLossMin, pub.d_lim_loss_95, 3, `${v.id} D_lim,loss`)
      expectPublishedDlim(r.dLimTReMin, pub.d_lim_t_re, 2, `${v.id} D_lim,tcr`)
    }
  })

  it('2023 Annex F case 3 (high radiant load, 0.1 m/s) needs tclIteration: ≈ 38.69 °C and ≈ 151 min', () => {
    const v = vector('ISO2023-F03')
    const iso = runVector(v, {})
    expect(iso.tReC).toBeCloseTo(38.69, 2)
    expect(iso.dLimTReMin).toBe(151) // published 149
    expect(iso.dLimLossMin).toBe(281) // published 280
    expect(iso.waterLossG).toBeCloseTo(6437.45, 1) // published 6419
    // pythermalcomfort's segment-fixed h_c: t_re −0.50 °C and D_lim,tcr 275 min (unsafe direction).
    const pytc = runVector(v, PYTC)
    expect(pytc.tReC).toBeCloseTo(38.198, 3)
    expect(pytc.dLimTReMin).toBe(275)
  })
})

// ─────────────────────────────── Piecewise stepping ───────────────────────────────

/** A low-wind, high-radiant case where natural convection beats z in every h_c rule (so h_c matters everywhere). */
const NATURAL_CONVECTION: PhsInput = {
  tdbC: 20,
  trC: 40,
  rhPct: 50,
  vMs: 0.1,
  metabolicWm2: 150,
  wmeWm2: 0,
  clo: 0.5,
  posture: 'standing',
  acclimatized: true,
  drink: 0,
  massKg: 75,
  heightM: 1.8,
}

function stepChunks(state: PhsState, input: PhsInput, chunks: number[], opts?: PhsOptions): PhsState {
  return chunks.reduce((s, n) => phsStep(s, input, n, opts), state)
}

describe('PHS stepper: chunked stepping equals one continuous run', () => {
  it('CHAIN-A-7933-2023: 1×120 = 2×60 = arbitrary chunks, bit for bit; equals the single 120-min call', () => {
    const c = chain('CHAIN-A-7933-2023')
    const seg = c.segments_inputs[0]
    if (!seg || !c.single_call_120min) throw new Error('chain fixture incomplete')
    const input = toInput(seg)
    for (const opts of [{ ...PYTC }, {}] as PhsOptions[]) {
      const s0 = phsInitialState(input, opts)
      const one = phsStep(s0, input, 120, opts)
      expect(stepChunks(s0, input, [60, 60], opts)).toEqual(one)
      expect(stepChunks(s0, input, [1, 2, 3, 7, 13, 29, 45, 20], opts)).toEqual(one)
      expect(phsRun(input, { ...opts, durationMin: 120 }).state).toEqual(one)
      const ref = c.single_call_120min.outputs
      close(one.tReC, ref.t_re, TOL.tempC, 'CHAIN-A t_re', 'tempC')
      close(one.tSkC, ref.t_sk, TOL.tempC, 'CHAIN-A t_sk', 'tempC')
      close(one.evapLoadWm2Min, ref.evap_load_wm2_min, TOL.evap, 'CHAIN-A evap', 'evap')
      expect(one.tReLimitMin).toBe(35) // absolute, not "1" as in pythermalcomfort's second call
      expect(one.elapsedMin).toBe(120)
    }
  })

  it('is chunk-invariant in every model × hcMode, including where natural convection dominates and drink = 0', () => {
    for (const model of ['7933-2023', '7933-2004'] as PhsModel[]) {
      for (const hcMode of ['tclIteration', 'pythermalcomfort'] as const) {
        const opts: PhsOptions = { model, hcMode }
        const k = phsConstants(NATURAL_CONVECTION, opts)
        expect(k.hcInitialWm2K).toBeGreaterThan(k.zWm2K) // natural convection is active
        const s0 = phsInitialState(NATURAL_CONVECTION, opts)
        const one = phsStep(s0, NATURAL_CONVECTION, 240, opts)
        expect(stepChunks(s0, NATURAL_CONVECTION, [1, 1, 2, 3, 50, 64, 119], opts), `${model} ${hcMode}`).toEqual(one)
        expect(one.drinkRestricted).toBe(true)
      }
    }
  })

  it('anchors the 2004 pythermalcomfort h_c per constant-condition segment (re-anchoring mid-segment would differ)', () => {
    const opts: PhsOptions = { model: '7933-2004', hcMode: 'pythermalcomfort' }
    const s0 = phsInitialState(NATURAL_CONVECTION, opts)
    const continuous = phsStep(s0, NATURAL_CONVECTION, 120, opts)
    const half = phsStep(s0, NATURAL_CONVECTION, 60, opts)
    expect(half.hcSegment).not.toBeNull()
    const reAnchored = phsStep({ ...half, hcSegment: null }, NATURAL_CONVECTION, 60, opts)
    expect(reAnchored.tReC).not.toBe(continuous.tReC)
  })

  it('applies the 2023 minute-1 override only at exposure start (E07: t_sk 20 → 34.92; 2004 E08 lags to 24.23)', () => {
    const e07 = runVector(vector('E07'))
    const e08 = runVector(vector('E08'))
    expect(e07.tSkC).toBeCloseTo(34.924, 3)
    expect(e08.tSkC).toBeCloseTo(24.231, 3)
    expect(e07.state.exposureStarted).toBe(true)
    // A second minute from the started state uses the 3-min lag, not the override: re-applying the override (as a
    // fresh pythermalcomfort call would) gives a different skin temperature.
    const input = toInput(vector('E07').inputs)
    const lagged = phsStep(e07.state, input, 1, PYTC)
    const overridden = phsStep({ ...e07.state, exposureStarted: false }, input, 1, PYTC)
    expect(lagged.tSkC).not.toBe(overridden.tSkC)
  })
})

describe('PHS worked work/rest example (phs_iso7933.md §11.3, fixture CHAIN-B)', () => {
  for (const id of ['CHAIN-B-7933-2023', 'CHAIN-B-7933-2004']) {
    it(`${id}: continuous state across [work 60, rest 15] × 2 matches the recommended reference`, () => {
      const c = chain(id)
      const segments = c.segments_inputs.map(toInput)
      for (const opts of [{ ...PYTC, model: c.model }, { model: c.model }] as PhsOptions[]) {
        let s = phsInitialState(segments[0] as PhsInput, opts)
        const every15: Array<[number, number]> = []
        let maxTRe = -Infinity
        c.segments_inputs.forEach((seg, k) => {
          const input = segments[k] as PhsInput
          for (let m = 0; m < seg.duration; m++) {
            s = phsStep(s, input, 1, opts)
            maxTRe = Math.max(maxTRe, s.tReC)
            if (s.elapsedMin % 15 === 0) every15.push([s.elapsedMin, s.tReC])
          }
          const ref = c.reference_continuous_recommended[k]?.outputs
          if (!ref) throw new Error('reference segment missing')
          close(s.tReC, ref.t_re, TOL.tempC, `${id} seg ${k} t_re`, 'tempC')
          close(s.tSkC, ref.t_sk, TOL.tempC, `${id} seg ${k} t_sk`, 'tempC')
          close(s.tCrC, ref.t_cr, TOL.tempC, `${id} seg ${k} t_cr`, 'tempC')
          close(s.sweatRateWm2, ref.sweat_rate_watt, TOL.swWm2, `${id} seg ${k} SW_p`, 'swWm2')
          close(s.evapLoadWm2Min, ref.evap_load_wm2_min, TOL.evap, `${id} seg ${k} evap`, 'evap')
        })
        const sum = c.reference_continuous_summary
        expect(s.elapsedMin).toBe(sum.shift_minutes)
        expect(s.tReLimitMin).toBe(sum.first_minute_t_re_ge_38) // 35
        expect(s.waterLoss5PctMin).toBe(sum.first_minute_sweat_loss_ge_dmax95) // null
        close(maxTRe, sum.max_t_re, TOL.tempC, `${id} max t_re`, 'tempC')
        expect(every15.map(([m]) => m)).toEqual(sum.t_re_by_minute_every_15.map(([m]) => m))
        every15.forEach(([, t], j) => close(t, sum.t_re_by_minute_every_15[j]?.[1] ?? Number.NaN, TOL.tempC, `${id} 15-min t_re`, 'tempC'))
      }
    })
  }

  it('2023 values quoted in the spec: first ≥ 38 °C at minute 35, 38.371 °C at 150 min, max 38.651 °C', () => {
    const c = chain('CHAIN-B-7933-2023')
    const segments = c.segments_inputs.map(toInput)
    const s = c.segments_inputs.reduce((st, seg, k) => phsStep(st, segments[k] as PhsInput, seg.duration), phsInitialState(segments[0] as PhsInput))
    expect(s.tReLimitMin).toBe(35)
    expect(s.tReC).toBeCloseTo(38.371, 3)
    // The limit latches: the cooler rest period never clears it.
    expect(phsLimitMinutes(s).tReMin).toBe(35)
    expect(minutesToLimit(s, segments[1] as PhsInput, 60)).toEqual({ minutes: 0, binding: 'rectal' })
  })

  it('reproduces pythermalcomfort chaining when the minute-1 override is re-applied per call (2023: +0.049 °C at 150 min)', () => {
    const c = chain('CHAIN-B-7933-2023')
    const segments = c.segments_inputs.map(toInput)
    let s = phsInitialState(segments[0] as PhsInput, PYTC)
    c.segments_inputs.forEach((seg, k) => {
      s = phsStep({ ...s, exposureStarted: false }, segments[k] as PhsInput, seg.duration, PYTC)
      const ref = c.pythermalcomfort_chained[k]?.outputs
      if (!ref) throw new Error('chained segment missing')
      close(s.tReC, ref.t_re, TOL.tempC, `pytc chained seg ${k} t_re`, 'tempC')
      close(s.tSkC, ref.t_sk, TOL.tempC, `pytc chained seg ${k} t_sk`, 'tempC')
      close(s.evapLoadWm2Min, ref.evap_load_wm2_min, TOL.evap, `pytc chained seg ${k} evap`, 'evap')
    })
    const continuousEnd = c.reference_continuous_recommended[3]?.outputs.t_re ?? Number.NaN
    expect(s.tReC - continuousEnd).toBeCloseTo(0.049, 3)
  })
})

// ─────────────────────────────── Limits and projection ───────────────────────────────

describe('D_lim semantics and minutesToLimit', () => {
  const ad01 = toInput(vector('AD01').inputs)
  const ad02 = toInput(vector('AD02').inputs)
  const ad15 = toInput(vector('AD15').inputs)

  it('returns null, not the duration, when a limit is not reached', () => {
    const r = phsRun(ad01, { durationMin: 120 })
    expect(r.dLimTReMin).toBeNull()
    expect(r.dLimLossMin).toBeNull()
    expect(phsRun(ad01).dLimLossMin).toBe(190)
  })

  it('agrees with phsRun D_lim for every fixture vector (projection from the initial state)', () => {
    for (const v of fx.vectors) {
      const input = toInput(v.inputs)
      const init = toInit(v.inputs)
      const dur = v.inputs.duration
      for (const opts of [{ ...PYTC, model: v.inputs.model }, { model: v.inputs.model }] as PhsOptions[]) {
        const r = phsRun(input, { ...opts, durationMin: dur }, init)
        const rectal = r.dLimTReMin
        const loss = r.dLimLossMin !== null && r.dLimLossMin <= dur ? r.dLimLossMin : null
        const p = minutesToLimit(init, input, dur, opts)
        if (rectal === null && loss === null) expect(p, v.id).toEqual({ minutes: null, binding: null })
        else if (loss === null || (rectal !== null && rectal <= loss)) expect(p, v.id).toEqual({ minutes: rectal, binding: 'rectal' })
        else expect(p, v.id).toEqual({ minutes: loss, binding: 'dehydration' })
      }
    }
  })

  it('counts down in absolute time and latches once reached (AD02: D_lim,tcr 35 min)', () => {
    const s0 = phsInitialState(ad02)
    expect(minutesToLimit(s0, ad02, 480)).toEqual({ minutes: 35, binding: 'rectal' })
    expect(minutesToLimit(s0, ad02, 34)).toEqual({ minutes: null, binding: null })
    const s30 = phsStep(s0, ad02, 30)
    expect(minutesToLimit(s30, ad02, 90)).toEqual({ minutes: 5, binding: 'rectal' })
    const s35 = phsStep(s30, ad02, 5)
    expect(s35.tReLimitMin).toBe(35)
    expect(minutesToLimit(s35, ad02, 90)).toEqual({ minutes: 0, binding: 'rectal' })
    expect(minutesToLimit(s0, ad02, 0)).toEqual({ minutes: null, binding: null })
  })

  it('finds the dehydration limit when it binds (AD01: 190 min)', () => {
    const s0 = phsInitialState(ad01)
    expect(minutesToLimit(s0, ad01, 480)).toEqual({ minutes: 190, binding: 'dehydration' })
    expect(minutesToLimit(s0, ad01, 190)).toEqual({ minutes: 190, binding: 'dehydration' })
    expect(minutesToLimit(s0, ad01, 189)).toEqual({ minutes: null, binding: null })
  })

  it('resolves the drink = 0 × 0.6 rule by looking past the horizon (AD15: 71.4 min from a 119-min crossing)', () => {
    const s0 = phsInitialState(ad15)
    expect(minutesToLimit(s0, ad15, 480)).toEqual({ minutes: 71.39999999999999, binding: 'dehydration' })
    expect(minutesToLimit(s0, ad15, 72)).toEqual({ minutes: 71.39999999999999, binding: 'dehydration' })
    expect(minutesToLimit(s0, ad15, 71)).toEqual({ minutes: null, binding: null })
    expect(minutesToLimit(s0, ad15, 480, { drink0Mode: 'threshold3PctOnly' })).toEqual({ minutes: 119, binding: 'dehydration' })
    // At minute 100 the 3 % threshold is not yet crossed, but 0.6 × 119 = 71.4 < 100: the limit has already passed.
    const s100 = phsStep(s0, ad15, 100)
    expect(s100.waterLoss3PctMin).toBeNull()
    expect(phsLimitMinutes(s100).lossMin).toBeNull()
    expect(minutesToLimit(s100, ad15, 30)).toEqual({ minutes: 0, binding: 'dehydration' })
    // Being able to drink later does not lift the no-drink criterion for this exposure [ENG, conservative].
    expect(s100.drinkRestricted).toBe(true)
    expect(minutesToLimit(s100, { ...ad15, drink: 1 }, 30)).toEqual({ minutes: 0, binding: 'dehydration' })
  })

  it('E10 (2004, drink = 0): closes pythermalcomfort\'s 0.6-rule blind spot (5 % reached only after the run)', () => {
    const v = vector('E10')
    const input = toInput(v.inputs)
    const opts: PhsOptions = { ...PYTC, model: '7933-2004' }
    const r = phsRun(input, { ...opts, durationMin: 480 }, toInit(v.inputs))
    expect(v.outputs.d_lim_loss_95).toBe(480) // pythermalcomfort: duration = "not reached"
    expect(r.state.waterLoss5PctMin).toBeNull() // 5 % not crossed within 480 min
    expect(r.state.waterLoss3PctMin).not.toBeNull() // but 3 % was
    const longer = phsRun(input, { ...opts, durationMin: 800 }, toInit(v.inputs))
    const crossing = longer.state.waterLoss5PctMin
    if (crossing === null) throw new Error('5 % should be crossed within 800 min')
    expect(r.dLimLossMin).toBe(crossing * 0.6)
    expect(r.dLimLossMin as number).toBeLessThanOrEqual(480)
    expect(r.dLimLoss50Min).toBe(r.dLimLossMin)
    expect(minutesToLimit(toInit(v.inputs), input, 480, opts)).toEqual({ minutes: crossing * 0.6, binding: 'dehydration' })
    // The 3 %-only reading uses the in-run 3 % crossing directly.
    const r3 = phsRun(input, { ...opts, drink0Mode: 'threshold3PctOnly', durationMin: 480 }, toInit(v.inputs))
    expect(r3.dLimLossMin).toBe(r.state.waterLoss3PctMin)
  })

  it('never mutates the state it is given', () => {
    const s = Object.freeze(phsStep(phsInitialState(ad02), ad02, 10))
    expect(() => phsStep(s, ad02, 5)).not.toThrow()
    expect(() => minutesToLimit(s, ad02, 120)).not.toThrow()
    expect(() => phsRun(ad02, { durationMin: 5 }, s)).not.toThrow()
    expect(phsStep(s, ad02, 0)).toEqual(s)
  })
})

describe('minutesToLimit with a custom drink-allowed water-loss threshold (PhsProjectionOptions)', () => {
  const ad01 = toInput(vector('AD01').inputs)
  const ad15 = toInput(vector('AD15').inputs)
  const K01 = phsConstants(ad01)
  const raised = K01.dMax5PctG + 400
  const trace01 = phsRun(ad01, { durationMin: 480, trace: true }).trace as NonNullable<PhsResult['trace']>
  const raisedCrossing = (trace01.find((p) => p.waterLossG >= raised) as { minute: number }).minute

  it('absent, NaN, or at/below the ISO 5 % value → bit-identical to ISO 7933 for every fixture vector', () => {
    for (const v of fx.vectors) {
      const input = toInput(v.inputs)
      const init = toInit(v.inputs)
      const dur = v.inputs.duration
      for (const opts of [{ ...PYTC, model: v.inputs.model }, { model: v.inputs.model }] as PhsOptions[]) {
        const iso = minutesToLimit(init, input, dur, opts)
        const K = phsConstants(input, opts)
        for (const lossThresholdG of [undefined, Number.NaN, K.dMax5PctG, K.dMax5PctG - 500, -1]) {
          expect(minutesToLimit(init, input, dur, opts, { lossThresholdG }), `${v.id}:${lossThresholdG}`).toEqual(iso)
        }
        const mid = phsStep(init, input, Math.min(60, dur), opts)
        expect(minutesToLimit(mid, input, dur, opts, { lossThresholdG: K.dMax5PctG }), v.id).toEqual(minutesToLimit(mid, input, dur, opts))
      }
    }
  })

  it('a higher threshold moves the dehydration limit to the minute the cumulative loss reaches it (AD01: 190 → later)', () => {
    const s0 = phsInitialState(ad01)
    expect(minutesToLimit(s0, ad01, 480)).toEqual({ minutes: 190, binding: 'dehydration' })
    expect(raisedCrossing).toBeGreaterThan(190)
    expect(minutesToLimit(s0, ad01, 480, undefined, { lossThresholdG: raised })).toEqual({ minutes: raisedCrossing, binding: 'dehydration' })
    expect(minutesToLimit(s0, ad01, raisedCrossing - 1, undefined, { lossThresholdG: raised })).toEqual({ minutes: null, binding: null })
  })

  it('already reached: the recorded 5 % crossing no longer latches; the cumulative loss is compared with the threshold', () => {
    const s200 = phsStep(phsInitialState(ad01), ad01, 200)
    expect(s200.waterLoss5PctMin).toBe(190)
    expect(minutesToLimit(s200, ad01, 120)).toEqual({ minutes: 0, binding: 'dehydration' })
    expect(minutesToLimit(s200, ad01, 480, undefined, { lossThresholdG: raised })).toEqual({ minutes: raisedCrossing - 200, binding: 'dehydration' })
    const past = phsStep(s200, ad01, raisedCrossing - 200)
    expect(minutesToLimit(past, ad01, 120, undefined, { lossThresholdG: raised })).toEqual({ minutes: 0, binding: 'dehydration' })
  })

  it('is ignored while drinking is restricted (AD15 drink = 0: the 3 % / 0.6 rule is unchanged)', () => {
    const s0 = phsInitialState(ad15)
    const K15 = phsConstants(ad15)
    const iso = minutesToLimit(s0, ad15, 480)
    expect(minutesToLimit(s0, ad15, 480, undefined, { lossThresholdG: K15.dMax5PctG * 2 })).toEqual(iso)
    const s100 = phsStep(s0, ad15, 100)
    expect(minutesToLimit(s100, { ...ad15, drink: 1 }, 30, undefined, { lossThresholdG: K15.dMax5PctG * 2 })).toEqual({ minutes: 0, binding: 'dehydration' })
  })
})

// ─────────────────────────────── Validity and input checks ───────────────────────────────

describe('phsValidity (ISO 7933 Annex A Table A.1, as pythermalcomfort 4.8.1)', () => {
  const FIELD: Record<string, PhsValidityField> = {
    tdb: 'tdbC',
    tr_minus_tdb: 'trMinusTdbC',
    v: 'vMs',
    p_a_kpa: 'paKpa',
    met_wm2: 'metabolicWm2',
    clo: 'clo',
  }

  it('flags exactly the fixture vectors pythermalcomfort would NaN (AD03: M 290 W/m² > 250)', () => {
    for (const v of fx.vectors) {
      const got = phsValidity(toInput(v.inputs), v.inputs.model)
      expect(got.failing.map((f) => f.field), v.id).toEqual(v.validity.failing.map((f) => FIELD[f]))
      expect(got.withinLimits).toBe(v.validity.within_limits)
    }
    expect(runVector(vector('AD03')).validity.failing[0]).toEqual({ field: 'metabolicWm2', value: 290, min: 56, max: 250 })
  })

  it('uses inclusive bounds and the edition-specific M and p_a ranges', () => {
    const base = toInput(vector('AD02').inputs)
    expect(phsValidity({ ...base, metabolicWm2: 250 }).withinLimits).toBe(true)
    expect(phsValidity({ ...base, metabolicWm2: 250.0001 }).withinLimits).toBe(false)
    expect(phsValidity({ ...base, metabolicWm2: 300 }, '7933-2004').withinLimits).toBe(true)
    expect(phsValidity({ ...base, metabolicWm2: 80 }, '7933-2004').failing.map((f) => f.field)).toEqual(['metabolicWm2'])
    expect(phsValidity({ ...base, paKpa: 0.3, rhPct: undefined }).failing.map((f) => f.field)).toEqual(['paKpa'])
    expect(phsValidity({ ...base, paKpa: 0.3, rhPct: undefined }, '7933-2004').withinLimits).toBe(true)
    expect(phsValidity({ ...base, trC: base.tdbC - 1 }).failing.map((f) => f.field)).toEqual(['trMinusTdbC'])
    expect(phsValidity({ ...base, trC: base.tdbC + 60 }).withinLimits).toBe(true)
    expect(phsValidity({ ...base, tdbC: 51, trC: 60 }).failing.map((f) => f.field)).toEqual(['tdbC'])
    expect(phsValidity({ ...base, clo: 1.2 }).failing[0]).toEqual({ field: 'clo', value: 1.2, ...PHS_VALIDITY_LIMITS['7933-2023'].clo })
    expect(phsValidity({ ...base, vMs: Number.NaN }).failing.map((f) => f.field)).toEqual(['vMs'])
  })
})

describe('PHS input and option checks', () => {
  const base = toInput(vector('AD02').inputs)

  it('rejects inputs that make the model meaningless or divide by zero', () => {
    expect(() => phsRun({ ...base, tdbC: Number.NaN })).toThrow(RangeError)
    expect(() => phsRun({ ...base, massKg: 0 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, heightM: 0 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, clo: 0 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, iMst: 0 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, vMs: -0.1 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, aP: 0.3, fR: 1.5 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, aP: 1.2 })).toThrow(RangeError)
    expect(() => phsRun({ ...base, rhPct: 20 } as unknown as PhsInput)).toThrow(RangeError)
    expect(() => phsRun(base, { durationMin: 1.5 })).toThrow(RangeError)
    expect(() => phsStep(phsInitialState(base), base, -1)).toThrow(RangeError)
  })

  it('refuses to mix editions on one state', () => {
    const s = phsInitialState(base, { model: '7933-2023' })
    expect(() => phsStep(s, base, 1, { model: '7933-2004' })).toThrow(RangeError)
    expect(() => phsRun(base, { model: '7933-2004' }, s)).toThrow(RangeError)
  })

  it('outside Table A.1 it still computes (flagged), never NaN (AD03, M 290 W/m²)', () => {
    const r = runVector(vector('AD03'))
    expect(r.validity.withinLimits).toBe(false)
    expect(Number.isFinite(r.tReC)).toBe(true)
    expect(r.dLimTReMin).toBe(22)
  })
})

// ─────────────────────────────── Performance ───────────────────────────────

describe('PHS performance', () => {
  it('runs one 480-min shift in < 5 ms', () => {
    const input = toInput(vector('AD02').inputs)
    for (let i = 0; i < 10; i++) phsRun(input)
    const times: number[] = []
    for (let i = 0; i < 31; i++) {
      const t0 = performance.now()
      phsRun(input)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[15] as number
    const pytc: number[] = []
    for (let i = 0; i < 31; i++) {
      const t0 = performance.now()
      phsRun(input, PYTC)
      pytc.push(performance.now() - t0)
    }
    pytc.sort((a, b) => a - b)
    // A full-horizon projection (AD01 reaches no limit within 120 min, so all 120 minutes are simulated).
    const ad01 = toInput(vector('AD01').inputs)
    const s0 = phsInitialState(ad01)
    const proj: number[] = []
    for (let i = 0; i < 31; i++) {
      const t0 = performance.now()
      minutesToLimit(s0, ad01, 120)
      proj.push(performance.now() - t0)
    }
    proj.sort((a, b) => a - b)
    console.log(
      `[phs timing] 480-min run, tclIteration: median ${median.toFixed(3)} ms (min ${(times[0] as number).toFixed(3)}, max ${(times[30] as number).toFixed(3)}); pythermalcomfort mode median ${(pytc[15] as number).toFixed(3)} ms; minutesToLimit 120-min horizon median ${(proj[15] as number).toFixed(3)} ms`,
    )
    expect(median).toBeLessThan(5)
  })

  it('reports the achieved worst-case deviations', () => {
    console.log(`[phs accuracy] worst |Δ| vs fixtures: ${JSON.stringify(worst)}`)
    expect(Object.keys(worst).length).toBeGreaterThan(0)
  })
})
