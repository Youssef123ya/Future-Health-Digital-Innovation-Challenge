import { describe, expect, it } from 'vitest'
import { alertStats, type Notification } from '../engine/alerts'
import { epochFromLocal } from '../engine/time'
import type { Alert, Crew, RiskLevel } from '../engine/types'
import {
  ackSummary,
  alarmTimesByBasis,
  alarmTimesByWorker,
  allFinite,
  bootstrapQuantile,
  bootstrapRatio,
  bootstrapRatioDiff,
  calibrationCounts,
  calibrationTable,
  challengeMeasures,
  detectionSummary,
  emptyCalibration,
  engineRuns,
  fairnessBreakdown,
  mergeCalibration,
  pairedComparison,
  policyRates,
  quantileSorted,
  recordAlarmTimes,
  runAlertSummary,
  truthEventCluster,
  workerShiftRecords,
  type WorkerShiftRecord,
} from './metrics'
import { makeSimConfig } from './worldsim'
import type { ShiftOutcome, SimEvent, SiteDayResult, SiteHour, TruthEventKind, WorkerMinute, WorkerSubgroup } from './types'

const DATE = '2025-07-15'
const T = (hhmm: string): number => epochFromLocal(`${DATE}T${hhmm}`)
const O = { seed: 'test', replicates: 200 }

const SUB: WorkerSubgroup = { acclimatization: 'acclimatized', ageBand: '30-44', clothing: 'cloth_coveralls', bmiBand: '<25', language: 'hi', wearable: false }

function outcome(workerId: string, over: Partial<ShiftOutcome> = {}, truth: Partial<Record<TruthEventKind, number>> = {}): ShiftOutcome {
  const events = {} as ShiftOutcome['events']
  for (const k of ['excessive_strain', 'severe_strain', 'critical', 'dehydration_3pct', 'symptom_onset'] as TruthEventKind[]) {
    const t = truth[k]
    events[k] = { count: t === undefined ? 0 : 1, firstT: t ?? null }
  }
  return {
    workerId,
    policy: 'zill_env',
    shadow: true,
    subgroup: SUB,
    workMin: 400,
    restMin: 100,
    idleMin: 0,
    hotWorkMin: 380,
    waterMl: 6000,
    maxCoreC: 38.2,
    minutesCoreAbove385: 0,
    maxDehydrationPct: 1.2,
    events,
    engine: { minutesByLevel: { safe: 300, caution: 200, high: 150, stop: 60, emergency: 0 }, firstHighT: null, firstStopT: null, firstEmergencyT: null },
    adherence: { instructions: 4, followed: 3 },
    checkins: { prompted: 2, answered: 2, selfReported: 0 },
    escalations: 1,
    ...over,
  }
}

const alert = (id: string, level: RiskLevel, scope: Alert['scope'], who: { workerId?: string; memberIds?: string[] }, status: Alert['status'] = 'active'): Alert => ({
  id,
  t: T('07:00'),
  siteId: 'kezad',
  crewId: 'C',
  scope,
  level,
  actions: [],
  reason: 'test',
  status,
  ...who,
})

const CREW: Crew = {
  id: 'C',
  siteId: 'kezad',
  name: 'Crew C',
  supervisorName: 'S',
  workerIds: ['W1', 'W2', 'W3'],
  tasks: [
    { id: 'heavy', name: 'Heavy', workClass: 'heavy', inSun: true, durationMin: 60, flexible: false },
    { id: 'light', name: 'Light', workClass: 'light', inSun: true, durationMin: 60, flexible: false },
  ],
}

function hours(): SiteHour[] {
  const out: SiteHour[] = []
  for (let h = 5; h < 17; h++) {
    const high = h === 6
    out.push({ t: T(`${String(h).padStart(2, '0')}:00`), wbgtC: 30, wbgtShadeC: 28, twlWm2: high ? 100 : 200, twlZone: high ? 'high' : 'low', middayBreak: false })
  }
  return out
}

