import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  ACTION_PRIORITY,
  COOLED_REST,
  DRIVER_IDS,
  RISK_DRIVER_IDS,
  RISK_THRESHOLDS,
  ENGINE_PHS_OPTIONS,
  assessSnapshot,
  buildPhsInput,
  cooledCabinTwlWm2,
  createWorkerEngine,
  creditedIntakeL,
  environmentLevel,
  orderActions,
  projectionLevel,
  sortDrivers,
  stepWorkerEngine,
} from './risk'
import type { WorkerContext, WorkerEngineOptions, WorkerEngineState, WorkerInputs, WorkerLocation, WorkerStepDetail, WorkerStepResult } from './risk'
import { computeSiteHeat } from './indices'
import type { SiteHeat } from './indices'
import { CLOTHING, allowedWorkFraction, clothingAdjustmentC, duBoisAreaM2, taskMetabolicW, wbgtEffectiveC } from './limits'
import { minutesToLimit, phsInitialState } from './phs'
import { FLUID } from './clinical'
import { CLINICAL_TEXT_PATTERN } from './alerts'
import { SHARJAH_RULE_PACK, QATAR_RULE_PACK, stricterWorkRest, twlWorkCategory, twlZone } from './regulation'
import { computeTwl } from './twl'
import { wbgtComponents } from './wbgt'
import { RISK_ORDER, maxLevel } from './types'
import type { Checkin, ClothingId, EnvSample, FluidIntake, RiskAssessment, RiskDriver, RiskFlagId, RiskLevel, SymptomId, Task, WorkClass, WorkerProfile } from './types'
import { epochFromLocal } from './time'
import { getSite } from '../data/sites'
import { parseArchiveFile, parseDemoDays, resolveEnvironment } from '../data/weather'
import type { DemoDay, ResolvedEnvironment } from '../data/weather'
import { buildDemoCrew } from '../data/workforce'

// ─────────────────────────────── Shared fixtures ───────────────────────────────

const DEMO = parseDemoDays(JSON.parse(readFileSync(new URL('../../public/data/weather/demo-days.json', import.meta.url), 'utf8')))
const SITE = getSite('musaffah')
const AUG1 = DEMO.find((d) => d.id === 'musaffah_2025-08-01') as DemoDay
const NOV26 = DEMO.find((d) => d.id === 'musaffah_2025-11-26') as DemoDay
const { crew, workers } = buildDemoCrew()
const W = (id: string): WorkerProfile => workers.find((w) => w.id === id) as WorkerProfile
const TASK = (key: string): Task => crew.tasks.find((t) => t.id === `${crew.id}:${key}`) as Task
const NEW_ARRIVAL = W('W-D2A1')
const VETERAN = W('W-D2B2')
const BETA_BLOCKER = W('W-D2C3')
const FASTING = W('W-D2D4')
const NO_CONSENT = W('W-D2E5')
const CREWMATE = W('W-D2F6')
const WELDING = TASK('welding')
const WELDING_NO_HOOD: Task = { ...WELDING, hood: false }
const INSPECTION = TASK('inspection_rounds')
const MAINTENANCE = TASK('maintenance')
const MIN = 60_000
const CLEAN_HR = { hrMeanBpm: 90, minuteValid: true, rScale: 1 }

const heatCache = new Map<string, { env: ResolvedEnvironment; heat: SiteHeat }>()
function siteAt(day: DemoDay, now: number): { env: ResolvedEnvironment; heat: SiteHeat } {
  const key = `${day.id}@${now}`
  let v = heatCache.get(key)
  if (!v) {
    const env = resolveEnvironment({ siteId: 'musaffah', now, archive: day.analysis })
    v = { env, heat: computeSiteHeat(env.sample, SITE) }
    heatCache.set(key, v)
  }
  return v
}
const local = (day: DemoDay, hhmm: string): number => epochFromLocal(`${day.date}T${hhmm}`)

/** Real Musaffah context; the site's rest area (an air-conditioned cabin, data/sites.ts) unless `extra` overrides it. */
function ctxAt(day: DemoDay, now: number, profile: WorkerProfile, task: Task | null, location: WorkerLocation, extra: Partial<WorkerContext> = {}): WorkerContext {
  const { env, heat } = siteAt(day, now)
  return { now, profile, task, location, heat, env, network: 'online', fastingNow: profile.riskFlags.includes('fasting'), restArea: SITE.restArea, ...extra }
}

interface Step {
  now: number
  a: RiskAssessment
  d: WorkerStepDetail
}
interface RunOptions {
  from?: string
  to?: string
  plan?: (now: number) => { task: Task | null; location: WorkerLocation }
  inputs?: (now: number) => WorkerInputs
  extra?: Partial<WorkerContext>
  opts?: WorkerEngineOptions
  state?: WorkerEngineState
}
function runDay(day: DemoDay, profile: WorkerProfile, task: Task | null, r: RunOptions = {}): { steps: Step[]; state: WorkerEngineState } {
  const start = local(day, r.from ?? '06:00')
  const end = local(day, r.to ?? '18:00')
  let state = r.state ?? createWorkerEngine(profile, start)
  const steps: Step[] = []
  for (let now = start; now <= end; now += MIN) {
    const p = r.plan ? r.plan(now) : { task, location: (task === null ? 'shade' : task.inSun ? 'sun' : 'shade') as WorkerLocation }
    const res = stepWorkerEngine(state, ctxAt(day, now, profile, p.task, p.location, r.extra), r.inputs ? r.inputs(now) : {}, r.opts)
    state = res.state
    steps.push({ now, a: res.assessment, d: res.detail })
  }
  return { steps, state }
}
const firstAtLeast = (steps: Step[], level: RiskLevel): number | null => steps.find((s) => RISK_ORDER[s.a.level] >= RISK_ORDER[level])?.now ?? null
const ch = (a: RiskAssessment, id: string) => a.channels.find((c) => c.channel === id)!
const ids = (a: RiskAssessment): string[] => a.drivers.map((d) => d.id)

/** A synthetic site-heat sample (no radiant boost) for unit tests. */
function heatFrom(over: Partial<EnvSample> = {}): SiteHeat {
  return computeSiteHeat(
    { t: epochFromLocal('2025-11-26T10:00'), taC: 26, rhPct: 40, pHpa: 1015, wind10Ms: 2, ghiWm2: 650, radiationWindowMin: 0, radiantBoostC: 0, source: 'archive', ...over },
    { ...SITE, radiantBoostC: 0 },
  )
}
function ctx(profile: WorkerProfile, now: number, task: Task | null, location: WorkerLocation, heat: SiteHeat, extra: Partial<WorkerContext> = {}): WorkerContext {
  return { now, profile, task, location, heat, network: 'online', ...extra }
}
const checkin = (profile: WorkerProfile, t: number, symptoms: Checkin['symptoms'], by: Checkin['by'] = 'self', extra: Partial<Checkin> = {}): Checkin => ({
  t,
  workerId: profile.id,
  by,
  symptoms,
  ...extra,
})

// ─────────────────────────────── Level mappings ───────────────────────────────

describe('level mappings (ARCHITECTURE.md §5)', () => {
  it('environment: f and margin → level, boundaries protective', () => {
    expect(environmentLevel(1, 1)).toBe('safe')
    expect(environmentLevel(1, 3)).toBe('safe')
    expect(environmentLevel(1, 0.999)).toBe('caution')
    expect(environmentLevel(1, 0)).toBe('caution')
    expect(environmentLevel(0.75, -1)).toBe('caution')
    expect(environmentLevel(0.7499, -1)).toBe('high')
    expect(environmentLevel(0.25, -1)).toBe('high')
    expect(environmentLevel(0.2499, -1)).toBe('stop')
    expect(environmentLevel(0, -5)).toBe('stop')
    expect(environmentLevel(Number.NaN, 0)).toBe('stop')
  })

  it('projection: minutes → level; > 90 safe, 45–90 caution, 15–45 high, < 15 stop; ties to the protective side', () => {
    expect(projectionLevel(null)).toBe('safe')
    expect(projectionLevel(120)).toBe('safe')
    expect(projectionLevel(90.01)).toBe('safe')
    expect(projectionLevel(90)).toBe('caution')
    expect(projectionLevel(45.01)).toBe('caution')
    expect(projectionLevel(45)).toBe('high')
    expect(projectionLevel(15)).toBe('high')
    expect(projectionLevel(14.99)).toBe('stop')
    expect(projectionLevel(0)).toBe('stop')
  })

  it('thresholds carry their basis', () => {
    for (const group of Object.values(RISK_THRESHOLDS)) expect(String((group as { basis: string }).basis).length).toBeGreaterThan(10)
    expect(RISK_THRESHOLDS.projection.horizonMin).toBe(120)
    expect(RISK_THRESHOLDS.dwell.dwellMin).toBe(10)
  })
})

// ─────────────────────────────── Environment channel ───────────────────────────────

