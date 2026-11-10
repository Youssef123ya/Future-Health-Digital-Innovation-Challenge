/**
 * Reference agreement (evidence class 1, docs/SIMULATION.md): runs the engine on every oracle fixture and summarises how
 * closely it reproduces each published model's reference implementation or published values.
 *
 *   WBGT  — wbgt.ts vs thermofeel 2.3.0 (Liljegren 2008 port) + Lemke & Kjellstrom 2012 published points
 *   PHS   — phs.ts vs pythermalcomfort 4.8.1 + ISO 7933:2004 / 2023 Annex F published cases
 *   TWL   — twl.ts vs the reference implementation (scripts/oracles/twl_oracle.py) + Brake & Bates 2002 Table I and text
 *   NIOSH / ACGIH — limits.ts REL/RAL, allowed work fraction, ACGIH TLV Table 2
 *   Heat index — limits.ts vs the NWS algorithm and the NOAA chart (NIOSH 2016 App. C)
 *   ECTemp / PSI / SQI — physio.ts vs the USARIEM-derived fixtures (Buller 2013, Looney 2018, Moran 1998, Li 2009)
 *   Human MRT — indices.ts humanMrtC vs thermofeel 2.3.0 (Di Napoli 2020)
 *   Gagge — sim/gagge.ts vs pythermalcomfort 4.8.1 two_nodes_gagge; sim/truth.ts MRT from fluxes vs thermofeel
 *
 * Tolerances are the ones the colocated unit tests assert (each check names its source). This script reports; the tests
 * enforce. Output: public/data/validation/reference.json. Run: `npm run validate` or `npx tsx scripts/validate/reference.ts`.
 */
import {
  globeTemperature,
  naturalWetBulb,
  psychrometricWetBulb,
  wbgtComponents,
  wbgtIndoorC,
  wbgtOutdoorC,
} from '../../src/engine/wbgt'
import type { LiljegrenInputs } from '../../src/engine/wbgt'
import { phsInitialState, phsRun } from '../../src/engine/phs'
import type { PhsInput, PhsModel, PhsOptions, PhsPosture, PhsResult, PhsState } from '../../src/engine/phs'
import { computeTwl } from '../../src/engine/twl'
import type { TwlHumidityInput, TwlInput, TwlRadiantInput, TwlVariant } from '../../src/engine/twl'
import {
  ACGIH_SCREENING_ROWS,
  acgihScreeningCell,
  allowedWorkFraction,
  heatIndexNwsC,
  heatIndexNwsDetail,
  heatIndexNwsF,
  ralC,
  relC,
  rothfuszF,
} from '../../src/engine/limits'
import type { AcgihAllocation, AcgihScreeningCategory, AllowedWorkBinding } from '../../src/engine/limits'
import { apsi, apsiCritical, ectempRun, minuteSqi, psiBand, psiMoran, sqiRScale } from '../../src/engine/physio'
import type { EctempModel } from '../../src/engine/physio'
import { humanMrtC } from '../../src/engine/indices'
import type { HumanMrtInput } from '../../src/engine/indices'
import { cToF, fToC } from '../../src/engine/units'
import { GAGGE, GAGGE_PARITY_PARAMS, createGaggeState, gaggeStep } from '../../src/sim/gagge'
import type { GaggeInputs, GaggeParams } from '../../src/sim/gagge'
import { humanMrtFromFluxesC } from '../../src/sim/truth'
import type { MrtFluxes } from '../../src/sim/truth'
import { Provenance, codeStamp, isMainModule, timed, writeValidationJson } from './lib/io'
import type { CodeStamp, InputFileRecord } from './lib/io'
import { DiffSet, sig } from './lib/stats'
import type { DiffSummary } from './lib/stats'

// ─────────────────────────────── Report contract ───────────────────────────────

/** Models covered by the reference-agreement report. */
export type ReferenceModelId =
  | 'wbgt'
  | 'phs'
  | 'twl'
  | 'niosh'
  | 'acgih'
  | 'heat_index'
  | 'ectemp'
  | 'psi'
  | 'sqi'
  | 'mrt_human'
  | 'gagge'

/** One agreement check: a set of engine-vs-reference values with a tolerance. */
export interface ReferenceCheck {
  id: string
  model: ReferenceModelId
  title: string
  /** Engine function(s) exercised. */
  engine: string
  /** The reference: implementation (with version) or publication. */
  reference: string
  kind: 'reference_implementation' | 'published_values'
  /** Fixture file and section. */
  fixture: string
  /** Number of fixture cases (input sets). */
  nCases: number
  /** Number of compared values. */
  nValues: number
  quantity: string
  /** Unit of the differences ('relative' for relative errors). */
  unit: string
  maxAbsDiff: number
  meanAbsDiff: number
  /** Signed mean difference (engine − reference). */
  meanDiff: number
  rmsDiff: number
  tolerance: number
  /** 'abs': max |Δ| ≤ tol · 'rel': max relative error ≤ tol · 'rms': rms ≤ tol (see `note` for any second criterion). */
  toleranceKind: 'abs' | 'rel' | 'rms'
  /** Where the tolerance comes from (the unit test that asserts it). */
  toleranceSource: string
  /** Categorical mismatches (branch, band, flag, D_lim "reached/not reached"); must be 0 to pass. */
  mismatches: number
  pass: boolean
  note?: string
}

/** Per-model roll-up. */
export interface ReferenceModelSummary {
  model: ReferenceModelId
  label: string
  checks: number
  passed: number
  /** Total compared values over the model's checks. */
  values: number
  pass: boolean
}

/** public/data/validation/reference.json */
export interface ReferenceReport {
  schema: 'zill.validation.reference/v1'
  evidenceClass: 'reference_agreement'
  title: string
  generatedBy: 'scripts/validate/reference.ts'
  command: string
  stamp: CodeStamp
  provenance: { inputs: InputFileRecord[]; oracleEnvironments: Record<string, unknown> }
  config: { note: string }
  summary: { checks: number; passed: number; allPass: boolean; models: ReferenceModelSummary[] }
  checks: ReferenceCheck[]
}

/** Run options shared by the validation scripts. */
export interface RunOptions {
  /** Write the JSON (default true). */
  write?: boolean
  /** Print progress and timings (default true). */
  log?: boolean
}

const MODEL_LABELS: Record<ReferenceModelId, string> = {
  wbgt: 'Outdoor WBGT (Liljegren 2008)',
  phs: 'Predicted Heat Strain (ISO 7933)',
  twl: 'Thermal Work Limit (Brake & Bates 2002)',
  niosh: 'NIOSH REL/RAL and work–rest',
  acgih: 'ACGIH TLV Table 2',
  heat_index: 'NWS heat index',
  ectemp: 'ECTemp (Buller 2013 / Looney 2018)',
  psi: 'PSI / aPSI (Moran 1998)',
  sqi: 'Heart-rate signal quality (Li 2009)',
  mrt_human: 'Human MRT (Di Napoli 2020)',
  gagge: 'Gagge two-node model (simulation truth)',
}

type CheckBase = Omit<ReferenceCheck, 'nValues' | 'maxAbsDiff' | 'meanAbsDiff' | 'meanDiff' | 'rmsDiff' | 'pass' | 'mismatches'>

/** Build a check from a difference summary. */
function makeCheck(base: CheckBase, d: DiffSummary, mismatches = 0, extraPass = true): ReferenceCheck {
  const metric = base.toleranceKind === 'rms' ? d.rms : d.maxAbs
  const pass = d.n > 0 && Number.isFinite(metric) && metric <= base.tolerance && mismatches === 0 && extraPass
  return {
    ...base,
    nValues: d.n,
    maxAbsDiff: sig(d.maxAbs, 3),
    meanAbsDiff: sig(d.meanAbs, 3),
    meanDiff: sig(d.mean, 3),
    rmsDiff: sig(d.rms, 3),
    mismatches,
    pass,
  }
}

// ─────────────────────────────── WBGT ───────────────────────────────

