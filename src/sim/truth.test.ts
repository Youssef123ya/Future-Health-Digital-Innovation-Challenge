import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { getSite } from '../data/sites'
import { interpolateEnv, parseArchiveFile } from '../data/weather'
import { ACGIH_METABOLIC_W } from '../engine/limits'
import { minuteSqi } from '../engine/physio'
import { solarPosition } from '../engine/solar'
import { epochFromLocal } from '../engine/time'
import type { WorkerProfile } from '../engine/types'
import { wind2mFrom10m } from '../engine/wbgt'
import { createRng } from './rng'
import {
  TRUTH_PARAMS,
  TRUTH_UNIFORMS_PER_MINUTE,
  DRINK_CALIBRATION,
  DRINK_MODEL_BASIS,
  createWearableChain,
  drinkDecision,
  drinkDecisionDetail,
  humanMrtFromFluxesC,
  initTruth,
  respondToCheckin,
  sampleDailyCondition,
  sampleHiddenTraits,
  spontaneousDrinkRateMlPerH,
  stepTruth,
  trueAcclimatizationFraction,
  trueHeartRate,
  trueMetabolicW,
  truthClothing,
  truthDynamicClothing,
  truthHumanMrtC,
  vo2FromMetabolicW,
  wearableSamples,
  withTruthParams,
  type HiddenTraits,
  type MrtFluxes,
  type TruthInputs,
  type TruthParams,
  type TruthState,
} from './truth'

// ─────────────────────────────── Helpers ───────────────────────────────

function profile(over: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id: 'W-T001',
    displayName: 'Test W.',
    crewId: 'crew',
    siteId: 'musaffah',
    language: 'en',
    ageYears: 30,
    sex: 'male',
    massKg: 70,
    heightCm: 170,
    daysOnSite: 300,
    daysAwayRecent: 0,
    experiencedInHeat: true,
    clothing: 'cloth_coveralls',
    riskFlags: [],
    restingHrBpm: 68,
    consent: { wearable: true, healthFlags: true, checkins: true, shareWithMedicOnEscalation: true, aggregateStatistics: true, updatedAt: 0 },
    hasWearable: true,
    ...over,
  }
}
const NEW_ARRIVAL: Partial<WorkerProfile> = { daysOnSite: 1, daysAwayRecent: 200, experiencedInHeat: false }
const T0 = epochFromLocal('2025-08-01T13:00')

/** Traits with the hidden multipliers neutralised, so scenario tests are about the physiology. */
function neutralTraits(p: WorkerProfile, params: TruthParams = TRUTH_PARAMS): HiddenTraits {
  return { ...sampleHiddenTraits(p, createRng(7), params), metabolicMultiplier: 1, sweatGainMultiplier: 1, microclimateOffsetC: 0, symptomSusceptibility: 1 }
}

type Env = Omit<TruthInputs, 'activity' | 'drankMl'>
const CONST_HOT: Env = { taC: 40, rhPct: 35, wind2Ms: 1.5, ghiWm2: 850, fdir: 0.75, cosZenith: 0.95, pHpa: 1000 }
const act = (metabolicW: number, location: 'sun' | 'shade' | 'indoor_cool' = 'sun', clothing: WorkerProfile['clothing'] = 'cloth_coveralls') =>
  ({ metabolicW, location, clothing, hood: false }) as const

function runConst(s: TruthState, env: Env, a: TruthInputs['activity'], minutes: number, seed: string | number = 'run', drankMlPerMin = 0): { s: TruthState; core: number[] } {
  const rng = createRng(seed)
  const core: number[] = []
  for (let i = 0; i < minutes; i++) {
    s = stepTruth(s, { ...env, activity: a, drankMl: drankMlPerMin }, 1, rng)
    core.push(s.gagge.tCoreC)
  }
  return { s, core }
}

// Real weather: Musaffah, 1 Aug 2025 (IFS archive), minute-interpolated instantaneous radiation.
const musaffah = getSite('musaffah')
const series = parseArchiveFile(JSON.parse(readFileSync(new URL('../../public/data/weather/archive/musaffah_2025.json', import.meta.url), 'utf8')))
function musaffahMinutes(from: string, to: string): Env[] {
  return interpolateEnv(series.samples, epochFromLocal(from), epochFromLocal(to), { lat: musaffah.lat, lon: musaffah.lon }, 1).map((m) => {
    const cz = solarPosition(m.t, musaffah.lat, musaffah.lon).cosApparentZenith
    return {
      taC: m.taC,
      rhPct: m.rhPct,
      wind2Ms: wind2mFrom10m(m.wind10Ms, cz, m.ghiWm2).u2Ms,
      ghiWm2: m.ghiWm2,
      fdir: m.ghiWm2 > 0 ? (m.directWm2 ?? 0) / m.ghiWm2 : 0,
      cosZenith: cz,
      pHpa: m.pHpa,
    }
  })
}

// ─────────────────────────────── Parameters ───────────────────────────────

