import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ClothingId, ConsentState, Crew, RiskFlagId, Site, Task, WorkClass, WorkerProfile } from './types'
import { HOUR_MS, MINUTE_MS, epochFromLocal, hhmmToMinutes } from './time'
import { FLUID_MAX_ML_PER_HOUR, HYDRATION, allowedWorkFraction, assessAcclimatization, clothingAdjustmentC, taskMetabolicW } from './limits'
import { QATAR_RULE_PACK, middayBreakWindow, twlWorkCategory, twlZone } from './regulation'
import type { RulePack } from './regulation'
import { conservativeMode } from './clinical'
import { wbgtComponents } from './wbgt'
import { computeTwl } from './twl'
import { parseDemoDays } from '../data/weather'
import { getSite } from '../data/sites'
import { computeSiteHeat } from './indices'
import type { SiteHeat } from './indices'
import { createWorkerEngine, stepWorkerEngine } from './risk'
import type { WorkerContext } from './risk'
import { CLINICAL_TEXT_PATTERN } from './alerts'
import { PHS_SCREEN, STOP_BAND_WORK_FRACTION, planDay, suggestShiftStart } from './planner'
import type { DayPlan, PlanDayInput, PlannerHour } from './planner'

// ─────────────────────────────── Real days (heat via the data parsers, wbgt.ts and twl.ts — not indices.ts) ───────────────────────────────

const DATA = new URL('../../public/data/', import.meta.url)
const DEMO = parseDemoDays(JSON.parse(readFileSync(new URL('weather/demo-days.json', DATA), 'utf8')))

/** Hourly WBGT (Liljegren, sun and engineered shade) and TWL (sun and shade MRT) for a cached demo day. */
function realDay(id: string): { site: Site; date: string; hourly: PlannerHour[] } {
  const day = DEMO.find((d) => d.id === id)
  if (!day) throw new Error(`demo day ${id} missing`)
  const site = getSite(day.siteId)
  const hourly = day.analysis.samples.map((s) => {
    const w = wbgtComponents({ ...s, radiantBoostC: site.radiantBoostC }, site.lat, site.lon)
    const base = { tdbC: w.taC, windMs: w.wind2Ms, pKpa: w.pHpa / 10, rhPct: w.rhPct }
    return {
      t: s.t,
      wbgtC: w.wbgtC,
      wbgtShadeC: w.wbgtShadeC,
      twlWm2: computeTwl({ ...base, mrtC: w.mrtC }).twlWm2,
      twlShadeWm2: computeTwl({ ...base, mrtC: w.mrtShadeC }).twlWm2,
    }
  })
  return { site, date: day.date, hourly }
}

const HOT = realDay('musaffah_2025-08-01')
const MILD = realDay('musaffah_2025-11-26')
const SITE = getSite('musaffah')

// ─────────────────────────────── Builders and checks ───────────────────────────────

const CONSENT: ConsentState = { wearable: false, healthFlags: false, checkins: true, shareWithMedicOnEscalation: false, aggregateStatistics: true, updatedAt: 0 }

function worker(id: string, crewId: string, over: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id,
    displayName: id,
    crewId,
    siteId: 'musaffah',
    language: 'en',
    massKg: 72,
    heightCm: 172,
    daysOnSite: 400,
    daysAwayRecent: 0,
    experiencedInHeat: true,
    clothing: 'cloth_coveralls',
    riskFlags: [],
    consent: CONSENT,
    hasWearable: false,
    ...over,
  }
}

const crewOf = (id: string, workerIds: string[], tasks: Task[]): Crew => ({ id, siteId: 'musaffah', name: id, supervisorName: 'S', workerIds, tasks })

const POUR: Task = { id: 'pour', name: 'Concrete pour', workClass: 'heavy', inSun: true, durationMin: 180, flexible: true, earliestStart: '04:30', latestEnd: '10:30' }
const MATERIAL: Task = { id: 'mh', name: 'Material handling', workClass: 'heavy', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '17:30' }
const FINISHING: Task = { id: 'fin', name: 'Blockwork and plastering', workClass: 'moderate', inSun: false, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '18:00' }

const POUR_WORKERS = ['P1', 'P2', 'P3', 'P4'].map((id) => worker(id, 'pour-crew'))
// Listed order puts the pour last, so the naive plan pours late.
const POUR_CREW = crewOf('pour-crew', POUR_WORKERS.map((w) => w.id), [MATERIAL, FINISHING, POUR])

function input(day: { site: Site; date: string; hourly: PlannerHour[] }, over: Partial<PlanDayInput> = {}): PlanDayInput {
  return { date: day.date, site: day.site, crews: [POUR_CREW], workers: POUR_WORKERS, hourly: day.hourly, shift: { start: '05:00', end: '17:00' }, ...over }
}

const local = (date: string, hhmm: string): number => epochFromLocal(`${date}T${hhmm}`)

/** Flat synthetic day: constant conditions, so expectations are exact. */
function flatDay(date: string, wbgtC: number, wbgtShadeC: number, twlWm2: number, twlShadeWm2 = twlWm2 + 40): PlannerHour[] {
  return Array.from({ length: 24 }, (_, h) => ({ t: local(date, `${String(h).padStart(2, '0')}:00`), wbgtC, wbgtShadeC, twlWm2, twlShadeWm2 }))
}

function assertNoSunWorkInBreak(plan: DayPlan, window: { startT: number; endT: number } | null): void {
  if (window === null) return
  for (const c of plan.crews) {
    for (const b of c.blocks) {
      if (b.location === 'sun' && b.taskId !== null) expect(b.endT <= window.startT || b.startT >= window.endT, `${c.crewId} ${b.taskId} ${b.start}–${b.end}`).toBe(true)
    }
  }
}

