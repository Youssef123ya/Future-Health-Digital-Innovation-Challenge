/**
 * Wave 2d planner tests: per-member acclimatisation caps, floored execution bouts, the plan basis ('tables' |
 * 'monitored') and the ISO 7933 screen guarantee (the plan followed minute by minute through the engine stops or holds
 * nobody), including the safety review's three counter-examples. Known answers were recorded from the planner and,
 * where marked, from the wave 2c planner (HEAD) on the same inputs.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ConsentState, Crew, Site, Task, WorkerProfile } from './types'
import { MINUTE_MS, epochFromLocal } from './time'
import { allowedWorkFraction, clothingAdjustmentC, taskMetabolicW } from './limits'
import { wbgtComponents } from './wbgt'
import { computeTwl } from './twl'
import { parseDemoDays } from '../data/weather'
import { getSite } from '../data/sites'
import { computeSiteHeat } from './indices'
import type { SiteHeat } from './indices'
import { createWorkerEngine, stepWorkerEngine } from './risk'
import type { PlanBasis as EnginePlanBasis, WorkerContext } from './risk'
import { CLINICAL_TEXT_PATTERN } from './alerts'
import { DEVICE_REST_NOTE, MONITORED_PLAN, PHS_SCREEN, planDay, suggestShiftStart } from './planner'
import type { CrewPlan, DayPlan, PlanBasis, PlannerHour } from './planner'

// ─────────────────────────────── Builders ───────────────────────────────

const CONSENT: ConsentState = { wearable: false, healthFlags: false, checkins: true, shareWithMedicOnEscalation: false, aggregateStatistics: true, updatedAt: 0 }
const SITE = getSite('musaffah')

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
const local = (date: string, hhmm: string): number => epochFromLocal(`${date}T${hhmm}`)
const hhmmOf = (t: number): string => new Date(t + 4 * 3600e3).toISOString().slice(11, 16)

/** Flat synthetic day without climate (no ISO 7933 screen): table numbers are exact. */
function flatDay(date: string, wbgtC: number, wbgtShadeC: number, twlWm2: number, twlShadeWm2 = twlWm2 + 40): PlannerHour[] {
  return Array.from({ length: 24 }, (_, h) => ({ t: local(date, `${String(h).padStart(2, '0')}:00`), wbgtC, wbgtShadeC, twlWm2, twlShadeWm2 }))
}

const MATERIAL: Task = { id: 'mh', name: 'Material handling', workClass: 'heavy', inSun: true, durationMin: 120, flexible: true, earliestStart: '06:00', latestEnd: '17:30' }
const FINISHING: Task = { id: 'fin', name: 'Blockwork and plastering', workClass: 'moderate', inSun: false, durationMin: 240, flexible: true, earliestStart: '06:00', latestEnd: '18:00' }
const POUR: Task = { id: 'pour', name: 'Concrete pour', workClass: 'heavy', inSun: true, durationMin: 180, flexible: true, earliestStart: '04:30', latestEnd: '10:30' }

/** History and private reasons a supervisor-visible text must never carry (see planner.test.ts). */
const HISTORY_TEXT = /\bday \d|days? on site|days? (off|away)|absence|returning|\bseason|\d+ ?%|allowance is \d|conservative|medication|fasting|stricter personal limit|\bkg\b/i
const supervisorTexts = (plan: DayPlan): string =>
  JSON.stringify([plan.notes, plan.warnings.map((w) => w.text), plan.crews.map((c) => [c.binding.text, c.notes, c.blocks.flatMap((b) => [...b.notes, b.rest.text])])])

// ─────────────────────────────── Constant-condition days with climate (the ISO 7933 screen runs) ───────────────────────────────

const DATE = '2025-07-20'
const siteWith = (restArea: Site['restArea']): Site => ({ ...SITE, radiantBoostC: 0, restArea })
const heatOf = (taC: number, rhPct: number, ghiWm2: number, site: Site): SiteHeat =>
  computeSiteHeat({ t: local(DATE, '10:00'), taC, rhPct, pHpa: 1005, wind10Ms: 1.5, ghiWm2, radiationWindowMin: 0, radiantBoostC: 0, source: 'archive' }, site)
const constantDay = (heat: SiteHeat): PlannerHour[] =>
  Array.from({ length: 24 }, (_, h) => ({
    t: local(DATE, `${String(h).padStart(2, '0')}:00`),
    wbgtC: heat.wbgtC,
    wbgtShadeC: heat.wbgtShadeC,
    twlWm2: heat.twlWm2,
    twlShadeWm2: heat.twlShadeWm2,
    climate: heat,
  }))