/** Three workers with known alarms, events, tasks and outcomes (answers in the tests below). */
function siteDay(): SiteDayResult {
  const a1 = alert('A1', 'high', 'worker', { workerId: 'W1' })
  const c1caution = alert('C1', 'caution', 'crew', { memberIds: ['W1', 'W2'] })
  const c1high = alert('C1', 'high', 'crew', { memberIds: ['W1', 'W2'] })
  const c1resolved = alert('C1', 'high', 'crew', { memberIds: ['W1', 'W2', 'W3'] }, 'resolved')
  const task = (t: string, workerId: string, taskId: string | null, location: 'sun' | 'shade' | 'indoor_cool'): SimEvent => ({ kind: 'task', t: T(t), workerId, taskId, location })
  const events: SimEvent[] = [
    { kind: 'shift', t: T('05:00'), workerId: 'W1', what: 'start' },
    task('06:00', 'W1', 'light', 'sun'),
    task('06:40', 'W1', null, 'indoor_cool'),
    task('12:00', 'W1', 'light', 'sun'),
    task('13:00', 'W1', null, 'shade'),
    task('06:00', 'W2', 'heavy', 'sun'),
    task('06:45', 'W2', null, 'indoor_cool'),
    task('06:00', 'W3', 'light', 'sun'),
    task('06:10', 'W3', null, 'indoor_cool'),
    { kind: 'alert', t: T('07:00'), alert: a1 },
    { kind: 'ack', t: T('07:02'), alertId: 'A1', role: 'worker' },
    { kind: 'alert', t: T('08:00'), alert: c1caution },
    { kind: 'alert', t: T('08:30'), alert: c1high },
    { kind: 'alert', t: T('16:00'), alert: c1resolved },
    { kind: 'checkin', t: T('10:30'), checkin: { t: T('10:30'), workerId: 'W1', by: 'self', symptoms: ['thirst'] }, prompted: false },
    { kind: 'checkin', t: T('11:00'), checkin: { t: T('11:00'), workerId: 'W2', by: 'self', symptoms: ['headache'] }, prompted: false },
    { kind: 'checkin', t: T('12:00'), checkin: { t: T('12:00'), workerId: 'W3', by: 'self', symptoms: ['heat_rash'] }, prompted: true },
    { kind: 'truth', t: T('09:30'), workerId: 'W1', event: 'symptom_onset', detail: 'thirst: thirst' },
    { kind: 'truth', t: T('10:45'), workerId: 'W2', event: 'symptom_onset', detail: 'heat_exhaustion: headache' },
    { kind: 'truth', t: T('11:30'), workerId: 'W2', event: 'symptom_onset', detail: 'cramps: cramps' },
    { kind: 'resolution', t: T('15:00'), workerId: 'W3', by: 'first_aider' },
    { kind: 'shift', t: T('15:00'), workerId: 'W3', what: 'end' },
    { kind: 'shift', t: T('17:00'), workerId: 'W1', what: 'end' },
    { kind: 'shift', t: T('17:00'), workerId: 'W2', what: 'end' },
  ]
  return {
    config: makeSimConfig({ siteId: 'kezad', date: DATE, policy: 'zill_env', shadow: true }),
    stamp: 'test',
    hours: hours(),
    outcomes: [
      outcome('W1', {}, { excessive_strain: T('09:00') }),
      outcome('W2', { workMin: 300, adherence: { instructions: 2, followed: 2 }, escalations: 0 }),
      outcome('W3', { subgroup: { ...SUB, language: 'bn', acclimatization: 'unacclimatized' }, adherence: { instructions: 0, followed: 0 } }, { excessive_strain: T('10:00') }),
    ],
    events,
    alertStats: alertStats([a1, c1high], []),
    plan: null,
    timingMs: 0,
  }
}

const recordsOf = (r: SiteDayResult = siteDay()): WorkerShiftRecord[] => workerShiftRecords(r, { crews: [CREW], adoshUnacclimatized: new Set(['W3']) })
const byId = (rs: WorkerShiftRecord[], id: string): WorkerShiftRecord => rs.find((r) => r.workerId === id) as WorkerShiftRecord

describe('alarmTimesByWorker', () => {
  it('counts distinct alerts at ≥ high covering the worker, at the first covering time, and ignores resolved versions', () => {
    const m = alarmTimesByWorker(siteDay().events)
    expect(m.get('W1')).toEqual([T('07:00'), T('08:30')])
    expect(m.get('W2')).toEqual([T('08:30')])
    expect(m.get('W3')).toBeUndefined()
    expect(alarmTimesByWorker(siteDay().events, 'caution').get('W2')).toEqual([T('08:00')])
  })
})