/**
 * Every block-hour: work ≤ the NIOSH/ACGIH allowed fraction recomputed with limits.allowedWorkFraction, ≤ the rule
 * pack's zone cycle (regulation.twlZone), never in the stop band, whole 5-min steps; required rest kept.
 */
function assertWorkWithinAllowance(plan: DayPlan, crews: readonly Crew[], workers: readonly WorkerProfile[], pack?: RulePack): number {
  const byId = new Map(workers.map((w) => [w.id, w]))
  let checked = 0
  for (const cp of plan.crews) {
    const crew = crews.find((c) => c.id === cp.crewId)!
    const masses = crew.workerIds.map((id) => byId.get(id)?.massKg)
    for (const b of cp.blocks) {
      if (b.taskId === null) {
        expect(b.workMin).toBe(0)
        continue
      }
      const task = crew.tasks.find((t) => t.id === b.taskId)!
      const workW = masses.length === 0 ? taskMetabolicW(task) : Math.max(...masses.map((m) => taskMetabolicW(task, m)))
      const wallMin = (b.endT - b.startT) / MINUTE_MS
      expect(b.restMin).toBeGreaterThanOrEqual(((60 - b.workMinPerHour) * wallMin) / 60 - 0.01)
      for (const h of b.hours) {
        const f = allowedWorkFraction({ workW, wbgtWorkEffC: h.wbgtWorkEffC, wbgtRestEffC: h.wbgtRestEffC, limit: cp.binding.limit })
        expect(Math.abs(f.workMinPerHour - h.nioshWorkMinPerHour)).toBeLessThan(1e-9)
        expect(h.workMin).toBeLessThanOrEqual((f.workMinPerHour * h.wallMin) / 60 + 0.01)
        expect(h.workMin).toBeLessThanOrEqual((h.allowedWorkMinPerHour * h.wallMin) / 60 + 0.01)
        expect(h.allowedWorkMinPerHour).toBeLessThanOrEqual(h.nioshWorkMinPerHour + 1e-9)
        expect(h.allowedWorkMinPerHour).toBeLessThanOrEqual(h.packWorkMinPerHour)
        expect(h.allowedWorkMinPerHour % 5).toBe(0)
        expect(h.allowedWorkMinPerHour).toBeGreaterThanOrEqual(60 * STOP_BAND_WORK_FRACTION)
        const zone = twlZone(h.twlWm2, pack)
        if (zone) expect(h.packWorkMinPerHour).toBeLessThanOrEqual(zone.workRest[twlWorkCategory(task.workClass)].workMinPerHour)
        checked += 1
      }
    }
  }
  return checked
}

// ─────────────────────────────── Real hot day: musaffah 2025-08-01 ───────────────────────────────