describe('environment channel', () => {
  const now = epochFromLocal('2025-11-26T11:00')
  const heat = heatFrom({ t: now, taC: 30, rhPct: 45 })

  it('WBGT_eff = wbgtEffectiveC(sun WBGT, task clothing, hood) + data margin; rest from shade WBGT without hood', () => {
    const r = stepWorkerEngine(createWorkerEngine(VETERAN, now), ctx(VETERAN, now, WELDING, 'sun', heat, { env: { source: 'cached_forecast', ageMin: 1600, stale: true, confidence: 'low', wbgtMarginC: 1, drivers: [] } }))
    expect(r.detail.wbgtWorkEffC).toBeCloseTo(wbgtEffectiveC(heat.wbgtC, 'fr_coveralls', true) + 1, 12)
    expect(r.detail.wbgtRestEffC).toBeCloseTo(wbgtEffectiveC(heat.wbgtShadeC, 'fr_coveralls', false) + 1, 12)
    const expected = allowedWorkFraction({ workW: taskMetabolicW(WELDING, VETERAN.massKg), wbgtWorkEffC: r.detail.wbgtWorkEffC, wbgtRestEffC: r.detail.wbgtRestEffC, limit: 'REL' })
    expect(r.detail.allowedWork.f).toBeCloseTo(expected.f, 12)
    expect(ch(r.assessment, 'environment').level).toBe(environmentLevel(expected.f, expected.marginC))
    expect(ids(r.assessment)).toContain('clothing_adjustment')
  })

  it('shade uses the shade WBGT; a cooled indoor space the cabin WBGT (never above the shade); the hood adds 1 °C', () => {
    const shade = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, WELDING_NO_HOOD, 'shade', heat))
    expect(shade.detail.wbgtWorkEffC).toBeCloseTo(heat.wbgtShadeC, 12)
    const indoor = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, WELDING_NO_HOOD, 'indoor_cool', heat))
    expect(indoor.detail.wbgtWorkEffC).toBeCloseTo(Math.min(COOLED_REST.wbgtC, heat.wbgtShadeC), 12)
    const hotHeat = heatFrom({ t: now, taC: 42, rhPct: 40 })
    expect(hotHeat.wbgtShadeC).toBeGreaterThan(COOLED_REST.wbgtC)
    const hotIndoor = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, WELDING_NO_HOOD, 'indoor_cool', hotHeat))
    expect(hotIndoor.detail.wbgtWorkEffC).toBeCloseTo(COOLED_REST.wbgtC, 12)
    const hooded = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, WELDING, 'shade', heat))
    expect(hooded.detail.wbgtWorkEffC - shade.detail.wbgtWorkEffC).toBeCloseTo(1, 12)
  })

  it('REL for the acclimatised veteran, RAL for the new arrival and in conservative mode', () => {
    const vet = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, INSPECTION, 'sun', heat))
    expect(vet.detail.allowedWork.limit).toBe('REL')
    const arr = stepWorkerEngine(createWorkerEngine(NEW_ARRIVAL, now), ctx(NEW_ARRIVAL, now, INSPECTION, 'sun', heat))
    expect(arr.detail.allowedWork.limit).toBe('RAL')
    expect(ids(arr.assessment)).toContain('limit_ral_unacclimatized')
    const fast = stepWorkerEngine(createWorkerEngine(FASTING, now), ctx(FASTING, now, INSPECTION, 'sun', heat))
    expect(fast.detail.allowedWork.limit).toBe('RAL')
    // Privacy-neutral id and text: the reason (here a declared flag) never appears outside the clinical channels.
    const d = fast.assessment.drivers.find((x) => x.id === 'limit_stricter_personal')!
    expect(d.channel).toBe('environment')
    expect(d.text).toBe('The stricter personal exposure limit applies')
    expect(d.text).not.toMatch(/\b(REL|RAL)\b|conservative|extra[-\s]?care|fasting|flag/i)
    expect(d.basis).not.toMatch(/conservative|extra[-\s]?care|fasting|flag/i)
    // The margin drivers cite both limits, so the basis does not reveal which one applies.
    const margin = fast.assessment.drivers.find((x) => x.id.startsWith('wbgt_') && x.id.endsWith('_limit'))!
    expect(margin.text).toMatch(/personal exposure limit/)
    expect(margin.text).not.toMatch(/\b(REL|RAL)\b/)
    expect(margin.basis).toMatch(/REL/)
    expect(margin.basis).toMatch(/RAL/)
  })

  it('acclimatisation budget: day 2 = 40 % × 480 = 192 min of hot work, then stop with acclimatization_plan + rotate_task', () => {
    const mild = heatFrom({ taC: 20, rhPct: 40, ghiWm2: 0, t: epochFromLocal('2025-11-26T19:00') })
    const start = epochFromLocal('2025-11-26T06:00')
    let state = createWorkerEngine(NEW_ARRIVAL, start)
    let last: { a: RiskAssessment; d: WorkerStepDetail } | null = null
    let stoppedAt: number | null = null
    for (let m = 0; m <= 200; m++) {
      const r = stepWorkerEngine(state, ctx(NEW_ARRIVAL, start + m * MIN, INSPECTION, 'shade', mild))
      state = r.state
      last = { a: r.assessment, d: r.detail }
      if (stoppedAt === null && ch(r.assessment, 'environment').level === 'stop') stoppedAt = m
    }
    expect(last!.d.hotWorkBudgetMin).toBeCloseTo(192, 9)
    expect(stoppedAt).toBe(192)
    expect(last!.a.actions).toEqual(expect.arrayContaining(['acclimatization_plan', 'rotate_task']))
    expect(ids(last!.a)).toContain('acclimatization_budget_exhausted')
    // Resting is not hot work; a cooled room does not count either.
    const rest = stepWorkerEngine(state, ctx(NEW_ARRIVAL, start + 201 * MIN, null, 'shade', mild))
    expect(ch(rest.assessment, 'environment').level).not.toBe('stop')
    const indoor = stepWorkerEngine(rest.state, ctx(NEW_ARRIVAL, start + 202 * MIN, INSPECTION, 'indoor_cool', mild))
    expect(indoor.detail.hotWorkMinToday).toBe(rest.detail.hotWorkMinToday)
  })
})

// ─────────────────────────────── Regulation channel ───────────────────────────────

describe('regulation channel', () => {
  it('midday break: outdoor-in-sun task → stop with midday_break; the same task in shade is not banned', () => {
    const now = local(AUG1, '13:00')
    const sun = assessSnapshot(ctxAt(AUG1, now, CREWMATE, INSPECTION, 'sun'))
    expect(ch(sun, 'regulation').level).toBe('stop')
    expect(sun.actions).toContain('midday_break')
    const shade = assessSnapshot(ctxAt(AUG1, now, CREWMATE, INSPECTION, 'shade'))
    expect(shade.actions).not.toContain('midday_break')
    expect(ids(shade)).toContain('midday_break_window')
    const resting = assessSnapshot(ctxAt(AUG1, now, CREWMATE, null, 'sun'))
    expect(resting.actions).not.toContain('midday_break')
  })

  it('uses the sun TWL in sun and the shade TWL in shade', () => {
    const now = local(AUG1, '11:00')
    const { heat } = siteAt(AUG1, now)
    const sun = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctxAt(AUG1, now, CREWMATE, INSPECTION, 'sun'))
    const shade = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctxAt(AUG1, now, CREWMATE, INSPECTION, 'shade'))
    expect(heat.twlWm2).toBeLessThan(115)
    expect(sun.detail.regulation.zone?.id).toBe('high')
    expect(heat.twlShadeWm2).toBeGreaterThan(140)
    expect(shade.detail.regulation.zone?.id).toBe('low')
  })

  it('ADOSH: an unacclimatised worker in a Medium/High zone is stopped and reassigned', () => {
    const now = local(AUG1, '07:00')
    const r = assessSnapshot(ctxAt(AUG1, now, NEW_ARRIVAL, INSPECTION, 'sun'))
    expect(ch(r, 'regulation').level).toBe('stop')
    expect(ids(r)).toContain('unacclimatized_excluded')
    expect(r.actions).toEqual(expect.arrayContaining(['acclimatization_plan', 'rotate_task']))
  })
})

// ─────────────────────────────── Projection channel ───────────────────────────────

describe('projection channel (ISO 7933:2023 PHS)', () => {
  const now = epochFromLocal('2025-11-26T11:00')
  const heat = heatFrom({ t: now, taC: 30, rhPct: 45, ghiWm2: 800 })

  it('equals phs.minutesToLimit from a fresh state with the documented inputs', () => {
    const a = assessSnapshot(ctx(CREWMATE, now, MAINTENANCE, 'sun', heat))
    const mass = CREWMATE.massKg as number
    const height = CREWMATE.heightCm as number
    const input = {
      tdbC: heat.taC,
      trC: heat.mrtC,
      vMs: Math.min(heat.wind2Ms, 3),
      rhPct: heat.rhPct,
      metabolicWm2: taskMetabolicW(MAINTENANCE, mass) / duBoisAreaM2(mass, height),
      wmeWm2: 0,
      clo: CLOTHING.cloth_coveralls.phs.clo,
      iMst: CLOTHING.cloth_coveralls.phs.imst,
      posture: 'standing' as const,
      acclimatized: true,
      drink: 1 as const,
      massKg: mass,
      heightM: height / 100,
      aP: 0,
    }
    const p = minutesToLimit(phsInitialState(input), input, 120, { model: '7933-2023', hcMode: 'tclIteration' })
    expect(a.minutesToLimit).toBe(p.minutes)
    expect(ch(a, 'projection').level).toBe(projectionLevel(p.minutes))
  })

  it('climate follows the location: sun → human MRT in sun, shade → shade MRT, cooled room → the COOLED_REST cabin', () => {
    const mass = CREWMATE.massKg as number
    const height = CREWMATE.heightCm as number
    const minutesFor = (trC: number, air: { tdbC: number; rhPct: number; vMs: number } = { tdbC: heat.taC, rhPct: heat.rhPct, vMs: Math.min(heat.wind2Ms, 3) }) => {
      const input = {
        tdbC: air.tdbC,
        trC,
        vMs: air.vMs,
        rhPct: air.rhPct,
        metabolicWm2: taskMetabolicW(TASK('welding'), mass) / duBoisAreaM2(mass, height),
        wmeWm2: 0,
        clo: CLOTHING.cloth_coveralls.phs.clo,
        iMst: CLOTHING.cloth_coveralls.phs.imst,
        posture: 'standing' as const,
        acclimatized: true,
        drink: 1 as const,
        massKg: mass,
        heightM: height / 100,
        aP: 0,
      }
      return minutesToLimit(phsInitialState(input), input, 120, { model: '7933-2023', hcMode: 'tclIteration' }).minutes
    }
    const heavyCloth: Task = { ...WELDING, clothing: undefined, hood: false }
    const got = (loc: WorkerLocation) => assessSnapshot(ctx(CREWMATE, now, heavyCloth, loc, heat)).minutesToLimit
    expect(got('sun')).toBe(minutesFor(heat.mrtC))
    expect(got('shade')).toBe(minutesFor(heat.mrtHumanShadeC))
    expect(got('indoor_cool')).toBe(minutesFor(COOLED_REST.trC, { tdbC: COOLED_REST.taC, rhPct: COOLED_REST.rhPct, vMs: COOLED_REST.vMs }))
    expect(got('sun') ?? Infinity).toBeLessThanOrEqual(got('shade') ?? Infinity)
    expect(got('shade') ?? Infinity).toBeLessThanOrEqual(got('indoor_cool') ?? Infinity)
  })

  it('projects every 5 min (countdown in between) and immediately on a task change', () => {
    const start = local(AUG1, '06:00')
    let state = createWorkerEngine(CREWMATE, start)
    const recT: number[] = []
    for (let m = 0; m <= 11; m++) {
      const r = stepWorkerEngine(state, ctxAt(AUG1, start + m * MIN, CREWMATE, INSPECTION, 'sun'))
      state = r.state
      recT.push((r.state.projection!.t - start) / MIN)
    }
    expect(recT).toEqual([0, 0, 0, 0, 0, 5, 5, 5, 5, 5, 10, 10])
    const changed = stepWorkerEngine(state, ctxAt(AUG1, start + 12 * MIN, CREWMATE, MAINTENANCE, 'sun'))
    expect(changed.state.projection!.t).toBe(start + 12 * MIN)
    const every1 = stepWorkerEngine(state, ctxAt(AUG1, start + 12 * MIN, CREWMATE, INSPECTION, 'sun'), {}, { projectionEveryMin: 1 })
    expect(every1.state.projection!.t).toBe(start + 12 * MIN)
  })

  it('vapour-barrier clothing: PHS not applicable → channel unavailable + monitoring driver, low confidence', () => {
    const task: Task = { ...MAINTENANCE, clothing: 'vapour_barrier' }
    const a = assessSnapshot(ctx(CREWMATE, now, task, 'sun', heat))
    const p = ch(a, 'projection')
    expect(p.available).toBe(false)
    expect(p.drivers.find((d) => d.id === 'phs_not_applicable')?.text).toMatch(/physiological monitoring/)
    expect(a.minutesToLimit).toBeNull()
    expect(a.confidence).toBe('low')
  })

  it('outside the validity range (very heavy work) → info driver and lower confidence; unverified FR values too', () => {
    const veryHeavy: Task = { ...MAINTENANCE, workClass: 'very_heavy' }
    const a = assessSnapshot(ctx(CREWMATE, now, veryHeavy, 'sun', heat))
    expect(ids(a)).toContain('phs_out_of_validity')
    expect(a.confidence).not.toBe('high')
    const fr = assessSnapshot(ctx(CREWMATE, now, WELDING_NO_HOOD, 'sun', heat))
    expect(ids(fr)).toContain('phs_clothing_unverified')
    expect(fr.confidence).not.toBe('high')
  })

  it('a reached limit holds through rest (ISO recovery caveat) until a reviewed recovery or a new shift', () => {
    const { steps, state } = runDay(AUG1, CREWMATE, WELDING_NO_HOOD, { from: '06:00', to: '08:00' })
    expect(steps[steps.length - 1].a.minutesToLimit).toBe(0)
    const rest = stepWorkerEngine(state, ctxAt(AUG1, local(AUG1, '08:01'), CREWMATE, null, 'shade'))
    expect(ch(rest.assessment, 'projection').level).toBe('stop')
    expect(ids(rest.assessment)).toContain('phs_recovery_not_modelled')
    expect(ids(rest.assessment)).toContain('phs_recovery_review_required')
    expect(rest.detail.phsRecovery?.needs).toEqual({ rest: true, checkin: true, signoff: true })
    const nextShift = stepWorkerEngine(rest.state, ctxAt(NOV26, local(NOV26, '06:00'), CREWMATE, null, 'shade'))
    expect(nextShift.state.shiftStartT).toBe(local(NOV26, '06:00'))
    expect(nextShift.assessment.minutesToLimit).not.toBe(0)
    expect(nextShift.state.phsRecovery).toBeNull()
    expect(nextShift.state.phsRestartedAt).toBeNull()
  })

  it('fasting: no drinking in PHS (stricter dehydration limit) and the projection is never longer', () => {
    const fastCtx = ctx(CREWMATE, now, MAINTENANCE, 'sun', heat, { fastingNow: true })
    const fasting = assessSnapshot(fastCtx)
    const normal = assessSnapshot(ctx(CREWMATE, now, MAINTENANCE, 'sun', heat))
    expect(ids(fasting)).toContain('phs_no_drinking')
    expect(fasting.minutesToLimit ?? Infinity).toBeLessThanOrEqual(normal.minutesToLimit ?? Infinity)
  })
})