interface WbgtFixture {
  meta: { versions: Record<string, string>; tolerances: { exact_port_degC: number }; acceptance: { lemke_rms_degC: number; lemke_max_degC: number } }
  core_cases: {
    id: string
    inputs: { ta_c: number; rh_pct: number; p_hpa: number; u2_ms: number; ghi_wm2: number; fdir_supplied: number; cos_zenith: number }
    outputs: { tg_c: number; tnwb_c: number; tpsy_c: number; wbgt_outdoor_c: number; wbgt_indoor_formula_c: number }
  }[]
  full_cases: {
    id: string
    inputs: { lat: number; lon: number; time_end_utc: string; ta_c: number; rh_pct: number | null; td_c: number | null; p_hpa: number; u10_ms: number; ghi_wm2: number; direct_wm2: number | null }
    outputs: { tg_c: number; tnwb_c: number; tpsy_c: number; wbgt_c: number }
    shade_variant: { tg_c: number; tnwb_c: number; wbgt_indoor_formula_c: number }
  }[]
  sanity_checks: { lemke_kjellstrom_2012: Record<'fig1' | 'fig2' | 'fig3' | 'fig4', { x: number[]; digitized_wbgt_c: number[] }> }
}

function wbgtChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/wbgt_liljegren.json'
  const fx = prov.readJson(path) as WbgtFixture
  env.wbgt = fx.meta.versions
  const tol = fx.meta.tolerances.exact_port_degC
  const out: ReferenceCheck[] = []

  const core = new DiffSet()
  for (const c of fx.core_cases) {
    const inp: LiljegrenInputs = {
      taC: c.inputs.ta_c,
      rhPct: c.inputs.rh_pct,
      pHpa: c.inputs.p_hpa,
      u2Ms: c.inputs.u2_ms,
      ghiWm2: c.inputs.ghi_wm2,
      fdir: c.inputs.fdir_supplied,
      cosZenith: c.inputs.cos_zenith,
    }
    const tg = globeTemperature(inp).valueC
    const tw = naturalWetBulb(inp).valueC
    const tp = psychrometricWetBulb(inp.taC, inp.rhPct, inp.pHpa, inp.u2Ms).valueC
    core.add(tg, c.outputs.tg_c)
    core.add(tw, c.outputs.tnwb_c)
    core.add(tp, c.outputs.tpsy_c)
    core.add(wbgtOutdoorC(tw, tg, inp.taC), c.outputs.wbgt_outdoor_c)
    core.add(wbgtIndoorC(tw, tg), c.outputs.wbgt_indoor_formula_c)
  }
  out.push(
    makeCheck(
      {
        id: 'wbgt.core_solvers',
        model: 'wbgt',
        title: 'Globe, natural wet-bulb and psychrometric wet-bulb solvers, outdoor and indoor WBGT',
        engine: 'wbgt.ts globeTemperature, naturalWetBulb, psychrometricWetBulb, wbgtOutdoorC, wbgtIndoorC',
        reference: `thermofeel ${fx.meta.versions.thermofeel} (Liljegren et al. 2008 port), scripts/oracles/wbgt_liljegren_oracle.py`,
        kind: 'reference_implementation',
        fixture: `${path} core_cases`,
        nCases: fx.core_cases.length,
        quantity: 'Tg, Tnwb, Tpsy, WBGT (outdoor and indoor formulas)',
        unit: '°C',
        tolerance: tol,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/wbgt.test.ts (exact port, fixture meta.tolerances.exact_port_degC)',
      },
      core.summary(),
    ),
  )

  const full = new DiffSet()
  for (const c of fx.full_cases) {
    const w = wbgtComponents(
      {
        t: Date.parse(c.inputs.time_end_utc),
        taC: c.inputs.ta_c,
        rhPct: c.inputs.rh_pct ?? Number.NaN,
        tdC: c.inputs.td_c ?? undefined,
        pHpa: c.inputs.p_hpa,
        wind10Ms: c.inputs.u10_ms,
        ghiWm2: c.inputs.ghi_wm2,
        directWm2: c.inputs.direct_wm2 ?? undefined,
        source: 'archive',
      },
      c.inputs.lat,
      c.inputs.lon,
      { engineeredShade: false },
    )
    full.add(w.tgC, c.outputs.tg_c)
    full.add(w.tnwbC, c.outputs.tnwb_c)
    full.add(w.tpwbC, c.outputs.tpsy_c)
    full.add(w.wbgtC, c.outputs.wbgt_c)
    full.add(w.tgShadeC, c.shade_variant.tg_c)
    full.add(w.tnwbShadeC, c.shade_variant.tnwb_c)
    full.add(w.wbgtShadeC, c.shade_variant.wbgt_indoor_formula_c)
  }
  out.push(
    makeCheck(
      {
        id: 'wbgt.pipeline',
        model: 'wbgt',
        title: 'Full Open-Meteo pipeline: solar geometry, fdir, 10 m → 2 m wind, sun and reference-shade WBGT',
        engine: 'wbgt.ts wbgtComponents (engineeredShade: false for parity)',
        reference: `thermofeel ${fx.meta.versions.thermofeel} + pvlib ${fx.meta.versions.pvlib}, scripts/oracles/wbgt_liljegren_oracle.py`,
        kind: 'reference_implementation',
        fixture: `${path} full_cases`,
        nCases: fx.full_cases.length,
        quantity: 'Tg, Tnwb, Tpsy, WBGT in sun; Tg, Tnwb, WBGT in reference shade',
        unit: '°C',
        tolerance: tol,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/wbgt.test.ts (wbgtComponents full cases ≤ 1e-6 °C)',
      },
      full.summary(),
    ),
  )

  const lk = fx.sanity_checks.lemke_kjellstrom_2012
  const base: LiljegrenInputs = { taC: 30, rhPct: 55, pHpa: 1013.25, u2Ms: 1, ghiWm2: 500, fdir: 0.8, cosZenith: 1 }
  const figs: [{ x: number[]; digitized_wbgt_c: number[] }, (x: number) => LiljegrenInputs][] = [
    [lk.fig1, (x) => ({ ...base, ghiWm2: x })],
    [lk.fig2, (x) => ({ ...base, rhPct: x })],
    [lk.fig3, (x) => ({ ...base, u2Ms: x })],
    [lk.fig4, (x) => ({ ...base, taC: x })],
  ]
  const lemke = new DiffSet()
  for (const [fig, make] of figs) {
    fig.x.forEach((x, i) => {
      const inp = make(x)
      if (inp.u2Ms < 0.13) return // below the Liljegren wind floor: the published curve is not comparable
      lemke.add(wbgtOutdoorC(naturalWetBulb(inp).valueC, globeTemperature(inp).valueC, inp.taC), fig.digitized_wbgt_c[i])
    })
  }
  const ls = lemke.summary()
  out.push(
    makeCheck(
      {
        id: 'wbgt.lemke_kjellstrom_2012',
        model: 'wbgt',
        title: 'Published Liljegren curves digitised from Lemke & Kjellstrom 2012 Figs 1–4',
        engine: 'wbgt.ts globeTemperature, naturalWetBulb, wbgtOutdoorC',
        reference: 'Lemke & Kjellstrom 2012, Ind Health 50:267–278, Figs 1–4 (digitised; P 1013.25 hPa, fdir 0.8, cos z 1)',
        kind: 'published_values',
        fixture: `${path} sanity_checks.lemke_kjellstrom_2012`,
        nCases: ls.n,
        quantity: 'WBGT',
        unit: '°C',
        tolerance: fx.meta.acceptance.lemke_rms_degC,
        toleranceKind: 'rms',
        toleranceSource: 'src/engine/wbgt.test.ts (rms ≤ 0.15 °C and max ≤ 0.25 °C over the 99 points)',
        note: `Second criterion max |Δ| ≤ ${fx.meta.acceptance.lemke_max_degC} °C. Differences include figure-digitising error.`,
      },
      ls,
      0,
      ls.maxAbs <= fx.meta.acceptance.lemke_max_degC,
    ),
  )
  return out
}

// ─────────────────────────────── Human MRT ───────────────────────────────

interface MrtFixture {
  meta: { environment: Record<string, string>; tolerance_c: number }
  cases: { id: string; inputs: { ta_c: number; rh_pct: number; ghi_wm2: number; fdir: number; cos_zenith: number; ground_temp_c?: number; albedo?: number }; outputs: { mrt_c: number } }[]
}

function mrtChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/mrt_human.json'
  const fx = prov.readJson(path) as MrtFixture
  env.mrt_human = fx.meta.environment
  const d = new DiffSet()
  for (const c of fx.cases) {
    const inp: HumanMrtInput = { taC: c.inputs.ta_c, rhPct: c.inputs.rh_pct, ghiWm2: c.inputs.ghi_wm2, fdir: c.inputs.fdir, cosZenith: c.inputs.cos_zenith }
    if (c.inputs.ground_temp_c !== undefined) inp.groundTempC = c.inputs.ground_temp_c
    if (c.inputs.albedo !== undefined) inp.albedo = c.inputs.albedo
    d.add(humanMrtC(inp), c.outputs.mrt_c)
  }
  return [
    makeCheck(
      {
        id: 'mrt_human.thermofeel',
        model: 'mrt_human',
        title: 'Mean radiant temperature of a standing person (PHS radiant input)',
        engine: 'indices.ts humanMrtC',
        reference: `thermofeel ${fx.meta.environment.thermofeel ?? ''} calculate_mean_radiant_temperature (Di Napoli et al. 2020), scripts/oracles/mrt_human_oracle.py`,
        kind: 'reference_implementation',
        fixture: `${path} cases`,
        nCases: fx.cases.length,
        quantity: 'MRT',
        unit: '°C',
        tolerance: fx.meta.tolerance_c,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/indices.test.ts (fixture meta.tolerance_c)',
      },
      d.summary(),
    ),
  ]
}

// ─────────────────────────────── PHS ───────────────────────────────