describe('musaffah 2025-08-01 (peak WBGT day, real hours)', () => {
  const window = middayBreakWindow(local(HOT.date, '12:00'))

  it('hour outlook follows the real day: Medium zone at dawn, High from 07:00, midday break flagged', () => {
    const plan = planDay(input(HOT))
    expect(plan.hours.map((h) => h.hour)).toEqual(['05:00', '06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'])
    expect(plan.hours[0].zone).toBe('medium')
    for (const h of plan.hours.slice(2)) expect(h.zone).toBe('high')
    expect(plan.hours.filter((h) => h.middayBreak).map((h) => h.hour)).toEqual(['12:00', '13:00', '14:00'])
    for (const h of plan.hours) {
      // Hour WBGT = time average of the interpolated series → between the hour's endpoint values.
      const ends = HOT.hourly.filter((x) => x.t === h.t || x.t === h.t + HOUR_MS).map((x) => x.wbgtC)
      expect(h.wbgtC).toBeGreaterThanOrEqual(Math.min(...ends) - 0.01)
      expect(h.wbgtC).toBeLessThanOrEqual(Math.max(...ends) + 0.01)
      expect(h.forecastFallback).toBe(false)
    }
    expect(plan.basis.join(' ')).toMatch(/NIOSH/)
    expect(plan.basis.join(' ')).toMatch(/44 of 2022/)
  })

  it('site default (musaffah has a cooled cabin) plans the same as an explicit 25 °C cabin', () => {
    expect(HOT.site.restArea).toBe('cooled_cabin')
    const byDefault = planDay(input(HOT))
    const explicit = planDay(input(HOT, { restAreaWbgtC: 25 }))
    expect(byDefault.crews[0].workMin).toBe(explicit.crews[0].workMin)
    expect(byDefault.crews[0].workMin).toBeGreaterThan(0)
  })

  it('rest in shade only (no cooled cabin): heavy and moderate work stay below the stop band all day — deferred, best window early morning', () => {
    const plan = planDay(input({ ...HOT, site: { ...HOT.site, restArea: 'shade' } }))
    const crew = plan.crews[0]
    expect(crew.binding.limit).toBe('REL')
    expect(crew.workMin).toBe(0)
    expect(crew.blocks.every((b) => b.taskId === null)).toBe(true)
    const pour = crew.unscheduled.find((u) => u.taskId === 'pour')!
    expect(pour.reason).toBe('deferred')
    expect(hhmmToMinutes(pour.bestHour ?? '23:00')).toBeLessThan(hhmmToMinutes('08:00'))
    expect(pour.bestWorkMinPerHour).toBeGreaterThan(0)
    expect(pour.bestWorkMinPerHour).toBeLessThan(60 * STOP_BAND_WORK_FRACTION)
    expect(plan.warnings.some((w) => w.code === 'task_deferred' && w.taskId === 'pour')).toBe(true)
    expect(plan.warnings.some((w) => w.code === 'rest_exceeds_limit')).toBe(true)
    // The naive plan pours at 11:00 and after the break, in WBGT ≈ 40 °C.
    const naivePour = crew.naive.blocks.filter((b) => b.taskId === 'pour')
    expect(naivePour.map((b) => b.start)).toEqual(['11:00', '15:00'])
    expect(crew.naive.exposureCMin).toBeGreaterThan(1000)
    expect(plan.totals.exposureReduction).toBe(plan.totals.exposureNaiveCMin)
    expect(plan.totals.lostWorkMinVsNaive).toBe(540)
    expect(plan.crews[0].blocks.some((b) => b.notes.join(' ').includes('Midday break'))).toBe(true)
    assertNoSunWorkInBreak(plan, window)
    expect(crew.waterL).toBeGreaterThan(0)
  })

  // [ASSUMPTION] An air-conditioned rest cabin at WBGT 25 °C (ADOSH-SF CoP 11.0 v4.0 §3.2(c), §3.2(i)).
  const COOLED = input(HOT, { restAreaWbgtC: 25 })

  it('with a cooled rest area: the heavy flexible concrete pour moves to the early morning', () => {
    const plan = planDay(COOLED)
    const crew = plan.crews[0]
    const pourBlocks = crew.blocks.filter((b) => b.taskId === 'pour')
    expect(pourBlocks.length).toBeGreaterThan(0)
    expect(pourBlocks[0].start).toBe('05:00')
    for (const b of pourBlocks) expect(b.endT).toBeLessThanOrEqual(local(HOT.date, '10:30'))
    const naivePour = crew.naive.blocks.find((b) => b.taskId === 'pour')!
    expect(hhmmToMinutes(pourBlocks[0].start)).toBeLessThan(hhmmToMinutes(naivePour.start))
    const early = pourBlocks.filter((b) => b.endT <= local(HOT.date, '07:00')).reduce((s, b) => s + b.workMin, 0)
    const late = pourBlocks.filter((b) => b.startT >= local(HOT.date, '09:00')).reduce((s, b) => s + b.workMin, 0)
    expect(early).toBeGreaterThan(late)
  })

  it('with a cooled rest area: nothing outdoor-in-sun in 12:30–15:00; work never exceeds the allowed fraction', () => {
    const plan = planDay(COOLED)
    expect(window).toEqual({ startT: local(HOT.date, '12:30'), endT: local(HOT.date, '15:00') })
    assertNoSunWorkInBreak(plan, window)
    expect(assertWorkWithinAllowance(plan, [POUR_CREW], POUR_WORKERS)).toBeGreaterThan(5)
    for (const b of plan.crews[0].blocks) for (const h of b.hours) expect(h.wbgtRestEffC).toBe(25)
    expect(plan.totals.exposureReduction).toBeGreaterThan(0)
    expect(plan.totals.exposurePlanCMin).toBeLessThan(plan.totals.exposureNaiveCMin)
    expect(plan.totals.lostWorkMinVsNaive).toBeGreaterThan(0) // protection before productivity
  })

  it('suggestShiftStart ranks the 05:00 start first', () => {
    const options = suggestShiftStart(COOLED)
    expect(options).toHaveLength(3)
    expect(options[0]).toMatchObject({ rank: 1, start: '05:00', end: '17:00' })
    expect(options[0].totals.workMin).toBeGreaterThanOrEqual(Math.max(...options.map((o) => o.totals.workMin)) * 0.95)
    expect(suggestShiftStart(COOLED, ['05:00', '13:00']).map((o) => o.start)).toEqual(['05:00']) // 13:00 + 12 h crosses midnight
  })
})

// ─────────────────────────────── Real mild day: musaffah 2025-11-26 ───────────────────────────────

describe('musaffah 2025-11-26 (mild November day, real hours)', () => {
  it('changes little: all work done, no lost work, near-continuous work allowed, no midday break', () => {
    const plan = planDay(input(MILD))
    const crew = plan.crews[0]
    expect(crew.unscheduled).toEqual([])
    expect(plan.totals.workMin).toBe(540)
    expect(Math.abs(plan.totals.lostWorkMinVsNaive)).toBeLessThanOrEqual(0.05 * plan.totals.naiveWorkMin)
    expect(plan.hours.every((h) => !h.middayBreak && h.zone === 'low')).toBe(true)
    for (const h of plan.hours) expect(h.allowedWorkMinPerHour.heavy).toBeGreaterThanOrEqual(45)
    const taskWall = crew.blocks.filter((b) => b.taskId !== null).reduce((s, b) => s + (b.endT - b.startT), 0)
    const continuous = crew.blocks.filter((b) => b.taskId !== null && b.workMinPerHour === 60).reduce((s, b) => s + (b.endT - b.startT), 0)
    expect(continuous / taskWall).toBeGreaterThan(0.8)
    expect(plan.warnings.filter((w) => w.code === 'task_deferred' || w.code === 'task_incomplete')).toEqual([])
    assertWorkWithinAllowance(plan, [POUR_CREW], POUR_WORKERS)
    expect(crew.blocks[0].taskId).toBe('pour') // still the coolest hours first (ties → earlier)
    expect(plan.totals.exposurePlanCMin).toBeLessThanOrEqual(plan.totals.exposureNaiveCMin)
  })
})

// ─────────────────────────────── Rules ───────────────────────────────