// ─────────────────────────────── Physiology channel ───────────────────────────────

describe('physiology channel', () => {
  const start = epochFromLocal('2025-11-26T06:00')
  const heat = heatFrom({ t: start, taC: 22, rhPct: 50, ghiWm2: 100 })

  const runHr = (profile: WorkerProfile, hr: (m: number) => number | null, minutes: number, task: Task | null = INSPECTION) => {
    let state = createWorkerEngine(profile, start)
    const out: RiskAssessment[] = []
    for (let m = 1; m <= minutes; m++) {
      const v = hr(m)
      const r = stepWorkerEngine(state, ctx(profile, start + m * MIN, task, 'shade', heat), {
        physioMinute: v === null ? null : { hrMeanBpm: v, minuteValid: true, rScale: 1 },
      })
      state = r.state
      out.push(r.assessment)
    }
    return { out, state }
  }

  it('HR-suppressing medication: unavailable even with a clean signal; HR is not processed', () => {
    const { out, state } = runHr(BETA_BLOCKER, () => 85, 45)
    for (const a of out) expect(ch(a, 'physiology').available).toBe(false)
    expect(ids(out[44])).toContain('physio_unavailable_hr_suppressing_medication')
    expect(state.physio.minutes).toHaveLength(0)
  })

  it('without consent the HR minutes are ignored (data minimisation)', () => {
    const { out, state } = runHr(NO_CONSENT, () => 85, 20)
    expect(ch(out[19], 'physiology').available).toBe(false)
    expect(state.physio.minutes).toHaveLength(0)
    expect(out[19].dataQuality.physiology).toBe('absent')
  })

  it('consented clean signal: available after the 30-min warm-up, no start-up check_sensor, never lowers the level', () => {
    const { out } = runHr(CREWMATE, () => 85, 40)
    expect(ch(out[5], 'physiology').available).toBe(false)
    expect(out[5].actions).not.toContain('check_sensor')
    expect(ch(out[35], 'physiology').available).toBe(true)
    expect(ch(out[35], 'physiology').level).toBe('safe')
    expect(out[35].dataQuality.physiology).toBe('good')
  })

  it('sustained very high HR raises to stop (T2) and latches even after the signal disappears', () => {
    const { out, state } = runHr(CREWMATE, (m) => (m <= 60 ? Math.min(195, 80 + m * 2.2) : null), 90, null)
    const peak = out.findIndex((a) => ch(a, 'physiology').level === 'stop')
    expect(peak).toBeGreaterThan(30)
    expect(state.latch?.channel).toBe('physiology')
    const last = out[out.length - 1]
    expect(ch(last, 'physiology').level).toBe('stop')
    expect(last.level).toBe('stop')
    expect(ids(last)).toContain('clinical_latch')
  })
})

// ─────────────────────────────── Symptoms and hydration ───────────────────────────────

describe('symptoms and hydration channels', () => {
  const now = epochFromLocal('2025-11-26T08:00')
  const heat = heatFrom({ t: now, taC: 22, rhPct: 50, ghiWm2: 300 })

  it('buddy check-in with confusion → emergency with call_998 first (consent not needed for buddy reports)', () => {
    for (const w of [CREWMATE, NO_CONSENT]) {
      const r = stepWorkerEngine(createWorkerEngine(w, now), ctx(w, now, INSPECTION, 'shade', heat), { checkin: checkin(w, now, ['confusion'], 'buddy') })
      expect(r.assessment.level).toBe('emergency')
      expect(r.assessment.actions.slice(0, 3)).toEqual(['call_998', 'cool_first', 'stay_with_worker'])
      expect(r.state.latch?.tier).toBe(3)
    }
  })

  it('T1 cramps → high, not latched; drops after the dwell once a clean check-in arrives', () => {
    let r = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, INSPECTION, 'shade', heat), { checkin: checkin(CREWMATE, now, ['cramps']) })
    expect(r.assessment.level).toBe('high')
    expect(r.state.latch).toBeNull()
    r = stepWorkerEngine(r.state, ctx(CREWMATE, now + MIN, INSPECTION, 'shade', heat), { checkin: checkin(CREWMATE, now + MIN, []) })
    expect(r.assessment.level).toBe('high') // held by the dwell
    let s = r.state
    let level: RiskLevel = r.assessment.level
    for (let m = 2; m <= 12; m++) {
      const x = stepWorkerEngine(s, ctx(CREWMATE, now + m * MIN, INSPECTION, 'shade', heat))
      s = x.state
      level = x.assessment.level
    }
    expect(level).toBe('safe')
  })

  it('urine shade 7 → hydration high', () => {
    const r = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, INSPECTION, 'shade', heat), { checkin: checkin(CREWMATE, now, [], 'self', { urineColor: 7 }) })
    expect(ch(r.assessment, 'hydration').level).toBe('high')
    expect(r.assessment.level).toBe('high')
  })

  it('fasting: waterMlPerHour 0 with a driver, no drink actions; the water level logic is otherwise unchanged', () => {
    const fasting = stepWorkerEngine(createWorkerEngine(FASTING, now), ctx(FASTING, now, INSPECTION, 'sun', heat, { fastingNow: true }))
    expect(fasting.assessment.waterMlPerHour).toBe(0)
    expect(ids(fasting.assessment)).toContain('water_paused_fasting')
    expect(fasting.assessment.actions).not.toContain('drink_water')
    expect(fasting.assessment.actions).not.toContain('electrolytes')
    const notFasting = stepWorkerEngine(createWorkerEngine(FASTING, now), ctx(FASTING, now, INSPECTION, 'sun', heat, { fastingNow: false }))
    expect(notFasting.assessment.waterMlPerHour).toBeGreaterThan(600)
  })

  it('water: at least the ADOSH zone minimum and never above the 1.42 L/h cap', () => {
    const r = assessSnapshot(ctxAt(AUG1, local(AUG1, '09:00'), CREWMATE, INSPECTION, 'sun'))
    expect(r.waterMlPerHour).toBeGreaterThanOrEqual(1000)
    expect(r.waterMlPerHour).toBeLessThanOrEqual(1419.6)
  })
})

// ─────────────────────────────── Latch ───────────────────────────────