/** The ISO 7933 screen's reference worker: 75 kg / 1.75 m, acclimatised (daysOnSite 60, experienced). */
const REF = worker('R1', 'c', { massKg: 75, heightCm: 175, daysOnSite: 60 })
/** The reference worker with a wearable and consent (for monitored mode on the device). */
const REF_WEARABLE = worker('R1', 'c', { massKg: 75, heightCm: 175, daysOnSite: 60, hasWearable: true, consent: { ...CONSENT, wearable: true } })
/** A newcomer of the reference size on day 3 (ADOSH-unacclimatised, new-employee ramp 60 %). */
const NEW3 = worker('N1', 'c', { massKg: 75, heightCm: 175, daysOnSite: 3, experiencedInHeat: false })
const job = (workClass: Task['workClass'], clothing: Task['clothing'], inSun = true): Task => ({ id: 'job', name: 'Job', workClass, inSun, clothing, durationMin: 600, flexible: true })

interface Scenario {
  site: Site
  heat: SiteHeat
  crew: Crew
  workers: WorkerProfile[]
  shift: [string, string]
  plan: DayPlan
}

function scenario(o: { taC: number; rh: number; ghi: number; rest: Site['restArea']; task: Task; workers: WorkerProfile[]; shift: [string, string]; planBasis?: PlanBasis }): Scenario {
  const site = siteWith(o.rest)
  const heat = heatOf(o.taC, o.rh, o.ghi, site)
  const crew = crewOf('c', o.workers.map((w) => w.id), [o.task])
  const plan = planDay({ date: DATE, site, crews: [crew], workers: o.workers, hourly: constantDay(heat), shift: { start: o.shift[0], end: o.shift[1] }, ...(o.planBasis ? { planBasis: o.planBasis } : {}) })
  return { site, heat, crew, workers: o.workers, shift: o.shift, plan }
}

interface FollowResult {
  workMin: number
  /** Minutes with the projection channel at stop. */
  stops: number
  /** Minutes with any hold (projection or task hold). */
  held: number
  /** Hold minutes while the plan says work. */
  heldAtWork: number
  /** Least minutes to a limit while working (null: never projected one). */
  minAtWork: number | null
  /** First minute with the projection channel at stop (local 'HH:mm'), or null. */
  firstStop: string | null
  /** The acclimatisation exposure budget ran out on the device. */
  budgetStop: boolean
  /** Minutes the device was in monitored mode. */
  monitoredMin: number
}

/**
 * Follows a day plan minute by minute through createWorkerEngine / stepWorkerEngine at constant conditions, as the
 * worker `profile`: in each crew block-hour the first boutMin minutes are work at the task's location — the member's
 * personal cap (CrewPlan.memberCaps) when there is one, unless `crewLayout` — and the rest of the block-hour and idle
 * blocks are rest in the site's rest area. The device knows the assignment (resumeTask) and the planned rate.
 */
function follow(s: Scenario, profile: WorkerProfile, o: { crewLayout?: boolean; planBasis?: PlanBasis; physio?: boolean } = {}): FollowResult {
  const cp = s.plan.crews[0]
  const caps = o.crewLayout ? undefined : cp.memberCaps[profile.id]
  const start = local(DATE, s.shift[0])
  const end = local(DATE, s.shift[1])
  const restLocation = s.site.restArea === 'cooled_cabin' ? 'indoor_cool' : 'shade'
  let state = createWorkerEngine(profile, start)
  const r: FollowResult = { workMin: 0, stops: 0, held: 0, heldAtWork: 0, minAtWork: null, firstStop: null, budgetStop: false, monitoredMin: 0 }
  let lastTask: Task = s.crew.tasks[0]
  for (let t = start; t < end; t += MINUTE_MS) {
    const b = cp.blocks.find((x) => t >= x.startT && t < x.endT) as CrewPlan['blocks'][number]
    const task = b.taskId === null ? null : (s.crew.tasks.find((x) => x.id === b.taskId) as Task)
    let work = false
    let rate = b.workMinPerHour
    if (task) {
      lastTask = task
      const bh = b.hours.find((h) => t >= h.startT && t < h.startT + h.wallMin * MINUTE_MS) as CrewPlan['blocks'][number]['hours'][number]
      const cap = caps?.find((c) => c.startT === bh.startT)
      const bout = caps ? (cap?.boutMin ?? 0) : bh.boutMin
      if (cap) rate = cap.workMinPerHour
      work = t - bh.startT < bout * MINUTE_MS
    }
    const ctx: WorkerContext = {
      now: t,
      profile,
      task: work ? task : null,
      location: work && task ? (task.inSun ? 'sun' : 'shade') : restLocation,
      heat: s.heat,
      network: 'online',
      restArea: s.site.restArea,
      resumeTask: task ?? lastTask,
      ...(task ? { plannedWorkMinPerHour: rate } : {}),
      ...(o.planBasis ? { planBasis: o.planBasis } : {}),
    }
    const step = stepWorkerEngine(state, ctx, o.physio ? { physioMinute: { hrMeanBpm: 100, minuteValid: true, rScale: 1 } } : {})
    state = step.state
    const projection = step.assessment.channels.find((c) => c.channel === 'projection')
    if (projection?.level === 'stop') {
      r.stops += 1
      if (r.firstStop === null) r.firstStop = hhmmOf(t)
    }
    if (step.detail.resume?.held) {
      r.held += 1
      if (work) r.heldAtWork += 1
    }
    if (step.assessment.channels.some((c) => c.drivers.some((d) => d.id === 'acclimatization_budget_exhausted'))) r.budgetStop = true
    if (step.detail.environment.monitored) r.monitoredMin += 1
    if (work) {
      r.workMin += 1
      const m = step.assessment.minutesToLimit
      if (m !== null) r.minAtWork = r.minAtWork === null ? m : Math.min(r.minAtWork, m)
    }
  }
  return r
}