describe('binding worker, cycles and flags', () => {
  it('RAL when any member is unacclimatised; the worst clothing CAV and the hood add to WBGT_eff', () => {
    const members = [worker('A1', 'c'), worker('A2', 'c', { clothing: 'double_layer' }), worker('A3', 'c', { daysOnSite: 2, experiencedInHeat: false })]
    const welding: Task = { id: 'weld', name: 'Welding', workClass: 'heavy', inSun: false, hood: true, durationMin: 60, flexible: true }
    const crew = crewOf('c', members.map((m) => m.id), [welding])
    const plan = planDay({ date: '2025-11-26', site: SITE, crews: [crew], workers: members, hourly: flatDay('2025-11-26', 18, 18, 300, 300), shift: { start: '06:00', end: '14:00' } })
    const cp = plan.crews[0]
    expect(cp.binding.limit).toBe('RAL')
    expect(cp.binding.nonAcclimatizedMemberIds).toEqual(['A3'])
    expect(cp.binding.text).not.toMatch(/A3|flag|medic/i)
    const h = cp.blocks.find((b) => b.taskId === 'weld')!.hours[0]
    expect(h.wbgtWorkEffC).toBeCloseTo(18 + clothingAdjustmentC('double_layer', true), 9)
    expect(plan.warnings.some((w) => w.code === 'acclimatization_ramp' && w.workerIds?.[0] === 'A3')).toBe(true)
  })

  it('conservative mode (a declared flag) → RAL and the next-stricter tier, without naming the flag', () => {
    const crew = crewOf('c', ['B1', 'B2'], [MATERIAL])
    const day = flatDay('2025-07-20', 26, 25, 130) // ADOSH Medium: heavy 45/15; next-stricter (High): heavy 20/40
    const rel = planDay({ date: '2025-07-20', site: SITE, crews: [crew], workers: [worker('B1', 'c'), worker('B2', 'c')], hourly: day, shift: { start: '06:00', end: '12:00' } })
    expect(rel.crews[0].binding).toMatchObject({ limit: 'REL', stricterTier: false })
    for (const b of rel.crews[0].blocks) for (const h of b.hours) expect(h.packWorkMinPerHour).toBe(45)
    const flagged = [worker('B1', 'c', { riskFlags: ['heat_sensitive_medication'] as RiskFlagId[], consent: { ...CONSENT, healthFlags: true } }), worker('B2', 'c')]
    expect(conservativeMode(flagged[0]).conservative).toBe(true)
    const ral = planDay({ date: '2025-07-20', site: SITE, crews: [crew], workers: flagged, hourly: day, shift: { start: '06:00', end: '12:00' } })
    expect(ral.crews[0].binding).toMatchObject({ limit: 'RAL', conservative: true, stricterTier: true })
    for (const b of ral.crews[0].blocks) for (const h of b.hours) expect(h.packWorkMinPerHour).toBe(20)
    expect(JSON.stringify(ral)).not.toMatch(/medication|heat_sensitive/)
  })

  it('stricter wins: the ADOSH High-zone heavy cycle (20/40) caps a generous NIOSH allowance', () => {
    const crew = crewOf('c', ['C1'], [MATERIAL])
    const plan = planDay({ date: '2025-11-20', site: SITE, crews: [crew], workers: [worker('C1', 'c')], hourly: flatDay('2025-11-20', 20, 20, 100, 140), shift: { start: '06:00', end: '12:00' } })
    const b = plan.crews[0].blocks.find((x) => x.taskId === 'mh')!
    expect(b.workMinPerHour).toBe(20)
    expect(b.rest.source).toBe('rule_pack')
    expect(b.hours[0].nioshWorkMinPerHour).toBe(60)
    expect(b.workMin).toBe(120)
    expect(b.end).toBe('12:00') // 120 work min at 20 min/h need the whole 6 h
  })

  it('flags unacclimatised members in Medium/High hours with a shaded-work reassignment hint', () => {
    const members = [worker('D1', 'c'), worker('D2', 'c', { daysOnSite: 1, experiencedInHeat: false })]
    const crew = crewOf('c', ['D1', 'D2'], [{ ...MATERIAL, workClass: 'light' }])
    const plan = planDay({ date: '2025-11-20', site: SITE, crews: [crew], workers: members, hourly: flatDay('2025-11-20', 18, 18, 125, 200), shift: { start: '06:00', end: '10:00' } })
    const w = plan.warnings.find((x) => x.code === 'unacclimatized_reassign')!
    expect(w.workerIds).toEqual(['D2'])
    expect(w.hours!.length).toBeGreaterThan(0)
    expect(plan.crews[0].blocks.find((b) => b.taskId === 'mh')!.notes.join(' ')).toMatch(/D2.*reassign to shaded light work/)
  })

  it('fixed tasks keep their start; a flexible task takes the earliest window that completes it', () => {
    const fixed: Task = { id: 'lash', name: 'Lashing', workClass: 'heavy', inSun: true, durationMin: 120, flexible: false, earliestStart: '07:00', latestEnd: '11:00' }
    const flex: Task = { id: 'insp', name: 'Inspection', workClass: 'light', inSun: true, durationMin: 60, flexible: true, earliestStart: '06:00', latestEnd: '12:00' }
    const crew = crewOf('c', ['E1'], [flex, fixed])
    const plan = planDay({ date: '2025-11-20', site: SITE, crews: [crew], workers: [worker('E1', 'c')], hourly: flatDay('2025-11-20', 18, 18, 300, 300), shift: { start: '06:00', end: '12:00' } })
    const blocks = plan.crews[0].blocks
    expect(blocks.find((b) => b.taskId === 'lash')).toMatchObject({ start: '07:00', end: '09:00' })
    expect(blocks.find((b) => b.taskId === 'insp')).toMatchObject({ start: '06:00', end: '07:00' })
    // The naive plan follows the listed order from the shift start.
    expect(plan.crews[0].naive.blocks.map((b) => `${b.taskId}@${b.start}`)).toEqual(['insp@06:00', 'lash@07:00'])
  })

  it('flexible work prefers the cooler hours of its window (maximal allowed work fraction)', () => {
    const date = '2025-09-20' // after the midday-break season
    // Warm until 15:00 (work allowed but with rest), cool from 16:00: the cool hours are not the earliest ones.
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const warm = h <= 15
      return { t: local(date, `${String(h).padStart(2, '0')}:00`), wbgtC: warm ? 28 : 22, wbgtShadeC: warm ? 26 : 21, twlWm2: warm ? 200 : 260, twlShadeWm2: 280 }
    })
    const task: Task = { id: 'kerb', name: 'Kerb laying', workClass: 'very_heavy', inSun: true, durationMin: 60, flexible: true, earliestStart: '06:00', latestEnd: '18:00' }
    const plan = planDay({ date, site: SITE, crews: [crewOf('c', ['F1'], [task])], workers: [worker('F1', 'c')], hourly, shift: { start: '06:00', end: '18:00' } })
    expect(plan.hours.find((h) => h.hour === '06:00')!.allowedWorkMinPerHour.very_heavy).toBeLessThan(60)
    expect(plan.hours.find((h) => h.hour === '16:00')!.allowedWorkMinPerHour.very_heavy).toBe(60)
    // The first hour allowing continuous work (15:00 averages 28 → 22 °C) — not the earliest hour of the window.
    const firstFull = plan.hours.find((h) => h.allowedWorkMinPerHour.very_heavy === 60)!.hour
    expect(hhmmToMinutes(firstFull)).toBeGreaterThanOrEqual(hhmmToMinutes('15:00'))
    const b = plan.crews[0].blocks.filter((x) => x.taskId === 'kerb')
    expect(b).toEqual([expect.objectContaining({ start: firstFull, workMinPerHour: 60, workMin: 60 })])
  })
})