describe('clinical latch', () => {
  const t0 = epochFromLocal('2025-11-26T08:00')
  const heat = heatFrom({ t: t0, taC: 22, rhPct: 50, ghiWm2: 300 })
  const step = (s: WorkerEngineState, m: number, inputs: WorkerInputs = {}, location: WorkerLocation = 'shade', task: Task | null = INSPECTION) =>
    stepWorkerEngine(s, ctx(CREWMATE, t0 + m * MIN, task, location, heat), inputs)

  it('T2 check-in latches until resolved AND a clean re-check; then no hot work in the sun for the rest of the day', () => {
    let r = step(createWorkerEngine(CREWMATE, t0), 0, { checkin: checkin(CREWMATE, t0, ['dizziness']) })
    expect(r.assessment.level).toBe('stop')
    expect(r.state.latch).toMatchObject({ tier: 2, channel: 'symptoms' })
    expect(r.state.latch?.noHotWorkUntil).toBe(epochFromLocal('2025-11-27T00:00'))
    // Clean re-check alone: still stop.
    r = step(r.state, 15, { checkin: checkin(CREWMATE, t0 + 15 * MIN, [], 'first_aider') })
    expect(r.assessment.level).toBe('stop')
    expect(ids(r.assessment)).toContain('clinical_latch')
    r = step(r.state, 20)
    expect(r.assessment.level).toBe('stop')
    // Resolution after the clean re-check: cleared (display then follows the 10-min dwell).
    r = step(r.state, 21, { resolution: { by: 'first_aider', t: t0 + 21 * MIN } })
    expect(r.state.latch?.clearedAt).toBe(t0 + 21 * MIN)
    expect(r.detail.computedLevel).toBe('safe')
    expect(r.assessment.level).toBe('stop')
    let s = r.state
    for (let m = 22; m <= 31; m++) s = step(s, m).state
    expect(step(s, 32).assessment.level).toBe('safe')
    // No hot work in the sun for the rest of the local day.
    const sun = step(s, 33, {}, 'sun')
    expect(sun.assessment.level).toBe('stop')
    expect(sun.assessment.actions).toContain('no_hot_work_today')
    const restInSun = step(s, 33, {}, 'sun', null)
    expect(ch(restInSun.assessment, 'symptoms').level).not.toBe('stop')
  })

  it('resolution first, then the clean re-check: clears only at the re-check', () => {
    let r = step(createWorkerEngine(CREWMATE, t0), 0, { checkin: checkin(CREWMATE, t0, ['headache']) })
    r = step(r.state, 10, { resolution: { by: 'supervisor', t: t0 + 10 * MIN } })
    expect(r.state.latch?.clearedAt).toBeUndefined()
    expect(r.assessment.level).toBe('stop')
    r = step(r.state, 20, { checkin: checkin(CREWMATE, t0 + 20 * MIN, ['thirst']) })
    expect(r.state.latch?.clearedAt).toBe(t0 + 20 * MIN)
  })

  it('a resolution recorded before the event does not pre-authorise; a re-check with T2 symptoms does not clear', () => {
    let r = step(createWorkerEngine(CREWMATE, t0), 0, { resolution: { by: 'first_aider', t: t0 } })
    r = step(r.state, 1, { checkin: checkin(CREWMATE, t0 + MIN, ['nausea']) })
    r = step(r.state, 5, { checkin: checkin(CREWMATE, t0 + 5 * MIN, ['nausea'], 'self', { trend: 'better' }) })
    r = step(r.state, 6, { resolution: { by: 'first_aider', t: t0 + 6 * MIN } })
    expect(r.state.latch?.clearedAt).toBeUndefined()
    expect(r.assessment.level).toBe('stop')
  })

  it('T3 emergency stays an emergency through a clean check-in until a resolution', () => {
    let r = step(createWorkerEngine(CREWMATE, t0), 0, { checkin: checkin(CREWMATE, t0, ['collapsed_unresponsive'], 'buddy') })
    expect(r.assessment.level).toBe('emergency')
    r = step(r.state, 30, { checkin: checkin(CREWMATE, t0 + 30 * MIN, [], 'first_aider') })
    expect(r.assessment.level).toBe('emergency')
    expect(r.assessment.actions[0]).toBe('call_998')
    r = step(r.state, 40, { resolution: { by: 'occ_health', t: t0 + 40 * MIN } })
    expect(r.state.latch?.clearedAt).toBe(t0 + 40 * MIN)
  })

  it('the no-hot-work restriction ends with the local day', () => {
    let r = step(createWorkerEngine(CREWMATE, t0), 0, { checkin: checkin(CREWMATE, t0, ['dizziness']) })
    r = step(r.state, 10, { checkin: checkin(CREWMATE, t0 + 10 * MIN, []) })
    r = step(r.state, 11, { resolution: { by: 'first_aider', t: t0 + 11 * MIN } })
    const tomorrow = epochFromLocal('2025-11-27T08:00')
    const next = stepWorkerEngine(r.state, ctx(CREWMATE, tomorrow, INSPECTION, 'sun', heatFrom({ t: tomorrow, taC: 22, rhPct: 50, ghiWm2: 300 })))
    expect(next.state.latch).toBeNull()
    expect(next.assessment.actions).not.toContain('no_hot_work_today')
  })
})

// ─────────────────────────────── Dwell and fusion ───────────────────────────────

describe('dwell and fusion', () => {
  const t0 = epochFromLocal('2025-11-26T08:00')
  const cool = heatFrom({ t: t0, taC: 22, rhPct: 50, ghiWm2: 300 })
  const hot = heatFrom({ t: t0, taC: 33, rhPct: 60, ghiWm2: 900 })

  it('escalates immediately and de-escalates only after 10 min below; dwellMin 0 drops at once', () => {
    let s = createWorkerEngine(CREWMATE, t0)
    const up = stepWorkerEngine(s, ctx(CREWMATE, t0, MAINTENANCE, 'sun', hot))
    expect(RISK_ORDER[up.assessment.level]).toBeGreaterThan(RISK_ORDER.safe)
    s = up.state
    const levels: RiskLevel[] = []
    for (let m = 1; m <= 12; m++) {
      const r = stepWorkerEngine(s, ctx(CREWMATE, t0 + m * MIN, null, 'shade', cool))
      s = r.state
      levels.push(r.assessment.level)
      if (m < 11) {
        expect(r.detail.held || r.assessment.level === r.detail.computedLevel).toBe(true)
      }
    }
    expect(levels[8]).toBe(up.assessment.level)
    expect(levels[11]).toBe('safe')
    const fast = stepWorkerEngine(up.state, ctx(CREWMATE, t0 + MIN, null, 'shade', cool), {}, { dwellMin: 0 })
    expect(fast.assessment.level).toBe(fast.detail.computedLevel)
  })

  it('level = max over available channels (unless held); actions ordered and unique; drivers sorted', () => {
    const { steps } = runDay(AUG1, NEW_ARRIVAL, INSPECTION, { from: '06:00', to: '07:30' })
    for (const { a, d } of steps) {
      const fused = a.channels.reduce<RiskLevel>((acc, c) => (c.available ? maxLevel(acc, c.level) : acc), 'safe')
      expect(d.computedLevel).toBe(fused)
      expect(RISK_ORDER[a.level]).toBeGreaterThanOrEqual(RISK_ORDER[fused])
      expect(new Set(a.actions).size).toBe(a.actions.length)
      expect(orderActions(a.actions)).toEqual(a.actions)
      const firstInfo = a.drivers.findIndex((x) => x.direction !== 'raises')
      if (firstInfo >= 0) expect(a.drivers.slice(firstInfo).every((x) => x.direction !== 'raises')).toBe(true)
      expect(a.channels.map((c) => c.channel)).toEqual(['environment', 'regulation', 'projection', 'physiology', 'symptoms', 'hydration'])
    }
  })

  it('workMinPerHour = min(environment f·60, regulation minutes), 0 at stop', () => {
    const now = epochFromLocal('2025-11-26T11:00')
    const heat = heatFrom({ t: now, taC: 31, rhPct: 40, ghiWm2: 850 })
    const r = stepWorkerEngine(createWorkerEngine(CREWMATE, now), ctx(CREWMATE, now, MAINTENANCE, 'sun', heat))
    if (RISK_ORDER[r.assessment.level] >= RISK_ORDER.stop) expect(r.assessment.workMinPerHour).toBe(0)
    else expect(r.assessment.workMinPerHour).toBeCloseTo(Math.min(r.detail.allowedWork.workMinPerHour, r.detail.regulation.workMinPerHour), 9)
    const stopped = assessSnapshot(ctxAt(AUG1, local(AUG1, '13:00'), CREWMATE, INSPECTION, 'sun'))
    expect(stopped.workMinPerHour).toBe(0)
    expect(stopped.actions).not.toContain('shade_breaks')
  })

  it('orderActions: emergency first, then stopping, then mitigations', () => {
    expect(orderActions(['drink_water', 'stop_work', 'call_998', 'shade_breaks', 'cool_first', 'drink_water'])).toEqual(['call_998', 'cool_first', 'stop_work', 'shade_breaks', 'drink_water'])
    expect(ACTION_PRIORITY.slice(0, 3)).toEqual(['call_998', 'cool_first', 'stay_with_worker'])
  })

  it('sortDrivers: raises first, then channel severity, then magnitude; duplicates removed', () => {
    const d = (id: string, channel: RiskDriver['channel'], direction: RiskDriver['direction'], value?: number): RiskDriver => ({ id, channel, direction, text: id, basis: 'b', ...(value !== undefined ? { value } : {}) })
    const out = sortDrivers(
      [d('a', 'environment', 'info'), d('b', 'regulation', 'raises', 1), d('c', 'symptoms', 'raises'), d('e', 'regulation', 'raises', 5), d('b', 'regulation', 'raises', 1)],
      { environment: 'caution', regulation: 'high', symptoms: 'stop' },
    )
    expect(out.map((x) => x.id)).toEqual(['c', 'e', 'b', 'a'])
  })

  it('confidence and data quality reflect the environmental source', () => {
    const now = epochFromLocal('2025-11-26T10:00')
    const heat = heatFrom({ t: now })
    const stale = assessSnapshot(ctx(CREWMATE, now, INSPECTION, 'shade', heat, { env: { source: 'cached_forecast', ageMin: 1500, stale: true, confidence: 'low', wbgtMarginC: 1, drivers: [] }, network: 'offline' }))
    expect(stale.confidence).toBe('low')
    expect(stale.dataQuality).toEqual({ env: 'cached_forecast', physiology: 'absent', network: 'offline', stale: true })
    const fresh = assessSnapshot(ctx(CREWMATE, now, INSPECTION, 'shade', heat, { env: { source: 'forecast', ageMin: 30, stale: false, confidence: 'high', wbgtMarginC: 0, drivers: [] } }))
    expect(fresh.confidence).toBe('high')
    const fallback = assessSnapshot(ctx(CREWMATE, now, INSPECTION, 'shade', heatFrom({ t: now, source: 'conservative_default' })))
    expect(fallback.confidence).toBe('low')
  })
})

// ─────────────────────────────── Fail-safe properties ───────────────────────────────