describe('workerShiftRecords', () => {
  const rs = recordsOf()
  it('derives symptomatic events (T2+ check-in or first-aid case), symptom reports and heat-symptom episodes from the log', () => {
    expect(byId(rs, 'W1').symptomaticT).toBeNull() // thirst is T0
    expect(byId(rs, 'W1').symptomReports).toBe(0)
    expect(byId(rs, 'W1').heatSymptomEpisodes).toBe(0) // thirst excluded
    expect(byId(rs, 'W2').symptomaticT).toBe(T('11:00')) // headache = T2
    expect(byId(rs, 'W2').heatSymptomEpisodes).toBe(2)
    expect(byId(rs, 'W2').heatSymptomOnsetT).toBe(T('10:45'))
    expect(byId(rs, 'W3').symptomReports).toBe(1) // heat rash = T1
    expect(byId(rs, 'W3').symptomaticT).toBe(T('15:00')) // evacuation = first-aid case
  })
  it('reads the structured truth cluster and onset (worldsim >= 1.1.0); the detail prefix is only a fallback for older logs', () => {
    const r = siteDay()
    const events: SimEvent[] = [
      ...r.events.filter((e) => e.kind !== 'truth'),
      // The structured cluster wins over contradictory detail text; onsetT (not the event time) is the onset.
      { kind: 'truth', t: T('09:30'), workerId: 'W1', event: 'symptom_onset', cluster: 'thirst', onsetT: T('09:30'), detail: 'heat_exhaustion: misleading text' },
      { kind: 'truth', t: T('10:50'), workerId: 'W2', event: 'symptom_onset', cluster: 'heat_exhaustion', onsetT: T('10:40') },
      { kind: 'truth', t: T('11:30'), workerId: 'W2', event: 'symptom_onset', cluster: 'cns', onsetT: T('11:30'), detail: 'thirst: misleading text' },
    ]
    const rs2 = recordsOf({ ...r, events })
    expect(byId(rs2, 'W1').heatSymptomEpisodes).toBe(0)
    expect(byId(rs2, 'W2').heatSymptomEpisodes).toBe(2)
    expect(byId(rs2, 'W2').heatSymptomOnsetT).toBe(T('10:40'))
    const ev = (over: Partial<Extract<SimEvent, { kind: 'truth' }>>): Extract<SimEvent, { kind: 'truth' }> => ({ kind: 'truth', t: 0, workerId: 'W', event: 'symptom_onset', ...over })
    expect(truthEventCluster(ev({ detail: 'cramps: cramps' }))).toBe('cramps')
    expect(truthEventCluster(ev({ cluster: 'cns', detail: 'cramps: cramps' }))).toBe('cns')
    expect(truthEventCluster(ev({}))).toBe('')
  })
  it('detects evacuations and the lost shift minutes', () => {
    expect(byId(rs, 'W3').evacuatedT).toBe(T('15:00'))
    expect(byId(rs, 'W3').lostMin).toBe(120)
    expect(byId(rs, 'W1').evacuatedT).toBeNull()
    expect(byId(rs, 'W1').shiftMin).toBe(720)
  })
  it('measures sun work inside the midday break (12:30–15:00 on 15 Jul)', () => {
    expect(byId(rs, 'W1').middayViolationMin).toBe(30)
    expect(byId(rs, 'W2').middayViolationMin).toBe(0)
  })
  it('checks ADOSH zone controls per worker-hour (dose rule and the unacclimatised exclusion)', () => {
    // W1: 40 min light work in the High zone hour (allowance 45/15) → compliant.
    expect(byId(rs, 'W1').zone).toEqual({ workerHours: 1, compliantHours: 1, excessMin: 0, unacclimatizedHours: 0 })
    // W2: 45 min heavy work (allowance 20/40) → dose 2.25 → 25 min over.
    expect(byId(rs, 'W2').zone).toEqual({ workerHours: 1, compliantHours: 0, excessMin: 25, unacclimatizedHours: 0 })
    // W3: ADOSH-unacclimatised, 10 min in a zone that excludes them.
    expect(byId(rs, 'W3').zone).toEqual({ workerHours: 1, compliantHours: 0, excessMin: 0, unacclimatizedHours: 1 })
  })
  it('copies outcome totals and engine minutes; engine fields are empty when the engine did not run', () => {
    expect(byId(rs, 'W1').minutesHighPlus).toBe(210)
    expect(byId(rs, 'W1').minutesStopPlus).toBe(60)
    const r = siteDay()
    const banOnly = workerShiftRecords({ ...r, config: makeSimConfig({ siteId: 'kezad', date: DATE, policy: 'ban_only' }) }, { crews: [CREW] })
    expect(banOnly.every((x) => !x.engineRan && x.alarmTimes.length === 0 && x.minutesHighPlus === 0)).toBe(true)
    expect(allFinite(rs)).toBe(true)
  })
})

