import { beforeAll, describe, expect, it } from 'vitest'
import { DEMO_CREW_ID } from '../data/workforce'
import { getSite, isSiteId } from '../data/sites'
import { epochFromLocal } from '../engine/time'
import { createNodeSimDataLoader } from './simdata'
import {
  PEAK_DAY_CONFUSION_WORKER,
  SCENARIOS,
  SCENARIO_IDS,
  createScenarioWorld,
  getScenario,
  hasDemoCrew,
  loadScenarioData,
  runScenario,
  scenarioConfig,
  type ScenarioId,
} from './scenarios'
import { finishWorld, idleMinutes, shiftMinutes, stepWorld, worldView } from './worldsim'
import type { SimData, SimEvent, SiteDayResult } from './types'

const loader = createNodeSimDataLoader()
const local = (date: string, hhmm: string): number => epochFromLocal(`${date}T${hhmm}`)
const byKind = <K extends SimEvent['kind']>(events: readonly SimEvent[], kind: K) => events.filter((e): e is Extract<SimEvent, { kind: K }> => e.kind === kind)

describe('scenario catalogue', () => {
  it('the five named scenarios, each with a real cached day, a description and a documented day choice', () => {
    expect(SCENARIO_IDS).toEqual(['peak-day', 'humid-day', 'mild-day', 'saadiyat-peak', 'shade-only'])
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length)
    for (const s of SCENARIOS) {
      expect(s.title.length).toBeGreaterThan(5)
      expect(s.description.length).toBeGreaterThan(40)
      expect(s.dayChoice.length).toBeGreaterThan(20)
      expect(s.demonstrates.length).toBeGreaterThan(0)
      expect(isSiteId(s.siteId)).toBe(true)
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(s.config.siteId).toBe(s.siteId)
      expect(s.config.date).toBe(s.date)
      expect(s.config.crews?.length).toBeGreaterThan(0)
      expect(s.config.crews!.every((c) => c.siteId === s.siteId)).toBe(true)
      const ats = s.events.map((e) => e.at)
      expect([...ats].sort()).toEqual(ats)
      for (const e of s.events) expect(e.note.length).toBeGreaterThan(10)
    }
    expect(() => getScenario('nope' as ScenarioId)).toThrow(RangeError)
  })

  it('days and sites as specified', () => {
    const pick = (id: ScenarioId) => [getScenario(id).siteId, getScenario(id).date]
    expect(pick('peak-day')).toEqual(['musaffah', '2025-08-01'])
    expect(pick('humid-day')).toEqual(['musaffah', '2025-09-09'])
    expect(pick('mild-day')).toEqual(['musaffah', '2025-11-26'])
    expect(pick('saadiyat-peak')).toEqual(['saadiyat', '2025-07-21'])
    const shade = getScenario('shade-only')
    expect(shade.siteId).toBe('alain')
    expect(getSite(shade.siteId).restArea).toBe('shade')
    expect(getSite('musaffah').restArea).toBe('cooled_cabin')
    expect(Number(shade.date.slice(5, 7))).toBeGreaterThanOrEqual(6)
    expect(Number(shade.date.slice(5, 7))).toBeLessThanOrEqual(9)
  })

  it("peak-day: the demo crew plus one generated crew; the scripted sensor failure, buddy report and network outage", () => {
    const s = getScenario('peak-day')
    expect(hasDemoCrew(s)).toBe(true)
    const crews = s.config.crews!
    expect(crews).toHaveLength(2)
    expect(crews.filter((c) => c.id === DEMO_CREW_ID)).toHaveLength(1)
    expect(new Set(s.config.workers!.map((w) => w.id))).toEqual(new Set(crews.flatMap((c) => c.workerIds)))
    const demoCrew = crews.find((c) => c.id === DEMO_CREW_ID)!
    expect(demoCrew.workerIds).toContain(PEAK_DAY_CONFUSION_WORKER)
    const summary = s.events.map((e) => [e.at, e.injection.kind === 'system' ? e.injection.what : e.injection.kind])
    expect(summary).toEqual([
      ['11:00', 'sensor_fail'],
      ['11:30', 'sensor_ok'],
      ['14:10', 'checkin'],
      ['15:30', 'network_down'],
      ['15:50', 'network_up'],
    ])
    const report = s.events[2].injection
    expect(report.kind === 'checkin' && report.checkin.by === 'buddy' && report.checkin.symptoms.includes('confusion')).toBe(true)
    expect(report.kind === 'checkin' && report.checkin.t).toBe(local('2025-08-01', '14:10'))
    expect(s.config.disruptions).toEqual({ envSensorFailure: { from: '11:00', to: '11:30' }, networkOutage: { from: '15:30', to: '15:50' } })
  })

  it('scenarioConfig gives a complete SimConfig and applies overrides without moving the scenario', () => {
    const c = scenarioConfig('humid-day')
    expect(c.siteId).toBe('musaffah')
    expect(c.date).toBe('2025-09-09')
    expect(c.policy).toBe('zill_full')
    expect(c.trace).toBe('full')
    expect(c.behaviour.ackDelayMin.supervisor).toBeGreaterThan(0)
    const o = scenarioConfig('peak-day', { policy: 'ban_only', shadow: true, siteId: 'kezad', behaviour: { compliance: 0.5 } })
    expect([o.policy, o.shadow, o.siteId, o.date, o.behaviour.compliance]).toEqual(['ban_only', true, 'musaffah', '2025-08-01', 0.5])
    expect(o.disruptions.networkOutage).toEqual({ from: '15:30', to: '15:50' })
  })
})