interface PhsFxInputs {
  tdb: number
  tr: number
  v: number
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

interface PhsFxOutputs {
  t_re: number
  t_sk: number
  t_cr: number
  t_cr_eq: number
  d_lim_loss_50: number
  d_lim_loss_95: number
  d_lim_t_re: number
  sweat_rate_watt: number
  sweat_loss_g: number
  evap_load_wm2_min: number
}

interface PhsFxVector {
  id: string
  group: 'iso_7933_2004_annex_f' | 'iso_7933_2023_annex_f' | 'abu_dhabi' | 'edge'
  inputs: PhsFxInputs
  outputs: PhsFxOutputs
  d_lim_margins: { d_lim_t_re: { minute: number } | null; d_lim_loss_95: { minute: number } | null }
  iso_published?: { t_re: number; sweat_loss_g: number; d_lim_t_re: number | null; d_lim_loss_50?: number; d_lim_loss_95: number; sweat_rate_final_g_per_h?: number }
}

interface PhsFixture {
  environment: Record<string, string>
  conventions: { recommended_tolerances_for_port: { temperatures_degC: number; sweat_rate_watt: number; sweat_loss_g: number } }
  vectors: PhsFxVector[]
}

function phsInput(i: PhsFxInputs): PhsInput {
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

function phsInit(i: PhsFxInputs): PhsState {
  return {
    ...phsInitialState(phsInput(i), { model: i.model }),
    tSkC: i.t_sk,
    tCrC: i.t_cr,
    tReC: i.t_re,
    tCrEqC: i.t_cr_eq,
    skinCoreWeight: i.t_sk_t_cr_wg,
    sweatRateWm2: i.sweat_rate_watt,
    evapLoadWm2Min: i.evap_load_wm2_min,
  }
}

function phsVector(v: PhsFxVector, opts: PhsOptions): PhsResult {
  return phsRun(phsInput(v.inputs), { ...opts, model: v.inputs.model, durationMin: v.inputs.duration }, phsInit(v.inputs))
}

/** pythermalcomfort-parity options (the fixture engine; phs.test.ts PYTC). */
const PHS_PYTC: PhsOptions = { hcMode: 'pythermalcomfort', drink0Mode: 'pythermalcomfort', spHeatBasis: 'pythermalcomfort' }

/** D_lim comparison against a published value where null or ≥ 480 means "not reached in the 480-min run". */
function publishedDlim(ours: number | null | undefined, pub: number | null | undefined): { diff: number | null; mismatch: boolean } {
  if (pub === null || pub === undefined || pub >= 480) return { diff: null, mismatch: !(ours === null || ours === undefined || ours === 480) }
  if (ours === null || ours === undefined) return { diff: null, mismatch: true }
  return { diff: ours - pub, mismatch: false }
}

function phsChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/phs.json'
  const fx = prov.readJson(path) as PhsFixture
  env.phs = fx.environment
  const tolFx = fx.conventions.recommended_tolerances_for_port
  const out: ReferenceCheck[] = []
  const pytc = `pythermalcomfort ${fx.environment.pythermalcomfort ?? ''} phs (both editions), scripts/oracles/phs_oracle.py`

  const temps = new DiffSet()
  const sweat = new DiffSet()
  const water = new DiffSet()
  const dlim = new DiffSet()
  let dlimMismatch = 0
  let documentedDeviation = 0
  for (const v of fx.vectors) {
    const r = phsVector(v, PHS_PYTC)
    const o = v.outputs
    const dur = v.inputs.duration
    temps.add(r.tReC, o.t_re)
    temps.add(r.tSkC, o.t_sk)
    temps.add(r.tCrC, o.t_cr)
    temps.add(r.tCrEqC, o.t_cr_eq)
    sweat.add(r.sweatRateWm2, o.sweat_rate_watt)
    water.add(r.waterLossG, o.sweat_loss_g)
    // D_lim,tre: exact when reached; pythermalcomfort reports `duration` for "not reached", Zill reports null.
    if (v.d_lim_margins.d_lim_t_re) {
      if (r.dLimTReMin === null) dlimMismatch++
      else dlim.add(r.dLimTReMin, o.d_lim_t_re)
    } else if (r.dLimTReMin !== null) dlimMismatch++
    // D_lim,loss (2023) / loss95 (2004), with the drink = 0 × 0.6 rule.
    if (v.d_lim_margins.d_lim_loss_95) {
      if (r.dLimLossMin === null) dlimMismatch++
      else dlim.add(r.dLimLossMin, o.d_lim_loss_95)
    } else if (v.id === 'E10') {
      documentedDeviation++ // Zill resolves pythermalcomfort's 0.6-rule blind spot (phs.test.ts E10)
    } else if (r.dLimLossMin !== null) dlimMismatch++
    if (v.inputs.model === '7933-2004' && v.id !== 'E10') {
      const theirs = o.d_lim_loss_50
      const ours = r.dLimLoss50Min
      if (theirs < dur) {
        if (ours === null || ours === undefined) dlimMismatch++
        else dlim.add(ours, theirs)
      } else if (!(ours === null || ours === undefined || ours === dur)) dlimMismatch++
    }
  }
  const nVec = fx.vectors.length
  const pytcBase = {
    model: 'phs' as const,
    engine: 'phs.ts phsRun (pythermalcomfort-parity options: hcMode, drink0Mode, spHeatBasis = pythermalcomfort)',
    reference: pytc,
    kind: 'reference_implementation' as const,
    fixture: `${path} vectors (2004 and 2023 editions)`,
    nCases: nVec,
    toleranceKind: 'abs' as const,
    toleranceSource: 'src/engine/phs.test.ts TOL (fixture conventions.recommended_tolerances_for_port)',
  }
  out.push(makeCheck({ ...pytcBase, id: 'phs.pytc.temperatures', title: 'End-of-run rectal, skin, core and equilibrium core temperatures', quantity: 't_re, t_sk, t_cr, t_cr_eq', unit: '°C', tolerance: tolFx.temperatures_degC }, temps.summary()))
  out.push(makeCheck({ ...pytcBase, id: 'phs.pytc.sweat_rate', title: 'Predicted sweat rate at the last minute', quantity: 'SW_p', unit: 'W/m²', tolerance: tolFx.sweat_rate_watt }, sweat.summary()))
  out.push(makeCheck({ ...pytcBase, id: 'phs.pytc.water_loss', title: 'Cumulative water loss', quantity: 'sweat_loss_g', unit: 'g', tolerance: tolFx.sweat_loss_g }, water.summary()))
  out.push(
    makeCheck(
      {
        ...pytcBase,
        id: 'phs.pytc.dlim',
        title: 'Allowed exposure times D_lim (rectal, dehydration 5 %/7.5 %, drink = 0 rule)',
        quantity: 'D_lim,tre, D_lim,loss(95), D_lim,loss50',
        unit: 'min',
        tolerance: 0,
        toleranceSource: 'src/engine/phs.test.ts (exact minutes; "not reached" = null instead of the duration)',
        note: `${documentedDeviation} documented deviation excluded (E10, drink = 0: Zill finds the dehydration limit pythermalcomfort's 0.6 rule misses; conservative).`,
      },
      dlim.summary(),
      dlimMismatch,
    ),
  )

  // ISO 7933:2004 Annex F (10 published cases).
  const annex04 = fx.vectors.filter((v) => v.group === 'iso_7933_2004_annex_f')
  for (const [variant, opts, tolT, tolW, tolD] of [
    ['defaults', { model: '7933-2004' } as PhsOptions, 0.1, 3, 1],
    ['basic2004', { model: '7933-2004', spHeatBasis: 'basic2004' } as PhsOptions, 0.05, 0.4, 0],
  ] as const) {
    const tre = new DiffSet()
    const wat = new DiffSet()
    const dl = new DiffSet()
    let mm = 0
    for (const v of annex04) {
      const pub = v.iso_published
      if (!pub) continue
      const r = phsVector(v, opts)
      tre.add(r.tReC, pub.t_re)
      wat.add(r.waterLossG, pub.sweat_loss_g)
      for (const [ours, p] of [
        [r.dLimTReMin, pub.d_lim_t_re],
        [r.dLimLoss50Min, pub.d_lim_loss_50],
        [r.dLimLossMin, pub.d_lim_loss_95],
      ] as const) {
        const c = publishedDlim(ours, p)
        if (c.mismatch) mm++
        else if (c.diff !== null) dl.addDiff(c.diff)
        else dl.addDiff(0)
      }
    }
    const isoBase = {
      model: 'phs' as const,
      engine: `phs.ts phsRun (ISO 7933:2004, ${variant === 'defaults' ? 'engine defaults' : 'c_sp 57.83 of the 2004 BASIC program'})`,
      reference: 'ISO 7933:2004 Annex F published results (10 cases)',
      kind: 'published_values' as const,
      fixture: `${path} vectors[group=iso_7933_2004_annex_f].iso_published`,
      nCases: annex04.length,
      toleranceKind: 'abs' as const,
      toleranceSource: 'src/engine/phs.test.ts "ISO 7933 Annex F published cases"',
    }
    const tag = variant === 'defaults' ? '' : ' (2004 BASIC c_sp)'
    out.push(makeCheck({ ...isoBase, id: `phs.iso2004.${variant}.t_re`, title: `ISO 7933:2004 Annex F rectal temperature${tag}`, quantity: 't_re at 480 min', unit: '°C', tolerance: tolT }, tre.summary()))
    out.push(makeCheck({ ...isoBase, id: `phs.iso2004.${variant}.water`, title: `ISO 7933:2004 Annex F water loss${tag}`, quantity: 'sweat loss at 480 min', unit: 'g', tolerance: tolW }, wat.summary()))
    out.push(makeCheck({ ...isoBase, id: `phs.iso2004.${variant}.dlim`, title: `ISO 7933:2004 Annex F D_lim${tag}`, quantity: 'D_lim,tre, D_lim,loss50, D_lim,loss95', unit: 'min', tolerance: tolD }, dl.summary(), mm))
  }

  // ISO 7933:2023 Annex F (5 published cases), engine defaults.
  const annex23 = fx.vectors.filter((v) => v.group === 'iso_7933_2023_annex_f')
  const tre = new DiffSet()
  const watRel = new DiffSet()
  const dl = new DiffSet()
  let mm = 0
  let dlimTolOk = true
  for (const v of annex23) {
    const pub = v.iso_published
    if (!pub || pub.sweat_rate_final_g_per_h === undefined) continue
    const r = phsVector(v, {})
    tre.add(r.tReC, pub.t_re)
    watRel.addDiff(r.waterLossG / pub.sweat_loss_g - 1)
    watRel.addDiff(r.sweatRateGPerH / pub.sweat_rate_final_g_per_h - 1)
    const loss = publishedDlim(r.dLimLossMin, pub.d_lim_loss_95)
    const trd = publishedDlim(r.dLimTReMin, pub.d_lim_t_re)
    for (const [c, tol] of [
      [loss, 3],
      [trd, 2],
    ] as const) {
      if (c.mismatch) mm++
      else {
        dl.addDiff(c.diff ?? 0)
        if (c.diff !== null && Math.abs(c.diff) > tol) dlimTolOk = false
      }
    }
  }
  const iso23Base = {
    model: 'phs' as const,
    engine: 'phs.ts phsRun (ISO 7933:2023, engine defaults incl. hcMode tclIteration)',
    reference: 'ISO 7933:2023 Annex F published results (5 cases)',
    kind: 'published_values' as const,
    fixture: `${path} vectors[group=iso_7933_2023_annex_f].iso_published`,
    nCases: annex23.length,
    toleranceKind: 'abs' as const,
    toleranceSource: 'src/engine/phs.test.ts "2023 Annex F (5 cases) … within the stated annex residuals"',
  }
  out.push(makeCheck({ ...iso23Base, id: 'phs.iso2023.t_re', title: 'ISO 7933:2023 Annex F rectal temperature', quantity: 't_re at 480 min', unit: '°C', tolerance: 0.1 }, tre.summary()))
  out.push(
    makeCheck(
      { ...iso23Base, id: 'phs.iso2023.water_rel', title: 'ISO 7933:2023 Annex F water loss and final sweat rate', quantity: 'relative error of sweat loss and SW_p (g/h)', unit: 'relative', tolerance: 0.006, toleranceKind: 'abs' },
      watRel.summary(),
    ),
  )
  out.push(
    makeCheck(
      {
        ...iso23Base,
        id: 'phs.iso2023.dlim',
        title: 'ISO 7933:2023 Annex F D_lim',
        quantity: 'D_lim,loss (±3 min) and D_lim,tcr (±2 min)',
        unit: 'min',
        tolerance: 3,
        note: 'D_lim,tcr is held to ±2 min and D_lim,loss to ±3 min (the annex rounding residuals).',
      },
      dl.summary(),
      mm,
      dlimTolOk,
    ),
  )
  return out
}

// ─────────────────────────────── TWL ───────────────────────────────

interface TwlFxVector {
  id: string
  group: string
  inputs: {
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
  expected: { twl_w_m2: number; twl_alt_1p8_w_m2: number; tsk_c: number; flags: string[] }
  tol: { twl_w_m2_abs: number; tsk_c_abs: number }
  published?: { twl_w_m2: number | null }
}

interface TwlTableICell {
  block: 'A' | 'B' | 'C'
  db: number
  wb: number
  published: number | null
  physical: number
  alt_1p8: number
}

interface TwlFixture {
  environment: Record<string, string>
  vectors: TwlFxVector[]
  tableI_full: TwlTableICell[]
  validation: { checks: { check: string; value: number; limit: number }[] }
}

function twlInput(v: TwlFxVector, variant: TwlVariant): TwlInput {
  const i = v.inputs
  const humidity: TwlHumidityInput =
    i.humidity_input === 'twb'
      ? { twbPsychrometricC: i.twb_psychrometric_c as number }
      : i.humidity_input === 'rh'
        ? { rhPct: i.rh_pct as number }
        : { paKpa: i.pa_kpa as number }
  const radiant: TwlRadiantInput = i.tg_c !== null ? { tgC: i.tg_c, globeDiameterM: i.globe_diameter_m ?? 0.15 } : { mrtC: i.mrt_c as number }
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

/** Brake & Bates 2002 Table I block conditions (twl.test.ts TABLE_I_BLOCKS; twl_and_regulation.md §1.8). */
const TABLE_I_BLOCKS = {
  A: { mrtMinusDb: 2, windMs: 0.2, pKpa: 101, iclClo: 0.45, perm: 0.45 },
  B: { mrtMinusDb: 0, windMs: 0.5, pKpa: 115, iclClo: 0.69, perm: 0.4 },
  C: { mrtMinusDb: 3, windMs: 1.5, pKpa: 80, iclClo: 0.35, perm: 0.45 },
} as const

function tableICell(c: TwlTableICell, variant: TwlVariant): { twl: number; x: number } {
  const b = TABLE_I_BLOCKS[c.block]
  const r = computeTwl({ tdbC: c.db, twbPsychrometricC: c.wb, mrtC: c.db + b.mrtMinusDb, windMs: b.windMs, pKpa: b.pKpa, iclClo: b.iclClo, vapourPermeation: b.perm, variant })
  return { twl: r.twlWm2, x: r.sweatToEmaxRatio }
}

function twlChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/twl.json'
  const fx = prov.readJson(path) as TwlFixture
  env.twl = fx.environment
  const limit = (name: string): number => {
    const c = fx.validation.checks.find((x) => x.check === name)
    if (!c) throw new Error(`twl.json validation check ${name} missing`)
    return c.limit
  }
  const out: ReferenceCheck[] = []

  // Reference implementation: 42 vectors, both variants, TWL and skin temperature, flags.
  const twlD = new DiffSet()
  const tskD = new DiffSet()
  let flagMismatch = 0
  let tolOk = true
  for (const v of fx.vectors) {
    const p = computeTwl(twlInput(v, 'physical'))
    const a = computeTwl(twlInput(v, 'alt_1p8'))
    twlD.add(p.twlWm2, v.expected.twl_w_m2)
    twlD.add(a.twlWm2, v.expected.twl_alt_1p8_w_m2)
    tskD.add(p.tskC, v.expected.tsk_c)
    if (JSON.stringify(p.flags) !== JSON.stringify(v.expected.flags)) flagMismatch++
    if (Math.abs(p.twlWm2 - v.expected.twl_w_m2) > v.tol.twl_w_m2_abs || Math.abs(a.twlWm2 - v.expected.twl_alt_1p8_w_m2) > v.tol.twl_w_m2_abs) tolOk = false
  }
  const refBase = {
    model: 'twl' as const,
    engine: 'twl.ts computeTwl (physical and alt_1p8 variants)',
    reference: 'Reference implementation of Brake & Bates 2002 (scripts/oracles/twl_oracle.py; cross-checked by scripts/oracles/twl_independent_check.js)',
    kind: 'reference_implementation' as const,
    fixture: `${path} vectors`,
    nCases: fx.vectors.length,
    toleranceKind: 'abs' as const,
    toleranceSource: 'src/engine/twl.test.ts (per-vector tol: ±0.05 W/m², ±0.001 K)',
  }
  out.push(makeCheck({ ...refBase, id: 'twl.reference.twl', title: 'TWL, 42 vectors (published, Abu Dhabi, edge, zone-boundary cases)', quantity: 'TWL', unit: 'W/m²', tolerance: 0.05 }, twlD.summary(), flagMismatch, tolOk))
  out.push(makeCheck({ ...refBase, id: 'twl.reference.tsk', title: 'Skin temperature at the TWL solution', quantity: 't_sk', unit: '°C', tolerance: 0.001 }, tskD.summary()))

  // Table I: oracle reproduction (75 cells × 2 variants).
  const oracleD = new DiffSet()
  for (const c of fx.tableI_full) {
    oracleD.add(tableICell(c, 'physical').twl, c.physical)
    oracleD.add(tableICell(c, 'alt_1p8').twl, c.alt_1p8)
  }
  out.push(
    makeCheck(
      {
        ...refBase,
        id: 'twl.tableI.oracle',
        title: 'Brake & Bates 2002 Table I conditions, engine vs reference implementation (75 cells × 2 variants)',
        fixture: `${path} tableI_full (physical, alt_1p8)`,
        nCases: fx.tableI_full.length,
        quantity: 'TWL',
        unit: 'W/m²',
        tolerance: 1e-3,
        toleranceSource: 'src/engine/twl.test.ts (Table I oracle reproduction < 1e-3 W/m²)',
      },
      oracleD.summary(),
    ),
  )

  // Table I vs the printed values (62 numeric cells; printed values appear truncated).
  const numeric = fx.tableI_full.filter((c) => c.published !== null)
  const alt = new DiffSet()
  const zoneC = new DiffSet()
  const zoneB = new DiffSet()
  for (const c of numeric) {
    const pub = c.published as number
    alt.add(tableICell(c, 'alt_1p8').twl, pub)
    const p = tableICell(c, 'physical')
    if (p.x > 1.7) zoneC.add(p.twl, pub)
    else zoneB.add(p.twl, pub)
  }
  const tabBase = {
    model: 'twl' as const,
    engine: 'twl.ts computeTwl',
    reference: 'Brake & Bates 2002, Appl Occup Environ Hyg 17(3):176–186, Table I (printed integers, apparently truncated)',
    kind: 'published_values' as const,
    fixture: `${path} tableI_full[published ≠ null]`,
    toleranceKind: 'abs' as const,
    toleranceSource: 'fixtures/twl.json validation.checks (twl_oracle.py acceptance limits)',
  }
  out.push(
    makeCheck(
      { ...tabBase, id: 'twl.tableI.published.alt_1p8', title: 'Table I printed values, alt_1p8 variant (all 62 numeric cells)', nCases: numeric.length, quantity: 'TWL', unit: 'W/m²', tolerance: limit('tableI_alt_1p8_max_abs') },
      alt.summary(),
    ),
  )
  out.push(
    makeCheck(
      {
        ...tabBase,
        id: 'twl.tableI.published.physical_zoneC',
        title: 'Table I printed values, physical variant (engine default), sweat-limited cells (x > 1.7)',
        nCases: zoneC.size,
        quantity: 'TWL',
        unit: 'W/m²',
        tolerance: limit('tableI_physical_zoneC_max_abs'),
      },
      zoneC.summary(),
    ),
  )
  const zb = zoneB.summary()
  out.push(
    makeCheck(
      {
        ...tabBase,
        id: 'twl.tableI.published.physical_zoneB',
        title: 'Table I printed values, physical variant, evaporation-limited cells (80 kPa block, WB 24–26 °C)',
        nCases: zoneB.size,
        quantity: 'TWL',
        unit: 'W/m²',
        tolerance: -limit('tableI_physical_min_err'),
        note: 'The physical reading sits up to 10.1 W/m² BELOW the printed values here (more protective); alt_1p8 reproduces them within 1.9 W/m².',
      },
      zb,
    ),
  )

  // Published worked examples (B&B 2002 text, App. 2; AOH 2002 Table 2).
  const pubCheck = (id: string, title: string, ids: string[], tol: number, note?: string): ReferenceCheck => {
    const d = new DiffSet()
    for (const vid of ids) {
      const v = fx.vectors.find((x) => x.id === vid)
      if (!v || !v.published || v.published.twl_w_m2 === null) throw new Error(`twl.json vector ${vid} missing published value`)
      d.add(computeTwl(twlInput(v, 'physical')).twlWm2, v.published.twl_w_m2)
    }
    const c: CheckBase = {
      ...tabBase,
      id,
      title,
      reference: 'Brake & Bates 2002 (AEOH 17(3) text; Ann Occup Hyg 2002 Table 2) as printed',
      fixture: `${path} vectors (${ids.join(', ')})`,
      nCases: ids.length,
      quantity: 'TWL',
      unit: 'W/m²',
      tolerance: tol,
    }
    if (note) c.note = note
    return makeCheck(c, d.summary())
  }
  out.push(pubCheck('twl.published.text', 'B&B 2002 worked examples p.180–181 (110, 158 W/m²)', ['BB2002-TEXT-1', 'BB2002-TEXT-2'], limit('text_examples_max_abs')))
  out.push(pubCheck('twl.published.app2', 'B&B 2002 App. 2 "typically ≈ 220 W/m²" example', ['BB2002-TEXT-3'], limit('app2_220_max_abs'), 'The published value is approximate ("typically").'))
  out.push(pubCheck('twl.published.aoh2002_highwind', 'AOH 2002 Table 2, high-wind cases (3.0 m/s)', ['BB2002AOH-T2-B', 'BB2002AOH-T2-D'], limit('aoh_t2_highwind_max_abs')))
  out.push(
    pubCheck(
      'twl.published.aoh2002_lowwind',
      'AOH 2002 Table 2, low-wind cases (0.2 m/s)',
      ['BB2002AOH-T2-A', 'BB2002AOH-T2-C'],
      limit('aoh_t2_lowwind_max_abs'),
      'The model reads 5.6–7.6 W/m² above these printed low-wind values (possibly a pre-publication model version); Table I agrees.',
    ),
  )
  return out
}

// ─────────────────────────────── NIOSH / ACGIH / heat index ───────────────────────────────

interface LimitsVector {
  id: string
  group: string
  fn: string
  inputs: Record<string, unknown>
  expected: Record<string, unknown>
  tol: { abs?: number; exact?: boolean }
}

interface LimitsFixture {
  environment: Record<string, string>
  constants: { noaa_chart_F_niosh2016_appC: Record<string, number[]> }
  summary: { noaa_chart: { cells: number; rothfusz_exact: number; rothfusz_within_1F: number; nws_full_within_1F: number } }
  vectors: LimitsVector[]
}

function num(x: unknown, label: string): number {
  if (typeof x !== 'number') throw new Error(`${label}: expected a number, got ${JSON.stringify(x)}`)
  return x
}

const BRANCH_TO_BINDING: Record<string, AllowedWorkBinding> = { continuous_ok: 'continuous_ok', bisection: 'work_rest', rest_exceeds_limit: 'rest_exceeds_limit' }

function limitsChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/limits.json'
  const fx = prov.readJson(path) as LimitsFixture
  env.limits = fx.environment
  const vectors = (g: string): LimitsVector[] => fx.vectors.filter((v) => v.group === g)
  const out: ReferenceCheck[] = []