describe('TRUTH_PARAMS', () => {
  it('is one deep-frozen object covering every model part', () => {
    for (const k of ['traits', 'acclimatisation', 'illness', 'hydration', 'environment', 'mrt', 'clothing', 'hr', 'wearable', 'selfPacing', 'behaviour', 'symptoms', 'reporting', 'events', 'cooling'] as const) {
      expect(TRUTH_PARAMS[k]).toBeDefined()
    }
    expect(Object.isFrozen(TRUTH_PARAMS.symptoms.heatExhaustion)).toBe(true)
    expect(() => {
      ;(TRUTH_PARAMS.hr as { kTBpmPerC: number }).kTBpmPerC = 1
    }).toThrow()
  })

  it('withTruthParams deep-merges overrides without touching the defaults', () => {
    const p = withTruthParams({ wearable: { noiseMultiplier: 2 }, symptoms: { cns: { fromC: 39.0 } } })
    expect(p.wearable.noiseMultiplier).toBe(2)
    expect(p.wearable.dropoutOnPerS).toBe(TRUTH_PARAMS.wearable.dropoutOnPerS)
    expect(p.symptoms.cns.fromC).toBe(39.0)
    expect(p.symptoms.cns.certainC).toBe(40)
    expect(TRUTH_PARAMS.wearable.noiseMultiplier).toBe(1)
  })

  it('event definitions match SIMULATION.md §2.4', () => {
    expect(TRUTH_PARAMS.events).toEqual({ excessiveC: 38.5, excessiveUnacclimatisedC: 38.0, sustainMin: 10, severeC: 39.5, criticalC: 40.0, dehydrationPct: 3 })
  })
})

// ─────────────────────────────── Hidden traits ───────────────────────────────

describe('sampleHiddenTraits / sampleDailyCondition', () => {
  it('is deterministic per seed and uses the profile', () => {
    const p = profile({ ageYears: 40, restingHrBpm: 61 })
    const a = sampleHiddenTraits(p, createRng('w1'))
    expect(sampleHiddenTraits(p, createRng('w1'))).toEqual(a)
    expect(sampleHiddenTraits(p, createRng('w2'))).not.toEqual(a)
    expect(a.hrMaxBpm).toBeCloseTo(208 - 0.7 * 40, 10) // Tanaka 2001
    expect(a.hrRestBpm).toBe(61)
    expect(a.bsaM2).toBeCloseTo(0.202 * 70 ** 0.425 * 1.7 ** 0.725, 10)
  })

  it('distributions: log-normal metabolic multiplier (median 1, σ_ln 0.15), VO₂max falls with age, resting HR fallback', () => {
    const rng = createRng('cohort')
    const lnM: number[] = []
    const young: number[] = []
    const old: number[] = []
    for (let i = 0; i < 4000; i++) {
      const t = sampleHiddenTraits(profile({ id: `W-${i}`, ageYears: i % 2 ? 25 : 55, restingHrBpm: undefined }), rng)
      lnM.push(Math.log(t.metabolicMultiplier))
      ;(i % 2 ? young : old).push(t.vo2maxMlKgMin)
      expect(t.hrRestBpm).toBeGreaterThanOrEqual(48)
      expect(t.hrRestBpm).toBeLessThanOrEqual(95)
    }
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
    const sd = Math.sqrt(mean(lnM.map((x) => (x - mean(lnM)) ** 2)))
    expect(Math.abs(mean(lnM))).toBeLessThan(0.01)
    expect(sd).toBeGreaterThan(0.14)
    expect(sd).toBeLessThan(0.16)
    expect(mean(young) - mean(old)).toBeGreaterThan(10)
  })

  it('true acclimatisation follows days on site / days away', () => {
    const f = (o: Partial<WorkerProfile>) => trueAcclimatizationFraction({ ...profile(), ...o }, { acclimTauFactor: 1 })
    expect(f(NEW_ARRIVAL)).toBe(0)
    expect(f({ daysOnSite: 5, daysAwayRecent: 200, experiencedInHeat: false })).toBeCloseTo(1 - Math.exp(-4 / 3.6), 10)
    expect(f({ daysOnSite: 300, daysAwayRecent: 0, experiencedInHeat: true })).toBe(1)
    expect(f({ daysOnSite: 1, daysAwayRecent: 30, experiencedInHeat: true })).toBeCloseTo(0.25, 10) // 2.5 %/day decay
    expect(f({ daysOnSite: 4, daysAwayRecent: 30, experiencedInHeat: true })).toBeGreaterThan(f({ daysOnSite: 4, daysAwayRecent: 200, experiencedInHeat: false }))
  })

  it('daily condition: ≈ 25 % start hypohydrated, illness rare', () => {
    const traits = sampleHiddenTraits(profile(), createRng(1))
    const rng = createRng('days')
    let hypo = 0
    let ill = 0
    const n = 5000
    for (let i = 0; i < n; i++) {
      const d = sampleDailyCondition(traits, rng)
      if (d.startDehydrationPct >= 1) hypo++
      if (d.illness !== 'none') ill++
    }
    expect(hypo / n).toBeGreaterThan(0.22)
    expect(hypo / n).toBeLessThan(0.3)
    expect(ill / n).toBeLessThan(0.03)
  })
})

// ─────────────────────────────── Radiation and clothing ───────────────────────────────