describe('fail-safe properties', () => {
  const times = ['05:00', '06:30', '08:00', '09:30', '11:00', '13:00', '15:30', '17:00', '19:00']
  const tasks: (Task | null)[] = [null, INSPECTION, MAINTENANCE, WELDING]
  const locations: WorkerLocation[] = ['sun', 'shade', 'indoor_cool']

  it('a +1 °C data margin (stale data) never lowers the level', () => {
    for (const day of [AUG1, NOV26]) {
      for (const hh of times) {
        for (const task of tasks) {
          for (const location of locations) {
            for (const w of [NEW_ARRIVAL, CREWMATE]) {
              const base = ctxAt(day, local(day, hh), w, task, location)
              const fresh = assessSnapshot({ ...base, env: { ...base.env!, wbgtMarginC: 0 } })
              const margin = assessSnapshot({ ...base, env: { ...base.env!, wbgtMarginC: 1, stale: true } })
              expect(RISK_ORDER[margin.level]).toBeGreaterThanOrEqual(RISK_ORDER[fresh.level])
              expect(margin.workMinPerHour).toBeLessThanOrEqual(fresh.workMinPerHour + 1e-9)
            }
          }
        }
      }
    }
  })

  it('unknown solar (clear-sky default) never lowers the level compared with the measured radiation', () => {
    for (const day of [AUG1, NOV26]) {
      for (const hh of ['07:00', '10:00', '13:00', '16:00']) {
        const now = local(day, hh)
        const { env } = siteAt(day, now)
        const measured = computeSiteHeat(env.sample, SITE)
        const unknown = computeSiteHeat({ ...env.sample, ghiWm2: Number.NaN }, SITE)
        for (const task of tasks) {
          const a = assessSnapshot(ctx(CREWMATE, now, task, 'sun', measured))
          const b = assessSnapshot(ctx(CREWMATE, now, task, 'sun', unknown))
          expect(RISK_ORDER[b.level]).toBeGreaterThanOrEqual(RISK_ORDER[a.level])
        }
      }
    }
  })

  it('missing physiology minutes or no check-ins never lower the level (channels unavailable, not reassuring)', () => {
    const hr = (bpm: number) => () => ({ physioMinute: { hrMeanBpm: bpm, minuteValid: true, rScale: 1 } })
    for (const day of [AUG1, NOV26]) {
      const withHr = runDay(day, CREWMATE, INSPECTION, { from: '06:00', to: '09:00', inputs: hr(95) })
      const missing = runDay(day, CREWMATE, INSPECTION, { from: '06:00', to: '09:00', inputs: () => ({ physioMinute: null }) })
      const nothing = runDay(day, CREWMATE, INSPECTION, { from: '06:00', to: '09:00' })
      const highHr = runDay(day, CREWMATE, INSPECTION, { from: '06:00', to: '09:00', inputs: hr(175) })
      withHr.steps.forEach((s, i) => {
        expect(RISK_ORDER[missing.steps[i].a.level]).toBeGreaterThanOrEqual(RISK_ORDER[s.a.level])
        expect(RISK_ORDER[nothing.steps[i].a.level]).toBeGreaterThanOrEqual(RISK_ORDER[s.a.level])
        expect(RISK_ORDER[highHr.steps[i].a.level]).toBeGreaterThanOrEqual(RISK_ORDER[s.a.level])
      })
    }
  })

  it('unknown body size uses 75 kg / 175 cm; unknown clothing uses cloth coveralls (CAV 0, no short-sleeve credit)', () => {
    const now = local(NOV26, '11:00')
    const bare: WorkerProfile = { ...CREWMATE, massKg: undefined, heightCm: undefined, ageYears: undefined, clothing: undefined as unknown as WorkerProfile['clothing'] }
    const r = stepWorkerEngine(createWorkerEngine(bare, now), ctxAt(NOV26, now, bare, MAINTENANCE, 'sun'))
    expect(r.detail.workW).toBe(taskMetabolicW(MAINTENANCE, 75))
    expect(r.detail.wbgtWorkEffC).toBeCloseTo(siteAt(NOV26, now).heat.wbgtC, 12)
    expect(Number.isFinite(r.assessment.waterMlPerHour)).toBe(true)
  })

  it('a long gap is simulated only up to the catch-up cap and lowers confidence', () => {
    const start = local(AUG1, '06:00')
    const first = stepWorkerEngine(createWorkerEngine(CREWMATE, start), ctxAt(AUG1, start, CREWMATE, null, 'shade'))
    const later = stepWorkerEngine(first.state, ctxAt(AUG1, start + 150 * MIN, CREWMATE, null, 'shade'))
    expect(ids(later.assessment)).toContain('step_gap_capped')
    expect(later.state.phs!.elapsedMin).toBe(RISK_THRESHOLDS.steps.maxCatchUpMin)
    expect(later.assessment.confidence).not.toBe('high')
  })
})

// ─────────────────────────────── State hygiene ───────────────────────────────

describe('state hygiene', () => {
  it('stepWorkerEngine does not mutate its input state; assessSnapshot is stateless', () => {
    const now = local(AUG1, '08:00')
    const s0 = createWorkerEngine(CREWMATE, local(AUG1, '06:00'))
    const copy = structuredClone(s0)
    stepWorkerEngine(s0, ctxAt(AUG1, now, CREWMATE, WELDING_NO_HOOD, 'sun'), { checkin: checkin(CREWMATE, now, ['dizziness']), physioMinute: CLEAN_HR })
    expect(s0).toEqual(copy)
    const c = ctxAt(AUG1, now, CREWMATE, INSPECTION, 'sun')
    expect(assessSnapshot(c)).toEqual(assessSnapshot(c))
  })

  it('the state survives structuredClone and keeps check-ins (12 h) and intakes (24 h) only', () => {
    const t = local(NOV26, '06:00')
    let r = stepWorkerEngine(createWorkerEngine(CREWMATE, t), ctxAt(NOV26, t, CREWMATE, null, 'shade'), {
      checkin: checkin(CREWMATE, t, []),
      intake: { t, workerId: CREWMATE.id, ml: 250 },
    })
    const cloned = structuredClone(r.state)
    const a = stepWorkerEngine(r.state, ctxAt(NOV26, t + MIN, CREWMATE, INSPECTION, 'sun')).assessment
    const b = stepWorkerEngine(cloned, ctxAt(NOV26, t + MIN, CREWMATE, INSPECTION, 'sun')).assessment
    expect(b).toEqual(a)
    r = stepWorkerEngine(r.state, ctxAt(NOV26, t + 13 * 60 * MIN, CREWMATE, null, 'shade'))
    expect(r.state.checkins).toHaveLength(0)
    expect(r.state.intakes).toHaveLength(1)
  })

  it('the state is plain data: a JSON round trip (also after missing HR minutes) gives the same next assessment', () => {
    const start = local(AUG1, '06:00')
    let s = createWorkerEngine(CREWMATE, start)
    for (let m = 0; m <= 40; m++) {
      const now = start + m * MIN
      s = stepWorkerEngine(s, ctxAt(AUG1, now, CREWMATE, INSPECTION, 'sun'), { physioMinute: m < 35 ? CLEAN_HR : null, ...(m === 20 ? { checkin: checkin(CREWMATE, now, ['heat_rash']) } : {}) }).state
    }
    const json = JSON.parse(JSON.stringify(s)) as WorkerEngineState
    const c = ctxAt(AUG1, start + 41 * MIN, CREWMATE, INSPECTION, 'sun')
    expect(stepWorkerEngine(json, c, { physioMinute: CLEAN_HR }).assessment).toEqual(stepWorkerEngine(s, c, { physioMinute: CLEAN_HR }).assessment)
  })

  it('DRIVER_IDS is unique and covers this module, indices and the pass-through ids', () => {
    expect(new Set(DRIVER_IDS).size).toBe(DRIVER_IDS.length)
    for (const id of RISK_DRIVER_IDS) expect(DRIVER_IDS).toContain(id)
    for (const id of ['env_wind_default', 'midday_break', 'symptom_confusion', 'physio_unavailable_hr_suppressing_medication', 'env_source_archive']) expect(DRIVER_IDS).toContain(id)
  })
})

// ─────────────────────────────── End to end: Musaffah demo days ───────────────────────────────