  // NIOSH REL / RAL equations and published worked answers.
  const eq = new DiffSet()
  const pub = new DiffSet()
  let pubTol = 0
  for (const v of vectors('niosh_ral_rel')) {
    const mW = num(v.inputs.mW, v.id)
    if (v.fn === 'ralC/relC') {
      eq.add(ralC(mW), num(v.expected.ralC, v.id))
      eq.add(relC(mW), num(v.expected.relC, v.id))
    } else {
      const value = v.fn === 'relC' ? relC(mW) : ralC(mW)
      eq.add(value, num(v.expected.valueC, v.id))
      pub.add(value, num(v.expected.publishedC_2dp, v.id))
      pubTol = Math.max(pubTol, v.tol.abs ?? 0.005)
    }
  }
  for (const v of vectors('osha_table2_reference')) {
    const mW = num(v.inputs.mW, v.id)
    eq.add(ralC(mW), num(v.expected.ralC, v.id))
    eq.add(relC(mW), num(v.expected.relC, v.id))
  }
  out.push(
    makeCheck(
      {
        id: 'niosh.rel_ral',
        model: 'niosh',
        title: 'NIOSH REL and RAL equations',
        engine: 'limits.ts relC, ralC',
        reference: 'NIOSH 2016-106 §8.1 equations, scripts/oracles/limits_oracle.py',
        kind: 'reference_implementation',
        fixture: `${path} vectors[niosh_ral_rel, osha_table2_reference]`,
        nCases: vectors('niosh_ral_rel').length + vectors('osha_table2_reference').length,
        quantity: 'REL, RAL',
        unit: '°C',
        tolerance: 1e-9,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts',
      },
      eq.summary(),
    ),
  )
  out.push(
    makeCheck(
      {
        id: 'niosh.published_answers',
        model: 'niosh',
        title: 'Published two-decimal REL/RAL worked answers (ASSP PSJ 2022)',
        engine: 'limits.ts relC, ralC',
        reference: 'ASSP Professional Safety Journal, Aug 2022 worked answers (2 decimals)',
        kind: 'published_values',
        fixture: `${path} vectors[niosh_ral_rel, fn relC|ralC].publishedC_2dp`,
        nCases: pub.size,
        quantity: 'REL, RAL',
        unit: '°C',
        tolerance: pubTol,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts (half of the last printed digit)',
      },
      pub.summary(),
    ),
  )