describe('human MRT (hot ground) and clothing', () => {
  const fx = JSON.parse(readFileSync(new URL('../../fixtures/gagge.json', import.meta.url), 'utf8')) as { mrt: Array<{ id: string; fluxes: MrtFluxes; mrt_c: number }> }

  it('flux formula reproduces thermofeel 2.3.0 calculate_mean_radiant_temperature (Di Napoli 2020)', () => {
    expect(fx.mrt.length).toBeGreaterThanOrEqual(5)
    for (const v of fx.mrt) expect(Math.abs(humanMrtFromFluxesC(v.fluxes) - v.mrt_c), v.id).toBeLessThan(1e-9)
  })

  it('hot ground makes the truth MRT exceed a ground-at-air-temperature MRT; shade < sun; indoor = room', () => {
    const inp = { taC: 44.7, rhPct: 37, ghiWm2: 875, fdir: 0.7, cosZenith: 0.985, location: 'sun' as const }
    const hot = truthHumanMrtC(inp)
    const flat = truthHumanMrtC(inp, withTruthParams({ mrt: { groundKPerWm2: 0 } }))
    expect(hot - flat).toBeGreaterThan(3)
    expect(hot).toBeGreaterThan(65)
    expect(hot).toBeLessThan(85)
    const shade = truthHumanMrtC({ ...inp, location: 'shade' })
    expect(shade).toBeLessThan(hot - 10)
    expect(shade).toBeGreaterThan(inp.taC)
    expect(truthHumanMrtC({ ...inp, location: 'indoor_cool' })).toBe(TRUTH_PARAMS.environment.indoorTaC)
    expect(truthHumanMrtC({ ...inp, siteRadiantBoostC: 2, microclimateOffsetC: 1 }) - hot).toBeCloseTo(2 * 1.5 + 1, 10)
    // Night: no shortwave, finite.
    expect(Number.isFinite(truthHumanMrtC({ ...inp, ghiWm2: 0, cosZenith: -0.3 }))).toBe(true)
  })

  it('clothing: vapour barrier least permeable, hood reduces permeability, wind/movement lower resistance', () => {
    const wc = truthClothing('work_clothes', false)
    const vb = truthClothing('vapour_barrier', false)
    expect(wc).toEqual({ clo: 0.6, icl: 0.45 })
    expect(vb.icl).toBeLessThan(wc.icl / 3)
    expect(truthClothing('fr_coveralls', true).icl).toBeLessThan(truthClothing('fr_coveralls', false).icl)
    const calm = truthDynamicClothing(wc, 0.38, 0.15, 0)
    const windy = truthDynamicClothing(wc, 0.38, 2.5, 0.3)
    expect(windy.clo).toBeLessThan(calm.clo)
    expect(windy.icl).toBeGreaterThan(calm.icl)
    expect(truthDynamicClothing(wc, 0.38, 2.5, 0.3, withTruthParams({ clothing: { dynamicCorrection: false } }))).toEqual(wc)
  })
})

// ─────────────────────────────── Thermoregulation sanity ───────────────────────────────

describe('ground-truth thermoregulation — sanity', () => {
  it('rest in shade at 30 °C keeps core ≈ 37 °C', () => {
    const p = profile()
    const s = initTruth(p, neutralTraits(p), T0)
    const env: Env = { taC: 30, rhPct: 50, wind2Ms: 1.5, ghiWm2: 700, fdir: 0.75, cosZenith: 0.9, pHpa: 1005 }
    const { s: end, core } = runConst(s, env, act(ACGIH_METABOLIC_W.rest, 'shade', 'work_clothes'), 180)
    expect(Math.min(...core)).toBeGreaterThan(36.4)
    expect(end.gagge.tCoreC).toBeGreaterThan(36.6)
    expect(end.gagge.tCoreC).toBeLessThan(37.4)
    expect(end.outcomes).toEqual({})
  })

  it('heavy work in the Musaffah 2025-08-01 afternoon sun: unacclimatised passes 38.5 °C fast, acclimatised later', () => {
    const params = withTruthParams({ selfPacing: { enabled: false } })
    const env = musaffahMinutes('2025-08-01T13:00', '2025-08-01T15:30')
    const crossing = (o: Partial<WorkerProfile>): number | null => {
      const p = profile(o)
      let s = initTruth(p, neutralTraits(p, params), T0, { params })
      const rng = createRng('musaffah')
      for (let i = 0; i < env.length; i++) {
        s = stepTruth(s, { ...env[i], activity: act(ACGIH_METABOLIC_W.heavy), drankMl: 0 }, 1, rng)
        if (s.gagge.tCoreC >= 38.5) return i + 1
      }
      return null
    }
    const unacc = crossing(NEW_ARRIVAL)
    const acc = crossing({})
    console.info(`[truth sanity] Musaffah 2025-08-01 13:00 heavy work in sun: 38.5 °C after ${unacc} min (unacclimatised), ${acc} min (acclimatised)`)
    expect(unacc).not.toBeNull()
    expect(unacc!).toBeGreaterThanOrEqual(10)
    expect(unacc!).toBeLessThanOrEqual(60)
    expect(acc === null || acc >= unacc! + 5).toBe(true)
  })

  it('dehydration raises core (≈ 0.1–0.2 °C per %), drinking limits dehydration, fever raises and acclimatisation lowers core', () => {
    const p = profile()
    const tr = neutralTraits(p)
    const shadeWork: Env = { taC: 36, rhPct: 30, wind2Ms: 2, ghiWm2: 700, fdir: 0.75, cosZenith: 0.9 }
    const a = act(ACGIH_METABOLIC_W.moderate, 'shade')
    const off = withTruthParams({ selfPacing: { enabled: false } })
    const base = runConst(initTruth(p, tr, T0, { params: off }), shadeWork, a, 120).s
    const dry = runConst(initTruth(p, tr, T0, { params: off, day: { illness: 'none', startDehydrationPct: 3 } }), shadeWork, a, 120).s
    const perPct = (dry.gagge.tCoreC - base.gagge.tCoreC) / (dry.dehydrationPct - base.dehydrationPct)
    expect(perPct).toBeGreaterThan(0.08)
    expect(perPct).toBeLessThan(0.3)
    const drinking = runConst(initTruth(p, tr, T0, { params: off }), shadeWork, a, 120, 'run', 15).s
    expect(drinking.dehydrationPct).toBeLessThan(base.dehydrationPct - 1)
    expect(drinking.intakeMl).toBeCloseTo(1800, 6)
    const fever = runConst(initTruth(p, tr, T0, { params: off, day: { illness: 'febrile', startDehydrationPct: 0 } }), shadeWork, a, 120).s
    expect(fever.gagge.tCoreC - base.gagge.tCoreC).toBeGreaterThan(0.25)
    const pu = profile(NEW_ARRIVAL)
    const unacc = runConst(initTruth(pu, neutralTraits(pu), T0, { params: off }), CONST_HOT, act(ACGIH_METABOLIC_W.moderate), 60).s
    const acc = runConst(initTruth(p, tr, T0, { params: off }), CONST_HOT, act(ACGIH_METABOLIC_W.moderate), 60).s
    expect(unacc.unacclimatised).toBe(true)
    expect(acc.gagge.tCoreC).toBeLessThan(unacc.gagge.tCoreC - 0.2)
  })

  it('self-pacing slows work under strain, independent of any policy input', () => {
    const p = profile(NEW_ARRIVAL)
    const tr = { ...neutralTraits(p), selfPacingPropensity: 1 }
    const { s } = runConst(initTruth(p, tr, T0), CONST_HOT, act(ACGIH_METABOLIC_W.very_heavy), 120)
    expect(s.paceFactor).toBeLessThan(1)
    expect(s.effMetabolicW).toBeLessThan(ACGIH_METABOLIC_W.very_heavy)
    expect(s.events.some((e) => e.type === 'pace_change')).toBe(true)
  })

  it('stepTruth validates dtMin and does not mutate its input', () => {
    const p = profile()
    const s0 = initTruth(p, neutralTraits(p), T0)
    const snapshot = JSON.stringify(s0)
    expect(() => stepTruth(s0, { ...CONST_HOT, activity: act(300), drankMl: 0 }, 0, createRng(1))).toThrow(RangeError)
    expect(() => stepTruth(s0, { ...CONST_HOT, activity: act(300), drankMl: 0 }, 1.5, createRng(1))).toThrow(RangeError)
    stepTruth(s0, { ...CONST_HOT, activity: act(300), drankMl: 0 }, 5, createRng(1))
    expect(JSON.stringify(s0)).toBe(snapshot)
  })

  it('a 10-minute step equals ten 1-minute steps (same random stream)', () => {
    const p = profile(NEW_ARRIVAL)
    const s0 = initTruth(p, neutralTraits(p), T0)
    const big = stepTruth(s0, { ...CONST_HOT, activity: act(400), drankMl: 100 }, 10, createRng('chunk'))
    let small = s0
    const rng = createRng('chunk')
    for (let i = 0; i < 10; i++) small = stepTruth(small, { ...CONST_HOT, activity: act(400), drankMl: 10 }, 1, rng)
    expect({ ...big, lastEvents: [] }).toEqual({ ...small, lastEvents: [] })
    expect(TRUTH_UNIFORMS_PER_MINUTE).toBe(12)
  })
})