describe('fail-safe inputs', () => {
  it('a forecast gap longer than 3 h takes the day’s worst values and warns', () => {
    const hourly = HOT.hourly.filter((h) => {
      const hh = new Date(h.t + 4 * HOUR_MS).getUTCHours()
      return hh < 8 || hh > 12
    })
    const plan = planDay(input({ ...HOT, hourly }, { restAreaWbgtC: 25 }))
    const fb = plan.hours.filter((h) => h.forecastFallback).map((h) => h.hour)
    // Entries at 07:00 and 13:00 bracket a 6-h gap: every hour with points strictly inside it falls back.
    expect(fb).toEqual(['07:00', '08:00', '09:00', '10:00', '11:00', '12:00'])
    const worst = Math.max(...hourly.map((h) => h.wbgtC))
    for (const h of plan.hours.filter((x) => x.forecastFallback)) expect(h.wbgtC).toBeCloseTo(worst, 2)
    expect(plan.warnings.find((w) => w.code === 'forecast_gap')?.hours).toEqual(fb)
  })

  it('no forecast → no plan; invalid shift → no plan; unknown worker → treated as unacclimatised (RAL)', () => {
    const none = planDay(input(HOT, { hourly: [] }))
    expect(none.crews).toEqual([])
    expect(none.warnings[0].code).toBe('no_forecast')
    const bad = planDay(input(HOT, { shift: { start: '17:00', end: '05:00' } }))
    expect(bad.crews).toEqual([])
    expect(bad.warnings[0].code).toBe('invalid_shift')
    const crew = crewOf('c', ['G1', 'GHOST'], [MATERIAL])
    const plan = planDay({ date: MILD.date, site: SITE, crews: [crew], workers: [worker('G1', 'c')], hourly: MILD.hourly, shift: { start: '06:00', end: '12:00' } })
    expect(plan.crews[0].binding).toMatchObject({ limit: 'RAL', unknownMemberIds: ['GHOST'] })
    expect(plan.warnings.some((w) => w.code === 'unknown_worker')).toBe(true)
  })
})

describe('water and rule packs', () => {
  it('water per block between the NIOSH cadence floor and the 1.42 L/h cap per worker; at least one cooler', () => {
    const plan = planDay(input(HOT, { restAreaWbgtC: 25 }))
    const n = POUR_CREW.workerIds.length
    for (const b of plan.crews[0].blocks) {
      const h = (b.endT - b.startT) / HOUR_MS
      expect(b.waterL).toBeLessThanOrEqual((FLUID_MAX_ML_PER_HOUR / 1000) * n * h + 0.01)
      expect(b.waterL).toBeGreaterThanOrEqual(HYDRATION.typicalLPerH[0] * n * h - 0.01)
    }
    // ADOSH High zone: all work > 1.2 L/h (regulatory minimum) → at least 1.2 L/h per worker in task blocks.
    for (const b of plan.crews[0].blocks.filter((x) => x.taskId !== null && x.hours.every((hh) => hh.zone === 'high'))) {
      expect(b.waterL).toBeGreaterThanOrEqual(1.2 * n * ((b.endT - b.startT) / HOUR_MS) - 0.01)
    }
    expect(plan.totals.coolersNeeded).toBeGreaterThanOrEqual(1)
    expect(plan.totals.waterL).toBeCloseTo(plan.crews[0].blocks.reduce((s, b) => s + b.waterL, 0), 0)
  })

  it('a different rule pack is configuration: Qatar bans sun work 10:00–15:30 (UTC+3) and stops above WBGT 32.1 °C', () => {
    const date = '2025-07-20'
    const hourly = Array.from({ length: 24 }, (_, h) => ({ t: local(date, `${String(h).padStart(2, '0')}:00`), wbgtC: h >= 15 && h < 17 ? 33 : 28, wbgtShadeC: 24, twlWm2: 200, twlShadeWm2: 240 }))
    const task: Task = { id: 'yard', name: 'Yard work', workClass: 'light', inSun: true, durationMin: 600, flexible: true }
    const crew = crewOf('q', ['Q1'], [task])
    const plan = planDay({ date, site: SITE, crews: [crew], workers: [worker('Q1', 'q')], hourly, shift: { start: '05:00', end: '20:00' }, pack: QATAR_RULE_PACK })
    expect(plan.packId).toBe('qatar')
    const window = middayBreakWindow(local(date, '12:00'), QATAR_RULE_PACK)!
    expect(window.startT).toBe(local(date, '11:00')) // 10:00 Qatar time = 11:00 Gulf Standard Time
    assertNoSunWorkInBreak(plan, window)
    for (const b of plan.crews[0].blocks.filter((x) => x.taskId === 'yard')) {
      for (const h of b.hours) expect(h.wbgtWorkEffC).toBeLessThanOrEqual(32.1)
    }
    assertWorkWithinAllowance(plan, [crew], [worker('Q1', 'q')], QATAR_RULE_PACK)
  })
})