  // Allowed work fraction (1-h TWA solver).
  const awf = new DiffSet()
  let awfMismatch = 0
  for (const v of vectors('allowed_work_fraction')) {
    const i = v.inputs
    const r = allowedWorkFraction({
      workW: num(i.mWorkW, v.id),
      restW: num(i.mRestW, v.id),
      wbgtWorkEffC: num(i.wbgtWorkC, v.id),
      wbgtRestEffC: num(i.wbgtRestC, v.id),
      limit: i.acclimatized === true ? 'REL' : 'RAL',
    })
    awf.add(r.f, num(v.expected.f, v.id))
    awf.add(r.marginC, num(v.expected.marginAtFullWorkC, v.id))
    if (r.binding !== BRANCH_TO_BINDING[String(v.expected.branch)]) awfMismatch++
  }
  out.push(
    makeCheck(
      {
        id: 'niosh.allowed_work_fraction',
        model: 'niosh',
        title: 'Allowed work fraction per hour (1-h TWA of WBGT_eff and M vs REL/RAL)',
        engine: 'limits.ts allowedWorkFraction',
        reference: 'Independent solver in scripts/oracles/limits_oracle.py (NIOSH 2016 §8.1 + ACGIH 1-h TWA)',
        kind: 'reference_implementation',
        fixture: `${path} vectors[allowed_work_fraction]`,
        nCases: vectors('allowed_work_fraction').length,
        quantity: 'work fraction f and continuous-work margin',
        unit: 'fraction / °C',
        tolerance: 1e-6,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts (fixture tol.abs)',
      },
      awf.summary(),
      awfMismatch,
    ),
  )

  // ACGIH TLV Table 2.
  const acgih = new DiffSet()
  let acgihMismatch = 0
  for (const v of vectors('acgih_screening_table')) {
    const cell = acgihScreeningCell(String(v.inputs.category) as AcgihScreeningCategory, String(v.inputs.allocation) as AcgihAllocation)
    const e = v.expected
    acgih.add(cell.mTwaW, num(e.mTwaW, v.id))
    acgih.add(cell.tlvRawC, num(e.tlvRawC, v.id))
    acgih.add(cell.alRawC, num(e.alRawC, v.id))
    if (cell.tlvRoundedC !== e.tlvRoundedC || cell.alRoundedC !== e.alRoundedC || cell.publishedTlvC !== e.publishedTlvC || cell.publishedAlC !== e.publishedAlC) acgihMismatch++
  }
  out.push(
    makeCheck(
      {
        id: 'acgih.table2.oracle',
        model: 'acgih',
        title: 'ACGIH Table 2 cells from the REL/RAL equations at the TWA metabolic rate',
        engine: 'limits.ts acgihScreeningCell',
        reference: 'scripts/oracles/limits_oracle.py (pythermalcomfort-independent equation evaluation)',
        kind: 'reference_implementation',
        fixture: `${path} vectors[acgih_screening_table]`,
        nCases: vectors('acgih_screening_table').length,
        quantity: 'M_TWA (W), TLV and Action Limit (°C, unrounded)',
        unit: 'W / °C',
        tolerance: 1e-9,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts',
      },
      acgih.summary(),
      acgihMismatch,
    ),
  )
  const cells = new DiffSet()
  let cellMismatch = 0
  const categories: AcgihScreeningCategory[] = ['light', 'moderate', 'heavy', 'very_heavy']
  for (const { allocation } of ACGIH_SCREENING_ROWS) {
    for (const category of categories) {
      const cell = acgihScreeningCell(category, allocation)
      if ((cell.publishedTlvC === null) !== (cell.publishedAlC === null)) cellMismatch++
      if (cell.publishedTlvC !== null && cell.publishedAlC !== null) {
        cells.add(cell.tlvRoundedC, cell.publishedTlvC)
        cells.add(cell.alRoundedC, cell.publishedAlC)
      }
    }
  }
  out.push(
    makeCheck(
      {
        id: 'acgih.table2.published',
        model: 'acgih',
        title: 'Every published ACGIH Table 2 TLV and Action Limit cell, reproduced (rest 115 W, nearest 0.5 °C half-up)',
        engine: 'limits.ts acgihScreeningCell',
        reference: 'ACGIH TLVs Heat Stress and Strain, Table 2 (as printed)',
        kind: 'published_values',
        fixture: 'src/engine/limits.ts ACGIH_SCREENING_C (transcribed; equals fixtures/limits.json constants)',
        nCases: ACGIH_SCREENING_ROWS.length * categories.length,
        quantity: 'TLV and Action Limit, rounded',
        unit: '°C',
        tolerance: 0,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts (exact reproduction of all 26 printed values)',
      },
      cells.summary(),
      cellMismatch,
    ),
  )