// ─────────────────────────────── Per-member acclimatisation ───────────────────────────────

describe('per-member acclimatisation (wave 2d)', () => {
  it('an all-unacclimatised crew reproduces the wave 2c plan numbers (known answers recorded from the wave 2c planner on the same inputs)', () => {
    // Two acclimatising members (day 10): crew rate at RAL with the next-stricter tier, as the wave 2c plan had it (both
    // were in conservative mode then: new_worker_14d). ADOSH Medium zone: heavy 45/15 → next-stricter (High) 20/40.
    const ws = ['N0', 'N1'].map((id) => worker(id, 'n', { daysOnSite: 10, experiencedInHeat: false }))
    const crew = crewOf('n', ['N0', 'N1'], [MATERIAL])
    const plan = planDay({ date: DATE, site: SITE, crews: [crew], workers: ws, hourly: flatDay(DATE, 26, 25, 130), shift: { start: '06:00', end: '12:00' } })
    const cp = plan.crews[0]
    expect(cp.binding.limit).toBe('RAL')
    expect(cp.blocks.map((b) => `${b.taskId}@${b.start}-${b.end}:${b.workMinPerHour}/${b.workMin}`)).toEqual(['mh@06:00-12:00:20/120'])
    const h = cp.blocks[0].hours[0]
    expect(h).toMatchObject({ allowedWorkMinPerHour: 20, packWorkMinPerHour: 20, zone: 'medium', limitedBy: 'rule_pack', boutMin: 20 })
    expect(h.nioshWorkMinPerHour).toBeCloseTo(30.7256028339566, 9)
    expect(plan.hours[0].allowedWorkMinPerHour.heavy).toBe(20) // site outlook for the strictest crew rate
    // Real peak day, three new workers (days 2–4): identical blocks to the wave 2c planner.
    const demo = parseDemoDays(JSON.parse(readFileSync(new URL('../../public/data/weather/demo-days.json', import.meta.url), 'utf8')))
    const day = demo.find((d) => d.id === 'musaffah_2025-08-01')!
    const daySite = getSite(day.siteId)
    const hourly = day.analysis.samples.map((s) => {
      const w = wbgtComponents({ ...s, radiantBoostC: daySite.radiantBoostC }, daySite.lat, daySite.lon)
      const base = { tdbC: w.taC, windMs: w.wind2Ms, pKpa: w.pHpa / 10, rhPct: w.rhPct }
      return { t: s.t, wbgtC: w.wbgtC, wbgtShadeC: w.wbgtShadeC, twlWm2: computeTwl({ ...base, mrtC: w.mrtC }).twlWm2, twlShadeWm2: computeTwl({ ...base, mrtC: w.mrtShadeC }).twlWm2 }
    })
    const news = [0, 1, 2].map((i) => worker(`N${i}`, 'n', { daysOnSite: 2 + i, experiencedInHeat: false, massKg: 65 + 7 * i }))
    const hot = planDay({ date: day.date, site: daySite, crews: [crewOf('n', news.map((w) => w.id), [MATERIAL, FINISHING, POUR])], workers: news, hourly, shift: { start: '05:00', end: '17:00' } })
    const hc = hot.crews[0]
    expect(hc.binding.limit).toBe('RAL')
    expect(hc.workMin).toBe(190)
    expect(hc.blocks.filter((b) => b.taskId).map((b) => `${b.taskId}@${b.start}-${b.end}:${b.workMinPerHour}/${b.workMin}`)).toEqual([
      'pour@05:00-08:00:15/45',
      'fin@08:00-10:00:20/40',
      'fin@10:00-17:00:15/105',
    ])
    // Personal caps are additive: ADOSH-unacclimatised members get no work in Medium/High-zone hours.
    for (const w of news) expect(hc.memberWorkMin[w.id]).toBeLessThan(190)
  })

  it('empty crew: the acclimatisation-schedule rate (RAL), no members, an empty_crew warning', () => {
    const plan = planDay({ date: DATE, site: SITE, crews: [crewOf('e', [], [MATERIAL])], workers: [], hourly: flatDay(DATE, 26, 25, 130), shift: { start: '06:00', end: '12:00' } })
    const cp = plan.crews[0]
    expect(cp.binding).toMatchObject({ limit: 'RAL', nonAcclimatizedMemberIds: [], crewSize: 1 })
    expect(cp.memberCaps).toEqual({})
    expect(cp.memberWorkMin).toEqual({})
    expect(cp.notes).toEqual([DEVICE_REST_NOTE])
    expect(plan.warnings.some((w) => w.code === 'empty_crew')).toBe(true)
    for (const b of cp.blocks) for (const h of b.hours) expect(h.packWorkMinPerHour).toBe(20) // RAL and the next-stricter tier
  })

  it('ADOSH note b: a newcomer gets a personal cap of 0 in Medium-zone hours while the acclimatised crew works at its own rate; texts name the schedule and the zone, never the history', () => {
    const ws = [worker('M1', 'c'), worker('N1', 'c', { daysOnSite: 2, experiencedInHeat: false })]
    const plan = planDay({ date: DATE, site: SITE, crews: [crewOf('c', ['M1', 'N1'], [MATERIAL])], workers: ws, hourly: flatDay(DATE, 26, 25, 130, 200), shift: { start: '06:00', end: '12:00' } })
    const cp = plan.crews[0]
    expect(cp.binding.limit).toBe('REL')
    // Known answers: the crew works the pack's base Medium-zone heavy cycle (45/15): 45 + 45 + 30 min.
    expect(cp.blocks.filter((b) => b.taskId).map((b) => `${b.start}-${b.end}:${b.workMinPerHour}/${b.workMin}`)).toEqual(['06:00-08:40:45/120'])
    expect(cp.memberCaps.N1.map((c) => [c.hour, c.workMinPerHour, c.boutMin, c.limitedBy])).toEqual([
      ['06:00', 0, 0, 'acclimatization'],
      ['07:00', 0, 0, 'acclimatization'],
      ['08:00', 0, 0, 'acclimatization'],
    ])
    expect(cp.memberWorkMin).toEqual({ M1: 120, N1: 0 })
    const reassign = plan.warnings.find((w) => w.code === 'unacclimatized_reassign')!
    expect(reassign).toMatchObject({ workerIds: ['N1'], hours: ['06:00', '07:00', '08:00'] })
    expect(cp.blocks[0].notes.join(' ')).toMatch(/Not yet acclimatised \(N1\): no work in the Medium Risk — Cautionary Zone \(personal cap\)/)
    expect(cp.blocks[0].notes.join(' ')).toMatch(/Acclimatisation schedule \(personal caps\): N1 no work\./)
    expect(supervisorTexts(plan)).not.toMatch(HISTORY_TEXT)
    expect(supervisorTexts(plan)).not.toMatch(CLINICAL_TEXT_PATTERN)
  })

  it('exposure ramp: the planned bouts stay below the day’s allowance (60 % × 480 = 288 → 287 min) and the device never reaches it', () => {
    const light: Task = { id: 'insp', name: 'Inspection', workClass: 'light', inSun: false, durationMin: 480, flexible: true }
    const ws = [worker('M1', 'c'), worker('N3', 'c', { daysOnSite: 3, experiencedInHeat: false })]
    const plan = planDay({ date: '2025-11-20', site: SITE, crews: [crewOf('c', ['M1', 'N3'], [light])], workers: ws, hourly: flatDay('2025-11-20', 20, 20, 300, 300), shift: { start: '06:00', end: '14:00' } })
    const cp = plan.crews[0]
    expect(cp.memberWorkMin).toEqual({ M1: 480, N3: 287 })
    expect(cp.memberCaps.N3.map((c) => c.boutMin)).toEqual([60, 60, 60, 60, 47, 0, 0, 0])
    expect(cp.memberCaps.N3.map((c) => c.limitedBy)).toEqual(['crew', 'crew', 'crew', 'crew', 'acclimatization', 'acclimatization', 'acclimatization', 'acclimatization'])
    const ramp = plan.warnings.find((w) => w.code === 'acclimatization_ramp')!
    expect(ramp.workerIds).toEqual(['N3'])
    expect(ramp.text).not.toMatch(HISTORY_TEXT)
    // Followed on the device (mild constant conditions with climate): the budget never runs out, nothing stops or holds.
    const s = scenario({ taC: 24, rh: 40, ghi: 300, rest: 'cooled_cabin', task: light, workers: [worker('M1', 'c'), worker('N3', 'c', { daysOnSite: 3, experiencedInHeat: false, massKg: 75, heightCm: 175 })], shift: ['06:00', '14:00'] })
    expect(s.plan.crews[0].memberWorkMin.N3).toBe(287)
    const f = follow(s, s.workers[1])
    expect(f).toMatchObject({ workMin: 287, budgetStop: false, stops: 0, held: 0 })
  })

  it('rest itself above a member’s personal limit (NIOSH RAL at rest) but not the crew’s: a rest_exceeds_limit warning for that member only', () => {
    const light: Task = { id: 'insp', name: 'Inspection', workClass: 'light', inSun: false, durationMin: 120, flexible: true }
    const ws = [worker('M1', 'c'), worker('N9', 'c', { daysOnSite: 9, experiencedInHeat: false })]
    // Shade-only site at WBGT 32 °C in shade: above RAL at rest (30.8 °C), below REL at rest (33.0 °C).
    const plan = planDay({ date: '2025-11-20', site: { ...SITE, restArea: 'shade' }, crews: [crewOf('c', ['M1', 'N9'], [light])], workers: ws, hourly: flatDay('2025-11-20', 33, 32, 300, 300), shift: { start: '06:00', end: '10:00' } })
    const rest = plan.warnings.filter((w) => w.code === 'rest_exceeds_limit')
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ workerIds: ['N9'], hours: ['06:00', '07:00', '08:00', '09:00'] })
    expect(rest[0].text).toMatch(/N9 \(acclimatisation schedule\): even rest in shade exceeds this member's exposure limit/)
    expect(plan.crews[0].memberWorkMin).toEqual({ M1: 80, N9: 0 })
  })
})