// ─────────────────────────────── Heart rate ───────────────────────────────

describe('trueHeartRate', () => {
  const p = profile()
  const tr = neutralTraits(p)
  const s0 = initTruth(p, tr, T0)

  it('VO₂ conversion: ISO 8996 energy equivalent (RQ 0.85 → 5.677 Wh/L)', () => {
    expect(vo2FromMetabolicW(340.62, 70)).toBeCloseTo(((340.62 / ((0.23 * 0.85 + 0.77) * 5.88)) * 1000) / 60 / 70, 10)
    expect(vo2FromMetabolicW(415, 70)).toBeGreaterThan(17)
    expect(vo2FromMetabolicW(415, 70)).toBeLessThan(18)
  })

  it('is monotone in metabolic rate and in core temperature', () => {
    let prev = -Infinity
    for (let m = 115; m <= 500; m += 25) {
      const hr = trueHeartRate(s0, tr, m)
      expect(hr).toBeGreaterThan(prev)
      prev = hr
    }
    prev = -Infinity
    for (let c = 36.6; c <= 39.6; c += 0.25) {
      const hr = trueHeartRate({ ...s0, gagge: { ...s0.gagge, tCoreC: c } }, tr, 300)
      expect(hr).toBeGreaterThan(prev)
      prev = hr
    }
  })

  it('rest ≈ resting HR; dehydration adds k_D per %; capped near HRmax', () => {
    expect(trueHeartRate(s0, tr, 115)).toBeGreaterThan(tr.hrRestBpm - 1)
    expect(trueHeartRate(s0, tr, 115)).toBeLessThan(tr.hrRestBpm + 12)
    const d = trueHeartRate({ ...s0, dehydrationPct: 2 }, tr, 300) - trueHeartRate(s0, tr, 300)
    expect(d).toBeCloseTo(2 * TRUTH_PARAMS.hr.kDBpmPerPct, 10)
    expect(trueHeartRate({ ...s0, gagge: { ...s0.gagge, tCoreC: 42 } }, tr, 600)).toBeLessThanOrEqual(tr.hrMaxBpm + 5)
    expect(trueMetabolicW(300, { metabolicMultiplier: 1.2 })).toBeCloseTo(360, 10)
  })
})

// ─────────────────────────────── Symptoms and events ───────────────────────────────