describe('end to end — Musaffah, 1 Aug 2025 (peak WBGT day) with the demo crew', () => {
  it('the day-2 new arrival reaches STOP earlier than the veteran on the same light task', () => {
    const arrival = runDay(AUG1, NEW_ARRIVAL, INSPECTION)
    const veteran = runDay(AUG1, VETERAN, INSPECTION, { inputs: () => ({ physioMinute: CLEAN_HR }) })
    const a = firstAtLeast(arrival.steps, 'stop')
    const v = firstAtLeast(veteran.steps, 'stop')
    expect(a).not.toBeNull()
    expect(v).not.toBeNull()
    expect(a!).toBeLessThan(v!)
    expect(a).toBe(local(AUG1, '06:00'))
  })

  it('the FR + hood welder gets fewer work minutes per hour than an unhooded crewmate on the same task', () => {
    const hooded = runDay(AUG1, VETERAN, WELDING)
    const open = runDay(AUG1, CREWMATE, WELDING_NO_HOOD)
    let strict = 0
    hooded.steps.forEach((s, i) => {
      const o = open.steps[i]
      expect(s.a.workMinPerHour).toBeLessThanOrEqual(o.a.workMinPerHour + 1e-9)
      if (o.d.allowedWork.workMinPerHour > 0) {
        expect(s.d.allowedWork.workMinPerHour).toBeLessThan(o.d.allowedWork.workMinPerHour)
        strict++
      }
    })
    expect(strict).toBeGreaterThan(30)
    // With headroom (mild 26 Nov), the assessment's work minutes differ too.
    for (const hh of ['11:00', '13:00']) {
      const h = assessSnapshot(ctxAt(NOV26, local(NOV26, hh), VETERAN, WELDING, 'sun'))
      const u = assessSnapshot(ctxAt(NOV26, local(NOV26, hh), CREWMATE, WELDING_NO_HOOD, 'sun'))
      expect(h.workMinPerHour).toBeLessThan(u.workMinPerHour)
      expect(h.drivers.find((d) => d.id === 'clothing_adjustment')?.value).toBe(1)
    }
  })

  it("the beta-blocker worker's physiology channel is unavailable all shift even with clean HR", () => {
    const beta = runDay(AUG1, BETA_BLOCKER, TASK('grinding'), { to: '08:00', inputs: () => ({ physioMinute: CLEAN_HR }) })
    const mate = runDay(AUG1, CREWMATE, TASK('grinding'), { to: '08:00', inputs: () => ({ physioMinute: CLEAN_HR }) })
    for (const s of beta.steps) {
      expect(ch(s.a, 'physiology').available).toBe(false)
      expect(ch(s.a, 'physiology').drivers[0].id).toBe('physio_unavailable_hr_suppressing_medication')
    }
    expect(ch(mate.steps[60].a, 'physiology').available).toBe(true)
  })

  it('13:00 on 1 Aug outdoor-in-sun → STOP with midday_break; not on 26 Nov (mild day)', () => {
    const aug = runDay(AUG1, CREWMATE, INSPECTION, { from: '12:00', to: '13:00' }).steps.at(-1)!.a
    expect(aug.level).toBe('stop')
    expect(aug.actions).toContain('midday_break')
    expect(ids(aug)).toContain('midday_break')
    expect(ch(aug, 'regulation').level).toBe('stop')
    const nov = runDay(NOV26, CREWMATE, INSPECTION, { from: '12:00', to: '13:00' }).steps.at(-1)!.a
    expect(nov.actions).not.toContain('midday_break')
    expect(ids(nov)).not.toContain('midday_break')
    expect(ch(nov, 'regulation').level).toBe('safe')
    expect(RISK_ORDER[nov.level]).toBeLessThan(RISK_ORDER.stop)
  })

  it("a buddy check-in with 'confusion' → EMERGENCY with call_998 first", () => {
    const at = local(AUG1, '09:15')
    const r = runDay(AUG1, CREWMATE, INSPECTION, { from: '09:00', to: '09:20', inputs: (now) => (now === at ? { checkin: checkin(CREWMATE, at, ['confusion'], 'buddy') } : {}) })
    const after = r.steps.filter((s) => s.now >= at)
    for (const s of after) {
      expect(s.a.level).toBe('emergency')
      expect(s.a.actions[0]).toBe('call_998')
    }
    expect(r.steps.find((s) => s.now === at - MIN)!.a.level).not.toBe('emergency')
  })

  it('a T2 check-in latches the symptoms channel until resolved + clean re-check', () => {
    const t2 = local(AUG1, '07:10')
    const recheck = local(AUG1, '07:30')
    const resolve = local(AUG1, '07:40')
    const r = runDay(AUG1, CREWMATE, null, {
      from: '07:00',
      to: '08:00',
      plan: () => ({ task: null, location: 'indoor_cool' }),
      inputs: (now) =>
        now === t2
          ? { checkin: checkin(CREWMATE, t2, ['dizziness', 'headache']) }
          : now === recheck
            ? { checkin: checkin(CREWMATE, recheck, [], 'first_aider') }
            : now === resolve
              ? { resolution: { by: 'first_aider', t: resolve } }
              : {},
    })
    const sym = (now: number) => ch(r.steps.find((s) => s.now === now)!.a, 'symptoms')
    expect(sym(t2 - MIN).level).not.toBe('stop')
    for (let t = t2; t < resolve; t += MIN) {
      expect(sym(t).level).toBe('stop')
      expect(RISK_ORDER[r.steps.find((s) => s.now === t)!.a.level]).toBeGreaterThanOrEqual(RISK_ORDER.stop)
    }
    expect(sym(recheck + MIN).drivers.some((d) => d.id === 'clinical_latch')).toBe(true)
    expect(sym(resolve).level).not.toBe('stop')
    expect(r.state.latch?.clearedAt).toBe(resolve)
    expect(r.state.latch?.noHotWorkUntil).toBe(epochFromLocal('2025-08-02T00:00'))
  })

  it('every driver id in a full crew day is listed in DRIVER_IDS; every driver has a basis; claims discipline holds', () => {
    const seen = new Set<string>()
    const texts = new Set<string>()
    for (const w of workers) {
      const task = w.id === VETERAN.id ? WELDING : w.id === NEW_ARRIVAL.id ? MAINTENANCE : INSPECTION
      const r = runDay(AUG1, w, task, {
        from: '05:00',
        to: '18:00',
        inputs: (now) => ({
          ...(w.hasWearable ? { physioMinute: CLEAN_HR } : {}),
          ...(now === local(AUG1, '10:00') ? { checkin: checkin(w, now, ['dizziness'], 'self', { urineColor: 6 }) } : {}),
        }),
      })
      for (const s of r.steps) {
        for (const d of s.a.drivers) {
          seen.add(d.id)
          texts.add(d.text)
          expect(d.basis.length).toBeGreaterThan(3)
        }
      }
    }
    for (const id of seen) expect(DRIVER_IDS).toContain(id)
    expect(seen.size).toBeGreaterThan(20)
    for (const t of texts) expect(t).not.toMatch(/diagnos|predicts? heat ?stroke|measures? core temperature/i)
  })

  it('performance: mean time per worker-minute step (projection every 5 min)', () => {
    const start = local(AUG1, '06:00')
    const days = [AUG1, NOV26]
    let n = 0
    let ms = 0
    for (const day of days) {
      const states = new Map(workers.map((w) => [w.id, createWorkerEngine(w, local(day, '06:00'))]))
      for (let m = 0; m <= 12 * 60; m++) {
        const now = local(day, '06:00') + m * MIN
        const { env, heat } = siteAt(day, now)
        for (const w of workers) {
          const task = m % 60 < 45 ? INSPECTION : null
          const c: WorkerContext = { now, profile: w, task, location: task ? 'sun' : 'shade', heat, env, network: 'online' }
          const t0 = performance.now()
          const r = stepWorkerEngine(states.get(w.id)!, c, w.hasWearable ? { physioMinute: CLEAN_HR } : {})
          ms += performance.now() - t0
          n++
          states.set(w.id, r.state)
        }
      }
    }
    expect(start).toBeGreaterThan(0)
    const mean = ms / n
    expect(mean).toBeLessThan(0.5)
  })
})

// ─────────────────────────────── Wave 2c: water credit, projection hold, plan cap, memo ───────────────────────────────

const REF: WorkerProfile = {
  id: 'W-REF',
  displayName: 'Ref',
  crewId: 'c-ref',
  siteId: 'musaffah',
  language: 'en',
  massKg: 75,
  heightCm: 175,
  daysOnSite: 30,
  daysAwayRecent: 0,
  experiencedInHeat: true,
  clothing: 'cloth_coveralls',
  riskFlags: [],
  consent: { wearable: false, healthFlags: true, checkins: true, shareWithMedicOnEscalation: false, aggregateStatistics: false, updatedAt: 0 },
  hasWearable: false,
}
const T0 = epochFromLocal('2025-11-26T05:00')
const HEAVY_FR: Task = { id: 'weld-fr', name: 'FR welding', workClass: 'heavy', inSun: true, clothing: 'fr_coveralls', durationMin: 480, flexible: true }
const VERY_HEAVY_FR: Task = { ...HEAVY_FR, id: 'grind-fr', name: 'FR grinding', workClass: 'very_heavy' }
const MODERATE_SUN: Task = { id: 'rig', name: 'Rigging', workClass: 'moderate', inSun: true, durationMin: 600, flexible: true }
const LIGHT_SHADE: Task = { id: 'inspect', name: 'Inspection', workClass: 'light', inSun: false, durationMin: 120, flexible: true }
const isStop = (l: RiskLevel): boolean => RISK_ORDER[l] >= RISK_ORDER.stop

interface LoopStep {
  m: number
  working: boolean
  a: RiskAssessment
  d: WorkerStepDetail
  s: WorkerEngineState
}
interface LoopOptions {
  profile?: WorkerProfile
  /** true: rest when the device shows stop and go back when it no longer does (default); false: keep working. */
  comply?: boolean
  /** Forced activity for minute m (overrides the compliance rule). */
  activity?: (m: number, prev: LoopStep | null) => 'work' | 'rest' | null
  extra?: (m: number) => Partial<WorkerContext>
  inputs?: (m: number, prev: LoopStep | null) => WorkerInputs
}
/** One worker, constant site heat, stepped minute by minute from T0; rests in the air-conditioned cabin. */
function loop(heat: SiteHeat, task: Task, minutes: number, o: LoopOptions = {}): LoopStep[] {
  const profile = o.profile ?? REF
  let state = createWorkerEngine(profile, T0)
  let working = true
  let prev: LoopStep | null = null
  const out: LoopStep[] = []
  for (let m = 0; m <= minutes; m++) {
    const forced: 'work' | 'rest' | null = o.activity?.(m, prev) ?? null
    if (forced !== null) working = forced === 'work'
    const now = T0 + m * MIN
    const c: WorkerContext = {
      now,
      profile,
      task: working ? task : null,
      location: working ? (task.inSun ? 'sun' : 'shade') : 'indoor_cool',
      heat,
      network: 'online',
      restArea: 'cooled_cabin',
      ...(o.extra?.(m) ?? {}),
    }
    const r = stepWorkerEngine(state, c, o.inputs?.(m, prev) ?? {})
    state = r.state
    prev = { m, working, a: r.assessment, d: r.detail, s: r.state }
    out.push(prev)
    if (o.comply !== false && forced === null) {
      if (working && isStop(r.assessment.level)) working = false
      else if (!working && !isStop(r.assessment.level)) working = true
    }
  }
  return out
}
const refInput = (heat: SiteHeat, task: Task | null, location: WorkerLocation, fasting = false) =>
  buildPhsInput({ climate: heat, location, task, clothing: task?.clothing ?? 'cloth_coveralls', massKg: 75, heightCm: 175, acclimatized: true, fasting }).input