describe('running the scenarios', () => {
  const data = new Map<ScenarioId, SimData>()
  beforeAll(async () => {
    for (const id of SCENARIO_IDS) data.set(id, await loadScenarioData(id, loader))
  }, 60_000)

  it('peak-day: scripted events fire at their times and drive the engine and the alert flow', () => {
    const r: SiteDayResult = runScenario('peak-day', data.get('peak-day')!)
    const d = '2025-08-01'
    expect(byKind(r.events, 'system').map((e) => [e.what, e.t])).toEqual([
      ['sensor_fail', local(d, '11:00')],
      ['sensor_ok', local(d, '11:30')],
      ['network_down', local(d, '15:30')],
      ['network_up', local(d, '15:50')],
    ])
    const report = byKind(r.events, 'checkin').find((e) => e.checkin.workerId === PEAK_DAY_CONFUSION_WORKER && e.checkin.symptoms.includes('confusion'))
    expect(report?.t).toBe(local(d, '14:10'))
    const lv = byKind(r.events, 'level').find((e) => e.workerId === PEAK_DAY_CONFUSION_WORKER && e.to === 'emergency' && e.t >= local(d, '14:10'))
    expect(lv?.t).toBe(local(d, '14:11'))
    expect(lv?.channel).toBe('symptoms')
    const em = byKind(r.events, 'alert').find((e) => e.alert.workerId === PEAK_DAY_CONFUSION_WORKER && e.alert.level === 'emergency')
    expect(em).toBeDefined()
    expect(byKind(r.events, 'notification').some((e) => e.notification.alertId === em!.alert.id && e.notification.to.role === 'first_aider')).toBe(true)
    expect(byKind(r.events, 'ack').some((e) => e.alertId === em!.alert.id && e.role === 'first_aider')).toBe(true)
    // During the outage only the worker's own device acknowledges.
    expect(byKind(r.events, 'ack').filter((e) => e.role !== 'worker' && e.t > local(d, '15:30') && e.t < local(d, '15:50'))).toHaveLength(0)
    for (const o of r.outcomes) expect(o.workMin + o.restMin + idleMinutes(o, r.config)).toBe(shiftMinutes(r.config))
    expect(r.hours.some((h) => h.middayBreak)).toBe(true)
    expect(r.plan).not.toBeNull()
  })

  it('every scenario runs; rest happens in the site rest area (cooled cabin vs shade only)', () => {
    for (const id of SCENARIO_IDS) {
      const w = createScenarioWorld(id, data.get(id)!)
      stepWorld(w, 120)
      const v = worldView(w)
      expect(v.workers.length).toBeGreaterThan(0)
      expect(v.t).toBe(local(v.config.date, '07:00'))
      const r = finishWorld(w)
      expect(r.outcomes).toHaveLength(v.workers.length)
      const restRows = (r.minutes ?? []).filter((m) => !m.working)
      expect(restRows.length).toBeGreaterThan(0)
      const cabin = restRows.filter((m) => m.location === 'indoor_cool').length
      if (getSite(v.site.id).restArea === 'shade') expect(cabin).toBe(0)
      else expect(cabin).toBeGreaterThan(0)
    }
  }, 60_000)

  it('mild-day: no midday-break season; the Lab can switch policy or shadow mode on any scenario', () => {
    const mild = runScenario('mild-day', data.get('mild-day')!, { trace: 'none' })
    expect(mild.hours.some((h) => h.middayBreak)).toBe(false)
    const shadow = runScenario('shade-only', data.get('shade-only')!, { shadow: true, trace: 'none' })
    expect(shadow.config.shadow).toBe(true)
    expect(shadow.plan).toBeNull()
    expect(byKind(shadow.events, 'instruction')).toHaveLength(0)
  }, 60_000)
})