describe('detectionSummary', () => {
  it('computes sensitivity, specificity, PPV, false alarms and lead time exactly on a hand-built log', () => {
    const d = detectionSummary(recordsOf(), 'excessive_strain', O)
    expect(d.positives).toBe(2)
    expect(d.warnedShifts).toBe(2)
    expect(d.sensitivityBeforeOnset.value).toBe(0.5)
    expect(d.sensitivityInShift.value).toBe(0.5)
    expect(d.specificity.value).toBe(0) // the one negative shift (W2) was warned
    expect(d.ppvShift.value).toBe(0.5)
    expect(d.alarms).toBe(3)
    expect(d.ppvAlarm.value).toBe(0.667) // W1's two alarms lie within ±120 min of 09:00; W2's does not count
    expect(d.falseAlarmsPerShift.value).toBe(0.333)
    expect(d.leadTime.n).toBe(1)
    expect(d.leadTime.medianMin).toBe(120)
    expect(d.leadTime.bins.find((b) => b.fromMin === 120)?.n).toBe(1)
    expect(d.sensitivityBeforeOnset.ci95).toBeNull() // one cluster → no interval
  })
  it('the log-only symptomatic target gives the PILOT event lead time', () => {
    const d = detectionSummary(recordsOf(), 'symptomatic', O)
    expect(d.positives).toBe(2) // W2 (T2 check-in), W3 (first aid)
    expect(d.sensitivityBeforeOnset.value).toBe(0.5)
    expect(d.leadTime.medianMin).toBe(150) // 11:00 − 08:30
    const h = detectionSummary(recordsOf(), 'heat_symptoms', O)
    expect(h.positives).toBe(1)
    expect(h.leadTime.medianMin).toBe(135) // 10:45 − 08:30
  })
})

describe('rates, challenge measures, fairness and paired comparison', () => {
  it('policyRates counts worker-shifts with events per 1,000 and gives the rule-of-three bound for zero counts', () => {
    const p = policyRates(recordsOf(), O)
    expect(p.workerShifts).toBe(3)
    expect(p.per1000.excessive.count).toBe(2)
    expect(p.per1000.excessive.value).toBe(666.7)
    expect(p.per1000.excessive.upper95).toBeNull()
    expect(p.per1000.severe.value).toBe(0)
    expect(p.per1000.severe.upper95).toBe(1000)
    expect(p.per1000.symptomaticEpisodes.count).toBe(2)
    expect(p.per1000.evacuations.count).toBe(1)
    expect(p.perShift.workMin.value).toBe(366.7)
  })
  it('challengeMeasures: adherence, check-in response, midday and zone compliance, lead time and lost time', () => {
    const r = siteDay()
    const c = challengeMeasures(recordsOf(r), [runAlertSummary(r)], O)
    expect(c.adherence.value).toBe(0.833) // (3 + 2 + 0) / (4 + 2 + 0)
    expect(c.checkinResponse.value).toBe(1)
    expect(c.alarmsPerShift.value).toBe(1)
    expect(c.midday.violationMin).toBe(30)
    expect(c.midday.compliantShare.value).toBe(0.667)
    expect(c.zone.workerHours).toBe(3)
    expect(c.zone.compliantShare.value).toBe(0.333)
    expect(c.zone.unacclimatizedHours).toBe(1)
    expect(c.eventLeadTime.medianMin).toBe(150)
    expect(c.symptomaticShiftsPer1000.count).toBe(2)
    expect(c.escalationsPer1000.count).toBe(2)
    expect(c.heatIllnessLostMinPer1000WorkerHours).toBe(3333.3) // 120 min / 36 worker-hours
    expect(allFinite(c)).toBe(true)
  })
  it('runAlertSummary and ackSummary pool alert counts and acknowledgement delays', () => {
    const s = runAlertSummary(siteDay())
    expect(s.alerts).toBe(2)
    expect(s.alarms).toBe(2)
    expect(s.ackDelaysMin).toEqual([2])
    const a = ackSummary([s, s])
    expect(a.alerts).toBe(4)
    expect(a.medianDelayMin).toBe(2)
  })
  it('fairnessBreakdown splits by subgroup with exact point estimates', () => {
    const cells = fairnessBreakdown(recordsOf(), ['language', 'acclimatization'])
    const hi = cells.find((c) => c.dimension === 'language' && c.value === 'hi')
    const bn = cells.find((c) => c.dimension === 'language' && c.value === 'bn')
    expect(hi?.workerShifts).toBe(2)
    expect(hi?.excessivePer1000).toBe(500)
    expect(hi?.positivesExcessive).toBe(1)
    expect(hi?.sensitivityExcessive).toBe(1)
    expect(bn?.excessivePer1000).toBe(1000)
    expect(bn?.sensitivityExcessive).toBe(0)
    expect(bn?.adherence).toBeNull()
    expect(cells.map((c) => c.dimension)).toEqual(['language', 'language', 'acclimatization', 'acclimatization'])
  })
  it('pairedComparison gives exact differences on matched worker-shifts, and zero against itself', () => {
    const a = recordsOf()
    const b = a.map((r) => ({ ...r, workMin: r.workMin + 60, truth: { ...r.truth, excessive_strain: { count: 0, onsetT: null } } }))
    const p = pairedComparison(a, b, O)
    expect(p.pairedWorkerShifts).toBe(3)
    expect(p.workMinPerShift.value).toBe(-60)
    expect(p.excessivePer1000.value).toBe(666.7)
    expect(p.workRelative.value).toBe(-0.141) // 1100 / 1280 − 1
    const z = pairedComparison(a, a, O)
    expect(z.workMinPerShift.value).toBe(0)
    expect(z.workRelative.value).toBe(0)
  })
})