describe('symptoms and ground-truth events', () => {
  it('extreme exposure: excessive (38.0 °C unacclimatised, 10 min sustained), severe ≥ 39.5, critical ≥ 40 with CNS signs, dehydration > 3 %', () => {
    const params = withTruthParams({ selfPacing: { enabled: false } })
    const p = profile(NEW_ARRIVAL)
    const s0 = initTruth(p, neutralTraits(p, params), T0, { params })
    const extreme: Env = { taC: 46, rhPct: 35, wind2Ms: 1, ghiWm2: 950, fdir: 0.8, cosZenith: 0.98 }
    const { s, core } = runConst(s0, extreme, act(ACGIH_METABOLIC_W.very_heavy, 'sun', 'vapour_barrier'), 240)
    const firstAt = (thr: number) => core.findIndex((c) => c >= thr)
    const a = firstAt(38.0)
    expect(core.slice(a, a + 10).every((c) => c >= 38.0)).toBe(true)
    expect(s.outcomes.excessive_strain).toMatchObject({ onsetT: T0 + a * 60_000, t: T0 + (a + 10) * 60_000 })
    expect(s.outcomes.severe_strain?.t).toBe(T0 + (firstAt(39.5) + 1) * 60_000)
    expect(s.outcomes.critical!.t).toBeLessThanOrEqual(T0 + (firstAt(40) + 1) * 60_000)
    expect(s.outcomes.dehydration!.value).toBeGreaterThan(3)
    expect(s.events.some((e) => e.type === 'symptom_onset' && e.cluster === 'cns' && e.symptoms.includes('confusion'))).toBe(true)
    expect(s.maxCoreC).toBeGreaterThanOrEqual(40)
  })

  it('an acclimatised worker needs 38.5 °C for 10 min (not 38.0)', () => {
    const p = profile()
    const s0 = initTruth(p, neutralTraits(p), T0)
    expect(s0.unacclimatised).toBe(false)
    let s = { ...s0, gagge: { ...s0.gagge, tCoreC: 38.3 } }
    // Hold the core just above 38.0 by stepping a mild load from a warm start: no excessive event at < 38.5.
    s = runConst(s, { taC: 30, rhPct: 40, wind2Ms: 1, ghiWm2: 0, fdir: 0, cosZenith: -0.1 }, act(115, 'shade'), 30).s
    expect(s.outcomes.excessive_strain).toBeUndefined()
  })

  it('no heat-exhaustion hazard below the thresholds; thirst from 1 % dehydration', () => {
    const p = profile()
    const tr = { ...neutralTraits(p), symptomSusceptibility: 100 }
    const cool = runConst(initTruth(p, tr, T0), CONST_HOT, act(115, 'indoor_cool'), 240).s
    expect(cool.symptoms.some((x) => x.cluster === 'heat_exhaustion')).toBe(false)
    const thirsty = runConst(initTruth(p, tr, T0, { day: { illness: 'none', startDehydrationPct: 1.2 } }), CONST_HOT, act(115, 'indoor_cool'), 2).s
    expect(thirsty.symptoms.map((x) => x.id)).toContain('thirst')
  })

  it('heat-exhaustion cluster persists until cooled and rehydrated; check-in answers report it', () => {
    const params = withTruthParams({ symptoms: { hazardScale: 1e6 }, reporting: { pRespond: 100, pDisclose: 1 }, selfPacing: { enabled: false } })
    const p = profile(NEW_ARRIVAL)
    const tr = neutralTraits(p, params)
    let s = initTruth(p, tr, T0, { params })
    s = runConst(s, CONST_HOT, act(ACGIH_METABOLIC_W.heavy), 25).s
    const onset = s.events.find((e) => e.type === 'symptom_onset' && e.cluster === 'heat_exhaustion')
    expect(onset).toBeDefined()
    const heIds = s.symptoms.filter((x) => x.cluster === 'heat_exhaustion').map((x) => x.id)
    expect(heIds.length).toBeGreaterThanOrEqual(1)
    for (const id of heIds) expect(['headache', 'dizziness', 'nausea', 'weakness_fatigue']).toContain(id)
    const ans = respondToCheckin(s, tr, createRng('ci'))
    expect(ans).not.toBeNull()
    expect(ans!.symptoms).toEqual(expect.arrayContaining(heIds))
    expect(ans!.urineColor).toBeGreaterThanOrEqual(1)
    expect(ans!.urineColor).toBeLessThanOrEqual(8)
    // Still symptomatic while working hot; resolves after cooling + drinking for ≥ 15 min.
    s = runConst(s, CONST_HOT, act(ACGIH_METABOLIC_W.heavy), 5).s
    expect(s.episodes.heat_exhaustion).not.toBeNull()
    s = runConst(s, CONST_HOT, act(115, 'indoor_cool'), 120, 'cool', 20).s
    expect(s.episodes.heat_exhaustion).toBeNull()
    expect(s.events.some((e) => e.type === 'symptom_resolved' && e.cluster === 'heat_exhaustion')).toBe(true)
  })

  it('cramps follow sodium loss, become persistent after 60 min and resolve with rest', () => {
    const params = withTruthParams({ symptoms: { hazardScale: 1e7 }, selfPacing: { enabled: false } })
    const p = profile(NEW_ARRIVAL)
    let s = initTruth(p, { ...neutralTraits(p, params), sweatSodiumMmolL: 60 }, T0, { params })
    const shadeWork: Env = { taC: 36, rhPct: 30, wind2Ms: 2, ghiWm2: 700, fdir: 0.75, cosZenith: 0.9 }
    s = runConst(s, shadeWork, act(ACGIH_METABOLIC_W.moderate, 'shade'), 240, 'cr', 15).s
    expect(s.sodiumLossMmol).toBeGreaterThan(TRUTH_PARAMS.symptoms.cramps.minSodiumMmol)
    const onset = s.events.find((e) => e.type === 'symptom_onset' && e.cluster === 'cramps')
    expect(onset).toBeDefined()
    const ids = s.symptoms.map((x) => x.id)
    expect(ids).toContain('cramps')
    expect(ids).toContain('cramps_persistent')
    s = runConst(s, shadeWork, act(115, 'shade'), 25, 'rest', 10).s
    expect(s.episodes.cramps).toBeNull()
  })

  it('check-in: no answer with CNS signs', () => {
    const p = profile()
    const tr = neutralTraits(p)
    const s0 = initTruth(p, tr, T0)
    const cns: TruthState = { ...s0, episodes: { ...s0.episodes, cns: { onsetT: T0, recoveryRunMin: 0, noticed: false } }, symptoms: [{ id: 'confusion', cluster: 'cns', onsetT: T0 }] }
    expect(respondToCheckin(cns, tr, createRng(1))).toBeNull()
  })
})