describe('water-loss limit with logged drinking (RISK_THRESHOLDS.hydrationCredit)', () => {
  const heat = heatFrom({ t: T0, taC: 34, rhPct: 40, ghiWm2: 700 })
  const drinks = (every: number, ml: number) => (m: number): WorkerInputs => (m > 0 && m % every === 0 ? { intake: { t: T0 + m * MIN, workerId: REF.id, ml } } : {})

  it('constants carry their basis; the ISO-implied replacement is 1 − 3 %/5 %', () => {
    const H = RISK_THRESHOLDS.hydrationCredit
    expect(H.creditFactor).toBe(0.8)
    expect(H.hourlyCapL).toBe(FLUID.HOURLY_CAP_L)
    expect(H.isoLossFraction).toBe(0.05)
    expect(H.netLossFraction).toBe(0.03)
    expect(H.isoImpliedReplacement).toBeCloseTo(1 - 0.03 / 0.05, 12)
    expect(H.restartNetLossFraction).toBe(0.02)
    expect(H.basis).toMatch(/ISO 7933/)
    expect(H.basis).toMatch(/\[ENG\]/)
  })

  it('creditedIntakeL: 0.8 × Σ per local clock hour of min(logged, hourly cap), since the shift start (known answers)', () => {
    const at = (hhmm: string) => epochFromLocal(`2025-11-26T${hhmm}`)
    const x = (hhmm: string, ml: number, workerId = REF.id): FluidIntake => ({ t: at(hhmm), workerId, ml })
    const intakes = [x('06:50', 400), x('07:10', 1000), x('07:50', 1000), x('08:05', 300), x('08:30', 500, 'OTHER'), x('08:40', -200), x('09:30', 250)]
    // 06:50 is before the shift start (07:00), 09:30 after `now`; 07:xx is capped at 1.42 L; OTHER and negatives ignored.
    expect(creditedIntakeL(intakes, at('07:00'), at('09:00'), REF.id)).toBeCloseTo(0.8 * (FLUID.HOURLY_CAP_L + 0.3), 12)
    expect(creditedIntakeL(intakes, at('07:00'), at('09:00'))).toBeCloseTo(0.8 * (FLUID.HOURLY_CAP_L + 0.8), 12)
    expect(creditedIntakeL([x('07:59', 1000), x('08:00', 1000)], at('07:00'), at('09:00'))).toBeCloseTo(0.8 * 2, 12) // clock hours, not a rolling hour
    expect(creditedIntakeL([], at('07:00'), at('09:00'))).toBe(0)
  })

  it('no logs → exactly ISO 7933: threshold 5 % of body mass, and the limit is reached when the 5 % mark is crossed', () => {
    const run = loop(heat, MODERATE_SUN, 260, { comply: false })
    const reached = run.find((s) => s.d.phsRecovery !== null) as LoopStep
    expect(reached).toBeDefined()
    expect(reached.d.phsRecovery?.binding).toBe('dehydration')
    expect(reached.s.phs?.waterLoss5PctMin).not.toBeNull()
    for (const s of run) {
      expect(s.d.water?.thresholdL).toBeCloseTo(3.75, 12)
      expect(s.d.water?.creditedIntakeL).toBe(0)
    }
    // Logs without the check-in consent are not used: identical levels and projections.
    const noConsent = loop(heat, MODERATE_SUN, 260, { comply: false, profile: { ...REF, consent: { ...REF.consent, checkins: false } }, inputs: drinks(15, 250) })
    expect(noConsent.map((s) => [s.a.level, s.a.minutesToLimit])).toEqual(run.map((s) => [s.a.level, s.a.minutesToLimit]))
  })

  it('logged drinking: threshold max(5 %, 3 % + credit), net loss sweat − max(credit, 0.4 × sweat), and a later limit', () => {
    const logged = loop(heat, MODERATE_SUN, 300, { comply: false, inputs: drinks(15, 250) })
    const iso = loop(heat, MODERATE_SUN, 300, { comply: false })
    for (const m of [60, 120, 180, 240, 300]) {
      const s = logged[m]
      const C = creditedIntakeL(s.s.intakes, T0, T0 + m * MIN, REF.id)
      const w = s.d.water as NonNullable<WorkerStepDetail['water']>
      expect(w.creditedIntakeL).toBeCloseTo(C, 12)
      expect(w.thresholdL).toBeCloseTo(Math.max(3.75, 2.25 + C), 9)
      expect(w.netLossPctBM).toBeCloseTo((100 * (w.sweatLossL - Math.max(C, 0.4 * w.sweatLossL))) / 75, 9)
      expect(w.restricted).toBe(false)
      expect(s.a.minutesToLimit ?? Infinity).toBeGreaterThanOrEqual(iso[m].a.minutesToLimit ?? Infinity)
    }
    expect(iso[300].d.phsRecovery).not.toBeNull()
    expect(logged[300].d.phsRecovery).toBeNull()
    expect(ids(logged[300].a)).toContain('phs_water_credit')
    expect(logged[300].a.drivers.find((d) => d.id === 'phs_water_credit')?.channel).toBe('hydration')
    // The projection is the ISO 7933 projection at the raised threshold (no further intake assumed).
    const s = logged[300]
    const thrG = (s.d.water?.thresholdL ?? 0) * 1000
    const p = minutesToLimit(s.s.phs!, refInput(heat, MODERATE_SUN, 'sun'), 120, ENGINE_PHS_OPTIONS, { lossThresholdG: thrG })
    expect(s.s.projection?.t).toBe(T0 + 300 * MIN)
    expect(s.a.minutesToLimit).toBe(p.minutes)
  })

  it('fasting (drink = 0): the ISO drink-restricted criterion is unchanged by logged drinks', () => {
    const extra = () => ({ fastingNow: true })
    const a = loop(heat, MODERATE_SUN, 150, { comply: false, extra })
    const b = loop(heat, MODERATE_SUN, 150, { comply: false, extra, inputs: drinks(15, 250) })
    expect(b.map((s) => [s.a.level, s.a.minutesToLimit])).toEqual(a.map((s) => [s.a.level, s.a.minutesToLimit]))
    expect(b[100].d.water?.restricted).toBe(true)
    expect(b[100].d.water?.thresholdL).toBeCloseTo(2.25, 12)
    expect(ids(b[100].a)).not.toContain('phs_water_credit')
    // A reached drink-restricted limit keeps the "no more heat work this shift" wording.
    const reached = a.find((s) => s.d.phsRecovery !== null) as LoopStep
    expect(reached.d.phsRecovery?.blockedBy).toBe('dehydration')
    const txt = reached.a.drivers.find((d) => d.id === 'phs_recovery_review_required')?.text ?? ''
    expect(txt).toMatch(/no more heat work this shift/)
    expect(txt).not.toMatch(/drink and rest/)
  })

  it('a reached water-loss limit is recoverable by drinking: blocked while net > 2 % of body mass, then the reviewed restart', () => {
    let limitM = -1
    let restMetM = -1
    let signoffM = -1
    const run = loop(heat, MODERATE_SUN, 420, {
      activity: (_m, prev) => (prev?.d.phsRecovery || limitM >= 0 ? 'rest' : 'work'),
      inputs: (m, prev) => {
        const t = T0 + m * MIN
        if (limitM < 0 && prev?.d.phsRecovery) limitM = m
        const out: WorkerInputs = {}
        // 500 mL/h while working, then 1.4 L/h (just under the hourly cap) while resting.
        if (m > 0 && m % 15 === 0) out.intake = { t, workerId: REF.id, ml: limitM < 0 ? 125 : 350 }
        const r = prev?.d.phsRecovery
        if (r && !r.needs.rest && restMetM < 0) {
          restMetM = m
          out.checkin = { t, workerId: REF.id, by: 'self', symptoms: [] }
        }
        if (r && !r.needs.rest && !r.needs.checkin && r.restartable && signoffM < 0) {
          signoffM = m
          out.resolution = { by: 'first_aider', t }
        }
        return out
      },
    })
    expect(limitM).toBeGreaterThan(0)
    const blocked = run.filter((s) => s.d.phsRecovery?.blockedBy === 'dehydration')
    expect(blocked.length).toBeGreaterThan(0)
    for (const s of blocked) {
      expect(s.d.water!.netLossPctBM).toBeGreaterThan(2)
      expect(s.d.phsRecovery?.restartable).toBe(false)
      const txt = s.a.drivers.find((d) => d.id === 'phs_recovery_review_required')?.text ?? ''
      expect(txt).toMatch(/drink and rest: the water-loss limit is not yet restored/)
      expect(txt).not.toMatch(/no more heat work this shift/)
      expect(s.a.drivers.find((d) => d.id === 'phs_drink_to_restart')?.channel).toBe('hydration')
      expect(s.a.actions).toContain('drink_water')
    }
    const firstOk = run.find((s) => s.m > limitM && s.d.phsRecovery !== null && s.d.phsRecovery.blockedBy === null) as LoopStep
    expect(firstOk).toBeDefined()
    expect(firstOk.d.water!.netLossPctBM).toBeLessThanOrEqual(2)
    expect(signoffM).toBeGreaterThan(limitM)
    const restarted = run[signoffM]
    expect(restarted.d.phsRecovery).toBeNull()
    expect(restarted.d.phsRestartedAt).toBe(T0 + signoffM * MIN)
    expect(ch(restarted.a, 'projection').level).not.toBe('stop')
    expect(restarted.d.water!.sweatLossL).toBeLessThan(restarted.d.water!.thresholdL)
  })
})