describe('alarms split by Alert.basis (metrics 1.1.0)', () => {
  const based = (id: string, level: RiskLevel, scope: Alert['scope'], who: { workerId?: string; memberIds?: string[] }, basis: 'exposure' | 'individual', status: Alert['status'] = 'active'): Alert => ({
    ...alert(id, level, scope, who, status),
    basis,
  })
  const note = (alertId: string, t: string, role: Notification['to']['role'], basis: 'exposure' | 'individual', requiresAck: boolean, level: RiskLevel = 'high'): SimEvent => ({
    kind: 'notification',
    t: T(t),
    notification: { id: `${alertId}-${role}-${t}`, t: T(t), alertId, to: { role }, channel: 'app', level, actions: [], reasonKey: 'x', text: 'x', requiresAck, kind: 'alert', basis },
  })
  /** W1: exposure A re-labelled individual at 08:20; exposure B never individual; individual stop C. W2: individual high D; covered by crew alert E. */
  function basisDay(): SiteDayResult {
    const events: SimEvent[] = [
      { kind: 'alert', t: T('08:00'), alert: based('A', 'high', 'worker', { workerId: 'W1' }, 'exposure') },
      { kind: 'alert', t: T('08:20'), alert: based('A', 'high', 'worker', { workerId: 'W1' }, 'individual') },
      { kind: 'alert', t: T('08:40'), alert: based('A', 'high', 'worker', { workerId: 'W1' }, 'individual', 'resolved') },
      { kind: 'alert', t: T('09:00'), alert: based('B', 'high', 'worker', { workerId: 'W1' }, 'exposure') },
      { kind: 'alert', t: T('09:05'), alert: based('B0', 'caution', 'worker', { workerId: 'W1' }, 'individual') }, // below the alarm level
      { kind: 'alert', t: T('10:00'), alert: based('C', 'stop', 'worker', { workerId: 'W1' }, 'individual') },
      { kind: 'alert', t: T('07:30'), alert: based('D', 'high', 'worker', { workerId: 'W2' }, 'individual') },
      { kind: 'alert', t: T('07:31'), alert: based('E', 'high', 'crew', { memberIds: ['W1', 'W2'] }, 'exposure') },
      { kind: 'alert', t: T('11:00'), alert: based('F', 'stop', 'worker', { workerId: 'W2' }, 'exposure', 'resolved') }, // only a resolved version
      note('A', '08:00', 'worker', 'exposure', false),
      note('E', '07:31', 'supervisor', 'exposure', true),
      note('E', '07:45', 'supervisor', 'exposure', true), // reminder of the same crew alert: one advisory
      note('B', '09:00', 'supervisor', 'exposure', true),
      note('C', '10:00', 'supervisor', 'individual', true, 'stop'),
      note('C', '10:00', 'worker', 'individual', true, 'stop'),
      note('C', '10:02', 'buddy', 'individual', true, 'stop'),
      note('D', '07:30', 'worker', 'individual', false),
      note('X', '12:00', 'supervisor', 'exposure', true, 'caution'), // below the alarm level: not an advisory
    ]
    return {
      config: makeSimConfig({ siteId: 'kezad', date: DATE, policy: 'zill_env', shadow: true }),
      stamp: 'test',
      hours: hours(),
      outcomes: [outcome('W1', {}, { excessive_strain: T('10:30') }), outcome('W2', {}, { excessive_strain: T('07:20') })],
      events,
      alertStats: alertStats([], []),
      plan: null,
      timingMs: 0,
    }
  }

  it('alarmTimesByBasis: individual from the first individual version (re-label counts from 08:20), exposure only if never individual, worker scope only', () => {
    const hi = alarmTimesByBasis(basisDay().events, 'high')
    expect(hi.individual.get('W1')).toEqual([T('08:20'), T('10:00')])
    expect(hi.individual.get('W2')).toEqual([T('07:30')])
    expect(hi.exposure.get('W1')).toEqual([T('09:00')]) // A became individual; crew alert E is not counted again
    expect(hi.exposure.get('W2')).toBeUndefined()
    const st = alarmTimesByBasis(basisDay().events, 'stop')
    expect(st.individual.get('W1')).toEqual([T('10:00')])
    expect(st.individual.get('W2')).toBeUndefined() // F has only a resolved version
    // Old logs without a basis: every alarm is individual (protective), so the split equals alarmTimesByWorker.
    const old = alarmTimesByBasis(siteDay().events, 'high')
    expect(old.individual.get('W1')).toEqual(alarmTimesByWorker(siteDay().events).get('W1'))
    expect(old.exposure.size).toBe(0)
  })

  it('records carry individual alarm times and exposure advisories; detection counts individual alarms by default', () => {
    const rs = workerShiftRecords(basisDay(), { crews: [CREW] })
    const w1 = byId(rs, 'W1')
    expect(w1.alarmTimes).toEqual([T('07:31'), T('08:00'), T('09:00'), T('10:00')]) // every alarm, crew alert included
    expect(w1.individualAlarmTimes).toEqual({ high: [T('08:20'), T('10:00')], stop: [T('10:00')] })
    expect(w1.exposureAdvisories).toBe(1)
    expect(recordAlarmTimes(w1, 'all', 'high')).toBe(w1.alarmTimes)
    expect(() => recordAlarmTimes(w1, 'individual', 'caution')).toThrow(RangeError)
    // Excessive strain: W1 onset 10:30 (warned 08:20 individual, 07:31 any), W2 onset 07:20 (warned only at 07:30/07:31).
    const ind = detectionSummary(rs, 'excessive_strain', O)
    expect(ind.alarmSet).toBe('individual')
    expect(ind.alarms).toBe(3)
    expect(ind.sensitivityBeforeOnset.value).toBe(0.5)
    expect(ind.leadTime.medianMin).toBe(130) // 10:30 − 08:20
    const all = detectionSummary(rs, 'excessive_strain', O, 'high', 120, 'all')
    expect(all.alarms).toBe(6)
    expect(all.leadTime.medianMin).toBe(179) // 10:30 − 07:31
    const stop = detectionSummary(rs, 'excessive_strain', O, 'stop')
    expect(stop.alarms).toBe(1)
    expect(stop.leadTime.medianMin).toBe(30)
    expect(stop.ppvAlarm.value).toBe(1) // 10:00 is within ±120 min of W1's onset
    // Engine-off records carry no alarms of either basis.
    const off = workerShiftRecords({ ...basisDay(), config: makeSimConfig({ siteId: 'kezad', date: DATE, policy: 'ban_only' }) }, { crews: [CREW] })
    expect(off.every((r) => r.individualAlarmTimes.high.length === 0 && r.exposureAdvisories === 0)).toBe(true)
  })

  it('runAlertSummary / challengeMeasures: burden by basis and role, exposure advisories per crew-shift and per worker-shift', () => {
    const r = basisDay()
    const s = runAlertSummary(r, 'high', { crews: [CREW] })
    expect(s.workerShifts).toBe(2)
    expect(s.crewShifts).toBe(1)
    expect(s.exposureAdvisoriesToSupervisor).toBe(2) // E (once, despite the reminder) and B; X is below the alarm level
    expect(s.notificationsByBasisRole.exposure.supervisor).toEqual({ sent: 4, requiringAck: 4 })
    expect(s.notificationsByBasisRole.exposure.worker).toEqual({ sent: 1, requiringAck: 0 })
    expect(s.notificationsByBasisRole.individual).toEqual({ supervisor: { sent: 1, requiringAck: 1 }, worker: { sent: 2, requiringAck: 1 }, buddy: { sent: 1, requiringAck: 1 } })
    const pooled = ackSummary([s, s])
    expect(pooled.crewShifts).toBe(2)
    expect(pooled.notificationsByBasisRole.individual.buddy).toEqual({ sent: 2, requiringAck: 2 })
    const c = challengeMeasures(workerShiftRecords(r, { crews: [CREW] }), [s], O)
    expect(c.individualAlarmsPerShift.high.value).toBe(1.5) // W1 2, W2 1
    expect(c.individualAlarmsPerShift.stop.value).toBe(0.5)
    expect(c.exposureAdvisoriesPerWorkerShift.value).toBe(0.5)
    expect(c.exposureAdvisoriesPerCrewShift).toBe(2)
    expect(c.alarmsPerShift.value).toBe(3) // all alarms: W1 4, W2 2
    expect(c.burdenPerWorkerShift.exposure.supervisor).toEqual({ sent: 2, requiringAck: 2 })
    expect(c.burdenPerWorkerShift.total.supervisor).toEqual({ sent: 2.5, requiringAck: 2.5 })
    expect(c.burdenPerWorkerShift.total.worker).toEqual({ sent: 1.5, requiringAck: 0.5 })
    expect(allFinite(c)).toBe(true)
  })
})