// ─────────────────────────────── Behaviour ───────────────────────────────

describe('drinkDecision', () => {
  const p = profile()
  const tr = neutralTraits(p)
  const s0 = initTruth(p, tr, T0)
  const B = TRUTH_PARAMS.behaviour
  /** A state with a given recent sweat rate (mL/h) and dehydration (%). */
  const withSweat = (sweatRateMlPerH: number, dehydrationPct = 0, base: TruthState = s0): TruthState => ({ ...base, sweatRateMlPerH, dehydrationPct })
  const meanPerHour = (s: TruthState, ctx: Parameters<typeof drinkDecision>[2], minutes: number, seed: number): number => {
    const rng = createRng(seed)
    let ml = 0
    for (let i = 0; i < minutes; i++) ml += drinkDecision(s, tr, ctx, rng)
    return (ml / minutes) * 60
  }

  it('spontaneous rate: habitual floor when not sweating, sweat replacement in the heat, thirst and break gains (known answers)', () => {
    expect(B.habitualDrinkFraction).toBe(0.87)
    // A worker with the median baseline (450 mL/h) and replacement fraction 0.6: floor 0.87 × 450 = 391.5 mL/h.
    const hot = { ...tr, baselineDrinkMlPerH: 450, sweatReplacementFraction: 0.6 }
    const floor = 391.5
    expect(spontaneousDrinkRateMlPerH(withSweat(0), hot)).toBeCloseTo(floor, 9)
    expect(spontaneousDrinkRateMlPerH(withSweat(0), hot, true)).toBeCloseTo(2 * floor, 9)
    expect(spontaneousDrinkRateMlPerH(withSweat(1000), hot)).toBeCloseTo(600, 9)
    // Thirst: 3 % dehydration is 2 % above the 1 % threshold → × (1 + 0.5 × 2) = × 2.
    expect(spontaneousDrinkRateMlPerH(withSweat(1000, 3), hot)).toBeCloseTo(1200, 9)
    // Below the floor the sweat term does not matter (0.6 × 600 = 360 < 391.5).
    expect(spontaneousDrinkRateMlPerH(withSweat(600), hot)).toBeCloseTo(floor, 9)
    expect(spontaneousDrinkRateMlPerH(withSweat(10), hot)).toBeCloseTo(floor, 9)
    expect(DRINK_MODEL_BASIS).toMatch(/50–80 %/)
    expect(DRINK_MODEL_BASIS).toMatch(/TB MED 507/)
  })

  it('a followed reminder replaces the spontaneous drink of that minute instead of adding to it', () => {
    const always = initTruth(p, tr, T0, { params: withTruthParams({ behaviour: { reminderCompliance: 100 } }) })
    // A sweat rate so high that a spontaneous drink is certain every minute (rate/60/250 ≥ 1).
    const thirsty = withSweat(1e6, 0, always)
    expect(drinkDecision(thirsty, tr, { reminder: false, canDrink: true }, createRng(3))).toBe(B.cupMl)
    expect(drinkDecision(thirsty, tr, { reminder: true, canDrink: true }, createRng(3))).toBe(B.reminderMl)
    expect(drinkDecision(thirsty, tr, { reminder: true, canDrink: true, reminderMl: 300 }, createRng(3))).toBe(300)
    expect(drinkDecision(thirsty, tr, { reminder: true, canDrink: false }, createRng(3))).toBe(0)
    // Never followed: the reminder minute is an ordinary spontaneous minute.
    const never = initTruth(p, tr, T0, { params: withTruthParams({ behaviour: { reminderCompliance: 0 } }) })
    expect(drinkDecision(withSweat(1e6, 0, never), tr, { reminder: true, canDrink: true }, createRng(3))).toBe(B.cupMl)
  })

  it('a reminder still on screen is not followed again within 20 min of the last followed one (known answers)', () => {
    expect(B.reminderRefollowMin).toBe(20)
    const always = initTruth(p, tr, T0, { params: withTruthParams({ behaviour: { reminderCompliance: 100 } }) })
    const thirsty = withSweat(1e6, 0, always)
    const at = (minutesSinceFollowedReminder?: number) =>
      drinkDecisionDetail(thirsty, tr, { reminder: true, canDrink: true, reminderMl: 300, ...(minutesSinceFollowedReminder === undefined ? {} : { minutesSinceFollowedReminder }) }, createRng(3))
    expect(at()).toEqual({ ml: 300, followedReminder: true })
    expect(at(Number.POSITIVE_INFINITY)).toEqual({ ml: 300, followedReminder: true })
    expect(at(20)).toEqual({ ml: 300, followedReminder: true })
    // Within the interval the minute is an ordinary spontaneous minute (here a certain 250-mL drink).
    expect(at(19.99)).toEqual({ ml: B.cupMl, followedReminder: false })
    expect(at(0)).toEqual({ ml: B.cupMl, followedReminder: false })
    // A spontaneous drink is never a followed reminder; no drink when drinking is not possible.
    expect(drinkDecisionDetail(thirsty, tr, { reminder: false, canDrink: true }, createRng(3))).toEqual({ ml: B.cupMl, followedReminder: false })
    expect(drinkDecisionDetail(thirsty, tr, { reminder: true, canDrink: false }, createRng(3))).toEqual({ ml: 0, followedReminder: false })
  })

  it('drinkDecision is drinkDecisionDetail’s volume (same draws, same result)', () => {
    const ctxs = [{ reminder: true, canDrink: true }, { reminder: false, canDrink: true, onBreak: true }, { reminder: true, canDrink: true, minutesSinceFollowedReminder: 5 }]
    for (const ctx of ctxs) {
      const a = createRng(21)
      const b = createRng(21)
      for (let i = 0; i < 500; i++) expect(drinkDecision(withSweat(800, 1.5), tr, ctx, a)).toBe(drinkDecisionDetail(withSweat(800, 1.5), tr, ctx, b).ml)
    }
  })

  it('always draws exactly two uniforms (common random numbers across policies)', () => {
    for (const ctx of [{ reminder: true, canDrink: true }, { reminder: false, canDrink: true }, { reminder: true, canDrink: false }, { reminder: true, canDrink: true, minutesSinceFollowedReminder: 3 }]) {
      const a = createRng(11)
      drinkDecision(s0, tr, ctx, a)
      const b = createRng(11)
      b.next()
      b.next()
      expect(a.next()).toBe(b.next())
    }
  })

  it('the habitual floor is the calibrated value, with its target, statistic, set, method and achieved value', () => {
    expect(DRINK_CALIBRATION.parameter).toBe('behaviour.habitualDrinkFraction')
    expect(B.habitualDrinkFraction).toBe(DRINK_CALIBRATION.value)
    expect(DRINK_CALIBRATION.target.litresPer12hShift).toBe(5.44)
    expect(DRINK_CALIBRATION.target.basis).toMatch(/Bates & Schneider 2008/)
    expect(Math.abs(DRINK_CALIBRATION.achieved.litresPer12hShift - DRINK_CALIBRATION.target.litresPer12hShift)).toBeLessThan(0.05)
    for (const k of ['statistic', 'calibrationSet', 'method', 'whyTheFloor', 'caveat'] as const) expect(DRINK_CALIBRATION[k].length).toBeGreaterThan(40)
    expect(DRINK_CALIBRATION.calibrationSet).toMatch(/hot-tercile/)
    expect(DRINK_MODEL_BASIS).toMatch(/5\.44 L/)
    expect(DRINK_MODEL_BASIS).toMatch(/CALIBRATED/)
    expect(Object.isFrozen(DRINK_CALIBRATION.achieved)).toBe(true)
  })

  it('cooled rest drinks at the habitual floor; hot work at the replacement fraction of sweat loss (statistical)', () => {
    const floor = B.habitualDrinkFraction * tr.baselineDrinkMlPerH
    const rest = meanPerHour(withSweat(0), { reminder: false, canDrink: true }, 20_000, 4)
    expect(rest).toBeGreaterThan(floor * 0.85)
    expect(rest).toBeLessThan(floor * 1.15)
    const hot = meanPerHour(withSweat(1000), { reminder: false, canDrink: true }, 20_000, 5)
    const expected = Math.max(floor, tr.sweatReplacementFraction * 1000)
    expect(hot).toBeGreaterThan(expected * 0.9)
    expect(hot).toBeLessThan(expected * 1.1)
    expect(meanPerHour(withSweat(1000), { reminder: false, canDrink: false }, 600, 6)).toBe(0)
  })
})