// ─────────────────────────────── Property: never removes required rest ───────────────────────────────

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const CLOTHES: ClothingId[] = ['work_clothes', 'cloth_coveralls', 'fr_coveralls', 'sms_coveralls', 'polyolefin_coveralls', 'double_layer']
const CLASSES: WorkClass[] = ['light', 'moderate', 'heavy', 'very_heavy']
const FLAGS: RiskFlagId[] = ['prior_heat_illness', 'poor_sleep', 'fasting', 'oh_review_required']

function randomCase(seed: number): { input: PlanDayInput; crews: Crew[]; workers: WorkerProfile[] } {
  const r = seeded(seed)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]
  const hhmm = (min: number): string => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
  const date = r() < 0.7 ? '2025-07-20' : '2025-11-20'
  const base = 18 + r() * 14
  const amp = 2 + r() * 10
  const hourly: PlannerHour[] = []
  for (let h = 0; h < 24; h++) {
    if (r() < 0.06) continue // occasional missing hours
    const d = Math.max(0, Math.sin(((h - 6) / 12) * Math.PI))
    const wbgtC = base + amp * d + (r() - 0.5)
    const wbgtShadeC = wbgtC - r() * 4 * d
    const twlWm2 = Math.max(0, Math.min(380, 330 - (wbgtC - 18) * 14 + (r() - 0.5) * 30))
    hourly.push({ t: local(date, hhmm(h * 60)), wbgtC, wbgtShadeC, twlWm2, ...(r() < 0.8 ? { twlShadeWm2: twlWm2 + 20 + r() * 60 } : {}) })
  }
  const workers: WorkerProfile[] = []
  const crews: Crew[] = []
  const nCrews = 1 + Math.floor(r() * 3)
  for (let c = 0; c < nCrews; c++) {
    const crewId = `c${c}`
    const ids: string[] = []
    const nWorkers = 1 + Math.floor(r() * 6)
    for (let w = 0; w < nWorkers; w++) {
      const id = `${crewId}-w${w}`
      ids.push(id)
      if (r() < 0.05) continue // unknown member
      const flags = r() < 0.2 ? [pick(FLAGS)] : []
      workers.push(
        worker(id, crewId, {
          massKg: 55 + r() * 55,
          daysOnSite: r() < 0.25 ? 1 + Math.floor(r() * 14) : 30 + Math.floor(r() * 400),
          daysAwayRecent: r() < 0.1 ? Math.floor(r() * 30) : 0,
          experiencedInHeat: r() < 0.7,
          clothing: pick(CLOTHES),
          riskFlags: flags,
          consent: { ...CONSENT, healthFlags: flags.length > 0 },
        }),
      )
    }
    const tasks: Task[] = []
    const nTasks = 1 + Math.floor(r() * 5)
    for (let k = 0; k < nTasks; k++) {
      const es = r() < 0.6 ? 240 + Math.floor(r() * 20) * 30 : undefined
      const le = es !== undefined && r() < 0.8 ? Math.min(23 * 60, es + 120 + Math.floor(r() * 16) * 30) : undefined
      tasks.push({
        id: `${crewId}-t${k}`,
        name: `Task ${k}`,
        workClass: pick(CLASSES),
        inSun: r() < 0.7,
        durationMin: 30 + Math.floor(r() * 18) * 15,
        flexible: r() < 0.7,
        ...(es !== undefined ? { earliestStart: hhmm(es) } : {}),
        ...(le !== undefined ? { latestEnd: hhmm(le) } : {}),
        ...(r() < 0.2 ? { clothing: pick(CLOTHES) } : {}),
        ...(r() < 0.1 ? { hood: true } : {}),
      })
    }
    crews.push(crewOf(crewId, ids, tasks))
  }
  const start = 240 + Math.floor(r() * 9) * 30
  const len = 360 + Math.floor(r() * 13) * 30
  const shift = { start: hhmm(start), end: hhmm(start + len) }
  return {
    input: { date, site: SITE, crews, workers, hourly, shift, ...(r() < 0.3 ? { restAreaWbgtC: 20 + r() * 8 } : {}), ...(r() < 0.3 ? { minBlockMin: pick([0, 15, 45]) } : {}) },
    crews,
    workers,
  }
}