describe('designed suppression (metrics 1.2.0)', () => {
  const sup = (id: string, level: RiskLevel, who: string, liftedAt?: number, basis: 'exposure' | 'individual' = 'exposure', status: Alert['status'] = 'active'): Alert => ({
    ...alert(id, level, 'worker', { workerId: who }, status),
    basis,
    suppression: { reason: 'action_in_force', t: T('08:00'), ...(liftedAt !== undefined ? { liftedAt } : {}) },
  })
  /** W1: S1 suppressed at high, never notified; S2 suppressed, lifted at 09:30 (now an exposure advisory); S3 suppressed at caution only. W2: N notified exposure. */
  function suppressedDay(): SiteDayResult {
    const events: SimEvent[] = [
      { kind: 'alert', t: T('08:00'), alert: sup('S1', 'high', 'W1') },
      { kind: 'alert', t: T('08:30'), alert: sup('S1', 'high', 'W1', undefined, 'exposure', 'resolved') },
      { kind: 'alert', t: T('09:00'), alert: sup('S2', 'high', 'W1') },
      { kind: 'alert', t: T('09:30'), alert: sup('S2', 'high', 'W1', T('09:30'), 'individual') },
      { kind: 'alert', t: T('10:00'), alert: sup('S3', 'caution', 'W1') },
      { kind: 'alert', t: T('11:00'), alert: { ...alert('N', 'high', 'worker', { workerId: 'W2' }), basis: 'exposure' } },
    ]
    const stats = alertStats([], [])
    return {
      config: makeSimConfig({ siteId: 'kezad', date: DATE, policy: 'zill_monitored' }),
      stamp: 'test',
      hours: hours(),
      outcomes: [outcome('W1'), outcome('W2')],
      events,
      alertStats: { ...stats, designedSuppression: { alerts: 3, stillSuppressed: 2, lifted: 1 } },
      plan: null,
      timingMs: 0,
    }
  }

  it('a version under designed suppression is not an alarm; an alert never notified at ≥ the level is a suppressed advisory, a lifted one counts from its lift (known answers)', () => {
    const ev = suppressedDay().events
    const hi = alarmTimesByBasis(ev, 'high')
    expect(hi.suppressed.get('W1')).toEqual([T('08:00')]) // S1 only: S2 was lifted (notified), S3 is below high
    expect(hi.individual.get('W1')).toEqual([T('09:30')]) // S2 from its lift, with the basis it was lifted on
    expect(hi.exposure.get('W1')).toBeUndefined()
    expect(hi.exposure.get('W2')).toEqual([T('11:00')])
    expect(alarmTimesByBasis(ev, 'caution').suppressed.get('W1')).toEqual([T('08:00'), T('10:00')])
    // Every-alarm count (metrics 1.0.0 definition) skips the suppressed versions too.
    expect(alarmTimesByWorker(ev).get('W1')).toEqual([T('09:30')])
    // Logs without suppression read as before (metrics 1.1.0 numbers unchanged).
    expect(alarmTimesByBasis(siteDay().events, 'high').suppressed.size).toBe(0)
  })

  it('records, run summaries and challenge measures carry suppressed advisories and AlertStats.designedSuppression; zill_monitored runs the engine', () => {
    const r = suppressedDay()
    expect(engineRuns(r.config)).toBe(true)
    const rs = workerShiftRecords(r, { crews: [CREW] })
    expect(byId(rs, 'W1').suppressedAdvisories).toBe(1)
    expect(byId(rs, 'W2').suppressedAdvisories).toBe(0)
    expect(byId(rs, 'W1').exposureAdvisories).toBe(0)
    const s = runAlertSummary(r, 'high', { crews: [CREW] })
    expect(s.designedSuppression).toEqual({ alerts: 3, stillSuppressed: 2, lifted: 1 })
    expect(ackSummary([s, s]).designedSuppression).toEqual({ alerts: 6, stillSuppressed: 4, lifted: 2 })
    const c = challengeMeasures(rs, [s], O)
    expect(c.suppressedAdvisoriesPerWorkerShift.value).toBe(0.5)
    expect(c.exposureAdvisoriesPerWorkerShift.value).toBe(0.5) // W2's notified advisory only
    // A run summary of a log without the stats (older results) reports zeros.
    const old = runAlertSummary({ ...r, alertStats: alertStats([], []) }, 'high', { crews: [CREW] })
    expect(old.designedSuppression).toEqual({ alerts: 0, stillSuppressed: 0, lifted: 0 })
  })
})