// ─────────────────────────────── Wearable ───────────────────────────────

describe('wearableSamples → engine/physio.ts minuteSqi', () => {
  const p = profile()
  const tr = { ...sampleHiddenTraits(p, createRng(11)), ppgBiasBpm: 1.5, ppgNoiseSdBpm: 3, ppgDropoutFactor: 1 }

  function validity(minutes: number, ctx: { armWork: boolean; dust: boolean }, params?: TruthParams['wearable'], hr = 110): { valid: number; meanErr: number } {
    const rng = createRng('ppg')
    const chain = createWearableChain()
    let valid = 0
    let err = 0
    for (let m = 0; m < minutes; m++) {
      const samples = wearableSamples(hr, tr, { minuteIndex: m, armWork: ctx.armWork, dust: ctx.dust, chain, params }, rng)
      const q = minuteSqi(samples, 1)
      if (q.minuteValid) {
        valid++
        err += Math.abs(q.hrMeanBpm! - hr)
      }
    }
    return { valid: valid / minutes, meanErr: valid ? err / valid : NaN }
  }

  it('emits 60 per-second samples with tSec 0–59 and integer readings', () => {
    const s = wearableSamples(100, tr, { minuteIndex: 0, armWork: true, dust: true }, createRng(1))
    expect(s).toHaveLength(60)
    s.forEach((x, i) => {
      expect(x.tSec).toBe(i)
      if (x.bpm !== null) expect(Number.isInteger(x.bpm)).toBe(true)
    })
  })

  it('clean streams give mostly SQI-valid minutes with small error', () => {
    const r = validity(600, { armWork: false, dust: false })
    console.info(`[wearable] clean: ${(r.valid * 100).toFixed(1)} % valid minutes, mean |HR error| ${r.meanErr.toFixed(2)} bpm`)
    expect(r.valid).toBeGreaterThan(0.9)
    expect(r.meanErr).toBeLessThan(4)
  })

  it('arm work and dust degrade validity; heavy dropout settings give mostly invalid minutes; minute loss gives none', () => {
    const clean = validity(600, { armWork: false, dust: false }).valid
    const work = validity(600, { armWork: true, dust: true })
    console.info(`[wearable] arm work + dust: ${(work.valid * 100).toFixed(1)} % valid, mean |HR error| ${work.meanErr.toFixed(2)} bpm`)
    expect(work.valid).toBeLessThan(clean)
    const bad = validity(300, { armWork: true, dust: true }, withTruthParams({ wearable: { dropoutMultiplier: 30 } }).wearable).valid
    expect(bad).toBeLessThan(0.3)
    const lost = validity(100, { armWork: false, dust: false }, withTruthParams({ wearable: { minuteLossProb: 1 } }).wearable).valid
    expect(lost).toBe(0)
  })

  it('cadence-lock artefacts appear during arm work (some escape the SQI, as intended)', () => {
    const rng = createRng('cad')
    const chain = createWearableChain()
    const params = withTruthParams({ wearable: { cadenceLockPerS: 0.02, dropoutOnPerS: 0, offSkinPerMin: 0 } }).wearable
    let doubled = 0
    for (let m = 0; m < 60; m++) {
      for (const x of wearableSamples(90, { ...tr, ppgNoiseSdBpm: 0.5 }, { minuteIndex: m, armWork: true, dust: false, chain, params }, rng)) if (x.bpm !== null && (x.bpm > 160 || x.bpm < 55)) doubled++
    }
    expect(doubled).toBeGreaterThan(20)
  })

  it('off-skin periods carry across minutes through the chain and set contactOk = false', () => {
    const chain = createWearableChain()
    const params = withTruthParams({ wearable: { offSkinPerMin: 60, offSkinMinS: 150, offSkinMaxS: 150 } }).wearable
    const rng = createRng('off')
    const m0 = wearableSamples(100, tr, { minuteIndex: 0, armWork: false, dust: false, chain, params }, rng)
    const m1 = wearableSamples(100, tr, { minuteIndex: 1, armWork: false, dust: false, chain, params }, rng)
    expect(m0.some((x) => !x.contactOk)).toBe(true)
    expect(m1.slice(0, 30).every((x) => !x.contactOk)).toBe(true)
    expect(minuteSqi(m1, 1).flags).toContain('contact_lost')
  })
})