  // NWS heat index.
  const hi = new DiffSet()
  let hiMismatch = 0
  for (const v of vectors('heat_index_nws')) {
    const e = v.expected
    if (v.fn === 'heatIndexNwsF') {
      const tF = num(v.inputs.tF, v.id)
      const rh = num(v.inputs.rhPct, v.id)
      const d = heatIndexNwsDetail(tF, rh)
      if (e.hiF_textRule !== undefined) {
        hi.add(d.hiF, num(e.hiF_textRule, v.id))
        if (d.branch !== e.branch_textRule) hiMismatch++
        hi.add(rothfuszF(tF, rh), num(e.hiF_jsRule, v.id))
        continue
      }
      hi.add(d.hiF, num(e.hiF, v.id))
      hi.add(d.hiC, num(e.hiC, v.id))
      if (d.branch !== e.branch) hiMismatch++
    } else {
      const tC = num(v.inputs.tC, v.id)
      const rh = num(v.inputs.rhPct, v.id)
      hi.add(heatIndexNwsC(tC, rh), num(e.hiC, v.id))
      if (heatIndexNwsDetail(cToF(tC), rh).branch !== e.branch) hiMismatch++
      if (e.rothfuszOnlyC !== undefined) hi.add(fToC(rothfuszF(cToF(tC), rh)), num(e.rothfuszOnlyC, v.id))
    }
  }
  for (const v of vectors('heat_index_chart_crosscheck')) {
    const tF = num(v.inputs.tF, v.id)
    const rh = num(v.inputs.rhPct, v.id)
    hi.add(heatIndexNwsF(tF, rh), num(v.expected.nwsFullF, v.id))
    hi.add(rothfuszF(tF, rh), num(v.expected.rothfuszOnlyF, v.id))
    if (heatIndexNwsDetail(tF, rh).branch !== v.expected.nwsBranch) hiMismatch++
  }
  out.push(
    makeCheck(
      {
        id: 'heat_index.nws',
        model: 'heat_index',
        title: 'NWS heat index algorithm (Steadman simple formula, Rothfusz regression, adjustments)',
        engine: 'limits.ts heatIndexNwsF, heatIndexNwsC, heatIndexNwsDetail, rothfuszF',
        reference: 'NWS/WPC heat index equation page (Rothfusz 1990 SR 90-23), scripts/oracles/limits_oracle.py; pythermalcomfort cross-check',
        kind: 'reference_implementation',
        fixture: `${path} vectors[heat_index_nws, heat_index_chart_crosscheck]`,
        nCases: vectors('heat_index_nws').length + vectors('heat_index_chart_crosscheck').length,
        quantity: 'heat index',
        unit: '°F / °C',
        tolerance: 1e-9,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts',
      },
      hi.summary(),
      hiMismatch,
    ),
  )
  const chart = fx.constants.noaa_chart_F_niosh2016_appC
  const roth = new DiffSet()
  let nwsWithin1 = 0
  let nwsMax = 0
  for (const [rhKey, row] of Object.entries(chart)) {
    row.forEach((chartF, i) => {
      const tF = 80 + 2 * i
      const rh = Number(rhKey)
      roth.add(Math.round(rothfuszF(tF, rh)), chartF)
      const dn = Math.abs(Math.round(heatIndexNwsF(tF, rh)) - chartF)
      if (dn <= 1) nwsWithin1++
      nwsMax = Math.max(nwsMax, dn)
    })
  }
  const rs = roth.summary()
  out.push(
    makeCheck(
      {
        id: 'heat_index.noaa_chart',
        model: 'heat_index',
        title: 'NOAA heat-index chart (NIOSH 2016 App. C), 135 printed cells',
        engine: 'limits.ts rothfuszF (rounded to whole °F)',
        reference: 'NIOSH 2016-106 Appendix C chart (adapted from NOAA)',
        kind: 'published_values',
        fixture: `${path} constants.noaa_chart_F_niosh2016_appC`,
        nCases: rs.n,
        quantity: 'heat index, whole °F',
        unit: '°F',
        tolerance: 1,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/limits.test.ts (all 135 cells within 1 °F; counts equal the oracle summary)',
        note: `The full NWS algorithm (with its low/high-RH adjustments, which the chart omits) is within 1 °F in ${nwsWithin1}/${rs.n} cells (max ${nwsMax} °F); oracle summary ${fx.summary.noaa_chart.nws_full_within_1F}/${fx.summary.noaa_chart.cells}.`,
      },
      rs,
      0,
      nwsWithin1 === fx.summary.noaa_chart.nws_full_within_1F,
    ),
  )
  return out
}

// ─────────────────────────────── ECTemp / PSI / SQI ───────────────────────────────

interface PhysioFixture {
  _meta: { generated_by: string; sources: Record<string, string>; tolerance_recommendation: { ct_abs: number; v_abs: number; psi_abs: number } }
  ectemp_vectors: { name: string; ct0: number; v0: number; hr: (number | null)[]; ct_quadratic?: number[]; v_quadratic?: number[]; ct_sigmoid?: number[]; v_sigmoid?: number[]; psi?: number; r_scale?: number }[]
  psi_vectors: { ct: number; hr: number; ct0: number; hr0: number; psi: number; category: string }[]
  apsi_vectors: { ct: number; hr: number; ct_rest: number; hr_rest: number; age: number; tsk: number | null; hr_crit: number; ct_crit: number; apsi: number }[]
  sqi_vectors: { name: string; expected_interval_s: number; samples: [number, number | null, boolean][]; psi: number; valid: boolean; hr_mean: number | null; flags: string[]; r_scale: number | null }[]
}

function physioChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/physio/physio_fixtures.json'
  const fx = prov.readJson(path) as PhysioFixture
  env.physio = { generated_by: `scripts/oracles/physio/${fx._meta.generated_by}`, sources: fx._meta.sources }
  const tol = fx._meta.tolerance_recommendation
  const out: ReferenceCheck[] = []

  const ct = new DiffSet()
  const vv = new DiffSet()
  for (const vec of fx.ectemp_vectors) {
    const rScale = vec.r_scale !== undefined ? sqiRScale(vec.psi as number) : 1
    for (const model of ['quadratic', 'sigmoid'] as EctempModel[]) {
      const expCt = model === 'quadratic' ? vec.ct_quadratic : vec.ct_sigmoid
      const expV = model === 'quadratic' ? vec.v_quadratic : vec.v_sigmoid
      if (!expCt || !expV) continue
      const r = ectempRun(vec.hr, { ct0C: vec.ct0, v0: vec.v0, rScale, model })
      r.ctC.forEach((x, i) => ct.add(x, expCt[i]))
      r.variance.forEach((x, i) => vv.add(x, expV[i]))
    }
  }
  const ecBase = {
    model: 'ectemp' as const,
    engine: 'physio.ts ectempRun (quadratic Buller 2013 and sigmoid Looney 2018 observation models)',
    reference: 'USARIEM ECTemp algorithm (Buller 2013 Physiol Meas 34:781; Looney 2018), scripts/oracles/physio/ectemp_reference.py',
    kind: 'reference_implementation' as const,
    fixture: `${path} ectemp_vectors`,
    nCases: fx.ectemp_vectors.length,
    toleranceKind: 'abs' as const,
    toleranceSource: 'src/engine/physio.test.ts (fixture _meta.tolerance_recommendation)',
  }
  out.push(makeCheck({ ...ecBase, id: 'ectemp.ct', title: 'Minute-by-minute core-temperature estimate (Kalman filter)', quantity: 'estimated CT', unit: '°C', tolerance: tol.ct_abs }, ct.summary()))
  out.push(makeCheck({ ...ecBase, id: 'ectemp.variance', title: 'Kalman variance of the estimate', quantity: 'variance', unit: '°C²', tolerance: tol.v_abs }, vv.summary()))

  const psi = new DiffSet()
  let bandMismatch = 0
  for (const p of fx.psi_vectors) {
    const v = psiMoran(p.ct, p.hr, p.ct0, p.hr0)
    if (v === null) {
      bandMismatch++
      continue
    }
    psi.add(v, p.psi)
    if (psiBand(v) !== p.category) bandMismatch++
  }
  for (const a of fx.apsi_vectors) {
    const crit = apsiCritical(a.ct, a.age, a.tsk)
    psi.add(crit.hrCritBpm, a.hr_crit)
    psi.add(crit.ctCritC, a.ct_crit)
    const v = apsi(a.ct, a.hr, a.ct_rest, a.hr_rest, a.age, a.tsk)
    if (v === null) bandMismatch++
    else psi.add(v, a.apsi)
  }
  out.push(
    makeCheck(
      {
        id: 'psi.moran_apsi',
        model: 'psi',
        title: 'Physiological Strain Index (Moran 1998) with bands, and adaptive PSI',
        engine: 'physio.ts psiMoran, psiBand, apsi, apsiCritical',
        reference: 'Moran et al. 1998 Am J Physiol 275:R129; aPSI per US11564579B2; scripts/oracles/physio/ectemp_reference.py',
        kind: 'reference_implementation',
        fixture: `${path} psi_vectors, apsi_vectors`,
        nCases: fx.psi_vectors.length + fx.apsi_vectors.length,
        quantity: 'PSI, aPSI, HRcrit, CTcrit',
        unit: 'index / bpm / °C',
        tolerance: tol.psi_abs,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/physio.test.ts (1e-6)',
      },
      psi.summary(),
      bandMismatch,
    ),
  )