describe('property: the plan never removes required rest', () => {
  it('holds for 150 random days, crews and tasks', () => {
    let checked = 0
    let scheduledBlocks = 0
    for (let seed = 1; seed <= 150; seed++) {
      const { input: inp, crews, workers } = randomCase(seed)
      const plan = planDay(inp)
      const window = middayBreakWindow(local(inp.date, '12:00'))
      assertNoSunWorkInBreak(plan, window)
      checked += assertWorkWithinAllowance(plan, crews, workers)
      const byId = new Map(workers.map((w) => [w.id, w]))
      const shiftStart = local(inp.date, inp.shift.start)
      const shiftEnd = local(inp.date, inp.shift.end)
      let workSum = 0
      for (const cp of plan.crews) {
        const crew = crews.find((c) => c.id === cp.crewId)!
        // Blocks are ordered, contiguous and cover the shift.
        expect(cp.blocks[0].startT).toBe(shiftStart)
        expect(cp.blocks[cp.blocks.length - 1].endT).toBe(shiftEnd)
        for (let i = 1; i < cp.blocks.length; i++) expect(cp.blocks[i].startT).toBe(cp.blocks[i - 1].endT)
        // Binding limit, recomputed independently.
        const needsRal = crew.workerIds.some((id) => {
          const p = byId.get(id)
          return !p || assessAcclimatization(p).status !== 'acclimatized' || conservativeMode(p).conservative
        })
        expect(cp.binding.limit).toBe(needsRal ? 'RAL' : 'REL')
        for (const t of crew.tasks) {
          const bs = cp.blocks.filter((b) => b.taskId === t.id)
          const done = bs.reduce((s, b) => s + b.workMin, 0)
          expect(done).toBeLessThanOrEqual(t.durationMin + 0.05)
          if (t.earliestStart) for (const b of bs) expect(b.startT).toBeGreaterThanOrEqual(local(inp.date, t.earliestStart))
          if (t.flexible && t.latestEnd) for (const b of bs) expect(b.endT).toBeLessThanOrEqual(local(inp.date, t.latestEnd))
          scheduledBlocks += bs.length
        }
        workSum += cp.workMin
      }
      expect(Math.abs(workSum - plan.totals.workMin)).toBeLessThan(0.5)
    }
    expect(checked).toBeGreaterThan(200)
    expect(scheduledBlocks).toBeGreaterThan(100)
  })
})

// ─────────────────────────────── Wave 2c: ISO 7933 screen (plan and monitor agree) ───────────────────────────────