// ─────────────────────────────── Determinism and performance ───────────────────────────────

function simulateWorker(seed: string, minutes: number): { s: TruthState; trace: Array<[number, number, number | null]> } {
  const root = createRng(seed)
  const p = profile({ id: `W-${seed}` })
  const traits = sampleHiddenTraits(p, root.fork('traits'))
  const day = sampleDailyCondition(traits, root.fork('day'))
  let s = initTruth(p, traits, epochFromLocal('2025-08-01T06:00'), { day })
  const env = musaffahMinutes('2025-08-01T06:00', '2025-08-01T19:00').slice(0, minutes)
  const rTruth = root.fork('truth')
  const rDrink = root.fork('drink')
  const rWear = root.fork('wear')
  const chain = createWearableChain()
  const trace: Array<[number, number, number | null]> = []
  let drank = 0
  env.forEach((e, i) => {
    const working = i % 60 < 45
    s = stepTruth(s, { ...e, activity: { metabolicW: trueMetabolicW(working ? ACGIH_METABOLIC_W.moderate : ACGIH_METABOLIC_W.rest, traits), location: working ? 'sun' : 'shade', clothing: p.clothing, hood: false }, drankMl: drank }, 1, rTruth)
    drank = drinkDecision(s, traits, { reminder: i % 20 === 0, canDrink: true, onBreak: !working }, rDrink)
    const hr = trueHeartRate(s, traits)
    const q = minuteSqi(wearableSamples(hr, traits, { minuteIndex: i, armWork: working, dust: false, chain }, rWear), 1)
    trace.push([s.gagge.tCoreC, hr, q.hrMeanBpm])
  })
  return { s, trace }
}

describe('determinism and performance', () => {
  it('a seed reproduces the whole trajectory; another seed differs', () => {
    const a = simulateWorker('seed-A', 240)
    const b = simulateWorker('seed-A', 240)
    expect(b.trace).toEqual(a.trace)
    expect(b.s).toEqual(a.s)
    expect(simulateWorker('seed-B', 240).trace).not.toEqual(a.trace)
  })

  it('mean truth step + HR + wearable samples per worker-minute (target < 0.05 ms)', () => {
    const env = musaffahMinutes('2025-08-01T05:00', '2025-08-01T19:00')
    const workers = Array.from({ length: 30 }, (_, i) => {
      const p = profile({ id: `W-P${i}`, ageYears: 22 + i, daysOnSite: 1 + i * 7 })
      const traits = sampleHiddenTraits(p, createRng(`perf-${i}`))
      return { traits, s: initTruth(p, traits, epochFromLocal('2025-08-01T05:00')), rng: createRng(`perf-run-${i}`), chain: createWearableChain() }
    })
    const run = () => {
      for (let i = 0; i < env.length; i++) {
        const working = i % 60 < 45
        for (const w of workers) {
          w.s = stepTruth(w.s, { ...env[i], activity: { metabolicW: trueMetabolicW(working ? 300 : 115, w.traits), location: working ? 'sun' : 'shade', clothing: 'cloth_coveralls', hood: false }, drankMl: 4 }, 1, w.rng)
          wearableSamples(trueHeartRate(w.s, w.traits), w.traits, { minuteIndex: i, armWork: working, dust: false, chain: w.chain }, w.rng)
        }
      }
    }
    const t0 = performance.now()
    run()
    const ms = performance.now() - t0
    const perWorkerMinute = ms / (env.length * workers.length)
    console.info(`[truth perf] ${workers.length} workers × ${env.length} min: ${ms.toFixed(0)} ms total, ${(perWorkerMinute * 1000).toFixed(1)} µs per worker-minute`)
    expect(perWorkerMinute).toBeLessThan(0.1)
    for (const w of workers) expect(Number.isFinite(w.s.gagge.tCoreC)).toBe(true)
  })
})