// ─────────────────────────────── Floor bouts ───────────────────────────────

describe('execution bouts are floored (wave 2d)', () => {
  it('a partial block-hour at 40 min/h over 40 min plans 26.67 min and lays out a 26-min bout (wave 2c: ceil → 27)', () => {
    const big: Task = { ...MATERIAL, durationMin: 400 }
    const plan = planDay({ date: '2025-11-20', site: SITE, crews: [crewOf('c', ['M1'], [big])], workers: [worker('M1', 'c')], hourly: flatDay('2025-11-20', 29, 25, 300, 300), shift: { start: '06:00', end: '09:40' } })
    const cp = plan.crews[0]
    const hours = cp.blocks.flatMap((b) => b.hours)
    expect(hours.map((h) => [h.hour, h.wallMin, h.workMin, h.boutMin, h.allowedWorkMinPerHour])).toEqual([
      ['06:00', 60, 40, 40, 40],
      ['07:00', 60, 40, 40, 40],
      ['08:00', 60, 40, 40, 40],
      ['09:00', 40, 26.67, 26, 40],
    ])
    for (const h of hours) expect(h.boutMin).toBeLessThanOrEqual((h.allowedWorkMinPerHour * h.wallMin) / 60)
    expect(cp.workMin).toBe(146.7)
    expect(cp.memberWorkMin.M1).toBe(146) // executed work never exceeds the planned allowance
  })
})