describe('ISO 7933 screen of the planned day (PHS_SCREEN)', () => {
  const DATE = '2025-11-26'
  const REF_W = worker('R1', 'ref-crew', { massKg: 75, heightCm: 175, daysOnSite: 30 })
  const WELD_FR: Task = { id: 'weld', name: 'FR welding', workClass: 'heavy', inSun: true, clothing: 'fr_coveralls', durationMin: 480, flexible: true }
  const REF_CREW = crewOf('ref-crew', [REF_W.id], [WELD_FR])
  const COOLED_SITE: Site = { ...SITE, radiantBoostC: 0, restArea: 'cooled_cabin' }
  const heatOf = (taC: number, rhPct: number, ghiWm2: number, site: Site = COOLED_SITE): SiteHeat =>
    computeSiteHeat({ t: local(DATE, '10:00'), taC, rhPct, pHpa: 1010, wind10Ms: 2, ghiWm2, radiationWindowMin: 0, radiantBoostC: 0, source: 'archive' }, site)
  const constantDay = (heat: SiteHeat, withClimate = true): PlannerHour[] =>
    Array.from({ length: 24 }, (_, h) => ({
      t: local(DATE, `${String(h).padStart(2, '0')}:00`),
      wbgtC: heat.wbgtC,
      wbgtShadeC: heat.wbgtShadeC,
      twlWm2: heat.twlWm2,
      twlShadeWm2: heat.twlShadeWm2,
      ...(withClimate ? { climate: heat } : {}),
    }))
  const planFor = (heat: SiteHeat, site: Site = COOLED_SITE, crew: Crew = REF_CREW, workers: WorkerProfile[] = [REF_W], withClimate = true): DayPlan =>
    planDay({ date: DATE, site, crews: [crew], workers, hourly: constantDay(heat, withClimate), shift: { start: '06:00', end: '14:00' } })

  /**
   * Follows the crew plan minute by minute with createWorkerEngine / stepWorkerEngine: in each block-hour the first
   * boutMin minutes are work at the task's location, the rest is rest in the site's rest area ('unscreened': work the
   * NIOSH/rule-pack allowance instead). Returns the projection-stop and hold minutes and the least minutes at work.
   */
  function follow(plan: DayPlan, site: Site, heat: SiteHeat, unscreened = false): { stops: number; held: number; minAtWork: number; workMin: number } {
    const cp = plan.crews[0]
    const start = local(DATE, '06:00')
    let state = createWorkerEngine(REF_W, start)
    let stops = 0
    let held = 0
    let minAtWork = Infinity
    let workMin = 0
    for (let t = start; t < local(DATE, '14:00'); t += MINUTE_MS) {
      const b = cp.blocks.find((x) => t >= x.startT && t < x.endT) as DayPlan['crews'][number]['blocks'][number]
      const task = b.taskId === null ? null : (REF_CREW.tasks.find((x) => x.id === b.taskId) as Task)
      let work = false
      if (task) {
        const bh = b.hours.find((h) => t >= h.startT && t < h.startT + h.wallMin * MINUTE_MS) as DayPlan['crews'][number]['blocks'][number]['hours'][number]
        const bout = unscreened ? Math.ceil((bh.allowedWorkMinPerHour * bh.wallMin) / 60) : bh.boutMin
        work = t - bh.startT < bout * MINUTE_MS
      }
      const ctx: WorkerContext = {
        now: t,
        profile: REF_W,
        task: work ? task : null,
        location: work ? 'sun' : site.restArea === 'cooled_cabin' ? 'indoor_cool' : 'shade',
        heat,
        network: 'online',
        restArea: site.restArea,
        resumeTask: task ?? WELD_FR,
        ...(task ? { plannedWorkMinPerHour: b.workMinPerHour } : {}),
      }
      const r = stepWorkerEngine(state, ctx)
      state = r.state
      if (r.assessment.channels.find((c) => c.channel === 'projection')?.level === 'stop') stops += 1
      if (r.detail.resume?.held) held += 1
      if (work) {
        workMin += 1
        if (r.assessment.minutesToLimit !== null) minAtWork = Math.min(minAtWork, r.assessment.minutesToLimit)
      }
    }
    return { stops, held, minAtWork, workMin }
  }

  it('following the plan exactly at constant conditions never triggers a projection stop for the reference worker', () => {
    for (const [site, heat] of [
      [COOLED_SITE, heatOf(38, 35, 800)],
      [COOLED_SITE, heatOf(33, 40, 750)],
      [{ ...COOLED_SITE, restArea: 'shade' as const }, heatOf(32, 45, 700, { ...COOLED_SITE, restArea: 'shade' })],
    ] as const) {
      const plan = planFor(heat, site)
      const cp = plan.crews[0]
      expect(cp.phsScreen).not.toBeNull()
      const bhs = cp.blocks.flatMap((b) => b.hours)
      expect(bhs.some((h) => h.limitedBy === 'phs')).toBe(true) // the screen binds: the case is not trivial
      const f = follow(plan, site, heat)
      expect(f.workMin).toBeGreaterThan(0)
      expect(f.stops).toBe(0)
      expect(f.held).toBe(0)
      expect(f.minAtWork).toBeGreaterThanOrEqual(PHS_SCREEN.highFromMin)
      // Working the unscreened NIOSH/rule-pack allowance instead does trigger projection stops (plan and monitor disagree).
      expect(follow(plan, site, heat, true).stops).toBeGreaterThan(0)
    }
  })

  it('records phsWorkMin and limitedBy per task-hour; rates are 0 or ≥ minBoutMin; blocks and totals reflect W′', () => {
    const plan = planFor(heatOf(38, 35, 800))
    const cp = plan.crews[0]
    const scr = cp.phsScreen as NonNullable<typeof cp.phsScreen>
    expect(scr.reference).toEqual({ massKg: 75, heightCm: 175, acclimatized: true })
    expect(scr.passes).toBeGreaterThanOrEqual(1)
    expect(scr.passes).toBeLessThanOrEqual(PHS_SCREEN.maxPasses)
    let work = 0
    for (const b of cp.blocks) {
      work += b.workMin
      if (b.taskId === null) continue
      expect(b.workMinPerHour === 0 || b.workMinPerHour >= PHS_SCREEN.minBoutMin).toBe(true)
      for (const h of b.hours) {
        expect(h.phsWorkMinPerHour).not.toBeNull()
        expect(b.workMinPerHour).toBe(Math.min(h.allowedWorkMinPerHour, h.phsWorkMinPerHour as number))
        expect(h.boutMin).toBe(Math.ceil(h.workMin - 1e-6))
        expect(h.limitedBy).toBe((h.phsWorkMinPerHour as number) < h.allowedWorkMinPerHour ? 'phs' : h.allowedWorkMinPerHour >= 60 ? 'none' : 'niosh_acgih')
        const cell = scr.hours.find((x) => x.hour === h.hour)?.byTask.weld
        expect(cell).toEqual({ allowedMin: h.allowedWorkMinPerHour, phsWorkMin: h.phsWorkMinPerHour, workMin: b.workMinPerHour, limitedBy: h.limitedBy })
      }
      if (b.rest.source === 'phs') expect(b.rest.text).toMatch(/ISO 7933 heat-strain screen/)
    }
    expect(Math.abs(work - cp.workMin)).toBeLessThan(0.1)
    expect(plan.totals.workMin).toBe(cp.workMin)
    expect(cp.workMin).toBeLessThan(cp.allowance.reduce((s, h) => s + h.byTask.weld, 0)) // W′ lowered the day's work
  })

  it('warns phs_not_feasible with mitigation hints; without climate the screen is not run (phs_screen_unavailable)', () => {
    const plan = planFor(heatOf(30, 50, 700))
    const w = plan.warnings.find((x) => x.code === 'phs_not_feasible')
    expect(w?.taskId).toBe('weld')
    expect(w?.hours?.length).toBeGreaterThan(0)
    expect(w?.text).toMatch(/lighter task or rotation/)
    expect(w?.text).toMatch(/cooling garment/)
    expect(w?.text).toMatch(/cooler hour/)
    expect(w?.text).not.toMatch(CLINICAL_TEXT_PATTERN)
    const none = planFor(heatOf(38, 35, 800), COOLED_SITE, REF_CREW, [REF_W], false)
    expect(none.warnings.some((x) => x.code === 'phs_screen_unavailable')).toBe(true)
    expect(none.crews[0].phsScreen).toBeNull()
    expect(none.crews[0].blocks.flatMap((b) => b.hours).every((h) => h.phsWorkMinPerHour === null && h.limitedBy !== 'phs')).toBe(true)
  })

  it('reference worker: least-acclimatised known member; vapour-barrier tasks are not screened (PHS does not apply)', () => {
    const newcomer = worker('R2', 'ref-crew', { daysOnSite: 2, experiencedInHeat: false })
    const mixed = crewOf('ref-crew', [REF_W.id, newcomer.id], [WELD_FR])
    expect(planFor(heatOf(33, 40, 750), COOLED_SITE, mixed, [REF_W, newcomer]).crews[0].phsScreen?.reference.acclimatized).toBe(false)
    const suit: Task = { id: 'suit', name: 'Tank cleaning', workClass: 'light', inSun: false, clothing: 'vapour_barrier', durationMin: 120, flexible: true }
    const plan = planFor(heatOf(22, 40, 200), COOLED_SITE, crewOf('ref-crew', [REF_W.id], [suit]), [REF_W])
    const bhs = plan.crews[0].blocks.flatMap((b) => b.hours)
    expect(bhs.length).toBeGreaterThan(0)
    expect(bhs.every((h) => h.phsWorkMinPerHour === null && h.limitedBy !== 'phs')).toBe(true)
  })
})