describe('bootstrap', () => {
  it('quantileSorted interpolates linearly', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantileSorted([5], 0.9)).toBe(5)
    expect(Number.isNaN(quantileSorted([], 0.5))).toBe(true)
  })
  it('bootstrapRatio is deterministic, brackets the estimate and needs two clusters', () => {
    const num = [1, 0, 2, 0, 1, 3, 0, 1]
    const den = [10, 10, 10, 10, 10, 10, 10, 10]
    const a = bootstrapRatio(num, den, 's', 500)
    expect(a).toEqual(bootstrapRatio(num, den, 's', 500))
    const point = num.reduce((s, x) => s + x, 0) / 80
    expect(a && a[0] <= point && point <= a[1]).toBe(true)
    expect(bootstrapRatio([1], [10], 's')).toBeNull()
    expect(bootstrapRatio([2, 2, 2], [4, 4, 4], 's', 100)).toEqual([0.5, 0.5])
  })
  it('bootstrapRatioDiff of identical arms is [0, 0]; bootstrapQuantile brackets the median', () => {
    const n = [1, 2, 3, 4]
    const d = [5, 5, 5, 5]
    expect(bootstrapRatioDiff(n, d, n, d, 's', 200)).toEqual([0, 0])
    const q = bootstrapQuantile([[1, 2], [3], [4, 5, 6], [7]], 0.5, 's', 300)
    expect(q && q[0] <= 4 && 4 <= q[1]).toBe(true)
  })
})