  const sqi = new DiffSet()
  let sqiMismatch = 0
  for (const v of fx.sqi_vectors) {
    const r = minuteSqi(
      v.samples.map(([tSec, bpm, contactOk]) => ({ tSec, bpm, contactOk })),
      v.expected_interval_s,
    )
    sqi.add(r.sqi, v.psi)
    if (v.hr_mean !== null && r.hrMeanBpm !== null) sqi.add(r.hrMeanBpm, v.hr_mean)
    if (v.r_scale !== null) sqi.add(r.rScale, v.r_scale)
    if (r.minuteValid !== v.valid || JSON.stringify(r.flags) !== JSON.stringify(v.flags) || (v.hr_mean === null) !== (r.hrMeanBpm === null) || (v.r_scale === null && r.rScale !== Infinity)) sqiMismatch++
  }
  out.push(
    makeCheck(
      {
        id: 'sqi.minute',
        model: 'sqi',
        title: 'Minute heart-rate signal-quality index, validity, flags and noise scaling',
        engine: 'physio.ts minuteSqi',
        reference: 'Li, Mark & Clifford 2009 BioMed Eng Online 8:13 noise scaling; scripts/oracles/physio/ectemp_reference.py',
        kind: 'reference_implementation',
        fixture: `${path} sqi_vectors`,
        nCases: fx.sqi_vectors.length,
        quantity: 'SQI ψ, mean HR, R scale',
        unit: 'index / bpm',
        tolerance: tol.psi_abs,
        toleranceKind: 'abs',
        toleranceSource: 'src/engine/physio.test.ts (1e-6)',
      },
      sqi.summary(),
      sqiMismatch,
    ),
  )
  return out
}

// ─────────────────────────────── Gagge (simulation truth) ───────────────────────────────

interface GaggeFxInputs {
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
type GaggeOutKey = 't_core' | 't_skin' | 'm_bl' | 'm_rsw' | 'w' | 'w_max' | 'e_skin' | 'e_rsw' | 'e_max' | 'q_sensible' | 'q_skin' | 'q_res'
interface GaggeFixture {
  meta: { pythermalcomfort: string; thermofeel: string; steps: number[] }
  cases: { id: string; inputs: GaggeFxInputs; runs: (Record<GaggeOutKey, number> & { steps: number })[] }[]
  mrt: { id: string; fluxes: MrtFluxes; mrt_c: number }[]
}

function gaggeChecks(prov: Provenance, env: Record<string, unknown>): ReferenceCheck[] {
  const path = 'fixtures/gagge.json'
  const fx = prov.readJson(path) as GaggeFixture
  env.gagge = { pythermalcomfort: fx.meta.pythermalcomfort, thermofeel: fx.meta.thermofeel }
  const rel = new DiffSet()
  let values = 0
  for (const c of fx.cases) {
    const i = c.inputs
    const inputs: GaggeInputs = {
      taC: i.tdb,
      trC: i.tr,
      vMs: i.v,
      rhPct: i.rh,
      metabolic: i.met * GAGGE.MET_FACTOR,
      wme: i.wme,
      clo: i.clo,
      bodyPosition: i.position,
      bsa: i.body_surface_area,
      pAtmPa: i.p_atm,
      ...(i.w_max === false ? {} : { wMax: i.w_max }),
    }
    const params: GaggeParams = { ...GAGGE_PARITY_PARAMS, maxSkinBloodFlow: i.max_skin_blood_flow, maxSweatingGm2h: i.max_sweating }
    for (const run of c.runs) {
      const s = gaggeStep(createGaggeState({ initialMetabolicWm2: i.met * GAGGE.MET_FACTOR }), inputs, run.steps, params)
      const got: Record<GaggeOutKey, number> = {
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
      for (const k of Object.keys(got) as GaggeOutKey[]) {
        rel.addDiff((got[k] - run[k]) / Math.max(1, Math.abs(run[k])))
        values++
      }
    }
  }
  const mrt = new DiffSet()
  for (const v of fx.mrt) mrt.add(humanMrtFromFluxesC(v.fluxes), v.mrt_c)
  return [
    makeCheck(
      {
        id: 'gagge.parity',
        model: 'gagge',
        title: `Two-node thermoregulation, ${fx.cases.length} conditions × ${fx.meta.steps.length} durations × 12 outputs`,
        engine: 'sim/gagge.ts gaggeStep (parity parameters)',
        reference: `pythermalcomfort ${fx.meta.pythermalcomfort} two_nodes_gagge (Gagge, Fobelets & Berglund 1986), scripts/oracles/gagge_oracle.py`,
        kind: 'reference_implementation',
        fixture: `${path} cases`,
        nCases: fx.cases.length,
        quantity: 'core/skin temperature, blood flow, sweat, wettedness, heat fluxes',
        unit: 'relative',
        tolerance: 1e-9,
        toleranceKind: 'rel',
        toleranceSource: 'src/sim/gagge.test.ts (|Δ| / max(1, |ref|) < 1e-9)',
        note: `${values} values compared. Gagge is the simulation's ground truth, deliberately different from the engine's PHS (docs/SIMULATION.md §1).`,
      },
      rel.summary(),
    ),
    makeCheck(
      {
        id: 'gagge.truth_mrt_fluxes',
        model: 'gagge',
        title: 'Simulation-truth human MRT from radiation fluxes',
        engine: 'sim/truth.ts humanMrtFromFluxesC',
        reference: `thermofeel ${fx.meta.thermofeel} calculate_mean_radiant_temperature (Di Napoli et al. 2020)`,
        kind: 'reference_implementation',
        fixture: `${path} mrt`,
        nCases: fx.mrt.length,
        quantity: 'MRT',
        unit: '°C',
        tolerance: 1e-9,
        toleranceKind: 'abs',
        toleranceSource: 'src/sim/truth.test.ts (< 1e-9 °C)',
      },
      mrt.summary(),
    ),
  ]
}

// ─────────────────────────────── Run ───────────────────────────────

/**
 * Run every reference-agreement check and (by default) write public/data/validation/reference.json.
 * Basis: docs/SIMULATION.md evidence class "Reference agreement"; tolerances from the colocated unit tests.
 */
export function runReference(opts: RunOptions = {}): ReferenceReport {
  const log = opts.log ?? true
  const prov = new Provenance()
  const env: Record<string, unknown> = {}
  const { value: checks, ms } = timed(() => [
    ...wbgtChecks(prov, env),
    ...mrtChecks(prov, env),
    ...phsChecks(prov, env),
    ...twlChecks(prov, env),
    ...limitsChecks(prov, env),
    ...physioChecks(prov, env),
    ...gaggeChecks(prov, env),
  ])
  const models = (Object.keys(MODEL_LABELS) as ReferenceModelId[]).map((model): ReferenceModelSummary => {
    const own = checks.filter((c) => c.model === model)
    return {
      model,
      label: MODEL_LABELS[model],
      checks: own.length,
      passed: own.filter((c) => c.pass).length,
      values: own.reduce((s, c) => s + c.nValues, 0),
      pass: own.length > 0 && own.every((c) => c.pass),
    }
  })
  const passed = checks.filter((c) => c.pass).length
  const report: ReferenceReport = {
    schema: 'zill.validation.reference/v1',
    evidenceClass: 'reference_agreement',
    title: 'Agreement of the Zill engine with reference implementations and published values',
    generatedBy: 'scripts/validate/reference.ts',
    command: 'npm run validate',
    stamp: codeStamp(prov.inputsSha256()),
    provenance: { inputs: prov.records(), oracleEnvironments: env },
    config: {
      note: 'Each check runs the engine on the oracle fixture with the options the colocated unit test uses; maxAbsDiff/meanAbsDiff are |engine − reference|. Differences are rounded to 3 significant digits.',
    },
    summary: { checks: checks.length, passed, allPass: passed === checks.length, models },
    checks,
  }
  if (opts.write ?? true) {
    const bytes = writeValidationJson('reference', report)
    if (log) console.log(`[reference] ${passed}/${checks.length} checks pass · ${ms.toFixed(0)} ms · reference.json ${(bytes / 1024).toFixed(1)} KiB`)
  }
  if (log) {
    for (const c of checks.filter((x) => !x.pass)) console.warn(`[reference] FAIL ${c.id}: max |Δ| ${c.maxAbsDiff} ${c.unit} (tol ${c.tolerance}), mismatches ${c.mismatches}`)
  }
  return report
}

if (isMainModule(import.meta.url)) runReference()