// ─────────────────────────────── Plan basis ───────────────────────────────

describe('plan basis: tables (default) and monitored (wave 2d)', () => {
  const moderate = job('moderate', 'cloth_coveralls')
  const tables = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task: moderate, workers: [REF_WEARABLE], shift: ['06:00', '14:00'] })
  const monitored = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task: moderate, workers: [REF_WEARABLE], shift: ['06:00', '14:00'], planBasis: 'monitored' })

  it('defaults to tables; PlanBasis is the engine’s WorkerContext.planBasis type', () => {
    const bases: PlanBasis[] = ['tables', 'monitored']
    const engine: EnginePlanBasis[] = bases
    const back: PlanBasis[] = engine
    expect(back).toEqual(bases)
    expect(tables.plan.planBasis).toBe('tables')
    expect(tables.plan.notes).toEqual([])
    expect(tables.plan.crews[0].planBasis).toBe('tables')
    expect(tables.plan.crews[0].blocks.flatMap((b) => b.hours).every((h) => !h.monitored)).toBe(true)
  })

  it('monitored raises the crew rate only where NIOSH/ACGIH was binding, never above the rule pack or the ISO 7933 screen; it records its basis and note', () => {
    const t = tables.plan.crews[0]
    const m = monitored.plan.crews[0]
    expect(monitored.plan.planBasis).toBe('monitored')
    expect(monitored.plan.notes).toEqual([MONITORED_PLAN.note])
    expect(m.planBasis).toBe('monitored')
    expect(m.notes).toContain(MONITORED_PLAN.note)
    for (const b of MONITORED_PLAN.basis) expect(monitored.plan.basis).toContain(b)
    expect(MONITORED_PLAN.basis.join(' ')).toMatch(/ISO 7243:2017.*ISO 7933/)
    expect(MONITORED_PLAN.basis.join(' ')).toMatch(/ACGIH TLV/)
    expect(MONITORED_PLAN.basis.join(' ')).toMatch(/NIOSH 2016/)
    for (let hi = 0; hi < m.allowance.length; hi++) {
      const tc = (t.phsScreen as NonNullable<CrewPlan['phsScreen']>).hours[hi].byTask.job
      const mc = (m.phsScreen as NonNullable<CrewPlan['phsScreen']>).hours[hi].byTask.job
      expect(mc.allowedMin).toBeGreaterThanOrEqual(tc.allowedMin)
      if (tc.limitedBy !== 'niosh_acgih' && tc.limitedBy !== 'phs') expect(mc.allowedMin).toBe(tc.allowedMin)
    }
    for (const b of m.blocks.filter((x) => x.taskId)) {
      for (const h of b.hours) {
        if (h.monitored) {
          expect(h.allowedWorkMinPerHour).toBe(Math.floor(h.packWorkMinPerHour / 5) * 5)
          expect(['rule_pack', 'none', 'phs']).toContain(h.limitedBy)
        } else {
          expect(h.allowedWorkMinPerHour).toBeLessThanOrEqual(h.nioshWorkMinPerHour)
        }
        expect(b.workMinPerHour).toBeLessThanOrEqual(h.packWorkMinPerHour)
        expect(b.workMinPerHour).toBeLessThanOrEqual(h.phsWorkMinPerHour as number)
      }
    }
    // Known answers: 06:00 is the device warm-up hour (tables); 07:00–10:00 continuous by the pack; 11:00 cut by the screen.
    const hrs = m.blocks.filter((b) => b.taskId).flatMap((b) => b.hours)
    expect(hrs.map((h) => [h.hour, h.boutMin, h.monitored, h.limitedBy])).toEqual([
      ['06:00', 50, false, 'niosh_acgih'],
      ['07:00', 60, true, 'none'],
      ['08:00', 60, true, 'none'],
      ['09:00', 60, true, 'none'],
      ['10:00', 60, true, 'none'],
      ['11:00', 15, true, 'phs'],
    ])
    expect(t.memberWorkMin.R1).toBe(192)
    expect(m.memberWorkMin.R1).toBe(305)
  })

  it('monitored keeps the tables where devices cannot confirm monitoring: unverified clothing (FR coveralls), a work rate outside the ISO 7933 validity range (very heavy)', () => {
    for (const task of [job('heavy', 'fr_coveralls'), job('very_heavy', 'cloth_coveralls')]) {
      const t = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task, workers: [REF_WEARABLE], shift: ['06:00', '14:00'] })
      const m = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task, workers: [REF_WEARABLE], shift: ['06:00', '14:00'], planBasis: 'monitored' })
      expect(m.plan.crews[0].blocks.flatMap((b) => b.hours).every((h) => !h.monitored)).toBe(true)
      expect(m.plan.crews[0].allowance).toEqual(t.plan.crews[0].allowance)
      expect(m.plan.crews[0].notes.join(' ')).toMatch(/cannot confirm monitoring keep the WBGT table limits/)
    }
  })

  it('personal caps keep the tables (RAL) in a monitored plan; no acclimatised member or no climate → the tables, with a note', () => {
    const mixed = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task: moderate, workers: [REF_WEARABLE, NEW3], shift: ['06:00', '14:00'], planBasis: 'monitored' })
    const cp = mixed.plan.crews[0]
    expect(cp.planBasis).toBe('monitored')
    // N1's table cap recomputed independently: RAL with N1's size and clothing; rest in the 25 °C cabin, never hotter than shade.
    const cav = clothingAdjustmentC('cloth_coveralls')
    const ral = allowedWorkFraction({ workW: taskMetabolicW(moderate, 75), wbgtWorkEffC: mixed.heat.wbgtC + cav, wbgtRestEffC: Math.min(25, mixed.heat.wbgtShadeC) + cav, limit: 'RAL' })
    const ralCap = ral.workMinPerHour < 15 ? 0 : Math.floor(ral.workMinPerHour / 5) * 5
    expect(ralCap).toBe(30)
    for (const c of cp.memberCaps.N1) expect(c.workMinPerHour).toBeLessThanOrEqual(ralCap)
    // Known answers: RAL binds at the monitored crew's higher rate, then the unacclimatised ISO 7933 screen.
    expect(cp.memberCaps.N1.map((c) => [c.hour, c.workMinPerHour, c.limitedBy])).toEqual([
      ['06:00', 30, 'acclimatization'],
      ['07:00', 30, 'acclimatization'],
      ['08:00', 30, 'acclimatization'],
      ['09:00', 20, 'phs'],
      ['10:00', 10, 'phs'],
      ['11:00', 10, 'phs'],
    ])
    expect(cp.memberWorkMin).toEqual({ R1: 305, N1: 130 })
    const newOnly = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task: moderate, workers: [NEW3], shift: ['06:00', '14:00'], planBasis: 'monitored' })
    expect(newOnly.plan.planBasis).toBe('monitored')
    expect(newOnly.plan.crews[0].planBasis).toBe('tables')
    expect(newOnly.plan.crews[0].notes.join(' ')).toMatch(/no member is acclimatised yet/)
    const noClimate = planDay({ date: DATE, site: siteWith('cooled_cabin'), crews: [crewOf('c', ['R1'], [moderate])], workers: [REF_WEARABLE], hourly: flatDay(DATE, 29, 24, 220), shift: { start: '06:00', end: '14:00' }, planBasis: 'monitored' })
    expect(noClimate.crews[0].planBasis).toBe('tables')
    expect(noClimate.crews[0].notes.join(' ')).toMatch(/cannot run without air temperature/)
    expect(supervisorTexts(mixed.plan)).not.toMatch(HISTORY_TEXT)
    expect(supervisorTexts(mixed.plan)).not.toMatch(/consent|wearable/i)
  })

  it('suggestShiftStart and the naive comparison work for both bases', () => {
    const input = { date: DATE, site: monitored.site, crews: [monitored.crew], workers: [REF_WEARABLE], hourly: constantDay(monitored.heat), shift: { start: '05:00', end: '13:00' } }
    const t = suggestShiftStart(input)
    const m = suggestShiftStart({ ...input, planBasis: 'monitored' })
    expect(t.map((o) => o.start).sort()).toEqual(['05:00', '06:00', '07:00'])
    expect(m.map((o) => o.start).sort()).toEqual(['05:00', '06:00', '07:00'])
    for (const o of m) {
      const same = t.find((x) => x.start === o.start)!
      expect(o.totals.workMin).toBeGreaterThanOrEqual(same.totals.workMin)
      expect(o.totals.naiveWorkMin).toBe(same.totals.naiveWorkMin) // the naive plan does not depend on the basis
      expect(o.totals.lostWorkMinVsNaive).toBeCloseTo(o.totals.naiveWorkMin - o.totals.workMin, 1)
    }
  })
})