describe('projection hold and the engine-owned resume check (RISK_THRESHOLDS.resume)', () => {
  const heat = heatFrom({ t: T0, taC: 38, rhPct: 35, ghiWm2: 800 })
  const resumeToWeld = () => ({ resumeTask: HEAVY_FR })

  it('constants: release at highFromMin + minBoutMin = 25 min; rest estimate in 5-min steps up to 60 min', () => {
    const R = RISK_THRESHOLDS.resume
    expect(RISK_THRESHOLDS.projection.highFromMin + R.minBoutMin).toBe(25)
    expect([R.restStepMin, R.restMaxMin]).toEqual([5, 60])
    expect(R.basis).toMatch(/ISA-18\.2/)
  })

  it('holds stop through rest until the resume check projects ≥ 25 min; monotone rest estimate; ≥ 10-min bouts (no flapping)', () => {
    const run = loop(heat, HEAVY_FR, 240, { extra: resumeToWeld })
    const i0 = run.findIndex((s) => s.d.resume?.held === true)
    expect(i0).toBeGreaterThan(0)
    expect(run[i0].a.minutesToLimit as number).toBeLessThan(15)
    expect(ids(run[i0].a)).toContain('phs_resume_hold')
    const iR = run.findIndex((s, i) => i > i0 && s.d.resume?.held === false && s.d.resume.estRestMin === 0)
    expect(iR).toBeGreaterThan(i0)
    // Held at stop while resting, although the resting projection itself is safe.
    const held = run.slice(i0 + 1, iR)
    expect(held.every((s) => !s.working && s.d.resume?.held === true && ch(s.a, 'projection').level === 'stop')).toBe(true)
    expect(held.some((s) => projectionLevel(s.a.minutesToLimit) === 'safe')).toBe(true)
    // The check: < 25 min at the previous check, ≥ 25 min at the release (verified with phs.ts directly).
    const lastHold = run[iR - 1].s.projectionHold as NonNullable<WorkerEngineState['projectionHold']>
    expect(lastHold.resumeMin as number).toBeLessThan(25)
    const atRelease = minutesToLimit(run[iR].s.phs!, refInput(heat, HEAVY_FR, 'sun'), 120, ENGINE_PHS_OPTIONS)
    expect(atRelease.minutes === null || atRelease.minutes >= 25).toBe(true)
    // Rest estimate: monotone (never increases) and it counts down to 5 min at the last check.
    const ests = held.map((s) => s.d.resume?.estRestMin).filter((v): v is number => typeof v === 'number')
    for (let k = 1; k < ests.length; k++) expect(ests[k]).toBeLessThanOrEqual(ests[k - 1])
    expect(lastHold.estRestMin).toBe(5)
    // The release skips the dwell: the level drops below stop at once (no other channel was raised).
    expect(isStop(run[iR].a.level)).toBe(false)
    expect(run[iR].d.held).toBe(false)
    // No flapping: the resumed worker works at least minBoutMin minutes before the next stop, with a bout countdown.
    const after = run.slice(iR + 1)
    const nextStop = after.findIndex((s) => isStop(s.a.level))
    expect(nextStop).toBeGreaterThanOrEqual(RISK_THRESHOLDS.resume.minBoutMin)
    expect(after.slice(0, nextStop).every((s) => s.working)).toBe(true)
    const first = after[0]
    expect(first.d.resume?.boutMin).toBe(Math.floor((first.a.minutesToLimit as number) - 15))
    expect(first.a.drivers.find((d) => d.id === 'phs_work_bout')?.text).toBe(`About ${first.d.resume?.boutMin} min of work left before the next rest`)
  })

  it('the estimate is exact at constant conditions: each check is 5 min nearer, and the release comes when it says', () => {
    const run = loop(heat, HEAVY_FR, 120, { extra: resumeToWeld })
    const i0 = run.findIndex((s) => s.d.resume?.held === true)
    const iR = run.findIndex((s, i) => i > i0 && s.d.resume?.held === false)
    const checks = run.filter((s, i) => i > i0 && i < iR && s.s.projectionHold !== null && s.s.projectionHold.checkedT === s.a.t && !s.working)
    expect(checks.length).toBeGreaterThan(1)
    for (const c of checks) expect(iR - c.m).toBe(c.d.resume?.estRestMin)
  })

  it('other channels keep their dwell at a release (a urine reading that eased 5 min before keeps HIGH)', () => {
    const base = loop(heat, HEAVY_FR, 120, { extra: resumeToWeld })
    const i0 = base.findIndex((s) => s.d.resume?.held === true)
    const iR = base.findIndex((s, i) => i > i0 && s.d.resume?.held === false)
    const urine = (m: number, shade: NonNullable<Checkin['urineColor']>): WorkerInputs => ({ checkin: { t: T0 + m * MIN, workerId: REF.id, by: 'self', symptoms: [], urineColor: shade } })
    const run = loop(heat, HEAVY_FR, 120, { extra: resumeToWeld, inputs: (m) => (m === iR - 8 ? urine(m, 7) : m === iR - 5 ? urine(m, 2) : {}) })
    expect(run[iR].d.resume?.held).toBe(false)
    expect(run[iR].a.level).toBe('high')
    expect(run[iR].d.held).toBe(true)
    expect(ids(run[iR].a)).toContain('level_held_dwell')
    expect(base[iR].a.level).not.toBe('high')
  })

  it('infeasible now: even 60 min of rest would not pass → task_not_feasible_now + rotate_task; a lighter resume task releases', () => {
    const hot = heatFrom({ t: T0, taC: 46, rhPct: 35, ghiWm2: 1000 })
    let rotateAt = -1
    const run = loop(hot, VERY_HEAVY_FR, 90, {
      extra: (m) => ({ resumeTask: rotateAt >= 0 && m >= rotateAt ? LIGHT_SHADE : VERY_HEAVY_FR }),
      activity: (m, prev) => {
        if (rotateAt < 0 && prev?.d.resume?.infeasibleNow === true && m >= 30) rotateAt = m
        return prev?.d.resume?.held === true || (rotateAt >= 0 && m >= rotateAt) ? 'rest' : null
      },
    })
    const inf = run.find((s) => s.d.resume?.infeasibleNow === true) as LoopStep
    expect(inf).toBeDefined()
    expect(inf.d.resume?.estRestMin).toBeNull()
    expect(ids(inf.a)).toContain('task_not_feasible_now')
    expect(inf.a.actions).toContain('rotate_task')
    expect(inf.a.actions).toContain('rest_shade_now')
    expect(inf.a.drivers.find((d) => d.id === 'task_not_feasible_now')?.text).toBe('Current task is too hot to resume now: a lighter or cooler task is needed')
    // Still infeasible after 25 min of cabin rest; the lighter task releases the hold at the next check (≤ 5 min).
    expect(run[29].d.resume?.infeasibleNow).toBe(true)
    expect(rotateAt).toBeGreaterThanOrEqual(30)
    const rel = run.find((s) => s.m >= rotateAt && s.d.resume?.held === false) as LoopStep
    expect(rel).toBeDefined()
    expect(rel.m - rotateAt).toBeLessThanOrEqual(5)
    expect(rel.d.resume?.taskId).toBe(LIGHT_SHADE.id)
  })

  it('resume task: ctx.resumeTask, else the current task, else the last task seen this shift', () => {
    const run = loop(heat, HEAVY_FR, 60) // no resumeTask in the context
    const held = run.find((s) => s.d.resume?.held === true && !s.working) as LoopStep
    expect(held.d.resume?.taskId).toBe(HEAVY_FR.id)
    expect(held.s.lastTask?.task.id).toBe(HEAVY_FR.id)
    expect(held.s.lastTask?.location).toBe('sun')
    // A lighter assignment passed as resumeTask is checked instead (at the next projection cycle) and passes.
    let s = held.s
    let res: WorkerStepResult | null = null
    for (let k = 1; k <= 5; k++) {
      res = stepWorkerEngine(s, { now: held.a.t + k * MIN, profile: REF, task: null, location: 'indoor_cool', heat, network: 'online', restArea: 'cooled_cabin', resumeTask: LIGHT_SHADE })
      s = res.state
      if (res.detail.resume?.held === false) break
    }
    expect(res?.detail.resume?.held).toBe(false)
    expect(res?.detail.resume?.taskId).toBe(LIGHT_SHADE.id)
    // A new shift clears the hold and the last task.
    const tomorrow = stepWorkerEngine(held.s, { now: held.a.t + 12 * 60 * MIN, profile: REF, task: null, location: 'shade', heat, network: 'online' })
    expect(tomorrow.state.projectionHold).toBeNull()
    expect(tomorrow.state.lastTask).toBeNull()
  })

  it('new projection texts are supervisor-safe; water figures stay in the worker-only hydration channel', () => {
    const run = [...loop(heat, HEAVY_FR, 120, { extra: resumeToWeld }), ...loop(heatFrom({ t: T0, taC: 46, rhPct: 35, ghiWm2: 1000 }), VERY_HEAVY_FR, 20)]
    const seen = new Set<string>()
    for (const s of run) {
      for (const d of s.a.drivers) {
        if (['phs_resume_hold', 'task_not_feasible_now', 'phs_work_bout'].includes(d.id)) {
          seen.add(d.id)
          expect(d.channel).toBe('projection')
          expect(d.text).not.toMatch(CLINICAL_TEXT_PATTERN)
        }
      }
    }
    expect([...seen].sort()).toEqual(['phs_resume_hold', 'phs_work_bout', 'task_not_feasible_now'])
    for (const id of ['phs_water_credit', 'phs_drink_to_restart', 'phs_resume_hold', 'task_not_feasible_now', 'phs_work_bout', 'work_rest_planned']) expect(RISK_DRIVER_IDS).toContain(id)
  })
})

describe('day-plan cap (WorkerContext.plannedWorkMinPerHour)', () => {
  const now = epochFromLocal('2025-11-26T09:00')
  const heat = heatFrom({ t: now, taC: 33, rhPct: 45, ghiWm2: 750 })

  it('caps workMinPerHour at the planned value (never raises it), with shade_breaks and an info driver', () => {
    const own = stepWorkerEngine(createWorkerEngine(REF, now), ctx(REF, now, MODERATE_SUN, 'sun', heat, { restArea: 'cooled_cabin' }))
    expect(own.assessment.workMinPerHour).toBeGreaterThan(20)
    const capped = stepWorkerEngine(createWorkerEngine(REF, now), ctx(REF, now, MODERATE_SUN, 'sun', heat, { restArea: 'cooled_cabin', plannedWorkMinPerHour: 20 }))
    expect(capped.assessment.workMinPerHour).toBe(20)
    expect(capped.detail.plannedCapApplied).toBe(true)
    expect(capped.assessment.actions).toContain('shade_breaks')
    const d = capped.assessment.drivers.find((x) => x.id === 'work_rest_planned')
    expect(d?.channel).toBe('environment')
    expect(d?.text).not.toMatch(CLINICAL_TEXT_PATTERN)
    const above = stepWorkerEngine(createWorkerEngine(REF, now), ctx(REF, now, MODERATE_SUN, 'sun', heat, { restArea: 'cooled_cabin', plannedWorkMinPerHour: 60 }))
    expect(above.assessment.workMinPerHour).toBe(own.assessment.workMinPerHour)
    expect(above.detail.plannedCapApplied).toBe(false)
    expect(capped.assessment.level).toBe(own.assessment.level) // the cap changes work minutes, not the level
  })
})

describe('performance memo (cooled-cabin TWL)', () => {
  it('equals computeTwl at the pressure rounded to whole Pa, within 0.001 W/m² of the unrounded value, and is cached', () => {
    const exact = (pKpa: number) => computeTwl({ tdbC: COOLED_REST.taC, rhPct: COOLED_REST.rhPct, mrtC: COOLED_REST.trC, windMs: COOLED_REST.vMs, pKpa }).twlWm2
    for (const pHpa of [1013.25, 1008.4, 1015.0049, 1001.99951, 995.5]) {
      const v = cooledCabinTwlWm2(pHpa)
      expect(v).toBe(exact(Math.round((pHpa / 10) * 1000) / 1000))
      expect(Math.abs(v - exact(pHpa / 10))).toBeLessThan(1e-3)
      expect(cooledCabinTwlWm2(pHpa)).toBe(v)
    }
    expect(cooledCabinTwlWm2(undefined)).toBe(exact(101.325))
    expect(cooledCabinTwlWm2(Number.NaN)).toBe(exact(101.325))
  })
})