describe('calibration of minutes-to-limit', () => {
  const t0 = T('06:00')
  const row = (workerId: string, i: number, over: Partial<WorkerMinute>): WorkerMinute => ({
    t: t0 + i * 60_000,
    workerId,
    taskId: 'heavy',
    location: 'sun',
    working: true,
    level: 'high',
    computedLevel: 'high',
    workMinPerHour: 30,
    minutesToLimit: 30,
    wbgtEffC: 31,
    coreTrueC: 37.5,
    hrTrueBpm: 120,
    hrMeasuredBpm: null,
    ectempC: null,
    dehydrationPct: 0.5,
    ...over,
  })
  it('bins samples by predicted minutes and scores whether the truth limit is reached within the bin horizon', () => {
    const rows: WorkerMinute[] = []
    // W1: predicted 30 min (15–45 bin); truth core reaches 38.0 °C at minute 25 → samples at 0, 5, 10, 15, 20 all reached.
    for (let i = 0; i < 60; i++) rows.push(row('W1', i, { coreTrueC: i >= 25 ? 38.2 : 37.5 }))
    // W2: beyond the horizon (null), never reaches; follow-up of 90 min must fit before endT (200 min) → t ≤ 110.
    for (let i = 0; i < 200; i++) rows.push(row('W2', i, { minutesToLimit: null }))
    // W3: latched at 0; resting rows are not samples.
    for (let i = 0; i < 20; i++) rows.push(row('W3', i, { minutesToLimit: 0, working: i < 10 }))
    const c = calibrationCounts(rows, t0 + 200 * 60_000)
    const latched = c.bins[0]
    const mid = c.bins.find((b) => b.fromMin === 15) ?? emptyCalibration().bins[0]
    const open = c.bins[c.bins.length - 1]
    expect(latched.latched).toBe(true)
    expect(latched.samples).toBe(2) // W3 minutes 0 and 5
    expect(latched.reached).toBe(0)
    expect(mid.samples).toBe(5)
    expect(mid.reached).toBe(5)
    expect(mid.sumPredictedMin).toBe(150)
    expect(open.samples).toBe(23)
    expect(open.reached).toBe(0)
    expect(open.nullPredictions).toBe(23)
    const table = calibrationTable(mergeCalibration(c, c))
    expect(table.map((r) => r.label)).toEqual(['0 (limit reached in the projection)', '> 0–15 min', '15–45 min', '45–90 min', '≥ 90 min or beyond horizon'])
    const m = table.find((r) => r.fromMin === 15 && !r.label.startsWith('0'))
    expect(m?.samples).toBe(10)
    expect(m?.observedShare).toBe(1)
    expect(m?.meanPredictedMin).toBe(30)
    expect(table[1].observedShare).toBeNull()
  })
})