// ─────────────────────────────── Screen guarantee ───────────────────────────────

describe('ISO 7933 screen guarantee: the plan followed minute by minute through the engine stops or holds nobody (wave 2d)', () => {
  it('review counter-example (a): re-placement converges (7 passes, more than the old bound of 4) and the plan is followed without a stop or hold', () => {
    // Shade rest, FR heavy work in sun, 33 °C / 40 % / 800 W/m²: the wave 2c planner stopped after 4 passes and the
    // device held the worker at 15:28 and reached the water-loss limit at 15:42 while resting.
    const s = scenario({ taC: 33, rh: 40, ghi: 800, rest: 'shade', task: job('heavy', 'fr_coveralls'), workers: [REF], shift: ['05:00', '17:00'] })
    const scr = s.plan.crews[0].phsScreen as NonNullable<CrewPlan['phsScreen']>
    expect(scr.passes).toBe(7)
    expect(scr.verificationCuts).toBe(0)
    expect(scr.restLimitT).toBeNull()
    const f = follow(s, REF)
    expect(f).toMatchObject({ workMin: 25, stops: 0, held: 0 })
  })

  it('review counter-example (b): engine-aligned minutes and a 1-min margin — the device never holds at the end of a planned bout', () => {
    // Shade rest, FR very heavy work, 30 °C / 50 % / 600 W/m²: wave 2c planned 15-min bouts the device held at minute 14.
    const s = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'shade', task: job('very_heavy', 'fr_coveralls'), workers: [REF], shift: ['06:00', '14:00'] })
    const bouts = s.plan.crews[0].blocks.flatMap((b) => b.hours).filter((h) => h.boutMin > 0)
    expect(bouts.some((h) => h.limitedBy === 'phs')).toBe(true) // the screen binds: the case is not trivial
    const f = follow(s, REF)
    expect(f.workMin).toBe(125)
    expect(f.stops).toBe(0)
    expect(f.held).toBe(0)
    expect(f.minAtWork as number).toBeGreaterThanOrEqual(PHS_SCREEN.highFromMin)
  })

  it('review counter-example (c): rest is screened too — when rest alone reaches a limit the plan warns phs_rest_limit (never later than the device) and plans no work; a shift ending earlier is followed without a stop', () => {
    // Shade rest at 38 °C / 55 % / 800 W/m²: the reference worker reaches the 5 % water-loss limit at rest at 11:29.
    const full = scenario({ taC: 38, rh: 55, ghi: 800, rest: 'shade', task: job('moderate', 'cloth_coveralls'), workers: [REF], shift: ['05:00', '17:00'] })
    const cp = full.plan.crews[0]
    const w = full.plan.warnings.find((x) => x.code === 'phs_rest_limit')!
    expect(w).toMatchObject({ crewId: 'c', hours: ['11:00'] })
    expect(w.text).toMatch(/11:28/)
    expect(w.text).toMatch(/cooled rest area/)
    expect(w.text).toMatch(/log their drinks/)
    expect(w.text).toMatch(/shorten the shift to end before 11:28/)
    expect(w.text).not.toMatch(CLINICAL_TEXT_PATTERN)
    expect(cp.workMin).toBe(0)
    expect(hhmmOf((cp.phsScreen as NonNullable<CrewPlan['phsScreen']>).restLimitT as number)).toBe('11:28')
    const f = follow(full, REF)
    expect(f.workMin).toBe(0)
    expect(f.firstStop).toBe('11:29') // the device's first stop, resting: one minute after the warned margin
    const short = scenario({ taC: 38, rh: 55, ghi: 800, rest: 'shade', task: job('light', 'cloth_coveralls', false), workers: [REF], shift: ['06:00', '10:00'] })
    expect(short.plan.warnings.some((x) => x.code === 'phs_rest_limit')).toBe(false)
    expect(follow(short, REF)).toMatchObject({ stops: 0, held: 0 })
  })

  it('acclimatisation-schedule member: following the personal caps gives no stop and no hold; following the crew layout instead would', () => {
    const s = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task: job('moderate', 'cloth_coveralls'), workers: [REF, NEW3], shift: ['06:00', '14:00'] })
    const cp = s.plan.crews[0]
    expect(cp.memberWorkMin).toEqual({ R1: 192, N1: 132 })
    // Known answers: N1's RAL cap (30 min/h) binds while the crew works 50 min/h, then the crew's screened rate.
    expect(cp.memberCaps.N1.map((c) => [c.hour, c.workMinPerHour, c.boutMin, c.limitedBy])).toEqual([
      ['06:00', 30, 30, 'acclimatization'],
      ['07:00', 30, 30, 'acclimatization'],
      ['08:00', 30, 30, 'acclimatization'],
      ['09:00', 15, 15, 'crew'],
      ['10:00', 10, 10, 'crew'],
      ['11:00', 10, 10, 'crew'],
      ['12:00', 15, 7, 'crew'],
    ])
    expect(follow(s, REF)).toMatchObject({ workMin: 192, stops: 0, held: 0 })
    expect(follow(s, NEW3)).toMatchObject({ workMin: 132, stops: 0, held: 0 })
    const crewLayout = follow(s, NEW3, { crewLayout: true })
    expect(crewLayout.stops).toBeGreaterThan(0)
    expect(crewLayout.heldAtWork).toBeGreaterThan(0)
  })

  it('property: over a grid of constant days the re-placement converges before the safety net, the verification pass cuts nothing, and rates stay 0 or ≥ minBoutMin', () => {
    let plans = 0
    for (const rest of ['shade', 'cooled_cabin'] as const) {
      for (const [taC, rh, ghi] of [[30, 50, 600], [33, 40, 800], [35, 60, 850]]) {
        for (const task of [job('heavy', 'fr_coveralls'), job('moderate', 'cloth_coveralls'), job('light', 'double_layer', false)]) {
          for (const workers of [[REF], [REF, NEW3]]) {
            const s = scenario({ taC, rh, ghi, rest, task, workers, shift: ['05:00', '17:00'] })
            const cp = s.plan.crews[0]
            const scr = cp.phsScreen as NonNullable<CrewPlan['phsScreen']>
            expect(scr.passes).toBeLessThan(PHS_SCREEN.maxPasses)
            expect(scr.verificationCuts).toBe(0)
            for (const b of cp.blocks.filter((x) => x.taskId)) expect(b.workMinPerHour === 0 || b.workMinPerHour >= PHS_SCREEN.minBoutMin).toBe(true)
            for (const caps of Object.values(cp.memberCaps)) for (const c of caps) expect(c.workMinPerHour === 0 || c.workMinPerHour >= PHS_SCREEN.minBoutMin).toBe(true)
            // A rest-limit day plans no work at all, for anyone.
            if (scr.restLimitT !== null) expect(Object.values(cp.memberWorkMin).every((m) => m === 0)).toBe(true)
            plans += 1
          }
        }
      }
    }
    expect(plans).toBe(36)
  })

  it('monitored plan, end to end: the reference worker with valid monitoring (wearable, consent, heart-rate minutes; WorkerContext.planBasis) follows it without a stop or hold', () => {
    const s = scenario({ taC: 30, rh: 50, ghi: 600, rest: 'cooled_cabin', task: job('moderate', 'cloth_coveralls'), workers: [REF_WEARABLE], shift: ['06:00', '14:00'], planBasis: 'monitored' })
    const f = follow(s, REF_WEARABLE, { planBasis: 'monitored', physio: true })
    expect(f.workMin).toBe(305)
    expect(f.stops).toBe(0)
    expect(f.held).toBe(0)
    expect(f.monitoredMin).toBeGreaterThan(0) // the device did run in monitored mode after its warm-up
  })
})
